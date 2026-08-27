import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch, AuthError } from '../api/client';
import { useAuth } from '../context/AuthContext';

/**
 * Shared GET-and-track-state hook used by every data-backed screen
 * (Team browse/detail, Player browse/detail, and later the /query-backed
 * stat views). Centralizing loading/error/AuthError handling here means
 * every page gets the same behavior — including "session expired mid-use
 * -> bounce to /login" — without re-implementing it per screen.
 *
 * @param {string|null} path - null/false skips the fetch entirely (e.g.
 *   waiting on a required param).
 */
export function useApiFetch(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!!path);

  // Tracks which `path` the `data`/`error` state actually came from — set
  // only inside `refetch()` (never during render), so reading it during
  // render is ordinary state access, not a ref read.
  //
  // Why this exists: when `path` changes (e.g. navigating from one team's
  // page to another), React re-renders this component with the new `path`
  // *before* the effect below has a chance to run `refetch()` and flip
  // `loading` to true — so for that one render, `data` still holds the
  // PREVIOUS path's response. Comparing `path` against `fetchedKey` catches
  // that render (isStale) without waiting on the effect, so callers never
  // briefly render a mismatched previous result as if it were current.
  // Same fix in useStatsQuery.js, where the equivalent gap was a real
  // crash, not just a stale flash — see that file's comment for the story.
  const [fetchedKey, setFetchedKey] = useState(null);
  const isStale = path !== fetchedKey;

  const { logout } = useAuth();
  const navigate = useNavigate();

  const refetch = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch(path);
      setFetchedKey(path);
      setData(result);
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      setFetchedKey(path);
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [path, logout, navigate]);

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
