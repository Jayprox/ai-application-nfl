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
 * Games page now link to. Composes four routes rather than introducing
 * any new data of its own — same "one source of truth, link out rather
 * than duplicate" principle backend/routes/games.js's own header comment
 * states and the rest of this app already follows:
 *
 *   - GET /games/:gameId          — matchup header (backend/routes/games.js)
 *   - GET /edge/games/:gameId     — model-vs-market read (backend/lib/edge.js)
 *   - GET /odds/games/:id         — full odds board (backend/routes/odds.js)
 *   - GET /games/:gameId/injuries — both rosters' injury reports (new,
 *                                   same file as the first route above)
 *
 * Only the first fetch gates the page (a 404'd or bad game id really
 * means "there's nothing to show"). Edge/odds/injuries are treated as
 * secondary the same way GamesPage.jsx treats edge/odds on a card — a
 * slow or failed fetch just renders that section's own graceful-empty
 * state rather than blocking the header from showing.
 */

const MARKET_LABEL = { spreads: 'Spread', h2h: 'Moneyline', totals: 'Total' };
const MARKET_ORDER = ['spreads', 'h2h', 'totals'];

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

  const bookmakers = oddsData?.data?.bookmakers ?? [];
  const oddsByMarket = MARKET_ORDER.map((market) => ({
    market,
    rows: bookmakers.filter((b) => b.market === market),
  })).filter((g) => g.rows.length > 0);

  const homeInjuries = injuriesData?.data?.home ?? [];
  const awayInjuries = injuriesData?.data?.away ?? [];

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
                        <span className="text-ink">{r.bookmaker}</span>
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
      </div>
    </div>
   );
}
