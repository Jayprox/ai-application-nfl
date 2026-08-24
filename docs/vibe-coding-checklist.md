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

- [ ] **Screen inventory** — List every unique view/page
- [ ] **Key user flows** — Walk through the 1–2 flows that matter most
- [ ] **Component sketch** — Rough layout for the main screen (ASCII or Figma link)

```
SCREENS:
  1.
  2.
  3.

MAIN FLOW:
  User lands on ___ → does ___ → sees ___


MAIN SCREEN LAYOUT:
  +---------------------------+
  |                           |
  +---------------------------+
```

---

## Phase 5 — Build Order
*Always: data → server → UI. Never build UI against mocks if you can help it.*

- [ ] Schema / DB setup
- [ ] Seed data (enough to test with)
- [ ] Core API routes (CRUD + business logic)
- [ ] Frontend scaffold (routing, layout shell)
- [ ] Feature 1 wired end-to-end (real data)
- [ ] Feature 2 wired end-to-end
- [ ] Feature N...

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
