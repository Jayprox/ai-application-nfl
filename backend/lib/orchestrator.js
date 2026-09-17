/**
 * Chalk That NFL — orchestrator / chat agent
 * =========================================================================
 * Part 2 Phase 2's 5th agent, deliberately built last (docs/part2-
 * roadmap.md — it's most useful once the other four have real graded
 * data to draw on). v1 scope, chosen explicitly over a fuller assistant:
 * READ-ONLY. It answers natural-language questions by calling out to the
 * same deterministic agents every other screen already uses (ranking,
 * edge, insights, picks, leaderboard) — it never generates or logs a new
 * pick itself (that stays POST /portfolio/slate, a distinct, deliberate
 * write path with its own confirmation story). This is the first place
 * in the codebase that calls an LLM at all — every other agent so far is
 * explicitly "deterministic, no LLM call" (see lib/ranking.js's header).
 *
 * Calls the Anthropic Messages API directly over fetch (Node 18+ has a
 * global fetch — confirmed available here) rather than pulling in the
 * @anthropic-ai/sdk package. Same reasoning as lib/rate-limit.js's own
 * "no new dependency" note: this sandbox's dev loop can't `npm install`
 * a new package before it can be tested, and a handful of fetch calls is
 * a small enough surface not to need the SDK.
 *
 * Tool-calling loop: the model gets a fixed set of read-only tools (below)
 * backed directly by this codebase's own lib functions and a few compact
 * read queries — never a second HTTP hop back into this same API. Runs up
 * to MAX_TOOL_ROUNDS rounds of tool_use before giving up, so a confused
 * model can't loop forever racking up API cost against one chat message.
 *
 * ANTHROPIC_MODEL is deliberately an env var, not only a hardcoded
 * default — model names/availability change over time. The fallback
 * below (claude-haiku-4-5-20251001) was confirmed live against
 * platform.claude.com/docs on 2026-09-13 as Anthropic's current
 * fastest/cheapest tool-use-capable model, after an earlier guess here
 * (claude-3-5-haiku-20241022, a pre-2025 naming scheme) 404'd against
 * the real API the first time this was actually exercised end to end.
 * If this starts 404ing again down the line, that's model retirement,
 * not a bug — check platform.claude.com/docs and set ANTHROPIC_MODEL in
 * Railway rather than trusting this default indefinitely.
 *
 * NL search bar / get_player_stats (2026-09-17, backlog item — see
 * docs/part2-roadmap.md's Backlog and architecture.md §5 for the
 * original design). Closes the gap the original design called out: none
 * of the tools above covered raw per-game stat lookups (season/career
 * averages, splits) — only computed model reads. Two pieces: a new
 * get_player_stats tool (wraps lib/stats-query.js's runStatsQuery(), the
 * same engine POST /query uses) for the general LLM path, and a
 * deterministic pre-LLM shortcut (see tryDeterministicStatsAnswer below)
 * that answers the obvious canonical shapes ("Mahomes 2025", "Saquon
 * Barkley career") without spending a Claude API call at all —
 * architecture.md §5 explicitly flags that per-query LLM cost/latency as
 * the reason NL search was cut from MVP in the first place. Deliberately
 * scoped to Chat only, no new UI surface — Chat already renders whatever
 * plain-text reply comes back, whether it came from the shortcut or from
 * Claude, identically.
 * =========================================================================
 */

const { query } = require('../db');
const { rankMatchups, STAT_CATEGORIES } = require('./ranking');
const { listEdges } = require('./edge');
const { computePlayerInsights } = require('./insights');
const { getCurrentWeek } = require('./current-week');
const {
  runStatsQuery,
  VALID_SCOPES,
  VALID_GAME_SLOTS,
  VALID_WEATHER,
  PLAYER_STAT_COLUMNS,
} = require('./stats-query');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const MAX_TOOL_ROUNDS = 4;
const TOOL_RESULT_CHAR_CAP = 8000; // keeps one bad query result from blowing up the token budget

