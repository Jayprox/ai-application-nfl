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

    // Active roster + injured reserve (2026-09-15, extended same day) —
    // `status` uses uppercase codes (ACT/CUT/DEV/RES/INA/RET/EXE, per
    // scripts/fantasy-auction-values.js's ROSTER_STATUS_LABEL). 'ACT' is
    // the same "actually on the 53" filter matchup-score.js's own
    // getEligiblePlayers() already uses (see that file's header comment).
    // 'RES' (this data model's only reserve/IR bucket -- no separate
    // PUP/NFI split) is included too: a player who just landed on IR is
    // still part of the team, just not active for game day, so still
    // belongs here -- unlike CUT/DEV/RET/EXE, which mean they're off the
    // team's current picture entirely.
    //
    // updated_at freshness guard (2026-09-15): scripts/backfill-historical.js
    // seeded players from 2021-2025 roster files, and worker/ingestion-
    // worker.js's sync_roster job only UPDATEs players present in the
    // *current* season's roster file -- so a player whose last real season
    // was several years ago could in principle still carry a stale ACT/RES
    // status forever. sync_roster now also clears current_team_id for
    // anyone who drops out of a current-season fetch entirely (see that
    // job's own comment), so this filter is belt-and-suspenders, not the
    // primary fix -- but it means a team page never shows a player sync_roster
    // hasn't actually confirmed in the last couple of days, even if some
    // future code path ever sets current_team_id without going through
    // that job.
    const { rows: roster } = await query(
      `SELECT player_id, full_name, position, position_group, status
       FROM players
       WHERE current_team_id = $1 AND status IN ('ACT', 'RES')
         AND updated_at > now() - interval '2 days'
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
