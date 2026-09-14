import { useEffect, useRef } from 'react';
import { useApiFetch } from './useApiFetch';

/**
 * Resolves "this week" (GET /games/current-week, backend/lib/
 * current-week.js — added 2026-09-14 alongside BoardPage.jsx) once per
 * mount and calls `onResolve({season, week})` the first time it arrives,
 * so a page's own season/week selectors can seed themselves with a real
 * default instead of a hardcoded season + "week 1" (or a blank week, as
 * RankingsPage.jsx used to default to before this existed — see that
 * page's own header comment).
 *
 * Deliberately fire-once, not "keep in sync": a user who's already typed
 * their own week before this resolves keeps what they typed — this only
 * ever overwrites a page's OWN initial default, and only the first time
 * real data shows up. onResolve is read through a ref, the same pattern
 * useApiFetch.js's own `latestPathRef` uses and for the same reason: a
 * fresh closure every render shouldn't have to be memoized by every
 * caller just to go in this hook's own effect dependency array.
 */
export function useCurrentWeek(onResolve) {
  const { data } = useApiFetch('/games/current-week');
  const appliedRef = useRef(false);
  const onResolveRef = useRef(onResolve);

  useEffect(() => {
    onResolveRef.current = onResolve;
  });

  useEffect(() => {
    if (appliedRef.current) return;
    const current = data?.data;
    if (!current) return;
    appliedRef.current = true;
    onResolveRef.current(current);
  }, [data]);
}
