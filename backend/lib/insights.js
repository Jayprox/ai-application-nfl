/**
 * Chalk That NFL — deterministic insight layer
 * =========================================================================
 * Part 2 Phase 1 (docs/part2-roadmap.md). This is deliberately NOT part of
 * POST /query — architecture.md §2 is explicit that /query does "no
 * predictive calculations," so a derived label/note layer needs its own
 * home, same as how MLB's /api/splits is a separate endpoint from its raw
 * stat endpoints (see chalk-that-mlb-research-notes.md §2/§4).
 *
 * Every category here is a plain SQL aggregation + a threshold rule, no
 * LLM involved, computed at request time (same "computed fresh, no
 * predictive model" spirit as /query — this only differs from /query in
 * that it also attaches a controlled-vocabulary label + a templated
 * sentence on top of numbers that were already fair game).
 *
 * Scope, honestly (see the roadmap discussion this was scoped against):
 * nflverse's free data here is game-level box-score aggregates, not
 * play-by-play — there's no target depth, air yards, or route type, and
 * no offensive-line-level attribution for sacks allowed. So all four
 * categories below are built ONLY from what's already ingested
 * (player_offense_game_stats, player_defense_game_stats, team_game_stats,
 * games) — nothing here assumes data that isn't actually flowing yet.
 * Target-depth/route-type splits are real and worth having eventually,
 * but need a new nflverse play-by-play ingestion job — explicitly out of
 * scope for this first pass rather than faked with box-score data.
 *
 * The four categories:
 *   1. matchup       — this player's position vs. what the *next*
 *                       opponent's defense allows that position,
 *                       season-to-date, vs. league average allowed.
 *                       Offensive skill positions only (QB/RB/FB/HB/WR/TE)
 *                       — a defensive equivalent (e.g. pressure rate vs. a
 *                       specific pass-block unit) needs O-line-level
 *                       attribution this schema doesn't have, so defense
 *                       and special-teams players get label: null here.
 *   2. recent_form    — last-3-games average vs. this player's own
 *                       season average (MLB's hot/cold-streak equivalent).
 *   3. situational     — this player's stat average in their next game's
 *                       home/away or game_slot context vs. their own
 *                       season average — reuses the exact split
 *                       dimensions POST /query already supports
 *                       (architecture.md §3). Whichever dimension has an
 *                       adequate sample (>=2 games) and the larger
 *                       deviation is reported; weather isn't used here
 *                       since it's usually still NULL for games this far
 *                       out (see sync_forecast_weather's proximity
 *                       schedule).
 *   4. role_trend      — last-3-games volume stat (targets/carries/
 *                       attempts/tackle involvement) vs. the 3 games
 *                       before that, i.e. whether a player's role is
 *                       trending up or down.
 *
 * Every category can legitimately come back with label: null (not enough
 * games played yet, no scheduled next game, special-teams position, etc)
 * — same "graceful empty state over a fake answer" philosophy /query
 * already follows for sample_size: 0.
 * =========================================================================
 */

const { query } = require('../db');

// position -> which *_game_stats table/column pair drives categories 2-4.
// Defense positions all fall back to the combined tackles_solo+tackles_assist
// expression below rather than getting their own row here (see DEFENSE_STAT).
const POSITION_STAT_MAP = {
  QB: { table: 'player_offense_game_stats', primaryCol: 'passing_yards', volumeCol: 'pass_attempts', statLabel: 'passing yards' },
  RB: { table: 'player_offense_game_stats', primaryCol: 'rushing_yards', volumeCol: 'rush_attempts', statLabel: 'rushing yards' },
  FB: { table: 'player_offense_game_stats', primaryCol: 'rushing_yards', volumeCol: 'rush_attempts', statLabel: 'rushing yards' },
  HB: { table: 'player_offense_game_stats', primaryCol: 'rushing_yards', volumeCol: 'rush_attempts', statLabel: 'rushing yards' },
  WR: { table: 'player_offense_game_stats', primaryCol: 'receiving_yards', volumeCol: 'targets', statLabel: 'receiving yards' },
  TE: { table: 'player_offense_game_stats', primaryCol: 'receiving_yards', volumeCol: 'targets', statLabel: 'receiving yards' },
};

