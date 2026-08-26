/**
 * Thin wrapper around localStorage for the JWT access/refresh token pair.
 * Kept in one place so AuthContext and the API client agree on the exact
 * same storage keys and never drift.
 */

const ACCESS_TOKEN_KEY = 'ctnfl_access_token';
const REFRESH_TOKEN_KEY = 'ctnfl_refresh_token';

export function getTokens() {
  return {
    accessToken: localStorage.getItem(ACCESS_TOKEN_KEY),
    refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY),
  };
}

export function setTokens({ accessToken, refreshToken }) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}
