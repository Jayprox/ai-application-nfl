-- =========================================================================
-- Migration: add game_odds (sportsbook lines)
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and 002_username_auth.sql).
--
-- Part 2 Phase 1 (docs/part2-roadmap.md) — the odds gap Chalk That NFL's
-- original MVP deferred entirely. Backed by The Odds API
-- (the-odds-api.com), free tier. See worker/ingestion-worker.js's
-- sync_odds job for the sync logic.
--
-- Design notes:
--   - Every sync INSERTs new rows rather than upserting — this table is
--     an append-only time series of odds snapshots, not a "current odds"
--     cache, so line movement over time is queryable later (the roadmap
--     explicitly calls this out as worth having, and it's what Chalk That
--     MLB's "Odds & Line Movement" panel is built on). The query API's
--     /query endpoint (or a future one) can always pick the latest
--     synced_at per game/bookmaker/market for a "current odds" view.
--   - One row covers both sides of a market (both moneyline prices, both
--     spread sides, or both over/under) rather than one row per outcome —
--     matches how The Odds API already pairs them and how a UI would
--     naturally display a line.
--   - bookmaker is stored as the vendor's own key (e.g. 'fanduel',
--     'draftkings') rather than a foreign key into a bookmakers table —
--     not worth a new table for what's currently just a display label;
--     revisit if/when per-bookmaker configuration (deep links, logos)
--     is ever needed.
-- =========================================================================

CREATE TYPE odds_market_enum AS ENUM ('h2h', 'spreads', 'totals');

CREATE TABLE game_odds (
    odds_id                 BIGSERIAL PRIMARY KEY,
    game_id                 VARCHAR(20) NOT NULL REFERENCES games(game_id),
    bookmaker                TEXT NOT NULL,           -- vendor's bookmaker key, e.g. 'fanduel'
    market                   odds_market_enum NOT NULL,

    -- h2h: moneyline price for each side. spreads: each side's price.
    -- totals: both NULL (see over_price/under_price below instead).
    home_price                NUMERIC(7,2),
    away_price                NUMERIC(7,2),

    -- spreads only: each side's point (e.g. home -3.5 / away +3.5).
    home_point                 NUMERIC(5,1),
    away_point                 NUMERIC(5,1),

    -- totals only.
    over_price                 NUMERIC(7,2),
    under_price                 NUMERIC(7,2),
    total_point                 NUMERIC(5,1),

    bookmaker_last_update       TIMESTAMPTZ,           -- vendor-reported "this book last moved" time, not our sync time
    synced_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_game_odds_game_id ON game_odds(game_id);
CREATE INDEX idx_game_odds_game_market_synced ON game_odds(game_id, market, synced_at DESC);
