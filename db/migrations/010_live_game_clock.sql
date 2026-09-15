-- =========================================================================
-- Migration: live scoreboard clock (game_period / game_clock)
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and 002-009).
--
-- "Live updates similar to Chalk That MLB" (docs/part2-roadmap.md,
-- 2026-09-15 scoping). sync_live_scores (worker/ingestion-worker.js)
-- already polls Highlightly's /matches endpoint on a ~10-minute cadence
-- during a game's live window, and per Highlightly's own NFL API
-- documentation (highlightly.net/nfl-api/documentation/, checked
-- 2026-09-15 -- not yet confirmed against a REAL live capture, same
-- "verify before trusting" gap that job's own header comment already
-- flags for state.report/state.description) that same response's
-- `state` object also carries `state.period` (current quarter, e.g. 2)
-- and `state.clock` (time remaining, e.g. "8") right alongside
-- state.score.current, which the job was already parsing. So this is
-- not a new vendor call or added Highlightly quota -- just somewhere for
-- two fields already arriving on every poll to land instead of being
-- discarded.
--
-- game_clock is TEXT rather than an interval/numeric type deliberately:
-- the exact format (seconds? "MM:SS"? bare minutes, per the doc
-- example's plain "8"?) is unconfirmed against real live traffic, so
-- this stores whatever Highlightly sends verbatim rather than guessing a
-- parse that could silently mangle it -- same reasoning
-- STAT_FIELD_MAP/INJURY_STATUS_MAP's own header comment gives for
-- building those off real captured responses instead of docs alone.
-- Nullable, same graceful-null convention as home_score/away_score: a
-- game that hasn't gone live yet (or was synced before this migration
-- ran) just has no period/clock to show.
-- =========================================================================

ALTER TABLE games
    ADD COLUMN game_period SMALLINT,
    ADD COLUMN game_clock  TEXT;
