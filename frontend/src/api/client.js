/**
 * Shared fetch wrapper for backend-api. Every page/component should call
 * through here rather than using fetch() directly, so auth headers,
 * refresh-on-401, and error shapes stay consistent in exactly one place —
 * same "one query engine, one client entry point" spirit as the backend's
 * own shared query engine (see docs/architecture.md §2).
 */

import { getTokens, setTokens, clearTokens } from './tokenStorage';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Thrown when the caller has no valid session left (no token, or the
// refresh attempt itself failed) — callers catch this specifically to
// redirect to /login rather than showing a generic error banner.
export class AuthError extends Error {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'AuthError';
  }
}

let refreshInFlight = null;

async function refreshAccessToken() {
  // Multiple simultaneous 401s (e.g. a page firing several requests at
  // once) should only trigger one real /refresh call — everyone else
  // awaits the same in-flight promise instead of racing it.
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { refreshToken } = getTokens();
      if (!refreshToken) throw new AuthError('No refresh token');

      const res = await fetch(`${API_URL}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearTokens();
        throw new AuthError('Session expired');
      }
      const data = await res.json();
      setTokens(data);
      return data.accessToken;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * @param {string} path - e.g. '/teams' or '/query'
 * @param {object} [options]
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [options.method]
 * @param {object} [options.body] - JSON-serialized automatically
 * @param {boolean} [options.skipAuth] - true for /login itself
 */
export async function apiFetch(path, { method = 'GET', body, skipAuth = false } = {}) {
  const doFetch = async (accessToken) => {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let { accessToken } = getTokens();
  let res = await doFetch(skipAuth ? null : accessToken);

  if (!skipAuth && res.status === 401) {
    // Access token expired (15 min lifetime, see backend/auth.js) — try
    // one silent refresh-and-retry before giving up on the session.
    try {
      accessToken = await refreshAccessToken();
      res = await doFetch(accessToken);
    } catch {
      throw new AuthError('Session expired');
    }
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    if (res.status === 401) throw new AuthError(data?.error || 'Not authenticated');
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}
