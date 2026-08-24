/**
 * Chalk That NFL — Auth (design-stage skeleton)
 * =========================================================================
 * Two credential types, one API. Humans authenticate via a real login
 * session (short-lived JWT access token + revocable refresh token).
 * Agents authenticate via a single long-lived API key with no session at
 * all. The `authenticate` middleware at the bottom is what every protected
 * route actually uses — it doesn't care which credential type shows up,
 * it just attaches `req.user` or `req.service` accordingly.
 *
 * The JWT/hashing logic here is real (uses `jsonwebtoken`, `bcrypt`, and
 * Node's built-in `crypto`). The DB calls are stubbed with TODOs — no
 * Postgres client/pool exists yet; wire these against `users`,
 * `refresh_tokens`, and `api_keys` from schema.sql once it does.
 * =========================================================================
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const JWT_SECRET = process.env.JWT_SECRET; // TODO: set in Railway env vars, never commit
const API_KEY_PREFIX = 'ctnfl_live_'; // makes a leaked key easy to recognize/scan for, same idea as Stripe/GitHub token prefixes

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

  // TODO: INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
  //       VALUES ($1, $2, $3)
  await saveRefreshTokenHash(userId, hashToken(rawToken), expiresAt);

  return rawToken; // raw value only ever returned here — never stored, never logged
}

async function login(email, rawPassword) {
  const user = await findUserByEmail(email); // TODO: SELECT * FROM users WHERE email = $1
  if (!user) throw new AuthError('invalid credentials');

  const passwordOk = await verifyPassword(rawPassword, user.password_hash);
  if (!passwordOk) throw new AuthError('invalid credentials');

  const accessToken = issueAccessToken(user.user_id);
  const refreshToken = await issueRefreshToken(user.user_id);
  return { accessToken, refreshToken };
}

async function refresh(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  const record = await findRefreshTokenByHash(tokenHash); // TODO: SELECT * FROM refresh_tokens WHERE token_hash = $1

  if (!record || record.revoked_at || record.expires_at < new Date()) {
    // Presenting an unknown, already-revoked, or expired refresh token
    // is treated the same way: reject, no session-fixing hints given
    // back to the caller about which specific reason it failed for.
    throw new AuthError('invalid refresh token');
  }

  await revokeRefreshToken(record.token_id); // TODO: UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1

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
  // TODO: INSERT INTO api_keys (label, key_hash) VALUES ($1, $2)
  await saveApiKeyHash(label, hashToken(rawKey));
  return rawKey; // shown once at creation time, same as any API key provider
}

async function verifyApiKey(rawKey) {
  const keyHash = hashToken(rawKey);
  const record = await findApiKeyByHash(keyHash); // TODO: SELECT * FROM api_keys WHERE key_hash = $1
  if (!record || record.revoked_at) throw new AuthError('invalid api key');

  touchApiKeyLastUsed(record.key_id); // TODO: fire-and-forget UPDATE api_keys SET last_used_at = now() WHERE key_id = $1
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

// ---- DB-touching stubs (TODO: implement against Postgres) ----
async function findUserByEmail(_email) { return null; }
async function findRefreshTokenByHash(_hash) { return null; }
async function saveRefreshTokenHash(_userId, _hash, _expiresAt) {}
async function revokeRefreshToken(_tokenId) {}
async function findApiKeyByHash(_hash) { return null; }
async function saveApiKeyHash(_label, _hash) {}
async function touchApiKeyLastUsed(_keyId) {}

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
