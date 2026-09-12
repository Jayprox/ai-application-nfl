/**
 * Chalk That NFL — minimal in-memory rate limiter
 * =========================================================================
 * Hand-rolled rather than pulling in a new dependency (express-rate-limit
 * or similar) — this repo's sandbox dev loop has no network access to
 * `npm install` a new package before it can be tested, and the actual
 * need here is small: close a real, currently-zero-protection gap on
 * /login and /refresh, not build a production-grade distributed limiter.
 * Fixed-window counter, keyed however the caller wants (by IP by
 * default), one Map per limiter instance.
 *
 * Known limitation, worth stating plainly: in-memory means the counters
 * reset on every deploy/restart, and won't share state across replicas
 * if backend-api is ever scaled beyond the single instance it runs as
 * today. Redis is already provisioned in this Railway project (for
 * whatever originally justified it) but isn't wired into the app
 * anywhere yet — a Redis-backed limiter would be the natural upgrade if
 * backend-api ever runs more than one instance, since a real distributed
 * brute-force attempt could otherwise just get 1/N as effective a limit
 * as intended, split across replicas that don't share counters.
 * =========================================================================
 */

function createRateLimiter({ windowMs, max, keyFn = (req) => req.ip, message }) {
  const hits = new Map(); // key -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      // First request in a fresh window (or the previous window expired)
      // — reset rather than accumulate. This also self-cleans: an entry
      // for a key that's gone quiet just gets overwritten next time it's
      // seen rather than needing an external sweep.
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message || 'Too many requests — try again later.' });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
