-- =========================================================================
-- Migration: add player_prop_odds (player prop lines)
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and the earlier migrations).
--
-- Part 2 Phase 3 follow-up (2026-09-17, "let's explore adding Game and
-- Player props" request) — game_odds (003_game_odds.sql) only ever
-- covered game-level lines (moneyline/spread/total), which has no
-- player dimension at all. Player props need their own table rather
-- than a new game_odds market value, since a prop line belongs to one
-- specific player on that game, not the game as a whole.
--
-- Backed by the same vendor as game_odds (The Odds API), but a
-- different endpoint: the bulk /v4/sports/.../odds/ call game_odds uses
-- only carries the "featured" markets (h2h/spreads/totals); player
-- markets only come back from the per-event odds endpoint
-- (/v4/sports/.../events/{eventId}/odds), which is queried one game at
-- a time and costs more credits per sync than the bulk call — see
-- worker/ingestion-worker.js's syncPlayerProps job for how that's kept
-- bounded (current week's games only, a curated market list). The exact
-- market list and sync frequency are a starting point, not settled —
-- revisit alongside actual API credit usage once this is live.
--
-- Design notes (mirrors 003_game_odds.sql's own notes where the shape
-- is the same):
--   - Append-only time series, same as game_odds — every sync INSERTs
--     new rows rather than upserting, so prop line movement is
--     queryable later too. GET /props/players (backend/routes/props.js)
--     picks the latest synced_at per (game_id, player_id, bookmaker,
--     market) for a "current props" view, same DISTINCT ON pattern
--     odds.js already uses.
--   - One row covers both sides of the prop (over_price + under_price)
--     rather than one row per outcome, same as game_odds's totals
--     market — matches how The Odds API pairs outcomes.
--   - player_anytime_td has no line/point at all (it's a Yes/No prop,
--     not an Over/Under one) — line stays NULL for that market, and
--     over_price/under_price are reused to hold the Yes/No prices
--     respectively rather than adding two more nullable columns for a
--     single market's sake. Documented here and in props.js/the worker
--     job so this reuse isn't mistaken for a bug later.
--   - Prices widened to NUMERIC(7,2) from the start (game_odds needed
--     009_widen_game_odds_prices.sql to fix a real overflow incident on
--     this exact kind of value — no reason to repeat that here).
--   - bookmaker stored as the vendor's own key, same reasoning as
--     game_odds.
-- =========================================================================

CREATE TYPE player_prop_market_enum AS ENUM (
    'player_pass_yds',
    'player_rush_yds',
    'player_reception_yds',
    'player_receptions',
    'player_anytime_td'
);

CREATE TABLE player_prop_odds (
    prop_id                 BIGSERIAL PRIMARY KEY,
    game_id                 VARCHAR(20) NOT NULL REFERENCES games(game_id),
    player_id               UUID NOT NULL REFERENCES players(player_id),
    bookmaker                TEXT NOT NULL,           -- vendor's bookmaker key, e.g. 'fanduel'
    market                   player_prop_market_enum NOT NULL,

    -- Over/Under point for the 4 yardage/receptions markets. NULL for
    -- player_anytime_td (see header comment above).
    line                     NUMERIC(6,1),

    -- Over/Under prices for the 4 yardage/receptions markets. For
    -- player_anytime_td, reused as Yes/No prices respectively.
    over_price                NUMERIC(7,2),
    under_price                NUMERIC(7,2),

    bookmaker_last_update       TIMESTAMPTZ,           -- vendor-reported "this book last moved" time, not our sync time
    synced_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_player_prop_odds_game_id ON player_prop_odds(game_id);
CREATE INDEX idx_player_prop_odds_player_market_synced ON player_prop_odds(player_id, market, synced_at DESC);
CREATE INDEX idx_player_prop_odds_game_market_synced ON player_prop_odds(game_id, market, synced_at DESC);
