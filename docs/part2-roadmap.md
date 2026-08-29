# Chalk That NFL — Part 2 Roadmap (Agent Team)

Working plan for going from Part 1 (done — stats research app, Phases 1-7
of `vibe-coding-checklist.md`) to Part 2 (an AI agent team that helps make
smarter bets), informed by the live research pass on Chalk That MLB
(`chalk-that-mlb-research-notes.md`). This is a planning draft, not settled
architecture yet — treat it as the starting point for a real discussion,
not a committed decision.

**The one correction to lock in before scoping anything else:** frontend
redesign and agent-team work are *not* sequential-but-separate — the data
work the agents need and the frontend redesign genuinely are separable
(confirmed: push the redesign last), but "the data is fine, just build
agents on top of it" isn't quite right. Part 1's data *foundation* (schema,
ingestion pattern, query engine) is solid. Part 1's data *depth* — odds,
an insight layer, live/current stats, injuries — isn't there yet, and the
agent team can't do much without most of it. So this roadmap treats data
depth and the first agents as one connected effort, not two.

---

## Part 2, Phase 1 — Close the data gaps

Everything here either unblocks an agent directly or is cheap enough not
to defer.

**Status: in progress.** Weather is done and live. Odds ingestion is built
(schema + job) but not yet dry-run tested — needs a real `ODDS_API_KEY`.
Live-stats vendor is decided (Highlightly) but not yet wired.

**Vendor decisions (settled):**
- Weather: **Open-Meteo**, done — turned out to need no API key at all for
  this usage level ("No API key is required" per their own docs), so the
  `OPEN_METEO_API_KEY` this doc and `.env.example` used to mention was
  based on an assumption made before actually integrating it. Removed.
- Live stats + injuries: **Highlightly** (highlightly.net), free tier —
  100 requests/day, no per-second rate limit, covers live scores, box
  scores, rosters, and injuries (embedded in their `/matches/{id}`
  response). Chosen over BallDontLie because BallDontLie's free tier only
  covers teams/games — stats, injuries, and odds all need a paid tier
  there ($9.99-$39.99/mo depending on which endpoints), where Highlightly
  covers stats+injuries free.
- Odds/lines: **The Odds API** (the-odds-api.com), free tier — 500
  credits/month, most bookmakers, all markets (moneyline/spreads/totals)
  plus player props on select books. This is what makes the
  three-free-vendor stack work instead of needing BallDontLie's paid tier
  as a single consolidated vendor.

**Odds/lines ingestion — built, not yet verified live.** This was the
single highest-leverage gap: without odds, no agent can compare its own
read on a matchup against what the market already thinks, which is what
"edge" means and is the mechanic behind three of the MLB app's tabs
(Predict, Board, Scout). Now built: `db/migrations/003_game_odds.sql`
(a new `game_odds` table, append-only — every sync inserts new rows so
line movement over time is queryable, not just a "current odds" snapshot)
and `worker/ingestion-worker.js`'s new `sync_odds` job, reusing the same
proximity-schedule shape as weather. **Not yet dry-run tested** — written
against The Odds API's documented shape but no `ODDS_API_KEY` has been
provisioned anywhere yet, so this hasn't seen a real response. Needs the
same "run it once by hand before trusting the scheduler" treatment every
other job here got, once a key exists.

**Still to do:** sign up for The Odds API and Highlightly (both need an
account created by whoever owns the project — not something to do on
someone else's behalf), provision `ODDS_API_KEY` and `HIGHLIGHTLY_API_KEY`,
dry-run `sync_odds`, then build `sync_injury_reports` and `sync_live_stats`
against Highlightly's documented endpoints (`/matches/{id}` for injuries,
`/box-score/{matchId}` for live stats — a game-identity matching problem
similar to `sync_odds`'s team-name matching, since Highlightly's own game
ids aren't nflverse's `game_id` format).