// Defense: no single nflverse column captures "involvement" the way
// receiving_yards does for a WR, so this combines solo + assisted tackles
// into one expression. Coarser than the offense mapping on purpose — see
// file header re: matchup being offense-only.
const DEFENSE_STAT = {
  table: 'player_defense_game_stats',
  primaryExpr: '(stats.tackles_solo + stats.tackles_assist)',
  volumeExpr: '(stats.tackles_solo + stats.tackles_assist)',
  statLabel: 'tackle involvement',
};

const SPECIAL_TEAMS_POSITIONS = new Set(['K', 'P', 'LS', 'KR', 'PR']);

function statConfigFor(position) {
  if (SPECIAL_TEAMS_POSITIONS.has(position)) return null;
  const offense = POSITION_STAT_MAP[position];
  if (offense) {
    return { table: offense.table, primaryExpr: `stats.${offense.primaryCol}`, volumeExpr: `stats.${offense.volumeCol}`, statLabel: offense.statLabel, isOffenseSkillPosition: true };
  }
  return { ...DEFENSE_STAT, isOffenseSkillPosition: false };
}

function ratioLabel(recent, baseline, { hotAt = 1.2, coldAt = 0.8, hotLabel, coldLabel, neutralLabel }) {
  if (baseline === 0) return neutralLabel;
  const ratio = recent / baseline;
  if (ratio >= hotAt) return hotLabel;
  if (ratio <= coldAt) return coldLabel;
  return neutralLabel;
}

// ---------------------------------------------------------------------
// 1. Matchup strength (offensive skill positions only — see file header)
// ---------------------------------------------------------------------

async function computeMatchup({ playerId, teamId, position, season, statConfig }) {
  if (!statConfig.isOffenseSkillPosition) {
    return { category: 'matchup', label: null, note: 'Matchup labels are scoped to offensive skill positions (QB/RB/FB/HB/WR/TE) in v1 — a defensive equivalent needs offensive-line-level attribution this app does not ingest.' };
  }
  if (!teamId) {
    return { category: 'matchup', label: null, note: 'Player has no current team on file.' };
  }

  const { rows: nextGameRows } = await query(
    `SELECT game_id, game_datetime,
            CASE WHEN home_team_id = $1 THEN away_team_id ELSE home_team_id END AS opponent_team_id
     FROM games
     WHERE (home_team_id = $1 OR away_team_id = $1) AND status = 'scheduled'
     ORDER BY game_datetime ASC LIMIT 1`,
    [teamId]
  );
  const nextGame = nextGameRows[0];
  if (!nextGame) {
    return { category: 'matchup', label: null, note: 'No scheduled upcoming game found for this player\'s team.' };
  }
  const opponentTeamId = nextGame.opponent_team_id;

  const { rows: oppRows } = await query(
    `SELECT g.game_id, SUM(${statConfig.primaryExpr}) AS allowed
     FROM games g
     JOIN ${statConfig.table} stats ON stats.game_id = g.game_id
     JOIN players p ON p.player_id = stats.player_id
     WHERE g.season = $1
       AND (g.home_team_id = $2 OR g.away_team_id = $2)
       AND stats.team_id != $2
       AND p.position = $3
     GROUP BY g.game_id`,
    [season, opponentTeamId, position]
  );
  if (!oppRows.length) {
    return { category: 'matchup', label: null, note: 'Opponent has no games played yet this season — not enough data for a matchup read.' };
  }
  const oppAvg = oppRows.reduce((sum, r) => sum + Number(r.allowed || 0), 0) / oppRows.length;

  const { rows: leagueRows } = await query(
    `SELECT SUM(${statConfig.primaryExpr}) AS total_allowed, COUNT(DISTINCT g.game_id) AS game_count
     FROM games g
     JOIN ${statConfig.table} stats ON stats.game_id = g.game_id
     JOIN players p ON p.player_id = stats.player_id
     WHERE g.season = $1 AND p.position = $2`,
    [season, position]
  );
  const gameCount = Number(leagueRows[0]?.game_count || 0);
  if (!gameCount) {
    return { category: 'matchup', label: null, note: 'Not enough league-wide games played yet this season for a matchup baseline.' };
  }
  // Each game is one defensive instance for each of the two teams playing
  // it, so total allowed leaguewide spreads across (games * 2) team-games.
  const leagueAvg = Number(leagueRows[0].total_allowed || 0) / (gameCount * 2);

  const label = ratioLabel(oppAvg, leagueAvg, {
    hotAt: 1.15, coldAt: 0.85,
    hotLabel: 'FAVORABLE_MATCHUP', coldLabel: 'TOUGH_MATCHUP', neutralLabel: 'NEUTRAL_MATCHUP',
  });
  const pctVsLeague = leagueAvg === 0 ? null : Math.round(((oppAvg - leagueAvg) / leagueAvg) * 100);
  const note = pctVsLeague === null
    ? `Opponent allows ${oppAvg.toFixed(1)} ${statConfig.statLabel} per game to this position.`
    : `Opponent allows ${oppAvg.toFixed(1)} ${statConfig.statLabel}/game to this position, ${pctVsLeague >= 0 ? pctVsLeague : -pctVsLeague}% ${pctVsLeague >= 0 ? 'above' : 'below'} league average.`;

  return { category: 'matchup', label, note };
}

