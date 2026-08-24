/**
 * Chalk That NFL — Ingestion Worker (design-stage skeleton)
 * =========================================================================
 * Runs as its own Railway service, separate from the main API backend —
 * see Phase 2 System Design discussion for why (crashed/stuck ingestion
 * shouldn't be able to affect API responsiveness, and it mirrors how the
 * future AI agent service is also kept separate from the main backend).
 *
 * This file is a SKELETON: the scheduling logic (when does each job run)
 * is real and complete. The actual fetch/normalize/upsert bodies per job
 * are stubbed with TODOs — that's Build Order work, once a live-stats
 * vendor is picked and real DB/vendor clients exist. What's here is meant
 * to validate the *shape* of the pipeline before writing real code
 * against it.
 * =========================================================================
 */

// ---------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------
// Each job declares its own schedule type. Four shapes cover everything
// discussed:
//   - 'fixed'                 : plain interval (roster, schedule, historical stats)
//   - 'proximity'              : interval shrinks as an upcoming game gets closer (forecast weather)
//   - 'day-of-week-proximity'   : cadence keyed off day-of-week + how close to game day (injury reports)
//   - 'game-window'            : only active while now() falls inside a live game's window (live stats)

const JOBS = {
  sync_roster: {
    source: 'nflverse',
    schedule: { type: 'fixed', intervalMinutes: 24 * 60 },
    run: syncRoster,
  },
  sync_schedule: {
    source: 'nflverse',
    schedule: { type: 'fixed', intervalMinutes: 24 * 60 }, // daily is what catches flex-schedule changes
    run: syncSchedule,
  },
  sync_historical_stats: {
    source: 'nflverse',
    schedule: { type: 'fixed', intervalMinutes: 24 * 60 },
    run: syncHistoricalStats,
  },
  sync_forecast_weather: {
    source: 'open-meteo',
    schedule: {
      type: 'proximity',
      // { hoursBefore: X, intervalMinutes: Y } — first bucket whose hoursBefore
      // the game still exceeds "hoursUntilKickoff" wins.
      buckets: [
        { hoursBefore: 72, intervalMinutes: 360 }, // 3+ days out: every 6h
        { hoursBefore: 12, intervalMinutes: 120 }, // 12h-3d out: every 2h
        { hoursBefore: 0, intervalMinutes: 30 },  // final 12h: every 30m
      ],
    },
    run: syncForecastWeather,
  },
  sync_injury_reports: {
    source: 'live_stats_vendor', // BallDontLie / Highlightly — TBD
    schedule: { type: 'day-of-week-proximity' },
    run: syncInjuryReports,
  },
  sync_live_stats: {
    source: 'live_stats_vendor',
    schedule: { type: 'game-window', pollSeconds: 20 },
    run: syncLiveStats,
  },
};

// In-memory last-run tracking for this skeleton. A real implementation
// should read this from `ingestion_runs` on startup instead, so a worker
// restart doesn't forget recent runs and immediately re-fire everything.
const lastRunAt = {};

// ---------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------

async function tick() {
  const now = new Date();
  for (const [jobType, job] of Object.entries(JOBS)) {
    try {
      if (await isDue(jobType, job, now)) {
        // Fire and forget — runJob owns its own logging/error handling,
        // so a slow or failing job doesn't block the next tick's checks.
        runJob(jobType, job);
      }
    } catch (err) {
      console.error(`[scheduler] isDue() check failed for ${jobType}:`, err);
    }
  }
}

async function isDue(jobType, job, now) {
  const { schedule } = job;

  switch (schedule.type) {
    case 'fixed':
      return minutesSince(lastRunAt[jobType], now) >= schedule.intervalMinutes;

    case 'proximity': {
      const nextGame = await getNextUpcomingGame(); // TODO: SELECT ... FROM games WHERE status='scheduled' ORDER BY game_datetime LIMIT 1
      if (!nextGame) return false;
      const hoursUntil = hoursBetween(now, nextGame.game_datetime);
      const bucket = pickProximityBucket(schedule.buckets, hoursUntil);
      return minutesSince(lastRunAt[jobType], now) >= bucket.intervalMinutes;
    }

    case 'day-of-week-proximity':
      // TODO: real implementation reads day-of-week + hours-until-next-kickoff
      // and picks a cadence, same idea as 'proximity' but tuned for the
      // Mon-Wed / Thu-Sat / Sun-morning tightening described in Phase 2.
      return isInjuryReportWindowDue(now, lastRunAt[jobType]);

    case 'game-window':
      return isGameWindowActive(now); // TODO: SELECT 1 FROM games WHERE now() BETWEEN game_datetime AND game_datetime + interval '4 hours'

    default:
      return false;
  }
}

// ---------------------------------------------------------------------
// Job execution wrapper — every job goes through this, so ingestion_runs
// logging, retry/backoff, and error handling are written once, not per job.
// ---------------------------------------------------------------------

