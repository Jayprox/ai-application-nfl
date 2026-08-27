import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, AuthError } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * POST /query counterpart to useApiFetch — same loading/error/AuthError
 * handling, but for the shared query engine, which takes a JSON body
 * instead of a URL. Pass `null` for body to skip the request entirely
 * (e.g. waiting on a player to finish loading first).
 *
 * Re-fires whenever the *contents* of body change, not just its object
 * identity — body is rebuilt fresh every render by callers (see
 * PlayerDetailPage), so comparing by JSON avoids refetching on every
 * unrelated re-render.
 */
export function useStatsQuery(body) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!!body);

  const bodyKey = body ? JSON.stringify(body) : null;

  // Tracks which bodyKey the current `data`/`error` state actually came
  // from — set only inside `refetch()` (never during render), so reading
  // it during render is ordinary state access, not a ref read.
  //
  // Why this exists — a real bug it fixes, not just defensive style:
  // switching PlayerDetailPage's scope tab (e.g. "Season Avg" -> "Game
  // Log") changes `body.scope`, which changes what SHAPE the caller
  // expects `data` to be (a plain averages object vs. an array of game
  // rows) — but React re-renders PlayerDetailPage with the new `scope`
  // *before* the effect below runs `refetch()` and flips `loading` to
  // true. On that one render, this hook was still returning the PREVIOUS
  // scope's `data` — e.g. a plain object — while the page's render logic
  // had already switched to `scope === 'game_log'` and tried to
  // `rows.map(...)` over it, throwing "TypeError: e.map is not a
  // function" with no error boundary to catch it — the whole app went
  // blank. Comparing `bodyKey` against `fetchedKey` catches that render
  // (isStale) without waiting on the effect, so a caller can never
  // receive a previous query's data paired with a new query's shape
  // expectations.
  const [fetchedKey, setFetchedKey] = useState(null);
  const isStale = bodyKey !== fetchedKey;

  const { logout } = useAuth();
  const navigate = useNavigate();

  const refetch = useCallback(async () => {
    if (!body) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch('/query', { method: 'POST', body });
      setFetchedKey(bodyKey);
      setData(result);
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      setFetchedKey(bodyKey);
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bodyKey is the real dependency; body itself is captured fresh whenever bodyKey changes
  }, [bodyKey, logout, navigate]);

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
