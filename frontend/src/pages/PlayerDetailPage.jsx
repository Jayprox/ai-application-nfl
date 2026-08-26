import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import { useStatsQuery } from '../hooks/useStatsQuery';
import AsyncState from '../components/AsyncState';
import { STAT_COLUMNS_BY_POSITION_GROUP } from '../constants/statColumns';

// Phase 4 screen 5 (the app's main screen) / Phase 5 Feature 3 — scope
// tabs (season/last5/career/game log) wired to POST /query. Split filters
// (Feature 4) and the injury badge (Feature 5) are deliberately not here
// yet — kept as their own checklist items.

const SCOPES = [
  { value: 'season', label: 'Season Avg' },
  { value: 'last5', label: 'Last 5 Games' },
  { value: 'career', label: 'Career' },
  { value: 'game_log', label: 'Game Log' },
];

// Matches the 5 completed seasons the historical backfill loaded
// (2021-2025) plus the 2026 schedule, which has no stats until the
// season is actually played — see docs/vibe-coding-checklist.md Phase 5.
const AVAILABLE_SEASONS = [2026, 2025, 2024, 2023, 2022, 2021];
const DEFAULT_SEASON = 2025;

function formatSyncedAt(iso) {
  if (!iso) return 'not yet synced';
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return 'synced just now';
  if (diffMinutes < 60) return `synced ${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `synced ${diffHours}h ago`;
  return `synced ${Math.round(diffHours / 24)}d ago`;
}

// game_id is SEASON_WEEK_AWAY_HOME (e.g. "2021_01_CHI_LA" — see
// scripts/backfill-historical.js), so the opponent's abbreviation can be
// read straight off the id without a second request.
function opponentAbbr(gameId, isHome) {
  const parts = gameId.split('_');
  if (parts.length < 4) return null;
  const [, , away, home] = parts;
  return isHome ? away : home;
}

export default function PlayerDetailPage() {
  const { playerId } = useParams();
  const [scope, setScope] = useState('season');
  const [season, setSeason] = useState(DEFAULT_SEASON);

  const {
    data: playerData,
    error: playerError,
    loading: playerLoading,
    refetch: refetchPlayer,
  } = useApiFetch(`/players/${playerId}`);
  const player = playerData?.data;

  const queryBody = useMemo(() => {
    if (!player) return null;
    const body = { entity_type: 'player', entity_id: playerId, scope };
    if (scope !== 'career') body.season = season;
    return body;
  }, [player, playerId, scope, season]);

  const { data: statsData, error: statsError, loading: statsLoading, refetch: refetchStats } =
    useStatsQuery(queryBody);

  if (playerLoading || playerError) {
    return (
      <AsyncState loading={playerLoading} error={playerError} loadingLabel="Loading player…" onRetry={refetchPlayer} />
    );
  }
  if (!player) return <p className="text-sm text-slate-500">Player not found.</p>;

  const columns = STAT_COLUMNS_BY_POSITION_GROUP[player.position_group] ?? [];

  return (
    <div>
      <Link
        to={player.team_id ? `/teams/${player.team_id}` : '/players'}
        className="text-sm text-slate-500 hover:text-slate-900"
      >
        &larr; Back to {player.team_id ? player.team_name : 'Players'}
      </Link>

      <div className="mt-2 mb-6">
        <h1 className="text-xl font-semibold text-slate-900">{player.full_name}</h1>
        <p className="text-sm text-slate-500">
          {player.position} {player.team_name ? `· ${player.team_name}` : '· Free agent'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-md border border-slate-200 bg-white p-0.5">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setScope(s.value)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                scope === s.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {scope !== 'career' && (
          <select
            value={season}
            onChange={(e) => setSeason(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {AVAILABLE_SEASONS.map((yr) => (
              <option key={yr} value={yr}>
                {yr} season
              </option>
            ))}
          </select>
        )}
      </div>

      {statsLoading || statsError ? (
        <AsyncState loading={statsLoading} error={statsError} loadingLabel="Loading stats…" onRetry={refetchStats} />
      ) : scope === 'game_log' ? (
        <GameLogTable rows={statsData?.data ?? []} columns={columns} />
      ) : (
        <StatGrid stats={statsData?.data} columns={columns} sampleSize={statsData?.meta?.sample_size} />
      )}

      {statsData?.meta && (
        <p className="mt-4 text-xs text-slate-400">
          {statsData.meta.sample_size} game{statsData.meta.sample_size === 1 ? '' : 's'} &middot;{' '}
          {formatSyncedAt(statsData.meta.freshness?.synced_at)}
        </p>
      )}
    </div>
  );
}

function StatGrid({ stats, columns, sampleSize }) {
  if (!sampleSize) {
    return <p className="text-sm text-slate-500">No games match this selection yet.</p>;
  }
  return (
    <dl className="grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2">
      {columns.map(({ key, label }) => {
        const value = stats?.[key];
        return (
          <div key={key} className="flex items-baseline justify-between bg-white px-4 py-3">
            <dt className="text-sm text-slate-600">{label}</dt>
            <dd className="text-sm font-semibold text-slate-900">
              {value === null || value === undefined ? '—' : Number(value).toFixed(1)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function GameLogTable({ rows, columns }) {
  if (!rows.length) {
    return <p className="text-sm text-slate-500">No games match this selection yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-2 pl-4 pr-4">Week</th>
            <th className="py-2 pr-4">Date</th>
            <th className="py-2 pr-4">Opp</th>
            {columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap py-2 pr-4">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.game_id} className="border-b border-slate-100 last:border-0">
              <td className="py-2 pl-4 pr-4 text-slate-500">{row.week}</td>
              <td className="py-2 pr-4 text-slate-500">
                {row.game_datetime ? new Date(row.game_datetime).toLocaleDateString() : '—'}
              </td>
              <td className="py-2 pr-4 text-slate-900">
                {row.is_home ? 'vs' : '@'} {opponentAbbr(row.game_id, row.is_home) ?? '?'}
              </td>
              {columns.map((c) => (
                <td key={c.key} className="py-2 pr-4 text-slate-900">
                  {row[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
