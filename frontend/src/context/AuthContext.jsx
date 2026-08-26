import { createContext, useContext, useState, useCallback } from 'react';
import { apiFetch } from '../api/client';
import { getTokens, setTokens, clearTokens } from '../api/tokenStorage';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Initialize from localStorage so a page refresh doesn't bounce a
  // logged-in user back to /login — the access token itself may be
  // stale, but client.js transparently refreshes it on the first 401.
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getTokens().accessToken);

  const login = useCallback(async (username, password) => {
    const data = await apiFetch('/login', {
      method: 'POST',
      body: { username, password },
      skipAuth: true,
    });
    setTokens(data);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    const { refreshToken } = getTokens();
    // Best-effort — revoke server-side if we can, but don't block the
    // local logout on it (e.g. token's already expired, network hiccup).
    if (refreshToken) {
      try {
        await apiFetch('/logout', { method: 'POST', body: { refreshToken }, skipAuth: true });
      } catch {
        // ignore — clearing local tokens below is what actually logs the
        // user out of this browser regardless of server-side outcome
      }
    }
    clearTokens();
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
