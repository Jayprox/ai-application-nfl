/**
 * Game status badge — shared by the Games page (and anywhere else a game
 * needs a status pill later) so "what does 'final' look like" has one
 * answer. Deliberately only styles the states games.status can actually
 * be today ('scheduled', 'final', 'postponed') — NOT 'in_progress':
 * nothing in this app writes that value yet (worker/ingestion-worker.js's
 * syncSchedule() only ever sets 'scheduled' or 'final', confirmed
 * 2026-09-13 — see docs/part2-roadmap.md's "refresh cadence lags
 * same-day results" backlog item). Rendering a LIVE-style badge for a
 * status nothing produces would be dead code pretending to be a real
 * feature — add that style here once the live-scoring backlog item
 * actually lands, not before.
 */

const STATUS_LABEL = {
  scheduled: 'Scheduled',
  final: 'Final',
  postponed: 'Postponed',
};

const STATUS_STYLE = {
  scheduled: 'text-ink-dim bg-surface-2',
  final: 'text-ink bg-surface-2',
  postponed: 'text-caution bg-caution/12',
};

export default function StatusBadge({ status }) {
  const label = STATUS_LABEL[status] ?? status;
  const style = STATUS_STYLE[status] ?? 'text-ink-dim bg-surface-2';
  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}
