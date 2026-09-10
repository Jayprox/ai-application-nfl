import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
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
 * season is required by the route; week is optional and left blank by
 * default (whole-season top N) rather than defaulted to "current week",
 * since there's no existing frontend helper for "current NFL week" to
 * reuse (worker/ingestion-worker.js's currentNflSeason() only resolves
 * the season) — that's the first thing to add if a real "this week's
 * board" view is wanted later.
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

const selectClass =
  'rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900';

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

export default function RankingsPage() {
  const [statCategory, setStatCategory] = useState('passing_yards');
  const [season, setSeason] = useState(LAST_SEASON);
  const [weekInput, setWeekInput] = useState('');

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
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Rankings</h1>
      <p className="text-sm text-slate-500 mb-4">
        Top matchup scores for one stat category — the ranking agent's read on which players have the most
        favorable spot this week, purely from matchup/form/situational/role-trend signal, no market data involved.
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
          value={weekInput}
          onChange={(e) => setWeekInput(e.target.value)}
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </div>

      {loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading rankings…" onRetry={refetch} />
      ) : rankings.length === 0 ? (
        <p className="text-sm text-slate-500">
          No matchup scores yet for {STAT_CATEGORY_LABEL[statCategory].toLowerCase()} in {season}
          {weekInput ? `, week ${weekInput}` : ''}.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pl-4 pr-4">#</th>
                  <th className="py-2 pr-4">Player</th>
                  <th className="py-2 pr-4">Pos</th>
                  <th className="py-2 pr-4">Score</th>
                </tr>
              </thead>
              <tbody>
                {rankings.map((row) => (
                  <tr key={`${row.player_id}-${row.game_id}`} className="border-b border-slate-100 last:border-0">
                    <td className="py-3 pl-4 pr-4 font-semibold text-slate-400">{row.rank}</td>
                    <td className="py-3 pr-4">
                      <Link to={`/players/${row.player_id}`} className="font-medium text-slate-900 hover:underline">
                        {row.player_name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-slate-500">{row.position}</td>
                    <td className="py-3 pr-4 font-medium text-slate-900">{Number(row.score).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.meta && (
            <p className="mt-3 text-xs text-slate-400">
              {data.meta.count} player{data.meta.count === 1 ? '' : 's'} &middot;{' '}
              {formatSyncedAt(data.meta.freshness?.synced_at)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
