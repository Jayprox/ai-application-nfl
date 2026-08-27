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

const REPORT_STATUS_STYLE = {
  questionable: 'text-amber-700 bg-amber-50',
  doubtful: 'text-orange-700 bg-orange-50',
  out: 'text-red-700 bg-red-50',
  injured_reserve: 'text-red-800 bg-red-100',
  probable: 'text-emerald-700 bg-emerald-50',
};

export default function InjuryBadge({ injury }) {
  if (!injury || !injury.report_status || injury.report_status === 'active') return null;

  const label = REPORT_STATUS_LABEL[injury.report_status] ?? injury.report_status;
  const style = REPORT_STATUS_STYLE[injury.report_status] ?? 'text-slate-600 bg-slate-100';
  const detail = [injury.primary_injury, injury.secondary_injury].filter(Boolean).join(', ');

  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${style}`}>
      Injury: {label}
      {detail ? ` – ${detail}` : ''}
    </span>
  );
}
