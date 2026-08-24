/**
 * Chalk That NFL — Seed script (scoped-down first pass)
 * =========================================================================
 * Seeds: stadiums, teams, current-season players + their nflverse crosswalk
 * mapping. Deliberately does NOT pull historical games/stats yet — that's
 * a separate follow-up step once this first pass is verified.
 *
 * Requires DATABASE_URL in the environment (or a .env file — see
 * .env.example). Run with: node scripts/seed.js
 * =========================================================================
 */

require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');
const { parse } = require('csv-parse/sync');

const SEASON = 2026;
const ROSTER_URL = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${SEASON}.csv`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------
// Stadiums — hand-curated (stable reference data, ~30 entries since a few
// are shared by two teams). Coordinates are city-level, which is
// sufficient precision for weather API calls (Open-Meteo).
// NOTE: Buffalo's stadium reflects the new Highmark Stadium in Orchard
// Park, NY, opening for the 2026 season (verified via web search rather
// than assumed from training data, since it's a brand-new facility).
// Washington and Tennessee remain at their existing stadiums for 2026
// (both have new stadiums under construction, opening 2027+/2030-ish —
// also verified, not assumed).
// ---------------------------------------------------------------------

const STADIUMS = [
  { key: 'highmark',      name: 'Highmark Stadium',              city: 'Orchard Park', state: 'NY', lat: 42.7738, lon: -78.7870, roof: 'outdoors', surface: 'turf',  timezone: 'America/New_York' },
  { key: 'hard_rock',     name: 'Hard Rock Stadium',              city: 'Miami Gardens', state: 'FL', lat: 25.9580, lon: -80.2389, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'gillette',      name: 'Gillette Stadium',                city: 'Foxborough', state: 'MA', lat: 42.0909, lon: -71.2643, roof: 'outdoors', surface: 'turf',  timezone: 'America/New_York' },
  { key: 'metlife',       name: 'MetLife Stadium',                 city: 'East Rutherford', state: 'NJ', lat: 40.8136, lon: -74.0745, roof: 'outdoors', surface: 'turf',  timezone: 'America/New_York' }, // shared: NYG/NYJ
  { key: 'mt_bank',       name: 'M&T Bank Stadium',                city: 'Baltimore', state: 'MD', lat: 39.2780, lon: -76.6227, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'paycor',        name: 'Paycor Stadium',                  city: 'Cincinnati', state: 'OH', lat: 39.0954, lon: -84.5160, roof: 'outdoors', surface: 'turf',  timezone: 'America/New_York' },
  { key: 'northwest',     name: 'Northwest Stadium',               city: 'Landover', state: 'MD', lat: 38.9077, lon: -76.8645, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'cleveland_browns', name: 'Huntington Bank Field',        city: 'Cleveland', state: 'OH', lat: 41.5061, lon: -81.6995, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'acrisure',      name: 'Acrisure Stadium',                city: 'Pittsburgh', state: 'PA', lat: 40.4468, lon: -80.0158, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'nissan',        name: 'Nissan Stadium',                  city: 'Nashville', state: 'TN', lat: 36.1665, lon: -86.7713, roof: 'outdoors', surface: 'grass', timezone: 'America/Chicago' },
  { key: 'lucas_oil',     name: 'Lucas Oil Stadium',                city: 'Indianapolis', state: 'IN', lat: 39.7601, lon: -86.1639, roof: 'closed',   surface: 'turf',  timezone: 'America/Indiana/Indianapolis' },
  { key: 'everbank',      name: 'EverBank Stadium',                 city: 'Jacksonville', state: 'FL', lat: 30.3239, lon: -81.6373, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'arrowhead',     name: 'GEHA Field at Arrowhead Stadium',  city: 'Kansas City', state: 'MO', lat: 39.0489, lon: -94.4839, roof: 'outdoors', surface: 'grass', timezone: 'America/Chicago' },
  { key: 'allegiant',     name: 'Allegiant Stadium',                city: 'Las Vegas', state: 'NV', lat: 36.0909, lon: -115.1833, roof: 'dome',      surface: 'turf',  timezone: 'America/Los_Angeles' },
  { key: 'sofi',          name: 'SoFi Stadium',                     city: 'Inglewood', state: 'CA', lat: 33.9535, lon: -118.3387, roof: 'dome',      surface: 'turf',  timezone: 'America/Los_Angeles' }, // shared: LAR/LAC
  { key: 'lumen',         name: 'Lumen Field',                      city: 'Seattle', state: 'WA', lat: 47.5952, lon: -122.3316, roof: 'outdoors', surface: 'turf',  timezone: 'America/Los_Angeles' },
  { key: 'levis',         name: "Levi's Stadium",                   city: 'Santa Clara', state: 'CA', lat: 37.4033, lon: -121.9694, roof: 'outdoors', surface: 'grass', timezone: 'America/Los_Angeles' },
  { key: 'state_farm',    name: 'State Farm Stadium',               city: 'Glendale', state: 'AZ', lat: 33.5276, lon: -112.2626, roof: 'closed',    surface: 'grass', timezone: 'America/Phoenix' },
  { key: 'att',           name: 'AT&T Stadium',                     city: 'Arlington', state: 'TX', lat: 32.7473, lon: -97.0945, roof: 'closed',    surface: 'turf',  timezone: 'America/Chicago' },
  { key: 'nrg',           name: 'NRG Stadium',                      city: 'Houston', state: 'TX', lat: 29.6847, lon: -95.4107, roof: 'closed',    surface: 'turf',  timezone: 'America/Chicago' },
  { key: 'ford_field',    name: 'Ford Field',                       city: 'Detroit', state: 'MI', lat: 42.3400, lon: -83.0456, roof: 'closed',    surface: 'turf',  timezone: 'America/Detroit' },
  { key: 'lambeau',       name: 'Lambeau Field',                    city: 'Green Bay', state: 'WI', lat: 44.5013, lon: -88.0622, roof: 'outdoors', surface: 'grass', timezone: 'America/Chicago' },
  { key: 'us_bank',       name: 'U.S. Bank Stadium',                city: 'Minneapolis', state: 'MN', lat: 44.9738, lon: -93.2575, roof: 'dome',      surface: 'turf',  timezone: 'America/Chicago' },
  { key: 'soldier_field', name: 'Soldier Field',                    city: 'Chicago', state: 'IL', lat: 41.8623, lon: -87.6167, roof: 'outdoors', surface: 'grass', timezone: 'America/Chicago' },
  { key: 'mercedes_atl',  name: 'Mercedes-Benz Stadium',             city: 'Atlanta', state: 'GA', lat: 33.7554, lon: -84.4009, roof: 'dome',      surface: 'turf',  timezone: 'America/New_York' },
  { key: 'bank_of_america', name: 'Bank of America Stadium',        city: 'Charlotte', state: 'NC', lat: 35.2258, lon: -80.8528, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'caesars_superdome', name: 'Caesars Superdome',            city: 'New Orleans', state: 'LA', lat: 29.9511, lon: -90.0812, roof: 'dome',      surface: 'turf',  timezone: 'America/Chicago' },
  { key: 'raymond_james', name: 'Raymond James Stadium',            city: 'Tampa', state: 'FL', lat: 27.9759, lon: -82.5033, roof: 'outdoors', surface: 'grass', timezone: 'America/New_York' },
  { key: 'lincoln_financial', name: 'Lincoln Financial Field',      city: 'Philadelphia', state: 'PA', lat: 39.9008, lon: -75.1675, roof: 'outdoors', surface: 'turf',  timezone: 'America/New_York' },
  { key: 'mile_high',      name: 'Empower Field at Mile High',       city: 'Denver', state: 'CO', lat: 39.7439, lon: -105.0201, roof: 'outdoors', surface: 'grass', timezone: 'America/Denver' },
];

// team abbreviation -> stadium key, conference, division
const TEAMS = [
  { abbr: 'BUF', name: 'Buffalo Bills',        conf: 'AFC', div: 'East',  stadium: 'highmark' },
  { abbr: 'MIA', name: 'Miami Dolphins',       conf: 'AFC', div: 'East',  stadium: 'hard_rock' },
  { abbr: 'NE',  name: 'New England Patriots', conf: 'AFC', div: 'East',  stadium: 'gillette' },
  { abbr: 'NYJ', name: 'New York Jets',        conf: 'AFC', div: 'East',  stadium: 'metlife' },
  { abbr: 'BAL', name: 'Baltimore Ravens',     conf: 'AFC', div: 'North', stadium: 'mt_bank' },
  { abbr: 'CIN', name: 'Cincinnati Bengals',   conf: 'AFC', div: 'North', stadium: 'paycor' },
  { abbr: 'CLE', name: 'Cleveland Browns',     conf: 'AFC', div: 'North', stadium: 'cleveland_browns' },
  { abbr: 'PIT', name: 'Pittsburgh Steelers',  conf: 'AFC', div: 'North', stadium: 'acrisure' },
  { abbr: 'HOU', name: 'Houston Texans',       conf: 'AFC', div: 'South', stadium: 'nrg' },
  { abbr: 'IND', name: 'Indianapolis Colts',   conf: 'AFC', div: 'South', stadium: 'lucas_oil' },
  { abbr: 'JAX', name: 'Jacksonville Jaguars', conf: 'AFC', div: 'South', stadium: 'everbank' },
  { abbr: 'TEN', name: 'Tennessee Titans',     conf: 'AFC', div: 'South', stadium: 'nissan' },
  { abbr: 'DEN', name: 'Denver Broncos',       conf: 'AFC', div: 'West',  stadium: 'mile_high' },
  { abbr: 'KC',  name: 'Kansas City Chiefs',   conf: 'AFC', div: 'West',  stadium: 'arrowhead' },
  { abbr: 'LV',  name: 'Las Vegas Raiders',    conf: 'AFC', div: 'West',  stadium: 'allegiant' },
  { abbr: 'LAC', name: 'Los Angeles Chargers', conf: 'AFC', div: 'West',  stadium: 'sofi' },
  { abbr: 'DAL', name: 'Dallas Cowboys',       conf: 'NFC', div: 'East',  stadium: 'att' },
  { abbr: 'NYG', name: 'New York Giants',      conf: 'NFC', div: 'East',  stadium: 'metlife' },
  { abbr: 'PHI', name: 'Philadelphia Eagles',  conf: 'NFC', div: 'East',  stadium: 'lincoln_financial' },
  { abbr: 'WAS', name: 'Washington Commanders', conf: 'NFC', div: 'East', stadium: 'northwest' },
  { abbr: 'CHI', name: 'Chicago Bears',        conf: 'NFC', div: 'North', stadium: 'soldier_field' },
  { abbr: 'DET', name: 'Detroit Lions',        conf: 'NFC', div: 'North', stadium: 'ford_field' },
  { abbr: 'GB',  name: 'Green Bay Packers',    conf: 'NFC', div: 'North', stadium: 'lambeau' },
  { abbr: 'MIN', name: 'Minnesota Vikings',    conf: 'NFC', div: 'North', stadium: 'us_bank' },
  { abbr: 'ATL', name: 'Atlanta Falcons',      conf: 'NFC', div: 'South', stadium: 'mercedes_atl' },
  { abbr: 'CAR', name: 'Carolina Panthers',    conf: 'NFC', div: 'South', stadium: 'bank_of_america' },
  { abbr: 'NO',  name: 'New Orleans Saints',   conf: 'NFC', div: 'South', stadium: 'caesars_superdome' },
  { abbr: 'TB',  name: 'Tampa Bay Buccaneers', conf: 'NFC', div: 'South', stadium: 'raymond_james' },
  { abbr: 'ARI', name: 'Arizona Cardinals',    conf: 'NFC', div: 'West',  stadium: 'state_farm' },
  { abbr: 'LAR', name: 'Los Angeles Rams',     conf: 'NFC', div: 'West',  stadium: 'sofi' },
  { abbr: 'SF',  name: 'San Francisco 49ers',  conf: 'NFC', div: 'West',  stadium: 'levis' },
  { abbr: 'SEA', name: 'Seattle Seahawks',     conf: 'NFC', div: 'West',  stadium: 'lumen' },
];

const POSITION_GROUP = {
  offense: new Set(['QB', 'RB', 'FB', 'HB', 'WR', 'TE', 'T', 'G', 'C', 'OT', 'OG', 'OL']),
  defense: new Set(['DE', 'DT', 'NT', 'LB', 'ILB', 'OLB', 'MLB', 'EDGE', 'CB', 'S', 'SS', 'FS', 'DB']),
  special_teams: new Set(['K', 'P', 'LS']),
};

function positionGroupFor(position) {
  const pos = (position || '').toUpperCase();
  if (POSITION_GROUP.offense.has(pos)) return 'offense';
  if (POSITION_GROUP.defense.has(pos)) return 'defense';
  if (POSITION_GROUP.special_teams.has(pos)) return 'special_teams';
  console.warn(`[seed] unrecognized position "${position}" — defaulting to offense, review manually`);
  return 'offense';
}

// ---------------------------------------------------------------------
// Step 1: stadiums + teams
// ---------------------------------------------------------------------

async function seedStadiumsAndTeams(client) {
  const stadiumIdByKey = {};

  for (const s of STADIUMS) {
    const { rows } = await client.query(
      `INSERT INTO stadiums (name, city, state, latitude, longitude, roof, surface, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING stadium_id`,
      [s.name, s.city, s.state, s.lat, s.lon, s.roof, s.surface, s.timezone]
    );
    stadiumIdByKey[s.key] = rows[0].stadium_id;
  }
  console.log(`[seed] inserted ${STADIUMS.length} stadiums`);

  const teamIdByAbbr = {};
  for (const t of TEAMS) {
    const stadiumId = stadiumIdByKey[t.stadium];
    if (!stadiumId) {
      throw new Error(`No stadium seeded for key "${t.stadium}" (team ${t.abbr}) — see NOTE above about Denver`);
    }
    const { rows } = await client.query(
      `INSERT INTO teams (abbreviation, name, conference, division, home_stadium_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING team_id`,
      [t.abbr, t.name, t.conf, t.div, stadiumId]
    );
    teamIdByAbbr[t.abbr] = rows[0].team_id;
  }
  console.log(`[seed] inserted ${TEAMS.length} teams`);

  return teamIdByAbbr;
}

// ---------------------------------------------------------------------
// Step 2: current roster -> players + player_id_crosswalk
// ---------------------------------------------------------------------

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'chalk-that-nfl-seed-script' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchCsv(res.headers.location)); // follow redirect (GitHub release assets 302)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch ${url}: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function seedRoster(client, teamIdByAbbr) {
  console.log(`[seed] fetching roster: ${ROSTER_URL}`);
  const csvText = await fetchCsv(ROSTER_URL);
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  console.log(`[seed] parsed ${rows.length} roster rows`);

  let inserted = 0;
  let skippedNoTeam = 0;

  for (const row of rows) {
    // nflverse roster columns include: gsis_id, full_name, first_name,
    // last_name, position, team, birth_date, draft_year/round/pick,
    // status — adjust these field names if nflverse's exact column
    // naming has drifted since this was written.
    const teamId = teamIdByAbbr[row.team];
    if (!teamId) {
      skippedNoTeam++;
      continue; // e.g. free agents / retired players with no current team
    }
    if (!row.gsis_id) continue; // skip rows without a usable nflverse id

    const client_result = await client.query(
      `INSERT INTO players (full_name, first_name, last_name, position, position_group,
                             current_team_id, birth_date, draft_year, draft_round, draft_pick, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING player_id`,
      [
        row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        row.first_name || null,
        row.last_name || null,
        row.position || null,
        positionGroupFor(row.position),
        teamId,
        row.birth_date || null,
        row.draft_year ? parseInt(row.draft_year, 10) : null,
        row.draft_round ? parseInt(row.draft_round, 10) : null,
        row.draft_pick ? parseInt(row.draft_pick, 10) : null,
        row.status || 'active',
      ]
    );
    const playerId = client_result.rows[0].player_id;

    await client.query(
      `INSERT INTO player_id_crosswalk (player_id, source, source_player_id, match_confidence)
       VALUES ($1, 'nflverse', $2, 'matched')
       ON CONFLICT (source, source_player_id) DO NOTHING`,
      [playerId, row.gsis_id]
    );

    inserted++;
  }

  console.log(`[seed] inserted ${inserted} players (skipped ${skippedNoTeam} with no matching team — likely free agents/retired)`);
}

// ---------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in (get the value from the Railway dashboard: Postgres service -> Variables).');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const teamIdByAbbr = await seedStadiumsAndTeams(client);
    await seedRoster(client, teamIdByAbbr);
    await client.query('COMMIT');
    console.log('[seed] done — teams, stadiums, and current roster seeded.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
