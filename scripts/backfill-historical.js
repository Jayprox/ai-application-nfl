/**
 * Chalk That NFL — historical games + box-score stats backfill
 * =========================================================================
 * Loads real completed-season data from nflverse into games,
 * team_game_stats, and the three player_*_game_stats tables. Sources
 * confirmed directly from nflverse's own build scripts (nflverse-pbp /
 * nflfastR source, cloned and inspected — not guessed):
 *
 *   games:   https://github.com/nflverse/nfldata (raw) data/games.csv
 *            — every game since 1999, one row per game, game_id already
 *            in our exact PK format (e.g. "2023_01_KC_DET").
 *
 *   player stats: nflverse-data release "stats_player", file
 *            stats_player_week_<season>.csv — one row per player per
 *            game (week-level summary), built by nflfastR::calculate_stats().
 *            Already includes game_id directly, so no schedule-matching
 *            join is needed.
 *
 * Known, deliberate gaps (the data doesn't exist in this source — not a
 * bug, see the conversation this was scoped in):
 *   - Punting stats (punts, punt_yards, punt_avg) are never computed by
 *     nflverse's stat pipeline — only punt RETURNS are. Left null.
 *   - weather_condition is only reliably known for indoor games (roof
 *     dome/closed -> 'dome'). Outdoor games only give us numeric temp/wind,
 *     not a precipitation description, so it's left null rather than
 *     guessed. A real fix would be a historical-weather API backfill
 *     (Open-Meteo has one) — backlogged, not done here.
 *   - team_game_stats.penalties / penalty_yards / time_of_possession_seconds
 *     aren't in this data source either — left null. points/passing_yards/
 *     rushing_yards/turnovers ARE populated (points from games.csv's final
 *     score; the rest derived by summing the player rows we just loaded,
 *     which guarantees team and player numbers agree with each other).
 *
 * A player can end up with rows in MORE than one of the three
 * player_*_game_stats tables for the same game (e.g. a WR who also
 * returned punts gets both an offense row AND a special-teams row) —
 * decided per-row by which stat categories actually have non-zero values
 * that week, not by the player's fixed roster position_group. This is
 * more accurate than the original one-table-per-player assumption and
 * needs no schema change — see schema.sql's own comment flagging this as
 * something to revisit once real ingestion code existed.
 *
 * Run with: node scripts/backfill-historical.js <startSeason> <endSeason>
 * e.g.:     node scripts/backfill-historical.js 2021 2026
 * =========================================================================
 */

require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');
const { parse } = require('csv-parse/sync');

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const playerStatsUrl = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;

const BATCH_SIZE = 100;

// nflverse's games.csv (and its other data files — player stats, rosters)
// use 'LA' for the Los Angeles Rams; our own teams table (scripts/seed.js)
// uses 'LAR'. Confirmed by diffing games.csv's home_team/away_team values
// for 2021-2026 against our 32 real team abbreviations — 'LA' was the only
// mismatch found. This one mismatch was the root cause of 112 Rams games
// being skipped during loadGames() on the first run, which cascaded into
// player_defense_game_stats_game_id_fkey violations (and a full per-season
// rollback) in the player-stats loader downstream, since the player-stats
// CSVs still reference those game_ids. Applied everywhere an nflverse team
// abbreviation is looked up against our teamIdByAbbr/stadiumIdByAbbr maps.
const TEAM_ABBR_ALIASES = { LA: 'LAR' };
function normalizeAbbr(abbr) {
  return TEAM_ABBR_ALIASES[abbr] || abbr;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// ---------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'chalk-that-nfl-backfill-script' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchText(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

async function fetchCsv(url) {
  const text = await fetchText(url);
  return parse(text, { columns: true, skip_empty_lines: true });
}

// ---------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------

const THANKSGIVING_MONTH_DAY_RANGE = { month: 11, minDay: 22, maxDay: 28 }; // 4th Thursday of Nov

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
  return null; // see file header — genuinely unknown for outdoor games from this data source
}

// ---------------------------------------------------------------------
// Step 1: games
// ---------------------------------------------------------------------

