/**
 * Chalk That NFL — edge agent route
 * =========================================================================
 * GET /edge/games/:gameId          — single game's model-vs-market lean
 * GET /edge?season=&week=&only_disagreements= — a week's games, optionally
 *                                     filtered to just the disagreements
 *
 * See lib/edge.js for why this is scoped to game-level (spreads/h2h)
 * rather than player-prop level, and docs/part2-roadmap.md for the edge
 * agent's role: "once odds data exists, compares the model's implied
 * read against the book's."
 * =========================================================================
 */

const express = require('express');
const { compareGameEdge, listEdges } = require('../lib/edge');

const router = express.Router();

router.get('/games/:gameId', async (req, res) => {
  try {
    const edge = await compareGameEdge(req.params.gameId);
    if (!edge) return res.status(404).json({ error: 'game not found' });
    res.json({ data: edge });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'game not found' });
    console.error('[routes/edge] game lookup failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/', async (req, res) => {
  const { season, week, only_disagreements: onlyDisagreements } = req.query;
  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (!week || !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week is required and must be a 1-2 digit number' });
  }

  try {
    const results = await listEdges({
      season: Number(season),
      week: Number(week),
      onlyDisagreements: onlyDisagreements === 'true',
    });
    res.json({ data: results, meta: { count: results.length } });
  } catch (err) {
    console.error('[routes/edge] list failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
