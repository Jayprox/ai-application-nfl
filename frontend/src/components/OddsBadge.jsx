/**
 * Compact odds badge(s) for a game card, built from GET /odds
 * (backend/routes/odds.js). Filtered to DraftKings specifically ('DK')
 * rather than "whichever bookmaker last synced" -- DraftKings is the
 * highest-volume US book, so a reasonable default while there's no
 * per-user "preferred book" setting yet. That's deliberately left for
 * later: a future settings-driven default just swaps the hardcoded
 * DRAFTKINGS_KEY below for a prop, no other change needed here.
 *
 * Two render modes, added 2026-09-15 ("lock the values when the game
 * starts... and then when finished, show what did hit" request):
 *
 *   - Not yet final (scheduled/in_progress): one combined badge, same
 *     shape as before this change -- spread/total/moneyline joined on one
 *     line. The *line itself* is now locked to the closing number once
 *     the game starts (backend/routes/odds.js pins synced_at to the last
 *     sync at-or-before kickoff for any non-scheduled game), so this
 *     component doesn't need to know about locking at all -- it just
 *     renders whatever GET /odds already decided to hand it.
 *
 *   - Final, with both scores present: one small chip per market instead
 *     of a single combined badge, each showing the side/outcome that
 *     actually hit against that locked closing line -- same idea Chalk
 *     That MLB's slate cards use for separate ML/O-U/RL blocks, and the
 *     same text-positive/bg-positive token EdgeBadge.jsx already uses for
 *     its "Agrees" state, so "hit" reads consistently across the app
 *     rather than inventing a new color. A push (spread) or a tie
 *     (moneyline) has no side to highlight, so it renders in the same
 *     neutral style as the pregame badge.
 *
 * Renders nothing until DraftKings has actually posted a line for this
 * game -- same graceful-empty convention as WeatherBadge.jsx/
 * StatusBadge.jsx, not a bug when a game shows no badge early in the week
 * before books have posted lines (or if DK specifically hasn't, even
 * though another book has -- no cross-book fallback, so the "DK" label is
 * never a lie about whose price is shown).
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

// Grading helpers -- only called once the game is final and both scores
// are present. `margin` is home_score - away_score throughout: positive
// means the home team won. Each grader always describes the side/outcome
// that actually happened (not just "did the pregame favorite cover"), so
// the badge is showing what hit, not a fixed prediction.

function gradeSpread(spread, margin, homeAbbr, awayAbbr) {
  if (spread?.home_point == null) return null;
  const homePoint = Number(spread.home_point);
  const awayPoint = spread.away_point != null ? Number(spread.away_point) : -homePoint;
  const diff = margin + homePoint;
  if (diff === 0) return { key: 'spread', label: `${homeAbbr} ${formatSigned(homePoint)} (Push)`, hit: null };
  if (diff > 0) return { key: 'spread', label: `${homeAbbr} ${formatSigned(homePoint)}`, hit: true };
  return { key: 'spread', label: `${awayAbbr} ${formatSigned(awayPoint)}`, hit: true };
}

function gradeTotal(totals, homeScore, awayScore) {
  if (totals?.total_point == null) return null;
  const totalPoint = Number(totals.total_point);
  const actual = Number(homeScore) + Number(awayScore);
  if (actual === totalPoint) return { key: 'total', label: `O/U ${totalPoint} (Push)`, hit: null };
  const label = actual > totalPoint ? `O ${totalPoint} (${actual})` : `U ${totalPoint} (${actual})`;
  return { key: 'total', label, hit: true };
}

function gradeMoneyline(moneyline, margin, homeAbbr, awayAbbr) {
  if (moneyline?.home_price == null || moneyline?.away_price == null) return null;
  if (margin === 0) return { key: 'ml', label: 'ML Tie', hit: null };
  const homeWon = margin > 0;
  const winnerAbbr = homeWon ? homeAbbr : awayAbbr;
  const winnerPrice = homeWon ? moneyline.home_price : moneyline.away_price;
  return { key: 'ml', label: `ML ${winnerAbbr} ${formatSigned(winnerPrice)}`, hit: true };
}

export default function OddsBadge({ odds, homeAbbr, awayAbbr, status, homeScore, awayScore }) {
  const bookmakers = odds?.bookmakers;
  if (!bookmakers?.length) return null;

  const spread = latestDkByMarket(bookmakers, 'spreads');
  const totals = latestDkByMarket(bookmakers, 'totals');
  const moneyline = latestDkByMarket(bookmakers, 'h2h');

  const isGraded = status === 'final' && homeScore != null && awayScore != null;

  if (!isGraded) {
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

  const margin = Number(homeScore) - Number(awayScore);
  const chips = [
    gradeSpread(spread, margin, homeAbbr, awayAbbr),
    gradeTotal(totals, homeScore, awayScore),
    gradeMoneyline(moneyline, margin, homeAbbr, awayAbbr),
  ].filter(Boolean);
  if (chips.length === 0) return null;

  return chips.map((chip) => (
    <span
      key={chip.key}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-xs font-medium tabular-nums ${
        chip.hit ? 'text-positive bg-positive/12' : 'text-ink-dim bg-surface-2'
      }`}
    >
      <span className="font-semibold opacity-80">DK</span>
      {chip.hit ? '✓ ' : ''}
      {chip.label}
    </span>
  ));
}
