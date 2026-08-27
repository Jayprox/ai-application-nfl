# Chalk That — Platform Starter

This is the drop-in doc for starting a **new** Chalk That sport-app (NBA,
MLB, a revived WNBA, whatever's next). Paste this whole file into a fresh
chat building that app and it has everything it needs to match the pattern
established by Chalk That NFL (the pilot) — what to build the same way,
what to treat as sport-specific and re-decide from scratch, and how to get
started.

If you're working *inside* an existing Chalk That app instead, this isn't
the doc you want — read that app's own `docs/architecture.md`, which has
this same platform section plus everything specific to that sport.

---

## 1. What Chalk That is

Every Chalk That app is two parts. **Part 1** is a stats research app — raw
team/player data, trends, career stats, and situational splits, pulled live
from source APIs, with no predictive calculations. **Part 2** is a separate
future AI agent service that layers projections, research, and analysis on
top of Part 1's data — the long-term point being a team of AI agents that
can query real stats directly and condense hours of manual research into
picks, rather than a person doing that by hand.

Part 1 exists as its own product, not a data layer baked into Part 2,
specifically so Part 2's agents can hit it the exact same way a human hits
it through the web/iOS app — agents never depend on a third-party research
tool's rate limits or terms of service. **One query engine, multiple
clients** — human UI today, AI agents later, any future sport-app always.

Build Part 1 solidly first. Part 2 (the agent layer) is designed-for from
day one architecturally (see §3, two-tier auth) but isn't built until Part
1 for that sport is real.

---

## 2. What to copy exactly (sport-agnostic, don't re-decide)

These decisions cost real debugging time to get right the first time on
Chalk That NFL. Copy the *pattern*, not literally the NFL code — but don't
re-litigate the decision itself.

**One shared query engine, multiple clients.** A single structured query
API (entity, stat, scope, splits → structured response with sample size and
freshness metadata) — never separate endpoints per screen, and never a
second parallel API for agents later. The web UI's filters, a future
natural-language layer, and Part 2's agents are all just different callers.

**No predictive calculations in Part 1.** Splits and aggregates (season
averages, home/away records, situational filters) are simple filtered
counts/averages computed at query time, not stored derived tables and never
a forecast. A cache (Redis) is what makes repeat queries cheap, not
pre-computation.

**Independent canonical identity + crosswalk table.** Any entity sourced
from more than one vendor (players, first and foremost) gets an id minted by
your own app — never anchored to one vendor's id scheme. One
`entity_id_crosswalk`-style table (not a new table/column per source) maps
every vendor's native id to the canonical id, with a `manual_review` state
for ambiguous matches. Same pattern the real-world Chadwick Bureau Register
uses for baseball players across MLBAM/Retrosheet/Baseball-Reference/
FanGraphs. Adding or swapping a data vendor becomes a data change, never a
schema migration.

**Ingestion is a separate service, never bolted onto the main API.** A
dedicated worker owns pulling from external sources and writing to
Postgres/Redis directly — it does not go through the main backend's API or
its auth layer, since it's a trusted internal writer, not an external
reader. Same reasoning Part 2's agent service will follow later (it *does*
go through the public API, as a normal authenticated client — see below).

**Two-tier auth.** Human users get a real login session (short-lived JWT
access token + revocable, rotating refresh token). Agents/services get a
single long-lived API key with no session concept. Same middleware, same
API surface — the credential type changes who's asking, not what they can
ask for. **Refresh-token replay is a distinct, worse case than an expired
token**: if an already-rotated refresh token is ever presented again,
that's a real theft signal (the only realistic way it happens is a leaked
copy and the legitimate client both trying to use it) — revoke *every*
active session for that user, not just reject the one request.

**Situational data is tagged at ingestion, not computed at query time.**
Anything used as a query filter often enough to matter (time-slot
classification, weather condition, home/away, whatever your sport's
equivalents are) gets resolved into a plain column when data is written, so
filtering on it is a `WHERE` clause, not a runtime computation or join.

**The stale-async-state pattern in shared frontend fetch hooks.** This one
cost a real production crash on Chalk That NFL, so it's worth stating as a
rule up front instead of rediscovering it: in any shared `useFetch`-style
hook, whatever a component uses to decide "is my current data valid for
what I'm about to render" must be computed **during render, from
render-safe state** (React `useState`, not a `useRef`) — because React can
re-render a component with a *new* fetch key (a changed route param, a
changed query scope) *before* the effect that would refetch has run. If
the hook is still returning the *previous* key's data on that render, and
the new key implies a different data shape, you get an uncaught crash, not
just a stale flash. Track "which key does this data belong to" as state,
compute `isStale = currentKey !== fetchedKey` during render, and gate the
returned `data`/`loading` on it. Separately, guard against out-of-order
network responses (an older request's response landing after a newer one's)
with a "latest key" ref — but only ever *write* that ref from a
dependency-less `useEffect`, never during the render body itself (unsafe
under concurrent rendering). Full writeup with the actual bug story: Chalk
That NFL's `docs/architecture.md` §4.7.

