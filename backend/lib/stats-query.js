/**
 * Chalk That NFL — shared stats query engine
 * =========================================================================
 * Extracted from routes/query.js (2026-09-17, NL search bar backlog item)
 * so it can be called in-process by both POST /query (the HTTP route) and
 * the chat orchestrator's new get_player_stats tool, plus its new
 * deterministic StatMuse-style shortcut — same "never a second HTTP hop
 * back into this same API" principle orchestrator.js's header already
 * states for its other tools (get_rankings/get_edge/etc. all call a lib
 * function directly rather than hitting their own route over fetch). No
 * behavior change from the original routes/query.js: this is a straight
 * relocation of queryPlayer/queryTeam and their helpers, not a rewrite.
 * See routes/query.js for the HTTP-level request validation and response
 * shaping that now wraps this.
 *
 * runStatsQuery({ entity_type, entity_id, scope, season, splits }) does
 * NOT re-validate scope/season/splits shape the way the HTTP route does
 * (bad entity_type, missing season, invalid enum values) — callers are
 * expected to validate first against the VALID_* constants exported
 * here (the route does this already; orchestrator.js's new tool and
 * deterministic shortcut both validate against these same constants
 * before calling in). It still returns the same { error, status } shape
 * for data-level problems (player/team not found, non-numeric team id)
 * that input validation alone can't catch.
 * =========================================================================
 */

const { query } = require('../db');

const PLAYER_STAT_TABLES = {
  offense: 'player_offense_game_stats',
  defense: 'player_defense_game_stats',
  special_teams: 'player_special_teams_game_stats',
};

const PLAYER_STAT_COLUMNS = {
  offense: [
    'pass_attempts', 'pass_completions', 'passing_yards', 'passing_tds',
    'interceptions_thrown', 'sacks_taken', 'rush_attempts', 'rushing_yards',
    'rushing_tds', 'fumbles', 'targets', 'receptions', 'receiving_yards', 'receiving_tds',
  ],
  defense: [
    'tackles_solo', 'tackles_assist', 'sacks', 'tackles_for_loss', 'qb_hits',
    'interceptions', 'passes_defended', 'forced_fumbles', 'fumble_recoveries', 'defensive_tds',
  ],
  special_teams: [
    'fg_attempts', 'fg_made', 'longest_fg', 'xp_attempts', 'xp_made',
    'punts', 'punt_yards', 'punt_avg', 'kick_return_yards', 'punt_return_yards', 'return_tds',
  ],
};

const TEAM_STAT_COLUMNS = [
  'points', 'total_yards', 'passing_yards', 'rushing_yards',
  'turnovers', 'penalties', 'penalty_yards', 'time_of_possession_seconds',
];

// career scope aggregates every column with SUM by default (a real
// cumulative total) except columns where summing across games would be
// dishonest:
//   - longest_fg is a per-game max, not a counting stat — career value
//     is the max of those maxes, not their sum.
//   - punt_avg is already a per-game rate (that game's punt_yards /
//     that game's punts) — summing it across games produces a number
//     with no real meaning. AVG here is a known simplification (an
//     unweighted average of per-game averages, not punts-weighted); a
//     fully correct career punt average would need SUM(punt_yards) /
//     SUM(punts) computed separately, left as a future refinement since
//     it only affects punters.
const CAREER_AGGREGATE_OVERRIDE = {
  longest_fg: 'MAX',
  punt_avg: 'AVG',
};

// season_total (2026-09-17, "add season totals to Players too" request)
// reuses this exact same override table via careerAggFn() below -- it's
// SUM-with-the-same-exceptions, just scoped to one season instead of a
// player's whole career. Genuinely distinct from both existing scopes:
// "season" already existed but is a per-game AVERAGE (the tab is labeled
// "Season Avg" for exactly this reason) and "career" is a SUM but across
// every season on record, not one. See routes/query.js's header comment
// for the full season/season_total/career distinction written out.

function careerAggFn(column) {
  return CAREER_AGGREGATE_OVERRIDE[column] || 'SUM';
}

const VALID_SCOPES = ['season', 'season_total', 'last5', 'career', 'game_log'];

