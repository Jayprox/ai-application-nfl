/**
 * Chalk That NFL — player props route
 * =========================================================================
 * GET /props/players?season=&week= — this week's (or any week's) player
 * prop lines, one row per (game, player, market), with real recent-form
 * context and a deterministic lean attached — same "no predictive
 * calculations" principle architecture.md §2 already states for /query:
 * this is a rule (recent average vs. the line, past a threshold) over
 * real numbers, not a probability model. Each row's edge_pct is a plain
 * descriptive ratio (how far the average clears the line, or the TD
 * rate clears 50/50) meant only for ranking within the frontend's
 * per-market list — it is NOT a confidence or win-probability score, and
 * is never presented as one. A genuine simulation/confidence-score model
 * (closer to what Chalk That MLB's Board does) is a deliberately
 * separate, backlogged follow-up — see docs/part2-roadmap.md.
 *
 * player_prop_odds (db/migrations/012_player_prop_odds.sql) is an
 * append-only time series, same as game_odds — this route picks the
 * latest synced_at per (game_id, player_id, bookmaker, market), same
 * DISTINCT ON pattern routes/odds.js already uses, and further narrows
 * to DraftKings specifically per (player, market) — same DK-only, no-
 * cross-book-fallback convention frontend/src/components/OddsBadge.jsx
 * already established for game odds ("highest-volume US book, a
 * reasonable default while there's no per-user preferred-book setting
 * yet"). A slate view showing every bookmaker's own line per player
 * would be noise for a first version; per-bookmaker comparison is easy
 * to add later once this is live.
 *
 * FIXED 2026-09-18 ("switch it to the default, DraftKings" request):
 * this originally picked from a BOOKMAKER_ORDER preference LIST via
 * indexOf() comparison, but any bookmaker not actually in that list
 * (e.g. the vendor's 'betonlineag', 'betrivers', 'fanatics' — never
 * added to the list) resolved to indexOf() === -1, which compared as
 * LOWER (i.e. higher priority) than every real entry in the list — so
 * an unlisted book always won over the intended betmgm/draftkings/
 * fanduel/bovada/williamhill_us order, which is why the board was
 * showing betonlineag instead. Replaced with a direct DraftKings filter
 * (real production data confirmed DK has full coverage across all 5
 * launch markets, so this isn't trading coverage for the fix).
 *
 * Final-game grading (2026-09-18, "show if the props hit" request) —
 * same idea frontend/src/components/OddsBadge.jsx already applies to
 * game-level odds ("lock the values when the game starts... and then
 * when finished, show what did hit"): once the game is final, this route
 * also hands back the player's ACTUAL stat line for this specific game
 * (final_value below) — not the last5 average context above, a real
 * single-game number — so the frontend can grade the locked line against
 * reality the same way OddsBadge grades a spread/total/moneyline, without
 * a second round trip. The grading itself (over/under/push, or scored/
 * no-TD) stays a frontend concern, same division of labor OddsBadge
 * already uses (backend hands over raw ingredients, frontend derives the
 * label) — kept here rather than in picks_log/grade_picks because a
 * prop board entry isn't a user's pick, it's the market's own line; there
 * is nothing to grade "correct/incorrect" against.
 *
 * PERFORMANCE FIX 2026-09-21 ("Props page takes several seconds on web
 * and iOS" report). attachContext() used to reuse stats-query.js's
 * queryPlayer() (via runStatsQuery, same "one source of truth" principle
 * /query and the chat agent's get_player_stats tool follow) once per
 * (player, market) DraftKings row, awaited serially in a plain for-loop.
 * CONFIRMED against real production data before assuming this was the
 * cause, not just theorized: this week's slate (2026 season, week 2, 15
 * games) has 920 distinct (player, market) DraftKings rows. Each one
 * paid for up to 3 sequential round trips inside runStatsQuery/
 * queryPlayer — a `SELECT position_group FROM players` lookup, the
 * actual last5/game_log stat query, and a getFreshness
 * ('sync_historical_stats') call whose result this route never even
 * read (attachContext only used result.data/result.sampleSize) — plus a
 * 4th query per row once a game goes final. That's ~2,600-3,600
 * sequential, awaited Postgres round trips for one page load. Existing
 * indexes (idx_player_offense_player_id, the (game_id, player_id)
 * primary key) were confirmed fine — this was a round-trip-count
 * problem, not a slow-query problem. Both web (PropsPage.jsx) and the
 * iOS app's PropsView call this exact same endpoint, so the fix here
 * covers both clients without any change on either.
 *
 * Fixed by replacing the per-row reuse of queryPlayer() with two
 * purpose-built BATCHED queries covering the whole slate at once
 * (batchRecentForm()/batchFinalValues() below), plus carrying
 * position_group on this route's own existing players JOIN instead of a
 * separate per-player lookup. This is a deliberate, scoped exception to
 * the "one source of truth" reuse convention — stats-query.js's
 * queryPlayer() stays the real source of truth for the single-player
 * /query route and the chat agent's tool, which don't have this route's
 * "same handful of games' worth of players, computed hundreds of times
 * over in one request" shape; duplicating (not modifying) the last5/
 * game_log logic here, batched, is the honest tradeoff. Net effect: 2
 * queries total for context-attachment, regardless of slate size,
 * instead of up to ~3,600 — the main players JOIN already covers
 * position_group and the per-row position lookup that used to require.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// Same single-bookmaker convention OddsBadge.jsx already uses for game
// odds — kept in sync manually (one string) rather than sharing a
// module across frontend/backend for it.
const DRAFTKINGS_KEY = 'draftkings';

// market -> which *_game_stats column (via stats-query.js's offense
// group — every one of these 5 markets happens to be an offensive stat)
// backs its recent-form comparison, and how to read a game's raw stat
// row into "did this market hit" for the anytime_td rate below.
const MARKET_STAT_COLUMN = {
  player_pass_yds: 'passing_yards',
  player_rush_yds: 'rushing_yards',
  player_reception_yds: 'receiving_yards',
  player_receptions: 'receptions',
};

const MARKET_LABEL = {
  player_pass_yds: 'Passing Yards',
  player_rush_yds: 'Rushing Yards',
  player_reception_yds: 'Receiving Yards',
  player_receptions: 'Receptions',
  player_anytime_td: 'Anytime TD',
};

// How far the recent average has to clear the line before this calls it
// a lean rather than a toss-up — a player averaging 51.5 on a 50.5 line
// isn't a real signal, that's noise. 8% of the line, floored at 1 unit,
// mirrors how thin a real edge normally has to be to matter here.
// edgePct is a plain descriptive ratio (how far the average clears the
// line, as a fraction of the line) — NOT a probability or confidence
// score. It exists so the frontend can rank props by how far a real
// number sits from the market's line, same deterministic spirit as the
// lean itself; it makes no claim about how likely the pick is to hit.
function leanFromAverage(recentAvg, line) {
  if (recentAvg == null || line == null) return { lean: null, reasoning: null, edgePct: null };
  const threshold = Math.max(1, Math.abs(line) * 0.08);
  const diff = recentAvg - line;
  const edgePct = Math.abs(diff) / Math.max(1, Math.abs(line));
  if (Math.abs(diff) < threshold) {
    return {
      lean: 'toss_up',
      reasoning: `L5 avg of ${recentAvg.toFixed(1)} sits within range of the ${line} line — no real signal either way.`,
      edgePct,
    };
  }
  const lean = diff > 0 ? 'over' : 'under';
  return {
    lean,
    reasoning: `L5 avg of ${recentAvg.toFixed(1)} is ${Math.abs(diff).toFixed(1)} ${diff > 0 ? 'above' : 'below'} the ${line} line.`,
    edgePct,
  };
}

// Same idea as leanFromAverage's edgePct, just measured as distance from
// a 50/50 TD rate instead of distance from a line (anytime_td has no
// line to measure against).
function leanFromTdRate(tdRate, gamesPlayed) {
  if (tdRate == null || gamesPlayed === 0) return { lean: null, reasoning: null, edgePct: null };
  const pct = Math.round(tdRate * 100);
  const edgePct = Math.abs(tdRate - 0.5) * 2;
  if (tdRate >= 0.6) return { lean: 'over', reasoning: `Scored in ${pct}% of last ${gamesPlayed} games.`, edgePct };
  if (tdRate <= 0.2) return { lean: 'under', reasoning: `Scored in only ${pct}% of last ${gamesPlayed} games.`, edgePct };
  return { lean: 'toss_up', reasoning: `Scored in ${pct}% of last ${gamesPlayed} games — no clear signal.`, edgePct };
}

// Batched replacement for calling stats-query.js's queryPlayer() with
// scope 'last5' (yardage/receptions markets) and scope 'game_log'
// (anytime_td's TD-rate) once per player. One CTE, one pass over
// player_offense_game_stats for every offense player who has at least
// one DraftKings prop on this slate, instead of a separate query per
// player per market — a player with both a rush-yards prop and an
// anytime_td prop previously paid for two separate queries computing
// last5/game_log context off the exact same underlying rows.
//
// Only offense players are queried — every Props market is an
// offensive stat, so a non-offense player_id (would only happen from a
// data-quality issue; not expected in practice) just gets no
// recent-form context, same graceful-null result queryPlayer()'s own
// table/column mismatch already produced for that case before this fix.
//
// Returns Map<player_id, { gamesPlayed, avg: {passing_yards,
// rushing_yards, receiving_yards, receptions}, tdGames }>. tdGames is
// "scored in this many of the last 5" — leanFromTdRate's caller divides
// by gamesPlayed itself, same math the original per-player game_log
// path did in JS.
async function batchRecentForm(playerIds, season) {
  const out = new Map();
  if (playerIds.length === 0) return out;

  const { rows } = await query(
    `WITH recent AS (
       SELECT stats.player_id, stats.passing_yards, stats.rushing_yards,
              stats.receiving_yards, stats.receptions,
              stats.rushing_tds, stats.receiving_tds, stats.passing_tds,
              ROW_NUMBER() OVER (PARTITION BY stats.player_id ORDER BY g.game_datetime DESC) AS rn
       FROM player_offense_game_stats stats
       JOIN games g ON g.game_id = stats.game_id
       WHERE stats.player_id = ANY($1::uuid[]) AND g.season = $2
     )
     SELECT player_id,
            COUNT(*)::int AS games_played,
            AVG(passing_yards)::float8 AS passing_yards,
            AVG(rushing_yards)::float8 AS rushing_yards,
            AVG(receiving_yards)::float8 AS receiving_yards,
            AVG(receptions)::float8 AS receptions,
            COUNT(*) FILTER (
              WHERE COALESCE(rushing_tds, 0) + COALESCE(receiving_tds, 0) + COALESCE(passing_tds, 0) > 0
            )::int AS td_games
     FROM recent
     WHERE rn <= 5
     GROUP BY player_id`,
    [playerIds, season]
  );

  for (const r of rows) {
    out.set(r.player_id, {
      gamesPlayed: r.games_played,
      avg: {
        passing_yards: r.passing_yards,
        rushing_yards: r.rushing_yards,
        receiving_yards: r.receiving_yards,
        receptions: r.receptions,
      },
      tdGames: r.td_games,
    });
  }
  return out;
}

// Batched replacement for the per-row "is this game final, and if so
// what did this player actually do" lookup — one query covering every
// (game_id, player_id) pair that needs grading instead of one query per
// prop row (a player with two final-game props previously paid for this
// same row twice). Returns Map<"game_id|player_id", raw stat row> with
// columns left un-COALESCEd, same as the raw table — callers COALESCE
// to 0 themselves per-market below, same "a NULL column on a row that
// exists means a real 0, not unknown" reasoning the 2026-09-18 grading
// fix established (see this file's other header comment).
async function batchFinalValues(gameIds, playerIds) {
  const out = new Map();
  if (gameIds.length === 0 || playerIds.length === 0) return out;

  const { rows } = await query(
    `SELECT game_id, player_id, passing_yards, rushing_yards, receiving_yards,
            receptions, rushing_tds, receiving_tds, passing_tds
     FROM player_offense_game_stats
     WHERE game_id = ANY($1::varchar[]) AND player_id = ANY($2::uuid[])`,
    [gameIds, playerIds]
  );

  for (const r of rows) out.set(`${r.game_id}|${r.player_id}`, r);
  return out;
}

// Picks DraftKings's row per (player, market) — see header comment for
// why a single book rather than a preference list — then attaches
// recent-form context + a deterministic lean, using the two batched
// queries above instead of a per-row lookup. A player DraftKings hasn't
// posted this market for yet just doesn't appear, same graceful-
// omission convention OddsBadge.jsx uses ("renders nothing until
// DraftKings has actually posted a line").
async function attachContext(rows, season) {
  const byPlayerMarket = new Map();
  for (const r of rows) {
    if (r.bookmaker !== DRAFTKINGS_KEY) continue;
    const key = `${r.player_id}|${r.market}`;
    byPlayerMarket.set(key, r);
  }
  const picked = [...byPlayerMarket.values()];

  // Gather every batch's real inputs up front — which offense players
  // need recent-form context, and which (game_id, player_id) pairs need
  // a final grade — before issuing either query, instead of discovering
  // them row-by-row the way the old per-row loop did.
  const recentFormPlayerIds = new Set();
  const finalGameIds = new Set();
  const finalPlayerIds = new Set();
  for (const r of picked) {
    if (r.position_group === 'offense') recentFormPlayerIds.add(r.player_id);
    if (r.game_status === 'final') {
      finalGameIds.add(r.game_id);
      finalPlayerIds.add(r.player_id);
    }
  }

  const [recentForm, finalValues] = await Promise.all([
    batchRecentForm([...recentFormPlayerIds], season),
    batchFinalValues([...finalGameIds], [...finalPlayerIds]),
  ]);

  const out = [];
  for (const r of picked) {
    const base = {
      game_id: r.game_id,
      market: r.market,
      market_label: MARKET_LABEL[r.market],
      bookmaker: r.bookmaker,
      line: r.line,
      over_price: r.over_price,
      under_price: r.under_price,
      bookmaker_last_update: r.bookmaker_last_update,
      synced_at: r.synced_at,
      game_status: r.game_status,
      player: { player_id: r.player_id, full_name: r.full_name, position: r.position, team_id: r.team_id },
    };

    let finalValue = null;
    if (r.game_status === 'final') {
      const statRow = finalValues.get(`${r.game_id}|${r.player_id}`);
      if (statRow) {
        if (r.market === 'player_anytime_td') {
          const tds =
            Number(statRow.rushing_tds ?? 0) + Number(statRow.receiving_tds ?? 0) + Number(statRow.passing_tds ?? 0);
          finalValue = tds > 0 ? 1 : 0;
        } else if (MARKET_STAT_COLUMN[r.market]) {
          finalValue = Number(statRow[MARKET_STAT_COLUMN[r.market]] ?? 0);
        }
      }
    }
    base.final_value = finalValue;

    const statColumn = MARKET_STAT_COLUMN[r.market];
    const form = recentForm.get(r.player_id);

    if (statColumn) {
      const recentAvg = form ? form.avg[statColumn] : null;
      const { lean, reasoning, edgePct } = leanFromAverage(
        Number.isFinite(recentAvg) ? recentAvg : null,
        r.line != null ? Number(r.line) : null
      );
      out.push({
        ...base,
        context: { recent_avg: Number.isFinite(recentAvg) ? recentAvg : null, games_played: form?.gamesPlayed ?? 0 },
        lean,
        reasoning,
        edge_pct: edgePct,
      });
    } else {
      // player_anytime_td: no single stat column or line to compare —
      // lean off how often the player scored ANY touchdown (rushing +
      // receiving + passing, any of them) in their last 5 games instead.
      const gamesPlayed = form?.gamesPlayed ?? 0;
      const tdRate = gamesPlayed > 0 ? form.tdGames / gamesPlayed : null;
      const { lean, reasoning, edgePct } = leanFromTdRate(tdRate, gamesPlayed);
      out.push({
        ...base,
        context: { recent_avg: null, games_played: gamesPlayed, td_rate: tdRate },
        lean,
        reasoning,
        edge_pct: edgePct,
      });
    }
  }

  return out;
}

router.get('/players', async (req, res) => {
  const { season, week } = req.query;

  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (week !== undefined && !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week must be a 1-2 digit number' });
  }

  try {
    const params = [parseInt(season, 10)];
    let weekFilter = '';
    if (week !== undefined) {
      params.push(parseInt(week, 10));
      weekFilter = `AND g.week = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT DISTINCT ON (ppo.game_id, ppo.player_id, ppo.bookmaker, ppo.market)
              ppo.*, p.full_name, p.position, p.position_group, p.current_team_id AS team_id, g.status AS game_status
       FROM player_prop_odds ppo
       JOIN games g ON g.game_id = ppo.game_id
       JOIN players p ON p.player_id = ppo.player_id
       WHERE g.season = $1 ${weekFilter}
         AND (g.status NOT IN ('in_progress', 'final') OR ppo.synced_at <= g.game_datetime)
       ORDER BY ppo.game_id, ppo.player_id, ppo.bookmaker, ppo.market, ppo.synced_at DESC`,
      params
    );

    const data = await attachContext(rows, parseInt(season, 10));
    const freshness = await getFreshness('sync_player_props');
    res.json({ data, meta: { sample_size: data.length, freshness } });
  } catch (err) {
    console.error('[routes/props] players lookup failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

async function getFreshness(jobType) {
  const { rows } = await query(
    `SELECT finished_at FROM ingestion_runs
     WHERE job_type = $1 AND status = 'success'
     ORDER BY finished_at DESC LIMIT 1`,
    [jobType]
  );
  return { synced_at: rows[0]?.finished_at || null };
}

module.exports = router;
