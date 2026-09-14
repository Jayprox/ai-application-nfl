/**
 * Chalk That NFL — games/schedule route
 * =========================================================================
 * GET /games?season=&week=  — one week's full schedule: both teams, kickoff
 *                              time, stadium, weather, score, and status.
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
              g.weather_condition, g.weather_temp_f, g.weather_wind_mph,
              g.home_score, g.away_score, g.status,
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
