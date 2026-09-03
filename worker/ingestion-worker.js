/**
 * Chalk That NFL — Ingestion Worker
 * =========================================================================
 * Runs as its own Railway service, separate from the main API backend —
 * see Phase 2 System Design discussion for why (crashed/stuck ingestion
 * shouldn't be able to affect API responsiveness, and it mirrors how the
 * future AI agent service is also kept separate from the main backend).
 * It writes directly to Postgres, not through backend-api's HTTP/auth
 * layer — it's a trusted internal writer, not an external reader.
 *
 * STATUS as of "Ingestion worker automation" (Phase 5 build order):
 *   - Scheduler (fixed / proximity / day-of-week-proximity / game-window),
 *     retry/backoff, and ingestion_runs logging are real and running.
 *   - sync_roster, sync_schedule, sync_historical_stats are REAL — they
 *     pull nflverse's current-season files (the same sources
 *     scripts/backfill-historical.js used for the one-time historical
 *     load) and upsert, so rosters/scores/box-scores stay current as the
 *     season progresses instead of being frozen at backfill time.
 *   - sync_forecast_weather is now REAL too (Part 2 Phase 1 — see
 *     docs/part2-roadmap.md). Open-Meteo's forecast endpoint needs no API
 *     key for non-commercial use ("No API key is required. You can use it
 *     immediately!" — open-meteo.com/en/about), so there was no credential
 *     to provision after all — the `OPEN_METEO_API_KEY` env var this repo
 *     used to mention was based on an assumption made before actually
 *     integrating; it's unused and can be ignored/removed.
 *   - sync_odds is REAL and dry-run confirmed (The Odds API — 1508 odds
 *     rows across 272 games on the first real run, both locally and on
 *     Railway). See docs/part2-roadmap.md's vendor decision.
 *   - sync_injury_reports and sync_live_stats are now REAL too
 *     (Highlightly — highlightly.net via RapidAPI, the live-stats vendor
 *     decision, see docs/part2-roadmap.md). NOT YET DRY-RUN TESTED —
 *     HIGHLIGHTLY_API_KEY was only just provisioned. Written against
 *     Highlightly's documented request/response shape, which is a
 *     paraphrase of their docs page rather than a captured real response —
 *     see the job bodies' own comment for exactly what's confirmed vs.
 *     best-effort-guessed (particularly sync_live_stats's stat-name
 *     mapping), and what the first real dry run needs to check.
 *   - grade_picks is REAL (Part 2 Phase 2's calibration/tracking layer —
 *     see docs/part2-roadmap.md "3 paths" discussion). Grades picks_log
 *     rows (db/migrations/004_picks_log.sql) against final games once an
 *     hour and logs the all-time hit rate. No agent writes to picks_log
 *     yet — scripts/seed-test-picks.js is the only writer for now, used
 *     to validate this job against real 2021-2025 historical games
 *     before any agent depends on it.
 *
 * This file is intentionally self-contained (its own worker/package.json,
 * its own copy of the small fetch/normalize helpers scripts/
 * backfill-historical.js also uses) rather than requiring code from
 * ../backend or ../scripts. That mirrors how frontend/ is also fully
 * independent, and matches the architectural intent of ingestion-worker
 * being its own deployable unit — Railway's rootDirectory: "worker"
 * setting only installs/builds this directory. The tradeoff is a small
 * amount of duplication (CSV fetch, team-abbreviation normalization,
 * position-group classification) between this file and
 * scripts/backfill-historical.js; if that duplication becomes painful,
 * factoring it into a shared npm package is the natural next step, but
 * wasn't worth the extra indirection for two files.
 * =========================================================================
 */

// Reads the repo-root .env regardless of cwd, so `node ingestion-worker.js`
// works the same whether it's run from worker/ (as Railway's rootDirectory
// build will run it) or via the root `npm run worker` convenience script.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const https = require('https');
const { parse } = require('csv-parse/sync');

// ---------------------------------------------------------------------
// nflverse sources (same ones scripts/backfill-historical.js uses — see
// that file's header for how these were confirmed against nflverse's own
// build scripts, not guessed).
// ---------------------------------------------------------------------

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const playerStatsUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;
const rosterUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;

const BATCH_SIZE = 100;

// Same nflverse LA/LAR quirk documented in scripts/backfill-historical.js
// and docs/architecture.md — applies here too since this worker reads the
// same nflverse files against the same `teams` table.
const TEAM_ABBR_ALIASES = { LA: 'LAR' };
function normalizeAbbr(abbr) {
  return TEAM_ABBR_ALIASES[abbr] || abbr;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});
pool.on('error', (err) => {
  console.error('[ingestion-worker] unexpected pool error:', err.message);
});

// ---------------------------------------------------------------------
// Fetch helpers (same shape as scripts/backfill-historical.js)
// ---------------------------------------------------------------------

