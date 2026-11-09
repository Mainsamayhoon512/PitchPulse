# PitchPulse: Cricket Backend

PitchPulse is the back end for a cricket app. It does two jobs:

1. **Live scores.** It listens to a cricket data provider's push feed (EntitySport) and writes every update to **Firebase Realtime Database** within about a second, so the app can show live scores, balls and wickets.
2. **History and reference data.** It syncs series, teams, players, squads, matches, scorecards and every ball into **PostgreSQL**, and serves them through a **REST API** (with **Swagger UI**) that is cached in **Redis**.

The app never calls the provider directly. Live data comes from Firebase; everything else comes from this REST API.

> A longer data reference (field-by-field Firebase layout, event codes, admin-versus-provider merge rules, test results and the Phase 4 plan) is in [Cricket Backend Data and API Reference.md](Cricket%20Backend%20Data%20and%20API%20Reference.md).

---

## Contents

- [How it fits together](#how-it-fits-together)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration (.env)](#configuration-env)
- [npm scripts](#npm-scripts)
- [Swagger UI and the OpenAPI file](#swagger-ui-and-the-openapi-file)
- [REST API reference](#rest-api-reference)
- [Live data in Firebase](#live-data-in-firebase)
- [Data sync (REST to Postgres)](#data-sync-rest-to-postgres)
- [The live service in detail](#the-live-service-in-detail)
- [Database model](#database-model)
- [Project structure](#project-structure)
- [Testing and replaying recorded matches](#testing-and-replaying-recorded-matches)
- [Known gaps and not built yet](#known-gaps-and-not-built-yet)

---

## How it fits together

```
                 EntitySport provider
                  |                |
        WebSocket push feed     REST API
                  |                |
          +-------v------+   +-----v-------+
          | Live service |   | Sync (CLI)  |
          | npm run live |   | npm run sync|
          +---+------+---+   +------+------+
              |      |              |
   Firebase   |      | Postgres     | Postgres
   (live/..)  |      | (balls,      | (competitions, teams,
              |      |  innings,    |  players, squads, matches)
              |      |  match row)  |
              |      +------+-------+
              |             |
        Flutter app    +-----v------+      Redis (cache, rate limits,
        (read only)    | REST API   |<---- leader lock, provider
                       | npm run api|      call counter)
                       +-----+------+
                             |
                        Flutter app, Swagger UI at /docs
```

- **Live service** ([src/scripts/live.ts](src/scripts/live.ts)): holds one WebSocket to the provider, turns each message into Firebase writes, and archives balls, innings and match status to Postgres.
- **Sync** ([src/scripts/sync.ts](src/scripts/sync.ts)): pulls competitions, squads and matches over the provider's REST API into Postgres, applying the admin-versus-provider merge rules.
- **REST API** ([src/scripts/api.ts](src/scripts/api.ts)): a Fastify server that reads Postgres, caches in Redis, and publishes Swagger docs.
- **Redis** is shared by all of them: API cache, API rate limits, the provider call budget, the live-service leader lock, and the latest snapshot per live match.

## Tech stack

| Part | Choice |
| --- | --- |
| Language | TypeScript on Node.js (ES modules, run with `tsx`) |
| API server | Fastify 5 with `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/cors`, `@fastify/rate-limit` |
| Database | PostgreSQL 16 through Prisma 6 |
| Cache and locks | Redis 7 through ioredis |
| Live store | Firebase Realtime Database (`firebase-admin`) |
| Provider push feed | WebSocket (`ws`) |
| Config validation | zod |

## Quick start

You need Node.js, Docker (for Postgres and Redis), a provider token and, for live data, a Firebase project.

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres and Redis
docker compose up -d

# 3. Create the .env file (see "Configuration" below)

# 4. Create the database tables
npm run db:push

# 5. Load data from the provider (live and upcoming series)
npm run sync -- live --limit 10

# 6. Start the REST API
npm run api            # http://localhost:3000/docs

# 7. In another terminal, start the live service
npm run live
```

Check the database at any time with `npm run sync -- status` or `npm run db:studio`.

## Configuration (.env)

Create a `.env` file in the project root. It is git-ignored; never commit it. Values are validated at start-up by [src/config.ts](src/config.ts), and a clear message is printed if something is missing.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ENTITY_TOKEN` | yes | none | Provider access token |
| `ENTITY_REST_BASE` | no | `https://restapi.entitysport.com/exchange` | Provider REST base URL |
| `ENTITY_WS_URL` | no | `ws://webhook.entitysport.com:8087/connect` | Provider push feed URL (the token is appended) |
| `PROVIDER_MAX_CALLS_PER_MINUTE` | no | `30` | Budget for provider REST calls, shared by every process through Redis |
| `DATABASE_URL` | no | `postgresql://cricket:cricket@localhost:5432/cricket` | Postgres connection (matches `docker-compose.yml`) |
| `REDIS_URL` | no | `redis://localhost:6379` | Redis connection |
| `FIREBASE_DATABASE_URL` | for live | none | Your Realtime Database URL |
| `FIREBASE_SERVICE_ACCOUNT` | for live | none | Path to the service account JSON, for example `secrets/firebase-service-account.json` (git-ignored) |
| `SYNC_PER_PAGE` | no | `50` | Page size for provider list calls (1 to 100) |
| `CAPTURE_DIR` | no | `captures` | Where the capture scripts save feed recordings |
| `PORT` | no | `3000` | API port |
| `API_HOST` | no | `0.0.0.0` | API bind address |
| `API_RATE_LIMIT_PER_MINUTE` | no | `120` | Requests per minute per client IP |
| `API_CORS_ORIGINS` | no | `*` | Comma-separated allowed origins, or `*` for any |

If the Firebase variables are not set, the live service falls back to a **console sink** that prints instead of writing to Firebase.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run api` | Start the REST API and Swagger UI |
| `npm run api:dev` | Same, but reloads when a file changes |
| `npm run live` | Start the live service (add `--sink console` to avoid writing to Firebase, `--no-archive` to skip Postgres) |
| `npm run sync -- <command>` | Sync from the provider (see [Data sync](#data-sync-rest-to-postgres)) |
| `npm run replay` | Replay a recorded feed through the live processor (see [Testing](#testing-and-replaying-recorded-matches)) |
| `npm run merge:demo` | Run the 10 checks of the admin-versus-provider merge rules |
| `npm run typecheck` | TypeScript type check |
| `npm run db:push` | Apply the Prisma schema to the database |
| `npm run db:studio` | Open Prisma Studio to browse the database |
| `npm run test:connection` | Check the provider token and REST connection |
| `npm run listen` | Record the raw push feed to `captures/` |
| `npm run summarize`, `analyze`, `trace`, `deepdive` | Analysis tools for recorded feeds |

## Swagger UI and the OpenAPI file

The API documents itself. Once `npm run api` is running:

| URL | What you get |
| --- | --- |
| http://localhost:3000/docs | **Swagger UI**: browse every endpoint, see parameters and defaults, and press **Try it out** to call the API from the browser |
| http://localhost:3000/docs/json | The raw **OpenAPI 3** document (JSON), for generating client code or importing into Postman or Insomnia |

The documentation is generated from the route schemas in [src/api/routes/](src/api/routes/), so it cannot drift from the code. Endpoints are grouped by tag: **Matches**, **Series**, **Teams**, **Players**. The `/health` and `/ready` routes are hidden from Swagger on purpose.

To try an endpoint in Swagger UI: open `/docs`, expand an endpoint, click **Try it out**, fill in the parameters, then **Execute**. The response body, status code and headers appear below.

## REST API reference

Base URL: `http://localhost:3000`. All responses are JSON. App endpoints are under `/v1`.

### Conventions

- **Ids.** `id` in a path is the database id for series, teams and players. For matches, `id` is the **provider's match id**, the same id used in Firebase (`live/{matchId}`).
- **Lookup by provider id.** Series, team and player endpoints accept `?by=provider` to treat `id` as the provider's id instead of the database id (`?by=id` is the default).
- **Pagination.** List endpoints take `limit` (1 to 100, default 20) and `offset` (default 0). Ball history uses a cursor instead (see below).
- **Caching.** Responses are cached in Redis for a few seconds to a few minutes (see the table). If Redis is down, the API still works without the cache.
- **Rate limiting.** 120 requests per minute per client IP by default, counted in Redis so it is shared by every copy of the API. Over the limit returns `429`. `/health` and `/ready` are not limited.
- **Dates.** ISO 8601 UTC timestamps. Plain dates are `YYYY-MM-DD`.

### Errors

Every error has the same shape:

```json
{ "error": { "code": 404, "message": "Match not found" } }
```

| Code | When |
| --- | --- |
| 400 | A parameter failed validation (bad type, out of range, missing required value) |
| 404 | The record or route does not exist |
| 429 | Rate limit exceeded |
| 500 | Unexpected error (the message is always "Internal server error"; details are only in the server log) |

### Matches

| Endpoint | Returns | Cache |
| --- | --- | --- |
| `GET /v1/matches` | Match list | 5 s for `status=live`, otherwise 30 s |
| `GET /v1/matches/{id}` | Match details and result | 5 s if live, otherwise 120 s |
| `GET /v1/matches/{id}/scorecard` | Scorecard for each innings | 10 s if live, otherwise 600 s |
| `GET /v1/matches/{id}/balls` | Ball-by-ball history, newest first | 5 s for the first page, 60 s for later pages |

**`GET /v1/matches`** query parameters:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `status` | `live`, `upcoming`, `completed`, `cancelled` | Filter by state. `upcoming` is sorted soonest first; everything else is newest first |
| `date` | `YYYY-MM-DD` | Matches that start on this UTC day |
| `competitionId` | integer | Only matches in this series (database id) |
| `teamId` | integer | Only matches this team plays in (database id) |
| `limit`, `offset` | integer | Paging |

Response: `{ "items": [ matchSummary ], "limit": 20, "offset": 0 }`

A **match summary** contains:

```json
{
  "id": 98955,
  "title": "Team A vs Team B",
  "shortTitle": "TMA vs TMB",
  "subtitle": "1st ODI",
  "matchNumber": "1",
  "format": { "code": 1, "name": "ODI" },
  "status": { "code": 3, "name": "Live", "note": "Team A need 120 runs" },
  "live": true,
  "startsAt": "2026-11-05T09:00:00.000Z",
  "teamA": { "id": 12, "providerId": 4001, "name": "Team A", "short": "TMA", "type": "international", "country": "in", "logo": "https://...", "score": "180/4 (30.0)" },
  "teamB": { "...": "same shape as teamA" },
  "venue": { "id": 3, "name": "Ground name", "city": "City" },
  "competition": { "id": 7, "providerId": 130173, "title": "Series title" },
  "result": null,
  "winner": null
}
```

(Example values are illustrative; the field names are exact.) `winner` is `"teamA"`, `"teamB"` or `null`. Status codes are the provider's: `1` scheduled, `2` completed, `3` live, `4` cancelled.

**`GET /v1/matches/{id}`** returns the summary plus: `endsAt`, `gameState {code, name}`, `resultType`, `winMargin`, `winningTeamProviderId`, `toss`, `pitch`, `weather`, `umpires`, `referee`, `domestic`, `hasCommentary`, `hasWagon`, `latestInningNumber`, and `liveRef` (the Firebase path `live/{id}` while the match is live, otherwise `null`).

**`GET /v1/matches/{id}/scorecard`** returns `{ "matchId", "live", "innings": [ ... ] }`. Each innings has `id`, `number`, `name`, `short`, `status`, `result`, the batting and fielding team provider ids, `scores`, `scoresFull`, and `scorecard`, the full batting and bowling scorecard, which is stored once the innings is **completed**. For an innings in progress, use the live data in Firebase. Innings are returned even if the match row is not in the database yet.

**`GET /v1/matches/{id}/balls`** query parameters:

| Parameter | Meaning |
| --- | --- |
| `innings` | Innings number (1 or higher). Omit for all innings |
| `before` | Return balls with an `eventId` below this value |
| `limit` | 1 to 100, default 30 |

Response: `{ "items": [ ball ], "nextBefore": 15415646 }`. To get the next page, pass `nextBefore` as `before`. `nextBefore` is `null` when there are no more pages. Balls are sorted by `eventId`, not by over and ball, because a wide or no-ball shares its over and ball number with the re-bowled delivery. A **ball** has `eventId`, `innings`, `over`, `ball`, `event` (`ball` or `wicket`), `score` (such as `4`, `w`, `1wd`), `runs`, the split `batRun`, `wide`, `noBall`, `bye`, `legBye`, flags `four`, `six`, `freeHit`, `batsman` and `bowler` (`{providerId, id, name}`), `commentary`, `wicket` (or `null`), `wagon` (shot position, if recorded) and `time`. This works for any match that has balls stored, even if its match row is missing; an unknown match returns an empty list.

### Series

| Endpoint | Returns | Cache |
| --- | --- | --- |
| `GET /v1/series` | Series and tournaments, newest first | 60 s |
| `GET /v1/series/{id}` | Series details with its rounds and teams | 300 s |
| `GET /v1/series/{id}/matches` | Matches in the series | 30 s |

- `GET /v1/series` parameters: `status` (`live`, `fixture`, `result`), `search` (2 to 60 characters, matches the title), `limit`, `offset`.
- `GET /v1/series/{id}` accepts `by`. The series object has `id`, `providerId`, `title`, `short`, `type`, `category`, `status`, `format`, `season`, `startDate`, `endDate`, `country`, `totalMatches`, `totalTeams`, plus `rounds` (`id`, `name`, `order`, `type`, `format`, `startDate`, `endDate`) and `teams`.
- `GET /v1/series/{id}/matches` accepts `by`, `status` (same values as the match list), `limit`, `offset`, and returns the same shape as `GET /v1/matches`.

### Teams

| Endpoint | Returns | Cache |
| --- | --- | --- |
| `GET /v1/teams/{id}` | Team profile: `id`, `providerId`, `name`, `short`, `type`, `country`, `logo`, `altName`, `sex`, `headCoach`, `owner` | 600 s |
| `GET /v1/teams/{id}/squads` | Squads, newest series first | 600 s |

Both accept `by`. A team can have several squads (one per series, and per date and format for tours), so squads come back as `{ "items": [ { "competition": {id, title}, "date", "format", "players": [ playerSummary ] } ] }`.

### Players

| Endpoint | Returns | Cache |
| --- | --- | --- |
| `GET /v1/players?search=` | Player search by name (required, 2 to 60 characters, case-insensitive), `limit` 1 to 50, default 20 | 60 s |
| `GET /v1/players/{id}` | Player profile (accepts `by`) | 600 s |

A **player summary** has `id`, `providerId`, `name`, `role`, `country`, `image`. The **profile** adds `shortName`, `firstName`, `lastName`, `birthdate`, `birthplace`, `nationality`, `battingStyle`, `bowlingStyle`, `bowlingType`, `fieldingPosition`, `bio` and `social {facebook, twitter, instagram}`.

### Health checks (not in Swagger)

| Endpoint | Meaning |
| --- | --- |
| `GET /health` | The process is alive. Returns `{ "ok": true }` |
| `GET /ready` | Can it serve requests? Checks Postgres and Redis, and reports whether the live service holds the leader lock. Returns `200` when Postgres and Redis are up, otherwise `503`. A stopped live service is reported as `liveService: false` but does not make the API unready |

### Example calls

```bash
# Live matches
curl "http://localhost:3000/v1/matches?status=live"

# Today's upcoming matches
curl "http://localhost:3000/v1/matches?status=upcoming&date=2026-11-09"

# Last 30 balls of innings 2
curl "http://localhost:3000/v1/matches/98955/balls?innings=2&limit=30"

# Next page of balls
curl "http://localhost:3000/v1/matches/98955/balls?innings=2&limit=30&before=15415646"

# Look up a series by the provider's id
curl "http://localhost:3000/v1/series/130173?by=provider"

# Search players
curl "http://localhost:3000/v1/players?search=sharma"
```

## Live data in Firebase

The live service writes each live match to `live/{matchId}` (the provider's match id). The app listens to these paths and treats them as **read-only**. Only changed sections are rewritten, so a listener on one section fires only when that section changes.

| Path | Holds |
| --- | --- |
| `info` | Title, format, competition, both teams, venue, toss, start time (seconds) |
| `status` | Match status (1 scheduled, 2 completed, 3 live, 4 cancelled), state, day, session, batting and bowling team, innings, result |
| `score` | Runs, wickets, overs, target, run rates, innings score, per-team scores, equation |
| `batsmen`, `bowlers` | The two batters at the crease, and the current bowlers |
| `partnership` | Current partnership |
| `recent` | Recent scores, last five and ten overs, last wicket |
| `balls/{eventId}` | One entry per delivery |
| `lastEvent` | The latest ball event, shown before the confirming snapshot arrives. It is marked `provisional: true` |
| `heartbeat` | Time (ms) of the last write for this match |

A separate node, `system/liveHeartbeat`, holds the time (ms) of the live service's last beat, written every 10 seconds. If it is more than about 30 seconds old, the app should show that live updates are delayed.

Security rules ([database.rules.json](database.rules.json)): anyone can read `live` and `system`; nobody can write from the app. The live service writes with a service account.

Rules for the app developer:
- Never read the whole `balls` node. Use `orderByKey().limitToLast(60)` and load older balls from `GET /v1/matches/{id}/balls`.
- All times are milliseconds except `info/startsAt`, which is in seconds.
- Redraw from the latest value; balls and sections can be updated after they first appear (commentary arrives within about a minute, and scorers can correct runs or the batsman).

The full field list for balls and `lastEvent`, and the table of provider event codes, are in the [data reference](Cricket%20Backend%20Data%20and%20API%20Reference.md).

## Data sync (REST to Postgres)

```bash
npm run sync -- live [--limit 10] [--force]      # live and upcoming competitions (limit 0 = all)
npm run sync -- competition <cid> [--force]      # one competition, by provider id
npm run sync -- competitions [live|fixture|result]   # competition list only
npm run sync -- status                           # row counts in the database
```

For each competition the sync runs three parts: **info** (rounds and teams), **squads** and **matches**. Each part is skipped if it was synced recently (info 24 h, squads 12 h, matches 10 min); `--force` ignores that. A failure in one part is logged and counted and the others still run. Each run is recorded in the `SyncRun` table. All provider REST calls pass through a shared rate limiter ([src/provider/rateLimiter.ts](src/provider/rateLimiter.ts)) that counts calls per minute in Redis.

**Admin versus provider data.** Admins can enter players, teams, series and venues before the provider has them. When provider data arrives ([src/sync/merge.ts](src/sync/merge.ts)):

1. A record entered by an admin has no provider id. When the sync finds a clear match, it links the two; uncertain matches are left alone.
2. After linking, provider values overwrite admin values field by field.
3. An empty provider value never overwrites an existing value.
4. A field an admin has locked is never overwritten.
5. An unchanged value is skipped.
6. Every overwrite is written to the `ChangeLog` table with the old and new value.
7. Admin-only fields (a player's bio and photo) are never touched by the provider.

`npm run merge:demo` runs 10 checks of these rules against the real database using a temporary test player.

**Missing series.** If the live service receives a match whose series was never synced, it syncs that series itself in the background (at most once per 30 minutes per series), so the match row appears without manual work.

## The live service in detail

`npm run live` ([src/scripts/live.ts](src/scripts/live.ts)):

- **Feed** ([src/live/feed.ts](src/live/feed.ts)): one WebSocket to the provider. It sends pings, reconnects with back-off (1 s, 2 s, 4 s, up to 30 s), and reconnects if nothing arrives for 5 minutes.
- **Parser** ([src/live/parse.ts](src/live/parse.ts)): turns raw messages into two kinds: a **snapshot** (full match state) and a **ball event** (a single quick event).
- **Processor** ([src/live/processor.ts](src/live/processor.ts)) has two lanes:
  - *Fast lane:* a ball event is written straight to `live/{matchId}/lastEvent`, so a boundary or wicket shows at once. The provider repeats some events; duplicates are dropped.
  - *Truth lane:* a snapshot is mapped ([src/live/mapSnapshot.ts](src/live/mapSnapshot.ts)) into sections and balls. Each section and ball is hashed, and **only what changed** is written to Firebase. Replaying a recorded match this way wrote about 0.9 MB instead of about 37 MB. Snapshots are full state, so if several arrive while one is being processed, only the newest is kept. The same changes are archived to Postgres ([src/live/archive.ts](src/live/archive.ts)): balls, innings (with the full scorecard once completed), the match status and score, and the players in the snapshot.
- **Leader election** ([src/live/leader.ts](src/live/leader.ts)): you can run two or more copies. A Redis lock (`live:leader`, 15 s lifetime, renewed every 5 s) decides which copy is the **leader**; the others stay connected as **standby** and do nothing. If the leader stops, a standby takes over in a few seconds. Two leaders for a moment is harmless because every write is idempotent.
- **Reconciliation** ([src/live/reconcile.ts](src/live/reconcile.ts)): after a reconnect, an election, or a Match End event, the service re-fetches the affected matches over the provider's REST API and feeds them through the same processor, filling any gap in ball history. Match End is not trusted on its own (it can mean the end of a day), so it is confirmed over REST about a minute later.
- **Sinks** ([src/live/sink.ts](src/live/sink.ts)): Firebase, or a console sink for development.
- **Heartbeats:** a global `system/liveHeartbeat` every 10 seconds, and a per-match `heartbeat` at most every 30 seconds. The service also logs its status and latency (socket to Firebase, median and 95th percentile) every minute.

## Database model

Defined in [prisma/schema.prisma](prisma/schema.prisma).

| Table | Stores |
| --- | --- |
| `Competition` | A series or tournament, with the provider's id |
| `Round` | A round or stage of a competition |
| `Venue` | A ground, with city and country |
| `Team` | A team, with logo and short name |
| `Player` | A player's profile. Bio and photo are admin-only fields the provider never overwrites |
| `CompetitionTeam` | Which teams play in which competition |
| `SquadEntry` | A player in a team's squad for a competition, with date and format |
| `Match` | One row per match: teams, venue, competition, status, scores, result, toss, pitch, weather |
| `Innings` | One row per innings, with the full scorecard saved once the innings is completed |
| `Ball` | One row per delivery, keyed by match and event id, so a provider correction overwrites the old row |
| `ChangeLog` | Every field the provider overwrote, with the old and new value |
| `SyncRun` | History of sync runs, for monitoring |

Match status codes: 1 scheduled, 2 completed, 3 live, 4 cancelled. Formats: 1 ODI, 2 Test, 3 T20I, 4 List A, 5 First Class, 6 T20, 8 Women T20, 17 T10. Codes are stored as numbers next to the provider's text label.

## Project structure

```
prisma/schema.prisma        Database tables
database.rules.json         Firebase security rules (read-only for the app)
docker-compose.yml          Local Postgres 16 and Redis 7
fixtures/                   A recorded provider feed used for replay and tests

src/
  config.ts                 Environment variables, validated with zod
  db.ts, redis.ts, logger.ts, utils.ts   Shared clients and helpers

  api/                      REST API
    app.ts                  Fastify setup: Swagger, CORS, rate limit, error handling
    routes/                 matches, series, teams, players, health
    schemas.ts              Shared query and parameter schemas
    mappers.ts              Database rows to API response shapes
    lookups.ts              Match list query and player-name lookup
    cache.ts                Redis cache with request coalescing
    errors.ts               notFound() helper

  live/                     Live service
    feed.ts                 WebSocket connection and reconnects
    parse.ts, types.ts      Message parsing and types
    processor.ts            Fast lane and truth lane, change detection
    mapSnapshot.ts          Provider snapshot to Firebase sections, balls, innings
    archive.ts              Postgres writes for live data
    sink.ts                 Firebase and console outputs
    leader.ts               Redis leader election
    reconcile.ts            Gap filling over REST

  sync/                     Provider REST to Postgres
    orchestrator.ts         Info, squads and matches per competition
    competitions.ts, squads.ts, matches.ts, entities.ts
    merge.ts                Admin-versus-provider merge rules
    normalize.ts            Cleans provider values

  provider/                 Provider REST client and rate limiter

  scripts/                  Entry points (api, live, sync, replay, merge demo,
                            capture and analysis tools)
```

## Testing and replaying recorded matches

There is no separate test runner yet. What exists:

- `npm run typecheck` checks the types.
- `npm run merge:demo` checks the 10 admin-versus-provider merge rules (needs Postgres running).
- `npm run replay` feeds a recorded provider feed through the live processor without needing a live match:

```bash
npm run replay -- [file] [--speed 20] [--limit 500] [--match 98955] [--archive] [--sink firebase] [--root replay] [--print]
```

By default it replays `fixtures/live-sample.ndjson` (1,212 recorded messages) at 20x speed, writes to the console (not Firebase), and uses the Firebase root `replay` so real `live` data is never overwritten. Add `--archive` to also write to Postgres. It prints counts of applied, unchanged, coalesced and corrected snapshots, bytes written, and our-side latency.

## Known gaps and not built yet

- **Admin endpoints** (create, edit and lock records, provider linking, change-log viewer, sign-in and roles) are planned; the merge rules they rely on are built and tested.
- **OpenAPI contract** is generated from the code today; it is to be reviewed with the Flutter team before it is treated as final.
- **Match statistics, player career stats, rankings and standings** are not built.
- **Removing finished matches from Firebase** after about 24 hours is planned.
- **Strike indicator:** the `batsmen` list has no field marking who is on strike.
- **Wagon wheel data** (shot position) is stored in Postgres and returned by the balls endpoint, but is not in Firebase.
- **Deployment, alerting and automated tests** (Cloud Run, Cloud SQL, monitoring, API and pipeline tests, load test) are planned.
- Everything was tested with the provider's **demo token**; two competitions returned no teams or squads, probably a demo-token limit. Data-licensing terms are still to be confirmed.
