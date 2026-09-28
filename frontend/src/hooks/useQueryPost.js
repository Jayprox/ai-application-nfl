import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, AuthError } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * POST-body counterpart to useApiFetch (see that file's own header for
 * the full stale-key/out-of-order-response reasoning this mirrors
 * exactly, with a stringified body `key` standing in for `path`). Exists
 * because the shared query engine's one HTTP entry point, POST /query,
 * takes a JSON body rather than a GET path/querystring -- every other
 * /query caller so far (PlayerDetailPage, TeamDetailPage) fits
 * useApiFetch's GET-path shape fine via their own dedicated routes, but
 * the League Leaderboard (scope: "leaderboard") goes straight through
 * POST /query itself, so it needs a body-based version of the same hook
 * rather than a one-off fetch effect that skips the stale-response
 * guards every other data-backed page already gets for free.
 *
 * @param {object|null} body - null/false skips the fetch (e.g. waiting
 *   on a required filter). Compared by JSON.stringify, so pass a plain,
 *   stably-ordered object.
 */
export function useQueryPost(body) {
  const key = body ? JSON.stringify(body) : null;

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!!key);

  // Same isStale double-guard as useApiFetch: fetchedKey is render-safe
  // state (not a ref) so a render that happens between `key` changing and
  // the effect below re-running never shows the previous key's data as if
  // it were current.
  const [fetchedKey, setFetchedKey] = useState(null);
  const isStale = key !== fetchedKey;

  // Guards against an older in-flight request's response overwriting a
  // newer one (e.g. flipping the stat dropdown twice quickly) -- written
  // only in a dependency-less effect, never during render, for the same
  // concurrent-rendering-safety reason useApiFetch.js's own latestPathRef
  // documents.
  const latestKeyRef = useRef(key);
  useEffect(() => {
    latestKeyRef.current = key;
  });

  const { logout } = useAuth();
  const navigate = useNavigate();

  const refetch = useCallback(async () => {
    if (!key) return;
    const requestKey = key;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch('/query', { method: 'POST', body: JSON.parse(key) });
      if (latestKeyRef.current !== requestKey) return; // superseded by a newer request
      setFetchedKey(requestKey);
      setData(result);
      setLoading(false);
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      if (latestKeyRef.current !== requestKey) return;
      setFetchedKey(requestKey);
      setError(err.message || 'Something went wrong');
      setLoading(false);
    }
  }, [key, logout, navigate]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    data: isStale ? null : data,
    error: isStale ? null : error,
    loading: loading || isStale,
    refetch,
  };
}