// `extraHeaders` lets vendor clients that need auth headers (Highlightly's
// x-rapidapi-key/x-rapidapi-host) reuse this same fetch/redirect/error
// handling instead of duplicating it — fetchText() below is just this with
// no extra headers, which is all the nflverse/Open-Meteo/Odds-API callers
// ever needed.
function fetchTextWithHeaders(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'chalk-that-nfl-ingestion-worker', ...extraHeaders } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchTextWithHeaders(res.headers.location, extraHeaders));
        }
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 300)}`)));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function fetchText(url) {
  return fetchTextWithHeaders(url);
}

async function fetchCsv(url) {
  const text = await fetchText(url);
  return parse(text, { columns: true, skip_empty_lines: true });
}

// ---------------------------------------------------------------------
// Classification helpers (same logic as scripts/backfill-historical.js)
// ---------------------------------------------------------------------

const THANKSGIVING_MONTH_DAY_RANGE = { month: 11, minDay: 22, maxDay: 28 };

function isThanksgiving(gameday, weekday) {
  if (weekday !== 'Thursday' || !gameday) return false;
  const [, month, day] = gameday.split('-').map(Number);
  return (
    month === THANKSGIVING_MONTH_DAY_RANGE.month &&
    day >= THANKSGIVING_MONTH_DAY_RANGE.minDay &&
    day <= THANKSGIVING_MONTH_DAY_RANGE.maxDay
  );
}

function classifyGameSlot(weekday, gametime, gameday) {
  if (isThanksgiving(gameday, weekday)) return 'thanksgiving';
  if (weekday === 'Thursday') return 'thursday_night';
  if (weekday === 'Monday') return 'monday_night';
  if (weekday === 'Saturday') return 'saturday';
  if (weekday === 'Sunday') {
    const hour = gametime ? parseInt(gametime.split(':')[0], 10) : null;
    if (hour === null || Number.isNaN(hour)) return 'other';
    if (hour <= 13) return 'sunday_early';
    if (hour <= 17) return 'sunday_late';
    return 'sunday_night';
  }
  return 'other';
}

function classifyWeatherCondition(roof) {
  const r = (roof || '').toLowerCase();
  if (r === 'dome' || r === 'closed') return 'dome';
  return null; // see scripts/backfill-historical.js header — genuinely unknown for outdoor games from this source
}

const POSITION_GROUP = {
  offense: new Set(['QB', 'RB', 'FB', 'HB', 'WR', 'TE', 'T', 'G', 'C', 'OT', 'OG', 'OL']),
  defense: new Set(['DE', 'DT', 'NT', 'DL', 'LB', 'ILB', 'OLB', 'MLB', 'EDGE', 'CB', 'S', 'SS', 'FS', 'DB', 'SAF', 'NB']),
  special_teams: new Set(['K', 'P', 'LS', 'KR', 'PR']),
};
function positionGroupFor(position) {
  const pos = (position || '').toUpperCase();
  if (POSITION_GROUP.offense.has(pos)) return 'offense';
  if (POSITION_GROUP.defense.has(pos)) return 'defense';
  if (POSITION_GROUP.special_teams.has(pos)) return 'special_teams';
  return 'offense'; // same fallback as scripts/seed.js and scripts/backfill-historical.js
}

function n(v) {
  if (v === undefined || v === null || v === '') return null;
  const num = Number(v);
  return Number.isNaN(num) ? null : num;
}

// NFL season "labeled year" runs Sept-Feb (e.g. Super Bowl LX in Feb 2026
// closes out the *2025* season). Jan/Feb -> previous calendar year;
// Mar-Dec -> current calendar year, since that's also when nflverse starts
// publishing the *next* season's roster data ahead of kickoff.
function currentNflSeason(now) {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

// ---------------------------------------------------------------------
// Identity resolution — shared by every job that touches player records.
// Mirrors the 5-step algorithm the original skeleton documented:
//   1. Look up the crosswalk by (source, source_player_id).
//   2. Found -> return it (cached in-memory for the rest of this job run).
//   3. Not found -> attempt a normalized name + team + position match
//      against `players`.
//   4. Exactly one confident match -> crosswalk it as 'matched'.
//   5. Ambiguous (0 or >1 candidates) -> insert a new players row +
//      crosswalk it as 'manual_review', so the record isn't lost while
//      waiting on the next roster sync or an actual manual review pass.
// ---------------------------------------------------------------------

async function resolveIdentity(source, sourcePlayerId, candidate, cache) {
  if (cache && cache.has(sourcePlayerId)) return cache.get(sourcePlayerId);

  const { rows: crosswalked } = await pool.query(
    'SELECT player_id FROM player_id_crosswalk WHERE source = $1 AND source_player_id = $2',
    [source, sourcePlayerId]
  );
  if (crosswalked.length) {
    if (cache) cache.set(sourcePlayerId, crosswalked[0].player_id);
    return crosswalked[0].player_id;
  }

  const { rows: matches } = await pool.query(
    `SELECT player_id FROM players
     WHERE lower(full_name) = lower($1) AND position = $2
       AND ($3::uuid IS NULL OR current_team_id = $3)
     LIMIT 2`,
    [candidate.fullName, candidate.position, candidate.teamId || null]
  );

  let playerId;
  let confidence;
  if (matches.length === 1) {
    playerId = matches[0].player_id;
    confidence = 'matched';
  } else {
    const { rows: inserted } = await pool.query(
      `INSERT INTO players (full_name, position, position_group, current_team_id, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING player_id`,
      [candidate.fullName, candidate.position, positionGroupFor(candidate.position), candidate.teamId || null]
    );
    playerId = inserted[0].player_id;
    confidence = 'manual_review';
  }

  await pool.query(
    `INSERT INTO player_id_crosswalk (player_id, source, source_player_id, match_confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, source_player_id) DO NOTHING`,
    [playerId, source, sourcePlayerId, confidence]
  );
  if (cache) cache.set(sourcePlayerId, playerId);
  return playerId;
}

// ---------------------------------------------------------------------
// Job bodies — the three nflverse-backed jobs, real.
// ---------------------------------------------------------------------

async function loadTeamMaps() {
  const { rows } = await pool.query('SELECT team_id, abbreviation FROM teams');
  const teamIdByAbbr = {};
  for (const t of rows) teamIdByAbbr[t.abbreviation] = t.team_id;
  return teamIdByAbbr;
}

async function syncRoster() {
  const season = currentNflSeason(new Date());
  const url = rosterUrl(season);
  let rows;
  try {
    rows = await fetchCsv(url);
  } catch (err) {
    console.warn(`[job:sync_roster] no roster file for ${season} yet (${err.message})`);
    return { recordsProcessed: 0 };
  }

  const teamIdByAbbr = await loadTeamMaps();
  const cache = new Map();
  let processed = 0;

  for (const row of rows) {
    if (!row.gsis_id) continue;
    const teamId = teamIdByAbbr[normalizeAbbr(row.team)] || null;
    const fullName = row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim();

    const playerId = await resolveIdentity('nflverse', row.gsis_id, { fullName, position: row.position, teamId }, cache);

    await pool.query(
      `UPDATE players
       SET current_team_id = $2, status = $3, position = COALESCE($4, position),
           position_group = COALESCE($5, position_group)
       WHERE player_id = $1`,
      [playerId, teamId, row.status || 'active', row.position || null, row.position ? positionGroupFor(row.position) : null]
    );
    processed++;
  }

  console.log(`[job:sync_roster] season ${season}: ${processed} players synced`);
  return { recordsProcessed: processed };
}

async function syncSchedule() {
  const season = currentNflSeason(new Date());
  const rows = await fetchCsv(GAMES_URL);
  const inSeason = rows.filter((r) => parseInt(r.season, 10) === season);

  const teamIdByAbbr = await loadTeamMaps();
  const { rows: teams } = await pool.query('SELECT team_id, home_stadium_id, abbreviation FROM teams');
  const stadiumIdByAbbr = {};
  for (const t of teams) stadiumIdByAbbr[t.abbreviation] = t.home_stadium_id;

  let processed = 0;
  for (let i = 0; i < inSeason.length; i += BATCH_SIZE) {
    const batch = inSeason.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];

    for (const g of batch) {
      const homeTeamId = teamIdByAbbr[normalizeAbbr(g.home_team)];
      const awayTeamId = teamIdByAbbr[normalizeAbbr(g.away_team)];
      const stadiumId = stadiumIdByAbbr[normalizeAbbr(g.home_team)];
      if (!homeTeamId || !awayTeamId || !stadiumId) continue;

      const gameType = g.game_type === 'REG' ? 'regular' : g.game_type === 'PRE' ? 'preseason' : 'postseason';
      const gameSlot = classifyGameSlot(g.weekday, g.gametime, g.gameday);
      const weatherCondition = classifyWeatherCondition(g.roof);
      const gameDatetime = g.gameday && g.gametime ? `${g.gameday}T${g.gametime}:00` : g.gameday ? `${g.gameday}T00:00:00` : null;
      if (!gameDatetime) continue;

      const p = values.length * 15;
      values.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10},$${p + 11},$${p + 12},$${p + 13},$${p + 14},$${p + 15})`);
      params.push(
        g.game_id, season, parseInt(g.week, 10), gameType, gameDatetime,
        homeTeamId, awayTeamId, stadiumId, gameSlot, weatherCondition,
        n(g.temp), n(g.wind),
        g.home_score ? parseInt(g.home_score, 10) : null,
        g.away_score ? parseInt(g.away_score, 10) : null,
        g.home_score && g.away_score ? 'final' : 'scheduled'
      );
    }

    if (values.length) {
      await pool.query(
        `INSERT INTO games (game_id, season, week, game_type, game_datetime, home_team_id, away_team_id,
                             stadium_id, game_slot, weather_condition, weather_temp_f, weather_wind_mph,
                             home_score, away_score, status)
         VALUES ${values.join(',')}
         ON CONFLICT (game_id) DO UPDATE SET
           game_datetime = EXCLUDED.game_datetime,
           game_slot = EXCLUDED.game_slot,
           weather_condition = EXCLUDED.weather_condition,
           weather_temp_f = EXCLUDED.weather_temp_f,
           weather_wind_mph = EXCLUDED.weather_wind_mph,
           home_score = EXCLUDED.home_score,
           away_score = EXCLUDED.away_score,
           status = EXCLUDED.status`,
        params
      );
      processed += values.length;
    }
  }

  console.log(`[job:sync_schedule] season ${season}: ${processed} games synced (scores/status/flex updates included)`);
  return { recordsProcessed: processed };
}

const OFFENSE_COLS = ['completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'sacks_suffered', 'carries', 'rushing_yards', 'rushing_tds', 'fumbles_lost_total', 'targets', 'receptions',
  'receiving_yards', 'receiving_tds'];
const DEFENSE_COLS = ['def_tackles_solo', 'def_tackles_with_assist', 'def_sacks', 'def_tackles_for_loss',
  'def_qb_hits', 'def_interceptions', 'def_pass_defended', 'def_fumbles_forced', 'def_fumbles', 'def_tds'];
const ST_COLS = ['fg_att', 'fg_made', 'pat_att', 'pat_made', 'kickoff_return_yards', 'punt_return_yards', 'special_teams_tds'];
const hasAny = (row, cols) => cols.some((c) => Number(row[c]) > 0);

async function upsertOffenseBatch(batch) {
  if (!batch.length) return;
  await pool.query(
    `INSERT INTO player_offense_game_stats (
       game_id, player_id, team_id, pass_attempts, pass_completions, passing_yards, passing_tds,
       interceptions_thrown, sacks_taken, rush_attempts, rushing_yards, rushing_tds, fumbles, targets,
       receptions, receiving_yards, receiving_tds
     ) VALUES ${batch.map((_, idx) => {
       const p = idx * 17;
       return `($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13},$${p+14},$${p+15},$${p+16},$${p+17})`;
     }).join(',')}
     ON CONFLICT (game_id, player_id) DO UPDATE SET
       pass_attempts = EXCLUDED.pass_attempts, pass_completions = EXCLUDED.pass_completions,
       passing_yards = EXCLUDED.passing_yards, passing_tds = EXCLUDED.passing_tds,
       interceptions_thrown = EXCLUDED.interceptions_thrown, sacks_taken = EXCLUDED.sacks_taken,
       rush_attempts = EXCLUDED.rush_attempts, rushing_yards = EXCLUDED.rushing_yards,
       rushing_tds = EXCLUDED.rushing_tds, fumbles = EXCLUDED.fumbles, targets = EXCLUDED.targets,
       receptions = EXCLUDED.receptions, receiving_yards = EXCLUDED.receiving_yards,
       receiving_tds = EXCLUDED.receiving_tds`,
    batch.flatMap(({ row, playerId, teamId }) => [
      row.game_id, playerId, teamId,
      n(row.attempts), n(row.completions), n(row.passing_yards), n(row.passing_tds),
      n(row.passing_interceptions), n(row.sacks_suffered), n(row.carries), n(row.rushing_yards),
      n(row.rushing_tds), n(row.fumbles_lost_total), n(row.targets), n(row.receptions),
      n(row.receiving_yards), n(row.receiving_tds),
    ])
  );
}

