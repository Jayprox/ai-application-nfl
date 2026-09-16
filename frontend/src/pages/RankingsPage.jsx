import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import { useCurrentWeek } from '../hooks/useCurrentWeek';
import AsyncState from '../components/AsyncState';

/**
 * Rankings page — frontend surface for the ranking agent (GET /rankings,
 * backend/lib/ranking.js). Part 2 Phase 2 called this "the cheapest agent
 * to ship first": a deterministic top-N view over matchup_scores (the
 * blended 0-100 score backend/lib/matchup-score.js computes once daily)
 * filtered to one stat category at a time. No LLM call, no new backend
 * work needed for this page — routes/rankings.js already exists and has
 * had zero frontend consumers until now.
 *
 * stat_category maps to a position filter server-side (QB -> passing_yards,
 * RB/FB/HB -> rushing_yards, WR/TE -> receiving_yards, everyone else
 * non-special-teams -> tackles) — see lib/ranking.js's header for why.
 * season is required by the route; week is optional (blank means
 * whole-season top N). Used to default blank/hardcoded-season on load,
 * documented here as waiting on a reusable "current NFL week" helper —
 * that helper now exists (GET /games/current-week, backend/lib/
 * current-week.js, added 2026-09-14 alongside BoardPage.jsx), so this
 * page seeds season/week from it via useCurrentWeek instead. Clearing
 * the week field still falls back to the original whole-season view —
 * this only changes what the page opens showing, not what's available.
 *
 * SEASONS is deliberately just the two most recent years, not the same
 * 6-year AVAILABLE_SEASONS list PlayerDetailPage uses for real historical
 * game stats. matchup_scores isn't a historical table at all — it's a
 * forward-looking cache scripts/compute-matchup-scores.js recomputes for
 * one season at a time (worker/ingestion-worker.js's currentNflSeason()
 * logic), so anything older than "last season" will structurally never
 * have rows, unlike *_game_stats which genuinely does hold multi-year
 * history. Confirmed empty as of 2026-09-10 for 2024/2023/2022/2021 —
 * only LAST_SEASON currently has data, since this season's cron hasn't
 * populated CURRENT_SEASON yet. Once it does, both options here will
 * have real rows; if CURRENT_SEASON stays empty for a while after this
 * season's games start, that's the next thing worth checking (is the
 * cron running?), not a frontend bug.
 */

const CURRENT_SEASON = 2026;
const LAST_SEASON = 2025;
const SEASONS = [CURRENT_SEASON, LAST_SEASON];

const STAT_CATEGORY_LABEL = {
  passing_yards: 'Passing yards',
  rushing_yards: 'Rushing yards',
  receiving_yards: 'Receiving yards',
  tackles: 'Tackles',
};

// Short unit suffix for the season-avg column — reuses the same stat
// vocabulary as STAT_CATEGORY_LABEL rather than a second copy of the
// position->stat mapping (see backend/lib/ranking.js's header for why
// stat_category already implies exactly one column of matchup_scores).
const STAT_CATEGORY_UNIT = {
  passing_yards: 'pass yds/gm',
  rushing_yards: 'rush yds/gm',
  receiving_yards: 'rec yds/gm',
  tackles: 'tkl/gm',
};

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';

