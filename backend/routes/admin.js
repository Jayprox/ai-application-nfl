/**
 * Chalk That NFL — admin route
 * =========================================================================
 * POST /admin/sync-roster     re-run ingestion-worker's sync_roster job
 *                              now, instead of waiting for its normal 24h
 *                              cadence.
 * POST /admin/sync-schedule   re-run sync_schedule now (added 2026-09-15,
 *                              same day as sync-roster below) — the same
 *                              "don't wait 24h" need, but for a game's
 *                              status/score rather than a player's roster
 *                              spot. sync_schedule is the authoritative
 *                              nflverse source for games.status/
 *                              home_score/away_score; sync_live_scores is
 *                              supposed to get there first same-day, but
 *                              it only polls a game for 4 hours after
 *                              kickoff (worker/ingestion-worker.js's
 *                              isGameWindowActive) and depends on a
 *                              third-party vendor that can fail all game
 *                              long (confirmed 2026-09-15: Highlightly
 *                              returned 403 "not subscribed to this API"
 *                              on every single tick during a live game,
 *                              so nothing corrected it) — so a finished
 *                              game can sit at status='scheduled' for up
 *                              to 24h with no way to force a same-day fix
 *                              until this route existed.
 *
 * Added 2026-09-15 after noticing a player's real-world status (an IR
 * move) hadn't reached this app yet — sync_roster (worker/ingestion-
 * worker.js) only fires once every 24h on its own fixed schedule, and
 * that worker has no HTTP surface of its own to poke (own Railway
 * service, rootDirectory: worker, no public domain — see that file's own
 * header comment). backend-api's build isn't root-scoped the same way
 * (no rootDirectory override — see docs/architecture.md/Railway service
 * config), so its deployed filesystem includes the whole repo and this
 * route can require the worker's job table directly rather than
 * duplicating syncRoster's fetch/upsert logic here. That does mean this
 * process spins up a second, short-lived pg Pool (ingestion-worker.js's
 * own top-level `pool`) alongside this service's own db.js pool — an
 * accepted tradeoff for a route that's called rarely and manually, not a
 * reason to duplicate ~40 lines of CSV-fetch/upsert logic that would then
 * need to stay in sync with the real thing by hand.
 *
 * Scoped to sync_roster and sync_schedule specifically, not "trigger any
 * job" — several of the other jobs (sync_odds, sync_live_stats,
 * sync_injury_reports) call rate-limited/paid vendors (The Odds API,
 * Highlightly), so a generic trigger-any-job endpoint would make it too
 * easy to burn quota on an accidental or repeated click. Both
 * sync_roster's and sync_schedule's source (nflverse's raw GitHub CSVs)
 * has no such cost.
 * =========================================================================
 */

const express = require('express');
const path = require('path');

const router = express.Router();

router.post('/sync-roster', async (req, res) => {
  try {
    // Lazy require — only touched when this route actually fires, so a
    // worker-side syntax error can't take down backend-api's own startup.
    const { JOBS, runJob } = require(path.join(__dirname, '..', '..', 'worker', 'ingestion-worker'));
    const { ok, err } = await runJob('sync_roster', JOBS.sync_roster, { retry: false });
    if (!ok) {
      return res.status(502).json({ error: 'sync_roster failed', message: err ? err.message : undefined });
    }
    res.json({ data: { synced: true } });
  } catch (err) {
    console.error('[routes/admin] sync-roster failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/sync-schedule', async (req, res) => {
  try {
    // Same lazy-require / borrowed-runJob shape as sync-roster above —
    // see this file's header for why sync_schedule specifically gets a
    // manual trigger too.
    const { JOBS, runJob } = require(path.join(__dirname, '..', '..', 'worker', 'ingestion-worker'));
    const { ok, err } = await runJob('sync_schedule', JOBS.sync_schedule, { retry: false });
    if (!ok) {
      return res.status(502).json({ error: 'sync_schedule failed', message: err ? err.message : undefined });
    }
    res.json({ data: { synced: true } });
  } catch (err) {
    console.error('[routes/admin] sync-schedule failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
