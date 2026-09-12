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
 * ANTHROPIC_MODEL is deliberately an env var, not a hardcoded default
 * baked in here — model names/availability change over time and this
 * was written well after this codebase's own knowledge of "what's
 * current" could be stale. Set it in Railway once you've checked
 * console.anthropic.com for whatever the current small/fast model is;
 * the fallback below is a real model id as of when this was written, not
 * a guess, but treat it as a placeholder to double-check, not gospel.
 * =========================================================================
 */

const { query } = require('../db');
const { rankMatchups, STAT_CATEGORIES } = require('./ranking');
const { listEdges } = require('./edge');
const { computePlayerInsights } = require('./insights');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
const MAX_TOKENS = 1024;
const MAX_TOOL_ROUNDS = 4;
const TOOL_RESULT_CHAR_CAP = 8000; // keeps one bad query result from blowing up the token budget

const SYSTEM_PROMPT = `You are the Chalk That NFL research assistant, embedded in a stats/analytics app.

You have read-only tools onto this app's own data: matchup rankings, model-vs-market edges, deterministic per-player insights, logged picks, and the agent leaderboard. Every number these tools return is a real computed value from ingested NFL data — never invent, estimate, or round-trip a number you didn't get from a tool.

Rules:
- For any question involving specific numbers, rankings, players, or games, call a tool rather than answering from memory.
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
