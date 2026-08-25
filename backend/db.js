/**
 * Chalk That NFL — shared Postgres pool
 * =========================================================================
 * One pool, imported everywhere a query is needed (auth.js, route
 * handlers). keepAlive matches the fix applied in scripts/seed.js — the
 * same "Connection terminated unexpectedly" risk over a public/proxied
 * connection applies here too, though backend-api will normally run
 * inside Railway and use the internal DATABASE_URL, where this matters
 * less but doesn't hurt.
 * =========================================================================
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  // A background/idle client hitting an error (e.g. connection dropped)
  // should not crash the whole process — log it and let the pool recover
  // on the next checkout.
  console.error('[db] unexpected pool error:', err.message);
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
