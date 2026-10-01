import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';

/**
 * Trends — frontend surface for the trend/streak agent (GET /trends,
 * backend/lib/trends.js + routes/trends.js). 2026-09-30 brainstorm
 * ("Trends, etc" -> "streaks/trends" round 1 item), built as its own
 * dedicated GET route rather than a /query scope -- same reasoning
 * Rankings and Props already established for being their own routes
 * (see backend/lib/trends.js's own header comment): this answers a
 * genuinely different question shape (a temporal walk over graded games)
 * than /query's leaderboard/per-entity scopes.
 *
 * "Streak" here means the same thing PropsPage already shows a user on
 * that page -- gradeGame() is a direct server-side port of PropsPage's
 * own gradeProp(), against the same locked-pregame DraftKings line
 * (player_prop_odds, synced_at <= kickoff) -- explicitly REAL market
 * lines, not a Chalk-That-invented threshold (per the brainstorm answer
 * that settled this). A streak of "3" means the real stat cleared (or
 * missed) the real DraftKings number 3 games in a row, most recent
 * first.
 *
 * SEASONS deliberately mirrors RankingsPage's own SEASONS (current +
 * last season only, not PlayerDetailPage's 6-year AVAILABLE_SEASONS) for
 * the same reason documented there: player_prop_odds is a live sync
 * table (routes/props.js's own header), not a historical backfill --
 * older seasons structurally have nothing to stream.
 *
 * Market tabs reuse PropsPage's own MARKET_TABS list/order. Direction
 * options depend on the market (over/under for yardage/reception
 * markets, scored/no_td for player_anytime_td, which has no line at
 * all) -- mirrors lib/trends.js's directionsFor() exactly so the
 * dropdown never offers a direction the backend would 400 on.
 */

const CURRENT_SEASON = 2026;
const LAST_SEASON = 2025;
const SEASONS = [CURRENT_SEASON, LAST_SEASON];

const MARKET_TABS = [
  { key: 'player_pass_yds', label: 'Pass Yds' },
  { key: 'player_rush_yds', label: 'Rush Yds' },
  { key: 'player_reception_yds', label: 'Rec Yds' },
  { key: 'player_receptions', label: 'Receptions' },
  { key: 'player_anytime_td', label: 'Anytime TD' },
];

const DIRECTIONS_FOR = {
  player_pass_yds: [
    { value: 'over', label: 'Over' },
    { value: 'under', label: 'Under' },
  ],
  player_rush_yds: [
    { value: 'over', label: 'Over' },
    { value: 'under', label: 'Under' },
  ],
  player_reception_yds: [
    { value: 'over', label: 'Over' },
    { value: 'under', label: 'Under' },
  ],
  player_receptions: [
    { value: 'over', label: 'Over' },
    { value: 'under', label: 'Under' },
  ],
  player_anytime_td: [
    { value: 'scored', label: 'Scored' },
    { value: 'no_td', label: 'No TD' },
  ],
};

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';

function formatSyncedAt(iso) {
  if (!iso) return 'not yet synced';
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return 'synced just now';
  if (diffMinutes < 60) return `synced ${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `synced ${diffHours}h ago`;
  return `synced ${Math.round(diffHours / 24)}d ago`;
}

export default function TrendsPage() {
  const [market, setMarket] = useState('player_pass_yds');
  const [direction, setDirection] = useState('over');
  const [season, setSeason] = useState(CURRENT_SEASON);

  // Switching to Anytime TD while "Under" is selected would send a
  // direction the backend 400s on (that market only knows scored/no_td)
  // -- reset to the new market's first valid direction whenever the
  // market changes, rather than let a stale value through.
  useEffect(() => {
    const valid = DIRECTIONS_FOR[market].map((d) => d.value);
    if (!valid.includes(direction)) {
      setDirection(valid[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only market should trigger this reset, not direction itself
  }, [market]);

  const path = useMemo(() => {
    const params = new URLSearchParams({ market, season: String(season), direction, limit: '15' });
    return `/trends?${params.toString()}`;
  }, [market, season, direction]);

  const { data, error, loading, refetch } = useApiFetch(path);
  const rows = data?.data ?? [];
  const meta = data?.meta;
  const isAnytimeTd = market === 'player_anytime_td';

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Trends</h1>
      <p className="text-sm text-ink-dim mb-4">
        Who's actually on a real streak against the real DraftKings line — not a Chalk That number, the same
        line and the same hit/miss rule shown on <Link to="/props" className="underline hover:no-underline">Props</Link>.
        No prediction here, just a count of consecutive real games.
      </p>

      <div className="flex flex-wrap gap-1 mb-3">
        {MARKET_TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setMarket(key)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              market === key ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2 bg-surface border border-line'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className={selectClass} aria-label="Direction">
          {DIRECTIONS_FOR[market].map(({ value, label }) => (
            <option key={value} value={value}>
              {label} streaks
            </option>
          ))}
        </select>
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className={selectClass} aria-label="Season">
          {SEASONS.map((yr) => (
            <option key={yr} value={yr}>
              {yr}
            </option>
          ))}
        </select>
      </div>

      {loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading trends…" onRetry={refetch} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No active streaks of 2+ games yet for {meta?.market_label ?? 'this market'} ({DIRECTIONS_FOR[market].find((d) => d.value === direction)?.label.toLowerCase()}) in {season}.
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
                  <th className="py-2 pr-4">Team</th>
                  <th className="py-2 pr-4">Streak</th>
                  <th className="py-2 pr-4">Through</th>
                  {!isAnytimeTd && <th className="py-2 pr-4">Last Line</th>}
                  {!isAnytimeTd && <th className="py-2 pr-4">Last Result</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.player_id} className="border-b border-line last:border-0">
                    <td className="py-3 pl-4 pr-4 font-semibold text-ink-faint">{row.rank}</td>
                    <td className="py-3 pr-4">
                      <Link to={`/players/${row.player_id}`} className="font-medium text-ink hover:underline">
                        {row.full_name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-ink-dim">{row.position}</td>
                    <td className="py-3 pr-4 text-ink-dim">{row.team}</td>
                    <td className="py-3 pr-4 font-medium text-ink">{row.streak} straight</td>
                    <td className="py-3 pr-4 text-ink-dim">Wk {row.through_week}</td>
                    {!isAnytimeTd && (
                      <td className="py-3 pr-4 text-ink-dim">{row.last_line != null ? row.last_line : '—'}</td>
                    )}
                    {!isAnytimeTd && (
                      <td className="py-3 pr-4 text-ink-dim">{row.last_value != null ? row.last_value : '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 space-y-1 text-xs text-ink-faint">
            <p>{formatSyncedAt(meta?.freshness?.synced_at)}</p>
          </div>
        </>
      )}
    </div>
  );
}