async function upsertDefenseBatch(batch) {
  if (!batch.length) return;
  await pool.query(
    `INSERT INTO player_defense_game_stats (
       game_id, player_id, team_id, tackles_solo, tackles_assist, sacks, tackles_for_loss, qb_hits,
       interceptions, passes_defended, forced_fumbles, fumble_recoveries, defensive_tds
     ) VALUES ${batch.map((_, idx) => {
       const p = idx * 13;
       return `($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13})`;
     }).join(',')}
     ON CONFLICT (game_id, player_id) DO UPDATE SET
       tackles_solo = EXCLUDED.tackles_solo, tackles_assist = EXCLUDED.tackles_assist,
       sacks = EXCLUDED.sacks, tackles_for_loss = EXCLUDED.tackles_for_loss, qb_hits = EXCLUDED.qb_hits,
       interceptions = EXCLUDED.interceptions, passes_defended = EXCLUDED.passes_defended,
       forced_fumbles = EXCLUDED.forced_fumbles, fumble_recoveries = EXCLUDED.fumble_recoveries,
       defensive_tds = EXCLUDED.defensive_tds`,
    batch.flatMap(({ row, playerId, teamId }) => [
      row.game_id, playerId, teamId,
      n(row.def_tackles_solo), n(row.def_tackles_with_assist), n(row.def_sacks), n(row.def_tackles_for_loss),
      n(row.def_qb_hits), n(row.def_interceptions), n(row.def_pass_defended), n(row.def_fumbles_forced),
      n(row.def_fumbles), n(row.def_tds),
    ])
  );
}

async function upsertStBatch(batch) {
  if (!batch.length) return;
  await pool.query(
    `INSERT INTO player_special_teams_game_stats (
       game_id, player_id, team_id, fg_attempts, fg_made, longest_fg, xp_attempts, xp_made,
       punts, punt_yards, punt_avg, kick_return_yards, punt_return_yards, return_tds
     ) VALUES ${batch.map((_, idx) => {
       const p = idx * 14;
       return `($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13},$${p+14})`;
     }).join(',')}
     ON CONFLICT (game_id, player_id) DO UPDATE SET
       fg_attempts = EXCLUDED.fg_attempts, fg_made = EXCLUDED.fg_made, longest_fg = EXCLUDED.longest_fg,
       xp_attempts = EXCLUDED.xp_attempts, xp_made = EXCLUDED.xp_made,
       kick_return_yards = EXCLUDED.kick_return_yards, punt_return_yards = EXCLUDED.punt_return_yards,
       return_tds = EXCLUDED.return_tds`,
    batch.flatMap(({ row, playerId, teamId }) => [
      row.game_id, playerId, teamId,
      n(row.fg_att), n(row.fg_made), n(row.fg_long), n(row.pat_att), n(row.pat_made),
      null, null, null, // punts/punt_yards/punt_avg — see scripts/backfill-historical.js header, not in this source
      n(row.kickoff_return_yards), n(row.punt_return_yards), n(row.special_teams_tds),
    ])
  );
}

async function syncHistoricalStats() {
  const season = currentNflSeason(new Date());
  const url = playerStatsUrl(season);
  let rows;
  try {
    rows = await fetchCsv(url);
  } catch (err) {
    console.warn(`[job:sync_historical_stats] no stats file for ${season} yet (${err.message})`);
    return { recordsProcessed: 0 };
  }

  const teamIdByAbbr = await loadTeamMaps();
  const cache = new Map();
  let offense = 0, defense = 0, specialTeams = 0;
  const offenseBatch = [], defenseBatch = [], stBatch = [];

  for (const row of rows) {
    if (!row.player_id || !row.game_id) continue;
    const teamId = teamIdByAbbr[normalizeAbbr(row.team)] || null;
    const fullName = row.player_display_name || row.player_name || row.player_id;
    const playerId = await resolveIdentity(
      'nflverse',
      row.player_id,
      { fullName, position: row.position, teamId },
      cache
    );

    if (hasAny(row, OFFENSE_COLS)) { offenseBatch.push({ row, playerId, teamId }); offense++; }
    if (hasAny(row, DEFENSE_COLS)) { defenseBatch.push({ row, playerId, teamId }); defense++; }
    if (hasAny(row, ST_COLS)) { stBatch.push({ row, playerId, teamId }); specialTeams++; }

    if (offenseBatch.length >= BATCH_SIZE) { await upsertOffenseBatch(offenseBatch); offenseBatch.length = 0; }
    if (defenseBatch.length >= BATCH_SIZE) { await upsertDefenseBatch(defenseBatch); defenseBatch.length = 0; }
    if (stBatch.length >= BATCH_SIZE) { await upsertStBatch(stBatch); stBatch.length = 0; }
  }
  if (offenseBatch.length) await upsertOffenseBatch(offenseBatch);
  if (defenseBatch.length) await upsertDefenseBatch(defenseBatch);
  if (stBatch.length) await upsertStBatch(stBatch);

  await pool.query(
    `INSERT INTO team_game_stats (game_id, team_id, is_home, points, total_yards, passing_yards, rushing_yards, turnovers)
     SELECT
       g.game_id, t.team_id, (t.team_id = g.home_team_id) AS is_home,
       CASE WHEN t.team_id = g.home_team_id THEN g.home_score ELSE g.away_score END AS points,
       COALESCE(off.passing_yards, 0) + COALESCE(off.rushing_yards, 0) AS total_yards,
       off.passing_yards, off.rushing_yards, off.turnovers
     FROM games g
     JOIN teams t ON t.team_id = g.home_team_id OR t.team_id = g.away_team_id
     LEFT JOIN (
       SELECT game_id, team_id, SUM(passing_yards) AS passing_yards, SUM(rushing_yards) AS rushing_yards,
              SUM(interceptions_thrown) + SUM(fumbles) AS turnovers
       FROM player_offense_game_stats GROUP BY game_id, team_id
     ) off ON off.game_id = g.game_id AND off.team_id = t.team_id
     WHERE g.season = $1
     ON CONFLICT (game_id, team_id) DO UPDATE SET
       points = EXCLUDED.points, total_yards = EXCLUDED.total_yards,
       passing_yards = EXCLUDED.passing_yards, rushing_yards = EXCLUDED.rushing_yards,
       turnovers = EXCLUDED.turnovers`,
    [season]
  );

  const processed = offense + defense + specialTeams;
  console.log(`[job:sync_historical_stats] season ${season}: offense ${offense}, defense ${defense}, special-teams ${specialTeams}`);
  return { recordsProcessed: processed };
}

// ---------------------------------------------------------------------
// Job body — sync_forecast_weather, REAL (Open-Meteo). See file header:
// no API key needed for this usage level.
// ---------------------------------------------------------------------

// Well inside Open-Meteo's 16-day forecast max — this job's proximity
// schedule realistically only fires within a few days of the next
// kickoff anyway, so there's no value forecasting further out than this.
const OPEN_METEO_FORECAST_DAYS = 10;