// ---------------------------------------------------------------------
// Leaderboard (League Leaderboard, 2026-09-28 request) — a genuinely
// different shape from queryPlayer/queryTeam above: those all answer
// "how did THIS player/team do," scoped by an id the caller already has.
// A leaderboard answers "who leads the league," so it takes a stat
// instead of an id and returns many players at once. It's still routed
// through this same runStatsQuery()/POST /query engine (not a one-off
// route) per architecture.md's "one query engine" principle, so the web
// UI, iOS, and any future agent tool all reach it the same way — see
// routes/query.js's own header for how the HTTP layer special-cases
// scope: "leaderboard" (no entity_type/entity_id needed) before this.
//
// Deliberately plain: real season totals, sorted and capped, no scoring
// model — kept distinct from the Rankings page (lib/ranking.js), which
// is a deterministic *model* (matchup_scores' blended trend score).
// -----------------------------------------------------------------------
// Every leaderboard stat, in the 3 categories requested (passing /
// rushing / receiving — defense/kicking left for a future pass since
// their category tables/columns weren't in this v1's scope):
//   kind: 'sum'   -> season total of one counting column, no qualifier.
//   kind: 'ratio' -> numerator/denominator computed here (not summable
//                    as a column), qualified on the denominator.
//   kind: 'rating'-> NFL passer rating, computed from 5 summed columns,
//                    qualified on pass_attempts.
const LEADERBOARD_STATS = {
  pass_yards: { label: 'Passing Yards', unit: 'yds', kind: 'sum', column: 'passing_yards' },
  pass_tds: { label: 'Passing TDs', unit: 'TD', kind: 'sum', column: 'passing_tds' },
  pass_ints: { label: 'Interceptions Thrown', unit: 'INT', kind: 'sum', column: 'interceptions_thrown' },
  pass_rating: { label: 'Passer Rating', unit: 'rtg', kind: 'rating', qualifierColumn: 'pass_attempts' },
  rush_yards: { label: 'Rushing Yards', unit: 'yds', kind: 'sum', column: 'rushing_yards' },
  rush_tds: { label: 'Rushing TDs', unit: 'TD', kind: 'sum', column: 'rushing_tds' },
  rush_ypc: { label: 'Yards Per Carry', unit: 'ypc', kind: 'ratio', numerator: 'rushing_yards', denominator: 'rush_attempts', qualifierColumn: 'rush_attempts' },
  receptions: { label: 'Receptions', unit: 'rec', kind: 'sum', column: 'receptions' },
  rec_yards: { label: 'Receiving Yards', unit: 'yds', kind: 'sum', column: 'receiving_yards' },
  rec_tds: { label: 'Receiving TDs', unit: 'TD', kind: 'sum', column: 'receiving_tds' },
};

const VALID_GAME_TYPES = ['regular', 'postseason'];

// The NFL's own official minimum qualifiers for rate-stat leaderboards
// (verified against Pro-Football-Reference's published minimums page,
// 2026-09-28: "14 pass attempts per team game", "6.25 rushing attempts
// per team game"), NOT a Chalk-That-invented rule — unlike the NBA app's
// Leaders page, which uses its own 70%-of-games rule because the NBA
// doesn't publish an equivalent per-game minimum. Applied against
// whichever team has played the most games so far this season/game_type
// (same "fair to a team that hasn't had its bye yet" reasoning the NBA
// version uses for early-season leaderboards), not a fixed 17-game
// season assumption. Counting stats (yards, TDs, INTs) get no qualifier
// at all, matching how NFL.com's own leaderboards present them.
const LEADERBOARD_QUALIFIER_PER_TEAM_GAME = {
  pass_attempts: 14,
  rush_attempts: 6.25,
};

function clampRatingComponent(n) {
  return Math.max(0, Math.min(2.375, n));
}

// Standard NFL passer rating formula, unchanged since 1973. Verified
// 2026-09-28 against a real player-season line from Pro-Football-
// Reference (see commit message for the specific check) rather than
// trusted from memory alone.
function passerRating({ att, comp, yds, td, int }) {
  if (!att) return null;
  const a = clampRatingComponent(((comp / att) - 0.3) * 5);
  const b = clampRatingComponent(((yds / att) - 3) * 0.25);
  const c = clampRatingComponent((td / att) * 20);
  const d = clampRatingComponent(2.375 - (int / att) * 25);
  return Math.round(((a + b + c + d) / 6) * 100 * 10) / 10;
}

async function teamGamesPlayed(season, gameType) {
  const { rows: [row] } = await query(
    `SELECT MAX(n)::int AS team_games FROM (
       SELECT team_id, COUNT(*) AS n FROM (
         SELECT home_team_id AS team_id FROM games WHERE season = $1 AND game_type = $2 AND status = 'final'
         UNION ALL
         SELECT away_team_id AS team_id FROM games WHERE season = $1 AND game_type = $2 AND status = 'final'
       ) team_games
       GROUP BY team_id
     ) counted`,
    [season, gameType]
  );
  return row?.team_games || 0;
}