const SYSTEM_PROMPT = `You are the Chalk That NFL research assistant, embedded in a stats/analytics app.

You have read-only tools onto this app's own data: matchup rankings, model-vs-market edges, deterministic per-player insights, raw per-game stat lookups (season/last5/career, with optional home/away, game-slot, or weather splits), logged picks, and the agent leaderboard. Every number these tools return is a real computed value from ingested NFL data — never invent, estimate, or round-trip a number you didn't get from a tool.

You are scoped to this app only. If asked something with no connection to Chalk That NFL's own data or features — general coding help, DSA/algorithm questions, writing unrelated content, other sports, general trivia, personal advice, etc. — decline in one short sentence and point back to what you can help with (matchups, edges, insights, picks, leaderboard). Do not attempt the off-topic request itself, even partially.

Rules:
- If the user refers to "this week", "the current week", "this season", or otherwise leaves season/week unstated, call get_current_week first to resolve it to a concrete season/week, then use that for any other tool call that needs one. Don't ask the user to supply season/week unless get_current_week can't resolve one (e.g. no games in the schedule at all).
- For any question involving specific numbers, rankings, players, or games, call a tool rather than answering from memory.
- get_player_stats is raw actual production (season/career averages or totals, optionally split by home/away, game slot, or weather) — use it for "how did X do in Y" questions. get_player_insights is a different thing: a deterministic model read (matchup/form/situational/role-trend) relative to the player's NEXT game. Don't conflate the two.
- If a tool returns no data or a null/no-signal result, say so plainly (e.g. "no matchup scores computed yet for that week") rather than filling the gap with a guess.
- You cannot generate or log new picks — if asked to "make a pick" or "bet on X", explain that's a separate feature (the Picks/portfolio agent) and instead describe what the data actually shows for that spot.
- This is analysis of a fantasy/predictive model, not betting advice or a guarantee of outcomes — keep that framing when discussing edges or rankings.
- Keep answers concise and concrete: cite the actual numbers the tools returned rather than vague qualitative summaries.`;

