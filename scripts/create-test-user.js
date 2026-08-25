/**
 * Chalk That NFL — create the single MVP test account
 * =========================================================================
 * Per checklist Phase 3 ("a single test account is acceptable for v1"),
 * there's no public signup route — this one-off script creates it
 * directly against Postgres. Run with:
 *   node scripts/create-test-user.js <email> <password>
 * =========================================================================
 */

require('dotenv').config();
const { pool } = require('../db');
const { hashPassword } = require('../auth');

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node scripts/create-test-user.js <email> <password>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
     RETURNING user_id, email`,
    [email, passwordHash]
  );

  console.log(`[create-test-user] ready: ${rows[0].email} (user_id ${rows[0].user_id})`);
  await pool.end();
}

main().catch((err) => {
  console.error('[create-test-user] failed:', err);
  process.exit(1);
});