async function queryLeaderboard({ stat, season, gameType = 'regular', perGame = false, limit = 10 }) {
  const def = LEADERBOARD_STATS[stat];
  if (!def) return { error: `stat must be one of: ${Object.keys(LEADERBOARD_STATS).join(', ')}`, status: 400 };

  const teamGames = await teamGamesPlayed(season, gameType);

  // Pull every summable offense column per player in one pass rather
  // than a stat-specific query — cheap at this row count (skill-position
  // players in a season), and means adding a new 'sum'/'ratio' stat
  // later never needs a new SQL shape, only a new LEADERBOARD_STATS
  // entry. Latest team uses the same "most recent game" tiebreak the
  // NBA Leaders page uses for a player who was traded mid-season.
  const { rows } = await query(
    `WITH agg AS (
       SELECT s.player_id, COUNT(*)::int AS gp,
              SUM(s.pass_attempts)::int AS pass_attempts,
              SUM(s.pass_completions)::int AS pass_completions,
              SUM(s.passing_yards)::int AS passing_yards,
              SUM(s.passing_tds)::int AS passing_tds,
              SUM(s.interceptions_thrown)::int AS interceptions_thrown,
              SUM(s.rush_attempts)::int AS rush_attempts,
              SUM(s.rushing_yards)::int AS rushing_yards,
              SUM(s.rushing_tds)::int AS rushing_tds,
              SUM(s.receptions)::int AS receptions,
              SUM(s.receiving_yards)::int AS receiving_yards,
              SUM(s.receiving_tds)::int AS receiving_tds
         FROM player_offense_game_stats s
         JOIN games g ON g.game_id = s.game_id
        WHERE g.season = $1 AND g.game_type = $2 AND g.status = 'final'
        GROUP BY s.player_id
     ),
     latest_team AS (
       SELECT DISTINCT ON (s.player_id) s.player_id, t.abbreviation
         FROM player_offense_game_stats s
         JOIN games g ON g.game_id = s.game_id
         JOIN teams t ON t.team_id = s.team_id
        WHERE g.season = $1 AND g.game_type = $2 AND g.status = 'final'
        ORDER BY s.player_id, g.game_datetime DESC
     )
     SELECT p.player_id, p.full_name, p.position, lt.abbreviation AS team, agg.*
       FROM agg
       JOIN players p ON p.player_id = agg.player_id
       JOIN latest_team lt ON lt.player_id = agg.player_id`,
    [season, gameType]
  );

  const qualifierRate = def.qualifierColumn ? LEADERBOARD_QUALIFIER_PER_TEAM_GAME[def.qualifierColumn] : null;
  const minQualifier = qualifierRate ? Math.max(1, Math.ceil(teamGames * qualifierRate)) : null;

  const withValue = rows.map((r) => {
    let value;
    if (def.kind === 'sum') {
      value = perGame && r.gp ? Math.round((r[def.column] / r.gp) * 10) / 10 : r[def.column];
    } else if (def.kind === 'ratio') {
      value = r[def.denominator] ? Math.round((r[def.numerator] / r[def.denominator]) * 10) / 10 : null;
    } else {
      value = passerRating({ att: r.pass_attempts, comp: r.pass_completions, yds: r.passing_yards, td: r.passing_tds, int: r.interceptions_thrown });
    }
    return { ...r, value, qualifies: minQualifier == null || (r[def.qualifierColumn] || 0) >= minQualifier };
  });

  const qualified = withValue.filter((r) => r.value != null && r.qualifies);
  qualified.sort((x, y) => (y.value - x.value) || (y.gp - x.gp) || x.full_name.localeCompare(y.full_name));

  const data = qualified.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    player_id: r.player_id,
    full_name: r.full_name,
    position: r.position,
    team: r.team,
    gp: r.gp,
    value: r.value,
  }));

  const notes = minQualifier
    ? [`Qualifier: at least ${minQualifier} ${def.qualifierColumn.replace('_', ' ')} (${qualifierRate} per team game × ${teamGames} team games played) — the NFL's official minimum, not Chalk That's own rule.`]
    : [`No qualifier — ${def.label.toLowerCase()} is a counting stat, shown as a season total with no minimum, matching how the NFL's own leaderboards present it.`];

  return {
    data,
    sample: qualified.length,
    notes,
    qualifier: minQualifier ? { column: def.qualifierColumn, min: minQualifier, per_team_game_rate: qualifierRate, team_games: teamGames, qualified_players: qualified.length } : null,
  };
}


