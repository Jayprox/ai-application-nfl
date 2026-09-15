import { Link, useParams } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';
import { POSITION_GROUP_ORDER, POSITION_GROUP_LABEL } from '../constants/positionGroups';

// Phase 4 screen 3 / Phase 5 Feature 1 — wired to real data via
// GET /teams/:id (team + current roster).
//
// Roster is active (status='ACT') + injured reserve (status='RES') as of
// 2026-09-15 (backend/routes/teams.js) -- an IR badge below flags which
// rows are the latter, since the other roster_status codes (CUT/DEV/
// RET/EXE) never reach this page at all.

export default function TeamDetailPage() {
  const { teamId } = useParams();
  const { data, error, loading, refetch } = useApiFetch(`/teams/${teamId}`);

  if (loading || error) {
    return <AsyncState loading={loading} error={error} loadingLabel="Loading team…" onRetry={refetch} />;
  }

  const team = data?.data;
  if (!team) {
    return <p className="text-sm text-ink-dim">Team not found.</p>;
  }

  const rosterByGroup = (team.roster ?? []).reduce((acc, player) => {
    (acc[player.position_group] ??= []).push(player);
    return acc;
  }, {});

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

      {Object.keys(rosterByGroup).length === 0 ? (
        <p className="text-sm text-ink-dim">No roster on file for this team.</p>
      ) : (
        <div className="space-y-6">
          {POSITION_GROUP_ORDER.map((group) =>
            rosterByGroup[group] ? (
              <div key={group}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
                  {POSITION_GROUP_LABEL[group]} ({rosterByGroup[group].length})
                </h2>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {rosterByGroup[group].map((player) => (
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
