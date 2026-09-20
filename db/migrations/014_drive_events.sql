-- =========================================================================
-- Migration: add game_drives (drive-by-drive play-by-play)
-- =========================================================================
-- Part 2 backlog item 2 (docs/part2-roadmap.md) — "Drive events (play-by-
-- play) for live games," split out from the original "fuller live gamecast
-- view" item once the box score/top-performers half shipped (2026-09-17).
-- That item's whole blocker was "no confirmed data source exists"; resolved
-- live 2026-09-20 (a real Sunday, CIN@HOU 2nd quarter): the SAME
-- /matches/{id} Highlightly endpoint sync_injury_reports already calls
-- carries a real `events` array — one entry per drive/possession (team,
-- start/end clock+period+yardLine, a result like "Punt", a "3 plays, 6
-- yards, 1:05" summary, isScoringPlay), each with a nested `playDetails`
-- array giving every individual play (down, distance, yardLine,
-- yardsToEndzone, play type, the human-readable play text, clock, period).
-- See worker/ingestion-worker.js's syncDriveEvents() for the full vendor-
-- shape writeup and the real captured sample it was built against.
--
-- Design notes:
--   - One row per drive (possession), not one row per play. playDetails is
--     kept as-is in a JSONB column rather than exploded into a child
--     table — this is real display data (a play list a person reads, not
--     something queried play-by-play from SQL), same "denormalized JSONB
--     for the real inputs" pattern matchup_scores.breakdown already uses
--     (db/migrations/005_matchup_scores.sql).
--   - start_period/end_period are the vendor's own raw label ("1st
--     Quarter", "2nd Quarter", ...) kept as TEXT rather than parsed into
--     an int — same "store what's given" reasoning as elsewhere in this
--     app; overtime labels aren't confirmed against a real sample yet, so
--     forcing a numeric quarter column now would be guessing at a format
--     that hasn't actually been seen.
--   - Highlightly's `events` response is the FULL drive list so far on
--     every poll, not a delta — the sync job (see ingestion-worker.js)
--     replaces a game's drives wholesale each tick (DELETE + re-INSERT)
--     rather than trying to diff/upsert individual drives, so this table
--     is NOT an append-only time series the way player_prop_odds/game_odds
--     are. drive_sequence (1-based, the vendor array's own order) plus the
--     UNIQUE constraint below is what makes that safe to do repeatedly.
--   - No new Highlightly call shape — this reuses the exact
--     /matches/{id} detail endpoint sync_injury_reports already fetches,
--     just a separate call (same "one job = one clear job" convention the
--     rest of ingestion-worker.js follows, not a shared-fetch
--     optimization). See syncDriveEvents()'s own comment for the real
--     interval/cost math against the 7,500/day Pro-tier quota.
--   - CONFIRMED SEPARATELY while verifying this, in a different job:
--     fetchHighlightly('/matches/{id}') actually returns an ARRAY of one
--     match object, not a bare object (Array.isArray === true, length 1,
--     confirmed live 2026-09-20). sync_injury_reports reads
--     `detail.injuries` directly with no unwrapping, which is always
--     undefined on an array — so `detail.injuries || []` has silently
--     iterated an empty list on every run since that job shipped, meaning
--     it has likely never actually recorded a real injury row. NOT fixed
--     in this migration (out of scope for drive events) — flagged in
--     docs/part2-roadmap.md as its own backlog item.
-- =========================================================================

CREATE TABLE game_drives (
    drive_id            SERIAL PRIMARY KEY,
    game_id              VARCHAR(20) NOT NULL REFERENCES games(game_id),
    team_id               INT NOT NULL REFERENCES teams(team_id),  -- possessing team
    drive_sequence      INT NOT NULL,  -- 1-based, vendor's own events[] order

    start_period          TEXT,   -- vendor's raw label, e.g. "1st Quarter"
    start_clock            TEXT,   -- "15:00"
    start_yard_line       INT,

    end_period             TEXT,
    end_clock               TEXT,
    end_yard_line          INT,

    result                  TEXT,   -- "Punt", "Touchdown", "Field Goal", ...
    description             TEXT,   -- "3 plays, 6 yards, 1:05"
    is_scoring_play        BOOLEAN NOT NULL DEFAULT false,
    play_details            JSONB NOT NULL,  -- vendor's playDetails array, verbatim

    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (game_id, drive_sequence)
);

CREATE INDEX idx_game_drives_game_id ON game_drives(game_id);
