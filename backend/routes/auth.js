/**
 * Chalk That NFL — Auth routes
 * =========================================================================
 * POST /login    { username, password } -> { accessToken, refreshToken }
 * POST /refresh  { refreshToken }     -> { accessToken, refreshToken }
 * POST /logout   { refreshToken }     -> 204
 *
 * Tokens are returned in the JSON body rather than set as cookies — keeps
 * the same shape usable by the web app, a future Swift app, and curl/test
 * scripts alike without cookie-jar handling. Worth revisiting (httpOnly
 * cookie for the refresh token specifically) as a Phase 6 hardening item,
 * not blocking for MVP.
 *
 * /login and /refresh are rate limited per IP (see lib/rate-limit.js) —
 * previously wide open, which matters here specifically because these
 * are the two routes that don't sit behind the `authenticate` middleware
 * (server.js mounts them before it, since they're how a client gets
 * credentials in the first place). /logout isn't limited — a call
 * against a bogus/already-revoked token is a harmless no-op, nothing
 * worth brute-forcing there.
 * =========================================================================
 */

const express = require('express');
const { login, refresh, logout, AuthError } = require('../auth');
const { createRateLimiter } = require('../lib/rate-limit');

const router = express.Router();

// 10 attempts per 15 minutes per IP — generous enough for a real person
// fat-fingering a password a few times, tight enough to make credential
// stuffing/brute force impractical against the handful of known accounts
// this app has today (signups are closed).
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts — try again in a few minutes.',
});

// A legitimate client refreshes roughly once per ACCESS_TOKEN_TTL (15m
// — see auth.js) per active session, so real traffic here is naturally
// low-frequency. Threshold is looser than login's on purpose: a false
// positive here logs a real, already-authenticated user out mid-session,
// which is a worse experience than a login page asking someone to wait a
// minute.
const refreshLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many refresh attempts — try again in a few minutes.',
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const tokens = await login(username, password);
    res.json(tokens);
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message });
    console.error('[routes/auth] login failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  try {
    const tokens = await refresh(refreshToken);
    res.json(tokens);
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message });
    console.error('[routes/auth] refresh failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  try {
    await logout(refreshToken);
    res.status(204).end();
  } catch (err) {
    console.error('[routes/auth] logout failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
