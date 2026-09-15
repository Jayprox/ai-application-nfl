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

**In progress.** The Slate/Board/Game shape this phase was aiming for
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
  season/week — Games/Rankings/Edge/Portfolio still all require manual
  entry, unchanged by this.

Genuinely still open: Games/Rankings/Edge/Portfolio's own season/week
inputs could now default off `GET /games/current-week` the same way Board
does, instead of requiring manual entry or defaulting to a hardcoded
"week 1" — not done here, scoped narrowly to the Board page itself.

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

- Watch `sync_live_stats` across more live games to confirm the
  Highlightly stat map holds up broadly (one game's box score is
  confirmed so far).
- **Confirm the Highlightly quota-cache fix holds up across a full
  Sunday slate — done, 2026-09-14, and it didn't hold up on the first
  try.** `findHighlightlyMatch`'s module-scope cache (2026-09-13) and the
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
  supported `'in_progress'`. Deliberately NOT done as part of this:
    - The product question from candidate 3's original framing below —
      whether/how a partial game's stats should feed `recent_form`/
      `role_trend` — is untouched. `insights.js` stays gated to
      `status='final'`; only the scoreboard reads live data now.
    - What Highlightly's `state.report`/`state.description` actually say
      DURING a live game (only a finished game's values — "Final"/
      "Finished" — are confirmed, from the same real captured response
      that confirmed `state.score.current`). Any other value is logged
      once (`unrecognizedLiveScoreReports` in `sync_live_scores`) and
      treated as `in_progress` rather than guessed — needs checking
      against a real live capture the first time this runs during an
      actual game.
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
- Phase 3 (frontend redesign) — scope and timing not yet decided.
