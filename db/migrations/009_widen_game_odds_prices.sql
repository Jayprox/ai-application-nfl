-- =========================================================================
-- Migration: widen game_odds price columns
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and 002-008).
--
-- CONFIRMED real incident, 2026-09-13 ~20:02 UTC: sync_odds failed with
-- "numeric field overflow" partway through a run during Sunday's live
-- window (games already in progress -- sync_live_stats logged 4-5 live
-- games in the same minute), and kept failing across all 5 of
-- runJob()'s retry attempts before giving up for that run. home_price/
-- away_price/over_price/under_price were sized NUMERIC(7,2) -- max 5
-- integer digits (+/-99999.99) -- against 003_game_odds.sql's original
-- assumption that pre-game moneylines stay comfortably inside that
-- range. The-odds-api's /v4 odds endpoint doesn't cleanly separate
-- pre-match from in-play once a game has kicked off, and an in-play
-- moneyline on a book can spike to 6 digits (e.g. -100000-ish) for a
-- team about to win a decided game -- well outside what a PRE-game line
-- would ever need. Widened here rather than guessing the vendor's exact
-- real ceiling; worker/ingestion-worker.js's syncOdds() was also made
-- fault-tolerant per-row alongside this (one bad row no longer aborts
-- the whole run's remaining inserts), so this migration and that code
-- fix are a matched pair -- the column widening prevents the routine
-- case, the try/catch is the backstop for whatever the vendor throws
-- next that this doesn't anticipate.
--
-- home_point/away_point/total_point (NUMERIC(5,1), spread/total points)
-- are untouched -- no evidence they were involved, and real spreads/
-- totals never approach that column's +/-9999.9 ceiling.
-- =========================================================================

ALTER TABLE game_odds
    ALTER COLUMN home_price  TYPE NUMERIC(9,2),
    ALTER COLUMN away_price  TYPE NUMERIC(9,2),
    ALTER COLUMN over_price  TYPE NUMERIC(9,2),
    ALTER COLUMN under_price TYPE NUMERIC(9,2);