const VALID_GAME_SLOTS = [
  'sunday_early', 'sunday_late', 'sunday_night', 'monday_night',
  'thursday_night', 'thanksgiving', 'saturday', 'other',
];
const VALID_WEATHER = ['sunny', 'overcast', 'rain', 'snow', 'dome'];

function buildPlayerWhere({ entity_id, scope, season, splits }) {
  const conditions = ['stats.player_id = $1'];
  const params = [entity_id];

  if (scope !== 'career') {
    params.push(season);
    conditions.push(`g.season = $${params.length}`);
  }
  if (splits?.game_slot) {
    params.push(splits.game_slot);
    conditions.push(`g.game_slot = $${params.length}`);
  }
  if (splits?.weather_condition) {
    params.push(splits.weather_condition);
    conditions.push(`g.weather_condition = $${params.length}`);
  }
  if (splits?.home_away === 'home') conditions.push('stats.team_id = g.home_team_id');
  if (splits?.home_away === 'away') conditions.push('stats.team_id = g.away_team_id');

  return { whereSql: `WHERE ${conditions.join(' AND ')}`, params };
}

function buildTeamWhere({ entity_id, scope, season, splits }) {
  const conditions = ['stats.team_id = $1'];
  const params = [entity_id];

  if (scope !== 'career') {
    params.push(season);
    conditions.push(`g.season = $${params.length}`);
  }
  if (splits?.game_slot) {
    params.push(splits.game_slot);
    conditions.push(`g.game_slot = $${params.length}`);
  }
  if (splits?.weather_condition) {
    params.push(splits.weather_condition);
    conditions.push(`g.weather_condition = $${params.length}`);
  }
  if (splits?.home_away === 'home') conditions.push('stats.is_home = true');
  if (splits?.home_away === 'away') conditions.push('stats.is_home = false');

  return { whereSql: `WHERE ${conditions.join(' AND ')}`, params };
}

async function queryPlayer({ entity_id, scope, season, splits }) {
  const { rows: playerRows } = await query('SELECT position_group FROM players WHERE player_id = $1', [entity_id]);
  if (!playerRows[0]) return { error: 'player not found', status: 404 };

  const positionGroup = playerRows[0].position_group;
  const table = PLAYER_STAT_TABLES[positionGroup];
  const columns = PLAYER_STAT_COLUMNS[positionGroup];
  const { whereSql, params } = buildPlayerWhere({ entity_id, scope, season, splits });

  if (scope === 'game_log') {
    const { rows } = await query(
      `SELECT g.game_id, g.season, g.week, g.game_datetime, g.game_slot, g.weather_condition,
              (stats.team_id = g.home_team_id) AS is_home,
              ${columns.map((c) => `stats.${c}`).join(', ')}
       FROM ${table} stats
       JOIN games g ON g.game_id = stats.game_id
       ${whereSql}
       ORDER BY g.game_datetime DESC`,
      params
    );
    return { data: rows, sampleSize: rows.length };
  }

  if (scope === 'last5') {
    const { rows } = await query(
      `WITH recent AS (
         SELECT stats.*
         FROM ${table} stats
         JOIN games g ON g.game_id = stats.game_id
         ${whereSql}
         ORDER BY g.game_datetime DESC
         LIMIT 5
       )
       SELECT COUNT(*) AS sample_size, ${columns.map((c) => `AVG(${c})::float8 AS ${c}`).join(', ')}
       FROM recent`,
      params
    );
    return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
  }

  if (scope === 'career') {
    const { rows } = await query(
      `SELECT COUNT(*) AS sample_size, ${columns.map((c) => `${careerAggFn(c)}(stats.${c})::float8 AS ${c}`).join(', ')}
       FROM ${table} stats
       JOIN games g ON g.game_id = stats.game_id
       ${whereSql}`,
      params
    );
    return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
  }

  if (scope === 'season_total') {
    const { rows } = await query(
      `SELECT COUNT(*) AS sample_size, ${columns.map((c) => `${careerAggFn(c)}(stats.${c})::float8 AS ${c}`).join(', ')}
       FROM ${table} stats
       JOIN games g ON g.game_id = stats.game_id
       ${whereSql}`,
      params
    );
    return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
  }

  // season
  const { rows } = await query(
    `SELECT COUNT(*) AS sample_size, ${columns.map((c) => `AVG(stats.${c})::float8 AS ${c}`).join(', ')}
     FROM ${table} stats
     JOIN games g ON g.game_id = stats.game_id
     ${whereSql}`,
    params
  );
  return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
}

