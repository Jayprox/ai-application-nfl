# Chalk That — Platform Architecture

This document captures the System Design decisions made for **Chalk That NFL**, the first app in the Chalk That platform. It's split so future sport-apps (NBA, MLB, a revived WNBA) can reuse the parts that are genuinely platform-level, while knowing which parts are NFL-specific choices to be re-decided per sport.

---

## 1. Platform vision

Every Chalk That app is two parts. **Part 1** is a stats research app — raw team/player data, trends, career stats, and situational splits, pulled live from source APIs, with no predictive calculations. **Part 2** is a separate future AI agent service that layers projections, simulations, and confidence scores on top of Part 1's data.

The reason Part 1 exists as its own product, not just a data layer baked into Part 2: it's meant to be hit directly by Part 2's agents the same way a human hits it through the web/iOS app, so agents never depend on a third-party research tool's rate limits or terms of service. One query engine, multiple clients — human UI today, AI agents later, any future sport-app always.

---

## 2. Platform-level patterns (reusable across every sport-app)

These are the architectural decisions that should carry into NBA/MLB/WNAB versions largely unchanged, independent of which sport or which data vendors are involved.

**One shared query engine, multiple clients.** The backend exposes a single structured query API (entity, stat, scope, splits → structured response with sample size and freshness metadata). The web app's filter UI, a future natural-language search layer, and Part 2's AI agents are all just different callers of the same endpoint — never separate parallel APIs.

**No predictive calculations in Part 1.** Splits and aggregates (season averages, home/away records, situational filters) are simple filtered counts/averages computed at query time, not stored derived tables and never a forecast. Redis caching is what makes repeating those queries cheap, not pre-computation.

**Independent canonical identity + crosswalk table.** Every entity that might be sourced from more than one vendor (players, first and foremost) gets an id we mint ourselves — never anchored to any single vendor's id scheme. A single `entity_id_crosswalk`-style table (not a new table or new column per source) maps every vendor's native id to that canonical id, with a `manual_review` state for ambiguous/unresolved matches. This is the same pattern the real-world Chadwick Bureau Register uses for baseball players across MLBAM/Retrosheet/Baseball-Reference/FanGraphs — proven at scale, and it means adding or swapping a data vendor is a data change, never a schema migration.

**Ingestion is a separate service, never bolted onto the main API.** A dedicated worker owns pulling from external sources and writing to Postgres/Redis directly — it does not go through the main backend's API or its auth layer, since it's a trusted internal writer, not an external reader. This mirrors how Part 2's AI agent service is also kept separate from the main backend.

**Two-tier auth.** Human users get a real login session — short-lived JWT access token, revocable refresh token, standard web/mobile session pattern. Agents (and other trusted services) get a single long-lived API key with no session at all, checked by the same middleware but routed differently. Same API surface either way — the credential type changes who's asking, not what they can ask for.

**Situational data is tagged at ingestion, not computed at query time.** Anything used as a query filter often enough to matter (time-slot classification, weather condition, home/away) gets resolved into a plain column when data is written, so filtering on it is a `WHERE` clause, not a runtime computation or join.

---

## 3. NFL-specific decisions (this app)

The choices below are Chalk That NFL's answers to the platform patterns above — a future sport-app will make its own version of each.

