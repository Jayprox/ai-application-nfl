/**
 * Chalk That NFL — the shared query engine (HTTP wrapper)
 * =========================================================================
 * POST /query — the ONE endpoint both the web/iOS UI and future AI agents
 * call for stats. No predictive calculations: every response is a plain
 * filtered aggregation (or raw game log) over the *_game_stats tables,
 * computed at request time. See architecture.md §2/§5 for the design.
 *
 * Body:
 *   entity_type: "player" | "team"
 *   entity_id:   player UUID, or numeric team_id
 *   scope:       "season" | "season_total" | "last5" | "career" | "game_log" | "leaderboard"
 *   season:      required for season/season_total/last5/game_log/leaderboard, ignored for career
 *   splits:      optional { home_away, game_slot, weather_condition }
 *
 * scope: "leaderboard" (2026-09-28, League Leaderboard) is shaped
 * differently -- no entity_type/entity_id, since it's not about one
 * player/team. Its own params instead: stat (one of lib/stats-query.js's
 * LEADERBOARD_STATS keys), game_type ("regular" | "postseason", default
 * "regular"), per_game (bool, default false, ignored for rate stats),
 * limit (1-50, default 10). Real season totals sorted and capped, no
 * scoring model -- see lib/ranking.js's Rankings agent for the deliberately
 * distinct model-based ranking feature this is NOT trying to be.
 *
 * Response:
 *   { data: {...per-game averages (season/last5) or career totals
 *             (career)...} | [...game log rows...],
 *     meta: { sample_size, freshness: { synced_at } } }
 *
 * career vs season/season_total/last5: "Career" is deliberately
 * cumulative totals (SUM), not another per-game average, even though it
 * shares a query shape with season/last5 — a user reading "Career: 77.5
 * yards" and a user reading "Career: 6,252 yards" come away with very
 * different impressions of the same underlying data, and the tab is
 * labeled "Career" (not "Career Avg", unlike "Season Avg"), so the label
 * already promised totals. Rate-like columns that can't be honestly
 * summed (a kicker's longest field goal, a punter's per-punt average)
 * use a different aggregate — see lib/stats-query.js's
 * CAREER_AGGREGATE_OVERRIDE.
 *
 * season_total (2026-09-17, "add season totals to Players too" request)
 * is the same idea as career, just scoped to one season instead of every
 * season on record — SUM (with the same rate-like-column exceptions),
 * not the per-game average "season" already returns. Three genuinely
 * different things now share this route's scope param: season (avg,
 * one season), season_total (sum, one season), career (sum, every
 * season).
 *
 * Note: until the historical-data ingestion pass runs, `games` and the
 * *_game_stats tables are empty — every query here will correctly return
 * a zero-sample_size result rather than an error. That's the intended
 * "graceful empty state," not a bug — see checklist Phase 1 "done looks
 * like" and Phase 3 empty-state scope.
 *
 * Query logic moved out (2026-09-17, NL search bar backlog item). The
 * actual queryPlayer/queryTeam/buildPlayerWhere/etc. logic that used to
 * live in this file now lives in lib/stats-query.js's runStatsQuery(), so
 * the chat orchestrator's new get_player_stats tool (and its deterministic
 * StatMuse-style shortcut) can call it directly in-process — same "never
 * a second HTTP hop back into this same API" principle orchestrator.js's
 * header already states for get_rankings/get_edge/etc. This file is now
 * purely the HTTP-level concern: request validation and response shaping.
 * No behavior change to this endpoint from that move.
 * =========================================================================
 */

const express = require('express');
const {
  runStatsQuery,
  VALID_SCOPES,
  VALID_GAME_SLOTS,
  VALID_WEATHER,
  VALID_GAME_TYPES,
  LEADERBOARD_STATS,
} = require('../lib/stats-query');

const router = express.Router();

