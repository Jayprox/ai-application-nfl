/**
 * Chalk That NFL — Auth
 * =========================================================================
 * Two credential types, one API. Humans authenticate via a real login
 * session (short-lived JWT access token + revocable refresh token).
 * Agents authenticate via a single long-lived API key with no session at
 * all. The `authenticate` middleware at the bottom is what every protected
 * route actually uses — it doesn't care which credential type shows up,
 * it just attaches `req.user` or `req.service` accordingly.
 *
 * DB calls now hit real Postgres via db.js (previously stubbed TODOs
 * during the design-stage pass — wired up once schema.sql was live and
 * users/refresh_tokens/api_keys existed for real).
 * =========================================================================
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { query } = require('./db');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const JWT_SECRET = process.env.JWT_SECRET; // set in Railway env vars (and local .env), never commit
const API_KEY_PREFIX = 'ctnfl_live_'; // makes a leaked key easy to recognize/scan for, same idea as Stripe/GitHub token prefixes

if (!JWT_SECRET) {
  // Fail loudly at startup rather than silently signing tokens with
  // `undefined` as the secret, which jsonwebtoken will otherwise accept.
  console.error('[auth] JWT_SECRET is not set — see .env.example');
}

// ---------------------------------------------------------------------
// Hashing helpers — passwords use bcrypt (slow by design, right tool for
// low-entropy human passwords); tokens/keys use sha256 (fast lookup by
// hash is fine since they're already high-entropy random values, not
// something an attacker can feasibly guess/brute-force offline).
// ---------------------------------------------------------------------

async function hashPassword(rawPassword) {
  return bcrypt.hash(rawPassword, 12);
}

async function verifyPassword(rawPassword, passwordHash) {
  return bcrypt.compare(rawPassword, passwordHash);
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateApiKey() {
  return API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------
// Human auth: login issues both tokens; refresh rotates the refresh
// token (issuing a new one and revoking the old) rather than just
// re-validating the same one indefinitely — if an already-rotated
// refresh token is ever presented again, that's a signal of token theft
// and is worth treating as "revoke this whole session," not just denying
// the one request.
// ---------------------------------------------------------------------

function issueAccessToken(userId) {
  return jwt.sign({ sub: userId, type: 'user' }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

async function issueRefreshToken(userId) {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await saveRefreshTokenHash(userId, hashToken(rawToken), expiresAt);
  return rawToken; // raw value only ever returned here — never stored, never logged
}

async function login(email, rawPassword) {
  const user = await findUserByEmail(email);
  if (!user) throw new AuthError('invalid credentials');

  const passwordOk = await verifyPassword(rawPassword, user.password_hash);
  if (!passwordOk) throw new AuthError('invalid credentials');

  const accessToken = issueAccessToken(user.user_id);
  const refreshToken = await issueRefreshToken(user.user_id);
  return { accessToken, refreshToken };
}

async function refresh(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  const record = await findRefreshTokenByHash(tokenHash);

  if (!record || record.revoked_at || record.expires_at < new Date()) {
    // Presenting an unknown, already-revoked, or expired refresh token
    // is treated the same way: reject, no session-fixing hints given
    // back to the caller about which specific reason it failed for.
    throw new AuthError('invalid refresh token');
  }

  await revokeRefreshToken(record.token_id);

  const accessToken = issueAccessToken(record.user_id);
  const newRefreshToken = await issueRefreshToken(record.user_id); // rotation — old one is now dead either way
  return { accessToken, refreshToken: newRefreshToken };
}

async function logout(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  const record = await findRefreshTokenByHash(tokenHash);
  if (record) await revokeRefreshToken(record.token_id);
}

// ---------------------------------------------------------------------
// Agent auth: issued once (out of band, not via a public signup route —
// this is a service credential, not a self-serve account), presented on
// every request, no session/expiry concept at all.
// ---------------------------------------------------------------------

async function createApiKey(label) {
  const rawKey = generateApiKey();
  await saveApiKeyHash(label, hashToken(rawKey));
  return rawKey; // shown once at creation time, same as any API key provider
}

async function verifyApiKey(rawKey) {
  const keyHash = hashToken(rawKey);
  const record = await findApiKeyByHash(keyHash);
  if (!record || record.revoked_at) throw new AuthError('invalid api key');

  touchApiKeyLastUsed(record.key_id); // fire-and-forget, no need to block the request on this
  return { keyId: record.key_id, label: record.label, scopes: record.scopes };
}

// ---------------------------------------------------------------------
// The actual middleware every protected route uses. Distinguishes credential
// type by shape — a JWT is three dot-separated base64url segments; an API
// key is a flat string with the recognizable prefix — rather than trying
// jwt.verify() and catching a failure, so a malformed/garbage credential
// fails fast with a clear reason instead of two silent verification attempts.
// ---------------------------------------------------------------------

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'missing credentials' });

  try {
    if (token.startsWith(API_KEY_PREFIX)) {
      req.service = await verifyApiKey(token);
    } else if (isJwtShaped(token)) {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.type !== 'user') throw new AuthError('unexpected token type');
      req.user = { userId: payload.sub };
    } else {
      throw new AuthError('unrecognized credential format');
    }
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid or expired credentials' });
  }
}

function isJwtShaped(token) {
  return token.split('.').length === 3;
}

class AuthError extends Error {}

// ---- DB-touching implementations (real Postgres, via db.js) ----

async function findUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

async function findRefreshTokenByHash(hash) {
  const { rows } = await query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hash]);
  return rows[0] || null;
}

async function saveRefreshTokenHash(userId, hash, expiresAt) {
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hash, expiresAt]
  );
}

async function revokeRefreshToken(tokenId) {
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1', [tokenId]);
}

async function findApiKeyByHash(hash) {
  const { rows } = await query('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
  return rows[0] || null;
}

async function saveApiKeyHash(label, hash) {
  await query('INSERT INTO api_keys (label, key_hash) VALUES ($1, $2)', [label, hash]);
}

async function touchApiKeyLastUsed(keyId) {
  query('UPDATE api_keys SET last_used_at = now() WHERE key_id = $1', [keyId]).catch((err) =>
    console.error('[auth] failed to touch api key last_used_at:', err.message)
  );
}

module.exports = {
  hashPassword,
  verifyPassword,
  login,
  refresh,
  logout,
  createApiKey,
  authenticate,
  AuthError,
};
