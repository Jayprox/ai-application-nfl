import { useMemo, useState } from 'react';
import { useApiFetch } from '../hooks/useApiFetch';
import AsyncState from '../components/AsyncState';
import GameCard from '../components/GameCard';

/**
 * Games page — the scoreboard-style "front door" (Part 2 Phase 3,
 * docs/part2-roadmap.md) for a week's schedule, composed from GET /games
 * (schedule/score/weather, backend/routes/games.js), GET /edge
 * (model-vs-market disagreement, backend/lib/edge.js), and GET /odds
 * (spread/total, backend/routes/odds.js) rather than any endpoint
 * duplicating another's data. Slice 1b of that phase — Slice 1a was the
 * /games endpoint itself; odds wiring followed once the dark theme shipped.
 *
 * Same season/week selector convention as EdgePage.jsx (required week,
 * two most recent seasons — both game_odds and matchup_scores are
 * populated per-season by their own cron jobs, not backfilled, same
 * reasoning as that page's own header comment).
 *
 * Status can be "Scheduled", "Live", or "Final" (StatusBadge.jsx) — the
 * sync_live_scores job (worker/ingestion-worker.js, added 2026-09-14)
 * writes 'in_progress' on games.status/home_score/away_score during a
 * game's live window; see that job's own header comment for the
 * Highlightly-quota cadence behind the ~10-minute refresh. Click a card
 * (or a team name within it) to dig further in — the card itself links
 * to GameDetailPage.jsx, GameCard.jsx's own header comment has the "why
 * not just wrap it in a <Link>" note.
 */

const CURRENT_SEASON = 2026;
const LAST_SEASON = 2025;
const SEASONS = [CURRENT_SEASON, LAST_SEASON];

const selectClass =
  'rounded-md border border-line px-3 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-accent';

export default function GamesPage() {
  const [season, setSeason] = useState(CURRENT_SEASON);
  const [weekInput, setWeekInput] = useState('1');

  const week = weekInput.trim();

  const gamesPath = useMemo(() => {
    if (!week) return null;
    return `/games?${new URLSearchParams({ season: String(season), week }).toString()}`;
  }, [season, week]);

  const edgePath = useMemo(() => {
    if (!week) return null;
    return `/edge?${new URLSearchParams({ season: String(season), week }).toString()}`;
  }, [season, week]);

  const oddsPath = useMemo(() => {
    if (!week) return null;
    return `/odds?${new URLSearchParams({ season: String(season), week }).toString()}`;
  }, [season, week]);

  const { data, error, loading, refetch } = useApiFetch(gamesPath);
  // Edge and odds are nice-to-have overlays, not the primary fetch this
  // page gates on — a slow/failed /edge or /odds call shouldn't block the
  // schedule itself from rendering, so neither's own loading/error state
  // is surfaced here (a game card just shows no disagreement/odds badge
  // until it loads), same reasoning for both.
  const { data: edgeData } = useApiFetch(edgePath);
  const { data: oddsData } = useApiFetch(oddsPath);

  const edgeByGameId = useMemo(() => {
    const map = new Map();
    for (const row of edgeData?.data ?? []) map.set(row.game_id, row);
    return map;
  }, [edgeData]);

  const oddsByGameId = useMemo(() => {
    const map = new Map();
    for (const row of oddsData?.data ?? []) map.set(row.game_id, row);
    return map;
  }, [oddsData]);

  const games = data?.data ?? [];

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink mb-1">Games</h1>
      <p className="text-sm text-ink-dim mb-4">
        This week's schedule at a glance — score and status when known, plus a flag when the edge agent's
        model-vs-market read disagrees. Click a team to dig into the research behind it.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className={selectClass}>
          {SEASONS.map((yr) => (
            <option key={yr} value={yr}>
              {yr}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="1"
          max="22"
          placeholder="Week"
          value={weekInput}
          onChange={(e) => setWeekInput(e.target.value)}
          className="w-24 rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {!week ? (
        <p className="text-sm text-ink-dim">Enter a week to see that week's games.</p>
      ) : loading || error ? (
        <AsyncState loading={loading} error={error} loadingLabel="Loading games…" onRetry={refetch} />
      ) : games.length === 0 ? (
        <p className="text-sm text-ink-dim">No games found for season {season}, week {week}.</p>
      ) : (
        <>
          <div className="space-y-2">
            {games.map((game) => (
              <GameCard
                key={game.game_id}
                game={game}
                edge={edgeByGameId.get(game.game_id)}
                odds={oddsByGameId.get(game.game_id)}
              />
            ))}
          </div>
          {data?.meta && (
            <p className="mt-3 text-xs text-ink-faint">
              {data.meta.count} game{data.meta.count === 1 ? '' : 's'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
