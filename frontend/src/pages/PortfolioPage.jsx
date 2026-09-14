import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, AuthError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useApiFetch } from '../hooks/useApiFetch';
import { useCurrentWeek } from '../hooks/useCurrentWeek';

/**
 * Portfolio page — frontend surface for the portfolio/bankroll agent
 * (POST /portfolio/slate, backend/lib/portfolio.js). Part 2 Phase 3's
 * first incremental addition: the agent itself has been built and
 * deployed since Part 2 Phase 2, but had zero frontend surface — the
 * only way to run it was a direct API call. This page is that surface.
 *
 * Deliberately mirrors the route's own "safe preview by default" design:
 * `dry_run=true` builds and returns the slate WITHOUT writing to
 * picks_log, `dry_run=false` does the real thing. Two buttons, not a
 * checkbox + one button — "Preview" vs "Build & log" reads as two
 * distinct actions rather than one action with a toggle easy to miss.
 * Built picks show up under agent_name 'portfolio_agent_v1' on the
 * existing Picks tab, same as any other agent's picks — this page is
 * only for triggering the agent, not a second system of record for
 * viewing picks over time.
 *
 * Every slate pick is by construction a model/market disagreement
 * (buildSlate always calls listEdges with onlyDisagreements: true), so
 * unlike EdgePage there's no "agrees / no signal" case to badge — every
 * card here already IS a disagreement, sorted by how wide model_margin
 * is. home_team_id/away_team_id ride along on each slate entry purely
 * for the "AWAY @ HOME" display (see lib/portfolio.js's own comment on
 * why that doesn't change what's written to picks_log).
 *
 * Season/week seed from GET /games/current-week on load (useCurrentWeek,
 * added 2026-09-14 alongside BoardPage.jsx) instead of a hardcoded
 * "week 1" — same convention as GamesPage.jsx/EdgePage.jsx now use.
 */

const CURRENT_SEASON = 2026;
const LAST_SEASON = 2025;
const SEASONS = [CURRENT_SEASON, LAST_SEASON];

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';
const numberInputClass =
  'w-28 rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent';

export default function PortfolioPage() {
  const [season, setSeason] = useState(CURRENT_SEASON);
  const [weekInput, setWeekInput] = useState('');
  const [maxPicksInput, setMaxPicksInput] = useState('5');
  const [unitSizeInput, setUnitSizeInput] = useState('1');

  useCurrentWeek((current) => {
    setSeason(current.season);
    setWeekInput(String(current.week));
  });

  const [result, setResult] = useState(null);
  const [mode, setMode] = useState(null); // 'preview' | 'build' — which action produced `result`
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { logout } = useAuth();
  const navigate = useNavigate();

  const { data: teamsData } = useApiFetch('/teams');
  const teamsById = useMemo(() => {
    const map = new Map();
    for (const t of teamsData?.data ?? []) map.set(t.team_id, t.abbreviation);
    return map;
  }, [teamsData]);

  const week = weekInput.trim();

  const run = async (dryRun) => {
    if (!week || loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ season: String(season), week, dry_run: String(dryRun) });
      if (maxPicksInput.trim()) params.set('max_picks', maxPicksInput.trim());
      if (unitSizeInput.trim()) params.set('unit_size', unitSizeInput.trim());

      const res = await apiFetch(`/portfolio/slate?${params.toString()}`, { method: 'POST' });
      setResult(res.data);
      setMode(dryRun ? 'preview' : 'build');
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink mb-1">Portfolio</h1>
      <p className="text-sm text-ink-dim mb-4">
        Builds a slate of game-line picks from the edge agent's strongest disagreements, sized flat by unit — a
        distinct concern from "which picks are good" (that's Edge). Preview costs nothing and logs nothing; Build
        &amp; log actually writes the picks (visible on the Picks tab, graded like any other agent's picks).
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
          className="w-24 rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <input
          type="number"
          min="1"
          max="20"
          placeholder="Max picks"
          value={maxPicksInput}
          onChange={(e) => setMaxPicksInput(e.target.value)}
          className={numberInputClass}
        />
        <input
          type="number"
          min="0.01"
          step="0.5"
          placeholder="Unit size"
          value={unitSizeInput}
          onChange={(e) => setUnitSizeInput(e.target.value)}
          className={numberInputClass}
        />
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          onClick={() => run(true)}
          disabled={!week || loading}
          className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-40"
        >
          Preview slate
        </button>
        <button
          type="button"
          onClick={() => run(false)}
          disabled={!week || loading}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-40"
        >
          Build &amp; log slate
        </button>
      </div>

      {!week && <p className="text-sm text-ink-dim">Enter a week to build a slate for it.</p>}
      {loading && <p className="text-sm text-ink-faint">{mode === 'build' ? 'Building…' : 'Previewing…'}</p>}
      {error && <p className="text-sm text-negative">{error}</p>}

      {result && !loading && (
        <>
          <p className="text-sm text-ink-dim mb-3">
            {mode === 'build' ? 'Logged' : 'Would log'} {result.picked} pick{result.picked === 1 ? '' : 's'} from{' '}
            {result.considered} disagreement{result.considered === 1 ? '' : 's'} considered, at {result.unit_size}{' '}
            unit{Number(result.unit_size) === 1 ? '' : 's'} each.
            {mode === 'build' && result.picked > 0 && ' See the Picks tab to track how they grade out.'}
          </p>

          {result.slate.length === 0 ? (
            <p className="text-sm text-ink-dim">No picks — no disagreements met the bar for this week.</p>
          ) : (
            <ul className="space-y-2">
              {result.slate.map((pick) => {
                const awayAbbr = teamsById.get(pick.away_team_id) ?? 'AWAY';
                const homeAbbr = teamsById.get(pick.home_team_id) ?? 'HOME';
                const pickedAbbr =
                  pick.predicted_team_id === pick.home_team_id
                    ? homeAbbr
                    : pick.predicted_team_id === pick.away_team_id
                      ? awayAbbr
                      : null;
                return (
                  <li key={pick.pick_id ?? pick.game_id} className="rounded-md border border-line bg-surface px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-ink text-sm">
                          {awayAbbr} @ {homeAbbr}
                        </div>
                        <div className="mt-1 text-xs text-ink-dim">
                          Pick: <span className="font-medium text-ink">{pickedAbbr ?? '—'}</span> ·{' '}
                          {pick.units} unit{Number(pick.units) === 1 ? '' : 's'} · {pick.market}
                        </div>
                        {pick.reasoning && <p className="mt-1 text-xs text-ink-faint">{pick.reasoning}</p>}
                      </div>
                      <span className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-accent bg-accent/12">
                        {pick.model_margin !== null && pick.model_margin !== undefined
                          ? `by ${Number(pick.model_margin).toFixed(1)}`
                          : 'no margin'}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {result.skipped?.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-ink-dim mb-1">
                Skipped ({result.skipped.length})
              </p>
              <ul className="space-y-1">
                {result.skipped.map((s, i) => (
                  <li key={i} className="text-xs text-ink-faint">
                    {s.game_id}: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
