/**
 * Chalk That NFL — backend-api entrypoint
 * =========================================================================
 * The only public-facing service (per architecture.md §4). Owns auth and
 * the shared query API. Every client — web, iOS (fast-follow), and future
 * AI agents — talks to this and only this.
 * =========================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');
const { authenticate } = require('./auth');

const authRoutes = require('./routes/auth');
const teamRoutes = require('./routes/teams');
const playerRoutes = require('./routes/players');
const queryRoutes = require('./routes/query');

const app = express();
app.use(express.json());

// The React web app (and Swift iOS later) is now a real browser client
// hitting this API cross-origin, so CORS needs to be explicit rather than
// left to the browser's default same-origin block. CORS_ORIGIN is a single
// allowed origin (comma-separated list also supported) so each environment
// — local dev, the deployed Railway frontend — sets its own value rather
// than this defaulting open to '*'.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());
app.use(
  cors({
    origin: allowedOrigins,
  })
);

// Public: no credentials required. /health exists specifically so a
// Railway deploy (or anyone debugging locally) can confirm the service is
// actually up AND can reach Postgres, not just that the process started.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', message: err.message });
  }
});

// Public: these routes are how a client gets credentials in the first
// place, so they can't themselves require the `authenticate` middleware.
app.use('/', authRoutes); // POST /login, /refresh, /logout

// Everything past this point requires a valid JWT (human) or API key
// (agent/service) — see auth.js for how the two are distinguished.
app.use(authenticate);
app.use('/teams', teamRoutes);
app.use('/players', playerRoutes);
app.use('/query', queryRoutes);

// Fallback error handler — catches anything a route handler didn't
// already wrap in its own try/catch, so a bug never surfaces as a raw
// stack trace to a client.
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] chalk-that-nfl backend-api listening on :${PORT}`);
});
