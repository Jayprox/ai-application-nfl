# Chalk That NFL — Part 2 Roadmap (Agent Team)

Working plan for going from Part 1 (done — stats research app, Phases 1-7
of `vibe-coding-checklist.md`) to Part 2 (an AI agent team that helps make
smarter bets), informed by the live research pass on Chalk That MLB
(`chalk-that-mlb-research-notes.md`). Originally a planning draft; Phases
1 and 2 below are now built and live — this doc is kept updated as a
record of what actually shipped and what's still genuinely open, not just
the original plan.

**The one correction locked in early on:** frontend redesign and
agent-team work are *not* sequential-but-separate — the data work the
agents need and the frontend redesign genuinely are separable (confirmed:
push the redesign last), but "the data is fine, just build agents on top
of it" wasn't quite right at the time. That data depth (odds, an insight
layer, live/current stats, injuries) is what Phase 1 below closed.

---

## Part 2, Phase 1 — Close the data gaps

**Status: done.** All three vendor integrations are live and dry-run
confirmed against real responses, not just written against documented
shapes.

**Vendor decisions (settled):**
- Weather: **Open-Meteo**, done — turned out to need no API key at all for
  this usage level ("No API key is required" per their own docs), so the
  `OPEN_METEO_API_KEY` this doc and `.env.example` used to mention was
  based on an assumption made before actually integrating it. Removed.
- Live stats + injuries: **Highlightly** (highlightly.net via RapidAPI),
  free tier — 100 requests/day, no per-second rate limit, covers live
  scores, box scores, rosters, and injuries. Chosen over BallDontLie
  because BallDontLie's free tier only covers teams/games — stats,
  injuries, and odds all need a paid tier there ($9.99-$39.99/mo
  depending on which endpoints), where Highlightly covers stats+injuries
  free.
- Odds/lines: **The Odds API** (the-odds-api.com), free tier — 500
  credits/month, most bookmakers, all markets (moneyline/spreads/totals)
  plus player props on select books.

**Odds/lines ingestion — built and live.** `db/migrations/003_game_odds.sql`
(a `game_odds` table, append-only — every sync inserts new rows so line
movement over time is queryable, not just a "current odds" snapshot) and
`worker/ingestion-worker.js`'s `sync_odds` job. Dry-run confirmed against
a real key (1508 odds rows across 272 games on the first real run); still
running cleanly today (1972 rows / 212 games on a recent run).

