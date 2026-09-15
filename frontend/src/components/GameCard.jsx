import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import WeatherBadge from './WeatherBadge';
import EdgeBadge from './EdgeBadge';
import OddsBadge from './OddsBadge';

/**
 * One game's card for the Games page (Part 2 Phase 3's scoreboard-style
 * week view, docs/part2-roadmap.md) — built from data this app already
 * computes rather than duplicating it: `game` comes straight from
 * GET /games (backend/routes/games.js), `edge` is that same game's row
 * from GET /edge (backend/lib/edge.js), and `odds` is that same game's
 * entry from GET /odds (backend/routes/odds.js) — each matched by
 * game_id on GamesPage.jsx rather than this component re-fetching
 * anything itself. Team names link to the same TeamDetailPage the Teams
 * tab already uses — one route per team, not a second lighter view.
 *
 * The whole card also links to GameDetailPage.jsx (2026-09-14, the
 * per-game deep dive) via an absolutely-positioned overlay <Link>, not by
 * wrapping the card's own content in a <Link> — the two team-abbreviation
 * links already inside the card would make that an invalid nested-anchor.
 * The content wrapper is `pointer-events-none` so clicks fall through to
 * the overlay everywhere except the two team links, which opt back in
 * with `pointer-events-auto` — a normal pattern for a "clickable card
 * with an inner link that goes somewhere else."
 */

const GAME_SLOT_LABEL = {
  thursday_night: 'Thursday Night',
  sunday_early: 'Sunday',
  sunday_late: 'Sunday',
  sunday_night: 'Sunday Night',
  monday_night: 'Monday Night',
};

// Deliberately renders in the viewer's own browser timezone rather than
// pinned to ET — decided 2026-09-14, considered and explicitly rejected
// pinning to ET despite NFL kickoffs usually being talked about that way.
function formatKickoff(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function GameCard({ game, edge, odds }) {
  const isFinal = game.status === 'final';
  // Live scores land via sync_live_scores (2026-09-14) on the same
  // games.status/home_score/away_score columns a final game already
  // uses — no separate "live score" shape, so the score line below is
  // shared by both states rather than duplicated.
  const showScore = isFinal || game.status === 'in_progress';

  return (
    <div className="relative rounded-md border border-line bg-surface px-4 py-3 transition-colors hover:border-accent/60">
      <Link
        to={`/games/${game.game_id}`}
        className="absolute inset-0 z-0 rounded-md"
        aria-label={`${game.away_team_abbr} at ${game.home_team_abbr} — game details`}
      />
      <div className="relative z-10 pointer-events-none">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/teams/${game.away_team_id}`}
                className="pointer-events-auto font-medium text-link text-sm hover:underline"
              >
                {game.away_team_abbr}
              </Link>
              <span className="text-ink-faint text-sm">@</span>
              <Link
                to={`/teams/${game.home_team_id}`}
                className="pointer-events-auto font-medium text-link text-sm hover:underline"
              >
                {game.home_team_abbr}
              </Link>
              <StatusBadge status={game.status} period={game.game_period} clock={game.game_clock} />
            </div>
            <div className="mt-1 text-xs text-ink-dim">
              {formatKickoff(game.game_datetime)}
              {GAME_SLOT_LABEL[game.game_slot] ? ` · ${GAME_SLOT_LABEL[game.game_slot]}` : ''}
              {game.stadium_name ? ` · ${game.stadium_name}` : ''}
            </div>
          </div>
          {showScore && (
            <div className="text-right shrink-0">
              <div className="text-sm font-semibold text-ink">
                {game.away_score}–{game.home_score}
              </div>
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <WeatherBadge condition={game.weather_condition} tempF={game.weather_temp_f} />
          <OddsBadge odds={odds} homeAbbr={game.home_team_abbr} />
          {edge ? <EdgeBadge edge={edge.edge} /> : null}
        </div>
      </div>
    </div>
  );
}