// ---------------------------------------------------------------------
// 2. Recent form — last 3 games vs. this player's own season average
// ---------------------------------------------------------------------

const MIN_GAMES_FOR_FORM = 4;
const RECENT_WINDOW = 3;

async function computeRecentForm({ playerId, season, statConfig }) {
  const { rows } = await query(
    `SELECT g.game_datetime, ${statConfig.primaryExpr} AS val
     FROM ${statConfig.table} stats
     JOIN games g ON g.game_id = stats.game_id
     WHERE stats.player_id = $1 AND g.season = $2 AND g.status = 'final'
     ORDER BY g.game_datetime ASC`,
    [playerId, season]
  );
  if (rows.length < MIN_GAMES_FOR_FORM) {
    return { category: 'recent_form', label: null, note: `Only ${rows.length} game(s) played this season — not enough for a recent-form read (need ${MIN_GAMES_FOR_FORM}+).` };
  }

  const values = rows.map((r) => Number(r.val || 0));
  const seasonAvg = values.reduce((a, b) => a + b, 0) / values.length;
  const recentValues = values.slice(-RECENT_WINDOW);
  const recentAvg = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;

  const label = ratioLabel(recentAvg, seasonAvg, {
    hotAt: 1.2, coldAt: 0.8, hotLabel: 'HOT', coldLabel: 'COLD', neutralLabel: 'NEUTRAL',
  });
  const note = `Averaging ${recentAvg.toFixed(1)} ${statConfig.statLabel} over the last ${RECENT_WINDOW} games vs. a ${seasonAvg.toFixed(1)} season average.`;

  return { category: 'recent_form', label, note };
}

// ---------------------------------------------------------------------
// 3. Situational split strength — home/away or game_slot vs. season avg
// ---------------------------------------------------------------------

const MIN_GAMES_FOR_SPLIT = 2;
const SPLIT_THRESHOLD = 0.15; // +/-15% vs. season average to be worth labeling

async function splitAverage({ playerId, season, statConfig, whereExtra, params }) {
  const { rows } = await query(
    `SELECT ${statConfig.primaryExpr} AS val
     FROM ${statConfig.table} stats
     JOIN games g ON g.game_id = stats.game_id
     WHERE stats.player_id = $1 AND g.season = $2 AND g.status = 'final' ${whereExtra}`,
    [playerId, season, ...params]
  );
  if (!rows.length) return null;
  const values = rows.map((r) => Number(r.val || 0));
  return { avg: values.reduce((a, b) => a + b, 0) / values.length, sampleSize: values.length };
}