**Data sources.** Historical stats, career data, injury reports, and historical weather (already embedded in play-by-play): [nflverse](https://github.com/nflverse) — free, open, CC-BY-4.0. Forecast weather for upcoming games: Open-Meteo — free while building, ~$29/mo commercial tier once live. Current-season/live stats: still undecided, parked between BallDontLie and Highlightly. Sportsbook odds/props: deferred to a post-MVP phase entirely.

**Known nflverse quirk — team abbreviation drift.** nflverse's own files don't agree with each other on the Los Angeles Rams' abbreviation: `games.csv` (and the player-stats/roster release files) use `'LA'`, while every other nflverse source and our own `teams` table use `'LAR'`. Confirmed by diffing `games.csv` against our 32 real abbreviations for the 2021-2026 range — `'LA'` was the only mismatch found. Any code that joins nflverse data against `teams` by abbreviation (the one-time historical backfill today, `ingestion-worker` once it exists) needs a small alias/normalization step (`{ LA: 'LAR' }`) before doing that lookup, or Rams rows silently fail to match and — worse — get skipped upstream in a way that can cascade into foreign-key failures downstream (this exact chain is what broke the first historical backfill run; see `scripts/backfill-historical.js`).

**Schema** (`db/schema.sql`): `stadiums`, `teams`, `players` (UUID canonical id), `player_id_crosswalk`, `games` (with precomputed `game_slot` and `weather_condition`), `team_game_stats`, `player_offense_game_stats` / `player_defense_game_stats` / `player_special_teams_game_stats` (split by position group rather than one wide table), `injury_reports` (append-only time series), `ingestion_runs` (freshness/audit log), and the auth tables `users` / `refresh_tokens` / `api_keys`.

**Situational splits scoped for MVP:** home/away, Sunday early (1pm ET) / late (4pm ET) / primetime, Monday Night, Thursday Night, Thanksgiving, and weather (sunny/overcast/rain/snow/dome — dome games get their own explicit tag rather than being force-fit into a weather condition).

**MVP scope:** full roster depth (offense/defense/special teams/kicking), React web first with Swift iOS as a fast-follow on the same API, no sportsbook props at launch, graceful (not just non-broken) handling of offseason/preseason/bye-week/rookie empty states.

---

## 4. Deployment topology (Railway)

One Railway project holds every service plus the managed Postgres and Redis plugins, which `backend-api` and `ingestion-worker` both connect to as the same shared instances.

```mermaid
graph TB
    subgraph Clients
        Web["React Web App"]
        iOS["Swift iOS App<br/>(fast-follow)"]
        Agent["Part 2: AI Agent Service<br/>(future)"]
    end

    subgraph "Railway Project: chalk-that-nfl"
        API["backend-api<br/>Node / Express<br/>auth + query API<br/>(public)"]
        Worker["ingestion-worker<br/>Node<br/>scheduler + jobs<br/>(no public domain)"]
        PG[("Postgres")]
        Redis[("Redis")]
    end

    subgraph "External data sources"
        NFLverse["nflverse"]
        OpenMeteo["Open-Meteo"]
        LiveVendor["Live-stats vendor<br/>(TBD)"]
    end

    Web -- "HTTPS + JWT" --> API
    iOS -- "HTTPS + JWT" --> API
    Agent -- "HTTPS + API key" --> API

    API --> PG
    API --> Redis

    Worker --> PG
    Worker --> Redis
    Worker --> NFLverse
    Worker --> OpenMeteo
    Worker --> LiveVendor
```

**`backend-api`** — the only public-facing service. Owns auth (`backend/auth.js`) and the query API. Every client (web, iOS, agents) talks to this and only this.

**`ingestion-worker`** — no public domain at all; it only makes outbound calls (to nflverse/Open-Meteo/the live-stats vendor) and reaches Postgres/Redis over Railway's private network. It writes directly to the database rather than through `backend-api`'s HTTP layer or auth — it's a trusted internal writer, not an external reader, so routing it through auth would be pure overhead and unnecessary exposed surface.

**Postgres / Redis** — Railway-managed plugins, shared by both services. Railway auto-injects `DATABASE_URL` / `REDIS_URL` into any service linked to them, so no manual connection-string management.

**React web** — its own Railway service (built static app or a small Node server serving the build), calling `backend-api`'s public URL.

**Swift iOS** — not a Railway service at all; a client distributed through the App Store, hitting the same public `backend-api` URL once it exists.

**Part 2 (future)** — slots in architecturally identical to `ingestion-worker`: its own service, connected to the same Postgres/Redis, but it authenticates to `backend-api` as a normal API-key client rather than writing directly — same as any other agent.

### Env vars / secrets by service

| Service | Needs |
|---|---|
| `backend-api` | `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CORS_ORIGIN` (the deployed React web URL, once it has one) |
| `ingestion-worker` | `DATABASE_URL`, `REDIS_URL`, `OPEN_METEO_API_KEY`, `LIVE_STATS_VENDOR_API_KEY` (once chosen) |
| React web | `VITE_API_URL` (build-time — Vite only exposes `VITE_`-prefixed vars to client code) |

`JWT_SECRET` only ever needs to exist on `backend-api` — it's the only service verifying tokens; `ingestion-worker` never authenticates incoming requests, so it never needs it.

### Deploy (as built)

`backend-api` and the React web app (`web`) are both live on Railway, connected to the same GitHub repo with Railpack (Railway's builder) auto-detecting each as a Node project — `backend-api` builds from the repo root (`package.json`'s `start` script runs `node backend/server.js`), `web` builds from the `frontend/` subdirectory via each service's **Root Directory** setting.

`web` isn't a static-file host — Railpack runs `npm run build` (`vite build`, producing `dist/`) then `npm start`, which runs `frontend/server.js`: a small Express server (matching the rest of the stack rather than introducing a second server pattern) that serves `dist/` and falls back to `index.html` for any unmatched path, so a hard refresh or shared link on a client-routed page (e.g. `/players/<uuid>`) resolves correctly instead of 404ing.

Because `VITE_API_URL` is baked into the JS bundle at *build* time (Vite only exposes `VITE_`-prefixed vars, and only at build), it has to be set on the `web` service **before** its first deploy, not after — same for `CORS_ORIGIN` on `backend-api`, which needs the real `web` domain before `backend-api` will accept the browser's requests. Both Railway service domains were generated first (`generate-domain`, no deploy required), then each service's counterpart var was set from the other's known domain, and only then were both sources connected to trigger their builds. `backend-api` also has a `healthcheckPath` of `/health` — the same route already used for local debugging, now doing double duty as Railway's deploy-readiness check (confirms the container is up *and* can reach Postgres, not just that the process started).

`ingestion-worker` remains unconnected/undeployed — expected, since "Ingestion worker automation" is still open in the Phase 5 build order.

### Ingestion worker (as built)

`worker/ingestion-worker.js` turns the one-time `scripts/seed.js` / `scripts/backfill-historical.js` scripts into a real recurring worker, replacing the earlier design-stage skeleton (scheduling logic only, every job body a `TODO`) that lived at this path before this build step.

**What's real vs. still stubbed.** All four schedule shapes from the original design (`fixed`, `proximity`, `day-of-week-proximity`, `game-window`) are live, backed by real Postgres reads (`getNextUpcomingGame`, `isGameWindowActive`) rather than TODO stubs. Of the six jobs, three are fully implemented — `sync_roster`, `sync_schedule`, `sync_historical_stats` — because they're nflverse-sourced, the same source the historical backfill already uses, so no new vendor integration was needed. The other three — `sync_forecast_weather` (Open-Meteo), `sync_injury_reports` and `sync_live_stats` (live-stats vendor) — stay stubs: their *scheduling* fires for real (the proximity buckets tighten as kickoff approaches, the injury cadence tightens Mon→Sun per the Phase 2 discussion, the game-window check is a real query against `games`), but the fetch/normalize/upsert bodies remain `TODO` since they depend on the still-open vendor decision (§6, "Still open") and an unprovisioned `OPEN_METEO_API_KEY`. Wiring the scheduling now means only the vendor client + upsert need to be dropped in later, not the whole pipeline.

**Incremental, not one-time.** `scripts/backfill-historical.js` took an explicit `<startSeason> <endSeason>` range and used `ON CONFLICT DO NOTHING` — correct for a one-time historical load, wrong for an ongoing worker (a game's score would never update from `scheduled` to `final` once inserted). The worker instead always targets *the current NFL season* (`currentNflSeason()` — Sept–Feb spans one labeled season year; treats Mar–Dec as the season starting that calendar year) and upserts with `ON CONFLICT DO UPDATE`, so scores, statuses, flex-schedule datetime changes, and stat corrections all actually land on a re-run, not just first-insert.

**Identity resolution is implemented**, not just documented — `resolveIdentity(source, sourcePlayerId, candidate, cache)` in `worker/ingestion-worker.js` follows the same 5-step algorithm the original skeleton's comments described: crosswalk lookup → normalized name+team+position match → confident match crosswalked as `'matched'` → ambiguous/no match inserts a new `players` row crosswalked as `'manual_review'` rather than silently dropping the record. Used by both `sync_roster` and `sync_historical_stats`, with an in-memory `Map` cache scoped to a single job run (not persisted across runs — a restart just re-queries the crosswalk table, which is already fast and correct).

**`ingestion_runs` is live** — every job run gets a real row (`logRunStart`/`logRunSuccess`/`logRunFailure`), which is what `POST /query`'s `meta.freshness` will eventually read once the query engine is wired to it (currently that field reflects whatever's in the table already). On worker startup, `loadLastRunAtFromDb()` seeds the in-memory `lastRunAt` map from the latest successful run per `job_type`, so a Railway restart doesn't forget recent runs and immediately re-fire every job.

**Self-contained service.** `worker/` has its own `package.json` (`pg`, `dotenv`, `csv-parse` — no `express`, since it has no HTTP server or public domain) rather than requiring code from `../backend` or `../scripts`, matching how `frontend/` is also fully independent and matching Railway's per-service `rootDirectory` model (only `worker/` gets installed/built for this service). The tradeoff: the small CSV-fetch/team-abbreviation-normalization/position-group helpers are duplicated between `scripts/backfill-historical.js` and `worker/ingestion-worker.js` rather than shared — acceptable for two files, would be worth factoring out if a third consumer showed up.

**Manual dry-run mode.** `node worker/ingestion-worker.js <jobType>` (e.g. `npm run worker -- sync_roster`) runs one job once against a real `DATABASE_URL` and exits, rather than starting the unattended scheduler — the same "test it by hand against real data before trusting it to run on its own" pattern `scripts/backfill-historical.js` was run with.

**Deploy status:** code complete; Railway service `ingestion-worker` (already provisioned with `DATABASE_URL`/`REDIS_URL`, no public domain — matches the architecture above) still needs its `rootDirectory` set to `worker` and its GitHub source connected, same two-step pattern used for `web`. See the checklist for current status.

---

## 4.5 API surface (as built)

Live on `backend-api` (`backend/server.js` + `backend/routes/*.js`). Public routes need no credentials; everything else requires the `authenticate` middleware (JWT or API key — see §2/§3 auth).

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | public | Confirms the service is up **and** can reach Postgres — used for Railway deploy checks and local debugging, not just a liveness ping. |
| `POST /login` | public | `{ username, password }` → `{ accessToken, refreshToken }`. Username/password, not email — see auth note below. |
| `POST /refresh` | public | `{ refreshToken }` → new token pair (rotation — old refresh token is revoked). |
| `POST /logout` | public | `{ refreshToken }` → revokes it. |
| `GET /teams` | protected | List all 32 teams + their stadium. Not originally in the Phase 2 route sketch — added during Core API routes build since it's trivial and Feature 1 (Team browse) needs it anyway. |
| `GET /teams/:id` | protected | One team + its current roster. |
| `GET /players` | protected | Search/list via `?name=`, `?team=`, `?position_group=`. Added alongside `/teams` for the same reason. |
| `GET /players/:id` | protected | Player identity/bio + latest injury status. Deliberately excludes stats — those go through `/query`, not a duplicate code path, keeping "one query engine, multiple callers" (§2) honest. |
| `POST /query` | protected | The shared query engine — `{ entity_type, entity_id, scope, season, splits }` → `{ data, meta: { sample_size, freshness } }`. `entity_type` is `player` or `team`; `scope` is `season` \| `last5` \| `career` \| `game_log`; `splits` supports `home_away`, `game_slot`, `weather_condition`. Implemented as plain filtered aggregation over the `*_game_stats` tables — no stored/derived numbers, matching §2's "no predictive calculations." Currently returns correct `sample_size: 0` empty results until the historical-data ingestion pass loads real game stats. |

**Auth note:** human login uses `username`/`password` (not email) — matches the existing Chalk That MLB app's convention. `email` is stored on `users` but is optional and unused for login; email verification for a future self-serve signup flow is backlogged (see checklist Phase 3 backlog). There's no signup route yet either way — accounts are created directly via `scripts/create-test-user.js`.

**CORS.** `backend-api` is now called cross-origin by a real browser client, so `cors` is configured explicitly (`server.js`) against a `CORS_ORIGIN` env var — one allowed origin (or comma-separated list), never a wildcard `'*'`, since a JWT-authenticated API shouldn't accept requests from an arbitrary origin. Defaults to the local Vite dev server (`http://localhost:5173`) when unset; set to the real deployed frontend URL once React web has a Railway domain.

---

## 4.6 Frontend (as built)

`frontend/` — a separate Vite project (not a Railway service yet; see Phase 5 "Deploy"), matching the 5-screen inventory from the checklist's Phase 4 exactly.

**Stack:** React (JavaScript, not TypeScript — chosen to match the plain-JS backend rather than mixing languages across the stack) + [Vite](https://vite.dev) + Tailwind CSS v4 (via `@tailwindcss/vite`, no separate PostCSS config needed) + `react-router-dom` v7 for client-side routing.

**Routing (`src/App.jsx`):** `/login` is the only public route. Every other route sits behind a `ProtectedRoute` (redirects to `/login` if not authenticated, preserving the original destination to return to after login) wrapped in a shared `Layout` (nav shell — matches §2's "one shared query engine, multiple clients" spirit: one layout, one auth gate, all screens sit inside it). Routes: `/teams`, `/teams/:teamId`, `/players`, `/players/:playerId`.

**Auth on the client (`src/context/AuthContext.jsx`, `src/api/client.js`, `src/api/tokenStorage.js`):** access + refresh tokens are stored in `localStorage`. All API calls go through one `apiFetch()` wrapper (never raw `fetch()`) so token attachment, error shapes, and refresh are handled in exactly one place. On a `401` (access token expired — 15 min lifetime, see `backend/auth.js`), `apiFetch` transparently calls `POST /refresh` once and retries the original request; concurrent 401s from multiple in-flight requests share a single refresh call rather than racing. If the refresh itself fails, an `AuthError` is thrown and the caller drops back to `/login`.

**What's scaffolded vs. wired:** `LoginPage` is real, calling `POST /login` end-to-end (it's the auth gate, not a "feature," so it wasn't deferred). `TeamBrowsePage`/`TeamDetailPage`/`PlayerBrowsePage`/`PlayerDetailPage` are routed layout shells only — no data fetching yet. That's deliberate: wiring them to real data via `GET /teams`, `GET /players`, and `POST /query` is Features 1–5 in the Phase 5 build order, kept as separate checklist items rather than done all at once here.

---

## 5. Natural-language query layer (fast-follow, not MVP)

The StatMuse-style search bar — designed conceptually now, not yet scaffolded in code, since structured filters ship in MVP and this layers on after.

**The LLM only ever translates — it never touches actual data.** A question goes to an LLM with the structured query schema from §4/the query API as its target shape; its only job is extracting intent into that shape ("how did Mahomes do in primetime games this season" → `{ entity_type: "player", entity_name_raw: "Mahomes", splits: { game_slot: "primetime" }, scope: "season" }`). The LLM never sees or generates a stat value — the resulting structured object is handed to the exact same query API a filter click would call, so the numbers always come straight from Postgres. This keeps the same "translation, not computation" boundary that governs the rest of Part 1.

**Entity resolution reuses the crosswalk's matching logic.** The LLM extracts a raw name; resolving it to a real `player_id` is a separate, deterministic fuzzy name-lookup against `players` (last-name search, same idea as pybaseball's `playerid_lookup`). An ambiguous or unresolved match should prompt a clarifying question back to the user rather than guess — the same philosophy as the `manual_review` state in `player_id_crosswalk`, just surfaced conversationally instead of sitting in an admin queue. This fuzzy-matching logic is worth building once as a shared function, since both the ingestion worker's identity resolution and this layer's entity resolution need the same capability.

**Where it lives:** not a separate service — one more endpoint on `backend-api` (e.g. `POST /query/nl`) doing extract → resolve → call the existing structured endpoint internally, then either returns the raw structured result (for an agent) or phrases it into a sentence (for a human). That phrasing step is templated text (cheap, no extra LLM cost) vs. a second LLM call (more natural, costs more) — an open sub-decision, not urgent given this is already fast-follow.

**Cost/latency note:** every NL query costs an LLM API call that a plain filter click doesn't — a real new cost and external dependency (LLM provider uptime/latency) on top of everything else. Reinforces why structured filters belong in MVP and NL search comes after, not just a nice-to-have ordering.

## 6. Still open

Current-season/live-stats vendor (BallDontLie vs. Highlightly) — parked, not blocking anything designed so far. Sportsbook odds/props integration — deferred past MVP entirely. The NL query layer above is designed but not yet scaffolded in code. Auth details (username-based login, email verification backlog) are covered in §4.5.
