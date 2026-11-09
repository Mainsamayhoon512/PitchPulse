# Cricket Backend: Data and API Reference

Nov 6, 2026 · @Harsh

## 1. Overview

The app gets data from two places. Live match data comes from Firebase Realtime Database, which our live service updates within about a second of the provider. History, teams, players, series and scorecards will come from our own REST API, which reads Postgres and Redis and never calls the provider per request.

Built today: the Firebase live-data layout (sections 2 and 3), the Postgres data model (section 4) and the admin-versus-provider rules (section 5). Planned, not built: the REST API and admin endpoints (section 6). Everything here was tested with the provider's demo token; field names come from real recorded matches.

## 2. Firebase live data

Each live match is stored under `live/{matchId}`, where `matchId` is the provider's match id. The app should listen to these paths and treat them as read-only. Only changed sections are rewritten, so a listener on one section fires only when that section changes.

| Path | What it holds | Fields |
| --- | --- | --- |
| `info` | Match details, changes rarely | title, shortTitle, subtitle, format, competition {id, title}, teamA and teamB {id, name, short, logo}, venue {name, city}, toss, startsAt (seconds) |
| `status` | Match state | status (1 scheduled, 2 completed, 3 live, 4 cancelled), statusStr, statusNote, gameState, gameStateStr, day, session, teamBatting, teamBowling, inning, result, winningTeamId |
| `score` | Live score | runs, wickets, overs, target, runRate, requiredRunRate, inningsScore, battingTeamId, teamA {id, score}, teamB {id, score}, equation |
| `batsmen` | The two batters at the crease (list) | id, name, runs, balls, fours, sixes, strikeRate |
| `bowlers` | Current bowlers (list) | id, name, overs, maidens, runs, wickets, economy |
| `partnership` | Current partnership | runs, balls, overs, batsmen |
| `recent` | Recent form | recentScores, lastFiveOvers, lastTenOvers, lastWicket |
| `balls/{eventId}` | One entry per delivery | see section 3 |
| `lastEvent` | The latest ball event, shown before the snapshot confirms it | see section 3 |
| `heartbeat` | Time (ms) of the last write for this match | a single number |

A separate node, `system/liveHeartbeat`, holds the time (ms) of the live service's last beat, written every 10 seconds. If it is more than about 30 seconds old, the app should show that live updates are delayed.

The security rules let anyone read `live` and `system` and let nobody write from the app.

## 3. Ball and lastEvent

Each delivery is stored at `live/{matchId}/balls/{eventId}`. Sort balls by `eventId`, not by over and ball, because a wide or no-ball shares its over and ball number with the re-bowled delivery. A ball can change after it first appears: the provider adds commentary text within about a minute, and a scorer can correct runs or the batsman, so the app should always redraw from the latest value.

| Field | Meaning |
| --- | --- |
| innings | Innings number |
| over, ball | Over and ball number as the provider reports them |
| event | `ball` or `wicket` |
| score | Short label such as `4`, `w`, `1wd`, `2lb` |
| runs | Total runs from this delivery |
| batRun, wide, noBall, bye, legBye | Runs split by type |
| four, six, freeHit | true or false |
| batsmanId, bowlerId | Provider player ids |
| commentary | Text; it gets longer when the provider adds detail |
| wicket | `null`, or {wicketBatsmanId, howOut, dismissal, batsmanRuns, batsmanBalls} |
| time | Time (ms) when we first saw the ball |

`lastEvent` is a single node that is overwritten for each new event. It appears before the full snapshot arrives, so the app can show a boundary or wicket straight away. It is marked `provisional: true` because the snapshot that follows is the confirmed record.

| Field | Meaning |
| --- | --- |
| code, label | Event code and the provider's text for it |
| innings, over, ball | Position of the event |
| strikerName, bowlerName | Names for display |
| provisional | Always true |
| at | Time (ms) when we received it |

Event codes seen so far:

| Group | Codes |
| --- | --- |
| Runs | 26 dot, 35 one, 36 two, 31 four, 32 six |
| Extras | 27 wide, 28 no ball, 29 bye, 30 leg bye |
| Wickets | 25 wicket, 42 bowled, 43 caught, 44 LBW |
| Play | 24 ball start, 21 ball in air, 20 appeal, 6 boundary check |
| Markers | 23 over, 12 maiden, 2 new batter, 3 new bowler, 67 match end |
| Breaks | 53 drinks, 56 lunch, 63 bad light, 68 fielder injured |

