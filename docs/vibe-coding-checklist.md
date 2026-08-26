# Vibe Coding — Project Checklist Template

> Copy this file into every new project repo. Fill it out top to bottom before writing code.
> Goal: quality portfolio apps, not just working demos.

---

## Phase 1 — Concept Clarity
*Time box: 15 minutes. Write, don't code.*

- [x] **One-paragraph pitch** — What does it do, who is it for, what problem does it solve?
- [x] **Why this stack?** — Be able to answer this in an interview. Write it down.
- [x] **What does "done" look like?** — Describe the app running successfully in 2–3 sentences.

```
PITCH:
Chalk That NFL is a stats research app — no predictive calculations — giving
full-roster access (offense, defense, special teams, kicking) to season
averages, last-5-game trends, career stats, and injury status, filterable
by situational splits (home/away, time slot, weather) for both teams and
players. It's Part 1 of a two-part platform: Part 2 (future, separate
service) layers AI-driven projections and confidence scores on top. Built
as a StatMuse-style research/query layer specifically so future AI agents
can query it directly for prediction research, without depending on a
third-party tool's rate limits or ToS.

STACK RATIONALE:
Swift (iOS, fast-follow) + React (web, ships first) both hit the same
Node.js/Express backend for guaranteed data parity. JWT auth. Redis-backed
cache with short, data-type-specific TTLs (freshness matters — live stats
move fast, career stats don't). PostgreSQL for storage. Railway for
hosting. The future AI agent service stays separate from the main
backend, talking to the same shared Postgres/Redis, and authenticates to
the API via its own API key — never bolted onto the human-facing backend.

DONE LOOKS LIKE:
A user can browse any current-season NFL team or player and see accurate
season averages, last-5-game trends, career stats, and injury status —
filterable by every situational split — sourced live and matching
official numbers. Deployed as a working React web app on Railway with
JWT auth wired, with graceful (not just non-broken) handling of
offseason/preseason/bye-week/rookie empty states. No sportsbook props and
no iOS app required to call it done.
```

---

## Phase 2 — System Design
*Architecture first. This is what separates portfolio apps from demos.*

- [x] **Data model** — List your entities and their key fields. Note relationships.
- [x] **Architecture diagram** — Even a text sketch: frontend → API → DB → external services
- [x] **API surface** — What endpoints/routes exist? (REST routes, WebSocket events, etc.)
- [x] **Auth strategy** — None / JWT / Session / OAuth? Why?
- [x] **External dependencies** — APIs, SDKs, third-party services. Note rate limits and costs.

*(Full detail, including the Postgres DDL, identity-crosswalk design rationale,
Redis TTL strategy, and Railway topology diagram, lives in `docs/architecture.md`.
This is the condensed version.)*

```
ENTITIES:
Stadiums, Teams, Players (canonical UUID id — not tied to any vendor),
Player ID Crosswalk (maps nflverse/BallDontLie/Highlightly/etc ids to the
canonical player), Games (precomputed game_slot + weather_condition),
Team Game Stats, Player Offense/Defense/Special-Teams Game Stats (split
by position group), Injury Reports (append-only time series), Ingestion
Runs (freshness/audit log), Users, Refresh Tokens, API Keys (agent
credentials).

ARCHITECTURE:
  [React Web / Swift iOS (fast-follow) / AI Agents (future)]
        → [backend-api: Node/Express — JWT + API-key auth, query API]
        → [Postgres + Redis]

  [ingestion-worker: Node, own Railway service, no public domain]
        → [Postgres + Redis]  (writes directly, bypasses backend-api/auth)
        → [External APIs: nflverse, Open-Meteo, live-stats vendor (TBD)]


KEY ROUTES:
Auth: POST /login, POST /refresh, POST /logout
Query: POST /query (structured: entity, stat, scope, splits → response w/
  sample size + freshness metadata) — same endpoint for humans and agents
POST /query/nl (fast-follow, not v1 — NL question → same structured query
  internally, no separate data path)


AUTH:
JWT (short-lived access token + revocable refresh token) for human users.
Separate long-lived API keys (no session, no expiry) for AI agents/
services — same query API, different credential type, distinguished by
the auth middleware. Chosen because agents need permanent machine
credentials, not a login session, and keeping that separate keeps the
API surface identical regardless of who's calling it.


EXTERNAL DEPS + LIMITS:
nflverse — free, open (CC-BY-4.0), historical stats/injuries/weather,
  batch-updated (not real-time).
Open-Meteo — forecast weather; free tier while building (10k calls/day,
  non-commercial only); $29/mo Standard tier required once live/commercial.
Live-stats vendor — parked between BallDontLie (free: 5 req/min; paid:
  $9.99–$39.99/mo) and Highlightly (free: 100 req/day; paid:
  $7.99–$44.99/mo).
Sportsbook odds (deferred/backlog) — The Odds API Business tier ($99/mo)
  is the leading candidate for NFL player props when that phase starts.
```

