import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';
import { POSITION_GROUP_LABEL } from '../constants/positionGroups';
import { statusBadgeClass, statusLabel } from '../constants/playerStatus';

// Phase 4 screen 4 / Phase 5 Feature 2 — wired to real data via GET
// /players?name=&team=&position_group=.

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';

export default function PlayerBrowsePage() {
  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [team, setTeam] = useState('');
  const [positionGroup, setPositionGroup] = useState('');

  // Debounce the free-text name field so we're not firing a request on
  // every keystroke — team/position filters apply immediately since
  // they're discrete choices, not typed input.
  useEffect(() => {
    const timer = setTimeout(() => setName(nameInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [nameInput]);

  const playersPath = useMemo(() => {
    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (team) params.set('team', team);
    if (positionGroup) params.set('position_group', positionGroup);
    const qs = params.toString();
    return `/players${qs ? `?${qs}` : ''}`;
  }, [name, team, positionGroup]);

  const { data, error, loading, refetch } = useApiFetch(playersPath);
  // Reused just to populate the team filter dropdown with real
  // abbreviations/names — same endpoint Team browse already uses.
  const { data: teamsData } = useApiFetch('/teams');

  const players = data?.data ?? [];
  const atLimit = data?.meta && players.length === data.meta.limit;
  const teams = teamsData?.data ?? [];

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-4">Players</h1>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="text"
          placeholder="Search by name…"
          aria-label="Search players by name"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          className="flex-1 min-w-[180px] rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <select value={team} onChange={(e) => setTeam(e.target.value)} className={selectClass}>
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t.team_id} value={t.abbreviation}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={positionGroup}
          onChange={(e) => setPositionGroup(e.target.value)}
          className={selectClass}
        >
          <option value="">All positions</option>
          {Object.entries(POSITION_GROUP_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading players…" onRetry={refetch} />
      ) : players.length === 0 ? (
        <p className="text-sm text-ink-dim">No players match this search.</p>
      ) : (
        <>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {players.map((player) => (
              <li key={player.player_id}>
                <Link
                  to={`/players/${player.player_id}`}
                  className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-sm hover:border-accent/60 hover:shadow-sm transition-all"
                >
                  <span className="text-ink">{player.full_name}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-ink-faint">
                      {player.position}
                      {player.team_abbreviation ? ` · ${player.team_abbreviation}` : ''}
                    </span>
                    {player.status !== 'active' && (
                      <span
                        className={`text-xs font-medium rounded px-1.5 py-0.5 ${statusBadgeClass(
                          player.status
                        )}`}
                      >
                        {statusLabel(player.status)}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {atLimit && (
            <p className="mt-3 text-xs text-ink-faint">
              Showing the first {data.meta.limit} results — narrow your search to see more specific matches.
            </p>
          )}
        </>
      )}
    </div>
  );
}
