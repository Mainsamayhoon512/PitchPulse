# Code improvements: what changed and where

This document lists each improvement made after the first release, the problem it solves, the files that changed, and how it was checked. File links are relative to the repository root.

## Summary

| # | Improvement | Type | Main files |
| --- | --- | --- | --- |
| 1 | Replay script no longer crashes at the end | Bug fix | [processor.ts](../src/live/processor.ts), [replay.ts](../src/scripts/replay.ts), [live.ts](../src/scripts/live.ts) |
| 2 | Rate limit can no longer be bypassed with a fake IP header | Security | [app.ts](../src/api/app.ts), [config.ts](../src/config.ts) |
| 3 | Unknown match ids return 404 on the balls endpoint | Bug fix | [matches.ts](../src/api/routes/matches.ts) |
| 4 | No more wasted database writes for matches missing from the database | Efficiency | [processor.ts](../src/live/processor.ts) |
| 5 | Debug code and unbounded memory removed | Cleanup | [processor.ts](../src/live/processor.ts), [archive.ts](../src/live/archive.ts) |
| 6 | Automated tests (22 tests) | Quality | [tests/](../tests/), [vitest.config.ts](../vitest.config.ts) |
| 7 | CI on every push | Quality | [ci.yml](../.github/workflows/ci.yml) |
| 8 | `.env.example` | Developer experience | [.env.example](../.env.example) |
| 9 | Consistent line endings | Developer experience | [.gitattributes](../.gitattributes) |
| 10 | Dockerfile and compose services | Deployment | [Dockerfile](../Dockerfile), [docker-compose.yml](../docker-compose.yml) |
| 11 | Swagger UI switch and CORS warning | Security | [app.ts](../src/api/app.ts), [config.ts](../src/config.ts) |
| 12 | Finished matches removed from Firebase after 24 hours | Feature | [cleanup.ts](../src/live/cleanup.ts), [live.ts](../src/scripts/live.ts) |
| 13 | Database indexes for common queries | Performance | [schema.prisma](../prisma/schema.prisma) |

Not done, with the reason, are listed at the end.

---

## 1. Replay script crash

**Problem.** When the live processor met a match that was not in the database, it started a background sync of that match's series. `npm run replay` closed the Postgres and Redis connections as soon as its messages were processed, while that sync was still running. The result was `Connection is closed` and `Response from the Engine was empty` errors, and a half-finished sync.

**Change.**
- [processor.ts](../src/live/processor.ts): the processor keeps a set of running background syncs (`syncs`). A new method `waitForSyncs()` waits for all of them.
- [replay.ts](../src/scripts/replay.ts): calls `await processor.waitForSyncs()` after `drain()` and before closing connections.
- [live.ts](../src/scripts/live.ts): on shutdown (Ctrl+C), the live service also waits for background syncs, for at most 30 seconds, before closing connections.

**Checked.** A replay of the recorded feed now finishes with both missing series (130173 and 130174) synced and no errors.

## 2. Rate limit bypass through `X-Forwarded-For`

**Problem.** The API was created with `trustProxy: true`. Without a proxy in front, any client could send a different `X-Forwarded-For` header on every request and be counted as a new IP each time, so the per-IP limit never applied.

**Change.**
- [config.ts](../src/config.ts): new setting `API_TRUST_PROXY`, default `false`.
- [app.ts](../src/api/app.ts): `trustProxy` is set from that value through `parseTrustProxy()`. Accepted values: `false`, `true`, a number of proxies in front of the API (for example `1`), or a comma-separated list of proxy IPs or CIDRs.

**Checked.** With a limit of 3 per minute and a different fake IP on each of 5 requests: setting off gave `200 200 200 429 429` (spoofing ignored); setting `true` gave five `200`s (the header is trusted). A unit test covers every accepted value.

