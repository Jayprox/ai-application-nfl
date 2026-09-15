import { Link } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';

// Phase 4 screen 2 / Phase 5 Feature 1 — wired to real data via GET /teams.
const DIVISION_ORDER = [
  'AFC East', 'AFC North', 'AFC South', 'AFC West',
  'NFC East', 'NFC North', 'NFC South', 'NFC West',
];

export default function TeamBrowsePage() {
  const { data, error, loading, refetch } = useApiFetch('/teams');

  if (loading || error) {
    return <AsyncState loading={loading} error={error} loadingLabel="Loading teams…" onRetry={refetch} />;
  }

  const teams = data?.data ?? [];
  const byDivision = teams.reduce((acc, team) => {
    const key = `${team.conference} ${team.division}`;
    (acc[key] ??= []).push(team);
    return acc;
  }, {});

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-4">Teams</h1>

      {teams.length === 0 ? (
        <p className="text-sm text-ink-dim">No teams found.</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {DIVISION_ORDER.filter((division) => byDivision[division]?.length).map((division) => (
            <div key={division}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">
                {division}
              </h2>
              <ul className="space-y-1.5">
                {byDivision[division].map((team) => (
                  <li key={team.team_id}>
                    <Link
                      to={`/teams/${team.team_id}`}
                      className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-sm hover:border-accent/60 hover:shadow-sm transition-all"
                    >
                      <span>
                        <span className="font-medium text-ink">{team.name}</span>
                        <span className="ml-2 text-ink-faint">{team.city}</span>
                      </span>
                      <span className="text-xs font-semibold text-ink-faint">{team.abbreviation}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
