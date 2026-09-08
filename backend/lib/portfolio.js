/**
 * Chalk That NFL — portfolio agent (v1)
 * =========================================================================
 * Part 2 Phase 2 (docs/part2-roadmap.md): "given a goal and a unit size,
 * builds a slate from the strongest edges with reasoning — a distinct
 * concern from 'which picks are good' (this is 'how many, at what
 * size')." Suggested build order: calibration -> ranking -> edge ->
 * portfolio -> chat/orchestrator. This is that fourth piece.
 *
 * Deliberately thin: it does no scoring of its own. It calls the edge
 * agent's listEdges({onlyDisagreements: true}) (backend/lib/edge.js),
 * sorts by model_margin (how wide the model/market disagreement is —
 * the only ranking signal that actually exists today), and takes the top
 * maxPicks. "How many, at what size" is answered by three confirmed
 * decisions:
 *   - Sizing is flat units per pick (1 unit each), not proportional to
 *     model_margin or any confidence score — there's no calibrated
 *     confidence number to size against yet (same "don't fake a number"
 *     reasoning edge.js's own header follows), so scaling stake by an
 *     uncalibrated margin would be pretending to a precision that
 *     doesn't exist. Revisit once grade_picks has enough graded
 *     game_line picks to know whether model_margin actually predicts
 *     anything.
 *   - Every slate pick is logged to picks_log (006_picks_log_game_lines
 *     .sql's game_line shape) under agent_name 'portfolio_agent_v1', so
 *     the same grade_picks job (worker/ingestion-worker.js) that already
 *     grades player_stat picks now grades these too — one calibration
 *     loop, not two.
 *   - Only h2h/spreads-sourced edges are ever produced here (the edge
 *     agent's marketFavorite() never returns a 'totals' source — see
 *     edge.js), so every pick this agent writes takes the game_line
 *     h2h/spreads shape (predicted_team_id set, no predicted_line). The
 *     'totals' shape 006_picks_log_game_lines.sql's CHECK constraint
 *     supports is here for a future totals-aware agent, not this one.
 *
 * Dedup: re-running buildSlate for a week that's already been logged
 * (e.g. a cron re-fire, or a manual re-call before kickoff) should not
 * pile up duplicate picks on the same game under this agent while the
 * original is still pending — see alreadyLoggedGameIds().
 * =========================================================================
 */

const { query } = require('../db');
const { listEdges, latestOdds } = require('./edge');

const AGENT_NAME = 'portfolio_agent_v1';
const DEFAULT_UNITS = 1;
const DEFAULT_MAX_PICKS = 5;
const MAX_MAX_PICKS = 20;

// Games this agent has already logged a *pending* pick for. A graded
// (correct/incorrect/push/void) game is fair game to log again if it
// somehow reappears in listEdges (it won't in practice — a final game's
// edge is stale — but a pending one re-appearing on a re-run is the real
// case this guards against, e.g. calling /portfolio/slate twice before
// kickoff for the same week).
async function alreadyLoggedGameIds(gameIds) {
  if (!gameIds.length) return new Set();
  const { rows } = await query(
    `SELECT DISTINCT game_id FROM picks_log
     WHERE agent_name = $1 AND status = 'pending' AND game_id = ANY($2::varchar[])`,
    [AGENT_NAME, gameIds]
  );
  return new Set(rows.map((r) => r.game_id));
}

// Renders the actual line/price for the picked side, so reasoning says
// something concrete ("home -3.5") rather than just the margin's
// magnitude compareGameEdge already exposes. Best-effort — a missing or
// unrecognized odds shape just omits this clause rather than failing the
// whole pick.
function describeLine(oddsRow, market, favoriteSide) {
  if (!oddsRow) return null;
  if (market === 'spreads') {
    const point = favoriteSide === 'home' ? oddsRow.home_point : oddsRow.away_point;
    return point == null ? null : `${favoriteSide} ${Number(point) > 0 ? '+' : ''}${point}`;
  }
  if (market === 'h2h') {
    const price = favoriteSide === 'home' ? oddsRow.home_price : oddsRow.away_price;
    return price == null ? null : `${favoriteSide} ${Number(price) > 0 ? '+' : ''}${price}`;
  }
  return null;
}

async function buildSlate({ season, week, maxPicks = DEFAULT_MAX_PICKS, unitSize = DEFAULT_UNITS, dryRun = false }) {
  const cappedMaxPicks = Math.min(MAX_MAX_PICKS, Math.max(1, Number(maxPicks) || DEFAULT_MAX_PICKS));

  // onlyUpcoming: true — see edge.js's listEdges() comment. Without this,
  // a re-run partway through a week could log a pick against a game
  // that's already final, using stale pregame odds, which grade_picks
  // would then grade with zero real lead time.
  const edges = await listEdges({ season, week, onlyDisagreements: true, onlyUpcoming: true });

  // model_margin can be null (only one side had any matchup-score signal
  // at all — see edge.js) — treat that as the weakest possible signal
  // rather than letting `null` sort unpredictably against numbers.
  const ranked = [...edges].sort((a, b) => (b.model_margin ?? -1) - (a.model_margin ?? -1));
  const candidates = ranked.slice(0, cappedMaxPicks);

  const alreadyLogged = await alreadyLoggedGameIds(candidates.map((e) => e.game_id));

  const slate = [];
  const skipped = [];
  for (const edge of candidates) {
    if (alreadyLogged.has(edge.game_id)) {
      skipped.push({ game_id: edge.game_id, reason: 'already has a pending portfolio_agent_v1 pick for this game' });
      continue;
    }

    const predictedTeamId = edge.model_favorite === 'home' ? edge.home_team_id : edge.away_team_id;
    const oddsRow = await latestOdds(edge.game_id, edge.market_source);
    const lineText = describeLine(oddsRow, edge.market_source, edge.model_favorite);

    const reasoning =
      `${edge.note} Sizing: flat ${unitSize} unit(s) per pick (Part 2 Phase 2 bet-sizing decision — ` +
      `no calibrated confidence score to scale against yet).` +
      (lineText ? ` Market line at pick time: ${lineText}.` : '');

    slate.push({
      agent_name: AGENT_NAME,
      pick_type: 'game_line',
      game_id: edge.game_id,
      market: edge.market_source,
      predicted_team_id: predictedTeamId,
      units: unitSize,
      reasoning,
      model_margin: edge.model_margin,
      model_favorite: edge.model_favorite,
      market_favorite: edge.market_favorite,
    });
  }

  let inserted = [];
  if (!dryRun && slate.length) {
    inserted = await Promise.all(
      slate.map((pick) =>
        query(
          `INSERT INTO picks_log (agent_name, pick_type, game_id, market, predicted_team_id, units, reasoning, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING pick_id, game_id, market, predicted_team_id, units, created_at`,
          [pick.agent_name, pick.pick_type, pick.game_id, pick.market, pick.predicted_team_id, pick.units, pick.reasoning]
        ).then((r) => r.rows[0])
      )
    );
  }

  return {
    season,
    week,
    dry_run: dryRun,
    unit_size: unitSize,
    considered: edges.length,
    picked: slate.length,
    skipped,
    slate: dryRun ? slate : slate.map((pick, i) => ({ ...pick, pick_id: inserted[i]?.pick_id ?? null })),
  };
}

module.exports = { buildSlate, AGENT_NAME };
