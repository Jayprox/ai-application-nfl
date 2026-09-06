/**
 * Chalk That NFL — edge agent (game-level v1)
 * =========================================================================
 * Part 2 Phase 2 (docs/part2-roadmap.md): "once odds data exists, compares
 * the model's implied read against the book's."
 *
 * Scoped to GAME level, not player level, because of a real data gap:
 * game_odds (db/migrations/003_game_odds.sql) only carries team/game
 * markets from The Odds API's bulk /odds endpoint (h2h, spreads, totals —
 * see worker/ingestion-worker.js's ODDS_MARKETS). NFL player-prop odds
 * need a separate per-event API call (one request per game, not one for
 * the whole slate) — real added API quota cost, and docs/vibe-coding-
 * checklist.md already flags player props as "the leading candidate for
 * NFL player props when that phase starts," i.e. deliberately not this
 * phase. Meanwhile the ranking agent/matchup_scores are entirely
 * player-level. Rather than fake a player-prop comparison against data
 * that doesn't exist, this compares what's honestly available on both
 * sides: each team's aggregate offensive-skill matchup-score lean (each
 * player's own score there already factors that player's matchup vs.
 * this same opponent) against which side the book actually favors in
 * spreads/h2h.
 *
 * This is a LEAN, not a prediction — same "don't fake a number" honesty
 * insights.js and blendScore() already follow. It reports which side
 * (home/away) the aggregate skews toward and separately which side the
 * market favors, and flags whether they agree or disagree. No implied
 * probability, no confidence score, no combined total-points read —
 * those would require calibrating matchup_scores against real point
 * differentials, which hasn't been done and isn't attempted here.
 * =========================================================================
 */

const { query } = require('../db');

const OFFENSE_SKILL_POSITIONS = ['QB', 'RB', 'FB', 'HB', 'WR', 'TE'];

async function teamOffenseLean(gameId, teamId) {
  const { rows } = await query(
    `SELECT AVG(ms.score) AS avg_score, COUNT(*) AS player_count
     FROM matchup_scores ms
     JOIN players p ON p.player_id = ms.player_id
     WHERE ms.game_id = $1 AND p.current_team_id = $2 AND p.position = ANY($3::text[])`,
    [gameId, teamId, OFFENSE_SKILL_POSITIONS]
  );
  const row = rows[0];
  const playerCount = Number(row?.player_count || 0);
  if (!playerCount) return null;
  return { avg_score: Number(row.avg_score), player_count: playerCount };
}

async function latestOdds(gameId, market) {
  const { rows } = await query(
    `SELECT * FROM game_odds WHERE game_id = $1 AND market = $2 ORDER BY synced_at DESC LIMIT 1`,
    [gameId, market]
  );
  return rows[0] || null;
}

// Which side the market favors. Prefers spreads (a point spread is a
// cleaner favorite signal than moneyline price rounding); falls back to
// h2h if no spread has synced yet for this game.
function marketFavorite(spreadsRow, h2hRow) {
  if (spreadsRow && spreadsRow.home_point != null) {
    const homePoint = Number(spreadsRow.home_point);
    if (homePoint < 0) return { favorite: 'home', margin: Math.abs(homePoint), source: 'spreads' };
    if (homePoint > 0) return { favorite: 'away', margin: Math.abs(homePoint), source: 'spreads' };
    return { favorite: null, margin: 0, source: 'spreads' }; // pick 'em
  }
  if (h2hRow && h2hRow.home_price != null && h2hRow.away_price != null) {
    const homePrice = Number(h2hRow.home_price);
    const awayPrice = Number(h2hRow.away_price);
    if (homePrice === awayPrice) return { favorite: null, margin: 0, source: 'h2h' };
    // American odds: the more negative price is the favorite.
    return { favorite: homePrice < awayPrice ? 'home' : 'away', margin: Math.abs(homePrice - awayPrice), source: 'h2h' };
  }
  return null;
}

async function compareGameEdge(gameId) {
  const { rows: gameRows } = await query(
    `SELECT game_id, home_team_id, away_team_id, season, week, status FROM games WHERE game_id = $1`,
    [gameId]
  );
  const game = gameRows[0];
  if (!game) return null;

  const [homeLean, awayLean, spreadsRow, h2hRow] = await Promise.all([
    teamOffenseLean(gameId, game.home_team_id),
    teamOffenseLean(gameId, game.away_team_id),
    latestOdds(gameId, 'spreads'),
    latestOdds(gameId, 'h2h'),
  ]);

  if (!homeLean && !awayLean) {
    return { game_id: gameId, home_lean: null, away_lean: null, market_favorite: null, edge: null, note: 'No matchup scores computed yet for either team in this game.' };
  }

  const market = marketFavorite(spreadsRow, h2hRow);
  if (!market) {
    return { game_id: gameId, home_lean: homeLean, away_lean: awayLean, market_favorite: null, edge: null, note: 'No spreads or h2h odds synced yet for this game.' };
  }

  // model_margin matters as much as the favorite direction itself — a
  // 46.2-vs-45.0 lean and a 59.7-vs-47.8 lean both produce a "favorite,"
  // but the first is essentially a coin flip and the second is a real
  // gap. Exposing the raw margin (rather than collapsing straight to a
  // boolean) is the same "don't fake a confident answer" principle
  // insights.js and blendScore() already follow with categoriesUsed —
  // let the reader judge how much a disagreement actually means.
  let modelFavorite = null;
  let modelMargin = null;
  if (homeLean && awayLean) {
    modelMargin = Math.abs(homeLean.avg_score - awayLean.avg_score);
    if (homeLean.avg_score > awayLean.avg_score) modelFavorite = 'home';
    else if (awayLean.avg_score > homeLean.avg_score) modelFavorite = 'away';
  } else if (homeLean) {
    modelFavorite = 'home'; // only one side has any signal at all — a weak basis, noted below
  } else if (awayLean) {
    modelFavorite = 'away';
  }

  const agrees = market.favorite === null || modelFavorite === null ? null : modelFavorite === market.favorite;

  return {
    game_id: gameId,
    home_lean: homeLean,
    away_lean: awayLean,
    model_favorite: modelFavorite,
    model_margin: modelMargin,
    market_favorite: market.favorite,
    market_margin: market.margin,
    market_source: market.source,
    edge: agrees === null ? null : !agrees, // a disagreement is what's worth a second look
    note: agrees === null
      ? "Not enough signal on one side, or the market is a pick-'em, to compare a direction."
      : agrees
        ? `Model's offensive-skill lean and the market's ${market.source} favorite agree (${market.favorite}).`
        : `Model's offensive-skill lean favors ${modelFavorite} (by ${modelMargin === null ? 'n/a' : modelMargin.toFixed(1)}), but the market's ${market.source} favors ${market.favorite} — worth a closer look, more so if that margin is wide than if it's thin.`,
  };
}

async function listEdges({ season, week, onlyDisagreements }) {
  const { rows: games } = await query(
    `SELECT game_id FROM games WHERE season = $1 AND week = $2 ORDER BY game_datetime ASC`,
    [season, week]
  );
  const results = [];
  for (const g of games) {
    const edge = await compareGameEdge(g.game_id);
    if (edge) results.push(edge);
  }
  return onlyDisagreements ? results.filter((r) => r.edge === true) : results;
}

module.exports = { compareGameEdge, listEdges, OFFENSE_SKILL_POSITIONS };
