/**
 * Chalk That NFL — games/schedule route
 * =========================================================================
 * GET /games?season=&week=  — one week's full schedule: both teams, kickoff
 *                              time, stadium, weather, score, and status.
 * GET /games/current-week    — resolves "this week" to {season, week} —
 *                              added 2026-09-14 for BoardPage.jsx's front
 *                              door, which needs a sensible default
 *                              without asking the user to type one (unlike
 *                              GamesPage/RankingsPage/EdgePage/PortfolioPage,
 *                              which all require manual entry). Shares
 *                              lib/current-week.js's query with the chat
 *                              orchestrator's own get_current_week tool —
 *                              see that file's header for why this used to
 *                              only exist inside orchestrator.js.
 * GET /games/:gameId         — single game, same row shape as above — the
 *                              per-game deep dive page's (GameDetailPage.jsx)
 *                              primary fetch. Composes with the pre-existing
 *                              GET /edge/games/:gameId and GET /odds/games/:id
 *                              plus GET /games/:gameId/injuries below.
 * GET /games/:gameId/injuries — both rosters' latest injury_reports row per
 *                              player for this game's season/week, split
 *                              into { home, away } — see that route's own
 *                              comment for why a season/week-scoped query
 *                              is possible here (injury_reports carries
 *                              team_id/season/week directly).
 *
 * This is the "front door" data source for Part 2 Phase 3's Games/Slate
 * page (docs/part2-roadmap.md) — a sportsbook-scoreboard-style week view
 * that links out into the existing research surfaces (Rankings, Edge,
 * Insights, player/team pages) rather than duplicating them. Deliberately
 * scoped to schedule/score/weather only: odds and the edge agent's
 * model-vs-market lean are already their own routes (GET /odds,
 * GET /edge) with their own tables and freshness — a game card composes
 * this response with those rather than this route re-fetching or
 * duplicating that data itself, same "one source of truth" principle the
 * rest of this app already follows (e.g. lib/edge.js reusing
 * matchup_scores instead of a parallel score).
 *
 * season+week are both required (same as GET /edge, not optional like
 * GET /rankings/GET /odds) because the whole point of this route is "one
 * week's games" — a season with no week filter would return the entire
 * year's schedule for no real use case this page has.
 *
 * Status is read straight from games.status. As of 2026-09-14 that can
 * genuinely be 'in_progress' during a game's live window — a separate
 * worker job, sync_live_scores, writes status/home_score/away_score on a
 * ~10-minute cadence while a game is live (see docs/part2-roadmap.md's
 * "refresh cadence lags same-day results" backlog item and that job's
 * own header comment in worker/ingestion-worker.js for the Highlightly
 * quota math behind that cadence). This route still doesn't fake
 * anything: before sync_live_scores' first successful tick for a given
 * game, status stays 'scheduled' with null scores exactly as before.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');
const { getCurrentWeek } = require('../lib/current-week');

const router = express.Router();

router.get('/', async (req, res) => {
  const { season, week } = req.query;

  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (!week || !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week is required and must be a 1-2 digit number' });
  }

  try {
    const { rows } = await query(
      `SELECT g.game_id, g.season, g.week, g.game_type, g.game_datetime, g.game_slot,
              g.weather_condition, g.weather_temp_f, g.weather_wind_mph, g.weather_wind_direction_deg,
              g.home_score, g.away_score, g.status, g.game_period, g.game_clock,
              ht.team_id AS home_team_id, ht.abbreviation AS home_team_abbr, ht.name AS home_team_name,
              at.team_id AS away_team_id, at.abbreviation AS away_team_abbr, at.name AS away_team_name,
              s.name AS stadium_name, s.city AS stadium_city, s.state AS stadium_state, s.roof AS stadium_roof
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team_id
       JOIN teams at ON at.team_id = g.away_team_id
       JOIN stadiums s ON s.stadium_id = g.stadium_id
       WHERE g.season = $1 AND g.week = $2
       ORDER BY g.game_datetime ASC`,
      [parseInt(season, 10), parseInt(week, 10)]
    );

    const freshness = await getFreshness('sync_schedule');
    res.json({
      data: rows,
      meta: { season: parseInt(season, 10), week: parseInt(week, 10), count: rows.length, freshness },
    });
  } catch (err) {
    console.error('[routes/games] list failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /games/current-week — resolves "this week" to {season, week} for
// clients that need a sensible default without asking the user to enter
// one (BoardPage.jsx's primary/gating fetch). Registered here, BEFORE
// GET /:gameId below, so this literal path isn't swallowed by that
// param route — Express matches routes in registration order and
// "current-week" would otherwise bind to :gameId. Shares its query with
// backend/lib/orchestrator.js's own get_current_week tool case via
// lib/current-week.js — one source of truth, not two copies.
router.get('/current-week', async (req, res) => {
  try {
    const current = await getCurrentWeek();
    if (!current) return res.status(404).json({ error: 'no games found in the schedule' });
    res.json({ data: current });
  } catch (err) {
    console.error('[routes/games] current-week failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /games/:gameId — single game, same shape as one row of GET /games
// (season+week list above) — GameDetailPage.jsx's primary fetch. Composes
// with the already-existing GET /edge/games/:gameId (backend/routes/edge.js)
// and GET /odds/games/:id (backend/routes/odds.js) plus the new
// GET /games/:gameId/injuries route below, same "one source of truth,
// link out rather than duplicate" principle as the rest of this file —
// this route stays schedule/score/weather-only, exactly like the list
// route above.
router.get('/:gameId', async (req, res) => {
  const { gameId } = req.params;
  try {
    const { rows } = await query(
      `SELECT g.game_id, g.season, g.week, g.game_type, g.game_datetime, g.game_slot,
              g.weather_condition, g.weather_temp_f, g.weather_wind_mph, g.weather_wind_direction_deg,
              g.home_score, g.away_score, g.status, g.game_period, g.game_clock,
              ht.team_id AS home_team_id, ht.abbreviation AS home_team_abbr, ht.name AS home_team_name,
              at.team_id AS away_team_id, at.abbreviation AS away_team_abbr, at.name AS away_team_name,
              s.name AS stadium_name, s.city AS stadium_city, s.state AS stadium_state, s.roof AS stadium_roof
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team_id
       JOIN teams at ON at.team_id = g.away_team_id
       JOIN stadiums s ON s.stadium_id = g.stadium_id
       WHERE g.game_id = $1`,
      [gameId]
    );
    const game = rows[0];
    if (!game) return res.status(404).json({ error: 'game not found' });

    const freshness = await getFreshness('sync_schedule');
    res.json({ data: game, meta: { freshness } });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'game not found' });
    console.error('[routes/games] detail lookup failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /games/:gameId/injuries — both teams' latest injury_reports row per
// player for this game's season/week, split into { home, away }.
// injury_reports carries team_id/season/week directly (db/schema.sql),
// so this can filter straight to the two rosters that actually played in
// THIS game rather than needing a "most recent report ever" fallback —
// same DISTINCT ON (player_id) ... ORDER BY report_date DESC "latest
// report wins" pattern backend/routes/players.js already uses for a
// single player, just widened here to both rosters at once. Mirrors
// GET /edge/games/:gameId and GET /odds/games/:id in shape (game-scoped,
// 404 on an unknown or malformed game id) so GameDetailPage.jsx composes
// all three the same way.
router.get('/:gameId/injuries', async (req, res) => {
  const { gameId } = req.params;
  try {
    const { rows: gameRows } = await query(
      `SELECT home_team_id, away_team_id, season, week FROM games WHERE game_id = $1`,
      [gameId]
    );
    const game = gameRows[0];
    if (!game) return res.status(404).json({ error: 'game not found' });

    const { rows } = await query(
      `SELECT DISTINCT ON (ir.player_id)
              ir.player_id, ir.team_id, p.full_name, p.position,
              ir.report_status, ir.practice_status, ir.primary_injury, ir.secondary_injury, ir.report_date
       FROM injury_reports ir
       JOIN players p ON p.player_id = ir.player_id
       WHERE ir.team_id IN ($1, $2) AND ir.season = $3 AND ir.week = $4
       ORDER BY ir.player_id, ir.report_date DESC`,
      [game.home_team_id, game.away_team_id, game.season, game.week]
    );

    res.json({
      data: {
        home: rows.filter((r) => r.team_id === game.home_team_id),
        away: rows.filter((r) => r.team_id === game.away_team_id),
      },
      meta: { count: rows.length },
    });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'game not found' });
    console.error('[routes/games] injuries lookup failed:', err);
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
