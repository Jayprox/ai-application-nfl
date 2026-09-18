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
 * Recent-form context reuses backend/lib/stats-query.js's queryPlayer()
 * (via runStatsQuery, scope 'last5') rather than re-deriving an average
 * here — same "one source of truth" principle the rest of this app
 * follows for stats.
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
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');
const { runStatsQuery } = require('../lib/stats-query');

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

// Picks DraftKings's row per (player, market) — see header comment for
// why a single book rather than a preference list — then attaches
// recent-form context + a deterministic lean. Runs the stats-query
// lookup once per (player, market) pair actually present, not once per
// raw odds row. A player DraftKings hasn't posted this market for yet
// just doesn't appear, same graceful-omission convention OddsBadge.jsx
// uses ("renders nothing until DraftKings has actually posted a line").
async function attachContext(rows, season) {
  const byPlayerMarket = new Map();
  for (const r of rows) {
    if (r.bookmaker !== DRAFTKINGS_KEY) continue;
    const key = `${r.player_id}|${r.market}`;
    byPlayerMarket.set(key, r);
  }

  const picked = [...byPlayerMarket.values()];
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

    // Only fetch a real per-game value once the game is actually final —
    // same gate OddsBadge.jsx uses ("status === 'final'") before grading
    // anything. Distinct from the recent_avg/td_rate context below (which
    // always covers the player's last 5 PAST games, an over-time trend),
    // this is the ONE specific game this prop is for. No ROW AT ALL (DNP,
    // inactive, unresolved vendor name) leaves final_value null — same
    // "can't grade, don't guess" stance grade_picks' own void case takes.
    //
    // FIXED 2026-09-18 ("TOSS-UP badges never finalize" report): a row
    // existing is not the same as every column on it being non-null —
    // Highlightly's box score OMITS an entire stat group (Passing/
    // Rushing/Receiving/General) for a player rather than reporting an
    // explicit 0, whenever that player recorded nothing in it. CONFIRMED
    // directly against the real DET@BUF 2026-09-18 box score: TE Brock
    // Wright's entry carries only a General group (0 fumbles, 1 recovered
    // fumble) — no Receiving group at all, because he had zero targets —
    // so his player_offense_game_stats row exists (the General stat
    // created it) but targets/receptions/receiving_yards all land NULL,
    // not because we don't know his receiving line, but because it's
    // genuinely 0. The old code treated that column-level NULL the same
    // as "no row" and left final_value null, so the card fell back to the
    // pregame TOSS-UP LeanBadge forever — indistinguishable from a game
    // that hadn't started. Now COALESCEd to 0 here, same as the
    // anytime_td branch already did for exactly this reason (its rushing_
    // tds/receiving_tds/passing_tds COALESCE was already correct — this
    // just brings the other 4 markets in line with it). A genuinely
    // unresolved player (no row at all — no stat category matched him in
    // this game) still leaves final_value null and still renders as a
    // real void state, not a false Under.
    let finalValue = null;
    if (r.game_status === 'final') {
      if (r.market === 'player_anytime_td') {
        const { rows: finalRows } = await query(
          `SELECT (COALESCE(rushing_tds, 0) + COALESCE(receiving_tds, 0) + COALESCE(passing_tds, 0)) AS value
           FROM player_offense_game_stats WHERE game_id = $1 AND player_id = $2`,
          [r.game_id, r.player_id]
        );
        finalValue = finalRows.length ? (Number(finalRows[0].value) > 0 ? 1 : 0) : null;
      } else if (MARKET_STAT_COLUMN[r.market]) {
        const { rows: finalRows } = await query(
          `SELECT COALESCE(${MARKET_STAT_COLUMN[r.market]}, 0) AS value FROM player_offense_game_stats WHERE game_id = $1 AND player_id = $2`,
          [r.game_id, r.player_id]
        );
        finalValue = finalRows.length ? Number(finalRows[0].value) : null;
      }
    }
    base.final_value = finalValue;

    const statColumn = MARKET_STAT_COLUMN[r.market];
    if (statColumn) {
      const result = await runStatsQuery({ entity_type: 'player', entity_id: r.player_id, scope: 'last5', season });
      const recentAvg = result.data ? Number(result.data[statColumn]) : null;
      const { lean, reasoning, edgePct } = leanFromAverage(Number.isFinite(recentAvg) ? recentAvg : null, r.line != null ? Number(r.line) : null);
      out.push({
        ...base,
        context: { recent_avg: Number.isFinite(recentAvg) ? recentAvg : null, games_played: result.sampleSize ?? 0 },
        lean,
        reasoning,
        edge_pct: edgePct,
      });
    } else {
      // player_anytime_td: no single stat column or line to compare —
      // lean off how often the player scored ANY touchdown (rushing +
      // receiving + passing, any of them) in their last 5 games instead.
      const result = await runStatsQuery({ entity_type: 'player', entity_id: r.player_id, scope: 'game_log', season });
      const games = (result.data || []).slice(0, 5);
      const tdGames = games.filter(
        (g) => Number(g.rushing_tds || 0) + Number(g.receiving_tds || 0) + Number(g.passing_tds || 0) > 0
      ).length;
      const tdRate = games.length > 0 ? tdGames / games.length : null;
      const { lean, reasoning, edgePct } = leanFromTdRate(tdRate, games.length);
      out.push({
        ...base,
        context: { recent_avg: null, games_played: games.length, td_rate: tdRate },
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
              ppo.*, p.full_name, p.position, p.current_team_id AS team_id, g.status AS game_status
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
