import { Link, useParams } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';

// Phase 4 screen 3 / Phase 5 Feature 1 — wired to real data via
// GET /teams/:id (team + current roster).

const POSITION_GROUP_LABEL = {
  offense: 'Offense',
  defense: 'Defense',
  special_teams: 'Special Teams',
};

const STATUS_STYLE = {
  active: 'text-emerald-700 bg-emerald-50',
  injured_reserve: 'text-amber-700 bg-amber-50',
  practice_squad: 'text-slate-500 bg-slate-100',
  free_agent: 'text-slate-500 bg-slate-100',
  retired: 'text-slate-400 bg-slate-100',
};

export default function TeamDetailPage() {
  const { teamId } = useParams();
  const { data, error, loading, refetch } = useApiFetch(`/teams/${teamId}`);

  if (loading || error) {
    return <AsyncState loading={loading} error={error} loadingLabel="Loading team…" onRetry={refetch} />;
  }

  const team = data?.data;
  if (!team) {
    return <p className="text-sm text-slate-500">Team not found.</p>;
  }

  const rosterByGroup = (team.roster ?? []).reduce((acc, player) => {
    (acc[player.position_group] ??= []).push(player);
    return acc;
  }, {});

  return (
    <div>
      <Link to="/teams" className="text-sm text-slate-500 hover:text-slate-900">
        &larr; Back to Teams
      </Link>

      <div className="mt-2 mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{team.name}</h1>
          <p className="text-sm text-slate-500">
            {team.conference} {team.division} &middot; {team.stadium_name}, {team.city}, {team.state}
            {team.roof && team.roof !== 'outdoors' ? ` (${team.roof})` : ''}
            {team.surface ? ` · ${team.surface}` : ''}
          </p>
        </div>
        <span className="text-2xl font-bold text-slate-300">{team.abbreviation}</span>
      </div>

      {Object.keys(rosterByGroup).length === 0 ? (
        <p className="text-sm text-slate-500">No roster on file for this team.</p>
      ) : (
        <div className="space-y-6">
          {['offense', 'defense', 'special_teams'].map((group) =>
            rosterByGroup[group] ? (
              <div key={group}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  {POSITION_GROUP_LABEL[group]} ({rosterByGroup[group].length})
                </h2>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {rosterByGroup[group].map((player) => (
                    <li key={player.player_id}>
                      <Link
                        to={`/players/${player.player_id}`}
                        className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-400 transition-colors"
                      >
                        <span className="text-slate-900">{player.full_name}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">{player.position}</span>
                          {player.status !== 'active' && (
                            <span
                              className={`text-xs font-medium rounded px-1.5 py-0.5 ${
                                STATUS_STYLE[player.status] ?? 'text-slate-500 bg-slate-100'
                              }`}
                            >
                              {player.status.replace('_', ' ')}
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
