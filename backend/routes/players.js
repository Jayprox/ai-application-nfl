/**
 * Chalk That NFL — Player routes
 * =========================================================================
 * GET /players       search/list players — ?name=, ?team=(abbreviation),
 *                     ?position_group=offense|defense|special_teams,
 *                     ?active_only=true
 * GET /players/:id    one player's identity/bio (current team, position,
 *                      status, draft info). Deliberately does NOT include
 *                      stats here — stats/splits go through POST /query,
 *                      the one shared query engine, rather than this route
 *                      duplicating that logic. Keeps "one query engine,
 *                      multiple callers" (architecture.md §2) honest.
 *
 * active_only (2026-09-16): PlayerBrowsePage.jsx's "Players active in
 * 2026" checkbox, on by default. Same current_team_id/status IN
 * ('ACT','RES') + 2-day freshness definition routes/teams.js's own
 * roster query already uses for "on a team's roster right now" — kept
 * as a checkbox rather than baked in permanently so a free agent or
 * recently-cut player (e.g. someone worth checking before a potential
 * re-signing) is still findable by unchecking it, rather than removed
 * from search entirely. Nothing else reads this param: every
 * algorithmic path (matchup-score.js, insights.js, ranking.js, edge.js)
 * queries the players table directly, never through this route, so
 * scores/insights keep including every player regardless of this
 * filter. The existing stat-history filter below (added the same day,
 * before this one) is unaffected either way — a player with zero
 * recorded games across 2021-2026 has an empty detail page whether or
 * not they're currently rostered, so that part isn't optional.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

const MAX_RESULTS = 100;

router.get('/', async (req, res) => {
  const { name, team, position_group, active_only } = req.query;

  const conditions = [];
  const params = [];

  if (name) {
    params.push(`%${name}%`);
    conditions.push(`p.full_name ILIKE $${params.length}`);
  }
  if (team) {
    params.push(team.toUpperCase());
    conditions.push(`t.abbreviation = $${params.length}`);
  }
  if (position_group) {
    if (!['offense', 'defense', 'special_teams'].includes(position_group)) {
      return res.status(400).json({ error: 'position_group must be one of: offense, defense, special_teams' });
    }
    params.push(position_group);
    conditions.push(`p.position_group = $${params.length}`);
  }
  // See "active_only" in this file's header comment.
  if (active_only === 'true') {
    conditions.push(`p.current_team_id IS NOT NULL AND p.status IN ('ACT', 'RES') AND p.updated_at > now() - interval '2 days'`);
  }

  // Stat-history filter (2026-09-16), same reasoning and same three
  // stat tables as routes/teams.js's roster query: don't surface a
  // player anywhere browsable in the app if they have zero recorded
  // games across the whole 2021-2026 window this app tracks -- their
  // detail page has nothing on it. This is the other browsable listing
  // besides the team roster (PlayerBrowsePage.jsx's search/filter UI),
  // so it needs the identical filter or a stat-less player would still
  // be discoverable here even after dropping off their team's roster.
  const statHistoryClause = `(
    EXISTS (SELECT 1 FROM player_offense_game_stats pos WHERE pos.player_id = p.player_id)
    OR EXISTS (SELECT 1 FROM player_defense_game_stats pds WHERE pds.player_id = p.player_id)
    OR EXISTS (SELECT 1 FROM player_special_teams_game_stats pst WHERE pst.player_id = p.player_id)
  )`;
  const whereClause = `WHERE ${[...conditions, statHistoryClause].join(' AND ')}`;

  try {
    const { rows } = await query(
      `SELECT p.player_id, p.full_name, p.position, p.position_group, p.status,
              t.team_id, t.abbreviation AS team_abbreviation
       FROM players p
       LEFT JOIN teams t ON t.team_id = p.current_team_id
       ${whereClause}
       ORDER BY p.full_name
       LIMIT ${MAX_RESULTS}`,
      params
    );
    res.json({ data: rows, meta: { count: rows.length, limit: MAX_RESULTS } });
  } catch (err) {
    console.error('[routes/players] search failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await query(
      `SELECT p.player_id, p.full_name, p.first_name, p.last_name, p.position,
              p.position_group, p.status, p.birth_date, p.draft_year, p.draft_round, p.draft_pick,
              t.team_id, t.abbreviation AS team_abbreviation, t.name AS team_name
       FROM players p
       LEFT JOIN teams t ON t.team_id = p.current_team_id
       WHERE p.player_id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'player not found' });

    const { rows: injuryRows } = await query(
      `SELECT report_status, practice_status, primary_injury, secondary_injury, report_date
       FROM injury_reports
       WHERE player_id = $1
       ORDER BY report_date DESC
       LIMIT 1`,
      [id]
    );

    res.json({
      data: { ...rows[0], current_injury: injuryRows[0] || null },
    });
  } catch (err) {
    // A malformed UUID throws a Postgres error (invalid input syntax) —
    // treat that as "not found" rather than a 500, since it's a client
    // input problem, not a server fault.
    if (err.code === '22P02') return res.status(404).json({ error: 'player not found' });
    console.error('[routes/players] detail failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
