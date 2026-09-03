/**
 * Chalk That NFL — insight-layer route
 * =========================================================================
 * GET /insights/players/:id?season=YYYY — the deterministic label/note
 * layer described in lib/insights.js. Deliberately a separate endpoint
 * from POST /query (which does "no predictive calculations" per
 * architecture.md §2) — same boundary GET /players/:id already draws for
 * stats ("stats go through /query, not a duplicate code path").
 *
 * Response: { data: { player_id, season, insights: [...] },
 *             meta: { freshness } }
 * Each insights[] entry is { category, label, note } — label is nullable
 * (insufficient sample, no upcoming game, special-teams position, etc —
 * see lib/insights.js's per-category comments for exactly when).
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');
const { computePlayerInsights } = require('../lib/insights');

const router = express.Router();

router.get('/players/:id', async (req, res) => {
  const { id } = req.params;
  const { season } = req.query;

  if (!season || !/^\d{4}$/.test(String(season))) {
    // Same validation as POST /query — a non-4-digit season otherwise
    // reaches Postgres as a raw type-cast error against an INT column.
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }

  try {
    const result = await computePlayerInsights(id, parseInt(season, 10));
    if (!result) return res.status(404).json({ error: 'player not found' });

    const freshness = await getFreshness('sync_historical_stats');
    res.json({
      data: { player_id: id, season: parseInt(season, 10), insights: result.insights },
      meta: { freshness },
    });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'player not found' });
    console.error('[routes/insights] failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

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
