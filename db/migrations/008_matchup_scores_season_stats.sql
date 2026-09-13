-- =========================================================================
-- Migration: add games_played / season_avg to matchup_scores
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and 002-007).
--
-- Rankings surfaced backups/journeymen above established starters because
-- the blended score (backend/lib/matchup-score.js) is a pure TREND signal
-- -- every category compares a player only to his own baseline, never to
-- the league or to raw production level. A backup who just took over a
-- starting role can swing hard positive on recent_form/role_trend off a
-- thin sample and outscore a star having a normal, steady week.
--
-- These two columns don't change the score itself -- they just carry the
-- raw numbers recent_form (insights.js) already computes as part of its
-- own trend read, purely so the Rankings UI can show actual production
-- (e.g. "245.3 pass yds/gm (6 gm)") next to the trend score, so a high
-- score built on a thin sample doesn't read as equivalent to one backed
-- by real season-long production. Nullable: existing rows stay NULL until
-- the next daily recompute (scripts/compute-matchup-scores.js) fills them
-- in; a player with 0 games played this season also legitimately has no
-- season_avg to show, same graceful-null convention insights.js already
-- follows throughout.
-- =========================================================================

ALTER TABLE matchup_scores
    ADD COLUMN games_played INT,
    ADD COLUMN season_avg   NUMERIC(6,1);