async function computeSituational({ playerId, teamId, season, statConfig }) {
  const seasonAll = await splitAverage({ playerId, season, statConfig, whereExtra: '', params: [] });
  if (!seasonAll || seasonAll.sampleSize < MIN_GAMES_FOR_FORM) {
    return { category: 'situational', label: null, note: 'Not enough games played this season for a situational read.' };
  }

  const { rows: nextGameRows } = await query(
    `SELECT game_slot, home_team_id, away_team_id
     FROM games
     WHERE (home_team_id = $1 OR away_team_id = $1) AND status = 'scheduled'
     ORDER BY game_datetime ASC LIMIT 1`,
    [teamId]
  );
  const nextGame = nextGameRows[0];
  if (!nextGame) {
    return { category: 'situational', label: null, note: 'No scheduled upcoming game found for this player\'s team.' };
  }
  const isHome = nextGame.home_team_id === teamId;

  const homeAwaySplit = await splitAverage({
    playerId, season, statConfig,
    whereExtra: 'AND stats.team_id = (CASE WHEN $3 THEN g.home_team_id ELSE g.away_team_id END)',
    params: [isHome],
  });
  const gameSlotSplit = await splitAverage({
    playerId, season, statConfig,
    whereExtra: 'AND g.game_slot = $3',
    params: [nextGame.game_slot],
  });

  const candidates = [];
  if (homeAwaySplit && homeAwaySplit.sampleSize >= MIN_GAMES_FOR_SPLIT) {
    candidates.push({ ...homeAwaySplit, contextLabel: isHome ? 'at home' : 'on the road' });
  }
  if (gameSlotSplit && gameSlotSplit.sampleSize >= MIN_GAMES_FOR_SPLIT) {
    candidates.push({ ...gameSlotSplit, contextLabel: `in ${nextGame.game_slot.replace(/_/g, ' ')} games` });
  }
  if (!candidates.length) {
    return { category: 'situational', label: null, note: 'Not enough games yet in this player\'s upcoming home/away or game-slot context for a reliable split.' };
  }

  // Prefer whichever candidate deviates furthest from the season average.
  const best = candidates.reduce((a, b) =>
    Math.abs(b.avg - seasonAll.avg) > Math.abs(a.avg - seasonAll.avg) ? b : a
  );
  const deviation = seasonAll.avg === 0 ? 0 : (best.avg - seasonAll.avg) / seasonAll.avg;

  let label = 'NEUTRAL';
  if (deviation >= SPLIT_THRESHOLD) label = 'STRONG';
  else if (deviation <= -SPLIT_THRESHOLD) label = 'WEAK';

  const note = `Averaging ${best.avg.toFixed(1)} ${statConfig.statLabel} ${best.contextLabel} this season (n=${best.sampleSize}) vs. a ${seasonAll.avg.toFixed(1)} season average.`;

  return { category: 'situational', label, note };
}

// ---------------------------------------------------------------------
// 4. Role/volume trend — last 3 games vs. the 3 games before that
// ---------------------------------------------------------------------

const MIN_GAMES_FOR_TREND = 2 * RECENT_WINDOW;

async function computeRoleTrend({ playerId, season, statConfig }) {
  const { rows } = await query(
    `SELECT g.game_datetime, ${statConfig.volumeExpr} AS val
     FROM ${statConfig.table} stats
     JOIN games g ON g.game_id = stats.game_id
     WHERE stats.player_id = $1 AND g.season = $2 AND g.status = 'final'
     ORDER BY g.game_datetime ASC`,
    [playerId, season]
  );
  if (rows.length < MIN_GAMES_FOR_TREND) {
    return { category: 'role_trend', label: null, note: `Only ${rows.length} game(s) played this season — need ${MIN_GAMES_FOR_TREND}+ for a role-trend read.` };
  }

  const values = rows.map((r) => Number(r.val || 0));
  const recent = values.slice(-RECENT_WINDOW);
  const prior = values.slice(-2 * RECENT_WINDOW, -RECENT_WINDOW);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;

  const label = ratioLabel(recentAvg, priorAvg, {
    hotAt: 1.2, coldAt: 0.8, hotLabel: 'INCREASING', coldLabel: 'DECREASING', neutralLabel: 'STEADY',
  });
  const note = `Volume trend: ${recentAvg.toFixed(1)}/game over the last ${RECENT_WINDOW} games vs. ${priorAvg.toFixed(1)}/game the ${RECENT_WINDOW} before that.`;

  return { category: 'role_trend', label, note };
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

async function computePlayerInsights(playerId, season) {
  const { rows: playerRows } = await query(
    'SELECT position, current_team_id FROM players WHERE player_id = $1',
    [playerId]
  );
  const player = playerRows[0];
  if (!player) return null;

  const statConfig = statConfigFor(player.position);
  if (!statConfig) {
    const note = 'Insight labels are not scored for special-teams positions in v1.';
    return {
      insights: ['matchup', 'recent_form', 'situational', 'role_trend'].map((category) => ({ category, label: null, note })),
    };
  }

  const args = { playerId, teamId: player.current_team_id, position: player.position, season, statConfig };
  const [matchup, recentForm, situational, roleTrend] = await Promise.all([
    computeMatchup(args),
    computeRecentForm(args),
    computeSituational(args),
    computeRoleTrend(args),
  ]);

  return { insights: [matchup, recentForm, situational, roleTrend] };
}

module.exports = { computePlayerInsights };
