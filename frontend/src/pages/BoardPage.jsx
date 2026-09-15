import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApiFetch, LIVE_SCORE_POLL_MS } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';
import GameCard from '../components/GameCard';
import EdgeBadge from '../components/EdgeBadge';

/**
 * Board — the unified home page (Part 2 Phase 3, scoped 2026-09-14 via
 * docs/part2-roadmap.md's "Slate/Board/Game" vision), replacing the flat
 * 9-tab list as the front door. By the time this was built, Phase 3's
 * remaining roadmap items already existed as separate working pages —
 * the ranked board (RankingsPage.jsx), the portfolio builder
 * (PortfolioPage.jsx), and the logged track record (PicksPage.jsx /
 * LeaderboardPage.jsx) — so "build a board" here means curate and link
 * out to those, not duplicate them. Same "one source of truth, link out
 * rather than duplicate" principle backend/routes/games.js's own header
 * comment states and the rest of this app already follows.
 *
 * Composes four read-only fetches, three of them scoped to "this week"
 * once GET /games/current-week (added alongside this page — see that
 * route's own comment for why it didn't already exist) resolves a
 * season/week:
 *   - GET /games/current-week   — resolves season/week; gates the page
 *   - GET /games?season=&week=  — this week's schedule (GameCard, reused as-is)
 *   - GET /edge?season=&week=&only_disagreements=true — top model-vs-market reads
 *   - GET /rankings?stat_category=passing_yards&season=&week=&limit=5 — top leaders
 *
 * Only the current-week fetch gates the whole page (an empty schedule
 * really does mean "nothing to show yet"); each section below fetches
 * and renders its own loading/error/empty state independently via
 * AsyncState, so a slow rankings query doesn't hold up the games strip —
 * a bit more granular than GamesPage.jsx's edge/odds overlays (those are
 * per-card badges, not their own visible sections), but the same spirit.
 *
 * Rankings is pinned to passing_yards rather than offering the full
 * 4-category picker RankingsPage.jsx has — a curated front door shows
 * one example leaderboard and links out to the full page for the other
 * three categories, rather than re-implementing that picker here.
 *
 * Top Edges reuses team abbreviations off the games list already fetched
 * for the games strip above (same season/week, same game_ids) instead of
 * a second GET /teams call purely to resolve them — EdgePage.jsx needs
 * that extra call because it isn't already fetching a matching games
 * list; this page is.
 *
 * Visual design pass (2026-09-15, docs/part2-roadmap.md Phase 4): Board
 * is the app's front door, so it gets the most hero treatment — Top
 * Edges/Rankings Leaders paired into one row on wide screens instead of
 * stacking the whole page vertically, and the games grid picks up a 3rd
 * column at lg width. No fetch/data logic changed — presentational only.
 *
 * Portfolio Record section removed (2026-09-15, second pass): it
 * duplicated what Record > Picks (PicksPage.jsx, GET /picks/stats) already
 * shows at the top of its own page, above the full pick-by-pick history —
 * that page is already reachable from the nav, so Board no longer fetches
 * or renders a second copy of the same four stat tiles.
 */

const TOP_EDGES_LIMIT = 5;

function SectionHeader({ title, linkTo, linkLabel }) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h2>
      {linkTo && (
        <Link to={linkTo} className="text-xs text-link hover:underline">
          {linkLabel} &rarr;
        </Link>
      )}
    </div>
  );
}

