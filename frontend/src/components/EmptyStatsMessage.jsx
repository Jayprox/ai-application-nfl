// Phase 3 MVP scope calls for "graceful (not just non-broken) handling
// of offseason/preseason/bye-week/rookie empty states" — a flat "no
// data" string technically works but doesn't tell the person *why*.
// This picks the most likely real reason from what we already know
// client-side, rather than adding new backend signals just for copy:
//
//   - scope === 'career' with zero games -> genuinely no tracked history
//     (a rookie, or a player who never appears in the 2021-2025 data)
//   - a split filter is active -> the filter narrowed it to nothing,
//     not an offseason/rookie situation at all
//   - season === 2026 -> the one season we know has zero stats
//     system-wide (see scripts/backfill-historical.js — 2026 box scores
//     don't exist yet), i.e. genuinely "season hasn't happened"
//   - anything else -> this player specifically has no games that
//     season (not on a roster, injured out the whole year, etc.)
//
// A bye week doesn't need its own case here — Game Log already skips it
// gracefully on its own (there's simply no game row for that week), so
// nothing needs to be said about it.
export default function EmptyStatsMessage({ scope, season, hasActiveSplit, playerName }) {
  let message;
  if (scope === 'career') {
    message = `No career stats on file for ${playerName} yet — likely a rookie, or a player without tracked game history (our data covers the 2021–2025 seasons).`;
  } else if (hasActiveSplit) {
    message = `No games match these filters for the ${season} season — try clearing a split or picking a different season.`;
  } else if (season === 2026) {
    message = `The 2026 season hasn't been played yet — stats will appear here once games are tracked.`;
  } else {
    message = `No recorded games for ${playerName} in ${season} — they may not have been on an NFL roster that season.`;
  }

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center">
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  );
}
