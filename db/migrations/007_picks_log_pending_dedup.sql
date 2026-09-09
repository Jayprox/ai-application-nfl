-- 007_picks_log_pending_dedup.sql
-- =========================================================================
-- Backs the portfolio agent's pending-pick dedup (backend/lib/portfolio.js
-- alreadyLoggedGameIds()) with a real DB constraint, not just an app-level
-- SELECT-then-INSERT check. Without this, two overlapping POST
-- /portfolio/slate calls for the same week (a double-click, or a future
-- cron overlapping a manual call) could both pass the app-level check
-- before either INSERT commits, double-logging a pending pick on the same
-- game under the same agent. buildSlate()'s INSERT now targets this index
-- via ON CONFLICT (agent_name, game_id) WHERE status = 'pending' DO NOTHING,
-- and folds a caught conflict into its `skipped` response array instead of
-- failing the request.
--
-- Partial (WHERE status = 'pending') because the real invariant is "at
-- most one *open* pick per (agent, game)" -- once a pick is graded
-- (correct/incorrect/push/void) that same (agent, game) pair is fair game
-- again (e.g. a hypothetical future agent re-examining a decided game for
-- some other reason). A plain unique index across all statuses would block
-- that forever instead of just while a pick is still open.
-- =========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_log_pending_dedup
  ON picks_log (agent_name, game_id)
  WHERE status = 'pending';