---

## Phase 3 — MVP Scope
*Cut ruthlessly. Everything not in v1 goes in the backlog.*

- [x] **v1 features (must have):**
  - Full-roster team & player browsing (offense, defense, special teams, kicking)
  - Season averages, last-5-game trends, and career stats per player
  - Situational splits: home/away, Sunday early/late/primetime, MNF, TNF,
    Thanksgiving, weather (sunny/overcast/rain/snow/dome)
  - Current injury status attached to player records
  - Graceful handling of offseason/preseason/bye-week/rookie empty states
  - JWT auth wired (a single test account is acceptable for v1)
  - Deployed on Railway, reachable via a live URL
- [x] **Backlog (explicitly out of scope for now):**
  - Sportsbook props/odds (FanDuel, DraftKings, BetMGM, Caesars)
  - Swift iOS app (web ships first; same API, no rework needed later)
  - Natural-language search bar (StatMuse-style query)
  - Part 2: the AI agent/projections service entirely
  - Email verification for self-serve signup — auth is username/password
    for v1, accounts created directly via `scripts/create-test-user.js`;
    email is stored (optional) but unverified and unused for login
  - *(Not backlog, but still open: which live-stats vendor powers
    current-season data — BallDontLie vs. Highlightly, undecided)*
- [x] **Success metric** — How will you know v1 is shippable?
  A user can look up any current-season NFL team or player and see
  accurate season averages, last-5-game trends, career stats, and injury
  status — correctly filtered by any situational split — sourced live and
  matching official numbers, on a deployed app reachable at a real
  Railway URL.

---

## Phase 4 — UI/UX Plan
*Wireframe before you write a component.*

- [x] **Screen inventory** — List every unique view/page
- [x] **Key user flows** — Walk through the 1–2 flows that matter most
- [x] **Component sketch** — Rough layout for the main screen (ASCII or Figma link)

```
SCREENS:
  1. Login (single test account for MVP, but a real screen/flow)
  2. Team browse — list of all 32 teams
  3. Team detail — roster + team-level records (home/away, situational splits)
  4. Player search/browse — find a player by name/team/position
  5. Player detail — season averages, last-5-game trends, career stats,
     injury status, situational-split filters applied here
  (Not a separate screen, but a state every relevant screen must handle
   gracefully per MVP scope: offseason/preseason/bye-week/rookie-with-no-history)

MAIN FLOW:
  User lands on a player (via search, or drilling in from their team page)
  → views their base stats → applies one or more situational-split
  filters (home/away, weather, time slot) → sees the filtered numbers
  with sample size shown alongside. This loop — stats plus a split, with
  context on how much data backs it — is the actual differentiator, so
  the main screen is designed around it.

MAIN SCREEN LAYOUT (Player Detail):
  +-------------------------------------------------------------+
  | < Back to Team              [Injury: Questionable - Ankle]  |
  |                                                               |
  |  Patrick Mahomes                 QB  |  Kansas City Chiefs   |
  +-------------------------------------------------------------+
  | [Season Avg] [Last 5 Games] [Career] [Game Log]              |  <- scope tabs
  +-------------------------------------------------------------+
  | Splits:  [Home/Away v]  [Time Slot v]  [Weather v]  [Clear]  |  <- split filters
  +-------------------------------------------------------------+
  |                                                               |
  |  Passing Yards        287.4        (8 games)                 |
  |  Passing TDs            2.1        (8 games)                 |
  |  Completions            24.3       (8 games)                 |
  |  Interceptions           0.6       (8 games)                 |
  |                                                               |
  +-------------------------------------------------------------+
  | Data synced 4m ago                                           |  <- freshness metadata
  +-------------------------------------------------------------+

  Note: this layout is a direct visual of the System Design decisions —
  scope tabs map to the query API's `scope` field, split dropdowns map to
  its `splits` object, the "(8 games)" is the sample-size metadata, and
  "synced 4m ago" comes from ingestion_runs via the freshness metadata.
  Nothing here needs new backend work — it surfaces what's already designed.
```

---

## Phase 5 — Build Order
*Always: data → server → UI. Never build UI against mocks if you can help it.*