---

## 3. Reusable tech stack

| Piece | Choice | Notes |
|---|---|---|
| Backend | Node + Express | One language across backend + ingestion worker. |
| Database | Postgres | Managed instance (Railway or equivalent) shared by the API and the ingestion worker. |
| Cache | Redis | Query-result caching, not pre-computed stats. |
| Frontend (web) | React (JS) + Vite + Tailwind CSS v4 (`@tailwindcss/vite`) + React Router v7 | Plain JS, not TypeScript, to match the backend. |
| Frontend (mobile) | Swift, native iOS | Fast-follow on the same API, once web is solid — not started yet on any Chalk That app as of this writing, but the intended pattern; it's a client of the same public API, nothing sport-specific about it architecturally. |
| Auth | JWT (humans) + API key (agents/services) | See §2. |
| Ingestion | Standalone Node worker, own deploy service, no public domain, own `package.json` (don't share code across services — see deploy topology below) | |
| Deploy | Railway: one project per app, holding `backend-api` + `web` + `ingestion-worker` (+ Swift iOS as a distributed client, not a Railway service) + managed Postgres/Redis, all on the same private network | See §4 for the exact topology and the gotchas. |

**Data source**: sport-specific — re-decide per app (see §5). Chalk That
NFL uses [nflverse](https://github.com/nflverse) for historical/roster/
schedule data.

---

## 4. Deploy topology (Railway) — the pattern, gotchas included

One Railway project per app. Each service gets its own `rootDirectory`
(e.g. `backend`, `frontend`, `worker`) so a monorepo builds cleanly without
each service needing the others' code. `backend-api` is the only
public-facing service — it owns auth and the query API, and every client
(web, iOS, future agents) talks to it and only it. The ingestion worker has
no public domain at all; outbound calls to data vendors only, plus a
private-network connection to Postgres/Redis. Postgres/Redis are Railway-
managed plugins shared by `backend-api` and the worker — Railway
auto-injects `DATABASE_URL`/`REDIS_URL` into anything linked to them.

Two gotchas worth knowing before you hit them fresh:

- **A frontend's build-time env var (e.g. `VITE_API_URL`) has to be set
  *before* that service's first deploy**, not after — Vite only bakes
  `VITE_`-prefixed vars into the bundle at build time. Generate both
  services' domains first (no deploy required), set each service's
  counterpart var from the other's now-known domain, *then* connect
  sources to trigger the actual builds.
- **Railway does not necessarily auto-deploy on git push** — confirmed
  empirically on Chalk That NFL (checked repeatedly via `list-deployments`
  showing stale builds after pushes). If a redeploy isn't showing up,
  don't assume `git push` alone triggers one — reconnecting the service's
  source (even to the same repo/branch it's already on) reliably forces a
  fresh build from the latest commit; a plain "redeploy" action typically
  just re-runs the existing build/snapshot and won't pick up new code.

---

## 5. What to re-decide per sport (don't copy blindly)

- **Data source(s)** — historical stats, current-season/live stats,
  injuries, odds. Different sports have different vendor landscapes; don't
  assume nflverse's free/open setup exists for every sport.
- **Schema specifics** — stat tables split however that sport's positions/
  roles actually split (Chalk That NFL splits offense/defense/special-teams
  because that's how football stats are shaped; a different sport will
  split differently or not at all).
- **Situational splits that matter for that sport** — NFL's are home/away,
  time-slot (Sunday early/late, primetime, Thursday, Thanksgiving), and
  weather. A sport without weather-exposed play (indoor sports) drops that
  split entirely; a sport with a different schedule rhythm needs different
  time-based splits.
- **MVP scope** — how much roster depth, which situational splits ship
  first, whether preseason/offseason/injury-replacement empty states need
  special handling for that sport's calendar.

---

## 6. How to actually start

1. Get a copy of `docs/vibe-coding-checklist.md` from an existing Chalk
   That app — it's already written as a reusable template ("Template
   v1.0 — adapt as needed per project" is literally its last line) and is
   the actual phase-by-phase process to follow (vision → screens → schema
   → build order → hardening → packaging).
2. Read §2-4 above before writing any code — these are the decisions not
   worth re-litigating.
3. Fill in §5's sport-specific decisions for the new sport as Phase 1-2 of
   the checklist.
4. Set up the Railway project per §4's topology from the start, not as an
   afterthought — it's much easier to get the monorepo/service-splitting
   right on day one than to retrofit it later.
5. Keep a `docs/architecture.md` for the new app, same as this one: a
   platform-patterns section (can literally point back to this file) plus
   that sport's own decisions — update it after every real design decision
   or deviation from plan, not just at the end.
