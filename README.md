# Chalk That NFL

A stats-and-betting research app for NFL teams and players — built as the
first app in a personal "Chalk That" platform (a sibling to an existing
Chalk That MLB app). Part 1 is a research layer with no predictive
calculations — real historical and current-season data from
[nflverse](https://github.com/nflverse), Highlightly, and The Odds API,
exposed through one shared query API (`POST /query`) that the web UI and a
Part 2 agent team both call the same way: give it an entity, a scope, and
some splits, get back real numbers — home/away splits, weather-condition
splits, time-slot splits, season averages, last-5, career, or a full game
log. Part 2, layered on top and fully live, is a small deterministic agent
team (Rankings, Edge, Portfolio, a calibration/tracking loop, and a
Claude-backed conversational agent) plus a Player Props board with
real-time bookmaker lines, a deterministic recent-form lean, and final-game
grading once each game ends. See `docs/architecture.md` for the platform
design writeup and `docs/part2-roadmap.md` for the full Part 2 build
history and current backlog.

**Live app:** https://web-production-5f05d.up.railway.app
**API:** https://backend-api-production-15ce.up.railway.app

---

## Screenshots

| Teams | Team roster |
|---|---|
| ![Teams browse screen](screenshots/teams.jpg) | ![Kansas City Chiefs roster](screenshots/team-detail.jpg) |

| Player — season averages | Player — game log |
|---|---|
| ![Patrick Mahomes season averages](screenshots/player-season-avg.jpg) | ![Patrick Mahomes game log](screenshots/player-game-log.jpg) |

---

## Tech stack

| Piece | Choice | Why |
|---|---|---|
| Backend | Node + Express | Small, unopinionated, matches the sibling MLB app's stack — one less thing to context-switch between. |
| Database | Postgres (Railway-managed) | Real relational integrity for `players` ↔ `games` ↔ `*_game_stats` joins, and a proven fit for structured sports stats. |
| Cache | Redis (Railway-managed) | Cheap repeat-query caching for the query engine — cheaper than the alternative of pre-computing/storing derived stats, which the design deliberately avoids (see "no predictive calculations" in `docs/architecture.md` §2). |
| Frontend | React (JS, not TS) + Vite + Tailwind v4 + React Router v7 | Matches the plain-JS backend rather than mixing languages; Vite + Tailwind v4's `@tailwindcss/vite` plugin needs no separate PostCSS config. |
| Auth | JWT access token + rotating refresh token (humans), long-lived API key (agents/services) | Two credential types sharing one `authenticate` middleware — see `docs/architecture.md` §2/§4.5. Refresh-token replay triggers a full session revoke, not just a rejected request. |
| Ingestion | A separate Node worker (`worker/`), its own Railway service, no public domain | Keeps the trusted internal writer (direct DB access) fully separate from the public, auth-gated API — see `docs/architecture.md` §4. |
| Data source | [nflverse](https://github.com/nflverse) (free, open, CC-BY-4.0) for historical/roster/schedule data, plus **Highlightly** (live stats, injuries) and **The Odds API** (game + player-prop odds) for current-season data — see `docs/part2-roadmap.md` Phase 1 for the vendor decisions and `docs/architecture.md` §3. | All three vendors are live, not deferred — see Known limitations below for what's still genuinely open. |
| Deploy | Railway (3 services + managed Postgres/Redis, one project) | One project holds `backend-api`, `web`, and `ingestion-worker`, all sharing the same Postgres/Redis instances. |

---

## How to run locally

You'll need Node 18+, a Postgres database (a local one, or the Railway
Postgres instance's public/proxy connection string), and Redis is optional
for local dev (only the deployed query-caching path needs it).

```bash
git clone <this repo>
cd ai-application-nfl

# 1. Backend + worker (shared root package.json)
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, etc.
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/migrations/002_username_auth.sql

# 2. Seed data — teams, stadiums, current-season roster
npm run seed

# 3. (Optional but recommended) Backfill 5 seasons of real historical
#    games + box-score stats, so /query returns real numbers instead of
#    empty results — this is what makes the Player pages interesting
npm run backfill-historical -- 2021 2025

# 4. Create a login user for the frontend
npm run create-test-user -- <username> <password>

# 5. Start the API
npm start                   # backend-api on :3000 (see PORT in .env)

# 6. Frontend, in a second terminal
cd frontend
npm install
cp .env.example .env        # VITE_API_URL defaults to localhost:3000
npm run dev                 # Vite dev server on :5173
```

The ingestion worker (`npm run worker -- <jobType>` for a one-shot dry run,
or `npm run worker` for the real scheduler) is optional for local dev — the
historical backfill script covers everything needed to explore the app.
All eleven job types are real and live: `sync_roster`, `sync_schedule`,
`sync_historical_stats`, `sync_historical_weather` (nflverse),
`sync_forecast_weather` (Open-Meteo), `sync_injury_reports`,
`sync_live_stats`, `sync_live_scores` (Highlightly), `sync_odds`,
`sync_player_props`, `sync_team_totals` (both The Odds API) — see Known
limitations for what's still genuinely open.

---

## Known limitations / future work

*Updated 2026-09-18 at Player Props phase close-out — see
`docs/part2-roadmap.md`'s own Backlog section for the full, actively
maintained list; this is a shorter pointer version for anyone starting
from the README.*

- **Game props: alternate spreads/totals not built yet** — team totals
  shipped 2026-09-18 (`sync_team_totals`, `game_odds`'s new
  `team_totals` market), but alt lines are a separate, harder problem:
  The Odds API returns many lines per bookmaker for those, not one
  current line, so they need their own storage shape and probably their
  own UI. See `docs/part2-roadmap.md`'s Backlog.
- **Drive events (play-by-play) for live games** have no confirmed data
  source yet — nflverse is batch/historical only, and no live vendor's
  play-by-play field has actually been checked for. Needs real vendor
  research before it can even be sized.
- **No iOS app yet.** Last in the ordered backlog (`docs/part2-roadmap.md`)
  on purpose — the same `backend-api` surface a browser client calls
  (`/query`, `/props/players`, `/odds`, `/edge`, `/rankings`,
  `/portfolio`, `/picks`, the chat agent's routes) is what a native
  client would call too, so no backend rework is anticipated once this
  comes up.
- **No automated test suite.** Everything was verified through manual
  dry-runs and live browser stress-testing (see Phase 6 in
  `docs/vibe-coding-checklist.md` for Part 1, `docs/part2-roadmap.md` for
  every Part 2 feature's own real-data verification) rather than unit/
  integration tests — fine for a personal project at this stage, a real
  gap if this ever needs other contributors.
- **No rate limiting on `/login` or `/refresh`.** Reviewed during the
  hardening pass and deliberately deferred — worth adding before any
  real/public exposure.
- **Refresh tokens live in `localStorage`**, not an httpOnly cookie —
  reviewed and deliberately left alone for now; would reduce XSS exposure
  but is a larger client-side rework than this pass's scope.
- **No signup flow.** Accounts are created directly via
  `scripts/create-test-user.js` — checked and deliberately scrapped as a
  backlog item (not just deferred) once the real `users` table showed no
  evidence a self-serve flow is actually needed yet; see
  `docs/part2-roadmap.md`'s Backlog for the full reasoning.
- **5 leftover diagnostic Railway services** need manual deletion from
  the dashboard — the `delete-service` tool call has repeatedly timed
  out in this environment (most recently re-confirmed 2026-09-18); not
  urgent, doesn't affect the live app.

For the full build history, every real bug hit along the way, and the
day-by-day decisions behind all of the above, see `docs/architecture.md`
(platform design), `docs/part2-roadmap.md` (Part 2 build history + live
backlog), and `docs/vibe-coding-checklist.md` (Part 1 phase-by-phase build
log).