*(Order planned below — execution not started yet. Check items off as each
is actually built, not as it's planned.)*

- [x] Schema / DB setup — provision Postgres + Redis on Railway, run `db/schema.sql`
      *(Done: Railway project "chalk-that-nfl" created, Postgres + Redis
      provisioned, backend-api/ingestion-worker services created with
      DATABASE_URL/REDIS_URL wired, schema applied — all 14 tables confirmed live.)*
- [x] Seed data (scoped, pass 1) — `scripts/seed.js` seeds real nflverse
      data: 30 stadiums, 32 teams, 2,752 current-season players + their
      `player_id_crosswalk` rows. Ran clean against the live Railway
      Postgres. Deliberately scoped down — historical games/box-score
      stats are NOT loaded yet; that's a separate follow-up pass once
      this is verified, not blocking Core API routes from starting.
- [x] Core API routes — real Postgres-backed `/login`/`/refresh`/`/logout`
      (username/password), `POST /query` (the shared query engine — season/
      last5/career/game_log scope, home/away + weather + time-slot splits),
      plus `GET /teams`, `GET /players`, and `/health`. Verified end-to-end
      against the live Railway deploy: login issues real tokens, `/teams`
      and `/players` return real seeded data, `/query` correctly returns a
      graceful `sample_size: 0` empty state (expected — historical game
      stats aren't loaded yet).
- [x] Historical data backfill — `scripts/backfill-historical.js` loads 5
      completed seasons (2021-2025) of real games + player box-score stats
      (offense/defense/special-teams) from nflverse, plus the 2026
      schedule, and derives `team_game_stats` from the loaded player rows.
      *(Done: first run surfaced a real bug — nflverse's `games.csv` uses
      `'LA'` for the Rams while our `teams` table uses `'LAR'`, which
      caused 112 Rams games to be skipped, which cascaded into a
      foreign-key violation that rolled back every season's player-stats
      load entirely (all 5 seasons, zero rows). Root-caused via direct
      diff of `games.csv` against our real team abbreviations, fixed with
      an alias-normalization step (`LA` → `LAR`) applied everywhere an
      nflverse abbreviation is looked up (also documented in
      `docs/architecture.md` §3 since `ingestion-worker` will need the
      same fix later). A `scripts/cleanup-before-rerun.js` one-off was
      added to clear the `team_game_stats` rows the failed run had already
      inserted with null derived stats, since a re-run's `ON CONFLICT DO
      NOTHING` wouldn't have replaced them. Re-run after both fixes:
      1,696 games inserted (0 skipped), all 5 seasons of player stats
      loaded clean (no rollbacks — ~5,600-5,700 offense / ~9,700-10,100
      defense / ~1,300-1,700 special-teams rows per season), 3,392
      team_game_stats rows (1,696 games × 2 teams, no gaps). Verified
      end-to-end via `POST /query` for Patrick Mahomes' 2024 season —
      real, correct numbers (242.5 pass yds/gm, 23.5/34.9 completions,
      1.63 TDs, 0.68 INTs across 19 games) instead of the earlier
      `sample_size: 0` empty state. Note: `meta.freshness.synced_at`
      correctly returns `null` for this data — the one-time backfill
      script doesn't write to `ingestion_runs`; that starts once
      "Ingestion worker automation" (below) exists.)*
- [x] Frontend scaffold — React routing + layout shell for all 5 screens.
      *(Done: `frontend/` — Vite + React (JS) + Tailwind CSS v4 +
      react-router-dom v7. Routes for all 5 screens (`/login`, `/teams`,
      `/teams/:teamId`, `/players`, `/players/:playerId`), gated by a
      `ProtectedRoute` + shared nav `Layout`. Login is wired real
      end-to-end against `POST /login` (with token storage + transparent
      refresh-on-401 via a single shared `apiFetch` wrapper — not a mock);
      the other 4 screens are routed shells pending Features 1-5. Required
      adding `cors` to the backend (`server.js`, `CORS_ORIGIN` env var) so
      the browser can call the API cross-origin — documented in
      `docs/architecture.md` §4.5/§4.6. `npm run build`, lint, and
      `npm audit` all clean (0 vulnerabilities).)*
- [x] Feature 1: Team browse + team detail wired end-to-end (real data).
      *(Done: `TeamBrowsePage` fetches `GET /teams` and groups all 32 teams
      by conference/division; `TeamDetailPage` fetches `GET /teams/:id`
      and shows stadium info plus the current roster grouped by position
      group (offense/defense/special-teams), each player linking to
      `/players/:id`. Added a shared `useApiFetch` hook (loading/error
      state + auto-redirect to `/login` on a failed session, used by every
      data-backed screen from here on) and a shared `AsyncState` component
      for loading/error UI, so Features 2-5 reuse the same pattern rather
      than each re-implementing it. `npm run build`, lint, and `npm audit`
      all clean.)*
- [x] Feature 2: Player search/browse wired end-to-end.
      *(Done: `PlayerBrowsePage` fetches `GET /players` with live
      `?name=` (debounced 300ms), `?team=` (dropdown populated from
      `GET /teams`), and `?position_group=` filters — any combination,
      updating the result list as you type/select. Shows a "showing first
      100" notice when the backend's result cap is hit rather than
      silently truncating. Extracted `constants/positionGroups.js` and
      `constants/playerStatus.js` so the position-group labels and status
      badge styling are shared with Team detail (Feature 1) instead of
      duplicated. `npm run build`, lint, and `npm audit` all clean.)*
- [x] Feature 3: Player detail — base stats (season avg / last-5 / career
      scope tabs) wired end-to-end.
      *(Done: `PlayerDetailPage` — the app's main screen per the Phase 4
      component sketch — has real scope tabs (Season Avg / Last 5 Games /
      Career / Game Log) and a season selector, all wired to `POST
      /query`. Stat columns are position-group-aware (offense/defense/
      special-teams, via `constants/statColumns.js`, mirroring the
      backend's own `PLAYER_STAT_COLUMNS`). Game Log renders a real table
      with opponent parsed from `game_id` (no extra request needed — see
      the `SEASON_WEEK_AWAY_HOME` format from the historical backfill).
      Shows sample size + freshness (`meta.freshness.synced_at` correctly
      reads "not yet synced" — `ingestion_runs` isn't populated until
      Ingestion worker automation exists). Added a `useStatsQuery` hook
      (POST counterpart to `useApiFetch`, same loading/error/session
      handling) so future `/query`-backed screens don't reinvent this.
      Split filters (Feature 4) and the injury badge (Feature 5) are
      deliberately not here yet. `npm run build`, lint, and `npm audit`
      all clean.)*
- [ ] Feature 4: Situational split filters wired into player detail
- [ ] Feature 5: Injury status wired into player records + UI badge
- [ ] Feature 6: Empty states (offseason/preseason/bye-week/rookie) across
      all screens
- [ ] Ingestion worker automation — turn the one-time seed into the real
      scheduled worker (fixed / proximity / game-window jobs)
- [ ] Deploy — live on Railway with a real URL

**Checkpoint after each feature:** Does it still match the system design? Any drift?

---

## Phase 6 — Hardening Pass
*This is what separates a demo from a portfolio app. Don't skip it.*

- [ ] Error handling on all API calls (try/catch, user-facing error states)
- [ ] Loading states (skeleton loaders or spinners where data is async)
- [ ] Empty states (what does the UI show with no data?)
- [ ] Input validation (client-side + server-side)
- [ ] Environment variables (no API keys in code, no `.env` committed)
- [ ] Basic auth/access control review (nothing exposed that shouldn't be)
- [ ] Mobile responsiveness check (even if it's a "desktop app")
- [ ] Console errors cleared

---

## Phase 7 — Portfolio Packaging
*An unpackaged app is invisible to recruiters and collaborators.*

- [ ] **README.md**
  - What it is (1 paragraph)
  - Tech stack (with brief rationale)
  - How to run locally
  - Live demo link (if deployed)
  - Screenshots or GIF
  - Known limitations / future work
- [ ] **Deployed** — Railway, Vercel, Render, or equivalent. A live URL matters.
- [ ] **Loom or screen recording** — 2–3 min walkthrough. Optional but high value.
- [ ] **Can you explain it in 2 minutes?** — Practice the architecture explanation out loud.

---

## Architect's Gut Check (Before Calling It Done)

Answer these. If you stumble on any, go back.

1. Why did you choose this stack over alternatives?
2. What's the hardest technical problem you solved?
3. What would you do differently if you rebuilt it?
4. What breaks first under load or edge cases?
5. If a junior dev joined, could they navigate the codebase in 30 min?

---

## Project Log
*Running notes as you build. Good for README + interview stories.*

| Date | What I built | Decision made | Why |
|------|-------------|---------------|-----|
|      |             |               |     |
|      |             |               |     |
|      |             |               |     |

---

*Template v1.0 — adapt as needed per project.*
