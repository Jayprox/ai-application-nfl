/**
 * Compact odds badge for a game card, built from GET /odds
 * (backend/routes/odds.js). Filtered to DraftKings specifically ('DK')
 * rather than "whichever bookmaker last synced" (this component's
 * original behavior) -- DraftKings is the highest-volume US book, so a
 * reasonable default while there's no per-user "preferred book" setting
 * yet. That's deliberately left for later: a future settings-driven
 * default just swaps the hardcoded DRAFTKINGS_KEY below for a prop, no
 * other change needed here.
 *
 * Shows all three markets sync_odds already pulls
 * (worker/ingestion-worker.js's ODDS_MARKETS: h2h/spreads/totals) in one
 * line -- spread, total, moneyline -- same idea Chalk That MLB's slate
 * cards already use for their DK-tagged odds block. Renders nothing
 * until DraftKings has actually posted a line for this game -- same
 * graceful-empty convention as WeatherBadge.jsx/StatusBadge.jsx, not a
 * bug when a game shows no badge early in the week before books have
 * posted lines (or if DK specifically hasn't, even though another book
 * has -- no cross-book fallback, so the "DK" label is never a lie about
 * whose price is shown).
 */

const DRAFTKINGS_KEY = 'draftkings';

function latestDkByMarket(bookmakers, market) {
  const rows = (bookmakers ?? []).filter((b) => b.bookmaker === DRAFTKINGS_KEY && b.market === market);
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (
    !latest || new Date(row.synced_at) > new Date(latest.synced_at) ? row : latest
  ), null);
}

function formatSigned(value) {
  const n = Number(value);
  return n > 0 ? `+${n}` : `${n}`;
}

export default function OddsBadge({ odds, homeAbbr }) {
  const bookmakers = odds?.bookmakers;
  if (!bookmakers?.length) return null;

  const spread = latestDkByMarket(bookmakers, 'spreads');
  const totals = latestDkByMarket(bookmakers, 'totals');
  const moneyline = latestDkByMarket(bookmakers, 'h2h');

  const parts = [];
  if (spread?.home_point != null) parts.push(`${homeAbbr} ${formatSigned(spread.home_point)}`);
  if (totals?.total_point != null) parts.push(`O/U ${totals.total_point}`);
  if (moneyline?.away_price != null && moneyline?.home_price != null) {
    parts.push(`ML ${formatSigned(moneyline.away_price)}/${formatSigned(moneyline.home_price)}`);
  }
  if (parts.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-ink-dim bg-surface-2">
      <span className="font-semibold text-ink-faint">DK</span>
      <span className="tabular-nums">{parts.join(' · ')}</span>
    </span>
  );
}
