import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApiFetch, LIVE_SCORE_POLL_MS } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';
import StatusBadge from '../components/StatusBadge';
import WeatherBadge from '../components/WeatherBadge';
import EdgeBadge from '../components/EdgeBadge';
import InjuryBadge from '../components/InjuryBadge';

/**
 * Game Detail page — the per-game deep dive (Part 2 Phase 3, scoped
 * 2026-09-14 via docs/part2-roadmap.md) that GameCard.jsx's cards on the
 * Games page now link to. Composes five routes rather than introducing
 * any new data of its own — same "one source of truth, link out rather
 * than duplicate" principle backend/routes/games.js's own header comment
 * states and the rest of this app already follows:
 *
 *   - GET /games/:gameId          — matchup header (backend/routes/games.js)
 *   - GET /edge/games/:gameId     — model-vs-market read (backend/lib/edge.js)
 *   - GET /odds/games/:id         — full odds board (backend/routes/odds.js)
 *   - GET /games/:gameId/injuries — both rosters' injury reports
 *   - GET /games/:gameId/boxscore — live/final per-player stat lines
 *                                   (new, 2026-09-17, "fuller live
 *                                   gamecast view" backlog item — see
 *                                   docs/part2-roadmap.md). Same
 *                                   background-poll-while-in_progress
 *                                   treatment as the header fetch below,
 *                                   since a live box score is exactly
 *                                   the kind of thing that goes stale
 *                                   mid-page-view. Drive events
 *                                   (play-by-play) are deliberately NOT
 *                                   part of this — no confirmed data
 *                                   source exists for them yet (neither
 *                                   nflverse nor Highlightly's own
 *                                   /matches/{id} detail response has
 *                                   ever been confirmed to carry
 *                                   play-level data), so this stays
 *                                   scoreboard + box score only.
 *   - GET /games/:gameId/player-stats — both rosters' SEASON stats (not
 *                                   this-game stats), for the new Player
 *                                   Stats section below. No pollMs — a
 *                                   season aggregate doesn't go stale
 *                                   mid-page-view the way a live score
 *                                   does.
 *
 * Player Stats section (2026-09-17, "I wanted to see the players stats,
 * and we can create a toggle to switch between the two teams" request):
 * a new, always-visible section, separate from Live Box Score above —
 * that section only has data once a game has kicked off, which is
 * exactly the case (a scheduled, upcoming game) this one exists for.
 * Reuses ALL_BOX_SCORE_CATEGORIES and BoxScoreCategoryTable unchanged
 * from the box score rework — same category/column shape, just fed a
 * different rows array — plus its own independent away/home toggle (a
 * separate activeSide would collide with Live Box Score's) and a second
 * small Season Avg / Season Total toggle, since GET /player-stats
 * returns both per category rather than picking one.
 *
 * Only the first fetch gates the page (a 404'd or bad game id really
 * means "there's nothing to show"). Edge/odds/injuries/boxscore are
 * treated as secondary the same way GamesPage.jsx treats edge/odds on a
 * card — a slow or failed fetch just renders that section's own
 * graceful-empty state rather than blocking the header from showing.
 *
 * Box score rework (2026-09-17, Yahoo Sports app reference explore):
 * switched from a side-by-side away+home layout with a collapsible full
 * breakdown to a single team-toggle pill (matches the reference app's
 * own team switcher) showing one team's full stat-category breakdown at
 * a time. Special teams also split from one combined table into four —
 * Kicking / Punting / Punt Return / Kick Return — matching the
 * reference's category boundaries, though NOT its exact columns: our
 * schema (backend/lib/stats-query.js's PLAYER_STAT_COLUMNS.special_teams)
 * has no FG%, no kicker scoring total, no In20/In10/touchback/blocked-punt
 * tracking, no per-return attempt count, and return_tds isn't split by
 * return type (one combined column, can't tell a punt-return TD from a
 * kick-return TD) — those columns just don't exist here, so the Kicking/
 * Punting/Punt Return/Kick Return tables below only ever show real
 * synced columns, never an invented or estimated one. Every player name
 * in Top Performers and the category tables links to that player's page
 * with ?scope=last5, landing directly on PlayerDetailPage's Last 5 Games
 * tab (see that page's own new useSearchParams read) instead of the
 * page's default Season Avg view — the natural next question after
 * seeing one game's line is "how's he been playing lately," not the
 * full-season average.
 */