**Build the deterministic insight layer.** This is the biggest single idea
from the MLB research: `/api/splits` doesn't return raw stats, it returns
`{label: "WEAK SPOT", note: "Severe weakness vs CU — high K exposure"}` —
a rules engine that turns numbers into a verdict, computed once
server-side, no LLM involved. Chalk That NFL's `/query` currently returns
averages only. This needs real design work to scope honestly: nflverse's
free data is play-by-play level, not Statcast-level, so an NFL equivalent
won't be pitch-type granular the way MLB's is — but there's real signal
available (e.g. a WR's performance by target depth/route type vs. what a
specific defense allows, a RB's efficiency vs. run-defense strength, a
defense's pressure rate vs. a specific pass-block unit). Scope the first
version to 3-4 label categories that are honestly supportable with what
nflverse actually provides, not a mechanical port of MLB's pitch-type
system.

**A blended per-matchup score**, computed once per day and cached
(mirroring MLB's "shared daily snapshot" pattern — compute once, serve to
everyone, don't recompute per request/per user). This is the one number
a ranking agent and the UI both key off of, same role as MLB's
`matchupScore`.

---

## Part 2, Phase 2 — The agent team + the calibration loop

Build the calibration/tracking loop **first or in parallel with the first
agent, not after** — it's what turns "the agent said X" into "the agent
was right 61% of the time," and MLB's Picks/Ranks tabs show it's cheap to
build (a log table + a grading job once games finish) and it's the only
thing that actually proves any of this is working.

Rough agent-role breakdown, mapped from what worked in MLB's app (naming
TBD, this is about the roles, not final product surface):

- **Calibration/tracking layer** (build first): logs every pick a human or
  agent makes, grades it once the game's final, tracks hit rate and (if
  units/stakes are tracked) P&L over time. No AI needed for this one at
  all — it's a schema + a grading job.
- **Ranking agent**: surfaces the top matchup scores across upcoming
  games/props for a stat category. Can be pure deterministic scoring
  (insight layer + blended score) with no LLM call — the cheapest agent to
  ship first, and the one to validate the calibration loop against before
  building anything fancier.
- **Edge agent**: once odds data exists, compares the model's implied
  probability against the book's — only worth building after Phase 1's
  odds ingestion lands.
- **Portfolio/bankroll agent**: given a goal and a unit size, builds a
  slate from the strongest edges with reasoning — a distinct concern from
  "which picks are good" (this is "how many, at what size"), matching
  MLB's Scout tab.
- **Conversational/orchestrator agent**: the natural-language front end.
  This is the one that actually needs an LLM in the loop, and per
  `docs/architecture.md` §5's existing design, it should only ever
  *translate* intent into a call against the structured agents/API above —
  never compute or invent a number itself.

Suggested build order within this phase: calibration layer → ranking
agent (validate against real historical outcomes once there's enough
graded data) → edge agent (once odds exist) → portfolio agent → chat/
orchestrator last, once there's something real for it to call into.

---

## Part 2, Phase 3 — Frontend redesign

Only after the team above is producing something worth looking at. A
Slate/Board/Game-style UI (per-game deep dive with situational context,
per-market ranked boards, a portfolio builder, a logged track record) is
the right shape to aim for based on what's proven out in the MLB app — but
building it before the agents exist means designing UI for data that
doesn't exist yet. Current frontend (5 screens, hardened) keeps working as
the stats-browsing surface in the meantime; nothing about Phases 1-2 above
requires touching it.

---

## Open decisions this roadmap doesn't resolve

- Exactly which NFL stat splits are honestly supportable as "insight layer"
  categories given nflverse's free-tier depth.
- Whether the ranking/edge/portfolio agents need to be LLM-backed at all,
  or whether (like MLB's Board/Model appear to be) they're better as pure
  deterministic scoring with an LLM only in the conversational layer on
  top. Leaning toward deterministic-first, based on what MLB's app
  actually seems to do.
