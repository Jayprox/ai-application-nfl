/**
 * One-off cleanup: run once, before re-running backfill-historical.js
 * after the LA/LAR abbreviation fix.
 *
 * The first backfill run inserted team_game_stats rows with NULL
 * passing_yards/rushing_yards/turnovers (derived from player stats that
 * hadn't loaded yet, due to the LA/LAR bug). Those inserts used
 * ON CONFLICT (game_id, team_id) DO NOTHING, so simply re-running the
 * backfill will NOT fix or replace them — the conflict just gets skipped.
 * This deletes those rows first so the re-run can insert correct ones.
 *
 * Run with: node scripts/cleanup-before-rerun.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `DELETE FROM team_game_stats
       WHERE game_id IN (SELECT game_id FROM games WHERE season BETWEEN 2021 AND 2026)`
    );
    console.log(`[cleanup] deleted ${rowCount} team_game_stats rows for seasons 2021-2026`);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
