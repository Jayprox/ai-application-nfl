import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';

/**
 * Leaderboard page — ranks every agent logging picks to picks_log by hit
 * rate. See backend/routes/leaderboard.js for why this is agent-ranked
 * rather than PNL-ranked (picks_log doesn't store a price to compute a
 * payout against) and why a single row today is the honest result, not a
 * bug — portfolio_agent_v1 is the only agent writing picks so far.
 */

function formatRecord(agent) {
  const parts = [agent.correct, agent.incorrect];
  if (agent.push) parts.push(agent.push);
  return parts.join('-');
}

export default function LeaderboardPage() {
  const { data, error, loading, refetch } = useApiFetch('/leaderboard');

  if (loading || error) {
    return <AsyncState loading={loading} error={error} loadingLabel="Loading leaderboard…" onRetry={refetch} />;
  }

  const agents = data?.data ?? [];

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Leaderboard</h1>
      <p className="text-sm text-ink-dim mb-4">
        Every agent logging picks, ranked by hit rate. More rows appear as more agents start picking.
      </p>

      {agents.length === 0 ? (
        <p className="text-sm text-ink-dim">No picks logged by any agent yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-2 pl-4 pr-4">#</th>
                <th className="py-2 pr-4">Agent</th>
                <th className="py-2 pr-4">Record</th>
                <th className="py-2 pr-4">Hit Rate</th>
                <th className="py-2 pr-4">Pending</th>
                <th className="py-2 pr-4">Total</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.agent_name} className="border-b border-line last:border-0">
                  <td className="py-3 pl-4 pr-4 font-semibold text-ink-faint">{agent.rank}</td>
                  <td className="py-3 pr-4 font-medium text-ink">{agent.agent_name}</td>
                  <td className="py-3 pr-4 text-ink">{formatRecord(agent)}</td>
                  <td className="py-3 pr-4 text-ink">
                    {agent.hit_rate_pct !== null ? `${agent.hit_rate_pct}%` : '—'}
                  </td>
                  <td className="py-3 pr-4 text-ink-dim">{agent.pending}</td>
                  <td className="py-3 pr-4 text-ink-dim">{agent.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
