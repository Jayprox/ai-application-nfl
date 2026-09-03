/**
 * Chalk That NFL — picks route
 * =========================================================================
 * Read-only view onto picks_log (Part 2 Phase 2's calibration/tracking
 * layer — db/migrations/004_picks_log.sql, worker/ingestion-worker.js's
 * grade_picks job). No agent writes picks yet — scripts/seed-test-picks.js
 * is the only writer for now (see that file's header). This route exists
 * so the hit rate grade_picks computes is actually visible to a client,
 * not just Railway logs, and so a future agent/UI can list what's been
 * picked and how it graded without a direct DB connection.
 *
 * GET /picks              — list picks, most recent first.
 *                            ?agent_name=, ?status=, ?game_id=, ?player_id=
 * GET /picks/stats         — hit-rate summary (optionally ?agent_name=).
 *                            Same "pushes/voids excluded from the hit-rate
 *                            denominator" convention as grade_picks' own
 *                            log line.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

const MAX_RESULTS = 100;
const VALID_STATUSES = ['pending', 'correct', 'incorrect', 'push', 'void'];

router.get('/stats', async (req, res) => {
  const { agent_name } = req.query;

  const conditions = [];
  const params = [];
  if (agent_name) {
    params.push(agent_name);
    conditions.push(`agent_name = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
         COUNT(*) FILTER (WHERE status = 'correct')   AS correct,
         COUNT(*) FILTER (WHERE status = 'incorrect') AS incorrect,
         COUNT(*) FILTER (WHERE status = 'push')       AS push,
         COUNT(*) FILTER (WHERE status = 'void')        AS void,
         COUNT(*)                                       AS total
       FROM picks_log ${whereClause}`,
      params
    );
    const r = rows[0];
    const decided = Number(r.correct) + Number(r.incorrect);
    const hitRate = decided > 0 ? Number(((Number(r.correct) / decided) * 100).toFixed(1)) : null;

    res.json({
      data: {
        agent_name: agent_name || null,
        total: Number(r.total),
        pending: Number(r.pending),
        correct: Number(r.correct),
        incorrect: Number(r.incorrect),
        push: Number(r.push),
        void: Number(r.void),
        decided,
        hit_rate_pct: hitRate,
      },
    });
  } catch (err) {
    console.error('[routes/picks] stats failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/', async (req, res) => {
  const { agent_name, status, game_id, player_id } = req.query;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const conditions = [];
  const params = [];
  if (agent_name) {
    params.push(agent_name);
    conditions.push(`pl.agent_name = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`pl.status = $${params.length}`);
  }
  if (game_id) {
    params.push(game_id);
    conditions.push(`pl.game_id = $${params.length}`);
  }
  if (player_id) {
    params.push(player_id);
    conditions.push(`pl.player_id = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await query(
      `SELECT pl.pick_id, pl.agent_name, pl.game_id, pl.player_id, p.full_name AS player_name,
              pl.stat_category, pl.predicted_direction, pl.predicted_line, pl.confidence, pl.reasoning,
              pl.status, pl.actual_value, pl.graded_at, pl.created_at
       FROM picks_log pl
       LEFT JOIN players p ON p.player_id = pl.player_id
       ${whereClause}
       ORDER BY pl.created_at DESC
       LIMIT ${MAX_RESULTS}`,
      params
    );
    res.json({ data: rows, meta: { count: rows.length, limit: MAX_RESULTS } });
  } catch (err) {
    // Same 22P02 -> "treat as empty/not found" reasoning as routes/players.js
    // — a malformed game_id/player_id filter is a client input problem.
    if (err.code === '22P02') return res.json({ data: [], meta: { count: 0, limit: MAX_RESULTS } });
    console.error('[routes/picks] list failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
