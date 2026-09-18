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
 * to one representative bookmaker per (player, market) using the same
 * BOOKMAKER preference order the frontend's GameDetailPage.jsx already
 * displays (first available wins) — a slate view showing every
 * bookmaker's own line per player would be noise for a first version;
 * per-bookmaker comparison is easy to add later once this is live.
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

// Same bookmaker allowlist + preference order GameDetailPage.jsx already
// uses for game odds — kept in sync manually (small, stable list) rather
// than sharing a module across frontend/backend for five strings.
const BOOKMAKER_ORDER = ['betmgm', 'draftkings', 'fanduel', 'bovada', 'williamhill_us'];

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

// Picks one representative bookmaker's row per (player, market) using
// BOOKMAKER_ORDER's preference, then attaches recent-form context + a
// deterministic lean. Runs the stats-query lookup once per (player,
// market) pair actually present, not once per raw odds row — a player
// offered by 4 books for the same market only costs one lookup.
async function attachContext(rows, season) {
  const byPlayerMarket = new Map();
  for (const r of rows) {
    const key = `${r.player_id}|${r.market}`;
    const existing = byPlayerMarket.get(key);
    if (!existing || BOOKMAKER_ORDER.indexOf(r.bookmaker) < BOOKMAKER_ORDER.indexOf(existing.bookmaker)) {
      byPlayerMarket.set(key, r);
    }
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
    // this is the ONE specific game this prop is for. No row (DNP,
    // inactive, vendor gap) leaves final_value null — same "can't grade,
    // don't guess" stance grade_picks' own void case takes.
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
          `SELECT ${MARKET_STAT_COLUMN[r.market]} AS value FROM player_offense_game_stats WHERE game_id = $1 AND player_id = $2`,
          [r.game_id, r.player_id]
        );
        finalValue = finalRows.length && finalRows[0].value !== null ? Number(finalRows[0].value) : null;
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
