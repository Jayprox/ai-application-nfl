import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryPost } from '../hooks/useQueryPost';
import { useCurrentWeek } from '../hooks/useCurrentWeek';
import AsyncState from '../components/AsyncState';

/**
 * League Leaderboard — plain real season numbers, sorted and capped, no
 * scoring model. Same idea as Chalk That NBA's Leaders page, adapted to
 * football: pick a stat/season/game type, see the top N. Deliberately
 * kept distinct from Rankings (a deterministic *model* read over
 * matchup_scores) -- this page never touches that table.
 *
 * Served by the shared query engine (POST /query, scope: "leaderboard",
 * backend/lib/stats-query.js's queryLeaderboard()) rather than a one-off
 * route, so the same numbers are reachable by web, iOS, and any future
 * agent tool. Uses useQueryPost instead of useApiFetch because /query
 * takes a JSON body, not a GET path -- see that hook's header for why.
 *
 * Same 6-season window PlayerDetailPage's own historical view uses
 * (AVAILABLE_SEASONS there) -- this table only has real data for
 * completed/in-progress seasons anyway, and reusing that list keeps the
 * "which seasons have real data" answer in one place conceptually even
 * though it's duplicated here (PlayerDetailPage doesn't export it).
 */
const AVAILABLE_SEASONS = [2026, 2025, 2024, 2023, 2022, 2021];
const DEFAULT_SEASON = AVAILABLE_SEASONS[0];

const GAME_TYPES = [
  { value: 'regular', label: 'Regular season' },
  { value: 'postseason', label: 'Postseason' },
];

// Grouped the same way the original request asked for the page to be
// organized (passing / rushing / receiving), as <optgroup>s in one
// dropdown rather than a separate category selector -- one fewer control
// for what's still just picking one stat.
const STAT_GROUPS = [
  {
    label: 'Passing',
    stats: [
      ['pass_yards', 'Passing Yards'],
      ['pass_tds', 'Passing TDs'],
      ['pass_ints', 'Interceptions Thrown'],
      ['pass_rating', 'Passer Rating'],
    ],
  },
  {
    label: 'Rushing',
    stats: [
      ['rush_yards', 'Rushing Yards'],
      ['rush_tds', 'Rushing TDs'],
      ['rush_ypc', 'Yards Per Carry'],
    ],
  },
  {
    label: 'Receiving',
    stats: [
      ['receptions', 'Receptions'],
      ['rec_yards', 'Receiving Yards'],
      ['rec_tds', 'Receiving TDs'],
    ],
  },
];

const STAT_LABEL = Object.fromEntries(STAT_GROUPS.flatMap((g) => g.stats));

// Rate stats (already a per-attempt/per-carry number) have no meaningful
// "per game" reading -- the per-game toggle only applies to counting
// stats, so it's hidden rather than shown-and-ignored for these.
const RATE_STATS = new Set(['pass_rating', 'rush_ypc']);

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';

function formatSyncedAt(iso) {
  if (!iso) return 'not yet computed';
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return 'synced just now';
  if (diffMinutes < 60) return `synced ${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `synced ${diffHours}h ago`;
  return `synced ${Math.round(diffHours / 24)}d ago`;
}

export default function LeadersPage() {
  const [stat, setStat] = useState('pass_yards');
  const [season, setSeason] = useState(DEFAULT_SEASON);
  const [gameType, setGameType] = useState('regular');
  const [perGame, setPerGame] = useState(false);

  useCurrentWeek((current) => {
    setSeason(current.season);
  });

  const isRate = RATE_STATS.has(stat);

  const body = useMemo(
    () => ({
      scope: 'leaderboard',
      stat,
      season,
      game_type: gameType,
      per_game: isRate ? false : perGame,
      limit: 10,
    }),
    [stat, season, gameType, perGame, isRate]
  );

  const { data, error, loading, refetch } = useQueryPost(body);
  const rows = data?.data ?? [];
  const meta = data?.meta;
  const qualifier = meta?.qualifier;
  const unit = isRate ? '' : perGame ? '/gm' : '';

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">League Leaders</h1>
      <p className="text-sm text-ink-dim mb-4">
        Real season numbers, sorted and capped at the top 10 — no scoring, no model. That's what separates this
        from the model-based <Link to="/rankings" className="underline hover:no-underline">Rankings</Link> page.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={stat} onChange={(e) => setStat(e.target.value)} className={selectClass} aria-label="Stat">
          {STAT_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.stats.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className={selectClass} aria-label="Season">
          {AVAILABLE_SEASONS.map((yr) => (
            <option key={yr} value={yr}>
              {yr}
            </option>
          ))}
        </select>
        <select value={gameType} onChange={(e) => setGameType(e.target.value)} className={selectClass} aria-label="Season type">
          {GAME_TYPES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {!isRate && (
          <label className="flex items-center gap-2 text-sm text-ink-dim px-1">
            <input type="checkbox" checked={perGame} onChange={(e) => setPerGame(e.target.checked)} className="rounded border-line" />
            Per game
          </label>
        )}
      </div>

      {loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading leaders…" onRetry={refetch} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No qualifying players yet for {STAT_LABEL[stat].toLowerCase()} in the {season} {gameType === 'postseason' ? 'postseason' : 'regular season'}.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pl-4 pr-4">#</th>
                  <th className="py-2 pr-4">Player</th>
                  <th className="py-2 pr-4">Team</th>
                  <th className="py-2 pr-4">GP</th>
                  <th className="py-2 pr-4">{STAT_LABEL[stat]}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.player_id} className="border-b border-line last:border-0">
                    <td className="py-3 pl-4 pr-4 font-semibold text-ink-faint">{row.rank}</td>
                    <td className="py-3 pr-4">
                      <Link to={`/players/${row.player_id}`} className="font-medium text-ink hover:underline">
                        {row.full_name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 text-ink-dim">{row.team}</td>
                    <td className="py-3 pr-4 text-ink-dim">{row.gp}</td>
                    <td className="py-3 pr-4 font-medium text-ink">
                      {row.value != null ? `${row.value.toLocaleString()}${unit}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 space-y-1 text-xs text-ink-faint">
            {meta?.notes?.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
            {qualifier && (
              <p>
                {qualifier.qualified_players} player{qualifier.qualified_players === 1 ? '' : 's'} qualified.
              </p>
            )}
            <p>{formatSyncedAt(meta?.freshness?.synced_at)}</p>
          </div>
        </>
      )}
    </div>
  );
}
