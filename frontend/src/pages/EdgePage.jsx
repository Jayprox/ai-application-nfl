import { useMemo, useState } from 'react';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';

/**
 * Edge page — frontend surface for the edge agent (GET /edge,
 * backend/lib/edge.js). Part 2 Phase 2: "once odds data exists, compares
 * the model's implied read against the book's." Game-level only (spreads/
 * h2h), not player props — see lib/edge.js's header for the real data-gap
 * reason (NFL player-prop odds need a separate per-event API call The
 * Odds API charges extra quota for, deliberately not this phase).
 *
 * Same two-season convention as RankingsPage.jsx and the same reasoning:
 * both game_odds and matchup_scores are populated per-season by their own
 * sync/cron jobs, not backfilled historically, so seasons before last
 * year will structurally never have edges to show.
 *
 * A row's `edge` field means "the model and the market disagree" (true),
 * "they agree" (false), or "not enough signal on one/either side to say"
 * (null) — lib/edge.js is explicit that null covers both a genuine no-
 * signal case AND a "weak basis" case (only one side has any matchup-score
 * signal at all), so this page doesn't try to split those visually beyond
 * what the row's own `note` already says in plain language.
 *
 * home_team_id/away_team_id come back as raw team ids, not abbreviations
 * (compareGameEdge resolves them for the portfolio agent's own DB needs,
 * not for display) — GET /teams is fetched alongside to build the same
 * id -> abbreviation lookup PlayerBrowsePage already uses for its team
 * filter dropdown.
 */

const CURRENT_SEASON = 2026;
const LAST_SEASON = 2025;
const SEASONS = [CURRENT_SEASON, LAST_SEASON];

const selectClass =
  'rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900';

const EDGE_BADGE = {
  true: { label: 'Disagreement', className: 'text-amber-700 bg-amber-50' },
  false: { label: 'Agrees', className: 'text-emerald-700 bg-emerald-50' },
  null: { label: 'No signal', className: 'text-slate-500 bg-slate-100' },
};

function EdgeBadge({ edge }) {
  const badge = EDGE_BADGE[String(edge)];
  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

export default function EdgePage() {
  const [season, setSeason] = useState(LAST_SEASON);
  const [weekInput, setWeekInput] = useState('1');
  const [onlyDisagreements, setOnlyDisagreements] = useState(false);

  const week = weekInput.trim();

  const edgePath = useMemo(() => {
    if (!week) return null;
    const params = new URLSearchParams({ season: String(season), week });
    if (onlyDisagreements) params.set('only_disagreements', 'true');
    return `/edge?${params.toString()}`;
  }, [season, week, onlyDisagreements]);

  const { data, error, loading, refetch } = useApiFetch(edgePath);
  const { data: teamsData } = useApiFetch('/teams');

  const teamsById = useMemo(() => {
    const map = new Map();
    for (const t of teamsData?.data ?? []) map.set(t.team_id, t.abbreviation);
    return map;
  }, [teamsData]);

  const edges = data?.data ?? [];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Edge</h1>
      <p className="text-sm text-slate-500 mb-4">
        The edge agent's read on each game — which side the model's offensive-skill matchup scores lean toward,
        versus which side the sportsbook actually favors. A disagreement isn't a pick, just worth a second look.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
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
          placeholder="Week"
          value={weekInput}
          onChange={(e) => setWeekInput(e.target.value)}
          className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600 select-none">
          <input
            type="checkbox"
            checked={onlyDisagreements}
            onChange={(e) => setOnlyDisagreements(e.target.checked)}
            className="rounded border-slate-300 focus:ring-2 focus:ring-slate-900"
          />
          Only disagreements
        </label>
      </div>

      {!week ? (
        <p className="text-sm text-slate-500">Enter a week to see that week's games.</p>
      ) : loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading edges…" onRetry={refetch} />
      ) : edges.length === 0 ? (
        <p className="text-sm text-slate-500">
          {onlyDisagreements
            ? `No disagreements found for season ${season}, week ${week}.`
            : `No games found for season ${season}, week ${week}.`}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {edges.map((row) => {
              const awayAbbr = teamsById.get(row.away_team_id) ?? 'AWAY';
              const homeAbbr = teamsById.get(row.home_team_id) ?? 'HOME';
              const modelAbbr = row.model_favorite === 'home' ? homeAbbr : row.model_favorite === 'away' ? awayAbbr : null;
              const marketAbbr = row.market_favorite === 'home' ? homeAbbr : row.market_favorite === 'away' ? awayAbbr : null;
              return (
                <li key={row.game_id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium text-slate-900 text-sm">
                        {awayAbbr} @ {homeAbbr}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
                        <span>
                          Model: {modelAbbr ? <span className="font-medium text-slate-700">{modelAbbr}</span> : '—'}
                          {row.model_margin !== null && row.model_margin !== undefined
                            ? ` (by ${Number(row.model_margin).toFixed(1)})`
                            : ''}
                        </span>
                        <span>
                          Market: {marketAbbr ? <span className="font-medium text-slate-700">{marketAbbr}</span> : '—'}
                          {row.market_margin !== null && row.market_margin !== undefined
                            ? ` (${row.market_source}, ${Number(row.market_margin).toFixed(1)})`
                            : ''}
                        </span>
                      </div>
                      {row.note && <p className="mt-1 text-xs text-slate-400">{row.note}</p>}
                    </div>
                    <EdgeBadge edge={row.edge} />
                  </div>
                </li>
              );
            })}
          </ul>
          {data?.meta && <p className="mt-3 text-xs text-slate-400">{data.meta.count} game{data.meta.count === 1 ? '' : 's'}</p>}
        </>
      )}
    </div>
  );
}
