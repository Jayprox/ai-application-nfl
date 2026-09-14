// Shared across every screen that shows a player's roster status (Team
// detail, Player browse, Player detail) so the badge styling and label
// text never drift between them. Matches the `status` values on the
// `players` table (db/schema.sql): active, injured_reserve,
// practice_squad, free_agent, retired.

const STATUS_STYLE = {
  active: 'text-positive bg-positive/12',
  injured_reserve: 'text-caution bg-caution/12',
  practice_squad: 'text-ink-dim bg-surface-2',
  free_agent: 'text-ink-dim bg-surface-2',
  retired: 'text-ink-faint bg-surface-2',
};

export function statusBadgeClass(status) {
  return STATUS_STYLE[status] ?? 'text-ink-dim bg-surface-2';
}

export function statusLabel(status) {
  return (status ?? '').replace('_', ' ');
}
