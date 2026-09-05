/**
 * Chalk That NFL — daily blended matchup score computation
 * =========================================================================
 * Entry point for the dedicated Railway cron service (Part 2 Phase 2's
 * blended per-matchup score — see backend/lib/matchup-score.js for the
 * actual blend logic and why this runs as its own tiny service rather
 * than inside worker/ingestion-worker.js or backend-api itself: the
 * worker is deliberately self-contained with zero backend/ dependencies,
 * and this needs backend/lib/insights.js directly).
 *
 * Run with: node scripts/compute-matchup-scores.js [season]
 * (season defaults to the current NFL season, same Sept-Feb "labeled
 * year" logic as worker/ingestion-worker.js's currentNflSeason() —
 * duplicated here as a one-liner rather than importing from worker/,
 * since this script has no worker dependency either.)
 *
 * Logs to ingestion_runs under job_type 'compute_matchup_scores' so
 * GET /matchup-scores can report meta.freshness the same way every
 * other derived endpoint already does.
 * =========================================================================
 */

require('dotenv').config();
const { pool } = require('../backend/db');
const { computeAndStoreMatchupScores } = require('../backend/lib/matchup-score');

function currentNflSeason(now) {
  const month = now.getUTCMonth() + 1;
  return month <= 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

async function logRunStart(jobType, source) {
  const { rows } = await pool.query(
    `INSERT INTO ingestion_runs (job_type, source, status) VALUES ($1, $2, 'running') RETURNING run_id`,
    [jobType, source]
  );
  return rows[0].run_id;
}
async function logRunSuccess(runId, recordsProcessed) {
  await pool.query(
    `UPDATE ingestion_runs SET status = 'success', finished_at = now(), records_processed = $2 WHERE run_id = $1`,
    [runId, recordsProcessed]
  );
}
async function logRunFailure(runId, err) {
  await pool.query(
    `UPDATE ingestion_runs SET status = 'failed', finished_at = now(), error_message = $2 WHERE run_id = $1`,
    [runId, String(err && err.message ? err.message : err).slice(0, 2000)]
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[compute-matchup-scores] DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }
  const season = process.argv[2] ? Number(process.argv[2]) : currentNflSeason(new Date());
  const runId = await logRunStart('compute_matchup_scores', 'internal');

  try {
    const { written, skipped, eligible } = await computeAndStoreMatchupScores(season);
    await logRunSuccess(runId, written);
    console.log(
      `[compute-matchup-scores] season ${season}: ${written} score(s) written, ${skipped} skipped (no signal), ` +
        `${eligible} eligible player(s) considered`
    );
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[compute-matchup-scores] failed:', err);
    await logRunFailure(runId, err);
    await pool.end();
    process.exit(1);
  }
}

main();
