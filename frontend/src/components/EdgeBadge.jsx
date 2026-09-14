/**
 * Shared "model vs market" badge for the edge agent's disagreement read
 * (GET /edge, backend/lib/edge.js) — used on both the Edge page and the
 * Games page's game cards, so there's exactly one definition of what
 * "Disagreement" / "Agrees" / "No signal" mean and how they're styled,
 * rather than each page growing its own copy as more surfaces want it.
 * Extracted out of EdgePage.jsx (2026-09-13) when GamesPage.jsx became a
 * second consumer.
 */

const EDGE_BADGE = {
  true: { label: 'Disagreement', className: 'text-amber-700 bg-amber-50' },
  false: { label: 'Agrees', className: 'text-emerald-700 bg-emerald-50' },
  null: { label: 'No signal', className: 'text-slate-500 bg-slate-100' },
};

export default function EdgeBadge({ edge }) {
  const badge = EDGE_BADGE[String(edge)];
  return (
    <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}
