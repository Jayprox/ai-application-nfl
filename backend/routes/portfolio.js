/**
 * Chalk That NFL — portfolio agent route
 * =========================================================================
 * POST /portfolio/slate?season=&week=&max_picks=&unit_size=&dry_run=
 *
 * Builds (and, unless dry_run=true, logs to picks_log) a slate of
 * game_line picks for one week from the edge agent's strongest
 * disagreements. See lib/portfolio.js for the sizing/logging/dedup
 * design and docs/part2-roadmap.md for the portfolio agent's role
 * ("given a goal and a unit size, build a slate... a distinct concern
 * from 'which picks are good'").
 *
 * POST, not GET, because a non-dry-run call has a side effect (writes to
 * picks_log) — same "irreversible-ish action gets its own verb" reasoning
 * as routes/auth.js's /login. dry_run=true is the safe default path for
 * trying this out; it still requires an explicit query param to actually
 * write, so a bare POST never silently logs anything by accident... other
 * than the fact that dry_run defaults to false to match "building a real
 * slate" being the point of the route — callers verifying behavior should
 * pass dry_run=true explicitly.
 * =========================================================================
 */

const express = require('express');
const { buildSlate, MAX_MAX_PICKS } = require('../lib/portfolio');

const router = express.Router();

const DEFAULT_MAX_PICKS = 5;
const DEFAULT_UNIT_SIZE = 1;

router.post('/slate', async (req, res) => {
  const { season, week, max_picks: maxPicksRaw, unit_size: unitSizeRaw, dry_run: dryRunRaw } = req.query;

  if (!season || !/^\d{4}$/.test(String(season))) {
    return res.status(400).json({ error: 'season must be a 4-digit year' });
  }
  if (!week || !/^\d{1,2}$/.test(String(week))) {
    return res.status(400).json({ error: 'week is required and must be a 1-2 digit number' });
  }
  if (maxPicksRaw !== undefined && (!/^\d+$/.test(String(maxPicksRaw)) || Number(maxPicksRaw) < 1)) {
    return res.status(400).json({ error: `max_picks must be a positive integer (max ${MAX_MAX_PICKS})` });
  }
  if (unitSizeRaw !== undefined && (!/^\d+(\.\d+)?$/.test(String(unitSizeRaw)) || Number(unitSizeRaw) <= 0)) {
    return res.status(400).json({ error: 'unit_size must be a positive number' });
  }
  if (dryRunRaw !== undefined && !['true', 'false'].includes(String(dryRunRaw))) {
    return res.status(400).json({ error: 'dry_run must be "true" or "false"' });
  }

  try {
    const result = await buildSlate({
      season: Number(season),
      week: Number(week),
      maxPicks: maxPicksRaw !== undefined ? Math.min(MAX_MAX_PICKS, Number(maxPicksRaw)) : DEFAULT_MAX_PICKS,
      unitSize: unitSizeRaw !== undefined ? Number(unitSizeRaw) : DEFAULT_UNIT_SIZE,
      dryRun: dryRunRaw === 'true',
    });
    res.json({ data: result });
  } catch (err) {
    console.error('[routes/portfolio] slate build failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
