/**
 * Chalk That NFL — current week resolution
 * =========================================================================
 * getCurrentWeek() resolves "this week"/"current week" to a concrete
 * {season, week}, using the nearest upcoming scheduled game (falls back
 * to the most recently played game once a season is over, or before one
 * starts). Extracted 2026-09-14 out of backend/lib/orchestrator.js's
 * get_current_week tool case, which is where this logic lived first and
 * only — the chat agent's internal tool-calling switch was never a
 * reusable place for BoardPage.jsx's front door (GET /games/current-week,
 * backend/routes/games.js) to also get a sensible default season/week
 * without asking the user to type one. Pulled out so both call sites
 * share one query instead of drifting into two copies — same "one source
 * of truth" principle the rest of this app already follows.
 * =========================================================================
 */

const { query } = require('../db');

async function getCurrentWeek() {
  const { rows: upcoming } = await query(
    `SELECT season, week FROM games WHERE status = 'scheduled' ORDER BY game_datetime ASC LIMIT 1`
  );
  if (upcoming[0]) return upcoming[0];
  const { rows: latest } = await query(`SELECT season, week FROM games ORDER BY game_datetime DESC LIMIT 1`);
  return latest[0] || null;
}

module.exports = { getCurrentWeek };
