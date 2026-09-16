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
 *
 * Tiebreak fix (2026-09-16): early in a season (or for any thin-signal
 * category) it's normal for most rows to land on the same score —
 * matchup-score.js's blend falls back toward a flat default when a
 * player has little real matchup/form/situational/role-trend read yet
 * (see this table's own categories_used column). `ORDER BY ms.score DESC`
 * alone leaves every one of those ties in whatever order Postgres
 * happens to return them, which is not guaranteed stable across two
 * queries that differ only in LIMIT — confirmed live: BoardPage.jsx's
 * `limit=5` widget and RankingsPage.jsx's full (unlimited) table, same
 * season/week/stat_category otherwise, came back with almost entirely
 * different top players. Now breaks ties by categories_used DESC first
 * (a score backed by more real signal outranks an equal score that's
 * mostly default filler — the same trust signal the page's own Signal
 * badge already surfaces to the user), then player_id for full
 * determinism so any remaining tie is at least stable across requests
 * rather than arbitrary.
 *
 * Relevance filter (2026-09-16): two more usefulness bugs surfaced next
 * to each other in the same live list —
 *   1. A signal floor. categories_used in {0,1} means the blend is
 *      almost entirely BASELINE (50) filler, not a real read — that's
 *      exactly the "player who hasn't played yet" case (thin/no
 *      matchup, form, situational, or role-trend data), and it was
 *      still competing for the top spots on a flat/near-flat score.
 *      MIN_CATEGORIES_USED excludes those rows outright rather than
 *      just badging them (RankingsPage.jsx's Signal chip) and hoping
 *      the user notices before trusting the rank.
 *   2. A live roster check, done at READ time rather than trusting
 *      compute time. This table intentionally never deletes old rows
 *      (see 005_matchup_scores.sql's design note — old scores stay
 *      queryable for calibration), and matchup-score.js's own eligible-
 *      players filter (status = 'ACT' AND current_team_id IS NOT NULL)
 *      only governs what gets WRITTEN on a given day. Confirmed live: a
 *      players row can transiently pick up a stale 'ACT' status and a
 *      years-old current_team_id from backfill-historical.js's
 *      "backfill missing players from historical rosters" step (Step 0,
 *      inserts using that HISTORICAL season's own roster status/team
 *      verbatim — real for the season it's from, stale the moment
 *      sync_roster's next run hasn't yet corrected it back to 'CUT').
 *      If the daily matchup-scores-cron happens to run inside that
 *      window, the resulting row is permanent — re-checking status/team
 *      here means a player who has since been correctly marked 'CUT'
 *      (Nick Foles being the case that surfaced this: retired years ago,
 *      still had a live-season matchup_scores row) drops out of the
 *      list the moment the roster sync catches up, without needing any
 *      backfill or cleanup of the historical matchup_scores rows
 *      themselves.
 * =========================================================================
 */

// See "Relevance filter" above — a score built on 0-1 of the 4 trend
// categories is mostly BASELINE filler, not a real signal.
const MIN_CATEGORIES_USED = 2;

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
  params.push(MIN_CATEGORIES_USED);
  const minCategoriesParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await query(
    `SELECT ms.player_id, p.full_name AS player_name, p.position,
            ms.game_id, ms.score, ms.categories_used, ms.breakdown, ms.computed_at,
            ms.games_played, ms.season_avg
     FROM matchup_scores ms
     JOIN players p ON p.player_id = ms.player_id
     JOIN games g ON g.game_id = ms.game_id
     WHERE ms.season = $1 AND ${positionSql} ${weekFilter}
       AND ms.categories_used >= ${minCategoriesParam}
       AND p.status = 'ACT' AND p.current_team_id IS NOT NULL
     ORDER BY ms.score DESC, ms.categories_used DESC, ms.player_id ASC
     LIMIT ${limitParam}`,
    params
  );

  return rows.map((row, i) => ({ rank: i + 1, ...row }));
}

module.exports = { rankMatchups, STAT_CATEGORIES };
