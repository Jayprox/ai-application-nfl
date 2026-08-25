/**
 * Chalk That NFL — Team routes
 * =========================================================================
 * GET /teams       list all 32 teams (with their stadium)
 * GET /teams/:id   one team + its current roster
 * =========================================================================
 */

const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.team_id, t.abbreviation, t.name, t.conference, t.division,
              s.stadium_id, s.name AS stadium_name, s.city, s.state, s.roof, s.surface
       FROM teams t
       JOIN stadiums s ON s.stadium_id = t.home_stadium_id
       ORDER BY t.conference, t.division, t.name`
    );
    res.json({ data: rows, meta: { count: rows.length } });
  } catch (err) {
    console.error('[routes/teams] list failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/:id', async (req, res) => {
  const teamId = parseInt(req.params.id, 10);
  if (Number.isNaN(teamId)) return res.status(400).json({ error: 'team id must be a number' });

  try {
    const { rows: teamRows } = await query(
      `SELECT t.team_id, t.abbreviation, t.name, t.conference, t.division,
              s.stadium_id, s.name AS stadium_name, s.city, s.state, s.roof, s.surface, s.timezone
       FROM teams t
       JOIN stadiums s ON s.stadium_id = t.home_stadium_id
       WHERE t.team_id = $1`,
      [teamId]
    );
    if (!teamRows[0]) return res.status(404).json({ error: 'team not found' });

    const { rows: roster } = await query(
      `SELECT player_id, full_name, position, position_group, status
       FROM players
       WHERE current_team_id = $1
       ORDER BY position_group, full_name`,
      [teamId]
    );

    res.json({
      data: { ...teamRows[0], roster },
      meta: { roster_count: roster.length },
    });
  } catch (err) {
    console.error('[routes/teams] detail failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