**Injury reports + live stats — built and live** (Highlightly). Dry-run
tested against real injuries and a real completed game's box score —
`STAT_FIELD_MAP`, `INJURY_STATUS_MAP`, and the team-abbreviation alias
(Highlightly says "WSH", our schema says "WAS") were all rewritten from
real captured responses after the original docs-paraphrase guesses turned
out almost entirely wrong. Known, currently-open items, not blockers:
  - `sync_live_stats` still needs to be watched across a few more live
    games to confirm the corrected stat map holds up broadly — one game's
    box score is confirmed, not the full range of stat lines a season
    will produce.
  - **2026-09-13 incident, fixed:** `sync_live_stats` polls every 20s
    during a live game window, and its Highlightly match-id lookup was
    being re-resolved from scratch on every single poll tick instead of
    cached across ticks — dozens of redundant `/matches` calls every 20
    seconds, which blew through the 100-request/day quota within about a
    minute of the first game window opening and 429'd every other
    Highlightly call (including `sync_injury_reports`) for the rest of
    the day. Fixed by moving the match-id cache to module scope so it's
    resolved once per game and reused for the life of the worker process
    (see `worker/ingestion-worker.js`'s `findHighlightlyMatch`) — confirm
    this holds up across a full Sunday slate before considering it fully
    closed.
  - Highlightly's injuries payload never includes an injury type/
    description field (only name/jersey/position/status) — a permanent
    vendor limitation, not a bug. `primary_injury` will stay NULL until/
    unless that changes on their end.

**The deterministic insight layer — built and live.** `backend/lib/
insights.js` computes four label categories per player relative to their
next scheduled game — `matchup` (opponent's recent allowed stats),
`recent_form`, `situational` (includes a weather split — rain/snow vs.
clear — added once the weather data existed), and `role_trend` — each
returning `{label, note}` or `label: null` when there isn't enough same-
season data yet (never a faked/guessed reading). Scoped to four
categories that are honestly supportable with nflverse's free-tier depth,
not a mechanical port of MLB's pitch-type-level system.

**A blended per-matchup score — built and live.** `backend/lib/
matchup-score.js` blends the four insight categories into one 0-100ish
score (baseline 50, ±15/±15/±10/±10 swing), computed once daily by
`scripts/compute-matchup-scores.js` running as its own `matchup-scores-
cron` Railway service and stored in `matchup_scores` — the ranking agent
and Rankings page both key off this table rather than recomputing. Note:
early in a season, before any current-season games have been played, this
correctly writes 0 scores (every insight category has no same-season data
yet, so every player is `categoriesUsed: 0` → no score, matching
insights.js's own "don't fake a reading" convention) — not a bug, this
resolves itself once games are actually played.

---

## Part 2, Phase 2 — The agent team + the calibration loop

**Status: done.** All five roles below are built, deployed, and live —
built in the suggested order (calibration layer → ranking → edge →
portfolio → chat/orchestrator last).

- **Calibration/tracking layer** — `picks_log` (`db/migrations/
  004_picks_log.sql`, extended by `006_picks_log_game_lines.sql`) plus
  `grade_picks`, a Railway-cron job (hourly) that grades pending picks
  against final games and logs the all-time hit rate. No AI involved.
- **Ranking agent** — `backend/lib/ranking.js` + the Rankings page. Pure
  deterministic scoring off `matchup_scores`, no LLM call.
- **Edge agent** — `backend/lib/edge.js` + the Edge page. Compares the
  matchup-score model's offensive-skill lean against the market's actual
  spread/moneyline favorite (from `game_odds`) and flags disagreements.
- **Portfolio/bankroll agent** — `backend/lib/portfolio.js`. The first
  real agent *writer* — logs `game_line` picks into `picks_log` from the
  strongest edges, excluding already-started games.
- **Conversational/orchestrator agent** — `backend/lib/orchestrator.js` +
  the Chat page. The only agent that calls an LLM (Claude, via the
  Anthropic Messages API directly over `fetch`, no SDK dependency) — it
  translates intent into calls against the read-only tools backed by the
  four agents/tables above, never computing or inventing a number itself.
  Read-only in v1 by design: it can't generate or log a pick itself (that
  stays the portfolio agent's job). Ships with a `get_current_week` tool
  so "this week"/"current" resolves against the real schedule instead of
  requiring the user to state a season/week, a scope rule so it declines
  off-topic requests instead of burning tokens on them, and a hand-rolled
  markdown renderer on the frontend so its replies (which vary in
  formatting — sometimes a list, sometimes a table — since LLM output
  isn't deterministic) always render properly instead of showing raw
  markdown syntax.

Confirmed deterministic-first, per the "open decisions" section below:
only the orchestrator has an LLM in the loop.

---

## Part 2, Phase 3 — Frontend redesign

**Status: done.** The Slate/Board/Game shape this phase was aiming for
(per-game deep dive, per-market ranked boards, a portfolio builder, a
logged track record) turned out to already exist as separate working
pages by the time "build the Board" was actually scoped — Rankings, Edge,
Portfolio, Picks/Leaderboard were all live already. So this phase shipped
in two pieces instead of one redesign:

- **Game deep dive — done, 2026-09-14.** `GameDetailPage.jsx`
  (`GET /games/:gameId`, `GET /games/:gameId/injuries`, composed with the
  existing `/edge/games/:gameId` and `/odds/games/:id`) — a game card on
  the Games page now links through to matchup/edge/odds/injuries for that
  one game instead of stopping at the card's own summary.
- **Board home page — done, 2026-09-14.** `BoardPage.jsx`, now the app's
  index route (`/board`, replacing the old redirect to `/games`) — a
  curated front door composed from the pages already listed above (top
  edges, rankings leaders, the portfolio agent's live record, a preview
  of this week's games) rather than a duplicate of any of them, per this
  doc's own "one source of truth, link out rather than duplicate"
  principle. Needed one real gap closed first: `GET /games/current-week`
  (`backend/lib/current-week.js`), since nothing before this had a
  reusable way to resolve "this week" without the user typing a
  season/week.
- **Season/week defaulting on Games/Rankings/Edge/Portfolio — done,
  2026-09-14** (commit `3a9d290`, same day as Board). All four pages now
  seed off `GET /games/current-week` via a shared `useCurrentWeek` hook
  (`frontend/src/hooks/useCurrentWeek.js`) instead of requiring manual
  entry or defaulting to a hardcoded "week 1" — the user can still
  change either. This closes what the note below used to flag as still
  open right after Board shipped; kept here as a corrected record rather
  than silently deleted, since the original note briefly described real
  (now-stale) state.
- **Nav/IA cleanup — done, 2026-09-15.** With the game deep dive, Board,
  and current-week defaulting all shipped, the one concrete redesign gap
  left was the header itself: `Layout.jsx`'s nav had grown to 10 flat
  top-level `NavLink`s in a single row (Board, Games, Teams, Players,
  Picks, Leaderboard, Rankings, Edge, Portfolio, Chat) with no wrap or
  responsive handling — crowded even at desktop widths. Grouped the 9
  non-Board routes into 3 clusters behind a new `NavGroup.jsx` dropdown
  component: Research (Games/Teams/Players), Agents
  (Rankings/Edge/Portfolio/Chat), Record (Picks/Leaderboard) — Board
  stays standalone as the app's own front door. A group's trigger keeps
  the same active-pill styling as a plain link whenever the current
  route matches one of its items, so the user doesn't lose their place
  in the nav just because a route got nested one level deeper. This is
  the redesign work Phase 3 was left open for — closing the phase here.

---

## Part 2, Phase 4 — Visual design pass

**In progress, started 2026-09-15.** Phase 3 closed out the information
architecture (deep dive, Board, current-week defaulting, nav grouping);
this phase is about how it all looks, not what it shows. First round:

- **Typography system.** The app ran on the browser-default sans stack
  through Phase 3 — no font pairing was ever chosen. Added Oswald (a
  condensed, high-contrast "scoreboard" voice) for page titles, the brand
  wordmark, and Board's hero stat numerals, paired with Inter for body
  and data text everywhere else — `--font-display`/`--font-sans` tokens
  in `frontend/src/index.css`, loaded via a Google Fonts link in
  `frontend/index.html`. Applied consistently to every page's `<h1>`
  (uppercase, tracking-wide) rather than only on Board, since a one-off
  font change on a single page would clash with the header/nav right
  next to it instead of reading as a real system.
- **Board hero.** Portfolio Record — the app's actual track record —
  moved up directly under the title instead of sitting as the 4th
  stacked section; Top Edges and Rankings Leaders now sit side by side
  on wide screens instead of stacking the whole page vertically. No
  fetch/data logic changed, presentational only.

---

## Part 2, Phase 5 — Live scoreboard updates

**In progress, started 2026-09-15.** Requested as "live updates similar
to Chalk That MLB" — scoring, stats, time left, quarter. Scoped down to
the scoreboard first (quarter + clock), same incremental approach the
earlier live-scoring rollout took (scoreboard status/score before
touching insights.js) — see "Still genuinely open" above for the
separate, still-parked question of whether live stats should feed
recent_form/role_trend.

- **Quarter + clock — done, 2026-09-15.** No new vendor or added
  Highlightly quota needed: sync_live_scores' existing `/matches` poll
  (~10-minute cadence, worker/ingestion-worker.js) already receives
  `state.period`/`state.clock` alongside the score line it was already
  parsing — this just keeps those two fields instead of discarding them.
  `010_live_game_clock.sql` adds `games.game_period`/`game_clock`;
  StatusBadge.jsx shows "Q2 8:00" instead of a plain Live pill once both
  have landed for a game, falling back to Live otherwise. Per
  Highlightly's own NFL API docs (checked 2026-09-15) but **not yet
  confirmed against a real live capture** — same unconfirmed-until-it-
  actually-runs-live status as `state.report`/`state.description`
  already carried before this.
- **Browser-side live refresh — done, 2026-09-15.** GamesPage, Board's
  games preview, and GameDetailPage now background-poll their own
  `/games`/`/games/:id` fetch on the same ~10-minute cadence as
  sync_live_scores itself, but only while a fetched game is actually
  `in_progress` — a page with no live game on it never starts polling.
  `useApiFetch.js` grew an opt-in `pollMs` param and a `silent` refetch
  mode so the score/clock updates in place without flashing the page's
  loading state on every tick.
- **Top performers + live box score — done, 2026-09-17.** No new vendor
  call needed here either, same story as the quarter/clock fields above:
  `sync_live_stats` has polled Highlightly's `/box-score/{id}` every 30
  minutes during live games since the live-scoring rollout and written
  real per-player lines into `player_offense_game_stats`/`defense`/
  `special_teams_game_stats` — `insights.js` stays gated to
  `status='final'` for its own separate reason, but that gate never
  applied to a raw box score, and until this nothing in the product
  actually read those tables for a live game. New
  `GET /games/:gameId/boxscore` (`backend/routes/games.js`) reads them
  directly by `game_id` — a shape `POST /query`'s player/team+season-scoped
  engine can't express — and `GameDetailPage.jsx` renders a passing/
  rushing/receiving leader per team plus an expandable full box score.
  `LIVE_STATS_INTERVAL_MINUTES` tightened 30 -> 5 now that this is a real
  consumer, same "spend headroom where it shows in the product" call
  `LIVE_SCORE_INTERVAL_MINUTES` already made 2026-09-15 — see that
  constant's own comment in `worker/ingestion-worker.js` for the math.
- **Box score rework: team toggle + category split — done, 2026-09-17.**
  Same-day follow-up once real screenshots of the requested reference
  (the Yahoo Sports app's per-game Stats tab) were available. Replaced
  the side-by-side away+home layout with a single team-toggle pill (the
  reference's own pattern) showing one team's full breakdown at a time,
  and split the one combined Special Teams table into four — Kicking /
  Punting / Punt Return / Kick Return — matching the reference's
  category boundaries. Deliberately does NOT match the reference's exact
  columns: our schema (`PLAYER_STAT_COLUMNS.special_teams`) has no FG%,
  no kicker scoring total, no In20/In10/touchback/blocked-punt tracking,
  no per-return attempt count, and `return_tds` isn't split by return
  type — those columns don't exist here, so the four tables only ever
  render real synced columns, never an invented or estimated one. Every
  player name (Top Performers and the category tables) now links to
  `/players/:id?scope=last5`, landing directly on PlayerDetailPage's
  Last 5 Games tab — see that page's own new `useSearchParams`-driven
  scope, added same day so this link actually lands somewhere real
  instead of always opening to Season Avg regardless of where it came
  from.
- **Season Total added to PlayerDetailPage — done, 2026-09-17.** Same
  request as above ("total stats for the season, not just the average").
  `lib/stats-query.js` gets a new `season_total` scope — SUM (with the
  same longest_fg/punt_avg exceptions `career`'s SUM already uses), just
  scoped to one season instead of every season on record. Genuinely
  distinct from both existing scopes: `season` was already SUM's
  cousin in name only — it's actually a per-game AVERAGE (hence the
  "Season Avg" tab label), and `career` sums across every season, not
  one. Wired into `POST /query` (and, for free, the chat agent's
  `get_player_stats` tool, since both read the same `VALID_SCOPES`
  constant) and a new "Season Total" tab on PlayerDetailPage, next to
  "Season Avg."
- Deliberately NOT done: drive events (play-by-play). Unlike the box
  score above, this has no confirmed data source at all — nflverse is a
  batch/historical export with no live feed, and the one Highlightly
  detail endpoint this app has ever dry-run tested (`/matches/{id}`,
  used for injuries) has only ever been confirmed to carry an
  `.injuries` field; no play/drive field has ever actually been checked
  for. Left in Backlog below pending real research rather than guessed
  at.

---

## Part 2, Phase 6 — Player Props

**Status: done, closed 2026-09-18.** Requested as "let's explore adding
Game and Player props," inspired by a Chalk That MLB props Board
screenshot. Player props only for this phase — Game props (team totals,
alt lines) is a deliberate, scoped-out follow-up, see Backlog below.

- **Backend, worker sync, and the Props board page — done, 2026-09-17**
  (commit `9dd9ef5`). New append-only `player_prop_odds` table
  (`db/migrations/012_player_prop_odds.sql`, 5 launch markets:
  `player_pass_yds`, `player_rush_yds`, `player_reception_yds`,
  `player_receptions`, `player_anytime_td`); new `sync_player_props`
  worker job pulling from The Odds API's per-event endpoint (the bulk
  endpoint `sync_odds` uses only carries featured markets), scoped to
  the current week's games to bound API credit cost; new
  `GET /props/players` route joining each line with the player's real
  last-5-game average (reusing `lib/stats-query.js`) and computing a
  deterministic lean (over/under/toss-up) — same "no predictive
  calculations" principle the rest of Part 1 follows, not a confidence
  score; new `PropsPage.jsx`, market tabs grouped by this week's games.
- **James Cook / suffix-mismatch box-score bug — found and fixed,
  2026-09-18** (commit `ceb7f42`, backfilled live). Highlightly reported
  a live game's James Cook as "James Cook III"; our own roster has him
  as plain "James Cook" — `resolvePlayerForBoxScore()`'s exact-match-only
  comparison silently dropped his whole box-score line every poll tick.
  Fixed with a `stripGenerationalSuffix()` fallback (tried only on a
  genuine zero-match, never to resolve an ambiguity) and backfilled the
  one already-missed game directly against production. Same tick's logs
  also flagged Joshua Palmer/TJ Parker/Tommy Doman Jr./Mike Danna/DJ
  Wonnum as unmatched — worth another look (see Backlog: a sibling
  function turned out to have the identical gap, below).
- **Final-game grading — done, 2026-09-18** (commit `e611128`), same
  pattern `OddsBadge.jsx` already established for game-level odds ("lock
  the values when the game starts... then show what did hit"). Backend
  hands over the player's real per-game stat value once the game is
  final (`final_value`); frontend derives the label/color — same
  division of labor as `OddsBadge`, kept out of `picks_log`/`grade_picks`
  since a prop board entry isn't a user's pick, it's the market's own
  line.
- **DraftKings-only default — done, 2026-09-18** (commit `67666b5`).
  Requested as "switch it to the default, DraftKings." Root-caused a
  real pre-existing bug while implementing it, not just a preference
  change: the original `BOOKMAKER_ORDER` preference-list approach used
  `indexOf()` comparison, and any bookmaker NOT in that list (the
  vendor's real `betonlineag`/`betrivers`/`fanatics` keys, never added)
  resolved to `indexOf() === -1` — numerically lower than every real
  list index, so an unlisted book always won over the intended order,
  which is why the board was showing `betonlineag` instead of any
  preferred book. Replaced with a direct DraftKings filter (confirmed
  full coverage across all 5 launch markets before shipping) — same
  single-bookmaker, no-cross-book-fallback convention `OddsBadge.jsx`
  already used for game odds.
- **Final-grading NULL/COALESCE bug — found and fixed, 2026-09-18**
  (commit `c6affb2`). Reported as "the TOSS-UP badges never finalize."
  `final_value` treated a box-score row's NULL stat column the same as
  "we don't know," when it actually meant the player recorded a genuine
  zero. CONFIRMED against Highlightly's real box score for two
  independent players (TE Brock Wright, WR DJ Moore, both zero-target
  games): the vendor omits an entire stat group (Passing/Rushing/
  Receiving/General) for a player who recorded nothing in it, rather
  than reporting an explicit 0. The `player_anytime_td` branch already
  `COALESCE`d correctly for this reason — brought the other 4 markets in
  line with it. A genuinely void case (no box-score row at all) still
  renders its own neutral "Void" badge rather than ever falling back to
  the pregame `LeanBadge`.
- **Badge color-by-direction — done, 2026-09-18** (commit `4604e71`).
  Reported as "Unders showing green is confusing." Every real final
  grade previously shared one positive/green token regardless of
  direction; `GRADE_VARIANT` now colors over/scored green and under/
  no-TD red (push/void stay neutral gray) — same over-vs-under
  convention `LEAN_BADGE` already used pregame, carried through to the
  final grade.

---

## Open decisions — resolved

Both items this roadmap originally left open are now settled by what
actually shipped:

- **Which NFL stat splits are honestly supportable as "insight layer"
  categories:** four — matchup, recent form, situational (including a
  weather split), and role/volume trend. See `backend/lib/insights.js`.
- **Whether the ranking/edge/portfolio agents need to be LLM-backed:**
  no — they're pure deterministic scoring, matching MLB's Board/Model
  approach. Only the conversational/orchestrator agent has an LLM in the
  loop, exactly as this doc leaned toward.

## Still genuinely open

*(Cleaned up 2026-09-17 — this list used to also carry several items
whose own write-up already said "done"/"fixed"; those moved to
"Resolved" below so this heading only holds what's actually
unresolved. See "Backlog" further down for work that was deliberately
scoped out rather than just unverified.)*

- Watch `sync_live_stats` across more live games to confirm the
  Highlightly stat map holds up broadly (one game's box score is
  confirmed so far).
- Whether/how a partial (in-progress) game's live stats should feed
  `recent_form`/`role_trend` — the original product question behind
  live-scoring candidate 3 (see "Resolved" below) is still untouched.
  `insights.js` stays gated to `status='final'`; only the scoreboard
  (status/score/period/clock) reads live data today.
- What Highlightly's `state.report`/`state.description` actually say
  DURING a live game — only a finished game's values ("Final"/
  "Finished") are confirmed, from a real captured response.
  `sync_live_scores` logs any other value once
  (`unrecognizedLiveScoreReports`) and treats it as `in_progress` rather
  than guessing; needs checking against a real live capture the first
  time this runs during an actual game.

## Resolved (historical record)

Kept in full rather than deleted, per this doc's own "corrected record,
not silently dropped" convention — these were previously sitting under
"Still genuinely open" even though each already documents its own fix.

- **Highlightly quota-cache fix holds up across a full Sunday slate —
  done, 2026-09-14, and it didn't hold up on the first try.**
  `findHighlightlyMatch`'s module-scope cache (2026-09-13) and the
  `isDue()` `'game-window'` real-interval fix (2026-09-14 correction: the
  original incident writeup below said `sync_live_stats` polled "every
  20s" — that was never actually true; `isDue()` ignored the job's
  `pollSeconds`/`intervalMinutes` entirely, so the real cadence was
  always the scheduler's own 60s tick) both landed, but real Sunday
  2026-09-13 deploy logs (checked 2026-09-14) show `sync_live_stats`
  still hit Highlightly 429s from ~19:45 UTC onward and never recovered
  for the rest of that evening — every 15-minute cooldown expired
  straight into another 429, because the day's 100-request quota was
  simply gone by mid-afternoon. The circuit breaker worked as designed
  (no runaway hammering), it just can't manufacture quota that isn't
  there. Real fix: recognized that per-player box-score freshness during
  a LIVE game isn't consumed by anything today (insights.js stays gated
  to `status='final'`; nflverse's `sync_historical_stats` is the real
  source of truth for final stats) and cut `LIVE_STATS_INTERVAL_MINUTES`
  30 -> 120 — an actual ~4x reduction in real call volume (13 games x 2
  ticks instead of 8 in the early window), freeing the shared budget for
  `sync_live_scores` and `sync_injury_reports`, which both have real
  consumers today. See that constant's comment in
  `worker/ingestion-worker.js` for the full math.
- **Refresh cadence lags same-day results — Phase A (scoreboard) done,
  2026-09-14.** Went with candidate 3 below (true live scoring off
  Highlightly), but scoped narrowly: a new `sync_live_scores` worker job
  writes `games.status`/`home_score`/`away_score` during a game's live
  window via Highlightly's `/matches` list endpoint — confirmed batched
  (one call returns every game for a date, not one call per game, unlike
  `/box-score/{id}`) — on a ~10-minute cadence sized against the shared
  100-request/day quota. See that job's own header comment in
  `worker/ingestion-worker.js` for the real cost math (worst-case full
  Sunday: ~66 calls just for `sync_live_scores`, ~104 for
  `sync_live_stats` at its own newly-real 30-minute interval — both
  deliberately conservative rather than precise, backstopped by the
  existing 429 circuit breaker). `GameCard`/`StatusBadge` show a Live
  pill + running score the same way a final score already renders — no
  schema change needed, `games.status`/`home_score`/`away_score` already
  supported `'in_progress'`. Two things deliberately NOT done as part of
  this are exactly the two "Still genuinely open" items above (whether
  live stats should feed `insights.js`, and confirming
  `state.report`/`state.description` during an actual live game) — not
  repeated here so they don't drift out of sync again.
    - **`sync_injury_reports`' own Sunday cost — throttled, 2026-09-14.**
      It queries every `status='scheduled'` game within 4 days, and the
      outer job cadence (every 3h on Sundays) was only throttling how
      often the job *ran*, not how often it re-fetched the SAME game's
      injury detail within that run window — a Sunday's own games mostly
      stay `'scheduled'` all morning before any of them kick off, so 3-4
      back-to-back Sunday ticks were each re-fetching a full ~13-16 game
      slate's `/matches/{id}` detail from scratch, which alone could
      approach/exceed the 100/day quota, independent of anything live-
      scoring related. Fixed by adding a per-game proximity throttle
      inside `syncInjuryReports()` (`INJURY_DETAIL_PROXIMITY_BUCKETS` in
      `worker/ingestion-worker.js`, reusing the same `pickProximityBucket()`
      helper the odds/weather proximity schedules already use) — a game
      more than 2h from its own kickoff is now re-checked roughly every
      other outer tick instead of every tick (a real, measured ~50%
      reduction in this job's own Sunday call volume), while a game
      within 2h of kickoff still gets checked every tick so a real late
      inactive isn't missed. This is a measured cut to this one job's own
      contribution, not a claim that the combined `sync_live_stats` +
      `sync_live_scores` + `sync_injury_reports` total now stays under
      100/day on a maximal Sunday — it still can; the shared
      `highlightlyOnCooldown()` 429 circuit breaker all three jobs
      already check remains the real backstop for that combined total,
      same as before this fix.
  Original three candidates, for the record (2026-09-13):
    1. A manual re-trigger (endpoint or script) to force both
       `sync_historical_stats`/`matchup-scores-cron` on demand —
       cheapest, no schedule change, but relies on someone remembering to
       run it. Not pursued.
    2. Multiple scheduled runs on Sundays keyed to typical NFL window end
       times — easy to add, but a guess at real broadcast-window ends.
       Not pursued.
    3. True live scoring off `sync_live_stats`'s already-live box
       scores — chosen, see above for the actual scope it shipped with.
- **`sync_odds` numeric overflow — fixed, 2026-09-14.** CONFIRMED real
  incident: a run during Sunday 2026-09-13's live window (~20:02 UTC)
  failed with "numeric field overflow" and kept failing across all 5 of
  `runJob()`'s retries, recording zero net rows that run. Root cause:
  `game_odds.home_price`/`away_price`/`over_price`/`under_price` were
  sized `NUMERIC(7,2)` against 003_game_odds.sql's original assumption
  that these stay pre-game-sized; the-odds-api's odds endpoint doesn't
  cleanly separate pre-match from in-play once a game has kicked off,
  and an in-play moneyline on a decided game can spike well past that.
  Two fixes, a matched pair: `009_widen_game_odds_prices.sql` widens the
  four price columns to `NUMERIC(9,2)` (needs running once against the
  live Railway Postgres, same as every other migration here), and
  `syncOdds()`'s insert loop now wraps each row in its own try/catch —
  one bad/unexpected value only costs that one row instead of aborting
  every row queued after it in the batch, and instead of burning all 5
  retries on the same doomed full-batch re-attempt.
- **General QA / review pass — done, 2026-09-15.** Three parallel
  read-only reviews across backend, worker, and frontend surfaced 8
  findings; all 8 fixed same day. Worst first:
  1. **CRITICAL, worker:** `syncSchedule()` built `game_datetime` (a
     TIMESTAMPTZ column) as a naive `${gameday}T${gametime}:00` string
     with no UTC offset, even though nflverse's `gametime` is Eastern
     Time — every stored kickoff was off by 4-5 hours (DST-dependent),
     corrupting live-window detection, weather/odds proximity buckets,
     and any displayed kickoff time. Fixed with a new
     `easternToUtcIso()`/`easternOffsetForDate()` pair that resolves
     ET's real UTC offset per-date via `Intl`'s IANA tz data and builds
     an offset-bearing ISO string instead.
  2. **HIGH, worker:** that same function's upsert overwrote
     `home_score`/`away_score`/`status` unconditionally from nflverse's
     (lagging) schedule CSV, with no guard against downgrading an
     already-live/final game — unlike `sync_live_scores`'s own upsert,
     which already guards with `WHERE status <> 'final'`. Fixed with a
     `CASE WHEN games.status = 'final' THEN ... ELSE EXCLUDED. ... END`
     per column.
  3. **HIGH, worker:** `runJob()`/`scheduleRetry()` called
     `logRunStart()` *before* their own try/catch, so a transient DB
     error on that one call became an unhandled promise rejection with
     no `.catch` anywhere upstream and no process-level handler — Node
     treats that as fatal since v15. Fixed by moving `logRunStart` and
     the failure-logging call inside the try/catch, guarded so nothing
     in the path can throw uncaught.
  4. **MEDIUM, worker:** `findHighlightlyMatch`'s cache-poisoning guard
     required only ONE of its 3 date-candidate lookups to succeed before
     caching a permanent "no match" — so a transient failure on the real
     kickoff-date candidate plus a genuine zero-result success on an
     adjacent day cached "no match" forever without the real date ever
     being checked. Fixed to require all 3 to succeed (matches what the
     function's own doc comment already specified).
  5. **LOW, backend:** `computeAndStoreMatchupScores()`'s per-player
     batch loop had no error isolation — same failure class as the
     `sync_odds` bug above — so one player's transient error aborted
     every remaining player for the day. Fixed with a per-player
     try/catch and an `errored` counter.
  6. **LOW, backend:** `rankings.js` and `matchup-scores.js` didn't
     validate a negative `limit` query param, so `limit=-5` reached
     Postgres as a negative `LIMIT` and 500'd instead of a clean 400.
     Fixed with the same regex-based validation already used for
     `week`.
  7. **MODERATE, frontend:** `LoginPage.jsx` and `NotFoundPage.jsx`
     still defaulted/linked to `/teams`, which stopped being the app's
     index route when `/board` took over earlier this session. Fixed.
  8. **MINOR, frontend:** several filter/search inputs across
     `GamesPage`, `EdgePage`, `RankingsPage`, `PortfolioPage`,
     `PlayerBrowsePage`, and `ChatPage` were placeholder-only with no
     accessible name. Fixed with `aria-label` on each.
- **Natural-language / StatMuse-style search bar — done, 2026-09-17.**
  Extended the existing Chat agent (`backend/lib/orchestrator.js`) rather
  than building a separate search UI or a parallel LLM system, per
  explicit design-fork calls: a new `get_player_stats` tool for raw
  season/last5/career/game_log lookups (backed by `POST /query`'s engine,
  relocated into `lib/stats-query.js` so it can be called in-process), plus
  a deterministic pre-LLM shortcut for obvious canonical questions so
  they don't cost a Claude API call, falling through to the normal
  tool-calling loop for anything less clear-cut. Verified live end-to-end
  against real questions (season/career/last-5 lookups, plus an
  ambiguous question correctly falling through to the LLM) before
  calling it done.
- **Top performers + live box score — done, 2026-09-17.** See the Phase 5
  section above for the full writeup; noted here too since it was this
  session's second backlog item shipped the same day as the search bar.
- **Box score rework (team toggle + category split) and Season Total —
  done, 2026-09-17.** Same-day follow-up requested with real Yahoo
  Sports app screenshots as reference. See the Phase 5 section above for
  the full writeup.

## Backlog

Work that was explicitly scoped out of the plan rather than just
not-yet-verified — gathered here (2026-09-17, updated 2026-09-18 at
Player Props phase close-out) so it's reviewable as one list instead of
scattered across Part 1/Part 2 history. The stray line that used to sit
here ("Phase 3 — scope and timing not yet decided") was deleted outright
rather than moved: Phase 3 is marked "Status: done" above, so that line
was simply stale, not a real open item.

Re-ordered 2026-09-18, twice: first to put the Swift iOS app at the top
per explicit direction, then moved back to the bottom per a follow-up
call ("move the swift app to the bottom, then let's work down the
list") — the smaller, already-scoped backend/data items go first;
drafting the iOS app is the last thing in this list, not the first.

1. **`resolvePlayerForProp()` has no suffix-normalization fallback —
   found 2026-09-18, fixed 2026-09-18.** CONFIRMED via real
   `sync_player_props` production logs (2026-09-18): real players with a
   generational suffix mismatch between The Odds API's naming and our
   roster are being silently dropped from Player Props — same bug class
   as the James Cook box-score fix above (`ceb7f42`), but that fix only
   landed in `resolvePlayerForBoxScore()`; its sibling
   `resolvePlayerForProp()` (same file, used by `sync_player_props`)
   still did a plain exact-match comparison with no
   `stripGenerationalSuffix()` fallback. Fixed by porting the same
   `stripGenerationalSuffix()` retry-on-zero-match fallback, adapted for
   this function's two-team (home/away) match clause.
   **Verified against real data, not just the log sample:** of the names
   a "no player match" log sample flagged, 5 were genuine suffix
   mismatches this fix resolves (confirmed directly against the
   `players` table — exact match fails, the new fallback finds exactly
   one row): Brian Thomas Jr → "Brian Thomas Jr.", Kevin Coleman Jr. →
   "Kevin Coleman", Mike Washington Jr. → "Mike Washington", Montorie
   Foster Jr. → "Montorie Foster Jr", Thomas Fidone → "Thomas Fidone II".
   **Not fixed by this, and not a suffix issue — worth their own look
   later:** DJ Herman / CJ Williams / CJ Daniels are a different bug —
   our data stores these with periods ("D.J. Herman", "C.J. Williams",
   "C.J. Daniels"), a punctuation mismatch, not a suffix one; Drew
   Ogletree is a nickname mismatch ("Andrew Ogletree" in our data); James
   Jordan and Bam Knight aren't in the `players` table under any spelling
   checked, so more likely unrostered than a name-matching bug.
   **Not a bug, for contrast:** most of that same log's "no player
   match" lines are expected, not a defect — The Odds API's
   `player_anytime_td` market includes team-defense outcomes ("Kansas
   City Chiefs D/ST") and a synthetic "No Scorer" outcome alongside real
   players, none of which have (or should have) a `players` row;
   `resolvePlayerForProp()` correctly skips them rather than guessing.
2. **Drive events (play-by-play) for live games.** Split out from the
   original "fuller live gamecast view" item once the box score/top-
   performers half of it shipped (2026-09-17) — see Phase 5 above for
   why this half is explicitly NOT scoped yet: no confirmed data source
   exists. Needs real vendor research (either confirming Highlightly's
   `/matches/{id}` response has something nobody's checked for, or
   sourcing a different vendor entirely) before this can even be sized,
   let alone built.
3. **Game props: team totals — shipped 2026-09-18.** The deliberate
   follow-up noted in Player Props' own original commit message
   (`9dd9ef5`, 2026-09-17). Extends `game_odds` with a `team_totals`
   market (`db/migrations/013_team_totals_odds.sql`) rather than a new
   table — the vendor's per-team Over/Under already matches the row
   shape `game_odds` uses for the existing `totals` market (an O/U pair
   + a point), it just needed one new column (`team_side`) to say which
   team. New `sync_team_totals` worker job (same per-event endpoint and
   current-week-only scoping as `sync_player_props`, confirmed live
   2026-09-18 at 1 credit/event for this market). `routes/odds.js`'s two
   "latest odds" queries extended to dedup on `team_side` too, so a
   bookmaker's home *and* away team-total rows both survive. Surfaced on
   `GameDetailPage`'s existing odds board only (a new "Team Total"
   section) — the compact card badges (`OddsBadge`/`GameCard`) stay
   DraftKings-spread/total-only, unchanged, on purpose (deliberately
   terse, already busy).
4. **Game props: alternate spreads/totals — split out, not started.**
   Deliberately NOT built alongside team totals above: confirmed live
   2026-09-18 that The Odds API's `alternate_spreads`/`alternate_totals`
   markets return MANY lines per bookmaker (every available point value)
   rather than one current line, so they don't fit `game_odds`'s "one
   row = one bookmaker's current line" shape the way team totals did —
   needs its own storage shape (one row per line, not per bookmaker) and
   probably its own UI (a line picker, not just another list entry).
   Real scoping work, not a quick extension of #3.
5. **Additional player-prop markets beyond the 5 launch markets —
   decided against, closed 2026-09-18.** The Odds API offers more player
   markets than `PLAYER_PROP_MARKETS` currently pulls (e.g. pass
   attempts/completions/interceptions, longest reception, sacks), and
   this item asked whether to add them now that Player Props has run
   through a real live game. Explicit call: the 5 launch markets are
   enough — not pursuing this. `PLAYER_PROP_MARKETS` stays as-is;
   revisit only if a real need for a specific market comes up later.
6. **`sync_player_props`/`sync_odds` credit-usage check — done
   2026-09-18.** Checked live before building #3 above (its own header
   comment flagged this as "a starting point, not settled — revisit once
   real credit usage is visible," and this app's own backlog said to do
   it before scaling up markets or adding Game props): a free
   `/v4/sports` call's `X-Requests-Remaining` header showed 19,109 of
   this billing cycle's requests still available (891 used) — real,
   plenty of headroom for `sync_team_totals`'s narrow per-event addition
   on top of what `sync_odds`/`sync_player_props` already spend. Revisit
   again once alt lines (#4) or more player markets (#5) actually ship,
   since either adds real per-event cost on top of this.
7. **Delete 5 leftover Railway services.** Not urgent — dashboard
   cleanup only, none of these affect the live app. Diagnostic/temp
   services created during debugging sessions that `delete-service`
   couldn't remove (the tool call times out at 180s, a known systemic
   issue in this environment, not one-off — **re-confirmed 2026-09-18**,
   same timeout on the same tool call, service still present
   afterward): `claude-debug-stats-check`, `claude-debug-user-count-check`,
   `claude-debug-nl-search-check`, `claude-debug-season-total-check`
   (this last one was reused, not recreated, for this phase's own
   production diagnostics — see Phase 6 above — so it's still the same
   one service, not a new addition to this list). Plus one created by
   mistake during the 2026-09-17 season_total/box-score verification
   pass — `ai-application-nfl`, a stray full-repo clone triggered by
   calling the wrong Railway tool while the MCP connection was
   reconnecting. Delete all 5 manually from the Railway dashboard
   whenever convenient.
8. **Swift iOS app.** Also Part 1 MVP backlog — "web ships first, same
   API, no rework needed later." The API surface (`/query`,
   `/props/players`, `/odds`, `/edge`, `/rankings`, `/portfolio`,
   `/picks`, chat) is the same one a native client would call; no
   backend rework anticipated before drafting the iOS plan. Moved to the
   bottom of this list 2026-09-18 — the smaller backend/data items above
   go first, this comes once they're worked through.

**Scrapped, not backlogged (2026-09-17): self-serve signup + email
verification.** Checked instead of assumed before dropping it: the
`users` table has 8 rows today, but 7 are seed/test accounts with no
email (created 2026-08-25 through 08-30, all script-created — usernames
like `fastballzoro`/`dryrun_agent` are clearly not organic signups) and
the 8th is the one real account (`jayprox12`, created 2026-09-15). None
came through a self-serve flow, because none exists — accounts are still
only ever created directly via `scripts/create-test-user.js`. Multiple
accounts existing isn't evidence a signup flow is needed; it's evidence
the script-based path already covers however many accounts this app
actually needs. Dropped outright rather than deferred again.
