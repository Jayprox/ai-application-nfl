/**
 * Chalk That NFL — trend/streak agent
 * =========================================================================
 * "Which players are on a real current streak against the actual
 * DraftKings line" (2026-09-30 brainstorm, "keep it algorithmic" —
 * explicitly requested to use REAL market lines rather than a Chalk-
 * That-invented threshold, so a trend here means the same thing it
 * would mean to anyone reading the Props page: did the real number
 * clear the real line DraftKings posted before kickoff).
 *
 * Grading is a direct port of frontend/src/pages/PropsPage.jsx's own
 * gradeProp() — same over/under/push rule off a locked pregame line, or
 * scored/no_td for player_anytime_td (which has no line at all) — so a
 * streak here always means the exact same "hit" a user already sees
 * on that page, not a second, slightly different definition.
 *
 * Line source: player_prop_odds (db/migrations/012_player_prop_odds.sql),
 * same "latest DraftKings snapshot synced before kickoff" convention
 * routes/props.js already established (ppo.synced_at <= g.game_datetime)
 * -- a line that moved after kickoff was never the number the game
 * actually played out against.
 *
 * Deliberately its own small agent (lib + route), not folded into the
 * shared /query engine — same reasoning routes/rankings.js and
 * routes/props.js already give for being their own routes: this reads
 * a genuinely different shape (a temporal walk over graded games, not a
 * single aggregate or a per-entity drill-down) than what /query's
 * runStatsQuery()/queryLeaderboard() answer.
 * =========================================================================
 */

const { query } = require('../db');

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

const VALID_MARKETS = Object.keys(MARKET_LABEL);
const DRAFTKINGS_KEY = 'draftkings';

// A streak shorter than this isn't really a "trend" yet -- 1 game is
// just last week's result, not a pattern.
const MIN_STREAK = 2;

function directionsFor(market) {
  return market === 'player_anytime_td' ? ['scored', 'no_td'] : ['over', 'under'];
}

// Ported verbatim from PropsPage.jsx's gradeProp() (see that file for
// the original) -- same real-vs-line comparison, same push rule, same
// "any TD counts" anytime_td rule. Kept as a small pure function so it
// can be spot-checked independently of the SQL around it.
function gradeGame(market, line, statRow) {
  if (market === 'player_anytime_td') {
    const tds =
      Number(statRow.rushing_tds ?? 0) + Number(statRow.receiving_tds ?? 0) + Number(statRow.passing_tds ?? 0);
    return tds > 0 ? 'scored' : 'no_td';
  }
  const column = MARKET_STAT_COLUMN[market];
  const actual = Number(statRow[column] ?? 0);
  const lineNum = Number(line);
  if (actual === lineNum) return 'push';
  return actual > lineNum ? 'over' : 'under';
}

// Real DraftKings-graded (game, line, actual stat line) rows for every
// player who had this market posted at least once this season, final
// games only (a streak can only be built from games that actually
// finished). One query, not one per player -- same batching principle
// routes/props.js's batchRecentForm/batchFinalValues already established
// for exactly this "same handful of rows, computed once, not per-player"
// shape.
async function gradedGames({ market, season }) {
  const { rows } = await query(
    `SELECT DISTINCT ON (ppo.player_id, ppo.game_id)
            ppo.player_id, ppo.game_id, ppo.line, g.game_datetime, g.week,
            p.full_name, p.position, t.abbreviation AS team,
            s.passing_yards, s.rushing_yards, s.receiving_yards, s.receptions,
            s.rushing_tds, s.receiving_tds, s.passing_tds
       FROM player_prop_odds ppo
       JOIN games g ON g.game_id = ppo.game_id
       JOIN players p ON p.player_id = ppo.player_id
       JOIN player_offense_game_stats s ON s.game_id = ppo.game_id AND s.player_id = ppo.player_id
       JOIN teams t ON t.team_id = s.team_id
      WHERE ppo.bookmaker = $1 AND ppo.market = $2
        AND g.season = $3 AND g.status = 'final' AND ppo.synced_at <= g.game_datetime
      ORDER BY ppo.player_id, ppo.game_id, ppo.synced_at DESC`,
    [DRAFTKINGS_KEY, market, season]
  );
  return rows;
}

// Walks each player's real graded games most-recent-first and counts
// how many in a row match `direction` before the first break (an
// opposite result, or a push, which is neither an over nor an under and
// so always ends a streak rather than extending it either way).
async function currentStreaks({ market, season, direction, limit }) {
  const rows = await gradedGames({ market, season });

  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) {
      byPlayer.set(r.player_id, { full_name: r.full_name, position: r.position, team: r.team, games: [] });
    }
    byPlayer.get(r.player_id).games.push(r);
  }

  const results = [];
  for (const [playerId, info] of byPlayer) {
    info.games.sort((a, b) => new Date(a.game_datetime) - new Date(b.game_datetime));
    let streak = 0;
    let throughWeek = null;
    let lastValue = null;
    for (let i = info.games.length - 1; i >= 0; i--) {
      const g = info.games[i];
      const grade = gradeGame(market, g.line, g);
      if (grade !== direction) break;
      streak++;
      if (throughWeek === null) {
        throughWeek = g.week;
        lastValue = market === 'player_anytime_td' ? null : Number(g[MARKET_STAT_COLUMN[market]] ?? 0);
      }
    }
    if (streak >= MIN_STREAK) {
      results.push({
        player_id: playerId,
        full_name: info.full_name,
        position: info.position,
        team: info.team,
        streak,
        through_week: throughWeek,
        last_line: market === 'player_anytime_td' ? null : Number(info.games[info.games.length - 1]?.line ?? null),
        last_value: lastValue,
      });
    }
  }

  results.sort((a, b) => b.streak - a.streak || a.full_name.localeCompare(b.full_name));
  return results.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
}

module.exports = { currentStreaks, gradeGame, directionsFor, MARKET_LABEL, VALID_MARKETS, DRAFTKINGS_KEY, MIN_STREAK };