router.post('/', async (req, res) => {
  const { entity_type, entity_id, scope, season, splits } = req.body || {};

  // scope: "leaderboard" is a different shape from every other scope --
  // no entity_type/entity_id (it's not about one player/team), plus its
  // own stat/game_type/per_game/limit params -- so it's validated and
  // handled as its own branch rather than threading through the
  // entity_type/entity_id checks below. Deliberately NOT added to
  // VALID_SCOPES itself: that same constant is also the enum the chat
  // orchestrator's get_player_stats tool exposes to the LLM (see
  // lib/orchestrator.js), and that tool always requires a player_id --
  // adding "leaderboard" there would offer the LLM a scope its own tool
  // can't actually satisfy.
  if (scope === 'leaderboard') {
    const { stat, game_type: gameTypeRaw, per_game: perGame = false, limit } = req.body || {};
    const gameType = gameTypeRaw ?? 'regular';

    if (!stat || !LEADERBOARD_STATS[stat]) {
      return res.status(400).json({ error: `stat is required and must be one of: ${Object.keys(LEADERBOARD_STATS).join(', ')}` });
    }
    if (!season || !/^\d{4}$/.test(String(season))) {
      return res.status(400).json({ error: 'season must be a 4-digit year' });
    }
    if (!VALID_GAME_TYPES.includes(gameType)) {
      return res.status(400).json({ error: `game_type must be one of: ${VALID_GAME_TYPES.join(', ')}` });
    }
    if (typeof perGame !== 'boolean') {
      return res.status(400).json({ error: 'per_game must be a boolean' });
    }
    const resultLimit = limit === undefined ? 10 : Number(limit);
    if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 50) {
      return res.status(400).json({ error: 'limit must be an integer 1-50' });
    }

    try {
      const result = await runStatsQuery({ scope, stat, season: Number(season), gameType, perGame, limit: resultLimit });
      if (result.error) return res.status(result.status || 400).json({ error: result.error });
      return res.json({
        data: result.data,
        meta: { sample_size: result.sampleSize, freshness: result.freshness, qualifier: result.qualifier, notes: result.notes },
      });
    } catch (err) {
      console.error('[routes/query] leaderboard failed:', err);
      return res.status(500).json({ error: 'internal error' });
    }
  }

  if (!['player', 'team'].includes(entity_type)) {
    return res.status(400).json({ error: 'entity_type must be "player" or "team"' });
  }
  if (!entity_id) {
    return res.status(400).json({ error: 'entity_id is required' });
  }
  if (!VALID_SCOPES.includes(scope)) {
    return res.status(400).json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` });
  }
  if (scope !== 'career' && !season) {
    return res.status(400).json({ error: 'season is required for season/season_total/last5/game_log scope' });
  }
  if (scope !== 'career' && !/^\d{4}$/.test(String(season))) {
    // Without this, a non-numeric season (or e.g. "20255") reaches the DB
    // as a query param against an INT column, which Postgres rejects with
    // a raw type-cast error — caught below and previously surfaced as a
    // generic 500 instead of a clean 400 telling the caller what's wrong.
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (splits?.game_slot && !VALID_GAME_SLOTS.includes(splits.game_slot)) {
    return res.status(400).json({ error: `splits.game_slot must be one of: ${VALID_GAME_SLOTS.join(', ')}` });
  }
  if (splits?.weather_condition && !VALID_WEATHER.includes(splits.weather_condition)) {
    return res.status(400).json({ error: `splits.weather_condition must be one of: ${VALID_WEATHER.join(', ')}` });
  }
  if (splits?.home_away && !['home', 'away'].includes(splits.home_away)) {
    return res.status(400).json({ error: 'splits.home_away must be "home" or "away"' });
  }

  try {
    const result = await runStatsQuery({ entity_type, entity_id, scope, season, splits });

    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    res.json({ data: result.data, meta: { sample_size: result.sampleSize, freshness: result.freshness } });
  } catch (err) {
    // A malformed player UUID throws a Postgres error (invalid input
    // syntax) here too — same client-input case routes/players.js's
    // GET /:id already treats as "not found" rather than a 500.
    if (err.code === '22P02') return res.status(404).json({ error: 'player not found' });
    console.error('[routes/query] failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