async function runJob(jobType, job) {
  const runId = await logRunStart(jobType, job.source); // TODO: INSERT INTO ingestion_runs (...) RETURNING run_id
  lastRunAt[jobType] = new Date();

  try {
    const { recordsProcessed } = await job.run();
    await logRunSuccess(runId, recordsProcessed); // TODO: UPDATE ingestion_runs SET status='success', finished_at=now(), records_processed=$2 WHERE run_id=$1
  } catch (err) {
    console.error(`[job:${jobType}] failed:`, err);
    await logRunFailure(runId, err); // TODO: UPDATE ingestion_runs SET status='failed', finished_at=now(), error_message=$2 WHERE run_id=$1
    scheduleRetry(jobType, job);
  }
}

function scheduleRetry(jobType, job, attempt = 1) {
  const MAX_ATTEMPTS = 5;
  if (attempt > MAX_ATTEMPTS) {
    console.error(`[job:${jobType}] giving up after ${MAX_ATTEMPTS} attempts`);
    return;
  }
  const delayMs = Math.min(2 ** attempt * 1000, 5 * 60 * 1000); // exponential, capped at 5 minutes
  setTimeout(() => runJob(jobType, job), delayMs);
}

// ---------------------------------------------------------------------
// Identity resolution — shared by every job that touches player records
// (roster sync, historical stats, live stats, injury reports).
// ---------------------------------------------------------------------

async function resolveIdentity(source, sourceRecord) {
  // 1. SELECT player_id FROM player_id_crosswalk WHERE source=$1 AND source_player_id=$2
  // 2. If found, return it.
  // 3. If not found, attempt an automated match: normalized full_name +
  //    current_team_id + position against `players`.
  // 4. Confident match -> INSERT INTO player_id_crosswalk (..., match_confidence='matched')
  // 5. Ambiguous / no match -> INSERT a new players row + a crosswalk row
  //    with match_confidence='manual_review', so the record isn't lost
  //    while waiting on nflverse's next sync or a manual review pass
  //    (per the Phase 2 decision on new/rookie players).
  // TODO: implement against players + player_id_crosswalk
  throw new Error('resolveIdentity() not yet implemented');
}

// ---------------------------------------------------------------------
// Per-job bodies — stubs. Real fetch/normalize/upsert logic is Build
// Order work, once the live-stats vendor is picked and DB/vendor clients
// exist. Each one follows the same shape: fetch -> normalize ->
// resolveIdentity -> upsert (ON CONFLICT DO UPDATE) -> invalidate cache.
// ---------------------------------------------------------------------

async function syncRoster() {
  // TODO: pull nflverse roster data, resolveIdentity() per player, upsert `players`
  return { recordsProcessed: 0 };
}

async function syncSchedule() {
  // TODO: pull nflverse schedule, upsert `games` (bump schedule_updated_at on flex changes)
  return { recordsProcessed: 0 };
}

async function syncHistoricalStats() {
  // TODO: pull nflverse box scores, resolveIdentity() per player, upsert *_game_stats tables
  return { recordsProcessed: 0 };
}

async function syncForecastWeather() {
  // TODO: for each upcoming game, call Open-Meteo with stadium lat/long + kickoff time,
  // update games.weather_condition / weather_temp_f / weather_wind_mph
  return { recordsProcessed: 0 };
}

async function syncInjuryReports() {
  // TODO: pull live vendor injury data, resolveIdentity() per player, INSERT into injury_reports
  // (append-only — see schema notes on why this isn't an update-in-place)
  return { recordsProcessed: 0 };
}

async function syncLiveStats() {
  // TODO: pull live vendor box score for the currently active game(s),
  // resolveIdentity() per player, upsert *_game_stats, invalidate the
  // relevant Redis keys so the short-TTL live cache reflects the update
  return { recordsProcessed: 0 };
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function minutesSince(lastRun, now) {
  if (!lastRun) return Infinity; // never run -> always due
  return (now - lastRun) / 60000;
}

function hoursBetween(a, b) {
  return Math.abs(b - a) / 3600000;
}

function pickProximityBucket(buckets, hoursUntil) {
  // buckets is ordered furthest-out first; return the first bucket whose
  // threshold the game has already crossed into.
  const sorted = [...buckets].sort((a, b) => b.hoursBefore - a.hoursBefore);
  let chosen = sorted[sorted.length - 1];
  for (const bucket of sorted) {
    if (hoursUntil <= bucket.hoursBefore) chosen = bucket;
  }
  return chosen;
}

// ---- DB-touching stubs (TODO: implement against Postgres) ----
async function getNextUpcomingGame() { return null; }
async function isGameWindowActive(_now) { return false; }
async function isInjuryReportWindowDue(_now, _lastRun) { return false; }
async function logRunStart(_jobType, _source) { return null; }
async function logRunSuccess(_runId, _recordsProcessed) {}
async function logRunFailure(_runId, _err) {}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

function start() {
  setInterval(tick, 60 * 1000); // evaluate every minute; each job's own schedule decides if it's actually due
  console.log('Ingestion worker started.');
}

module.exports = { start, JOBS, resolveIdentity };
