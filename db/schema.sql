-- =========================================================================
-- Chalk That NFL — Postgres schema (Phase 2 System Design draft)
-- =========================================================================
-- Design notes (see checklist Phase 1/2 discussion for full rationale):
--   * game_slot and weather_condition are precomputed/tagged at ingestion
--     time (not derived per-query) so situational splits are plain WHERE
--     clauses, not runtime joins/computation.
--   * Season averages, home/away records, and every split are NOT stored
--     tables — they're aggregate queries over the *_game_stats tables,
--     filtered via games.game_slot / weather_condition / home-or-away.
--     Redis is what makes repeated versions of these queries cheap; this
--     schema stays honest to "no calculations, raw data only."
--   * player_id uses nflverse's gsis_id convention as a stable, free,
--     cross-source identifier.
--   * Offense / defense / special-teams stats are split into separate
--     tables rather than one wide mostly-null table, since full-roster
--     depth (not just skill positions) is a core requirement. Revisit if
--     this turns out to be the wrong call once real ingestion code exists.
-- =========================================================================

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------

CREATE TYPE roof_type AS ENUM ('dome', 'outdoors', 'closed', 'open');

CREATE TYPE position_group_type AS ENUM ('offense', 'defense', 'special_teams');

CREATE TYPE game_type_enum AS ENUM ('preseason', 'regular', 'postseason');

CREATE TYPE game_slot_enum AS ENUM (
    'sunday_early',   -- 1:00pm ET window
    'sunday_late',    -- 4:05/4:25pm ET window
    'sunday_night',   -- SNF / Sunday primetime
    'monday_night',
    'thursday_night',
    'thanksgiving',
    'saturday',
    'other'
);

CREATE TYPE weather_condition_enum AS ENUM ('sunny', 'overcast', 'rain', 'snow', 'dome');

CREATE TYPE game_status_enum AS ENUM ('scheduled', 'in_progress', 'final', 'postponed');

CREATE TYPE injury_report_status_enum AS ENUM (
    'questionable', 'doubtful', 'out', 'injured_reserve', 'probable', 'active'
);

CREATE TYPE practice_status_enum AS ENUM ('full', 'limited', 'dnp');

-- ---------------------------------------------------------------------
-- Stadiums
-- ---------------------------------------------------------------------