export default function BoardPage() {
  const {
    data: weekData,
    error: weekError,
    loading: weekLoading,
    refetch: refetchWeek,
  } = useApiFetch('/games/current-week');

  const season = weekData?.data?.season;
  const week = weekData?.data?.week;
  const hasWeek = season != null && week != null;

  const gamesPath = useMemo(
    () => (hasWeek ? `/games?${new URLSearchParams({ season: String(season), week: String(week) }).toString()}` : null),
    [hasWeek, season, week]
  );
  const edgePath = useMemo(
    () =>
      hasWeek
        ? `/edge?${new URLSearchParams({
            season: String(season),
            week: String(week),
            only_disagreements: 'true',
          }).toString()}`
        : null,
    [hasWeek, season, week]
  );
  const rankingsPath = useMemo(
    () =>
      hasWeek
        ? `/rankings?${new URLSearchParams({
            stat_category: 'passing_yards',
            season: String(season),
            week: String(week),
            limit: '5',
          }).toString()}`
        : null,
    [hasWeek, season, week]
  );

  // Live updates (2026-09-15, docs/part2-roadmap.md): background-poll
  // this week's games preview while any of them is in_progress, same
  // ~10-minute cadence as sync_live_scores itself.
  const [livePollMs, setLivePollMs] = useState(undefined);
  const { data: gamesData, error: gamesError, loading: gamesLoading, refetch: refetchGames } = useApiFetch(gamesPath, { pollMs: livePollMs });
  useEffect(() => {
    const list = gamesData?.data ?? [];
    setLivePollMs(list.some((g) => g.status === 'in_progress') ? LIVE_SCORE_POLL_MS : undefined);
  }, [gamesData]);
  const { data: edgeData, error: edgeError, loading: edgeLoading, refetch: refetchEdge } = useApiFetch(edgePath);
  const {
    data: rankingsData,
    error: rankingsError,
    loading: rankingsLoading,
    refetch: refetchRankings,
  } = useApiFetch(rankingsPath);
  const games = gamesData?.data ?? [];

  const gamesById = useMemo(() => {
    const map = new Map();
    for (const g of games) map.set(g.game_id, g);
    return map;
  }, [games]);

  const edges = edgeData?.data ?? [];
  const edgeByGameId = useMemo(() => {
    const map = new Map();
    for (const row of edges) map.set(row.game_id, row);
    return map;
  }, [edges]);

  const rankings = rankingsData?.data ?? [];

  if (weekLoading || weekError) {
    return (
      <AsyncState
        loading={weekLoading}
        error={weekError}
        loadingLabel="Finding this week's games…"
        onRetry={refetchWeek}
      />
    );
  }

  if (!hasWeek) {
    return (
      <div>
        <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink mb-1">Board</h1>
        <p className="text-sm text-ink-dim">
          No games in the schedule yet — once sync_schedule has run, this page will show this week's slate, top
          edges, and rankings leaders here.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 border-b border-line pb-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-accent">
          Season {season} &middot; Week {week}
        </p>
        <h1 className="font-display text-3xl font-semibold uppercase tracking-wide text-ink mb-2">Board</h1>
        <p className="max-w-2xl text-sm text-ink-dim">
          This week's games, the edge agent's top disagreements, and this week's rankings leaders — click
          through anywhere for the full page behind it.
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <SectionHeader title="This Week's Games" linkTo="/games" linkLabel="Full schedule" />
          {gamesLoading || gamesError ? (
            <AsyncState loading={gamesLoading} error={gamesError} loadingLabel="Loading games…" onRetry={refetchGames} />
          ) : games.length === 0 ? (
            <p className="text-sm text-ink-dim">No games scheduled for week {week} yet.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {games.map((game) => (
                <GameCard key={game.game_id} game={game} edge={edgeByGameId.get(game.game_id)} />
              ))}
            </div>
          )}
        </section>

        <div className="grid gap-8 lg:grid-cols-2">
          <section>
            <SectionHeader title="Top Edges" linkTo="/edge" linkLabel="All edges" />
            {edgeLoading || edgeError ? (
              <AsyncState loading={edgeLoading} error={edgeError} loadingLabel="Loading edges…" onRetry={refetchEdge} />
            ) : edges.length === 0 ? (
              <p className="text-sm text-ink-dim">No model-vs-market disagreements found for this week.</p>
            ) : (
              <ul className="space-y-2">
                {edges.slice(0, TOP_EDGES_LIMIT).map((row) => {
                  const g = gamesById.get(row.game_id);
                  const label = g ? `${g.away_team_abbr} @ ${g.home_team_abbr}` : `Game ${row.game_id}`;
                  return (
                    <li
                      key={row.game_id}
                      className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-2.5"
                    >
                      <Link to={`/games/${row.game_id}`} className="text-sm font-medium text-link hover:underline">
                        {label}
                      </Link>
                      <EdgeBadge edge={row.edge} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <SectionHeader title="Rankings Leaders" linkTo="/rankings" linkLabel="Full rankings" />
            <p className="text-xs text-ink-dim mb-2">Passing yards — top matchup scores this week.</p>
            {rankingsLoading || rankingsError ? (
              <AsyncState
                loading={rankingsLoading}
                error={rankingsError}
                loadingLabel="Loading rankings…"
                onRetry={refetchRankings}
              />
            ) : rankings.length === 0 ? (
              <p className="text-sm text-ink-dim">No rankings computed yet for this week.</p>
            ) : (
              <ul className="space-y-1">
                {rankings.map((row) => (
                  <li
                    key={`${row.player_id}-${row.game_id}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
                  >
                    <span className="text-ink-faint font-semibold w-5">{row.rank}</span>
                    <Link to={`/players/${row.player_id}`} className="flex-1 text-ink hover:underline">
                      {row.player_name} <span className="text-xs text-ink-faint">{row.position}</span>
                    </Link>
                    <span className="text-ink-dim tabular-nums">{Number(row.score).toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
