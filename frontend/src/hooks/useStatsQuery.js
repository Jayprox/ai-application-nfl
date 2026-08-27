import { useState, useEffect, useCallback, useRef } from 'react';
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

  // A second, related bug the above alone doesn't cover: switching scope
  // tabs *quickly* (e.g. clicking through all four before the first
  // request returns) fires several overlapping POST /query calls with no
  // cancellation. Network responses can arrive out of order — if an
  // OLDER request's response lands after a NEWER one's, the old response
  // would call setFetchedKey/setData last and win, permanently
  // overwriting the correct current data with a stale result (and, since
  // nothing would trigger another refetch until the user changes
  // something again, the UI could get stuck showing "Loading stats…"
  // forever, or worse, silently show the wrong scope's numbers). This ref
  // always holds the bodyKey belonging to the MOST RECENTLY STARTED
  // request; a response is only applied if it's still that request by
  // the time it resolves. The assignment happens in a (no-dependency-array,
  // runs-after-every-render) effect rather than directly in the render
  // body — mutating a ref during render itself is unsafe under React's
  // concurrent rendering (a render can be started speculatively and
  // discarded), so the write, like the read inside refetch(), stays
  // strictly outside the render phase.
  const latestBodyKeyRef = useRef(bodyKey);
  useEffect(() => {
    latestBodyKeyRef.current = bodyKey;
  });

  const { logout } = useAuth();
  const navigate = useNavigate();

  const refetch = useCallback(async () => {
    if (!body) return;
    const requestKey = bodyKey;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch('/query', { method: 'POST', body });
      if (latestBodyKeyRef.current !== requestKey) return; // superseded by a newer request — ignore this stale response
      setFetchedKey(requestKey);
      setData(result);
      setLoading(false);
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      if (latestBodyKeyRef.current !== requestKey) return;
      setFetchedKey(requestKey);
      setError(err.message || 'Something went wrong');
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
