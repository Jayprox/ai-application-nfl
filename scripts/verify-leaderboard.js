/**
 * League Leaderboard verification script (2026-09-28).
 *
 * Runs the SAME code path production uses (lib/stats-query.js's
 * queryLeaderboard(), through runStatsQuery) against a few stats for the
 * 2025 season -- the most recently completed one at the time this
 * feature shipped -- and prints the top 5 for each so they can be
 * checked against NFL.com / Pro-Football-Reference by eye. This is a
 * standalone check script (this repo has no automated test runner, see
 * package.json), matching the existing convention of scripts/*.js as
 * one-off/re-runnable verification tools rather than a jest suite.
 *
 * Real checks already performed once, 2026-09-28, cross-referencing each
 * player's own individual Pro-Football-Reference page (not just the
 * league leaderboard page, which can render tables out of the sorted
 * order a quick fetch expects):
 *   - Matthew Stafford, 2025: 4,707 pass yards, 46 pass TDs, rating 109.2
 *     -- exact match.
 *   - Lamar Jackson, 2025: 302 pass attempts, rating 103.8 -- exact
 *     match, and confirms the passer-rating formula independently of
 *     the counting stats (a computed value, not a stored column).
 *   - De'Von Achane, 2025: 238 rush attempts, 1,350 rush yards, 16 games,
 *     5.7 Y/A -- exact match, including the qualifier boundary (238 is
 *     also this season's pass-attempts qualifier, coincidentally).
 *   - Josh Allen, 2025: 112 rush attempts, 579 rush yards, 5.2 Y/A,
 *     passer rating 102.2 -- exact match. Notably, Allen clears this
 *     app's rushing qualifier (107 attempts = 6.25/team game x 17 team
 *     games, the NFL's own published minimum) even though many informal
 *     "top rushers" lists use a stricter unofficial ~150-carry cutoff
 *     that would exclude him -- confirmed this is correct, not a bug,
 *     since 112 >= 107 and his 5.2 Y/A is real.
 * Re-run this script whenever the stat list, qualifier logic, or
 * ingestion pipeline changes, and spot-check a few rows again.
 *
 * Run with: node scripts/verify-leaderboard.js [season]
 */

require('dotenv').config();
const { runStatsQuery, LEADERBOARD_STATS } = require('../backend/lib/stats-query');
const { pool } = require('../backend/db');

const season = Number(process.argv[2]) || 2025;

// One representative stat per category, plus both rate stats (the ones
// with a real qualifier) -- not every LEADERBOARD_STATS key, to keep
// this script's output spot-check-sized rather than exhaustive.
const SPOT_CHECK_STATS = ['pass_yards', 'pass_rating', 'rush_yards', 'rush_ypc', 'rec_yards', 'rec_tds'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }

  for (const stat of SPOT_CHECK_STATS) {
    const { data, qualifier, notes } = await runStatsQuery({
      scope: 'leaderboard',
      stat,
      season,
      gameType: 'regular',
      perGame: false,
      limit: 5,
    });
    console.log(`\n${LEADERBOARD_STATS[stat].label} — top 5, ${season} regular season`);
    if (qualifier) console.log(`  qualifier: >= ${qualifier.min} ${qualifier.column} (${qualifier.per_team_game_rate}/team game x ${qualifier.team_games} team games)`);
    console.log((notes || []).map((n) => `  note: ${n}`).join('\n'));
    for (const row of data) {
      console.log(`  ${row.rank}. ${row.full_name} (${row.team}) — ${row.value} (${row.gp} gm)`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
