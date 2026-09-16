import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch } from '../hooks/useApiFetch';
import { useStatsQuery } from '../hooks/useStatsQuery';
import AsyncState from '../components/AsyncState';
import InjuryBadge from '../components/InjuryBadge';
import EmptyStatsMessage from '../components/EmptyStatsMessage';
import PlayerInsights from '../components/PlayerInsights';
import { STAT_COLUMNS_BY_POSITION_GROUP } from '../constants/statColumns';
import { GAME_SLOT_OPTIONS, WEATHER_OPTIONS } from '../constants/splits';

// Phase 4 screen 5 (the app's main screen) / Phase 5 Features 3-5 — scope
// tabs (season/last5/career/game log), situational split filters
// (home/away, time slot, weather), and the injury badge, all wired to
// real data (POST /query and GET /players/:id's current_injury).
// PlayerInsights (Part 2's insight layer, GET /insights/players/:id)
// added below the header — see that component for why it's decoupled
// from this page's own season/scope selectors.

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';

const SCOPES = [
  { value: 'season', label: 'Season Avg' },
  { value: 'last5', label: 'Last 5 Games' },
  { value: 'career', label: 'Career' },
  { value: 'game_log', label: 'Game Log' },
];

// The 5 completed seasons the historical backfill loaded (2021-2025)
// plus the 2026 schedule. AVAILABLE_SEASONS[0] used to double as
// DEFAULT_SEASON's justification for being 2025 instead of 2026: at
// build time 2026 had no stats yet since the season hadn't started (see
// docs/vibe-coding-checklist.md Phase 5). That's stale now that games
// are being played — every other page's season selector (EdgePage,
// GamesPage, PortfolioPage, RankingsPage) already defaults to the
// current season, and this page should match rather than open on a
// year-old default while PlayerInsights.jsx's matchup box right above
// it is already reading live 2026 data. Deriving DEFAULT_SEASON from
// AVAILABLE_SEASONS[0] instead of a second hardcoded literal means this
// can't drift out of sync with it again next season.
const AVAILABLE_SEASONS = [2026, 2025, 2024, 2023, 2022, 2021];
const DEFAULT_SEASON = AVAILABLE_SEASONS[0];

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
  const [homeAway, setHomeAway] = useState('');
  const [gameSlot, setGameSlot] = useState('');
  const [weatherCondition, setWeatherCondition] = useState('');

  const {
    data: playerData,
    error: playerError,
    loading: playerLoading,
    refetch: refetchPlayer,
  } = useApiFetch(`/players/${playerId}`);
  const player = playerData?.data;

  const hasActiveSplit = !!(homeAway || gameSlot || weatherCondition);
  const clearSplits = () => {
    setHomeAway('');
    setGameSlot('');
    setWeatherCondition('');
  };

  const queryBody = useMemo(() => {
    if (!player) return null;
    const body = { entity_type: 'player', entity_id: playerId, scope };
    if (scope !== 'career') body.season = season;
    if (hasActiveSplit) {
      body.splits = {
        ...(homeAway && { home_away: homeAway }),
        ...(gameSlot && { game_slot: gameSlot }),
        ...(weatherCondition && { weather_condition: weatherCondition }),
      };
    }
    return body;
  }, [player, playerId, scope, season, homeAway, gameSlot, weatherCondition, hasActiveSplit]);

  const { data: statsData, error: statsError, loading: statsLoading, refetch: refetchStats } =
    useStatsQuery(queryBody);

  if (playerLoading || playerError) {
    return (
      <AsyncState loading={playerLoading} error={playerError} loadingLabel="Loading player…" onRetry={refetchPlayer} />
    );
  }
  if (!player) return <p className="text-sm text-ink-dim">Player not found.</p>;

  const columns = STAT_COLUMNS_BY_POSITION_GROUP[player.position_group] ?? [];

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <Link
          to={player.team_id ? `/teams/${player.team_id}` : '/players'}
          className="text-sm text-ink-dim hover:text-ink"
        >
          &larr; Back to {player.team_id ? player.team_name : 'Players'}
        </Link>
        <InjuryBadge injury={player.current_injury} />
      </div>

      <div className="mt-2 mb-6">
        <h1 className="font-display text-3xl font-semibold uppercase tracking-wide text-ink">{player.full_name}</h1>
        <p className="text-sm text-ink-dim">
          {player.position} {player.team_name ? `· ${player.team_name}` : '· Free agent'}
        </p>
      </div>

      <PlayerInsights playerId={playerId} />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-md border border-line bg-surface p-0.5">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setScope(s.value)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                scope === s.value ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
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
            className="rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {AVAILABLE_SEASONS.map((yr) => (
              <option key={yr} value={yr}>
                {yr} season
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={homeAway} onChange={(e) => setHomeAway(e.target.value)} className={selectClass}>
          <option value="">Home/Away: All</option>
          <option value="home">Home only</option>
          <option value="away">Away only</option>
        </select>
        <select value={gameSlot} onChange={(e) => setGameSlot(e.target.value)} className={selectClass}>
          <option value="">Time Slot: All</option>
          {GAME_SLOT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          value={weatherCondition}
          onChange={(e) => setWeatherCondition(e.target.value)}
          className={selectClass}
        >
          <option value="">Weather: All</option>
          {WEATHER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {hasActiveSplit && (
          <button
            type="button"
            onClick={clearSplits}
            className="text-sm text-ink-dim underline hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      {statsLoading || statsError ? (
        <AsyncState loading={statsLoading} error={statsError} loadingLabel="Loading stats…" onRetry={refetchStats} />
      ) : !statsData?.meta?.sample_size ? (
        <EmptyStatsMessage
          scope={scope}
          season={season}
          hasActiveSplit={hasActiveSplit}
          playerName={player.full_name}
        />
      ) : scope === 'game_log' ? (
        <GameLogTable rows={statsData.data} columns={columns} />
      ) : (
        <StatGrid stats={statsData.data} columns={columns} />
      )}

      {statsData?.meta && (
        <p className="mt-4 text-xs text-ink-faint">
          {statsData.meta.sample_size} game{statsData.meta.sample_size === 1 ? '' : 's'} &middot;{' '}
          {formatSyncedAt(statsData.meta.freshness?.synced_at)}
        </p>
      )}
    </div>
  );
}

function StatGrid({ stats, columns }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
      {columns.map(({ key, label }) => {
        const value = stats?.[key];
        return (
          <div key={key} className="flex items-baseline justify-between bg-surface px-4 py-3">
            <dt className="text-sm text-ink-dim">{label}</dt>
            <dd className="text-sm font-semibold text-ink">
              {value === null || value === undefined
                ? '—'
                : Number.isInteger(Number(value))
                  ? Number(value)
                  : Number(value).toFixed(1)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function GameLogTable({ rows, columns }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
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
            <tr key={row.game_id} className="border-b border-line last:border-0">
              <td className="py-2 pl-4 pr-4 text-ink-dim">{row.week}</td>
              <td className="py-2 pr-4 text-ink-dim">
                {row.game_datetime ? new Date(row.game_datetime).toLocaleDateString() : '—'}
              </td>
              <td className="py-2 pr-4 text-ink">
                {row.is_home ? 'vs' : '@'} {opponentAbbr(row.game_id, row.is_home) ?? '?'}
              </td>
              {columns.map((c) => (
                <td key={c.key} className="py-2 pr-4 text-ink">
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
