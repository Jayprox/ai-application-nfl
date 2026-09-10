import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';

/**
 * Picks page — the first user-facing surface for Part 2's agent team.
 * =========================================================================
 * Everything the portfolio agent (POST /portfolio/slate) has logged to
 * picks_log, most recent first, plus its running hit-rate record. Both
 * already exist as backend routes (routes/picks.js) — this page is pure
 * wiring, no new API surface needed for v1.
 *
 * Scoped to agent_name=portfolio_agent_v1 for now since it's the only
 * real writer to picks_log today (scripts/seed-test-picks.js aside). If
 * a second agent starts logging picks, this hardcoded filter is the
 * first thing to revisit — either a picker dropdown or an unfiltered
 * "all agents" view grouped by agent_name.
 *
 * Full matchup context (away_team_abbr @ home_team_abbr) comes straight
 * off GET /picks now — routes/picks.js joins through games/teams for
 * both sides, not just the picked one, so MatchupLine below needs no
 * extra request.
 * =========================================================================
 */

const AGENT_NAME = 'portfolio_agent_v1';

const STATUS_STYLE = {
  pending: 'text-slate-600 bg-slate-100',
  correct: 'text-emerald-700 bg-emerald-50',
  incorrect: 'text-red-700 bg-red-50',
  push: 'text-amber-700 bg-amber-50',
  void: 'text-slate-500 bg-slate-100',
};

const STATUS_LABEL = {
  pending: 'Pending',
  correct: 'Correct',
  incorrect: 'Incorrect',
  push: 'Push',
  void: 'Void',
};

function StatusBadge({ status }) {
  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${STATUS_STYLE[status] ?? 'text-slate-600 bg-slate-100'}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-center">
      <div className="text-lg font-semibold text-slate-900">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

// "away @ home", with whichever side was actually picked bolded — a
// player_stat pick has no predicted_team_abbr, so neither side bolds,
// which is correct (that pick isn't about a side at all).
function MatchupLine({ pick }) {
  if (!pick.away_team_abbr || !pick.home_team_abbr) return null;
  const awayClass = pick.predicted_team_abbr === pick.away_team_abbr ? 'font-semibold text-slate-700' : '';
  const homeClass = pick.predicted_team_abbr === pick.home_team_abbr ? 'font-semibold text-slate-700' : '';
  return (
    <div className="text-xs text-slate-400">
      {pick.week ? `Week ${pick.week} · ` : ''}
      <span className={awayClass}>{pick.away_team_abbr}</span> @ <span className={homeClass}>{pick.home_team_abbr}</span>
    </div>
  );
}

// Renders what was actually picked, whichever of the two picks_log shapes
// this row is (see db/migrations/006_picks_log_game_lines.sql) — a
// game_line pick has predicted_team_abbr/market/units; a player_stat pick
// has player_name/stat_category/predicted_direction/predicted_line.
function pickSummary(pick) {
  if (pick.pick_type === 'game_line') {
    const marketLabel = pick.market === 'h2h' ? 'moneyline' : pick.market;
    return `${pick.predicted_team_abbr ?? '—'} (${marketLabel})${pick.units ? ` · ${pick.units}u` : ''}`;
  }
  const direction = pick.predicted_direction ? pick.predicted_direction.toUpperCase() : '';
  return `${pick.player_name ?? 'Unknown player'} — ${direction} ${pick.predicted_line ?? ''} ${pick.stat_category ?? ''}`.trim();
}

export default function PicksPage() {
  const stats = useApiFetch(`/picks/stats?agent_name=${AGENT_NAME}`);
  const picks = useApiFetch(`/picks?agent_name=${AGENT_NAME}`);

  const loading = stats.loading || picks.loading;
  const error = stats.error || picks.error;

  if (loading || error) {
    return (
      <AsyncState
        loading={loading}
        error={error}
        loadingLabel="Loading picks…"
        onRetry={() => {
          stats.refetch();
          picks.refetch();
        }}
      />
    );
  }

  const record = stats.data?.data;
  const rows = picks.data?.data ?? [];

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-900 mb-1">Picks</h1>
      <p className="text-sm text-slate-500 mb-4">Portfolio agent — every pick it's logged, and how it's graded out.</p>

      {record && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-6">
          <StatTile label="Record" value={`${record.correct}-${record.incorrect}${record.push ? `-${record.push}` : ''}`} />
          <StatTile label="Hit rate" value={record.hit_rate_pct !== null ? `${record.hit_rate_pct}%` : '—'} />
          <StatTile label="Pending" value={record.pending} />
          <StatTile label="Correct" value={record.correct} />
          <StatTile label="Incorrect" value={record.incorrect} />
          <StatTile label="Total" value={record.total} />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No picks logged yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((pick) => (
            <li key={pick.pick_id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <MatchupLine pick={pick} />
                  <div className="mt-0.5 font-medium text-slate-900 text-sm">{pickSummary(pick)}</div>
                  {pick.reasoning && <p className="mt-1 text-xs text-slate-500">{pick.reasoning}</p>}
                  <p className="mt-1 text-xs text-slate-400">
                    Logged {new Date(pick.created_at).toLocaleString()}
                    {pick.graded_at ? ` · Graded ${new Date(pick.graded_at).toLocaleString()}` : ''}
                  </p>
                </div>
                <StatusBadge status={pick.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