function openMeteoUrl(lat, lon) {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,windspeed_10m,weathercode` +
    `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=UTC&forecast_days=${OPEN_METEO_FORECAST_DAYS}`
  );
}

// Collapses Open-Meteo's WMO `weathercode` into this app's
// weather_condition_enum ('sunny' | 'overcast' | 'rain' | 'snow' | 'dome').
// 'dome' is never returned here — dome/closed-roof games are already
// classified 'dome' at schedule-sync time from nflverse's per-game roof
// field (see classifyWeatherCondition above), so they never have a NULL
// weather_condition for this job's query to pick up in the first place.
function classifyOpenMeteoCode(code) {
  if (code === 0) return 'sunny';
  if (code === 1 || code === 2 || code === 3 || (code >= 45 && code <= 48)) return 'overcast';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'overcast'; // unrecognized code — default to "not clear" rather than silently guessing 'sunny'
}

async function syncForecastWeather() {
  const { rows: games } = await pool.query(
    `SELECT g.game_id, g.game_datetime, s.latitude, s.longitude
     FROM games g
     JOIN stadiums s ON s.stadium_id = g.stadium_id
     WHERE g.status = 'scheduled'
       AND g.weather_condition IS NULL
       AND g.game_datetime BETWEEN now() AND now() + ($1 || ' days')::interval`,
    [OPEN_METEO_FORECAST_DAYS]
  );

  let processed = 0;
  for (const game of games) {
    let forecast;
    try {
      const text = await fetchText(openMeteoUrl(parseFloat(game.latitude), parseFloat(game.longitude)));
      forecast = JSON.parse(text);
    } catch (err) {
      console.warn(`[job:sync_forecast_weather] fetch failed for game ${game.game_id} (${err.message})`);
      continue;
    }

    const hourly = forecast.hourly;
    if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) {
      console.warn(`[job:sync_forecast_weather] no hourly data for game ${game.game_id}`);
      continue;
    }

    // Open-Meteo returns `hourly.time` as UTC-local ISO strings (no offset
    // suffix) when timezone=UTC is set — appending 'Z' makes that explicit
    // before comparing against game_datetime.
    const gameMs = new Date(game.game_datetime).getTime();
    let closestIdx = 0;
    let closestDiff = Infinity;
    for (let i = 0; i < hourly.time.length; i++) {
      const diff = Math.abs(new Date(hourly.time[i] + 'Z').getTime() - gameMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIdx = i;
      }
    }

    const condition = classifyOpenMeteoCode(hourly.weathercode[closestIdx]);
    await pool.query(
      `UPDATE games SET weather_condition = $2, weather_temp_f = $3, weather_wind_mph = $4 WHERE game_id = $1`,
      [game.game_id, condition, n(hourly.temperature_2m[closestIdx]), n(hourly.windspeed_10m[closestIdx])]
    );
    processed++;
  }

  console.log(`[job:sync_forecast_weather] ${processed} of ${games.length} eligible game(s) forecasted`);
  return { recordsProcessed: processed };
}

// ---------------------------------------------------------------------
// Job bodies — sync_injury_reports / sync_live_stats, Highlightly
// (highlightly.net via RapidAPI, host nfl-ncaa-highlights-api). Part 2
// Phase 1's live-stats vendor decision — see docs/part2-roadmap.md.
//
// NOT yet dry-run tested against a live key — HIGHLIGHTLY_API_KEY was
// only just provisioned. Written against Highlightly's documented
// request/response shape (highlightly.net/nfl-api/documentation/), which
// is itself a paraphrase of their docs page rather than a captured real
// response, so treat field names below as a best guess pending the first
// real dry run, not a confirmed contract — same "run it for real before
// trusting it" step every other vendor job here needed. Specifically:
//   - /matches and /matches/{id} (injuries) — the shape (team block ->
//     data[] -> {status, player:{name,jersey,position}}) is reasonably
//     confirmed from the docs' own example payload. NOT confirmed:
//     whether Highlightly's status strings line up with this app's
//     injury_report_status_enum, or whether there's a practice-status /
//     injury-description field at all — INJURY_STATUS_MAP only handles
//     the values the docs showed, and unrecognized ones are logged
//     (once) and left NULL rather than guessed.
//   - /box-score/{matchId} — only ONE example stat ({group:"Passing",
//     name:"Total Successful Passes"}) was confirmed from the docs;
//     the rest of STAT_FIELD_MAP is an educated guess at Highlightly's
//     naming convention. syncLiveStats logs any (group, name) pair it
//     doesn't recognize (once per pair) so the first live dry run,
//     during an actual game window, surfaces the real vocabulary to
//     correct this against.
//   - Player identity: injuries only give a name (no stable per-vendor
//     player id), so those match by name+team against `players` with NO
//     crosswalk and are SKIPPED (not inserted) on a 0 or >1 candidate
//     match. Box-score entries do carry a per-vendor player id, so those
//     go through a crosswalk (source='highlightly') — but neither path
//     inserts a new players row the way resolveIdentity() does for
//     nflverse data, because neither Highlightly response includes a
//     usable position, and a miss here is more likely a name-format
//     mismatch (or an unresolved roster move) than a genuinely new
//     player; better to skip and let sync_roster catch up than to mint
//     player records with no position from a job that polls every
//     minute during a live game.
// ---------------------------------------------------------------------

const HIGHLIGHTLY_HOST = 'nfl-ncaa-highlights-api.p.rapidapi.com';
const HIGHLIGHTLY_BASE = `https://${HIGHLIGHTLY_HOST}`;

async function fetchHighlightly(path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  const url = `${HIGHLIGHTLY_BASE}${path}${query ? `?${query}` : ''}`;
  const text = await fetchTextWithHeaders(url, {
    'x-rapidapi-key': process.env.HIGHLIGHTLY_API_KEY,
    'x-rapidapi-host': HIGHLIGHTLY_HOST,
  });
  return JSON.parse(text);
}

async function loadTeamNameMap() {
  const { rows } = await pool.query('SELECT team_id, name, abbreviation FROM teams');
  const idByName = {};
  const abbrByTeamId = {};
  for (const t of rows) {
    idByName[t.name] = t.team_id;
    abbrByTeamId[t.team_id] = t.abbreviation;
  }
  return { idByName, abbrByTeamId };
}

// Resolves one of our `games` rows to Highlightly's numeric match id, by
// date + team abbreviation (their documented /matches filters). Tries the
// game's UTC date first, then ±1 day — same tolerance idea as
// findGameForOddsEntry's ±1 day window, in case Highlightly buckets a
// late-kickoff game under a different calendar date than we do. Cached
// per game_id for the rest of this job run (shared by both jobs below,
// since both need the same match id).
async function findHighlightlyMatch(game, abbrByTeamId, cache) {
  if (cache.has(game.game_id)) return cache.get(game.game_id);

  const homeAbbr = abbrByTeamId[game.home_team_id];
  const awayAbbr = abbrByTeamId[game.away_team_id];
  if (!homeAbbr || !awayAbbr) {
    cache.set(game.game_id, null);
    return null;
  }

  const kickoff = new Date(game.game_datetime);
  const dateCandidates = [0, -1, 1].map((offset) => {
    const d = new Date(kickoff);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });

  for (const date of dateCandidates) {
    let payload;
    try {
      payload = await fetchHighlightly('/matches', {
        date, league: 'NFL', homeTeamAbbreviation: homeAbbr, awayTeamAbbreviation: awayAbbr, limit: 5,
      });
    } catch (err) {
      console.warn(`[highlightly] /matches lookup failed for ${awayAbbr}@${homeAbbr} on ${date} (${err.message})`);
      continue;
    }
    const matches = Array.isArray(payload) ? payload : payload?.data || [];
    if (matches.length) {
      cache.set(game.game_id, matches[0].id);
      return matches[0].id;
    }
  }

  console.warn(`[highlightly] no match found for ${awayAbbr}@${homeAbbr} near ${game.game_datetime}`);
  cache.set(game.game_id, null);
  return null;
}

// See file header — only 'questionable' is confirmed from Highlightly's
// docs example; the rest are a best guess at their vocabulary.
const INJURY_STATUS_MAP = {
  questionable: 'questionable',
  doubtful: 'doubtful',
  out: 'out',
  'injured reserve': 'injured_reserve',
  ir: 'injured_reserve',
  probable: 'probable',
  active: 'active',
};
const unrecognizedInjuryStatuses = new Set();

function mapInjuryStatus(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  const mapped = INJURY_STATUS_MAP[key];
  if (!mapped && !unrecognizedInjuryStatuses.has(key)) {
    unrecognizedInjuryStatuses.add(key);
    console.warn(`[job:sync_injury_reports] unrecognized status "${raw}" — leaving report_status NULL for this row`);
  }
  return mapped || null;
}

// Name+team match against `players`. See file header re: why this does
// NOT insert a new player the way resolveIdentity() does.
async function findPlayerIdByName(fullName, teamId, cache) {
  const cacheKey = `${fullName}|${teamId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const { rows } = await pool.query(
    `SELECT player_id FROM players WHERE lower(full_name) = lower($1) AND current_team_id = $2 LIMIT 2`,
    [fullName, teamId]
  );
  const playerId = rows.length === 1 ? rows[0].player_id : null;
  if (!playerId) {
    console.warn(
      `[job:sync_injury_reports] ${rows.length === 0 ? 'no' : 'ambiguous'} player match for "${fullName}" (team_id ${teamId}) — skipping`
    );
  }
  cache.set(cacheKey, playerId);
  return playerId;
}

async function syncInjuryReports() {
  if (!process.env.HIGHLIGHTLY_API_KEY) {
    console.warn('[job:sync_injury_reports] HIGHLIGHTLY_API_KEY not set — skipping (see .env.example)');
    return { recordsProcessed: 0 };
  }

  const { rows: games } = await pool.query(
    `SELECT game_id, season, week, home_team_id, away_team_id, game_datetime
     FROM games
     WHERE status = 'scheduled' AND game_datetime BETWEEN now() AND now() + interval '8 days'`
  );
  if (!games.length) {
    console.log('[job:sync_injury_reports] no upcoming games in the next 8 days');
    return { recordsProcessed: 0 };
  }

  const { abbrByTeamId } = await loadTeamNameMap();
  const matchCache = new Map();
  const playerCache = new Map();
  const today = new Date().toISOString().slice(0, 10);
  let processed = 0;

  for (const game of games) {
    const matchId = await findHighlightlyMatch(game, abbrByTeamId, matchCache);
    if (!matchId) continue;

    let detail;
    try {
      detail = await fetchHighlightly(`/matches/${matchId}`);
    } catch (err) {
      console.warn(`[job:sync_injury_reports] /matches/${matchId} fetch failed for game ${game.game_id} (${err.message})`);
      continue;
    }

    for (const teamBlock of detail.injuries || []) {
      const blockAbbr = teamBlock.team?.abbreviation;
      const teamId =
        blockAbbr === abbrByTeamId[game.home_team_id] ? game.home_team_id :
        blockAbbr === abbrByTeamId[game.away_team_id] ? game.away_team_id :
        null;
      if (!teamId) {
        console.warn(`[job:sync_injury_reports] injury block team "${blockAbbr}" didn't match either side of game ${game.game_id}`);
        continue;
      }

      for (const entry of teamBlock.data || []) {
        const fullName = entry.player?.name;
        if (!fullName) continue;
        const playerId = await findPlayerIdByName(fullName, teamId, playerCache);
        if (!playerId) continue;

        // Avoid piling up identical rows every time this job's
        // day-of-week-proximity cadence fires again within the same
        // calendar day — only insert if today's latest row for this
        // player differs (or doesn't exist yet). Still a real time
        // series across days, just not re-stamped on every unchanged poll.
        const { rows: existing } = await pool.query(
          `SELECT report_status, primary_injury FROM injury_reports
           WHERE player_id = $1 AND report_date = $2
           ORDER BY created_at DESC LIMIT 1`,
          [playerId, today]
        );
        const reportStatus = mapInjuryStatus(entry.status);
        const primaryInjury = entry.injury || entry.description || null;
        if (existing.length && existing[0].report_status === reportStatus && existing[0].primary_injury === primaryInjury) {
          continue;
        }

        await pool.query(
          `INSERT INTO injury_reports (player_id, team_id, season, week, report_date, report_status, primary_injury)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [playerId, teamId, game.season, game.week, today, reportStatus, primaryInjury]
        );
        processed++;
      }
    }
  }

  console.log(`[job:sync_injury_reports] ${processed} injury row(s) recorded across ${games.length} upcoming game(s)`);
  return { recordsProcessed: processed };
}

// Box-score stat (group, name) -> our upsertOffense/Defense/StBatch column
// name + bucket. Keys are lowercased "group|name". See file header — only
// the 'passing|total successful passes' entry is confirmed; the rest are
// a best-effort guess pending a real dry run.
const STAT_FIELD_MAP = {
  'passing|total successful passes': { bucket: 'offense', col: 'completions' },
  'passing|pass attempts': { bucket: 'offense', col: 'attempts' },
  'passing|passing attempts': { bucket: 'offense', col: 'attempts' },
  'passing|passing yards': { bucket: 'offense', col: 'passing_yards' },
  'passing|passing touchdowns': { bucket: 'offense', col: 'passing_tds' },
  'passing|interceptions thrown': { bucket: 'offense', col: 'passing_interceptions' },
  'passing|sacks taken': { bucket: 'offense', col: 'sacks_suffered' },
  'rushing|rushing attempts': { bucket: 'offense', col: 'carries' },
  'rushing|carries': { bucket: 'offense', col: 'carries' },
  'rushing|rushing yards': { bucket: 'offense', col: 'rushing_yards' },
  'rushing|rushing touchdowns': { bucket: 'offense', col: 'rushing_tds' },
  'rushing|fumbles lost': { bucket: 'offense', col: 'fumbles_lost_total' },
  'receiving|targets': { bucket: 'offense', col: 'targets' },
  'receiving|receptions': { bucket: 'offense', col: 'receptions' },
  'receiving|receiving yards': { bucket: 'offense', col: 'receiving_yards' },
  'receiving|receiving touchdowns': { bucket: 'offense', col: 'receiving_tds' },
  'defense|solo tackles': { bucket: 'defense', col: 'def_tackles_solo' },
  'defense|assisted tackles': { bucket: 'defense', col: 'def_tackles_with_assist' },
  'defense|sacks': { bucket: 'defense', col: 'def_sacks' },
  'defense|tackles for loss': { bucket: 'defense', col: 'def_tackles_for_loss' },
  'defense|qb hits': { bucket: 'defense', col: 'def_qb_hits' },
  'defense|interceptions': { bucket: 'defense', col: 'def_interceptions' },
  'defense|passes defended': { bucket: 'defense', col: 'def_pass_defended' },
  'defense|forced fumbles': { bucket: 'defense', col: 'def_fumbles_forced' },
  'defense|fumble recoveries': { bucket: 'defense', col: 'def_fumbles' },
  'defense|defensive touchdowns': { bucket: 'defense', col: 'def_tds' },
  'special teams|field goals attempted': { bucket: 'special_teams', col: 'fg_att' },
  'special teams|field goals made': { bucket: 'special_teams', col: 'fg_made' },
  'special teams|extra points attempted': { bucket: 'special_teams', col: 'pat_att' },
  'special teams|extra points made': { bucket: 'special_teams', col: 'pat_made' },
  'special teams|kickoff return yards': { bucket: 'special_teams', col: 'kickoff_return_yards' },
  'special teams|punt return yards': { bucket: 'special_teams', col: 'punt_return_yards' },
  'special teams|special teams touchdowns': { bucket: 'special_teams', col: 'special_teams_tds' },
};
const unrecognizedStatKeys = new Set();

async function getLiveGames() {
  const { rows } = await pool.query(
    `SELECT game_id, home_team_id, away_team_id, game_datetime FROM games
     WHERE now() BETWEEN game_datetime AND game_datetime + interval '4 hours'`
  );
  return rows;
}

// Box-score player resolution: unlike resolveIdentity(), this does NOT
// insert a new players row on an ambiguous/missing name match (no
// position data is available here to disambiguate — see file header).
// Does still write the crosswalk on a confident match, so repeat polls
// during a live game hit the crosswalk instead of re-matching by name
// every minute.
async function resolvePlayerForBoxScore(vendorPlayerId, fullName, teamId, cache) {
  const cacheKey = String(vendorPlayerId);
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const { rows: crosswalked } = await pool.query(
    `SELECT player_id FROM player_id_crosswalk WHERE source = 'highlightly' AND source_player_id = $1`,
    [cacheKey]
  );
  if (crosswalked.length) {
    cache.set(cacheKey, crosswalked[0].player_id);
    return crosswalked[0].player_id;
  }

  const { rows: matches } = await pool.query(
    `SELECT player_id FROM players WHERE lower(full_name) = lower($1) AND current_team_id = $2 LIMIT 2`,
    [fullName, teamId]
  );
  if (matches.length !== 1) {
    console.warn(
      `[job:sync_live_stats] ${matches.length === 0 ? 'no' : 'ambiguous'} player match for "${fullName}" (team_id ${teamId}) — skipping this stat line`
    );
    cache.set(cacheKey, null);
    return null;
  }

  const playerId = matches[0].player_id;
  await pool.query(
    `INSERT INTO player_id_crosswalk (player_id, source, source_player_id, match_confidence)
     VALUES ($1, 'highlightly', $2, 'matched') ON CONFLICT (source, source_player_id) DO NOTHING`,
    [playerId, cacheKey]
  );
  cache.set(cacheKey, playerId);
  return playerId;
}

async function syncLiveStats() {
  if (!process.env.HIGHLIGHTLY_API_KEY) {
    console.warn('[job:sync_live_stats] HIGHLIGHTLY_API_KEY not set — skipping (see .env.example)');
    return { recordsProcessed: 0 };
  }

  const games = await getLiveGames();
  if (!games.length) return { recordsProcessed: 0 };

  const { idByName, abbrByTeamId } = await loadTeamNameMap();
  const matchCache = new Map();
  const identityCache = new Map();

  // Keyed by `${gameId}|${playerId}` so multiple stat lines for the same
  // player within one box score merge into a single upsert row instead of
  // one query per stat.
  const offenseRows = {}, defenseRows = {}, stRows = {};
  function rowFor(store, gameId, playerId, teamId) {
    const key = `${gameId}|${playerId}`;
    if (!store[key]) store[key] = { row: { game_id: gameId }, playerId, teamId };
    return store[key].row;
  }

  let processed = 0;

  for (const game of games) {
    const matchId = await findHighlightlyMatch(game, abbrByTeamId, matchCache);
    if (!matchId) continue;

    let boxScore;
    try {
      boxScore = await fetchHighlightly(`/box-score/${matchId}`);
    } catch (err) {
      console.warn(`[job:sync_live_stats] /box-score/${matchId} fetch failed for game ${game.game_id} (${err.message})`);
      continue;
    }
    if (!Array.isArray(boxScore)) {
      console.warn(`[job:sync_live_stats] unexpected /box-score/${matchId} response shape, skipping`);
      continue;
    }

    const usedTeamIds = new Set();
    for (const teamBlock of boxScore) {
      const teamName = teamBlock.team?.name;
      let teamId = idByName[teamName];
      if (!teamId) {
        // Fallback: only two possible teams for this game — assign
        // whichever side hasn't been claimed yet by the other block.
        teamId = [game.home_team_id, game.away_team_id].find((id) => !usedTeamIds.has(id)) || null;
      }
      if (!teamId) {
        console.warn(`[job:sync_live_stats] couldn't match box-score team "${teamName}" to game ${game.game_id}`);
        continue;
      }
      usedTeamIds.add(teamId);

      for (const entry of teamBlock.team?.boxScores || []) {
        const vendorPlayerId = entry.player?.id;
        const fullName = entry.player?.name;
        if (!vendorPlayerId || !fullName) continue;

        const playerId = await resolvePlayerForBoxScore(vendorPlayerId, fullName, teamId, identityCache);
        if (!playerId) continue;

        for (const stat of entry.statistics || []) {
          const mapKey = `${(stat.group || '').trim().toLowerCase()}|${(stat.name || '').trim().toLowerCase()}`;
          const mapped = STAT_FIELD_MAP[mapKey];
          if (!mapped) {
            if (!unrecognizedStatKeys.has(mapKey)) {
              unrecognizedStatKeys.add(mapKey);
              console.warn(`[job:sync_live_stats] unrecognized stat "${stat.group} / ${stat.name}" — not recorded (see STAT_FIELD_MAP)`);
            }
            continue;
          }
          const store = mapped.bucket === 'offense' ? offenseRows : mapped.bucket === 'defense' ? defenseRows : stRows;
          const row = rowFor(store, game.game_id, playerId, teamId);
          row[mapped.col] = stat.value;
        }
        processed++;
      }
    }
  }

  await upsertOffenseBatch(Object.values(offenseRows));
  await upsertDefenseBatch(Object.values(defenseRows));
  await upsertStBatch(Object.values(stRows));

  console.log(`[job:sync_live_stats] ${processed} player-line(s) updated across ${games.length} live game(s)`);
  return { recordsProcessed: processed };
}

