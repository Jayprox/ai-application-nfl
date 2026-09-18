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
 * Team totals (added 2026-09-18, db/migrations/013_team_totals_odds.sql,
 * worker's sync_team_totals job): the 'team_totals' market writes TWO
 * rows per bookmaker (one per team, via the new team_side column) rather
 * than one, so both routes' "latest per ___" dedup now groups by
 * (..., team_side) too — see each query's own comment below.
 *
 * Closing-line lock (added 2026-09-15, Board page request: "lock the
 * values when the game starts, so it doesn't change during the game"):
 * sync_odds keeps polling a live event and INSERTing new rows for as long
 * as the vendor still returns it, so before this change the "latest
 * synced_at" row could keep moving after kickoff -- in-play line moves,
 * or a lagging removal, changing what a viewer saw mid-game. Fixed here at
 * the read layer rather than in sync_odds itself, on purpose: game_odds
 * stays the same append-only log (line movement over time is still
 * queryable later, per 003_game_odds.sql's own header), and both routes
 * below now pick the latest row *as of kickoff* once a game has left
 * 'scheduled' -- games.game_datetime as the cutoff, games.status to know
 * when to apply it. A 'scheduled' or 'postponed' game is unaffected and
 * still reads the true latest sync.
 *
 * GET /odds/games/:id           — odds for one game, all bookmakers/
 *                                  markets. Latest sync while the game is
 *                                  'scheduled'; locked to the last sync at
 *                                  or before kickoff once 'in_progress' or
 *                                  'final' (see closing-line lock above).
 * GET /odds?season=&week=       — same odds/locking rules across every
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
    // 'team_totals' only (db/migrations/013_team_totals_odds.sql) --
    // which team over_price/under_price/total_point above belong to.
    // Always null for every other market.
    team_side: r.team_side,
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
      // DISTINCT ON includes team_side so a 'team_totals' market's two
      // rows (home + away, see db/migrations/013_team_totals_odds.sql)
      // both survive the "latest per bookmaker/market" dedup instead of
      // one clobbering the other -- Postgres treats NULL as an equal
      // grouping key here, so every other market (team_side always
      // NULL) dedups exactly as before.
      `SELECT DISTINCT ON (go.bookmaker, go.market, go.team_side) go.*
       FROM game_odds go
       JOIN games g ON g.game_id = go.game_id
       WHERE go.game_id = $1
         AND (g.status NOT IN ('in_progress', 'final') OR go.synced_at <= g.game_datetime)
       ORDER BY go.bookmaker, go.market, go.team_side, go.synced_at DESC`,
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
      // Same team_side addition as GET /games/:id above.
      `SELECT DISTINCT ON (go.game_id, go.bookmaker, go.market, go.team_side) go.*
       FROM game_odds go
       JOIN games g ON g.game_id = go.game_id
       WHERE g.season = $1 ${weekFilter}
         AND (g.status NOT IN ('in_progress', 'final') OR go.synced_at <= g.game_datetime)
       ORDER BY go.game_id, go.bookmaker, go.market, go.team_side, go.synced_at DESC`,
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
