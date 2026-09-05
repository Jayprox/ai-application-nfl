/**
 * Chalk That NFL — blended matchup score (Part 2 Phase 2, "3 paths" discussion)
 * =========================================================================
 * A single 0-100ish number per player's next upcoming matchup, blending
 * the four categories backend/lib/insights.js already computes (matchup,
 * recent_form, situational, role_trend) into one score — same idea as the
 * MLB sister app's `matchupScore` (chalk-that-mlb-research-notes.md §2):
 * "a single blended signal ... computed once server-side and reused
 * across every screen that needs 'how good is this matchup,' rather than
 * each screen recomputing its own version." Both the future ranking agent
 * (surfaces top scores) and edge agent (compares this to the market's
 * implied probability via /odds) key off this table rather than either
 * agent re-deriving its own blend.
 *
 * Deliberately built ON TOP of computePlayerInsights() rather than as a
 * parallel computation — insights.js is already shipped and verified
 * against real 2025 data, and its four labels are exactly the controlled
 * vocabulary this blend consumes. No changes to insights.js were needed.
 *
 * Computed once daily (see scripts/compute-matchup-scores.js, run as its
 * own small Railway cron service rather than inside
 * worker/ingestion-worker.js — the worker is deliberately self-contained
 * with zero backend/ dependencies, and this blend needs
 * backend/lib/insights.js directly), not per-request — same "shared
 * daily snapshot" pattern MLB's own matchupScore uses.
 *
 * Weighting: matchup and recent_form are the strongest signals (directly
 * about the immediate opponent and current performance), situational and
 * role_trend are supporting signals (a split or volume shift, not the
 * matchup itself) — so they're weighted 15/15/10/10 around a 50 baseline.
 * That total possible swing (+-50) keeps the score naturally in [0,100]
 * without needing to clamp in the common case; clamping is still applied
 * as a defensive floor/ceiling. A category with label: null (not enough
 * data, no next game, special-teams position) contributes 0 points and is
 * excluded from categoriesUsed — same "don't fake a reading" philosophy
 * insights.js itself follows for label: null.
 * =========================================================================
 */

const { query } = require('../db');
const { computePlayerInsights } = require('./insights');

const CATEGORY_WEIGHTS = {
  matchup: { weight: 15, positive: 'FAVORABLE_MATCHUP', negative: 'TOUGH_MATCHUP' },
  recent_form: { weight: 15, positive: 'HOT', negative: 'COLD' },
  situational: { weight: 10, positive: 'STRONG', negative: 'WEAK' },
  role_trend: { weight: 10, positive: 'INCREASING', negative: 'DECREASING' },
};
const BASELINE = 50;

// Pure function — takes the `insights` array computePlayerInsights()
// already returns. No DB access, so it's testable against a plain list
// of {category, label} objects with no Postgres mock required at all.
// Returns null (not a fake neutral 50) when every category is label:null
// — no signal at all means no score, matching insights.js's own honesty
// convention.
function blendScore(insights) {
  let raw = BASELINE;
  let categoriesUsed = 0;
  const breakdown = [];

  for (const entry of insights) {
    const config = CATEGORY_WEIGHTS[entry.category];
    let points = 0;
    if (config && entry.label === config.positive) points = config.weight;
    else if (config && entry.label === config.negative) points = -config.weight;
    // Any other label (a neutral bucket like NEUTRAL_MATCHUP/NEUTRAL/
    // STEADY, or an unrecognized category) contributes 0 points.
    if (entry.label !== null && entry.label !== undefined) categoriesUsed++;
    raw += points;
    breakdown.push({ category: entry.category, label: entry.label, points, note: entry.note });
  }

  if (categoriesUsed === 0) return null;

  const score = Math.max(0, Math.min(100, raw));
  return { score, categoriesUsed, breakdown };
}

async function getNextGameForTeam(teamId) {
  const { rows } = await query(
    `SELECT game_id FROM games
     WHERE (home_team_id = $1 OR away_team_id = $1) AND status = 'scheduled'
     ORDER BY game_datetime ASC LIMIT 1`,
    [teamId]
  );
  return rows[0]?.game_id || null;
}

const SPECIAL_TEAMS_POSITIONS = ['K', 'P', 'LS', 'KR', 'PR'];

// Only players whose team actually has an upcoming scheduled game are
// candidates — keeps this cheap (skips the whole league during bye
// weeks/offseason) and matches the "daily snapshot for UPCOMING
// matchups" scope. computePlayerInsights() would return all-null for
// anyone else anyway, so this is a performance filter, not a
// correctness one.
async function getEligiblePlayers() {
  const { rows } = await query(
    `SELECT p.player_id, p.current_team_id
     FROM players p
     WHERE p.status = 'active'
       AND p.current_team_id IS NOT NULL
       AND p.position != ALL($1::text[])
       AND EXISTS (
         SELECT 1 FROM games g
         WHERE (g.home_team_id = p.current_team_id OR g.away_team_id = p.current_team_id)
           AND g.status = 'scheduled'
       )`,
    [SPECIAL_TEAMS_POSITIONS]
  );
  return rows;
}

async function computeAndStoreMatchupScores(season) {
  const players = await getEligiblePlayers();
  let written = 0;
  let skipped = 0;

  for (const player of players) {
    const gameId = await getNextGameForTeam(player.current_team_id);
    if (!gameId) { skipped++; continue; } // defensive — shouldn't happen given the EXISTS filter above

    const result = await computePlayerInsights(player.player_id, season);
    const blended = result ? blendScore(result.insights) : null;
    if (!blended) { skipped++; continue; }

    await query(
      `INSERT INTO matchup_scores (player_id, game_id, season, score, categories_used, breakdown, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (player_id, game_id) DO UPDATE SET
         score = EXCLUDED.score, categories_used = EXCLUDED.categories_used,
         breakdown = EXCLUDED.breakdown, computed_at = now()`,
      [player.player_id, gameId, season, blended.score, blended.categoriesUsed, JSON.stringify(blended.breakdown)]
    );
    written++;
  }

  return { written, skipped, eligible: players.length };
}

module.exports = { blendScore, computeAndStoreMatchupScores, CATEGORY_WEIGHTS, BASELINE };