// Same "how stale is this cached table" formatting PlayerDetailPage uses
// for /query's freshness.synced_at — matchup_scores is on the same
// "computed once daily by a cron job" footing.
function formatSyncedAt(iso) {
  if (!iso) return 'not yet computed';
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return 'computed just now';
  if (diffMinutes < 60) return `computed ${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `computed ${diffHours}h ago`;
  return `computed ${Math.round(diffHours / 24)}d ago`;
}

// categories_used (0-4) is how many of the ranking's 4 trend categories
// (matchup/recent_form/situational/role_trend, see backend/lib/matchup-score.js)
// actually had a real read for this player rather than label: null. A high
// score built on only 1-2 real categories is much less meaningful than one
// built on all 4 — this badge makes that visible instead of letting every
// score look equally authoritative.
function signalBadgeClass(categoriesUsed) {
  const base = 'inline-block rounded-full px-2 py-0.5 text-xs font-medium';
  if (categoriesUsed >= 3) return `${base} bg-positive/12 text-positive`;
  if (categoriesUsed === 2) return `${base} bg-caution/12 text-caution`;
  return `${base} bg-negative/12 text-negative`;
}

export default function RankingsPage() {
  const [statCategory, setStatCategory] = useState('passing_yards');
  const [season, setSeason] = useState(CURRENT_SEASON);
  const [weekInput, setWeekInput] = useState('');

  useCurrentWeek((current) => {
    setSeason(current.season);
    setWeekInput(String(current.week));
  });

  const rankingsPath = useMemo(() => {
    const params = new URLSearchParams({ stat_category: statCategory, season: String(season) });
    const week = weekInput.trim();
    if (week) params.set('week', week);
    return `/rankings?${params.toString()}`;
  }, [statCategory, season, weekInput]);

  const { data, error, loading, refetch } = useApiFetch(rankingsPath);
  const rankings = data?.data ?? [];

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Rankings</h1>
      <p className="text-sm text-ink-dim mb-4">
        Top matchup scores for one stat category — the ranking agent's read on which players have the most
        favorable spot this week, purely from matchup/form/situational/role-trend signal, no market data involved.
        This is a trend score, not a production ranking, and it only surfaces players on an active roster with
        at least 2 of the 4 trend categories carrying a real read — check the Signal badge for exactly how many
        before treating a high score as "this player will put up big numbers."
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={statCategory} onChange={(e) => setStatCategory(e.target.value)} className={selectClass}>
          {Object.entries(STAT_CATEGORY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className={selectClass}>
          {SEASONS.map((yr) => (
            <option key={yr} value={yr}>
              {yr}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="1"
          max="22"
          placeholder="All weeks"
          aria-label="Week number (optional)"
          value={weekInput}
          onChange={(e) => setWeekInput(e.target.value)}
          className="w-28 rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading rankings…" onRetry={refetch} />
      ) : rankings.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No matchup scores yet for {STAT_CATEGORY_LABEL[statCategory].toLowerCase()} in {season}
          {weekInput ? `, week ${weekInput}` : ''}.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pl-4 pr-4">#</th>
                  <th className="py-2 pr-4">Player</th>
                  <th className="py-2 pr-4">Pos</th>
                  <th className="py-2 pr-4">Score</th>
                  <th className="py-2 pr-4">Signal</th>
                  <th className="py-2 pr-4">Season avg</th>
                </tr>
              </thead>
              <tbody>
                {rankings.map((row) => (
                  <tr key={`${row.player_id}-${row.game_id}`} className="border-b border-line last:border-0">
                    <td className="py-3 pl-4 pr-4 font-semibold text-ink-faint">{row.rank}</td>
                    <td className="py-3 pr-4">
                      <Link to={`/players/${row.player_id}`} className="font-medium text-ink hover:underline">
                        {row.player_name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-ink-dim">{row.position}</td>
                    <td className="py-3 pr-4 font-medium text-ink">{Number(row.score).toFixed(1)}</td>
                    <td className="py-3 pr-4">
                      <span
                        className={signalBadgeClass(row.categories_used)}
                        title={`${row.categories_used} of 4 trend categories had a real read for this player`}
                      >
                        {row.categories_used}/4
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-ink-dim">
                      {row.season_avg != null
                        ? `${Number(row.season_avg).toFixed(1)} ${STAT_CATEGORY_UNIT[statCategory]}${row.games_played != null ? ` (${row.games_played} gm)` : ''}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.meta && (
            <p className="mt-3 text-xs text-ink-faint">
              {data.meta.count} player{data.meta.count === 1 ? '' : 's'} &middot;{' '}
              {formatSyncedAt(data.meta.freshness?.synced_at)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