CREATE TABLE stadiums (
    stadium_id      SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    city            TEXT,
    state           TEXT,
    latitude        NUMERIC(9,6) NOT NULL,
    longitude       NUMERIC(9,6) NOT NULL,
    roof            roof_type NOT NULL,
    surface         TEXT,
    timezone        TEXT NOT NULL,          -- IANA tz, e.g. 'America/New_York'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------

CREATE TABLE teams (
    team_id             SERIAL PRIMARY KEY,
    abbreviation        VARCHAR(5) UNIQUE NOT NULL,   -- e.g. 'KC'
    name                TEXT NOT NULL,                -- e.g. 'Kansas City Chiefs'
    conference          VARCHAR(3) NOT NULL,           -- 'AFC' | 'NFC'
    division            VARCHAR(10) NOT NULL,          -- 'East' | 'West' | 'North' | 'South'
    home_stadium_id     INT NOT NULL REFERENCES stadiums(stadium_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------

CREATE TABLE players (
    player_id           VARCHAR(20) PRIMARY KEY,   -- nflverse gsis_id
    full_name           TEXT NOT NULL,
    first_name          TEXT,
    last_name           TEXT,
    position            VARCHAR(5) NOT NULL,        -- QB, RB, WR, TE, DL, LB, CB, S, K, P, ...
    position_group      position_group_type NOT NULL,
    current_team_id     INT REFERENCES teams(team_id),
    birth_date          DATE,
    draft_year          INT,
    draft_round         INT,
    draft_pick          INT,
    status              TEXT NOT NULL DEFAULT 'active',  -- active, injured_reserve, practice_squad, free_agent, retired
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_players_current_team ON players(current_team_id);
CREATE INDEX idx_players_position_group ON players(position_group);

-- ---------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------

CREATE TABLE games (
    game_id                 VARCHAR(20) PRIMARY KEY,   -- e.g. '2026_01_KC_BUF'
    season                  INT NOT NULL,
    week                    INT NOT NULL,
    game_type               game_type_enum NOT NULL DEFAULT 'regular',
    game_datetime           TIMESTAMPTZ NOT NULL,
    home_team_id            INT NOT NULL REFERENCES teams(team_id),
    away_team_id            INT NOT NULL REFERENCES teams(team_id),
    stadium_id              INT NOT NULL REFERENCES stadiums(stadium_id),

    game_slot               game_slot_enum NOT NULL,
    weather_condition       weather_condition_enum,   -- NULL until game is close enough to source
    weather_temp_f          NUMERIC(5,1),
    weather_wind_mph        NUMERIC(5,1),

    home_score              INT,
    away_score              INT,
    status                  game_status_enum NOT NULL DEFAULT 'scheduled',

    schedule_updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- bumped on flex-schedule changes
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_games_season_week ON games(season, week);
CREATE INDEX idx_games_game_slot ON games(game_slot);
CREATE INDEX idx_games_weather_condition ON games(weather_condition);
CREATE INDEX idx_games_home_team ON games(home_team_id);
CREATE INDEX idx_games_away_team ON games(away_team_id);

-- ---------------------------------------------------------------------
-- Team-level box score stats (one row per team per game)
-- ---------------------------------------------------------------------

CREATE TABLE team_game_stats (
    game_id                     VARCHAR(20) NOT NULL REFERENCES games(game_id),
    team_id                     INT NOT NULL REFERENCES teams(team_id),
    is_home                     BOOLEAN NOT NULL,

    points                      INT,
    total_yards                 INT,
    passing_yards                INT,
    rushing_yards                INT,
    turnovers                   INT,
    penalties                   INT,
    penalty_yards                INT,
    time_of_possession_seconds   INT,

    PRIMARY KEY (game_id, team_id)
);

CREATE INDEX idx_team_game_stats_team ON team_game_stats(team_id);

-- ---------------------------------------------------------------------
-- Player-level offense stats (one row per player per game they appeared in)
-- ---------------------------------------------------------------------

CREATE TABLE player_offense_game_stats (
    game_id             VARCHAR(20) NOT NULL REFERENCES games(game_id),
    player_id           VARCHAR(20) NOT NULL REFERENCES players(player_id),
    team_id             INT NOT NULL REFERENCES teams(team_id),

    -- passing
    pass_attempts        INT,
    pass_completions      INT,
    passing_yards         INT,
    passing_tds           INT,
    interceptions_thrown   INT,
    sacks_taken           INT,

    -- rushing
    rush_attempts         INT,
    rushing_yards          INT,
    rushing_tds            INT,
    fumbles               INT,

    -- receiving
    targets               INT,
    receptions            INT,
    receiving_yards        INT,
    receiving_tds          INT,

    PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_player_offense_player_id ON player_offense_game_stats(player_id);
CREATE INDEX idx_player_offense_team ON player_offense_game_stats(team_id);

-- ---------------------------------------------------------------------
-- Player-level defense stats
-- ---------------------------------------------------------------------

CREATE TABLE player_defense_game_stats (
    game_id             VARCHAR(20) NOT NULL REFERENCES games(game_id),
    player_id           VARCHAR(20) NOT NULL REFERENCES players(player_id),
    team_id             INT NOT NULL REFERENCES teams(team_id),

    tackles_solo         INT,
    tackles_assist        INT,
    sacks                NUMERIC(3,1),
    tackles_for_loss       INT,
    qb_hits              INT,
    interceptions         INT,
    passes_defended       INT,
    forced_fumbles        INT,
    fumble_recoveries      INT,
    defensive_tds          INT,

    PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_player_defense_player_id ON player_defense_game_stats(player_id);
CREATE INDEX idx_player_defense_team ON player_defense_game_stats(team_id);

-- ---------------------------------------------------------------------
-- Player-level special teams / kicking stats
-- ---------------------------------------------------------------------

CREATE TABLE player_special_teams_game_stats (
    game_id             VARCHAR(20) NOT NULL REFERENCES games(game_id),
    player_id           VARCHAR(20) NOT NULL REFERENCES players(player_id),
    team_id             INT NOT NULL REFERENCES teams(team_id),

    fg_attempts          INT,
    fg_made              INT,
    longest_fg            INT,
    xp_attempts           INT,
    xp_made               INT,

    punts                INT,
    punt_yards            INT,
    punt_avg              NUMERIC(4,1),

    kick_return_yards      INT,
    punt_return_yards      INT,
    return_tds             INT,

    PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_player_st_player_id ON player_special_teams_game_stats(player_id);
CREATE INDEX idx_player_st_team ON player_special_teams_game_stats(team_id);

-- ---------------------------------------------------------------------
-- Injury reports (time series — one row per status update, not overwritten)
-- ---------------------------------------------------------------------

CREATE TABLE injury_reports (
    report_id           SERIAL PRIMARY KEY,
    player_id           VARCHAR(20) NOT NULL REFERENCES players(player_id),
    team_id              INT NOT NULL REFERENCES teams(team_id),
    season               INT NOT NULL,
    week                 INT NOT NULL,
    report_date           DATE NOT NULL,

    report_status         injury_report_status_enum,
    practice_status        practice_status_enum,
    primary_injury         TEXT,
    secondary_injury        TEXT,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast "give me the latest status for this player this week" lookups
CREATE INDEX idx_injury_reports_player_week
    ON injury_reports(player_id, season, week, report_date DESC);

-- =========================================================================
-- Example split query this schema is meant to make cheap/simple:
--
--   -- A player's rushing yards average at home vs away in snow games
--   SELECT g.weather_condition,
--          (t.team_id = g.home_team_id) AS is_home,
--          AVG(pos.rushing_yards) AS avg_rushing_yards,
--          COUNT(*) AS sample_size
--   FROM player_offense_game_stats pos
--   JOIN games g ON g.game_id = pos.game_id
--   JOIN teams t ON t.team_id = pos.team_id
--   WHERE pos.player_id = :player_id
--     AND g.season = :season
--   GROUP BY g.weather_condition, is_home;
-- =========================================================================