// ---------------------------------------------------------------------
// Job body — sync_odds, REAL (The Odds API — the-odds-api.com, free
// tier). Part 2 Phase 1's highest-leverage data gap: without odds, no
// agent can compare its own read on a matchup against what the market
// already thinks (see docs/part2-roadmap.md).
//
// NOT yet dry-run tested against a live key — ODDS_API_KEY doesn't exist
// anywhere yet (see .env.example). Written against The Odds API's
// documented request/response shape (the-odds-api.com/liveapi/guides/v4/);
// needs the same "run once manually against a real key before trusting
// the scheduler" treatment every other job here got before this comment
// can be removed. Likely first-run surprises, going in with eyes open:
//   - Credit cost per call wasn't fully confirmed from the docs (looked
//     to be per-market-per-region, not per-game, which would make this
//     cheap — but that needs confirming against real usage once a key
//     exists, not assumed).
//   - Team-name matching (`teams.name` vs. the vendor's `home_team`/
//     `away_team` strings) assumes exact string equality — nflverse's
//     'LA'-vs-'LAR' abbreviation quirk (see architecture.md §3) was a
//     reminder that vendor data doesn't always agree on naming; this
//     hasn't been checked against The Odds API's actual team-name
//     strings yet.
// ---------------------------------------------------------------------

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/';
const ODDS_MARKETS = ['h2h', 'spreads', 'totals'];

