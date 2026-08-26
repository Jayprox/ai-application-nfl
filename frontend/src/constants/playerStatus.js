// Shared across every screen that shows a player's roster status (Team
// detail, Player browse, Player detail) so the badge styling and label
// text never drift between them. Matches the `status` values on the
// `players` table (db/schema.sql): active, injured_reserve,
// practice_squad, free_agent, retired.

const STATUS_STYLE = {
  active: 'text-emerald-700 bg-emerald-50',
  injured_reserve: 'text-amber-700 bg-amber-50',
  practice_squad: 'text-slate-500 bg-slate-100',
  free_agent: 'text-slate-500 bg-slate-100',
  retired: 'text-slate-400 bg-slate-100',
};

export function statusBadgeClass(status) {
  return STATUS_STYLE[status] ?? 'text-slate-500 bg-slate-100';
}

export function statusLabel(status) {
  return (status ?? '').replace('_', ' ');
}