async function queryTeam({ entity_id, scope, season, splits }) {
  const teamId = parseInt(entity_id, 10);
  if (Number.isNaN(teamId)) {
    return { error: 'entity_id must be a numeric team id for entity_type "team"', status: 400 };
  }

  const { rows: teamRows } = await query('SELECT team_id FROM teams WHERE team_id = $1', [teamId]);
  if (!teamRows[0]) return { error: 'team not found', status: 404 };

  const columns = TEAM_STAT_COLUMNS;
  const { whereSql, params } = buildTeamWhere({ entity_id: teamId, scope, season, splits });

  if (scope === 'game_log') {
    const { rows } = await query(
      `SELECT g.game_id, g.season, g.week, g.game_datetime, g.game_slot, g.weather_condition,
              stats.is_home, ${columns.map((c) => `stats.${c}`).join(', ')}
       FROM team_game_stats stats
       JOIN games g ON g.game_id = stats.game_id
       ${whereSql}
       ORDER BY g.game_datetime DESC`,
      params
    );
    return { data: rows, sampleSize: rows.length };
  }

  if (scope === 'last5') {
    const { rows } = await query(
      `WITH recent AS (
         SELECT stats.*
         FROM team_game_stats stats
         JOIN games g ON g.game_id = stats.game_id
         ${whereSql}
         ORDER BY g.game_datetime DESC
         LIMIT 5
       )
       SELECT COUNT(*) AS sample_size, ${columns.map((c) => `AVG(${c})::float8 AS ${c}`).join(', ')}
       FROM recent`,
      params
    );
    return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
  }

  if (scope === 'career') {
    const { rows } = await query(
      `SELECT COUNT(*) AS sample_size, ${columns.map((c) => `${careerAggFn(c)}(stats.${c})::float8 AS ${c}`).join(', ')}
       FROM team_game_stats stats
       JOIN games g ON g.game_id = stats.game_id
       ${whereSql}`,
      params
    );
    return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
  }

  if (scope === 'season_total') {
    const { rows } = await query(
      `SELECT COUNT(*) AS sample_size, ${columns.map((c) => `${careerAggFn(c)}(stats.${c})::float8 AS ${c}`).join(', ')}
       FROM team_game_stats stats
       JOIN games g ON g.game_id = stats.game_id
       ${whereSql}`,
      params
    );
    return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
  }

  // season
  const { rows } = await query(
    `SELECT COUNT(*) AS sample_size, ${columns.map((c) => `AVG(stats.${c})::float8 AS ${c}`).join(', ')}
     FROM team_game_stats stats
     JOIN games g ON g.game_id = stats.game_id
     ${whereSql}`,
    params
  );
  return { data: stripSampleSize(rows[0]), sampleSize: parseInt(rows[0].sample_size, 10) };
}

function stripSampleSize(row) {
  const { sample_size, ...rest } = row;
  return rest;
}

async function getFreshness(jobType) {
  const { rows } = await query(
    `SELECT finished_at FROM ingestion_runs
     WHERE job_type = $1 AND status = 'success'
     ORDER BY finished_at DESC LIMIT 1`,
    [jobType]
  );
  return { synced_at: rows[0]?.finished_at || null };
}

async function runStatsQuery({ entity_type, entity_id, scope, season, splits, stat, gameType, perGame, limit }) {
  const result =
    scope === 'leaderboard'
      ? await queryLeaderboard({ stat, season, gameType, perGame, limit })
      : entity_type === 'player'
      ? await queryPlayer({ entity_id, scope, season, splits })
      : await queryTeam({ entity_id, scope, season, splits });

  if (result.error) return result;

  const freshness = await getFreshness('sync_historical_stats');
  return {
    data: result.data,
    sampleSize: result.sampleSize ?? result.sample,
    freshness,
    ...(result.qualifier !== undefined ? { qualifier: result.qualifier } : {}),
    ...(result.notes ? { notes: result.notes } : {}),
  };
}

module.exports = {
  runStatsQuery,
  VALID_SCOPES,
  VALID_GAME_SLOTS,
  VALID_WEATHER,
  VALID_GAME_TYPES,
  PLAYER_STAT_TABLES,
  PLAYER_STAT_COLUMNS,
  TEAM_STAT_COLUMNS,
  CAREER_AGGREGATE_OVERRIDE,
  careerAggFn,
  LEADERBOARD_STATS,
  LEADERBOARD_QUALIFIER_PER_TEAM_GAME,
  passerRating,
};
