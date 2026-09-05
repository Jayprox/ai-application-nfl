-- =========================================================================
-- Migration: add matchup_scores (blended per-matchup score)
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql, 002-004).
--
-- Part 2 Phase 2 ("3 paths" discussion) — a single 0-100ish score per
-- player's next upcoming matchup, blending backend/lib/insights.js's four
-- categories into one number. Modeled on the MLB sister app's
-- `matchupScore` pattern (chalk-that-mlb-research-notes.md §2): computed
-- once daily server-side and shared/cached, not recomputed per request.
-- See backend/lib/matchup-score.js for the blend formula and
-- scripts/compute-matchup-scores.js for the daily job (its own small
-- Railway cron service) that writes here.
--
-- Design notes:
--   - PK is (player_id, game_id), not just player_id — game_id is always
--     that player's NEXT scheduled game at compute time. Re-running the
--     daily job while the same game is still upcoming UPSERTs the same
--     row (the score naturally shifts as more of the season's data
--     accrues); once that game goes final and a new one becomes "next,"
--     a new row appears rather than overwriting the old one — so old
--     scores stay queryable afterward for the calibration/tracking layer
--     (picks_log/grade_picks) to eventually check "did a high score here
--     actually predict a good game."
--   - breakdown is denormalized JSONB (the four {category, label, points,
--     note} entries) rather than 4 more columns — this is read-heavy,
--     display-shaped data (same reasoning as game_odds' one-row-per-
--     market shape), not something ever filtered/aggregated by category.
--   - No row is written for a player with zero categories carrying
--     signal (categories_used would be 0) — same "don't fake a neutral
--     reading" philosophy insights.js itself follows for label: null.
-- =========================================================================

CREATE TABLE matchup_scores (
    player_id            UUID NOT NULL REFERENCES players(player_id),
    game_id               VARCHAR(20) NOT NULL REFERENCES games(game_id),
    season                INT NOT NULL,

    score                  NUMERIC(5,1) NOT NULL,   -- 0-100ish blended score, see matchup-score.js
    categories_used          INT NOT NULL,             -- how many of the 4 categories had actual signal (1-4)
    breakdown                JSONB NOT NULL,            -- [{category, label, points, note}, ...] — the inputs that produced `score`

    computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (player_id, game_id)
);

CREATE INDEX idx_matchup_scores_game ON matchup_scores(game_id);
-- Ranking agent's primary read pattern: "top scores across this week's games."
CREATE INDEX idx_matchup_scores_season_score ON matchup_scores(season, score DESC);
