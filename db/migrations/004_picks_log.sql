-- =========================================================================
-- Migration: add picks_log (calibration/tracking layer)
-- =========================================================================
-- Run this once against the live Railway Postgres (same Data/Query tool
-- used for schema.sql, 002_username_auth.sql, and 003_game_odds.sql).
--
-- Part 2 Phase 2 (docs/part2-roadmap.md, "3 paths" discussion) — before
-- any agent is trusted, there needs to be a place to log what it predicted
-- and a job that checks, once the fact is known, whether it was right.
-- That's this table plus worker/ingestion-worker.js's new grade_picks job.
--
-- Design notes:
--   - Scoped to player-stat picks only (a player + one stat category +
--     an over/under line) for now, NOT game-level picks (spread/total/
--     moneyline). Two reasons: (1) this is exactly the shape the
--     deterministic insight layer (backend/lib/insights.js) already
--     produces — POSITION_STAT_MAP's primaryCol per position is
--     passing_yards / rushing_yards / receiving_yards, plus the combined
--     tackles expression for defense — so a future ranking/edge agent
--     keying off insights has a natural pick to log here without
--     inventing a new stat vocabulary; (2) it's the only shape that's
--     actually testable against the 2021-2025 historical backfill right
--     now, since game_odds only started recording real snapshots when
--     sync_odds went live — there's no historical spread/total data to
--     grade a historical game-level pick against. Revisit this table if/
--     when a game-level pick type is actually needed.
--   - Whether a future agent inserts rows here directly (worker-style, a
--     trusted internal writer) or through a new authenticated POST route
--     on backend-api (matching server.js's "every client talks to this
--     and only this" intent) is an open question deliberately left for
--     when the ranking/edge agents are actually built — this migration
--     only commits to the storage shape, not the write path.
--   - status starts 'pending' and is only ever written by the grading
--     job (or manually, for a withdrawn/bad pick) — never by whatever
--     inserted the pick in the first place.
--   - 'push' exists alongside 'correct'/'incorrect' for the case where
--     actual_value lands exactly on predicted_line — standard sports-
--     betting convention, and worth keeping distinct from a loss so hit
--     rate isn't quietly deflated by pushes.
--   - 'void' covers a pick that can never be graded (the picked player
--     has no stat row for that game — inactive, DNP, vendor gap) rather
--     than leaving it 'pending' forever or force-fitting it to
--     'incorrect'.
-- =========================================================================

CREATE TYPE pick_direction_enum AS ENUM ('over', 'under');
CREATE TYPE pick_status_enum AS ENUM ('pending', 'correct', 'incorrect', 'push', 'void');

CREATE TABLE picks_log (
    pick_id              BIGSERIAL PRIMARY KEY,

    agent_name             TEXT NOT NULL,        -- 'ranking_agent_v1' | 'edge_agent_v1' | 'manual' | ...
                                                    -- free text on purpose — no agents_table exists yet,
                                                    -- and this is meant to be cheap to add a new source to.
    game_id                VARCHAR(20) NOT NULL REFERENCES games(game_id),
    player_id              UUID NOT NULL REFERENCES players(player_id),
    stat_category            TEXT NOT NULL,         -- 'passing_yards' | 'rushing_yards' | 'receiving_yards' | 'tackles'
                                                       -- — mirrors backend/lib/insights.js's POSITION_STAT_MAP /
                                                       -- DEFENSE_STAT primary stats; see worker's STAT_CATEGORY_MAP
                                                       -- for the grading job's column mapping.
    predicted_direction       pick_direction_enum NOT NULL,
    predicted_line             NUMERIC(7,2) NOT NULL,   -- the threshold the pick is against, e.g. 74.5

    confidence                NUMERIC(5,2),            -- optional 0-100 agent-reported score (Part 2 Phase 2's
                                                          -- blended matchup score once that exists); NULL until
                                                          -- an agent sets one.
    reasoning                  TEXT,                     -- optional free-text note, e.g. an insight label/note
                                                            -- the agent keyed its pick off of.

    status                     pick_status_enum NOT NULL DEFAULT 'pending',
    actual_value                NUMERIC(10,2),            -- filled in by the grading job once graded; NULL until then
    graded_at                   TIMESTAMPTZ,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Grading job scans for pending picks whose game is final.
CREATE INDEX idx_picks_log_status ON picks_log(status);
CREATE INDEX idx_picks_log_game ON picks_log(game_id);
-- Hit-rate-by-agent is the primary read pattern once there's more than
-- one agent logging picks.
CREATE INDEX idx_picks_log_agent ON picks_log(agent_name, created_at DESC);
