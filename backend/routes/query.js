/**
 * Chalk That NFL — the shared query engine
 * =========================================================================
 * POST /query — the ONE endpoint both the web/iOS UI and future AI agents
 * call for stats. No predictive calculations: every response is a plain
 * filtered aggregation (or raw game log) over the *_game_stats tables,
 * computed at request time. See architecture.md §2/§5 for the design.
 *
 * Body:
 *   entity_type: "player" | "team"
 *   entity_id:   player UUID, or numeric team_id
 *   scope:       "season" | "last5" | "career" | "game_log"
 *   season:      required for season/last5/game_log, ignored for career
 *   splits:      optional { home_away, game_slot, weather_condition }
 *
 * Response:
 *   { data: {...averaged stats...} | [...game log rows...],
 *     meta: { sample_size, freshness: { synced_at } } }
 *
 * Note: until the historical-data ingestion pass runs, `games` and the
 * *_game_stats tables are empty — every query here will correctly return
 * a zero-sample_size result rather than an error. That's the intended
 * "graceful empty state," not a bug — see checklist Phase 1 "done looks
 * like" and Phase 3 empty-state scope.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

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

const VALID_SCOPES = ['season', 'last5', 'career', 'game_log'];
const VALID_GAME_SLOTS = [
  'sunday_early', 'sunday_late', 'sunday_night', 'monday_night',
  'thursday_night', 'thanksgiving', 'saturday', 'other',
];
const VALID_WEATHER = ['sunny', 'overcast', 'rain', 'snow', 'dome'];

router.post('/', async (req, res) => {
  const { entity_type, entity_id, scope, season, splits } = req.body || {};

  if (!['player', 'team'].includes(entity_type)) {
    return res.status(400).json({ error: 'entity_type must be "player" or "team"' });
  }
  if (!entity_id) {
    return res.status(400).json({ error: 'entity_id is required' });
  }
  if (!VALID_SCOPES.includes(scope)) {
    return res.status(400).json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` });
  }
  if (scope !== 'career' && !season) {
    return res.status(400).json({ error: 'season is required for season/last5/game_log scope' });
  }
  if (splits?.game_slot && !VALID_GAME_SLOTS.includes(splits.game_slot)) {
    return res.status(400).json({ error: `splits.game_slot must be one of: ${VALID_GAME_SLOTS.join(', ')}` });
  }
  if (splits?.weather_condition && !VALID_WEATHER.includes(splits.weather_condition)) {
    return res.status(400).json({ error: `splits.weather_condition must be one of: ${VALID_WEATHER.join(', ')}` });
  }
  if (splits?.home_away && !['home', 'away'].includes(splits.home_away)) {
    return res.status(400).json({ error: 'splits.home_away must be "home" or "away"' });
  }

  try {
    const result =
      entity_type === 'player'
        ? await queryPlayer({ entity_id, scope, season, splits })
        : await queryTeam({ entity_id, scope, season, splits });

    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    const freshness = await getFreshness('sync_historical_stats');
    res.json({ data: result.data, meta: { sample_size: result.sampleSize, freshness } });
  } catch (err) {
    console.error('[routes/query] failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

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

  // season | career
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

module.exports = router;
