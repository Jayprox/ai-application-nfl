/**
 * Chalk That NFL — Auth routes
 * =========================================================================
 * POST /login    { email, password } -> { accessToken, refreshToken }
 * POST /refresh  { refreshToken }     -> { accessToken, refreshToken }
 * POST /logout   { refreshToken }     -> 204
 *
 * Tokens are returned in the JSON body rather than set as cookies — keeps
 * the same shape usable by the web app, a future Swift app, and curl/test
 * scripts alike without cookie-jar handling. Worth revisiting (httpOnly
 * cookie for the refresh token specifically) as a Phase 6 hardening item,
 * not blocking for MVP.
 * =========================================================================
 */

const express = require('express');
const { login, refresh, logout, AuthError } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const tokens = await login(email, password);
    res.json(tokens);
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message });
    console.error('[routes/auth] login failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/refresh', async (req, res) => {
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
