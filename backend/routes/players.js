/**
 * Chalk That NFL — Player routes
 * =========================================================================
 * GET /players       search/list players — ?name=, ?team=(abbreviation),
 *                     ?position_group=offense|defense|special_teams
 * GET /players/:id    one player's identity/bio (current team, position,
 *                      status, draft info). Deliberately does NOT include
 *                      stats here — stats/splits go through POST /query,
 *                      the one shared query engine, rather than this route
 *                      duplicating that logic. Keeps "one query engine,
 *                      multiple callers" (architecture.md §2) honest.
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

const MAX_RESULTS = 100;

router.get('/', async (req, res) => {
  const { name, team, position_group } = req.query;

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

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

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
