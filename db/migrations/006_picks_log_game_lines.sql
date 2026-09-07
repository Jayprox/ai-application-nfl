-- =========================================================================
-- Migration: extend picks_log to support game-level picks
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql and 002-005).
--
-- Part 2 Phase 2 (docs/part2-roadmap.md) — the portfolio agent's job is
-- "given a goal and a unit size, build a slate from the strongest edges
-- with reasoning." The edge agent (backend/lib/edge.js) only ever
-- produces GAME-level disagreements (spreads/h2h), but 004_picks_log.sql
-- scoped picks_log to player-stat picks only — its own header explicitly
-- called this out: "Revisit this table if/when a game-level pick type is
-- actually needed." That need has now arrived, so this migration does
-- exactly that, rather than force-fitting a game-level pick into
-- player_id/stat_category columns it doesn't actually have data for.
--
-- Design notes:
--   - pick_type distinguishes the two shapes. The four original
--     player-stat columns (player_id, stat_category, predicted_direction,
--     predicted_line) are relaxed to nullable rather than dropped/
--     replaced — existing 'player_stat' rows are untouched, and the
--     grading job (gradePendingPicks in worker/ingestion-worker.js)
--     branches on pick_type to know which set of columns to read.
--   - market reuses odds_market_enum (003_game_odds.sql) rather than
--     inventing a parallel enum — a game_line pick is always "the model's
--     read on one of these three markets," so the vocabulary should
--     match game_odds exactly.
--   - predicted_team_id (nullable, FK teams) is new: for h2h/spreads
--     picks the thing being predicted is a SIDE, not an over/under
--     direction, so predicted_direction doesn't apply there. For a
--     totals pick there's no side at all — it reuses predicted_direction/
--     predicted_line exactly like a player_stat pick (over/under a
--     number), just with player_id/stat_category left NULL.
--   - units (nullable NUMERIC) records the portfolio agent's flat
--     unit-sizing decision per pick (Part 2 Phase 2 bet-sizing decision:
--     flat units, not proportional to edge/confidence). NULL for older
--     rows and for any pick logged before a sizing decision existed.
--   - The CHECK constraint enforces exactly one of three shapes per row,
--     so a bad insert fails loudly at write time instead of producing a
--     picks_log row that gradePendingPicks can't make sense of later:
--       1. player_stat  — player_id, stat_category, predicted_direction,
--                          predicted_line all set; market/predicted_team_id
--                          NULL.
--       2. game_line + h2h/spreads — predicted_team_id set (the side
--                          picked); predicted_direction/predicted_line/
--                          player_id/stat_category NULL.
--       3. game_line + totals — predicted_direction + predicted_line set
--                          (over/under the combined score), same as a
--                          player_stat pick's over/under shape, but
--                          player_id/stat_category/predicted_team_id NULL
--                          (a totals pick has no player and no side).
-- =========================================================================

CREATE TYPE pick_type_enum AS ENUM ('player_stat', 'game_line');

ALTER TABLE picks_log
    ADD COLUMN pick_type          pick_type_enum NOT NULL DEFAULT 'player_stat',
    ADD COLUMN market             odds_market_enum,
    ADD COLUMN predicted_team_id  INT REFERENCES teams(team_id),
    ADD COLUMN units              NUMERIC(6,2);

-- Relax the four player-stat columns — a game_line pick populates none
-- of them (h2h/spreads) or only the direction/line pair (totals).
ALTER TABLE picks_log
    ALTER COLUMN player_id DROP NOT NULL,
    ALTER COLUMN stat_category DROP NOT NULL,
    ALTER COLUMN predicted_direction DROP NOT NULL,
    ALTER COLUMN predicted_line DROP NOT NULL;

ALTER TABLE picks_log ADD CONSTRAINT picks_log_shape_check CHECK (
    (
        pick_type = 'player_stat'
        AND player_id IS NOT NULL
        AND stat_category IS NOT NULL
        AND predicted_direction IS NOT NULL
        AND predicted_line IS NOT NULL
        AND market IS NULL
        AND predicted_team_id IS NULL
    ) OR (
        pick_type = 'game_line'
        AND market IN ('h2h', 'spreads')
        AND predicted_team_id IS NOT NULL
        AND player_id IS NULL
        AND stat_category IS NULL
        AND predicted_direction IS NULL
        AND predicted_line IS NULL
    ) OR (
        pick_type = 'game_line'
        AND market = 'totals'
        AND predicted_direction IS NOT NULL
        AND predicted_line IS NOT NULL
        AND player_id IS NULL
        AND stat_category IS NULL
        AND predicted_team_id IS NULL
    )
);

-- Grading job needs to tell the two shapes apart cheaply per pending row.
CREATE INDEX idx_picks_log_pick_type ON picks_log(pick_type);
