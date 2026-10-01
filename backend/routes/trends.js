/**
 * Chalk That NFL — trend/streak agent route
 * =========================================================================
 * GET /trends?market=&season=&direction=&limit= — current real streaks
 * against DraftKings' actual line for one market. See lib/trends.js for
 * the grading rule (a direct port of PropsPage.jsx's gradeProp()) and
 * why this is its own small agent rather than a /query leaderboard scope.
 * =========================================================================
 */

const express = require('express');
const { currentStreaks, directionsFor, MARKET_LABEL, VALID_MARKETS } = require('../lib/trends');
const { query } = require('../db');

const router = express.Router();
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 15;

async function getFreshness() {
  const { rows } = await query(
    `SELECT finished_at FROM ingestion_runs
     WHERE job_type = 'sync_player_props' AND status = 'success'
     ORDER BY finished_at DESC LIMIT 1`
  );
  return { synced_at: rows[0]?.finished_at || null };
}

router.get('/', async (req, res) => {
  const { market, season, direction, limit } = req.query;

  if (!market || !VALID_MARKETS.includes(market)) {
    return res.status(400).json({ error: `market must be one of: ${VALID_MARKETS.join(', ')}` });
  }
  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  const validDirections = directionsFor(market);
  if (!direction || !validDirections.includes(direction)) {
    return res.status(400).json({ error: `direction must be one of: ${validDirections.join(', ')} for this market` });
  }
  if (limit !== undefined && !/^\d+$/.test(String(limit))) {
    return res.status(400).json({ error: 'limit must be a non-negative integer' });
  }
  const resultLimit = Math.min(MAX_RESULTS, Number(limit) || DEFAULT_RESULTS);

  try {
    const data = await currentStreaks({ market, season: Number(season), direction, limit: resultLimit });
    const freshness = await getFreshness();
    res.json({
      data,
      meta: { market, market_label: MARKET_LABEL[market], direction, count: data.length, limit: resultLimit, freshness },
    });
  } catch (err) {
    console.error('[routes/trends] failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