const TOOLS = [
  {
    name: 'find_player',
    description:
      'Look up a player by (partial) name to get their player_id, position, and current team abbreviation. Call this before get_player_insights, which needs a player_id, not a name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full or partial player name, e.g. "Mahomes" or "Patrick Mahomes".' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_current_week',
    description:
      'Resolves "this week" / "current week" / "this season" to a concrete {season, week}, using the nearest upcoming scheduled game on the calendar (falls back to the most recently played game once a season is over). Call this first whenever the user references the current week/season without giving explicit values, then pass the returned season/week into other tools.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_rankings',
    description:
      "Top players by matchup score for one stat category, for a season (and optionally one week) — the ranking agent's deterministic read on the most favorable matchups, from matchup/recent-form/situational/role-trend signal only. No market/odds data involved.",
    input_schema: {
      type: 'object',
      properties: {
        stat_category: { type: 'string', enum: STAT_CATEGORIES },
        season: { type: 'integer', description: 'e.g. 2026' },
        week: { type: 'integer', description: 'Optional — omit for a whole-season view.' },
        limit: { type: 'integer', description: 'Max rows to return (default 10, max 25).' },
      },
      required: ['stat_category', 'season'],
    },
  },
  {
    name: 'get_edge',
    description:
      "For a season/week, compares each game's model-based offensive-skill lean against which side the sportsbook actually favors (spreads/h2h), and flags disagreements. A disagreement is worth a second look, not a pick.",
    input_schema: {
      type: 'object',
      properties: {
        season: { type: 'integer' },
        week: { type: 'integer' },
        only_disagreements: { type: 'boolean', description: 'true to only return games where model and market disagree.' },
      },
      required: ['season', 'week'],
    },
  },
  {
    name: 'get_player_insights',
    description:
      'Deterministic per-category read (matchup strength, recent form, situational incl. weather, role/volume trend) for one player relative to their next scheduled game. Requires a player_id from find_player.',
    input_schema: {
      type: 'object',
      properties: {
        player_id: { type: 'string' },
        season: { type: 'integer' },
      },
      required: ['player_id', 'season'],
    },
  },
  {
    name: 'get_player_stats',
    description:
      "Raw stat lookup for one player — season averages, career totals, last-5-game averages, or a full game log — optionally filtered by home/away, game slot (e.g. 'thursday_night', 'monday_night'), or weather. Real per-game production from the *_game_stats tables, not a computed model read — use this for \"how did X do in Y\" questions. Requires a player_id from find_player.",
    input_schema: {
      type: 'object',
      properties: {
        player_id: { type: 'string' },
        scope: { type: 'string', enum: VALID_SCOPES, description: 'season/last5/career/game_log. season, last5, and game_log all need season; career does not.' },
        season: { type: 'integer', description: 'e.g. 2026 — required unless scope is "career".' },
        home_away: { type: 'string', enum: ['home', 'away'] },
        game_slot: { type: 'string', enum: VALID_GAME_SLOTS },
        weather_condition: { type: 'string', enum: VALID_WEATHER },
      },
      required: ['player_id', 'scope'],
    },
  },
  {
    name: 'get_picks',
    description: 'List picks an agent (e.g. portfolio_agent_v1) has logged and how they graded out.',
    input_schema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'correct', 'incorrect', 'push', 'void'] },
      },
    },
  },
  {
    name: 'get_leaderboard',
    description: 'Every agent that has logged at least one pick, ranked by hit rate.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_all_teams',
    description: "All 32 teams' id/abbreviation/name — use this to translate a team_id from another tool's result into a readable name.",
    input_schema: { type: 'object', properties: {} },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case 'find_player': {
      const { rows } = await query(
        `SELECT p.player_id, p.full_name, p.position, t.abbreviation AS team_abbreviation
         FROM players p
         LEFT JOIN teams t ON t.team_id = p.current_team_id
         WHERE p.full_name ILIKE $1
         ORDER BY p.full_name
         LIMIT 10`,
        [`%${input.name}%`]
      );
      return rows;
    }

    case 'get_current_week': {
      // Shared with GET /games/current-week (backend/routes/games.js) via
      // lib/current-week.js — see that file's header for why this used to
      // be the only place this query lived.
      const current = await getCurrentWeek();
      return current || { error: 'No games found in the schedule.' };
    }

    case 'get_rankings': {
      if (!STAT_CATEGORIES.includes(input.stat_category)) {
        return { error: `stat_category must be one of: ${STAT_CATEGORIES.join(', ')}` };
      }
      return rankMatchups({
        statCategory: input.stat_category,
        season: input.season,
        week: input.week,
        limit: Math.min(Number(input.limit) || 10, 25),
      });
    }

    case 'get_edge': {
      return listEdges({
        season: input.season,
        week: input.week,
        onlyDisagreements: !!input.only_disagreements,
      });
    }

    case 'get_player_insights': {
      const result = await computePlayerInsights(input.player_id, input.season);
      return result || { error: 'player not found' };
    }

    case 'get_player_stats': {
      if (!VALID_SCOPES.includes(input.scope)) {
        return { error: `scope must be one of: ${VALID_SCOPES.join(', ')}` };
      }
      if (input.scope !== 'career' && !input.season) {
        return { error: 'season is required unless scope is "career"' };
      }
      const splits = {};
      if (input.home_away) splits.home_away = input.home_away;
      if (input.game_slot) splits.game_slot = input.game_slot;
      if (input.weather_condition) splits.weather_condition = input.weather_condition;
      const result = await runStatsQuery({
        entity_type: 'player',
        entity_id: input.player_id,
        scope: input.scope,
        season: input.season,
        splits,
      });
      if (result.error) return { error: result.error };
      return { data: result.data, sample_size: result.sampleSize };
    }

    case 'get_picks': {
      const conditions = [];
      const params = [];
      if (input.agent_name) {
        params.push(input.agent_name);
        conditions.push(`agent_name = $${params.length}`);
      }
      if (input.status) {
        params.push(input.status);
        conditions.push(`status = $${params.length}`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await query(
        `SELECT pick_id, agent_name, pick_type, stat_category, predicted_direction, predicted_line,
                predicted_team_id, market, units, status, actual_value, reasoning, created_at
         FROM picks_log ${whereClause}
         ORDER BY created_at DESC
         LIMIT 15`,
        params
      );
      return rows;
    }

    // Mirrors routes/leaderboard.js's own query rather than importing it —
    // that route (like routes/picks.js) keeps its SQL inline rather than
    // in a lib/ module, unlike ranking/edge/insights/matchup-score which
    // do have one. Duplicating one compact read here beats refactoring a
    // tested, already-deployed route right before the season's underway.
    case 'get_leaderboard': {
      const { rows } = await query(
        `SELECT agent_name,
                COUNT(*) FILTER (WHERE status = 'correct')   AS correct,
                COUNT(*) FILTER (WHERE status = 'incorrect') AS incorrect,
                COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
                COUNT(*)                                     AS total
         FROM picks_log
         GROUP BY agent_name`
      );
      return rows
        .map((r) => {
          const correct = Number(r.correct);
          const incorrect = Number(r.incorrect);
          const decided = correct + incorrect;
          return {
            agent_name: r.agent_name,
            correct,
            incorrect,
            pending: Number(r.pending),
            total: Number(r.total),
            hit_rate_pct: decided > 0 ? Number(((correct / decided) * 100).toFixed(1)) : null,
          };
        })
        .sort((a, b) => (b.hit_rate_pct ?? -1) - (a.hit_rate_pct ?? -1));
    }

    case 'get_all_teams': {
      const { rows } = await query(`SELECT team_id, abbreviation, name FROM teams ORDER BY name`);
      return rows;
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------
// Deterministic StatMuse-style shortcut (2026-09-17, NL search bar
// backlog item). Tries to answer simple, unambiguous raw-stat questions
// ("Mahomes 2025", "Saquon Barkley career", "CMC thursday night")
// without ever calling Claude — architecture.md §5 flags a live LLM call
// as a real per-query cost/latency hit, and these canonical shapes don't
// need one. Deliberately conservative: fires ONLY when exactly one
// player name matches and at least one recognized scope/split/season
// keyword is present in the message; otherwise returns null and
// runChat() falls through to the normal Claude tool-calling loop (which
// still has get_player_stats available, so nothing this shortcut
// declines to handle becomes unanswerable — it just costs a real LLM
// call instead, same as before this shortcut existed). Never guesses on
// an ambiguous match: multiple player hits, or no recognized keyword at
// all, both fall through rather than answer with anything unconfirmed.
// ---------------------------------------------------------------------

const GAME_SLOT_PHRASES = {
  'thursday night': 'thursday_night',
  'monday night': 'monday_night',
  'sunday night': 'sunday_night',
  thanksgiving: 'thanksgiving',
  saturday: 'saturday',
};
const WEATHER_PHRASES = {
  rain: 'rain',
  rainy: 'rain',
  snow: 'snow',
  snowy: 'snow',
  dome: 'dome',
  indoors: 'dome',
  sunny: 'sunny',
  overcast: 'overcast',
};
const GAME_SLOT_LABEL = {
  thursday_night: 'Thursday nights',
  monday_night: 'Monday nights',
  sunday_night: 'Sunday nights',
  thanksgiving: 'Thanksgiving',
  saturday: 'Saturdays',
};
const STAT_LABELS = {
  pass_attempts: 'pass att', pass_completions: 'completions', passing_yards: 'pass yds', passing_tds: 'pass TD',
  interceptions_thrown: 'INT', sacks_taken: 'sacks taken', rush_attempts: 'rush att', rushing_yards: 'rush yds',
  rushing_tds: 'rush TD', fumbles: 'fumbles', targets: 'targets', receptions: 'rec', receiving_yards: 'rec yds', receiving_tds: 'rec TD',
  tackles_solo: 'solo tkl', tackles_assist: 'ast tkl', sacks: 'sacks', tackles_for_loss: 'TFL', qb_hits: 'QB hits',
  interceptions: 'INT', passes_defended: 'PD', forced_fumbles: 'FF', fumble_recoveries: 'FR', defensive_tds: 'def TD',
  fg_attempts: 'FG att', fg_made: 'FG made', longest_fg: 'long FG', xp_attempts: 'XP att', xp_made: 'XP made',
  punts: 'punts', punt_yards: 'punt yds', punt_avg: 'punt avg', kick_return_yards: 'KR yds', punt_return_yards: 'PR yds', return_tds: 'ret TD',
};
// Words that show up in a natural stat question but don't help identify
// the player — stripped before treating what's left as the name
// candidate, so "how did Mahomes do this season" still isolates
// "Mahomes" rather than failing to match on the whole phrase.
const FILLER_WORDS = ['how', 'did', 'do', 'does', 'in', 'this', 'season', 'stats', 'stat', 'what', 'were', 'was', 'his', 'her', 'the', 'for', 'a', 'an', 'of', 'game', 'games', 'give', 'me', 'tell', 'show', 'get', 'and'];

function extractDeterministicIntent(message) {
  let remaining = ` ${message.toLowerCase().replace(/'s\b/g, '').replace(/[?.,!]/g, ' ')} `;
  const splits = {};
  let scope = null;
  let season = null;
  let matchedKeyword = false;

  for (const [phrase, slot] of Object.entries(GAME_SLOT_PHRASES)) {
    if (remaining.includes(` ${phrase} `)) {
      splits.game_slot = slot;
      remaining = remaining.replace(` ${phrase} `, ' ');
      matchedKeyword = true;
      break;
    }
  }
  for (const [phrase, cond] of Object.entries(WEATHER_PHRASES)) {
    if (remaining.includes(` ${phrase} `)) {
      splits.weather_condition = cond;
      remaining = remaining.replace(` ${phrase} `, ' ');
      matchedKeyword = true;
      break;
    }
  }
  if (remaining.includes(' home ')) {
    splits.home_away = 'home';
    remaining = remaining.replace(' home ', ' ');
    matchedKeyword = true;
  } else if (remaining.includes(' away ') || remaining.includes(' on the road ')) {
    splits.home_away = 'away';
    remaining = remaining.replace(' away ', ' ').replace(' on the road ', ' ');
    matchedKeyword = true;
  }

  if (remaining.includes(' career ')) {
    scope = 'career';
    remaining = remaining.replace(' career ', ' ');
    matchedKeyword = true;
  } else if (remaining.includes(' last 5 ') || remaining.includes(' last five ') || remaining.includes(' last5 ')) {
    scope = 'last5';
    remaining = remaining.replace(' last 5 ', ' ').replace(' last five ', ' ').replace(' last5 ', ' ');
    matchedKeyword = true;
  } else if (remaining.includes(' game log ') || remaining.includes(' gamelog ') || remaining.includes(' every game ')) {
    scope = 'game_log';
    remaining = remaining.replace(' game log ', ' ').replace(' gamelog ', ' ').replace(' every game ', ' ');
    matchedKeyword = true;
  } else if (remaining.includes(' season ')) {
    scope = 'season';
    matchedKeyword = true;
  }

  const yearMatch = remaining.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    season = parseInt(yearMatch[0], 10);
    remaining = remaining.replace(yearMatch[0], ' ');
    matchedKeyword = true;
  }

  const nameCandidate = remaining
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.includes(w))
    .join(' ')
    .trim();

  if (!matchedKeyword || nameCandidate.length < 3) return null;
  if (!scope) scope = 'season';

  return { nameCandidate, scope, season, splits };
}

function describeSplits(splits) {
  const bits = [];
  if (splits.game_slot) bits.push(GAME_SLOT_LABEL[splits.game_slot] || splits.game_slot);
  if (splits.weather_condition) bits.push(`in ${splits.weather_condition}`);
  if (splits.home_away) bits.push(splits.home_away === 'home' ? 'at home' : 'on the road');
  return bits.length ? ` (${bits.join(', ')})` : '';
}

function formatStatsReply(player, scope, season, splits, data, sampleSize) {
  const splitPhrase = describeSplits(splits);
  const scopeLabel = { season: `${season} season`, last5: 'last 5 games', career: 'career', game_log: `${season} game log` }[scope];

  if (scope === 'game_log') {
    if (!data.length) return `${player.full_name} has no logged games for ${scopeLabel}${splitPhrase}.`;
    const cols = PLAYER_STAT_COLUMNS[player.position_group] || [];
    const lines = data.slice(0, 10).map((row) => {
      const nonZero = cols.filter((c) => Number(row[c]) > 0).map((c) => `${STAT_LABELS[c] || c} ${row[c]}`);
      return `Wk ${row.week}: ${nonZero.join(', ') || 'no production logged'}`;
    });
    const more = data.length > 10 ? ` (+${data.length - 10} more games)` : '';
    return `${player.full_name} — ${scopeLabel}${splitPhrase} (${data.length} games):\n${lines.join('\n')}${more}`;
  }

  if (!sampleSize) {
    return `${player.full_name} has no recorded games for ${scopeLabel}${splitPhrase}.`;
  }

  const cols = PLAYER_STAT_COLUMNS[player.position_group] || [];
  const parts = cols
    .map((c) => [c, Number(data[c]) || 0])
    .filter(([, v]) => Math.abs(v) > 0.01)
    .map(([c, v]) => `${STAT_LABELS[c] || c} ${c === 'punt_avg' || scope !== 'career' ? v.toFixed(1) : Math.round(v)}`);

  const totalsWord = scope === 'career' ? 'totals' : 'averages';
  const body = parts.length ? parts.join(', ') : 'no recorded production';
  return `${player.full_name} — ${scopeLabel}${splitPhrase} ${totalsWord} (${sampleSize} game${sampleSize === 1 ? '' : 's'}): ${body}.`;
}

async function tryDeterministicStatsAnswer(message) {
  if (typeof message !== 'string' || !message.trim()) return null;

  const intent = extractDeterministicIntent(message);
  if (!intent) return null;

  const { rows: playerRows } = await query(
    `SELECT player_id, full_name, position, position_group
     FROM players WHERE full_name ILIKE $1 LIMIT 2`,
    [`%${intent.nameCandidate}%`]
  );
  if (playerRows.length !== 1) return null; // no match, or ambiguous — let Claude handle it

  const player = playerRows[0];
  let season = intent.season;
  if (intent.scope !== 'career' && !season) {
    const current = await getCurrentWeek();
    if (!current) return null;
    season = current.season;
  }

  const result = await runStatsQuery({
    entity_type: 'player',
    entity_id: player.player_id,
    scope: intent.scope,
    season,
    splits: intent.splits,
  });
  if (result.error) return null; // fall through rather than surface a raw error deterministically

  return formatStatsReply(player, intent.scope, season, intent.splits, result.data, result.sampleSize);
}

async function callClaude(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY is not set');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * @param {Array<{role: 'user'|'assistant', content: string}>} history -
 *   plain-text turns from the client. Internal tool_use/tool_result
 *   blocks never leave this function — the client only ever sees plain
 *   user/assistant text.
 * @returns {Promise<{ reply: string }>}
 */
async function runChat(history) {
  // routes/chat.js guarantees the last message has role 'user' before
  // calling this, so no need to search from the end here.
  const latestUserMessage = history[history.length - 1]?.content;
  if (latestUserMessage) {
    const deterministicReply = await tryDeterministicStatsAnswer(latestUserMessage).catch((err) => {
      console.error('[orchestrator] deterministic shortcut failed, falling through to Claude:', err.message);
      return null;
    });
    if (deterministicReply) return { reply: deterministicReply };
  }

  let messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callClaude(messages);
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (!toolUseBlocks.length) {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text || "I don't have anything to add on that." };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let content;
        try {
          const result = await executeTool(block.name, block.input || {});
          content = JSON.stringify(result);
        } catch (err) {
          content = JSON.stringify({ error: err.message });
        }
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: content.slice(0, TOOL_RESULT_CHAR_CAP),
        };
      })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply: "That took more lookups than I'm allowed for one message — try asking a more specific question (a stat category, a season/week, or a player name).",
  };
}

module.exports = { runChat };