async function loadGames(client, startSeason, endSeason, teamIdByAbbr, stadiumIdByAbbr) {
  console.log(`[backfill] fetching games: ${GAMES_URL}`);
  const rows = await fetchCsv(GAMES_URL);
  const inRange = rows.filter((r) => {
    const season = parseInt(r.season, 10);
    return season >= startSeason && season <= endSeason;
  });
  console.log(`[backfill] ${inRange.length} games in range ${startSeason}-${endSeason}`);

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < inRange.length; i += BATCH_SIZE) {
    const batch = inRange.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];

    for (const g of batch) {
      const homeTeamId = teamIdByAbbr[normalizeAbbr(g.home_team)];
      const awayTeamId = teamIdByAbbr[normalizeAbbr(g.away_team)];
      // Home team's stadium is our source of truth for stadium_id (teams
      // table already has one) rather than trying to match games.csv's
      // free-text stadium name.
      const stadiumId = stadiumIdByAbbr[normalizeAbbr(g.home_team)];
      if (!homeTeamId || !awayTeamId || !stadiumId) {
        skipped++;
        continue;
      }

      // nflverse uses more granular playoff-round labels than a single
      // "POST" (WC/DIV/CON/SB) — treat REG/PRE as themselves and
      // everything else as postseason rather than only matching "POST"
      // literally, which would otherwise misclassify every playoff game.
      const gameType = g.game_type === 'REG' ? 'regular' : g.game_type === 'PRE' ? 'preseason' : 'postseason';
      const gameSlot = classifyGameSlot(g.weekday, g.gametime, g.gameday);
      const weatherCondition = classifyWeatherCondition(g.roof);
      const gameDatetime = g.gameday && g.gametime ? `${g.gameday}T${g.gametime}:00` : g.gameday ? `${g.gameday}T00:00:00` : null;
      if (!gameDatetime) {
        skipped++;
        continue;
      }

      const p = values.length * 15;
      values.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10},$${p + 11},$${p + 12},$${p + 13},$${p + 14},$${p + 15})`);
      params.push(
        g.game_id,
        parseInt(g.season, 10),
        parseInt(g.week, 10),
        gameType,
        gameDatetime,
        homeTeamId,
        awayTeamId,
        stadiumId,
        gameSlot,
        weatherCondition,
        n(g.temp),
        n(g.wind),
        g.home_score ? parseInt(g.home_score, 10) : null,
        g.away_score ? parseInt(g.away_score, 10) : null,
        g.home_score && g.away_score ? 'final' : 'scheduled'
      );
    }

    if (values.length) {
      await client.query(
        `INSERT INTO games (game_id, season, week, game_type, game_datetime, home_team_id, away_team_id,
                             stadium_id, game_slot, weather_condition, weather_temp_f, weather_wind_mph,
                             home_score, away_score, status)
         VALUES ${values.join(',')}
         ON CONFLICT (game_id) DO NOTHING`,
        params
      );
      inserted += values.length;
    }
    if (i % 500 === 0) console.log(`[backfill] ...games ${Math.min(i + BATCH_SIZE, inRange.length)}/${inRange.length}`);
  }

  console.log(`[backfill] games: inserted ${inserted}, skipped ${skipped} (missing team/stadium/date mapping)`);
}

// ---------------------------------------------------------------------
// Step 2: player stats (one season at a time — file is per-season)
// ---------------------------------------------------------------------

const hasAny = (row, cols) => cols.some((c) => Number(row[c]) > 0);

const OFFENSE_COLS = ['completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'sacks_suffered', 'carries', 'rushing_yards', 'rushing_tds', 'fumbles_lost_total', 'targets', 'receptions',
  'receiving_yards', 'receiving_tds'];
const DEFENSE_COLS = ['def_tackles_solo', 'def_tackles_with_assist', 'def_sacks', 'def_tackles_for_loss',
  'def_qb_hits', 'def_interceptions', 'def_pass_defended', 'def_fumbles_forced', 'def_fumbles', 'def_tds'];
const ST_COLS = ['fg_att', 'fg_made', 'pat_att', 'pat_made', 'kickoff_return_yards', 'punt_return_yards', 'special_teams_tds'];

async function loadPlayerStatsForSeason(client, season, playerIdByGsis, teamIdByAbbr) {
  const url = playerStatsUrl(season);
  console.log(`[backfill] fetching player stats: ${url}`);

  let rows;
  try {
    rows = await fetchCsv(url);
  } catch (err) {
    console.warn(`[backfill] no player stats available for ${season} yet (${err.message}) — skipping`);
    return { offense: 0, defense: 0, specialTeams: 0, skippedNoPlayer: 0 };
  }
  console.log(`[backfill] ${rows.length} player-week rows for ${season}`);

  // One-time sanity check against our assumed column names — if nflverse
  // has changed these since this script was written, fail loudly here
  // with the real header instead of silently inserting nulls everywhere.
  if (rows.length) {
    const actualCols = Object.keys(rows[0]);
    const expected = ['game_id', 'player_id', 'team', ...OFFENSE_COLS];
    const missing = expected.filter((c) => !actualCols.includes(c));
    if (missing.length) {
      console.warn(`[backfill] WARNING: expected columns missing from ${season} file: ${missing.join(', ')}`);
      console.warn(`[backfill] actual columns: ${actualCols.join(', ')}`);
    }
  }

  let offense = 0, defense = 0, specialTeams = 0, skippedNoPlayer = 0;
  const offenseBatch = [], defenseBatch = [], stBatch = [];

  const flushOffense = () => insertOffenseBatch(client, offenseBatch);
  const flushDefense = () => insertDefenseBatch(client, defenseBatch);
  const flushSt = () => insertStBatch(client, stBatch);

  for (const row of rows) {
    const playerId = playerIdByGsis[row.player_id];
    const teamId = teamIdByAbbr[normalizeAbbr(row.team)];
    if (!playerId || !teamId || !row.game_id) {
      skippedNoPlayer++;
      continue;
    }

    if (hasAny(row, OFFENSE_COLS)) {
      offenseBatch.push({ row, playerId, teamId });
      offense++;
    }
    if (hasAny(row, DEFENSE_COLS)) {
      defenseBatch.push({ row, playerId, teamId });
      defense++;
    }
    if (hasAny(row, ST_COLS)) {
      stBatch.push({ row, playerId, teamId });
      specialTeams++;
    }

    if (offenseBatch.length >= BATCH_SIZE) await flushOffense();
    if (defenseBatch.length >= BATCH_SIZE) await flushDefense();
    if (stBatch.length >= BATCH_SIZE) await flushSt();
  }
  if (offenseBatch.length) await flushOffense();
  if (defenseBatch.length) await flushDefense();
  if (stBatch.length) await flushSt();

  console.log(`[backfill] ${season}: offense rows ${offense}, defense rows ${defense}, special-teams rows ${specialTeams}, skipped (no player/team match) ${skippedNoPlayer}`);
  return { offense, defense, specialTeams, skippedNoPlayer };
}

async function insertOffenseBatch(client, batch) {
  if (!batch.length) return;
  await client.query(
    `INSERT INTO player_offense_game_stats (
       game_id, player_id, team_id, pass_attempts, pass_completions, passing_yards, passing_tds,
       interceptions_thrown, sacks_taken, rush_attempts, rushing_yards, rushing_tds, fumbles, targets,
       receptions, receiving_yards, receiving_tds
     ) VALUES ${batch.map((_, idx) => {
       const p = idx * 17;
       return `($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13},$${p+14},$${p+15},$${p+16},$${p+17})`;
     }).join(',')}
     ON CONFLICT (game_id, player_id) DO NOTHING`,
    batch.flatMap(({ row, playerId, teamId }) => [
      row.game_id, playerId, teamId,
      n(row.attempts), n(row.completions), n(row.passing_yards), n(row.passing_tds),
      n(row.passing_interceptions), n(row.sacks_suffered), n(row.carries), n(row.rushing_yards),
      n(row.rushing_tds), n(row.fumbles_lost_total), n(row.targets), n(row.receptions),
      n(row.receiving_yards), n(row.receiving_tds),
    ])
  );
  batch.length = 0;
}

async function insertDefenseBatch(client, batch) {
  if (!batch.length) return;
  await client.query(
    `INSERT INTO player_defense_game_stats (
       game_id, player_id, team_id, tackles_solo, tackles_assist, sacks, tackles_for_loss, qb_hits,
       interceptions, passes_defended, forced_fumbles, fumble_recoveries, defensive_tds
     ) VALUES ${batch.map((_, idx) => {
       const p = idx * 13;
       return `($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13})`;
     }).join(',')}
     ON CONFLICT (game_id, player_id) DO NOTHING`,
    batch.flatMap(({ row, playerId, teamId }) => [
      row.game_id, playerId, teamId,
      n(row.def_tackles_solo), n(row.def_tackles_with_assist), n(row.def_sacks), n(row.def_tackles_for_loss),
      n(row.def_qb_hits), n(row.def_interceptions), n(row.def_pass_defended), n(row.def_fumbles_forced),
      n(row.def_fumbles), n(row.def_tds),
    ])
  );
  batch.length = 0;
}

async function insertStBatch(client, batch) {
  if (!batch.length) return;
  await client.query(
    `INSERT INTO player_special_teams_game_stats (
       game_id, player_id, team_id, fg_attempts, fg_made, longest_fg, xp_attempts, xp_made,
       punts, punt_yards, punt_avg, kick_return_yards, punt_return_yards, return_tds
     ) VALUES ${batch.map((_, idx) => {
       const p = idx * 14;
       return `($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11},$${p+12},$${p+13},$${p+14})`;
     }).join(',')}
     ON CONFLICT (game_id, player_id) DO NOTHING`,
    batch.flatMap(({ row, playerId, teamId }) => [
      row.game_id, playerId, teamId,
      n(row.fg_att), n(row.fg_made), n(row.fg_long), n(row.pat_att), n(row.pat_made),
      null, null, null, // punts/punt_yards/punt_avg — see file header, not available from this source
      n(row.kickoff_return_yards), n(row.punt_return_yards), n(row.special_teams_tds),
    ])
  );
  batch.length = 0;
}

function n(v) {
  if (v === undefined || v === null || v === '') return null;
  const num = Number(v);
  return Number.isNaN(num) ? null : num;
}

// ---------------------------------------------------------------------
// Step 0: backfill players/crosswalk for historical seasons
// ---------------------------------------------------------------------
// scripts/seed.js only seeded players currently on a 2026 roster — anyone
// who retired, was cut, or left the league before 2026 has no players row
// and therefore no crosswalk entry, so their historical stats would
// otherwise be silently skipped for "no player match" rather than loaded.
// This fetches each season's own roster file and adds anyone missing
// before the stats load runs, so career history isn't gapped for players
// no longer active today. Mirrors scripts/seed.js's seedRoster() logic.

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
  return 'offense'; // same fallback as seed.js; logged there, not re-logged per-row here to avoid noise
}

async function backfillRostersForSeasons(client, startSeason, endSeason, teamIdByAbbr, playerIdByGsis) {
  let added = 0;
  for (let season = startSeason; season <= endSeason; season++) {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;
    let rows;
    try {
      rows = await fetchCsv(url);
    } catch (err) {
      console.warn(`[backfill] no roster file for ${season} (${err.message}) — skipping roster backfill for that season`);
      continue;
    }

    const missing = rows.filter((r) => r.gsis_id && !playerIdByGsis[r.gsis_id]);
    console.log(`[backfill] roster ${season}: ${rows.length} rows, ${missing.length} players not yet in our crosswalk`);

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const playerValues = [];
      const playerParams = [];
      batch.forEach((row, idx) => {
        const p = idx * 11;
        playerValues.push(`($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9},$${p+10},$${p+11})`);
        const teamId = teamIdByAbbr[normalizeAbbr(row.team)] || null;
        playerParams.push(
          row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
          row.first_name || null,
          row.last_name || null,
          row.position || null,
          positionGroupFor(row.position),
          teamId,
          row.birth_date || null,
          row.draft_year ? parseInt(row.draft_year, 10) : null,
          row.draft_round ? parseInt(row.draft_round, 10) : null,
          row.draft_pick ? parseInt(row.draft_pick, 10) : null,
          row.status || 'inactive'
        );
      });

      const { rows: inserted } = await client.query(
        `INSERT INTO players (full_name, first_name, last_name, position, position_group,
                               current_team_id, birth_date, draft_year, draft_round, draft_pick, status)
         VALUES ${playerValues.join(',')}
         RETURNING player_id`,
        playerParams
      );

      const crosswalkValues = [];
      const crosswalkParams = [];
      batch.forEach((row, idx) => {
        const p = idx * 2;
        crosswalkValues.push(`($${p+1}, 'nflverse', $${p+2}, 'matched')`);
        crosswalkParams.push(inserted[idx].player_id, row.gsis_id);
        playerIdByGsis[row.gsis_id] = inserted[idx].player_id; // update in-memory map for this run
      });
      await client.query(
        `INSERT INTO player_id_crosswalk (player_id, source, source_player_id, match_confidence)
         VALUES ${crosswalkValues.join(',')}
         ON CONFLICT (source, source_player_id) DO NOTHING`,
        crosswalkParams
      );
      added += batch.length;
    }
  }
  console.log(`[backfill] roster backfill: added ${added} players not on the current 2026 roster`);
}

// ---------------------------------------------------------------------
// Step 3: team_game_stats — points from games.csv (already loaded),
// passing/rushing/turnovers derived from the player rows just inserted
// (guarantees internal consistency). penalties/penalty_yards/
// time_of_possession_seconds are not available from this data source.
// ---------------------------------------------------------------------

async function loadTeamGameStats(client, startSeason, endSeason) {
  console.log('[backfill] deriving team_game_stats from games + player_offense_game_stats...');
  const { rowCount } = await client.query(
    `INSERT INTO team_game_stats (game_id, team_id, is_home, points, total_yards, passing_yards, rushing_yards, turnovers)
     SELECT
       g.game_id,
       t.team_id,
       (t.team_id = g.home_team_id) AS is_home,
       CASE WHEN t.team_id = g.home_team_id THEN g.home_score ELSE g.away_score END AS points,
       COALESCE(off.passing_yards, 0) + COALESCE(off.rushing_yards, 0) AS total_yards,
       off.passing_yards,
       off.rushing_yards,
       off.turnovers
     FROM games g
     JOIN teams t ON t.team_id = g.home_team_id OR t.team_id = g.away_team_id
     LEFT JOIN (
       SELECT game_id, team_id,
              SUM(passing_yards) AS passing_yards,
              SUM(rushing_yards) AS rushing_yards,
              SUM(interceptions_thrown) + SUM(fumbles) AS turnovers
       FROM player_offense_game_stats
       GROUP BY game_id, team_id
     ) off ON off.game_id = g.game_id AND off.team_id = t.team_id
     WHERE g.season BETWEEN $1 AND $2
     ON CONFLICT (game_id, team_id) DO NOTHING`,
    [startSeason, endSeason]
  );
  console.log(`[backfill] team_game_stats: inserted ${rowCount} rows`);
}

// ---------------------------------------------------------------------

async function main() {
  const [, , startArg, endArg] = process.argv;
  const startSeason = parseInt(startArg, 10);
  const endSeason = parseInt(endArg, 10);
  if (!startSeason || !endSeason) {
    console.error('Usage: node scripts/backfill-historical.js <startSeason> <endSeason>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const { rows: teams } = await client.query('SELECT team_id, abbreviation, home_stadium_id FROM teams');
    const teamIdByAbbr = {};
    const stadiumIdByAbbr = {};
    for (const t of teams) {
      teamIdByAbbr[t.abbreviation] = t.team_id;
      stadiumIdByAbbr[t.abbreviation] = t.home_stadium_id;
    }

    const { rows: crosswalk } = await client.query(
      "SELECT player_id, source_player_id FROM player_id_crosswalk WHERE source = 'nflverse'"
    );
    const playerIdByGsis = {};
    for (const c of crosswalk) playerIdByGsis[c.source_player_id] = c.player_id;
    console.log(`[backfill] loaded ${Object.keys(playerIdByGsis).length} player crosswalk entries`);

    await client.query('BEGIN');
    await backfillRostersForSeasons(client, startSeason, endSeason, teamIdByAbbr, playerIdByGsis);
    await client.query('COMMIT');
    console.log('[backfill] roster backfill committed');

    await client.query('BEGIN');
    await loadGames(client, startSeason, endSeason, teamIdByAbbr, stadiumIdByAbbr);
    await client.query('COMMIT');
    console.log('[backfill] games committed');

    // Player stats committed per-season (separate transactions) so a
    // failure partway through a large multi-season backfill doesn't
    // throw away seasons that already succeeded.
    for (let season = startSeason; season <= endSeason; season++) {
      await client.query('BEGIN');
      try {
        await loadPlayerStatsForSeason(client, season, playerIdByGsis, teamIdByAbbr);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[backfill] season ${season} failed, rolled back:`, err.message);
      }
    }

    await client.query('BEGIN');
    await loadTeamGameStats(client, startSeason, endSeason);
    await client.query('COMMIT');

    console.log('[backfill] done.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[backfill] failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