function oddsApiUrl() {
  const params = new URLSearchParams({
    apiKey: process.env.ODDS_API_KEY,
    regions: 'us',
    markets: ODDS_MARKETS.join(','),
    oddsFormat: 'american',
  });
  return `${ODDS_API_BASE}?${params.toString()}`;
}

// Resolves one odds-API game entry (home_team/away_team names +
// commence_time) to our own game_id. Matches on team pair + a ±1-day
// window around commence_time rather than an exact timestamp match, since
// a flex-schedule change between when nflverse's schedule and this
// vendor's commence_time were captured shouldn't cause a miss. Cached
// per (team pair, commence_time) for the rest of this job run — mirrors
// resolveIdentity()'s in-memory cache pattern, just for games instead of
// players (not worth a persistent crosswalk table for this: unlike player
// identity, which is looked up constantly across many jobs, this lookup
// only ever needs to happen inside this one job).
async function findGameForOddsEntry(entry, teamIdByName, cache) {
  const cacheKey = `${entry.home_team}|${entry.away_team}|${entry.commence_time}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const homeTeamId = teamIdByName[entry.home_team];
  const awayTeamId = teamIdByName[entry.away_team];
  if (!homeTeamId || !awayTeamId) {
    console.warn(`[job:sync_odds] no team match for "${entry.away_team}" @ "${entry.home_team}" — skipping`);
    cache.set(cacheKey, null);
    return null;
  }

  const { rows } = await pool.query(
    `SELECT game_id FROM games
     WHERE home_team_id = $1 AND away_team_id = $2
       AND game_datetime BETWEEN $3::timestamptz - interval '1 day' AND $3::timestamptz + interval '1 day'
     LIMIT 1`,
    [homeTeamId, awayTeamId, entry.commence_time]
  );
  const gameId = rows[0]?.game_id || null;
  if (!gameId) console.warn(`[job:sync_odds] no games row matched "${entry.away_team}" @ "${entry.home_team}" near ${entry.commence_time}`);
  cache.set(cacheKey, gameId);
  return gameId;
}

// Pairs a market's outcomes (The Odds API always returns both sides of a
// market together) into the single row shape game_odds stores — see
// 003_game_odds.sql for why one row covers both sides rather than one row
// per outcome.
function extractMarketRow(market, homeTeamName, awayTeamName) {
  const row = {};
  if (market.key === 'h2h') {
    for (const o of market.outcomes || []) {
      if (o.name === homeTeamName) row.homePrice = o.price;
      else if (o.name === awayTeamName) row.awayPrice = o.price;
    }
  } else if (market.key === 'spreads') {
    for (const o of market.outcomes || []) {
      if (o.name === homeTeamName) { row.homePrice = o.price; row.homePoint = o.point; }
      else if (o.name === awayTeamName) { row.awayPrice = o.price; row.awayPoint = o.point; }
    }
  } else if (market.key === 'totals') {
    for (const o of market.outcomes || []) {
      if (o.name === 'Over') { row.overPrice = o.price; row.totalPoint = o.point; }
      else if (o.name === 'Under') { row.underPrice = o.price; row.totalPoint = o.point; }
    }
  }
  return row;
}

async function syncOdds() {
  if (!process.env.ODDS_API_KEY) {
    console.warn('[job:sync_odds] ODDS_API_KEY not set — skipping (see .env.example)');
    return { recordsProcessed: 0 };
  }

  let entries;
  try {
    const text = await fetchText(oddsApiUrl());
    entries = JSON.parse(text);
  } catch (err) {
    console.warn(`[job:sync_odds] fetch failed (${err.message})`);
    return { recordsProcessed: 0 };
  }
  if (!Array.isArray(entries)) {
    // The Odds API returns an error object (not an array) on a bad key,
    // exhausted quota, etc. — surface it plainly rather than crashing on
    // an assumption that the response is always the happy-path array.
    console.warn(`[job:sync_odds] unexpected response (not an array), skipping this run: ${JSON.stringify(entries).slice(0, 500)}`);
    return { recordsProcessed: 0 };
  }

  const { rows: teams } = await pool.query('SELECT team_id, name FROM teams');
  const teamIdByName = {};
  for (const t of teams) teamIdByName[t.name] = t.team_id;

  const gameCache = new Map();
  const rowsToInsert = [];

  for (const entry of entries) {
    const gameId = await findGameForOddsEntry(entry, teamIdByName, gameCache);
    if (!gameId) continue;

    for (const bookmaker of entry.bookmakers || []) {
      for (const market of bookmaker.markets || []) {
        if (!ODDS_MARKETS.includes(market.key)) continue;
        const parsed = extractMarketRow(market, entry.home_team, entry.away_team);
        rowsToInsert.push({
          gameId,
          bookmaker: bookmaker.key,
          market: market.key,
          bookmakerLastUpdate: bookmaker.last_update || null,
          ...parsed,
        });
      }
    }
  }

  for (const r of rowsToInsert) {
    await pool.query(
      `INSERT INTO game_odds (
         game_id, bookmaker, market, home_price, away_price, home_point, away_point,
         over_price, under_price, total_point, bookmaker_last_update
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        r.gameId, r.bookmaker, r.market,
        n(r.homePrice), n(r.awayPrice), n(r.homePoint), n(r.awayPoint),
        n(r.overPrice), n(r.underPrice), n(r.totalPoint),
        r.bookmakerLastUpdate,
      ]
    );
  }

  console.log(`[job:sync_odds] ${rowsToInsert.length} odds row(s) recorded across ${entries.length} game(s) from the vendor`);
  return { recordsProcessed: rowsToInsert.length };
}

