// Phase 4 mockup: "[Injury: Questionable - Ankle]" in the Player Detail
// header. Renders nothing for a healthy player (no injury_reports row,
// or the most recent one reads 'active') — matches the MVP's "graceful,
// not just non-broken" empty-state philosophy rather than showing an
// empty/placeholder badge.
//
// Data source note: `injury_reports` isn't populated by either
// scripts/seed.js or scripts/backfill-historical.js — nflverse's
// historical pass covers games/box-scores, not injury reports. A live
// injury feed is still an open decision (docs/architecture.md §3,
// "current-season/live stats: still undecided"), so this will correctly
// show no badge for anyone until that source exists. Not a bug.

const REPORT_STATUS_LABEL = {
  questionable: 'Questionable',
  doubtful: 'Doubtful',
  out: 'Out',
  injured_reserve: 'Injured Reserve',
  probable: 'Probable',
};

// A mild-to-severe ladder, not five arbitrary colors: caution (mildest)
// -> accent (more severe, reuses the app's own orange rather than adding
// a second orange-ish hue) -> negative, with injured_reserve getting a
// bordered variant of the same negative color rather than a fourth red
// shade, since it's the same "out" severity just for longer.
const REPORT_STATUS_STYLE = {
  questionable: 'text-caution bg-caution/12',
  doubtful: 'text-accent bg-accent/12',
  out: 'text-negative bg-negative/12',
  injured_reserve: 'text-negative bg-negative/20 border border-negative/40',
  probable: 'text-positive bg-positive/12',
};

export default function InjuryBadge({ injury }) {
  if (!injury || !injury.report_status || injury.report_status === 'active') return null;

  const label = REPORT_STATUS_LABEL[injury.report_status] ?? injury.report_status;
  const style = REPORT_STATUS_STYLE[injury.report_status] ?? 'text-ink-dim bg-surface-2';
  const detail = [injury.primary_injury, injury.secondary_injury].filter(Boolean).join(', ');

  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${style}`}>
      Injury: {label}
      {detail ? ` – ${detail}` : ''}
    </span>
  );
}
