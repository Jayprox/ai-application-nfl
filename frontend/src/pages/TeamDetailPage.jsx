import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { apiFetch, AuthError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';
import { ROSTER_POSITION_ORDER, ROSTER_POSITION_LABEL, rosterBucketFor } from '../constants/rosterPositions';

// Phase 4 screen 3 / Phase 5 Feature 1 — wired to real data via
// GET /teams/:id (team + current roster).
//
// Roster is active (status='ACT') + injured reserve (status='RES') as of
// 2026-09-15 (backend/routes/teams.js) -- an IR badge below flags which
// rows are the latter, since the other roster_status codes (CUT/DEV/
// RET/EXE) never reach this page at all.
//
// Grouped by specific position (QB/RB/WR/TE/OL, DL/LB/CB/S, K/P/LS —
// constants/rosterPositions.js), depth-chart-style, rather than the
// coarse offense/defense/special_teams split — same day, same reasoning
// as the IR badge above (this is what "organize it like ESPN" meant
// given this app has no separate starter/2nd/3rd/4th depth-chart-rank
// data to actually reproduce ESPN's own 4-column layout).

export default function TeamDetailPage() {
  const { teamId } = useParams();
  const { data, error, loading, refetch } = useApiFetch(`/teams/${teamId}`);

  const { logout } = useAuth();
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null); // { kind: 'success' | 'error', text }

  const resyncRoster = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      // League-wide, not team-scoped — sync_roster pulls nflverse's whole
      // roster feed in one pass (worker/ingestion-worker.js), so this
      // button refreshes every team, not just the one you're looking at.
      await apiFetch('/admin/sync-roster', { method: 'POST' });
      setSyncMessage({ kind: 'success', text: 'Roster data refreshed.' });
      refetch();
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      setSyncMessage({ kind: 'error', text: err.message || 'Resync failed.' });
    } finally {
      setSyncing(false);
    }
  };

  if (loading || error) {
    return <AsyncState loading={loading} error={error} loadingLabel="Loading team…" onRetry={refetch} />;
  }

  const team = data?.data;
  if (!team) {
    return <p className="text-sm text-ink-dim">Team not found.</p>;
  }

  const rosterByPosition = (team.roster ?? []).reduce((acc, player) => {
    const bucket = rosterBucketFor(player.position);
    (acc[bucket] ??= []).push(player);
    return acc;
  }, {});

  // Known buckets render in ROSTER_POSITION_ORDER; anything left over is a
  // raw position code this list hasn't seen before — append it rather
  // than drop it, alphabetically so the order stays deterministic.
  const leftoverBuckets = Object.keys(rosterByPosition)
    .filter((bucket) => !ROSTER_POSITION_ORDER.includes(bucket))
    .sort();
  const orderedBuckets = [...ROSTER_POSITION_ORDER, ...leftoverBuckets];

  return (
    <div>
      <Link to="/teams" className="text-sm text-ink-dim hover:text-ink">
        &larr; Back to Teams
      </Link>

      <div className="mt-2 mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold uppercase tracking-wide text-ink">{team.name}</h1>
          <p className="text-sm text-ink-dim">
            {team.conference} {team.division} &middot; {team.stadium_name}, {team.city}, {team.state}
            {team.roof && team.roof !== 'outdoors' ? ` (${team.roof})` : ''}
            {team.surface ? ` · ${team.surface}` : ''}
          </p>
        </div>
        <span className="text-2xl font-bold text-ink-faint">{team.abbreviation}</span>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={resyncRoster}
          disabled={syncing}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-dim hover:text-ink hover:border-accent/60 transition-colors disabled:opacity-60"
        >
          {syncing ? 'Resyncing…' : 'Resync rosters'}
        </button>
        {syncMessage && (
          <span className={`text-xs ${syncMessage.kind === 'error' ? 'text-negative' : 'text-positive'}`}>
            {syncMessage.text}
          </span>
        )}
      </div>

      {Object.keys(rosterByPosition).length === 0 ? (
        <p className="text-sm text-ink-dim">No roster on file for this team.</p>
      ) : (
        <div className="space-y-6">
          {orderedBuckets.map((bucket) =>
            rosterByPosition[bucket] ? (
              <div key={bucket}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
                  {ROSTER_POSITION_LABEL[bucket] ?? bucket} ({rosterByPosition[bucket].length})
                </h2>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {rosterByPosition[bucket].map((player) => (
                    <li key={player.player_id}>
                      <Link
                        to={`/players/${player.player_id}`}
                        className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-accent/60 transition-colors"
                      >
                        <span className="text-ink">{player.full_name}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-ink-faint">{player.position}</span>
                          {player.status === 'RES' && (
                            <span className="text-xs font-medium rounded px-1.5 py-0.5 text-caution bg-caution/12">
                              IR
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}