## 4. Postgres data model

Postgres is the long-term store. The REST API will read from it, and the app should not need to know its layout; this table is for the back-end and front-end teams to agree on what data exists.

| Table | What it stores |
| --- | --- |
| Competition | A series or tournament, with the provider's id |
| Round | A round or stage of a competition |
| Venue | A ground, with city and country |
| Team | A team, with logo and short name |
| Player | A player's profile. Bio and photo are admin-only fields the provider never overwrites |
| CompetitionTeam | Which teams play in which competition |
| SquadEntry | A player in a team's squad for a competition, with date and format |
| Match | One row per match: teams, venue, competition, status, scores, result, toss, pitch and weather |
| Innings | One row per innings, with the full scorecard saved once the innings is completed |
| Ball | One row per delivery, keyed by match and event id, so a provider correction overwrites the old row |
| ChangeLog | Every field the provider overwrote, with the old and new value |
| SyncRun | A history of sync runs, for monitoring |

Match status uses the provider's codes: 1 scheduled, 2 completed, 3 live, 4 cancelled. Formats are 1 ODI, 2 Test, 3 T20I, 4 List A, 5 First Class, 6 T20, 8 Women T20, 17 T10. Codes are stored as numbers next to the provider's text label.

## 5. Admin and provider data rules

Admins can enter players, teams, series and venues before the provider has them. When provider data arrives it overwrites the admin data under these rules:

1. A record entered by an admin has no provider id yet. When the provider sync finds a clear match, it links the two records; uncertain matches are left alone.
2. After linking, provider values overwrite admin values field by field.
3. An empty provider value never overwrites a value that is already there.
4. A field an admin has locked is never overwritten.
5. A value that is unchanged is skipped.
6. Every overwrite is written to the ChangeLog with the old and new value.
7. Admin-only fields (a player's bio and photo) are never touched by the provider.

The ten automated checks of these rules pass.

## 6. Planned REST API (Phase 4, not built yet)

This is a draft for the front-end team to review. Paths and response shapes will be confirmed against the Flutter app's data models before the code is written, and the final contract will be published as an OpenAPI specification. All endpoints return JSON, are versioned under `/v1`, and read from Redis first and Postgres second.

**App endpoints**

| Endpoint | Returns |
| --- | --- |
| `GET /v1/matches?status=live\|upcoming\|completed&date=` | Match list for the home screen |
| `GET /v1/matches/{id}` | Match details and result |
| `GET /v1/matches/{id}/scorecard` | Full scorecard for each innings |
| `GET /v1/matches/{id}/balls?innings=&before=&limit=` | Ball-by-ball history in pages |
| `GET /v1/series` and `GET /v1/series/{id}` | Series list and details |
| `GET /v1/series/{id}/matches` | Matches in a series |
| `GET /v1/teams/{id}` | Team profile and squad |
| `GET /v1/players/{id}` and `GET /v1/players?search=` | Player profile and search |

**Admin endpoints** (sign-in and roles required)

| Endpoint | Does |
| --- | --- |
| `POST /admin/{players\|teams\|series\|venues}` | Create a record |
| `PATCH /admin/{type}/{id}` | Edit a record |
| `PUT /admin/{type}/{id}/locks` | Lock or unlock fields against provider overwrites |
| `GET /admin/provider/players?search=` | Search provider players to link to an admin record |
| `POST /admin/{type}/{id}/link` | Link an admin record to a provider record |
| `GET /admin/changelog` | See what the provider overwrote and when |

Later additions: match statistics, player career stats, rankings and standings. These tables are not built yet.

## 7. Conventions, limits and open items

For the Flutter team:

- Never read the whole `balls` node. A long match can hold hundreds of balls. Ask for the latest ones only (`orderByKey().limitToLast(60)`) and load older balls from the REST API.
- Times are milliseconds, except `info/startsAt`, which is in seconds.
- Treat Firebase as read-only. Redraw from the latest value, because balls and sections can be updated after they first appear.
- If `system/liveHeartbeat` is more than about 30 seconds old, show that live updates are delayed.

Open items:

- The `batsmen` list has no field marking who is on strike. The list order changes between updates, but I have not confirmed that it shows the striker.
- Shot position (wagon, with pitch length and line) is stored in Postgres but is not yet in Firebase. It is added if the app needs a wagon wheel.
- Finished matches should be removed from Firebase after about 24 hours. This cleanup is planned for Phase 4.
- The provider's scoring delay can't be measured by us. Our side, from receiving a message to the Firebase write being confirmed, measured about 450 ms median from a PC in Dubai to a Singapore database, and should be lower when the service runs in the cloud.
- Demo-token limits, data-licensing terms and the Flutter data models are still to be confirmed.

## 8. Development status: Phases 1 to 3

Phases 1 to 3 are built and tested with the provider's demo token. This table lists the test cases and their results. Rows marked pending have not been run yet.

| Phase | Test case | Result |
| --- | --- | --- |
| 1 | Connect to the REST API and read a response | Passed |
| 1 | Record the push feed and analyse the recording (1,212 clean messages kept as a fixture) | Passed |
| 1 | Three listeners on one token at the same time | Passed; the demo token accepted 3 connections |
| 1 | Delay from provider to us after correcting the PC clock | Snapshot median 34 ms; ball event to confirming snapshot median 245 ms |
| 2 | Create the database schema and run the type check | Passed |
| 2 | Ten automated checks of the admin and provider merge rules | All 10 passed |
| 2 | Sync from the provider, then a forced second sync | No duplicates created |
| 2 | Database contents after sync | 48 competitions, 20 teams, 28 venues, 1,397 players, 916 squad entries, 238 matches |
| 3 | Replay 1,212 recorded messages into Firebase | None unrecognised; 13 repeated events dropped; about 0.9 MB written instead of about 37 MB |
| 3 | Replay into Postgres twice | Same counts both times (1,191 balls, 44 innings), so no duplicates |
| 3 | Study of ball changes in the recording | 553 changes across 120 of 721 balls; mostly commentary and shot position; 16 batsman changes and 7 score changes are real corrections |
| 3 | Live run against the real feed | Passed; data and heartbeat reach Firebase; about 450 ms median from a PC in Dubai |
| 3 | Second copy as standby | Passed; stayed idle while the first was leader |
| 3 | Failover: stop the leader | Passed; the standby took over in about 4 seconds and re-fetched 5 matches over REST, including a 790-ball innings |
| 3 | Demo token allows the REST gap-fill calls | Passed |
| 3 | A match finishes while the service runs and its status becomes Completed | Pending |

Bugs found and fixed during testing: the provider changes every ball's timestamp on each snapshot, which made almost every ball look corrected (now ignored); and a new leader did not know which matches to re-fetch (now recorded in Redis and verified in the failover test).

Known gaps: two competitions returned no teams or squads, probably a demo-token limit; match statistics, player career stats, rankings and standings are not built.

## 9. Phase 4: still to build

| Workstream | To build | Depends on |
| --- | --- | --- |
| App API | The endpoints in section 6, reading Redis first and Postgres second, with per-user rate limiting and pagination for ball history | Flutter data models, or approval of the shapes in this document |
| API contract | An OpenAPI specification for the front-end team and a final Firebase layout, including whether wagon data goes into Firebase | Review by the Flutter team |
| Admin endpoints | Sign-in and roles; create, edit and lock records; provider player search and linking; change-log viewer | The list of admin roles |
| Remaining data | Match statistics, player career stats, rankings and standings, plus a scheduled sync so data stays fresh | Production token and its quota |
| Firebase upkeep | Remove finished matches after about 24 hours; confirm match-end status change to Completed | A live match that finishes while the service runs |
| Deployment | Containers on Google Cloud: Cloud Run, Cloud SQL with high availability, managed Redis, secrets in Secret Manager; live service deployed in the same region as the Firebase database | Hosting and region decision, billing account |
| Reliability | Health checks, alert when the live heartbeat stops, error and latency dashboards, backups | Alert contacts |
| Testing | Automated tests for the merge rules, live pipeline and API, plus a load test of the API | None |
| Go-live | Switch to the production token, rotate the demo token, re-run the empty competitions, and measure real latency in the cloud | Production token, data-licensing answer |