// ---------------------------------------------------------------------
// grade_picks — calibration/tracking layer (Part 2 Phase 2, "3 paths"
// discussion — see docs/part2-roadmap.md). Grades any picks_log row
// whose linked game has gone final: looks up the actual stat value,
// compares it to the pick's line/direction, and writes back status +
// actual_value. Doesn't care who or what inserted the pick (a future
// agent, or scripts/seed-test-picks.js for now) — this is purely "given
// a claim and a fact, was the claim right." No external vendor call, so
// unlike every other job here it only ever touches our own tables.
// ---------------------------------------------------------------------

// stat_category -> which *_game_stats table/column(s) hold the actual
// value. Deliberately the same categories backend/lib/insights.js's
// POSITION_STAT_MAP / DEFENSE_STAT already key off of (passing/rushing/
// receiving yards from player_offense_game_stats, combined tackles from
// player_defense_game_stats) — see 004_picks_log.sql's header for why
// this table is scoped to player-stat picks only, not game lines.
// tackles COALESCEs both columns to 0 rather than leaving the SQL sum
// NULL-poisoned if either side wasn't reported — see gradePendingPicks's
// void-detection, which relies on "no row at all" (not "a null column")
// meaning ungradeable for this expression.
const STAT_CATEGORY_MAP = {
  passing_yards: { table: 'player_offense_game_stats', expr: 'passing_yards' },
  rushing_yards: { table: 'player_offense_game_stats', expr: 'rushing_yards' },
  receiving_yards: { table: 'player_offense_game_stats', expr: 'receiving_yards' },
  tackles: { table: 'player_defense_game_stats', expr: '(COALESCE(tackles_solo, 0) + COALESCE(tackles_assist, 0))' },
};

