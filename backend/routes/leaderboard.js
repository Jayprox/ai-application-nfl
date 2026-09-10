/**
 * Chalk That NFL — leaderboard route
 * =========================================================================
 * GET /leaderboard — ranks every agent that has logged picks to
 * picks_log (db/migrations/004_picks_log.sql / 006_picks_log_game_lines
 * .sql) by hit rate, decided-pick count as a tiebreaker. Same "pushes/
 * voids excluded from the hit-rate denominator" convention
 * routes/picks.js's GET /picks/stats already uses — this is effectively
 * that same aggregation, grouped across every agent_name instead of
 * filtered to one.
 *
 * Real ranking infrastructure, not just a stats dump: built for when
 * more than one agent is logging picks (ranking_agent_v1, edge_agent_v1
 * — see docs/part2-roadmap.md's agent-role breakdown), not only for the
 * one agent (portfolio_agent_v1) that logs picks today. A single-row
 * leaderboard right now is the honest result, not a bug — more rows
 * appear as more agents start writing to picks_log.
 *
 * Deliberately does NOT compute PNL/units profit. An earlier reference
 * doc (an MLB sister app's architecture notes) assumed a stored odds
 * price per pick to compute payout from. picks_log has no such column —
 * lib/portfolio.js's reasoning text mentions the market line at pick
 * time, but never persists it structurally, so there's no honest price
 * to compute a payout against today. Record + hit rate are what's
 * actually computable now; a PNL column would need picks_log to start
 * storing the price at pick time, a real schema change, not something to
 * fake here.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         agent_name,
         COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
         COUNT(*) FILTER (WHERE status = 'correct')   AS correct,
         COUNT(*) FILTER (WHERE status = 'incorrect') AS incorrect,
         COUNT(*) FILTER (WHERE status = 'push')       AS push,
         COUNT(*) FILTER (WHERE status = 'void')        AS void,
         COUNT(*)                                       AS total
       FROM picks_log
       GROUP BY agent_name`
    );

    const agents = rows.map((r) => {
      const correct = Number(r.correct);
      const incorrect = Number(r.incorrect);
      const decided = correct + incorrect;
      return {
        agent_name: r.agent_name,
        total: Number(r.total),
        pending: Number(r.pending),
        correct,
        incorrect,
        push: Number(r.push),
        void: Number(r.void),
        decided,
        hit_rate_pct: decided > 0 ? Number(((correct / decided) * 100).toFixed(1)) : null,
      };
    });

    // Ranked by hit rate, best first. Agents with zero decided picks sort
    // last (hit_rate_pct: null), never zeroth — "no sample yet" and "0%"
    // mean very different things and shouldn't be conflated. Decided
    // count breaks ties so a 1-0 agent doesn't outrank a 20-5 one purely
    // on a tiny sample.
    agents.sort((a, b) => {
      if (a.hit_rate_pct === null && b.hit_rate_pct === null) return b.decided - a.decided;
      if (a.hit_rate_pct === null) return 1;
      if (b.hit_rate_pct === null) return -1;
      if (b.hit_rate_pct !== a.hit_rate_pct) return b.hit_rate_pct - a.hit_rate_pct;
      return b.decided - a.decided;
    });

    const ranked = agents.map((a, i) => ({ rank: i + 1, ...a }));
    res.json({ data: ranked, meta: { agent_count: ranked.length } });
  } catch (err) {
    console.error('[routes/leaderboard] failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
