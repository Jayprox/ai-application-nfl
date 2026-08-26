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
  const { logout } = useAuth();
  const navigate = useNavigate();

  const bodyKey = body ? JSON.stringify(body) : null;

  const refetch = useCallback(async () => {
    if (!body) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch('/query', { method: 'POST', body });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bodyKey is the real dependency; body itself is captured fresh whenever bodyKey changes
  }, [bodyKey, logout, navigate]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, error, loading, refetch };
}