async function gradePendingPicks() {
  const { rows: pending } = await pool.query(
    `SELECT pl.pick_id, pl.game_id, pl.player_id, pl.stat_category, pl.predicted_direction, pl.predicted_line
     FROM picks_log pl
     JOIN games g ON g.game_id = pl.game_id
     WHERE pl.status = 'pending' AND g.status = 'final'`
  );

  if (!pending.length) {
    console.log('[job:grade_picks] no pending picks with a final game — nothing to grade');
    return { recordsProcessed: 0 };
  }

  let graded = 0;
  const tallies = { correct: 0, incorrect: 0, push: 0, void: 0 };

  for (const pick of pending) {
    const statConfig = STAT_CATEGORY_MAP[pick.stat_category];
    if (!statConfig) {
      // Left 'pending' on purpose, not voided — an unrecognized category
      // means STAT_CATEGORY_MAP is missing an entry (a bug on our side),
      // not that the pick is ungradeable. Fix the map and the next run
      // picks it back up.
      console.warn(`[job:grade_picks] pick ${pick.pick_id}: unrecognized stat_category "${pick.stat_category}" — skipping (see STAT_CATEGORY_MAP)`);
      continue;
    }

    const { rows } = await pool.query(
      `SELECT ${statConfig.expr} AS actual_value FROM ${statConfig.table} WHERE game_id = $1 AND player_id = $2`,
      [pick.game_id, pick.player_id]
    );

    let status;
    let actualValue = null;
    if (!rows.length || rows[0].actual_value === null) {
      // Game is final but this player has no stat row for it (or an
      // unexpectedly null column on a single-stat category) — inactive,
      // DNP, or a vendor gap. Can't be graded correct/incorrect, and
      // shouldn't sit 'pending' forever waiting for a stat that will
      // never arrive.
      status = 'void';
    } else {
      actualValue = Number(rows[0].actual_value);
      if (actualValue === Number(pick.predicted_line)) {
        status = 'push';
      } else if (pick.predicted_direction === 'over') {
        status = actualValue > pick.predicted_line ? 'correct' : 'incorrect';
      } else {
        status = actualValue < pick.predicted_line ? 'correct' : 'incorrect';
      }
    }

    await pool.query(
      `UPDATE picks_log SET status = $2, actual_value = $3, graded_at = now() WHERE pick_id = $1`,
      [pick.pick_id, status, actualValue]
    );
    tallies[status] = (tallies[status] || 0) + 1;
    graded++;
  }

  // All-time hit rate (not just this run) so it's visible in Railway logs
  // after every scheduled fire, same "computes hit rate" ask this job
  // exists to satisfy. Pushes and voids are excluded from the
  // denominator — same convention as a sportsbook hold calculation — so
  // a batch of ungradeable picks doesn't quietly deflate it.
  const { rows: hitRateRows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'correct') AS correct,
            COUNT(*) FILTER (WHERE status = 'incorrect') AS incorrect
     FROM picks_log`
  );
  const { correct, incorrect } = hitRateRows[0];
  const decided = Number(correct) + Number(incorrect);
  const hitRate = decided > 0 ? `${((Number(correct) / decided) * 100).toFixed(1)}%` : 'n/a';

  console.log(
    `[job:grade_picks] graded ${graded} pick(s) this run ` +
      `(${tallies.correct} correct, ${tallies.incorrect} incorrect, ${tallies.push} push, ${tallies.void} void) — ` +
      `all-time hit rate: ${hitRate} (${correct}/${decided} decided)`
  );
  return { recordsProcessed: graded };
}

// ---------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------

const JOBS = {
  sync_roster: {
    source: 'nflverse',
    schedule: { type: 'fixed', intervalMinutes: 24 * 60 },
    run: syncRoster,
  },
  sync_schedule: {
    source: 'nflverse',
    schedule: { type: 'fixed', intervalMinutes: 24 * 60 },
    run: syncSchedule,
  },
  sync_historical_stats: {
    source: 'nflverse',
    schedule: { type: 'fixed', intervalMinutes: 24 * 60 },
    run: syncHistoricalStats,
  },
  sync_forecast_weather: {
    source: 'open-meteo',
    schedule: {
      type: 'proximity',
      buckets: [
        { hoursBefore: 72, intervalMinutes: 360 },
        { hoursBefore: 12, intervalMinutes: 120 },
        { hoursBefore: 0, intervalMinutes: 30 },
      ],
    },
    run: syncForecastWeather,
  },
  sync_injury_reports: {
    source: 'live_stats_vendor',
    schedule: { type: 'day-of-week-proximity' },
    run: syncInjuryReports,
  },
  sync_live_stats: {
    source: 'live_stats_vendor',
    schedule: { type: 'game-window', pollSeconds: 20 },
    run: syncLiveStats,
  },
  sync_odds: {
    source: 'the-odds-api',
    // Reuses the same proximity shape as sync_forecast_weather — line
    // movement matters most close to kickoff, same reasoning as weather.
    schedule: {
      type: 'proximity',
      buckets: [
        { hoursBefore: 72, intervalMinutes: 360 },
        { hoursBefore: 12, intervalMinutes: 60 },
        { hoursBefore: 0, intervalMinutes: 15 },
      ],
    },
    run: syncOdds,
  },
  grade_picks: {
    source: 'internal', // grades our own picks_log against our own games/stats — no vendor call
    schedule: { type: 'fixed', intervalMinutes: 60 },
    run: gradePendingPicks,
  },
};

// In-memory last-run tracking, seeded from ingestion_runs on startup (see
// loadLastRunAtFromDb) so a worker restart doesn't forget recent runs and
// immediately re-fire everything.
const lastRunAt = {};

// ---------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------

async function tick() {
  const now = new Date();
  for (const [jobType, job] of Object.entries(JOBS)) {
    try {
      if (await isDue(jobType, job, now)) {
        runJob(jobType, job); // fire and forget — see runJob's own error handling
      }
    } catch (err) {
      console.error(`[scheduler] isDue() check failed for ${jobType}:`, err);
    }
  }
}

async function isDue(jobType, job, now) {
  const { schedule } = job;
  switch (schedule.type) {
    case 'fixed':
      return minutesSince(lastRunAt[jobType], now) >= schedule.intervalMinutes;

    case 'proximity': {
      const nextGame = await getNextUpcomingGame();
      if (!nextGame) return false;
      const hoursUntil = hoursBetween(now, nextGame.game_datetime);
      const bucket = pickProximityBucket(schedule.buckets, hoursUntil);
      return minutesSince(lastRunAt[jobType], now) >= bucket.intervalMinutes;
    }

    case 'day-of-week-proximity':
      return isInjuryReportWindowDue(now, lastRunAt[jobType]);

    case 'game-window':
      return isGameWindowActive(now);

    default:
      return false;
  }
}

// `retry: false` is used by the CLI's one-shot dry-run mode (see the entry
// point below) — without it, a failed job would schedule a setTimeout
// retry that the CLI process then kills anyway when it exits right after
// this promise resolves, so the retry silently never runs. The background
// scheduler (tick() -> runJob(jobType, job), no options) always wants the
// real retry/backoff behavior, so it keeps the default.
async function runJob(jobType, job, { retry = true } = {}) {
  const runId = await logRunStart(jobType, job.source);
  lastRunAt[jobType] = new Date();

  try {
    const { recordsProcessed } = await job.run();
    await logRunSuccess(runId, recordsProcessed);
    return { ok: true };
  } catch (err) {
    console.error(`[job:${jobType}] failed:`, err);
    await logRunFailure(runId, err);
    if (retry) scheduleRetry(jobType, job);
    return { ok: false, err };
  }
}

function scheduleRetry(jobType, job, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  if (attempt > MAX_ATTEMPTS) {
    console.error(`[job:${jobType}] giving up after ${MAX_ATTEMPTS} attempts`);
    return;
  }
  const delayMs = Math.min(2 ** attempt * 1000, 5 * 60 * 1000);
  setTimeout(async () => {
    const runId = await logRunStart(jobType, job.source);
    try {
      const { recordsProcessed } = await job.run();
      await logRunSuccess(runId, recordsProcessed);
    } catch (err) {
      console.error(`[job:${jobType}] retry ${attempt} failed:`, err);
      await logRunFailure(runId, err);
      scheduleRetry(jobType, job, attempt + 1);
    }
  }, delayMs);
}

// ---------------------------------------------------------------------
// Scheduling helpers backed by real data
// ---------------------------------------------------------------------

function minutesSince(lastRun, now) {
  if (!lastRun) return Infinity;
  return (now - lastRun) / 60000;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

function pickProximityBucket(buckets, hoursUntil) {
  const sorted = [...buckets].sort((a, b) => b.hoursBefore - a.hoursBefore);
  let chosen = sorted[sorted.length - 1];
  for (const bucket of sorted) {
    if (hoursUntil <= bucket.hoursBefore) chosen = bucket;
  }
  return chosen;
}

async function getNextUpcomingGame() {
  const { rows } = await pool.query(
    `SELECT game_id, game_datetime FROM games WHERE status = 'scheduled' ORDER BY game_datetime ASC LIMIT 1`
  );
  return rows[0] || null;
}

async function isGameWindowActive(now) {
  const { rows } = await pool.query(
    `SELECT 1 FROM games
     WHERE $1::timestamptz BETWEEN game_datetime AND game_datetime + interval '4 hours'
     LIMIT 1`,
    [now]
  );
  return rows.length > 0;
}

// Injury reports firm up as the week builds toward Sunday — cadence tuned
// per the Phase 2 discussion (Mon-Wed thinnest, tightening Thu-Sat, game
// day itself checked most often for late scratches). Pure scheduling
// logic, no vendor call needed — real today even though syncInjuryReports
// itself is still a stub.
const INJURY_REPORT_CADENCE_MINUTES = {
  0: 180,      // Sunday — game day, check every 3h for late scratches
  1: 24 * 60,  // Monday — thinnest right after the previous game
  2: 24 * 60,  // Tuesday
  3: 12 * 60,  // Wednesday — official practice reports start
  4: 12 * 60,  // Thursday
  5: 6 * 60,   // Friday — final injury designations typically land
  6: 6 * 60,   // Saturday
};
function isInjuryReportWindowDue(now, lastRun) {
  const cadence = INJURY_REPORT_CADENCE_MINUTES[now.getUTCDay()];
  return minutesSince(lastRun, now) >= cadence;
}

// ---------------------------------------------------------------------
// ingestion_runs logging — backs both operational debugging and the
// query API's `meta.freshness` ("synced 4m ago").
// ---------------------------------------------------------------------

async function logRunStart(jobType, source) {
  const { rows } = await pool.query(
    `INSERT INTO ingestion_runs (job_type, source, status) VALUES ($1, $2, 'running') RETURNING run_id`,
    [jobType, source]
  );
  return rows[0].run_id;
}

async function logRunSuccess(runId, recordsProcessed) {
  // records_processed is an INT column — defensively round/coerce here so
  // a future job returning a non-integer count (as sync_schedule once did,
  // see git history) fails loudly in that job's own try/catch instead of
  // crashing the logging step for every job.
  const safeCount = Number.isFinite(recordsProcessed) ? Math.round(recordsProcessed) : 0;
  await pool.query(
    `UPDATE ingestion_runs SET status = 'success', finished_at = now(), records_processed = $2 WHERE run_id = $1`,
    [runId, safeCount]
  );
}

async function logRunFailure(runId, err) {
  await pool.query(
    `UPDATE ingestion_runs SET status = 'failed', finished_at = now(), error_message = $2 WHERE run_id = $1`,
    [runId, String(err && err.message ? err.message : err).slice(0, 2000)]
  );
}

async function loadLastRunAtFromDb() {
  const { rows } = await pool.query(
    `SELECT job_type, MAX(finished_at) AS finished_at FROM ingestion_runs WHERE status = 'success' GROUP BY job_type`
  );
  for (const r of rows) lastRunAt[r.job_type] = r.finished_at;
  console.log(`[ingestion-worker] loaded last-run times for ${rows.length} job type(s) from ingestion_runs`);
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

async function start() {
  await loadLastRunAtFromDb();
  setInterval(tick, 60 * 1000); // evaluate every minute; each job's own schedule decides if it's actually due
  console.log('[ingestion-worker] started.');
}

process.on('SIGTERM', async () => {
  console.log('[ingestion-worker] SIGTERM received, shutting down...');
  await pool.end();
  process.exit(0);
});

if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error('[ingestion-worker] DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }
  // `node ingestion-worker.js <jobType>` runs one job once and exits —
  // for dry-running a job against a real DATABASE_URL locally before
  // trusting it to run unattended on Railway's schedule (same idea as
  // `npm run backfill-historical` being run manually first).
  const onceJobType = process.argv[2];
  if (onceJobType) {
    if (!JOBS[onceJobType]) {
      console.error(`[ingestion-worker] unknown job "${onceJobType}". Valid jobs: ${Object.keys(JOBS).join(', ')}`);
      process.exit(1);
    }
    console.log(`[ingestion-worker] running "${onceJobType}" once (manual dry run)...`);
    runJob(onceJobType, JOBS[onceJobType], { retry: false }).then(({ ok }) =>
      pool.end().then(() => process.exit(ok ? 0 : 1))
    );
  } else {
    start();
  }
}

module.exports = { start, JOBS, resolveIdentity, currentNflSeason };
