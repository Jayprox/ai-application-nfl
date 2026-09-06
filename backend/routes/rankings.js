/**
 * Chalk That NFL — ranking agent route
 * =========================================================================
 * GET /rankings?stat_category=&season=&week=&limit=
 *
 * Deterministic top-N view over matchup_scores for one stat category
 * (passing_yards | rushing_yards | receiving_yards | tackles) — see
 * lib/ranking.js for why "stat category" maps to a position filter
 * rather than a new column, and docs/part2-roadmap.md for why this is
 * "the ranking agent": the cheapest agent to ship, pure deterministic
 * scoring with no LLM call, meant to validate the calibration loop
 * before anything fancier gets built on top of it.
 * =========================================================================
 */

const express = require('express');
const { rankMatchups, STAT_CATEGORIES } = require('../lib/ranking');
const { query } = require('../db');

const router = express.Router();
const MAX_RESULTS = 100;
const DEFAULT_RESULTS = 20;

async function getFreshness() {
  const { rows } = await query(
    `SELECT finished_at FROM ingestion_runs
     WHERE job_type = 'compute_matchup_scores' AND status = 'success'
     ORDER BY finished_at DESC LIMIT 1`
  );
  return { synced_at: rows[0]?.finished_at || null };
}

router.get('/', async (req, res) => {
  const { stat_category: statCategory, season, week, limit } = req.query;

  if (!statCategory || !STAT_CATEGORIES.includes(statCategory)) {
    return res.status(400).json({ error: `stat_category is required and must be one of: ${STAT_CATEGORIES.join(', ')}` });
  }
  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (week !== undefined && !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week must be a 1-2 digit number' });
  }
  const resultLimit = Math.min(MAX_RESULTS, Number(limit) || DEFAULT_RESULTS);

  try {
    const rankings = await rankMatchups({
      statCategory,
      season: Number(season),
      week: week !== undefined ? Number(week) : undefined,
      limit: resultLimit,
    });
    const freshness = await getFreshness();
    res.json({
      data: rankings,
      meta: { stat_category: statCategory, count: rankings.length, limit: resultLimit, freshness },
    });
  } catch (err) {
    console.error('[routes/rankings] list failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
