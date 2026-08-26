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
  const { logout } = useAuth();
  const navigate = useNavigate();

  const refetch = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch(path);
      setData(result);
    } catch (err) {
      if (err instanceof AuthError) {
        await logout();
        navigate('/login', { replace: true });
        return;
      }
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [path, logout, navigate]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, error, loading, refetch };
}
