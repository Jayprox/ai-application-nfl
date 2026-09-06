/**
 * Chalk That NFL — ranking agent
 * =========================================================================
 * Part 2 Phase 2 (docs/part2-roadmap.md): "surfaces the top matchup scores
 * across upcoming games/props for a stat category. Can be pure
 * deterministic scoring (insight layer + blended score) with no LLM call —
 * the cheapest agent to ship first, and the one to validate the
 * calibration loop against before building anything fancier."
 *
 * This is deliberately NOT a new computation — it's a thin, deterministic
 * ranking view over the matchup_scores table backend/lib/matchup-score.js
 * already computes and caches once daily. "Agent" here means a small
 * reusable decision surface other things (the UI, a future edge/portfolio
 * agent, the conversational orchestrator per architecture.md §5) can call
 * — not an LLM call, same non-AI meaning the roadmap uses for the
 * calibration/tracking layer.
 *
 * A matchup_scores row is already scoped to exactly one stat category by
 * construction — insights.js's statConfigFor() picks a player's stat
 * purely from position (QB -> passing_yards, RB/FB/HB -> rushing_yards,
 * WR/TE -> receiving_yards, everyone else non-special-teams -> the
 * combined-tackles "tackles" category) before computePlayerInsights() is
 * ever called. So "rank by stat category" here just means filtering
 * matchup_scores by which position group produced that score. The
 * position lists are duplicated from insights.js rather than imported
 * (insights.js doesn't export them) but are intentionally kept identical
 * — see insights.js's own file header for the same list.
 * =========================================================================
 */

const { query } = require('../db');

const OFFENSE_SKILL_POSITIONS = {
  passing_yards: ['QB'],
  rushing_yards: ['RB', 'FB', 'HB'],
  receiving_yards: ['WR', 'TE'],
};
const SPECIAL_TEAMS_POSITIONS = ['K', 'P', 'LS', 'KR', 'PR'];
const ALL_OFFENSE_SKILL = Object.values(OFFENSE_SKILL_POSITIONS).flat();

const STAT_CATEGORIES = ['passing_yards', 'rushing_yards', 'receiving_yards', 'tackles'];

// tackles has no fixed list of defensive position codes to match against
// — same as insights.js's statConfigFor() fallback, it's "everyone who
// isn't an offense skill position and isn't special teams."
function positionFilterFor(statCategory) {
  if (statCategory === 'tackles') {
    return { sql: 'p.position != ALL($POS::text[])', positions: [...ALL_OFFENSE_SKILL, ...SPECIAL_TEAMS_POSITIONS] };
  }
  return { sql: 'p.position = ANY($POS::text[])', positions: OFFENSE_SKILL_POSITIONS[statCategory] };
}

async function rankMatchups({ statCategory, season, week, limit }) {
  const filter = positionFilterFor(statCategory);

  const params = [season, filter.positions];
  const positionSql = filter.sql.replace('$POS', '$2');
  let weekFilter = '';
  if (week !== undefined) {
    params.push(week);
    weekFilter = `AND g.week = $${params.length}`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await query(
    `SELECT ms.player_id, p.full_name AS player_name, p.position,
            ms.game_id, ms.score, ms.categories_used, ms.breakdown, ms.computed_at
     FROM matchup_scores ms
     JOIN players p ON p.player_id = ms.player_id
     JOIN games g ON g.game_id = ms.game_id
     WHERE ms.season = $1 AND ${positionSql} ${weekFilter}
     ORDER BY ms.score DESC
     LIMIT ${limitParam}`,
    params
  );

  return rows.map((row, i) => ({ rank: i + 1, ...row }));
}

module.exports = { rankMatchups, STAT_CATEGORIES };
