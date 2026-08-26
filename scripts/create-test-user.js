/**
 * Chalk That NFL — create a test account (username/password login)
 * =========================================================================
 * No public signup route yet — accounts are created directly against
 * Postgres. Email is optional (nullable in the schema); it's not used for
 * login and there's no verification flow yet (backlogged — see checklist
 * Phase 3 backlog). Run with:
 *   node scripts/create-test-user.js <username> <password> [email]
 * =========================================================================
 */

require('dotenv').config();
const { pool } = require('../backend/db');
const { hashPassword } = require('../backend/auth');

async function main() {
  const [, , username, password, email] = process.argv;
  if (!username || !password) {
    console.error('Usage: node scripts/create-test-user.js <username> <password> [email]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — see .env.example');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, email) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           email = COALESCE(EXCLUDED.email, users.email),
           updated_at = now()
     RETURNING user_id, username`,
    [username, passwordHash, email || null]
  );

  console.log(`[create-test-user] ready: ${rows[0].username} (user_id ${rows[0].user_id})`);
  await pool.end();
}

main().catch((err) => {
  console.error('[create-test-user] failed:', err);
  process.exit(1);
});
