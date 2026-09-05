/**
 * Chalk That NFL — matchup-scores route
 * =========================================================================
 * Read-only view onto matchup_scores (Part 2 Phase 2's blended per-
 * matchup score — db/migrations/005_matchup_scores.sql,
 * scripts/compute-matchup-scores.js). Computed once daily by its own
 * Railway cron service, not on request — this route only ever reads the
 * cached table, same "shared daily snapshot" pattern the MLB sister app
 * uses for its own matchupScore.
 *
 * GET /matchup-scores?season=&week=&limit=   — ranked list, highest score
 *                                                first (optionally scoped
 *                                                to one week). Built for
 *                                                the ranking agent to scan
 *                                                a whole slate at once.
 * GET /matchup-scores/players/:id?season=     — one player's current score
 *                                                + breakdown.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();
const MAX_RESULTS = 100;

async function getFreshness() {
  const { rows } = await query(
    `SELECT finished_at FROM ingestion_runs
     WHERE job_type = 'compute_matchup_scores' AND status = 'success'
     ORDER BY finished_at DESC LIMIT 1`
  );
  return { synced_at: rows[0]?.finished_at || null };
}

router.get('/players/:id', async (req, res) => {
  const { id } = req.params;
  const { season } = req.query;
  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }

  try {
    const { rows } = await query(
      `SELECT ms.player_id, ms.game_id, ms.season, ms.score, ms.categories_used, ms.breakdown, ms.computed_at
       FROM matchup_scores ms
       WHERE ms.player_id = $1 AND ms.season = $2
       ORDER BY ms.computed_at DESC LIMIT 1`,
      [id, season]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'no matchup score found for this player/season (no upcoming game, or not yet computed)' });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    // Same 22P02 -> 404 pattern as routes/players.js — a malformed
    // player_id is a client input problem, not a server fault.
    if (err.code === '22P02') return res.status(404).json({ error: 'no matchup score found for this player/season' });
    console.error('[routes/matchup-scores] player lookup failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/', async (req, res) => {
  const { season, week, limit } = req.query;
  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (week !== undefined && !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week must be a 1-2 digit number' });
  }
  const resultLimit = Math.min(MAX_RESULTS, Number(limit) || MAX_RESULTS);

  try {
    const params = [Number(season)];
    let weekFilter = '';
    if (week !== undefined) {
      params.push(Number(week));
      weekFilter = `AND g.week = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT ms.player_id, p.full_name AS player_name, p.position,
              ms.game_id, ms.score, ms.categories_used, ms.breakdown, ms.computed_at
       FROM matchup_scores ms
       JOIN players p ON p.player_id = ms.player_id
       JOIN games g ON g.game_id = ms.game_id
       WHERE ms.season = $1 ${weekFilter}
       ORDER BY ms.score DESC
       LIMIT ${resultLimit}`,
      params
    );
    const freshness = await getFreshness();
    res.json({ data: rows, meta: { count: rows.length, limit: resultLimit, freshness } });
  } catch (err) {
    console.error('[routes/matchup-scores] list failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
