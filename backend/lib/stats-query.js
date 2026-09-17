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

async function runStatsQuery({ entity_type, entity_id, scope, season, splits }) {
  const result =
    entity_type === 'player'
      ? await queryPlayer({ entity_id, scope, season, splits })
      : await queryTeam({ entity_id, scope, season, splits });

  if (result.error) return result;

  const freshness = await getFreshness('sync_historical_stats');
  return { data: result.data, sampleSize: result.sampleSize, freshness };
}

module.exports = {
  runStatsQuery,
  VALID_SCOPES,
  VALID_GAME_SLOTS,
  VALID_WEATHER,
  PLAYER_STAT_TABLES,
  PLAYER_STAT_COLUMNS,
  TEAM_STAT_COLUMNS,
  CAREER_AGGREGATE_OVERRIDE,
  careerAggFn,
};
