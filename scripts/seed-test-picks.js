/**
 * Chalk That NFL — log a pick into picks_log (calibration/tracking layer)
 * =========================================================================
 * No agent writes to picks_log yet (task: build the calibration layer
 * before/alongside the first agent — see docs/part2-roadmap.md "3 paths"
 * discussion). This script is the manual stand-in: a way to (a) hand-log
 * real picks right now, before any agent exists, and (b) seed picks
 * against already-final games from the 2021-2025 historical backfill so
 * worker/ingestion-worker.js's grade_picks job can be dry-run against
 * real data instead of only a mocked harness.
 *
 * stat_category must be one of the categories grade_picks knows how to
 * grade (see worker/ingestion-worker.js's STAT_CATEGORY_MAP) — deliberately
 * the same four backend/lib/insights.js's POSITION_STAT_MAP/DEFENSE_STAT
 * already use: passing_yards, rushing_yards, receiving_yards, tackles.
 *
 * Finding real game_id / player_id values: game_id is nflverse's own
 * format (e.g. "2024_05_KC_BUF" — season_week_away_home... actually
 * away/home order matches games.csv, check a row via the games table).
 * player_id is our UUID — look one up via GET /players?name=... against a
 * locally running backend-api, or query players directly.
 *
 * Run with:
 *   node scripts/seed-test-picks.js <agentName> <gameId> <playerId> \
 *     <statCategory> <over|under> <line> [confidence] [reasoning]
 *
 * Example (against a real final game from the historical backfill):
 *   node scripts/seed-test-picks.js manual 2024_05_KC_BUF \
 *     3f9a1e2b-... receiving_yards over 74.5 65 "trending up 3 games straight"
 * =========================================================================
 */

require('dotenv').config();
const { pool } = require('../backend/db');

const VALID_STAT_CATEGORIES = ['passing_yards', 'rushing_yards', 'receiving_yards', 'tackles'];
const VALID_DIRECTIONS = ['over', 'under'];

async function main() {
  const [, , agentName, gameId, playerId, statCategory, direction, lineArg, confidenceArg, ...reasoningParts] = process.argv;

  if (!agentName || !gameId || !playerId || !statCategory || !direction || lineArg === undefined) {
    console.error(
      'Usage: node scripts/seed-test-picks.js <agentName> <gameId> <playerId> <statCategory> <over|under> <line> [confidence] [reasoning]'
    );
    console.error(`  statCategory must be one of: ${VALID_STAT_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
  if (!VALID_STAT_CATEGORIES.includes(statCategory)) {
    console.error(`statCategory must be one of: ${VALID_STAT_CATEGORIES.join(', ')} (got "${statCategory}")`);
    process.exit(1);
  }
  if (!VALID_DIRECTIONS.includes(direction)) {
    console.error(`direction must be "over" or "under" (got "${direction}")`);
    process.exit(1);
  }
  const line = Number(lineArg);
  if (!Number.isFinite(line)) {
    console.error(`line must be a number (got "${lineArg}")`);
    process.exit(1);
  }
  const confidence = confidenceArg !== undefined && confidenceArg !== '' ? Number(confidenceArg) : null;
  if (confidence !== null && !Number.isFinite(confidence)) {
    console.error(`confidence must be a number if provided (got "${confidenceArg}")`);
    process.exit(1);
  }
  const reasoning = reasoningParts.length ? reasoningParts.join(' ') : null;

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }

  // Fail fast with a clear message rather than a raw FK-violation error if
  // the game/player ids don't exist — easy to typo when copy-pasting a
  // UUID or game_id by hand.
  const { rows: gameRows } = await pool.query('SELECT game_id, status FROM games WHERE game_id = $1', [gameId]);
  if (!gameRows[0]) {
    console.error(`No game found with game_id "${gameId}"`);
    process.exit(1);
  }
  const { rows: playerRows } = await pool.query('SELECT player_id, full_name FROM players WHERE player_id = $1', [playerId]);
  if (!playerRows[0]) {
    console.error(`No player found with player_id "${playerId}"`);
    process.exit(1);
  }

  const { rows } = await pool.query(
    `INSERT INTO picks_log (agent_name, game_id, player_id, stat_category, predicted_direction, predicted_line, confidence, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING pick_id`,
    [agentName, gameId, playerId, statCategory, direction, line, confidence, reasoning]
  );

  console.log(
    `[seed-test-picks] logged pick_id ${rows[0].pick_id}: ${playerRows[0].full_name} ${direction} ${line} ${statCategory} ` +
      `in ${gameId} (game status: ${gameRows[0].status}${gameRows[0].status !== 'final' ? ' — grade_picks will skip it until this game is final' : ' — ready to grade'})`
  );
  await pool.end();
}

main().catch((err) => {
  console.error('[seed-test-picks] failed:', err);
  process.exit(1);
});
