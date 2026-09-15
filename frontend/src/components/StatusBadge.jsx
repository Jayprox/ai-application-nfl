/**
 * Game status badge — shared by the Games page (and anywhere else a game
 * needs a status pill later) so "what does 'final' look like" has one
 * answer. 'in_progress' styles a real status as of 2026-09-14 —
 * worker/ingestion-worker.js's new sync_live_scores job (see
 * docs/part2-roadmap.md's "refresh cadence lags same-day results"
 * backlog item) writes it during a game's live window, on a ~10-minute
 * cadence bounded by Highlightly's 100-request/day free-tier quota — see
 * that job's own header comment for the full cost math. Solid accent
 * fill (not the usual translucent X/12 chip) deliberately matches the
 * "active state" treatment the scope tabs elsewhere already use for
 * accent, so Live reads as the one thing on a card that's currently
 * happening, not just another descriptive label.
 *
 * `period`/`clock` (2026-09-15, "live updates similar to Chalk That
 * MLB") are optional — sync_live_scores writes games.game_period/
 * game_clock off the same Highlightly response it already parses for
 * score/status (010_live_game_clock.sql), and this badge shows "Q2
 * 8:00" instead of the plain Live pill once both have landed for a
 * given game. Falls back to Live whenever either is missing (before
 * that game's first live poll, or if Highlightly's response for it
 * omitted them) rather than showing a broken "Q undefined".
 */

const STATUS_LABEL = {
  scheduled: 'Scheduled',
  in_progress: 'Live',
  final: 'Final',
  postponed: 'Postponed',
};

const STATUS_STYLE = {
  scheduled: 'text-ink-dim bg-surface-2',
  in_progress: 'text-on-accent bg-accent',
  final: 'text-ink bg-surface-2',
  postponed: 'text-caution bg-caution/12',
};

export default function StatusBadge({ status, period, clock }) {
  const hasClock = status === 'in_progress' && period != null && clock;
  const label = hasClock ? `Q${period} ${clock}` : (STATUS_LABEL[status] ?? status);
  const style = STATUS_STYLE[status] ?? 'text-ink-dim bg-surface-2';
  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${style}${hasClock ? ' tabular-nums' : ''}`}>
      {label}
    </span>
  );
}
