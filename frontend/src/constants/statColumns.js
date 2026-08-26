// Mirrors backend/routes/query.js's PLAYER_STAT_TABLES/PLAYER_STAT_COLUMNS
// exactly — one label per column, keyed the same way the query engine
// keys its response, so a new stat column only ever needs to be added in
// two places (there, and here) rather than drifting independently.

export const STAT_COLUMNS_BY_POSITION_GROUP = {
  offense: [
    { key: 'pass_attempts', label: 'Pass Attempts' },
    { key: 'pass_completions', label: 'Completions' },
    { key: 'passing_yards', label: 'Passing Yards' },
    { key: 'passing_tds', label: 'Passing TDs' },
    { key: 'interceptions_thrown', label: 'Interceptions' },
    { key: 'sacks_taken', label: 'Sacks Taken' },
    { key: 'rush_attempts', label: 'Rush Attempts' },
    { key: 'rushing_yards', label: 'Rushing Yards' },
    { key: 'rushing_tds', label: 'Rushing TDs' },
    { key: 'fumbles', label: 'Fumbles' },
    { key: 'targets', label: 'Targets' },
    { key: 'receptions', label: 'Receptions' },
    { key: 'receiving_yards', label: 'Receiving Yards' },
    { key: 'receiving_tds', label: 'Receiving TDs' },
  ],
  defense: [
    { key: 'tackles_solo', label: 'Solo Tackles' },
    { key: 'tackles_assist', label: 'Assisted Tackles' },
    { key: 'sacks', label: 'Sacks' },
    { key: 'tackles_for_loss', label: 'Tackles for Loss' },
    { key: 'qb_hits', label: 'QB Hits' },
    { key: 'interceptions', label: 'Interceptions' },
    { key: 'passes_defended', label: 'Passes Defended' },
    { key: 'forced_fumbles', label: 'Forced Fumbles' },
    { key: 'fumble_recoveries', label: 'Fumble Recoveries' },
    { key: 'defensive_tds', label: 'Defensive TDs' },
  ],
  special_teams: [
    { key: 'fg_attempts', label: 'FG Attempts' },
    { key: 'fg_made', label: 'FG Made' },
    { key: 'longest_fg', label: 'Longest FG' },
    { key: 'xp_attempts', label: 'XP Attempts' },
    { key: 'xp_made', label: 'XP Made' },
    { key: 'punts', label: 'Punts' },
    { key: 'punt_yards', label: 'Punt Yards' },
    { key: 'punt_avg', label: 'Punt Avg' },
    { key: 'kick_return_yards', label: 'Kick Return Yards' },
    { key: 'punt_return_yards', label: 'Punt Return Yards' },
    { key: 'return_tds', label: 'Return TDs' },
  ],
};
