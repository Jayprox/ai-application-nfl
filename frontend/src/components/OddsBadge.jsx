/**
 * Compact spread + total badge for a game card, built from GET /odds
 * (backend/routes/odds.js). Reuses the same "just take the latest-synced
 * row per market, no bookmaker preference" selection backend/lib/edge.js's
 * own latestOdds() already uses (see its header) — so this shows the same
 * line the edge agent itself compared against, not a second independent
 * read of the odds table. Renders nothing until a spread or total has
 * actually synced for this game — same graceful-empty convention as
 * WeatherBadge.jsx/StatusBadge.jsx, not a bug when a game shows no badge
 * early in the week before books have posted lines.
 */

function latestByMarket(bookmakers, market) {
  const rows = (bookmakers ?? []).filter((b) => b.market === market);
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (
    !latest || new Date(row.synced_at) > new Date(latest.synced_at) ? row : latest
  ), null);
}

function formatPoint(point) {
  const n = Number(point);
  return n > 0 ? `+${n}` : `${n}`;
}

export default function OddsBadge({ odds, homeAbbr }) {
  const bookmakers = odds?.bookmakers;
  if (!bookmakers?.length) return null;

  const spread = latestByMarket(bookmakers, 'spreads');
  const totals = latestByMarket(bookmakers, 'totals');

  const parts = [];
  if (spread?.home_point != null) parts.push(`${homeAbbr} ${formatPoint(spread.home_point)}`);
  if (totals?.total_point != null) parts.push(`O/U ${totals.total_point}`);
  if (parts.length === 0) return null;

  return (
    <span className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-ink-dim bg-surface-2">
      {parts.join(' · ')}
    </span>
  );
}
