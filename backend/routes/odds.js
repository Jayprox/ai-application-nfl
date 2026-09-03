/**
 * Chalk That NFL — odds route
 * =========================================================================
 * Exposes game_odds (The Odds API via worker/ingestion-worker.js's
 * sync_odds job — see docs/part2-roadmap.md Part 2 Phase 1). game_odds is
 * an append-only time series (every sync INSERTs new rows, see
 * db/migrations/003_game_odds.sql's own header) so both routes here pick
 * the latest synced_at per (game_id, bookmaker, market) rather than
 * exposing the raw log — a "current odds" view, same idea the migration's
 * comment already flagged as the intended future read pattern.
 *
 * Deliberately its own route, not folded into POST /query — same
 * "no predictive calculations" boundary that already keeps /insights
 * separate (architecture.md §2). Odds are raw vendor data (fair game for
 * a plain read), but game_odds isn't one of the *_game_stats tables
 * /query already knows how to aggregate, and a market's shape (paired
 * home/away or over/under prices) doesn't fit /query's per-column-average
 * response shape anyway.
 *
 * GET /odds/games/:id           — current odds for one game, all
 *                                  bookmakers/markets.
 * GET /odds?season=&week=       — current odds across every scheduled
 *                                  game in that season (week optional),
 *                                  grouped by game. Built for the edge
 *                                  agent to scan a whole slate at once
 *                                  rather than one game at a time.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

function groupByGame(rows) {
  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(formatOddsRow(r));
  }
  return byGame;
}

function formatOddsRow(r) {
  return {
    bookmaker: r.bookmaker,
    market: r.market,
    home_price: r.home_price,
    away_price: r.away_price,
    home_point: r.home_point,
    away_point: r.away_point,
    over_price: r.over_price,
    under_price: r.under_price,
    total_point: r.total_point,
    bookmaker_last_update: r.bookmaker_last_update,
    synced_at: r.synced_at,
  };
}

router.get('/games/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: gameRows } = await query('SELECT game_id FROM games WHERE game_id = $1', [id]);
    if (!gameRows[0]) return res.status(404).json({ error: 'game not found' });

    const { rows } = await query(
      `SELECT DISTINCT ON (bookmaker, market) *
       FROM game_odds
       WHERE game_id = $1
       ORDER BY bookmaker, market, synced_at DESC`,
      [id]
    );

    const freshness = await getFreshness('sync_odds');
    res.json({
      data: { game_id: id, bookmakers: rows.map(formatOddsRow) },
      meta: { sample_size: rows.length, freshness },
    });
  } catch (err) {
    console.error('[routes/odds] game lookup failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/', async (req, res) => {
  const { season, week } = req.query;

  if (!season || !/^\d{4}$/.test(String(season))) {
    // Same validation shape as POST /query and GET /insights/players/:id —
    // an unvalidated season otherwise reaches Postgres as a raw type-cast
    // error against an INT column.
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (week !== undefined && !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week must be a 1-2 digit number' });
  }

  try {
    const params = [parseInt(season, 10)];
    let weekFilter = '';
    if (week !== undefined) {
      params.push(parseInt(week, 10));
      weekFilter = `AND g.week = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT DISTINCT ON (go.game_id, go.bookmaker, go.market) go.*
       FROM game_odds go
       JOIN games g ON g.game_id = go.game_id
       WHERE g.season = $1 ${weekFilter}
       ORDER BY go.game_id, go.bookmaker, go.market, go.synced_at DESC`,
      params
    );

    const byGame = groupByGame(rows);
    const data = [...byGame.entries()].map(([game_id, bookmakers]) => ({ game_id, bookmakers }));

    const freshness = await getFreshness('sync_odds');
    res.json({ data, meta: { sample_size: data.length, freshness } });
  } catch (err) {
    console.error('[routes/odds] list failed:', err);
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