const MARKET_LABEL = { spreads: 'Spread', h2h: 'Moneyline', totals: 'Total' };
const MARKET_ORDER = ['spreads', 'h2h', 'totals'];

// Book display names + display order (2026-09-15): The Odds API syncs
// every US bookmaker it has for a game (worker/ingestion-worker.js), but
// showing all of them turns this into a long undifferentiated list of
// raw lowercase keys. Narrow to the four majors most bettors check,
// plus Caesars (still synced under its pre-rebrand API key,
// williamhill_us) with a real display name instead of the bare key.
// Scoped to this page's display only -- GET /odds/games/:id still
// returns every book, and backend/lib/edge.js's model-vs-market calc
// keeps reading all of them, so narrowing this list doesn't change
// what feeds Edge.
const BOOKMAKER_DISPLAY = {
  betmgm: 'BetMGM',
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  bovada: 'Bovada',
  williamhill_us: 'Caesars',
};
const BOOKMAKER_ORDER = ['betmgm', 'draftkings', 'fanduel', 'bovada', 'williamhill_us'];

function formatKickoff(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Same one-line pure function as OddsBadge.jsx's own formatPoint, kept as
// a local copy rather than a shared import — the two components have
// nothing else in common to couple on for it.
function formatPoint(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  return num > 0 ? `+${num}` : `${num}`;
}

// Box score category configs — mirror the real position groupings
// PLAYER_STAT_TABLES/PLAYER_STAT_COLUMNS use server-side
// (backend/lib/stats-query.js), not a frontend-only invented split. Each
// category's filterKeys decide which players are "in" that table (e.g. a
// receiver with 0 rush attempts doesn't get a blank row in Rushing) —
// same "don't show a row with nothing in it" norm PlayerDetailPage.jsx's
// EmptyStatsMessage already follows for a whole page.
const OFFENSE_CATEGORIES = [
  {
    key: 'passing',
    label: 'Passing',
    filterKeys: ['pass_attempts'],
    columns: [
      ['pass_completions', 'C'],
      ['pass_attempts', 'ATT'],
      ['passing_yards', 'YDS'],
      ['passing_tds', 'TD'],
      ['interceptions_thrown', 'INT'],
    ],
  },
  {
    key: 'rushing',
    label: 'Rushing',
    filterKeys: ['rush_attempts'],
    columns: [
      ['rush_attempts', 'ATT'],
      ['rushing_yards', 'YDS'],
      ['rushing_tds', 'TD'],
      ['fumbles', 'FUM'],
    ],
  },
  {
    key: 'receiving',
    label: 'Receiving',
    filterKeys: ['targets', 'receptions'],
    columns: [
      ['receptions', 'REC'],
      ['targets', 'TGT'],
      ['receiving_yards', 'YDS'],
      ['receiving_tds', 'TD'],
    ],
  },
];

const DEFENSE_CATEGORY = {
  key: 'defense',
  label: 'Defense',
  filterKeys: [
    'tackles_solo', 'tackles_assist', 'sacks', 'interceptions',
    'passes_defended', 'forced_fumbles', 'fumble_recoveries', 'defensive_tds',
  ],
  columns: [
    ['tackles_solo', 'SOLO'],
    ['tackles_assist', 'AST'],
    ['sacks', 'SACK'],
    ['interceptions', 'INT'],
    ['passes_defended', 'PD'],
    ['forced_fumbles', 'FF'],
    ['fumble_recoveries', 'FR'],
    ['defensive_tds', 'TD'],
  ],
};

// Special teams split into 4 tables (2026-09-17, Yahoo reference) —
// see this file's header comment for exactly which Yahoo columns we
// don't have and why (schema gap, not an oversight). return_tds isn't
// split by return type in the schema, so it's deliberately left out of
// both return tables below rather than guessed at.
const KICKING_CATEGORY = {
  key: 'kicking',
  group: 'special_teams',
  label: 'Kicking',
  filterKeys: ['fg_attempts', 'xp_attempts'],
  columns: [
    ['fg_made', 'FG'],
    ['fg_attempts', 'FGA'],
    ['longest_fg', 'LNG'],
    ['xp_made', 'XP'],
    ['xp_attempts', 'XPA'],
  ],
};
const PUNTING_CATEGORY = {
  key: 'punting',
  group: 'special_teams',
  label: 'Punting',
  filterKeys: ['punts'],
  columns: [
    ['punts', 'PUNT'],
    ['punt_yards', 'YDS'],
    ['punt_avg', 'AVG'],
  ],
};
const PUNT_RETURN_CATEGORY = {
  key: 'punt_return',
  group: 'special_teams',
  label: 'Punt Return',
  filterKeys: ['punt_return_yards'],
  columns: [['punt_return_yards', 'YDS']],
};
const KICK_RETURN_CATEGORY = {
  key: 'kick_return',
  group: 'special_teams',
  label: 'Kick Return',
  filterKeys: ['kick_return_yards'],
  columns: [['kick_return_yards', 'YDS']],
};

// Rendering order matches the Yahoo reference: Passing/Rushing/Receiving,
// Kicking, Punting, Defense, Punt Return, Kick Return.
const ALL_BOX_SCORE_CATEGORIES = [
  ...OFFENSE_CATEGORIES.map((c) => ({ ...c, group: 'offense' })),
  KICKING_CATEGORY,
  PUNTING_CATEGORY,
  { ...DEFENSE_CATEGORY, group: 'defense' },
  PUNT_RETURN_CATEGORY,
  KICK_RETURN_CATEGORY,
];

function nonZeroRows(rows, filterKeys) {
  return rows.filter((r) => filterKeys.some((k) => Number(r[k]) > 0));
}

// "Top performers" = the classic gamecast leaders pattern (a passing
// leader, a rushing leader, a receiving leader per team), not a generic
// top-N-by-yards list — comparing 300 pass yards against 80 rush yards
// on one shared scale would be apples-to-oranges, so each category picks
// its own leader instead.
function topByStat(rows, statKey) {
  return rows.reduce((best, r) => (Number(r[statKey]) > Number(best?.[statKey] ?? -1) ? r : best), null);
}

const LEADER_CATEGORIES = [
  { label: 'Passing', statKey: 'passing_yards', tdKey: 'passing_tds' },
  { label: 'Rushing', statKey: 'rushing_yards', tdKey: 'rushing_tds' },
  { label: 'Receiving', statKey: 'receiving_yards', tdKey: 'receiving_tds' },
];

function teamLeaders(offenseRows) {
  return LEADER_CATEGORIES.map(({ label, statKey, tdKey }) => {
    const player = topByStat(offenseRows, statKey);
    if (!player || Number(player[statKey]) <= 0) return null;
    return { label, player, stat: player[statKey], td: player[tdKey] };
  }).filter(Boolean);
}

function formatSyncedAt(freshness) {
  const iso = freshness?.synced_at;
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// No team label here -- the team toggle right above this already
// establishes which team's leaders these are (2026-09-17 rework; the
// old side-by-side layout needed the per-team label, a single-team
// view doesn't).
function TopPerformers({ offenseRows }) {
  const leaders = teamLeaders(offenseRows);
  if (leaders.length === 0) return null;
  return (
    <ul className="space-y-1">
      {leaders.map((l) => (
        <li
          key={l.label}
          className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
        >
          <span className="w-20 shrink-0 text-xs uppercase tracking-wide text-ink-faint">{l.label}</span>
          <Link to={`/players/${l.player.player_id}?scope=last5`} className="flex-1 truncate text-link hover:underline">
            {l.player.full_name}
          </Link>
          <span className="shrink-0 text-xs text-ink tabular-nums">
            {l.stat} YDS{l.td ? `, ${l.td} TD` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BoxScoreCategoryTable({ category, rows }) {
  const filtered = nonZeroRows(rows, category.filterKeys);
  if (filtered.length === 0) return null;
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-xs font-medium text-ink-dim">{category.label}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-ink-faint">
              <th className="pb-1 text-left font-medium">Player</th>
              {category.columns.map(([key, label]) => (
                <th key={key} className="pb-1 pl-2 text-right font-medium tabular-nums">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.player_id} className="border-t border-line">
                <td className="py-1 pr-2">
                  <Link to={`/players/${r.player_id}?scope=last5`} className="text-link hover:underline">
                    {r.full_name}
                  </Link>{' '}
                  <span className="text-xs text-ink-faint">{r.position}</span>
                </td>
                {category.columns.map(([key]) => (
                  <td key={key} className="py-1 pl-2 text-right text-ink tabular-nums">
                    {r[key] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function GameDetailPage() {
  const { gameId } = useParams();

  // Live updates (2026-09-15, docs/part2-roadmap.md): background-poll
  // this game's own fetch while it's in_progress, same ~10-minute
  // cadence as sync_live_scores itself — see useApiFetch.js's own
  // comment for why this is a two-step "fetch once, then decide whether
  // to start polling" rather than an always-on interval.
  const [livePollMs, setLivePollMs] = useState(undefined);
  const { data: gameData, error, loading, refetch } = useApiFetch(`/games/${gameId}`, { pollMs: livePollMs });
  useEffect(() => {
    setLivePollMs(gameData?.data?.status === 'in_progress' ? LIVE_SCORE_POLL_MS : undefined);
  }, [gameData]);
  const { data: edgeData } = useApiFetch(`/edge/games/${gameId}`);
  const { data: oddsData } = useApiFetch(`/odds/games/${gameId}`);
  const { data: injuriesData } = useApiFetch(`/games/${gameId}/injuries`);
  // Same livePollMs as the header fetch above -- a live box score goes
  // stale on the same "game is in_progress" condition the score/clock
  // do, so it reuses that state rather than deriving its own.
  const { data: boxscoreData } = useApiFetch(`/games/${gameId}/boxscore`, { pollMs: livePollMs });
  const [activeSide, setActiveSide] = useState('away');
  // Player Stats section's own toggles — deliberately separate state
  // from Live Box Score's activeSide above, since a reader may well
  // want the box score on one team and the season stats on the other.
  const { data: playerStatsData } = useApiFetch(`/games/${gameId}/player-stats`);
  const [playerStatsSide, setPlayerStatsSide] = useState('away');
  const [playerStatsMode, setPlayerStatsMode] = useState('avg');

  if (loading || error) {
    return <AsyncState loading={loading} error={error} loadingLabel="Loading game…" onRetry={refetch} />;
  }

  const game = gameData?.data;
  if (!game) {
    return <p className="text-sm text-ink-dim">Game not found.</p>;
  }

  const isFinal = game.status === 'final';
  const showScore = isFinal || game.status === 'in_progress';

  const edge = edgeData?.data;
  const modelAbbr =
    edge?.model_favorite === 'home'
      ? game.home_team_abbr
      : edge?.model_favorite === 'away'
        ? game.away_team_abbr
        : null;
  const marketAbbr =
    edge?.market_favorite === 'home'
      ? game.home_team_abbr
      : edge?.market_favorite === 'away'
        ? game.away_team_abbr
        : null;

  const bookmakers = (oddsData?.data?.bookmakers ?? []).filter((b) => BOOKMAKER_ORDER.includes(b.bookmaker));
  const oddsByMarket = MARKET_ORDER.map((market) => ({
    market,
    rows: bookmakers
      .filter((b) => b.market === market)
      .sort((a, b) => BOOKMAKER_ORDER.indexOf(a.bookmaker) - BOOKMAKER_ORDER.indexOf(b.bookmaker)),
  })).filter((g) => g.rows.length > 0);

  const homeInjuries = injuriesData?.data?.home ?? [];
  const awayInjuries = injuriesData?.data?.away ?? [];

  const boxscore = boxscoreData?.data;
  const boxscoreSampleSize = boxscoreData?.meta?.sample_size ?? 0;
  const boxscoreSyncedAtLabel = formatSyncedAt(boxscoreData?.meta?.freshness);
  const activeBoxscoreSide = boxscore ? (activeSide === 'away' ? boxscore.away : boxscore.home) : null;

  const playerStats = playerStatsData?.data;
  const playerStatsSampleSize = playerStatsData?.meta?.sample_size ?? 0;
  const activePlayerStatsSide = playerStats
    ? (playerStatsSide === 'away' ? playerStats.away : playerStats.home)
    : null;

  return (
    <div>
      <Link to="/games" className="text-sm text-ink-dim hover:text-ink">
        &larr; Back to Games
      </Link>

      <div className="mt-2 mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={`/teams/${game.away_team_id}`} className="text-xl font-semibold text-link hover:underline">
            {game.away_team_name}
          </Link>
          <span className="text-ink-faint text-xl">@</span>
          <Link to={`/teams/${game.home_team_id}`} className="text-xl font-semibold text-link hover:underline">
            {game.home_team_name}
          </Link>
          <StatusBadge status={game.status} period={game.game_period} clock={game.game_clock} />
        </div>

        {showScore && (
          <div className="mt-1 text-2xl font-bold text-ink tabular-nums">
            {game.away_score}–{game.home_score}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-ink-dim">
          <span>{formatKickoff(game.game_datetime)}</span>
          {game.stadium_name && (
            <span>
              · {game.stadium_name}, {game.stadium_city}, {game.stadium_state}
            </span>
          )}
          <WeatherBadge condition={game.weather_condition} tempF={game.weather_temp_f} />
        </div>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">Model vs. Market</h2>
          {!edge ? (
            <p className="text-sm text-ink-dim">Edge read not available yet for this game.</p>
          ) : (
            <div className="rounded-md border border-line bg-surface px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-ink-dim">
                  <span>
                    Model: {modelAbbr ? <span className="font-medium text-ink">{modelAbbr}</span> : '—'}
                    {edge.model_margin !== null && edge.model_margin !== undefined
                      ? ` (by ${Number(edge.model_margin).toFixed(1)})`
                      : ''}
                  </span>
                  <span>
                    Market: {marketAbbr ? <span className="font-medium text-ink">{marketAbbr}</span> : '—'}
                    {edge.market_margin !== null && edge.market_margin !== undefined
                      ? ` (${edge.market_source}, ${Number(edge.market_margin).toFixed(1)})`
                      : ''}
                </span>
                </div>
                <EdgeBadge edge={edge.edge} />
              </div>
              {edge.note && <p className="mt-1 text-xs text-ink-faint">{edge.note}</p>}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">Odds</h2>
          {oddsByMarket.length === 0 ? (
            <p className="text-sm text-ink-dim">No odds synced yet for this game.</p>
          ) : (
            <div className="space-y-4">
              {oddsByMarket.map(({ market, rows }) => (
                <div key={market}>
                  <h3 className="text-xs font-medium text-ink-dim mb-1.5">{MARKET_LABEL[market]}</h3>
                  <ul className="space-y-1">
                    {rows.map((r, i) => (
                      <li
                        key={`${r.bookmaker}-${i}`}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
                      >
                        <span className="text-ink">{BOOKMAKER_DISPLAY[r.bookmaker] ?? r.bookmaker}</span>
                        <span className="text-xs text-ink-dim tabular-nums">
                          {market === 'spreads' &&
                            `${game.away_team_abbr} ${formatPoint(r.away_point)} (${formatPoint(r.away_price)}) · ${game.home_team_abbr} ${formatPoint(r.home_point)} (${formatPoint(r.home_price)})`}
                          {market === 'h2h' &&
                            `${game.away_team_abbr} ${formatPoint(r.away_price)} · ${game.home_team_abbr} ${formatPoint(r.home_price)}`}
                          {market === 'totals' &&
                            `O/U ${r.total_point ?? '—'} (O ${formatPoint(r.over_price)} / U ${formatPoint(r.under_price)})`}
                      </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">Injuries</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { label: game.away_team_abbr, players: awayInjuries, teamId: game.away_team_id },
              { label: game.home_team_abbr, players: homeInjuries, teamId: game.home_team_id },
            ].map(({ label, players, teamId }) => (
              <div key={teamId}>
                <h3 className="text-xs font-medium text-ink-dim mb-1.5">{label}</h3>
                {players.length === 0 ? (
                  <p className="text-sm text-ink-faint">No injuries reported.</p>
                ) : (
                  <ul className="space-y-1">
                    {players.map((p) => (
                      <li
                        key={p.player_id}
                        className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
                      >
                        <Link to={`/players/${p.player_id}`} className="text-ink hover:underline">
                          {p.full_name} <span className="text-xs text-ink-faint">{p.position}</span>
                        </Link>
                        <InjuryBadge injury={p} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">Player Stats</h2>
          {!playerStats || playerStatsSampleSize === 0 ? (
            <p className="text-sm text-ink-dim">No stats synced yet this season for either roster.</p>
          ) : (
            <div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex max-w-xs rounded-md border border-line bg-surface p-0.5">
                  {[
                    { key: 'away', abbr: game.away_team_abbr },
                    { key: 'home', abbr: game.home_team_abbr },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setPlayerStatsSide(t.key)}
                      className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                        playerStatsSide === t.key ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
                      }`}
                    >
                      {t.abbr}
                    </button>
                  ))}
                </div>

                <div className="flex rounded-md border border-line bg-surface p-0.5 text-xs">
                  {[
                    { key: 'avg', label: 'Season Avg' },
                    { key: 'total', label: 'Season Total' },
                  ].map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setPlayerStatsMode(m.key)}
                      className={`rounded px-2.5 py-1 font-medium transition-colors ${
                        playerStatsMode === m.key ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {ALL_BOX_SCORE_CATEGORIES.map((cat) => (
                <BoxScoreCategoryTable
                  key={cat.key}
                  category={cat}
                  rows={activePlayerStatsSide[cat.group][playerStatsMode]}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint mb-2">Live Box Score</h2>
          {!boxscore || boxscoreSampleSize === 0 ? (
            <p className="text-sm text-ink-dim">
              {game.status === 'scheduled'
                ? 'Box score available once the game kicks off.'
                : 'No box score synced yet for this game.'}
            </p>
          ) : (
            <div>
              <div className="mb-4 flex max-w-xs rounded-md border border-line bg-surface p-0.5">
                {[
                  { key: 'away', abbr: game.away_team_abbr },
                  { key: 'home', abbr: game.home_team_abbr },
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setActiveSide(t.key)}
                    className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      activeSide === t.key ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-surface-2'
                    }`}
                  >
                    {t.abbr}
                  </button>
                ))}
              </div>

              <h3 className="mb-1.5 text-xs font-medium text-ink-dim">Top Performers</h3>
              <TopPerformers offenseRows={activeBoxscoreSide.offense} />

              <div className="mt-4">
                {ALL_BOX_SCORE_CATEGORIES.map((cat) => (
                  <BoxScoreCategoryTable key={cat.key} category={cat} rows={activeBoxscoreSide[cat.group]} />
                ))}
              </div>

              {boxscoreSyncedAtLabel && (
                <p className="mt-2 text-xs text-ink-faint">
                  Box score as of {boxscoreSyncedAtLabel}
                  {game.status === 'in_progress' ? ' — updates every few minutes while the game is live.' : ''}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