**When deploying.** Behind a load balancer set `API_TRUST_PROXY=1` (or the proxy's IPs). Otherwise all users share the proxy's address and one rate limit.

## 3. 404 for unknown matches on the balls endpoint

**Problem.** After the "sync a missing series" change, `GET /v1/matches/{id}/balls` no longer checked that the match exists, so any id returned `200` with an empty list.

**Change.** [matches.ts](../src/api/routes/matches.ts) (balls route): if no balls are found and the match row does not exist and no balls exist for that match at all, it returns `null`, which becomes a 404. A match with balls but no match row still returns its balls, which was the purpose of the earlier change.

**Checked.** API test requests `/v1/matches/999999999/balls` and expects the standard 404 error body.

## 4. Repeated database writes for a missing match

**Problem.** For a match not in the database, `updateMatchStatus` updated zero rows on every changed snapshot, because the "already written" hash was never saved.

**Change.** [processor.ts](../src/live/processor.ts), in `archive()`: the processor remembers a match as missing for 60 seconds (`missingUntil`, `MISSING_RECHECK_MS`) and skips the update during that time. When a later update succeeds, the memory is cleared. The 30-minute limit on series syncs is unchanged.

## 5. Debug code and memory

**Problem.** `processor.ts` held a `ballRows` map with a copy of every ball (up to 200,000 balls) only to print the first five corrections, plus several commented-out lines.

**Change.**
- [processor.ts](../src/live/processor.ts): removed `ballRows`, `debugShown`, the debug log and the commented-out code in `diffBalls`. The correction counter (`ball_corrections`) stays. A comment now explains why `providerTime` is left out of the hash.
- [archive.ts](../src/live/archive.ts): removed a commented-out line.

## 6. Automated tests

Run with `npm test`. There are 22 tests in five files; they use the first 400 recorded messages in [fixtures/live-sample.ndjson](../fixtures/live-sample.ndjson).

| File | What it checks |
| --- | --- |
| [parse.test.ts](../tests/parse.test.ts) | Ball events, snapshots, bad input, and that every recorded message parses |
| [mapSnapshot.test.ts](../tests/mapSnapshot.test.ts) | All Firebase sections are produced, competition id and match update are read, balls are mapped, empty input never throws |
| [processor.test.ts](../tests/processor.test.ts) | Firebase paths written; an identical snapshot writes nothing new; repeated ball events are dropped; a match is written in full again after `forgetMatch` |
| [cleanup.test.ts](../tests/cleanup.test.ts) | Only matches finished more than 24 hours ago are removed, and only once Postgres holds them |
| [api.test.ts](../tests/api.test.ts) | `/health`, `/ready`, Swagger UI and the OpenAPI paths, match list shape, 404 error shape for unknown records, 400 for bad parameters, `parseTrustProxy` |

The tests need Postgres and Redis (`docker compose up -d`). They use **Redis database 15** and only read from Postgres, so development data is not touched. [vitest.config.ts](../vitest.config.ts) sets a dummy provider token. `npm run typecheck` now also checks the tests ([tsconfig.json](../tsconfig.json)). The existing `npm run merge:demo` (the 10 merge-rule checks) is unchanged.

## 7. Continuous integration

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on every push to `main` and every pull request. It starts Postgres and Redis, installs dependencies, creates the tables, then runs the type check and the tests. It has not run on GitHub yet (see the notes at the end).

## 8. `.env.example`

[.env.example](../.env.example) lists every setting with safe placeholders. Copy it to `.env` and fill in the values.

## 9. Line endings

[.gitattributes](../.gitattributes) sets `* text=auto`, which removes the LF/CRLF warnings between Windows and Linux. The large fixture file is marked `-diff`.

## 10. Docker

- [Dockerfile](../Dockerfile): one image for both programs. The command decides which runs (`npm run api` is the default, `npm run live` for the live service). [.dockerignore](../.dockerignore) keeps secrets, the `.env` file, recordings and tests out of the image.
- [docker-compose.yml](../docker-compose.yml): new `api` and `live` services under the `app` profile. A plain `docker compose up -d` still starts only Postgres and Redis. To run everything: `docker compose --profile app up -d --build`.

**Checked.** The image builds, and the API started from it answered `/ready` with Postgres and Redis up, and `/docs` returned 404 with docs disabled.

## 11. Swagger UI switch and CORS warning

- [config.ts](../src/config.ts): new `API_DOCS_ENABLED` (default `true`). With `false`, `/docs` and `/docs/json` are not served.
- [app.ts](../src/api/app.ts): when `NODE_ENV=production` and `API_CORS_ORIGINS` is still `*`, the API logs a warning at start-up. The Docker image sets `NODE_ENV=production`.
- [api.ts](../src/scripts/api.ts): the start-up message no longer mentions `/docs` when docs are off.

## 12. Removing finished matches from Firebase (only after they are in Postgres)

**The data flow.** Firebase gets each update first, so the app can show it at once; Postgres is written right after, from the same snapshot ([processor.ts](../src/live/processor.ts), `applySnapshot`):

1. A ball event (a boundary, a wicket) goes straight to `live/{id}/lastEvent`. It is Firebase only; the confirmed ball reaches Postgres with the next snapshot.
2. A snapshot is written to Firebase first (`sink.update`). If that fails, nothing is archived and the next snapshot retries.
3. Only after Firebase succeeds is the same data saved to Postgres (`archive`): balls, innings, match status and score, players. If Postgres fails, the balls are retried on the next snapshot.

**Problem.** Matches stayed in `live/` forever. A first version of the cleanup also had a gap: it marked a match as finished before the Postgres write and never checked that Postgres had it, so a Postgres outage at the end of a match could have deleted the only copy.

**Change.**
- [processor.ts](../src/live/processor.ts): a match is added to the Redis sorted set `live:finished` (with the time it was first seen finished) only when its snapshot shows status 2 **and the Postgres write succeeded**.
- [cleanup.ts](../src/live/cleanup.ts): `cleanupFinished()` takes the matches finished more than 24 hours ago and checks Postgres (`archivedInDatabase`): the match row must exist with status 2, and its balls must be saved. Only those are deleted from Firebase (`live/{id}` set to null). The others stay in Firebase, a warning is logged, and they are checked again on the next run. Deleted matches are also forgotten by the processor (`forgetMatch`), otherwise it would never write them to Firebase again.
- [live.ts](../src/scripts/live.ts): runs the cleanup every 10 minutes, on the leader only.

The match stays in Postgres and in the REST API. Matches that finished before this change are not in the set, so they are not removed automatically.

**Checked.** Tests cover: only matches older than 24 hours are removed; a match that Postgres does not hold yet is kept in Firebase and stays queued. The Postgres check was also run against the real local database: none of the matches there qualified, so none would have been deleted.

## 13. Database indexes

[schema.prisma](../prisma/schema.prisma), model `Match`: added indexes on `dateStart` (list matches for a day with no status), `teamAId` and `teamBId` (matches of a team). Before, those filters scanned the whole table. Applied to the local database with `npm run db:push`.

---

## Not done, and why

| Item | Reason |
| --- | --- |
| Admin endpoints, sign-in and roles | Needs the list of admin roles and a sign-in decision (listed as a dependency in section 9 of the data reference). The merge rules they rely on are built and tested |
| Faster player search | `GET /v1/players?search=` uses a case-insensitive "contains" match, which a normal index cannot speed up. Fixing it needs the Postgres `pg_trgm` extension. Not needed at the current 1,397 players |
| Prisma client regeneration | `npx prisma generate` failed on this PC because a running API process had the engine file locked. The new indexes do not change the generated types. Stop the running API, then run `npx prisma generate` |

## Notes before you push

- The CI workflow file lives under `.github/workflows/`. Pushing it can be refused if the saved GitHub login does not allow workflow changes; in that case use a token with the `workflow` permission.
- `package.json` gained the `vitest` dev dependency and the `test` script.
- Nothing from this round is committed yet.
