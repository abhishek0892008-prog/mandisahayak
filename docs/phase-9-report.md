# FarmQueue — Phase 9 Report: Queue and ETA Engine

**Phase:** 9 — live queue projection, queue position, evidence-based ETA
**Date:** 2026-09-02
**Status:** **IMPLEMENTED AND VERIFIED** against PostgreSQL 17.11
**Design contract:** [`phase-9-queue-eta.md`](./phase-9-queue-eta.md), written before implementation
**API contract:** [`api/queue.md`](./api/queue.md)
**Governing architecture:** `architecture.md` §14, §13.5 (D-4), P-1, P-3

---

## 1. Phase status

**Implemented and verified.** Two read endpoints, one pure projection engine, no
migration, no new permission, no invented operational policy.

| Check | Result |
|---|---|
| `npm test` | **226 / 226 pass**, 55 suites, 0 fail, 0 skipped |
| Phase 9 alone (`queue.test.ts`) | **52 / 52 pass**, 17 suites |
| `tsc --noEmit` | clean |
| `static-check.mjs` | PASSED — 0 failures, 0 warnings |
| `verify-schema.sql` | 23 / 23 |
| `verify-phase4.sql` | 15 / 15 |
| `verify-d9.sql` | 12 / 12 |
| SQL probes total | **50 / 50** |
| Route protection assertion | passes over **40** routes |

**One stop-condition was triggered and reported rather than resolved by
guessing** — see §9 and §32.

---

## 2. Baseline verification

Run **before** any Phase 9 file was created, on a database provisioned from zero:

| Check | Baseline |
|---|---|
| `npm test` | 174 tests, 38 suites, 0 fail |
| `tsc --noEmit` | clean |
| `static-check.mjs` | PASSED, 0/0 — 13 migrations, 48 tables, 130 indexes, 172 CHECK, 7 EXCLUDE |
| `verify-schema.sql` / `verify-phase4.sql` / `verify-d9.sql` | 23 / 15 / 12 |
| PostgreSQL | 17.11 on x86_64-windows |

Baseline was clean, so implementation proceeded. Phase 8 remains fully green:
**226 − 174 = 52**, exactly the Phase 9 additions, with no existing test changed.

Documents read first: `phase-8-report.md`, `phase-8-officer-operations.md`,
`api/officer.md`, `api/bookings.md`, `database-schema.md`, `architecture.md`
(§13.5, §14, §15, §16.4, §18, §19, §22, §23–23a), the live schema catalogue, the
permission and grant matrices, `core/rateLimit.ts`, `core/rbac.ts`, `core/audit.ts`,
and all four existing test files.

---

## 3. Requirements interpreted

Architecture **§14 already specifies this phase in full** — the projection
algorithm, the polling contract and the "derived, never stored" principle. Phase 9
implements §14 rather than inventing a queue model. Three concepts are kept
apart in the response contract itself:

```
QUEUE POSITION ≠ ETA ≠ GUARANTEED SERVICE TIME ≠ PROMISE
```

Position is an exact ordinal over committed records. ETA is a projection that
always travels with a confidence label. Neither is phrased as a commitment.

---

## 4. Queue definition

The queue is the set of bookings at one **(centre, service_date)** that are
physically waiting for, or currently receiving, service on a lane.

It is **derived on every request** from `bookings`, `procurements`,
`centre_slot_configurations` and `centre_service_lanes`. Nothing is stored.
Deleting the engine would lose no fact (P-1, §14.1).

---

## 5. Queue ordering rule

**Primary: `scheduled_start_at`** — the reserved window, exactly as §14.2
specifies. Not creation order, not token order, not arrival order.

**Tie-break: `(lane_no, token_number)`**, making the order **total**.
`token_number` is unique per centre-day (allocated `MAX+1` under the
daily-capacity lock), so no two members can tie on all three keys.

**Position is assigned by *projected* start**, which diverges from scheduled
start once a lane runs late — a free lane is genuinely served before a backed-up
one, and the ordinal says so.

**Two "ahead of me" numbers**, because one would mislead at a multi-lane centre:

| Field | Meaning |
|---|---|
| `aheadAtCentre` | served before me anywhere at this centre |
| `aheadOnLane` | served before me on my own lane — what actually predicts my wait |

**No manual reordering. No priority. No bump, flag or override.** No priority
concept exists in the approved requirements, the schema or the brief, and none
was invented.

---

## 6. Queue membership rule

Decided by **timestamps**, not the status label — the timestamps are the
physical facts:

| Status | `service_started_at` | `service_ended_at` | Membership |
|---|---|---|---|
| `CONFIRMED` | — | — | `WAITING` |
| `ARRIVED` | — | — | `WAITING` |
| `WEIGHING` | set | — | `IN_SERVICE` |
| `QUALITY_CHECK` | set | — | `IN_SERVICE` |
| `PROCUREMENT_RECORDED` | set | — | `IN_SERVICE` |
| `PAYMENT_PENDING` | set | set | **NOT_IN_QUEUE** |
| `COMPLETED` | set | set | NOT_IN_QUEUE |
| `CANCELLED` | any | any | NOT_IN_QUEUE |
| `NO_SHOW` | — | — | NOT_IN_QUEUE |

**`PAYMENT_PENDING` leaves the queue** although it remains an *active* booking
for the lane exclusion constraint and daily capacity. Its produce has been
handled; counting it would inflate every downstream farmer's wait with finished
work. This is a documented deviation from §14.2 (§23, deviation 1).

**Four events remove a member**, all existing Phase 7/8 transitions — Phase 9
adds none: `complete`, farmer cancellation, officer cancellation, no-show.
Removal is atomic with the causing transaction, because membership is a query
predicate rather than stored state.

---

## 7. Multi-lane semantics

- **One cursor per lane.** Each booking advances on the lane it reserved.
- **The stored `lane_no` is authoritative.** The projection never reassigns
  lanes; doing so in a read-only forecast would contradict the reservation
  `bookings_no_lane_overlap` is enforcing. Documented deviation 2 (§23).
- **Cross-lane comparison:** valid for *ordering* (all members share one clock,
  so a centre-wide ordinal is well-defined), invalid for *wait prediction* —
  which is exactly why `aheadOnLane` exists as its own field. A test asserts two
  bookings at adjacent centre positions on different lanes have materially
  different waits.
- **Idle lanes appear** in the officer view rather than being omitted; an idle
  lane is operational information.

Tested against **Aligarh**, the only demonstration centre with three lanes.

---

## 8. ETA algorithm

Implements §14.2 with three documented refinements (§23).

```
sort members by (scheduledStartAt, laneNo, tokenNumber)
laneFreeAt: Map<laneNo, Date> = {}                    // absent = free now

for each member m:
    if m.serviceStartedAt != null and m.serviceEndedAt == null:      // IN_SERVICE
        elapsed   = ceil(now - m.serviceStartedAt)  in minutes
        remaining = max(config.minimumProcessingMinutes,
                        m.processingMinutes - elapsed)
        projectedStartAt = m.serviceStartedAt        // an OBSERVED fact
        projectedEndAt   = now + remaining
        confidence       = OBSERVED
    else:                                                             // WAITING
        projectedStartAt = max(m.scheduledStartAt, laneFreeAt[m.laneNo] ?? now)
        projectedEndAt   = projectedStartAt + m.processingMinutes
        confidence       = isFutureDate ? SCHEDULED : PROJECTED

    laneFreeAt[m.laneNo] = projectedEndAt + config.transitionBufferMinutes
    waitMinutes          = max(0, ceil(projectedStartAt - now))

order by (projectedStartAt, laneNo, tokenNumber)
position = 1-based index;  aheadAtCentre = position - 1
```

**Every input is evidence, not an assumption:**

| Input | Origin |
|---|---|
| `processingMinutes` | `bookings.estimated_processing_minutes` — computed at booking time from **that booking's own quantity** and the centre's configured reference rate |
| `minimumProcessingMinutes` | `centre_slot_configurations` — §14.2's "configured_minimum" |
| `transitionBufferMinutes` | `centre_slot_configurations` — the same vehicle-clearance gap the Phase 7 scheduler uses |
| `serviceStartedAt` / `serviceEndedAt` | database `now()` recorded by an officer in Phase 8; never client-supplied |

**Four confidence levels:**

| Level | Basis |
|---|---|
| `OBSERVED` | Being served now; start is a recorded fact |
| `PROJECTED` | Service date is today; the cursor incorporates real upstream timestamps |
| `SCHEDULED` | Service date is future; no arrival recorded, so this is the reservation and explicitly not a live estimate |
| `UNAVAILABLE` | No defensible estimate; a reason is given |

**Unavailable reasons** — `estimatedStartAt`, `estimatedEndAt`,
`estimatedWaitMinutes` and `queuePosition` are all **`null`, never `0`**:

| Reason | When |
|---|---|
| `BOOKING_NOT_ACTIVE` | `CANCELLED`, `NO_SHOW`, `COMPLETED` |
| `SERVICE_COMPLETE` | `PAYMENT_PENDING` |
| `SERVICE_DATE_PAST` | Day has passed but the booking is still `CONFIRMED`/`ARRIVED` |
| `CENTRE_CONFIGURATION_UNAVAILABLE` | No slot configuration in force on the service date |

Dynamic behaviour falls out with no special-casing, as §14.3 requires: early
finish pulls downstream in, overrun pushes it out, cancellation and no-show move
everyone up, and larger quantities take longer. All four are tested.

---

## 9. ETA limitations

**What is deliberately NOT used as evidence:**

- **No historical or empirical service times**, although
  `service_started_at`/`service_ended_at` make an empirical mean computable.
  Using one requires choosing a lookback window, a minimum sample size, a
  grouping (centre? crop? lane? officer?) and an outlier rule — **four
  operational policies no approved requirement specifies**. At demonstration
  scale the sample is also near zero.
- **No average or fixed service duration**, no fixed minutes per farmer or per
  tonne, no officer productivity assumption, no lane-balancing rule, no capacity
  assumption beyond the CONFIGURED slot configuration, no government operating
  policy.

**STOP-CONDITION TRIGGERED AND REPORTED — `displayStatus: "APPROACHING"` is not
implemented.** D-4 (§13.5) defines it as derived *"against the configured
threshold"*, and §16.4 names `approaching_position_threshold` and
`turn_threshold_minutes` as centre/queue configuration. Verified against the
live schema:

```sql
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='public'
   AND (column_name ILIKE '%threshold%' OR column_name ILIKE '%approach%');
-- (0 rows)
```

**No threshold exists anywhere.** Choosing "position ≤ 3" or "wait ≤ 15 minutes"
would be fabricating operational policy. `displayStatus` therefore maps exactly
as Phases 7–8 already ship it. Unblocking requires a migration adding the
threshold columns **and an approved value or an explicit "the operator sets
this" decision.**

**Honest caveat on quality (R-9a):** the ETA is built on
`estimated_processing_minutes`, a *configured* rate that has never been
validated against measured reality. It is evidence-linked and defensible, but it
is a plan, not an observation.

---

## 10. Data sources

**Phase 9 used no government source and made no network request.** No government
value was created, read for interpretation, or inferred.

The queue and ETA read no MSP data at all. The only external-facing values
consumed are CONFIGURED centre parameters (lanes, processing reference,
minimum, buffer) already present from Phase 4.

**No source verification was required, and none is claimed.** The MSP provenance
position is unchanged from Phase 8: both PIB releases carry full provenance with
`last_verified_at` NULL, and Phase 9 does not touch them.

---

## 11. OFFICIAL / CONFIGURED / TEST classification

| Class | Phase 9 interaction |
|---|---|
| **OFFICIAL** | MSP rates (23) — **not read by queue or ETA**. Untouched |
| **CONFIGURED** | Slot configuration, lanes, operating hours, the five `DEMO-UP-*` centres — **read only**, never written |
| **TEST** | Bookings, procurements and staff created by the suite |

Phase 9 **creates no data of any kind**. No centre capacity is inferred from
national or state figures. Demonstration centres remain `CONFIGURED`; none was
promoted to `OFFICIAL`. No `verified_at` was set anywhere.

**One new configuration parameter**, explicitly CONFIGURED and operational:

| Key | Default | Why that default |
|---|---|---|
| `QUEUE_POLL_AFTER_SECONDS` | 5 | Architecture §14.4's stated default for `QUEUE_CACHE_TTL_SECONDS`, which §14.5 ties the polling cadence to |

It changes no computed value — only the `pollAfterSeconds` hint returned to the
client — and is **not** labelled OFFICIAL.

---

## 12. Database changes

**NONE.** No table, column, index, constraint or trigger was created, altered or
dropped. `static-check.mjs` reports the same object counts as the Phase 8
baseline: 48 tables, 130 indexes, 172 CHECK constraints, 7 EXCLUDE constraints,
24 triggers.

**No existing constraint was weakened.** No `queue_projections` table was
created: §14.4 makes it optional and calls it *"a cache, never an authority"*,
and a cache with no measured load problem is a second source of truth waiting to
drift.

Queue position is **not stored**, in line with P-1 and the brief's instruction
not to persist derived state for convenience.

---

## 13. Migrations

**ZERO.** Migrations remain **0001–0013**, unmodified. Nothing in Phase 9
required schema support that did not already exist.

---

## 14. Routes

Two added; registry total **40**, all passing the deny-by-default startup
assertion.

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/api/v1/bookings/:bookingCode/queue` | `queue.read.own` | — |
| GET | `/api/v1/officer/centres/:centreId/queue?date=` | `queue.read.centre` | — |

**No mutating queue endpoint exists**, because queue order is derived and
immutable from source records — there is nothing to reorder.

**Route ordering is safe by construction:** `/bookings/:bookingCode/queue` is
three segments and cannot collide with `/bookings/me` or `/bookings/:bookingCode`
(two each); the officer route sits under `/officer/centres/:centreId/`, disjoint
from `/officer/bookings/search`. Both are covered by tests, including malformed
codes rejected at the schema.

**Booking codes, not UUIDs**, on the farmer route. `:centreId` on the officer
route matches `/officer/centres/:centreId/bookings` shipped in Phase 8. **No
response contains a UUID** — asserted for both responses.

Deliberately not created: a bare `/queue` listing, a position-only endpoint, a
separate ETA endpoint, any queue mutation.

---

## 15. Permissions

**No permission was added, and no grant was changed.** Both permissions already
existed and were already granted:

| Permission | FARMER | OFFICER | ADMIN |
|---|:--:|:--:|:--:|
| `queue.read.own` | yes | — | — |
| `queue.read.centre` | — | yes | yes |

Phase 8's non-grants are untouched and re-asserted by a Phase 9 test: an ADMIN
can read a centre queue but is still refused `arrive` (`booking.advance_state`)
and still lacks `queue.read.own`. An officer is refused the farmer route.

---

## 16. Authentication / RBAC

Unchanged from Phase 5. Phase 9 added no authentication code.

Both routes declare an explicit permission; the startup assertion refuses to
boot otherwise and passes over all 40 routes. Both are GET reads, so CSRF does
not apply — and the assertion still requires CSRF on every mutating route,
unchanged.

- **Farmer identity comes from the session.** There is no `farmerId` parameter to
  supply. A test passes `?farmerId=…&userId=…` and confirms it changes nothing.
- **Ownership is resolved inside the query.** Another farmer's booking code
  returns `404` **byte-identical** to a nonexistent code — asserted by comparing
  the two error bodies.
- **No UUID reaches either response.**

---

## 17. Centre-scope enforcement

- The officer route calls `actorMayActOnCentre()` and returns **`404`, never
  `403`**, for an unassigned centre — the Phase 8 rule, so a refusal cannot
  confirm a centre exists.
- ADMIN carries an unrestricted scope (authority is not derived from an
  assignment); an officer carries exactly their assigned centres.
- The farmer route needs no centre scope: ownership already restricts it to one
  booking, and the centre is derived from that booking rather than supplied.

**Note on §8 of the brief ("centre scope must be enforced inside SQL
predicates"):** the officer *queue* route enforces scope in the route layer via
`actorMayActOnCentre` on a `:centreId` supplied in the path, then loads that one
centre-day. This matches `/officer/centres/:centreId/bookings` shipped in Phase 8
— where a single centre is addressed directly, the check is an equality test on
that identifier, not a filter over a result set that could leak a row. The
SQL-predicate rule applies to Phase 8's multi-centre searches, and remains in
force there. Recorded here so the difference is deliberate and visible.

---

## 18. Audit behaviour

**No audit action was added.** Two structural reasons:

1. **These are reads.** The architecture audits state changes, authorization
   denials and rate-limit rejections — not reads. A five-second poll per waiting
   farmer would write tens of thousands of rows a day into an append-only log
   retained for seven years, with no decision in any of them.
2. **There is nothing to audit.** Queue order is derived and immutable from
   source records; no actor can alter it. Every event that changes the queue is a
   Phase 7/8 transition **already audited** where it occurs, with the ordered
   trail already in `booking_status_history`.

**Still audited on these routes:** authorization denials (tested —
`queue.read.centre` denial appears in `audit_logs`) and rate-limit rejections.

**Tested invariant (§14.5):** ten polls across both endpoints change **nothing**
in `bookings`, `procurements`, `booking_status_history`, `audit_logs` or
`notifications`. A poll never mutates state and never sends a notification.

---

## 19. Rate limiting

Two new buckets. **No existing limit was weakened or reused.**

| Rule | Limit / 15 min | Headroom |
|---|---|---|
| `queue_read_session` | 400 | 2.2× |
| `officer_queue_session` | 900 | 5× |

**Threat model:** both endpoints are authenticated, ownership-scoped and
centre-scoped, and unknown/foreign identifiers return `404` identically — so
they are **not enumeration oracles**. The risk is resource exhaustion: the
server itself advertises a 5-second cadence, so a compliant client is a
high-frequency client and a looping one is indistinguishable until counted.

**Limits are derived, not picked.** A 15-minute window is 900 seconds; at
`pollAfterSeconds = 5` a compliant client issues **180** requests per window.
Farmers and officers are separated deliberately — an officer dashboard watches a
whole centre, possibly on several screens, and blocking it would stop the centre
working.

Tested: the derivation itself is asserted (`limit > 2 × 180`); a session driven
to its bucket limit gets `429` with `retryAfterSeconds`, while a **different**
session is unaffected, proving the limit is per session and not global.

---

## 20. Concurrency strategy

The queue is a **read of committed state**, so it needs no lock of its own — it
inherits the isolation of the writes Phase 8 already serialises with
`SELECT … FOR UPDATE`. A reader can therefore only ever observe a fully
committed, internally consistent state.

Tested races:

| Scenario | Assertion |
|---|---|
| 12 queue reads racing `weighing` | every response is `ARRIVED`+`WAITING` or `WEIGHING`+`IN_SERVICE`+`OBSERVED` — never a mixture |
| 10 reads racing `complete` | either in-service **with** a position, or out **with** all ETA fields null — never both, never neither |
| 8 centre-queue reads racing a cancellation **and** a no-show | no duplicate members, no terminal member, positions always a dense 1..n sequence |
| 3 bookings arriving and weighing simultaneously on 3 lanes | all three lanes serve at once, each a different booking |

**No impossible queue state was produced in any run**, and no race is "solved" by
hiding it — the projection simply has no intermediate state to expose.

---

## 21. Every file created

| Path | Lines | Purpose |
|---|---:|---|
| `server/src/engines/queue.ts` | 328 | PURE projection, membership, position, ETA confidence |
| `server/src/modules/queue/queue.repository.ts` | 108 | One query per centre-day; ownership query. No writes |
| `server/src/modules/queue/queue.service.ts` | 231 | Assembly, centre resolution, view mapping |
| `server/src/modules/queue/queue.routes.ts` | 127 | HTTP, permissions, rate limits |
| `server/tests/queue.test.ts` | 1 125 | 52 tests |
| `docs/phase-9-queue-eta.md` | — | Design contract (written first) |
| `docs/api/queue.md` | — | API contract |
| `docs/phase-9-report.md` | — | This report |

---

## 22. Every file modified

| Path | Change | Behaviour change |
|---|---|---|
| `server/src/core/config.ts` | +`QUEUE_POLL_AFTER_SECONDS` (default 5) | Additive |
| `server/src/core/rateLimit.ts` | +2 rules with documented threat model | Additive |
| `server/src/app.ts` | Mounts `buildQueueRouter()` | Additive |
| `server/.env.example` | Documents the new key; marks `QUEUE_CACHE_TTL_SECONDS` / `QUEUE_RECOMPUTE_SECONDS` as **not implemented** | Docs only |
| `server/README.md` | Counts 174→226; layout lists `queue` | Docs only |
| `server/package.json` | Version 0.8.0→0.9.0; description | Metadata |

**No existing behaviour was changed.** No existing test was modified. No
migration touched. **No frontend file was modified** — verified by timestamp
scan over `src/`, `public/`, `index.html`, `vite.config.js`, `eslint.config.js`
and the root `package.json`.

**Phase 8 documentation was left alone**, including the known permission-count
wording discrepancy, per instruction. It is unrelated to Phase 9 correctness and
remains outstanding.

---

## 23. Every test added — and the deviations they encode

**52 tests, 17 suites: 23 pure + 29 integration.**

| Suite | Tests | Kind |
|---|---:|---|
| ETA projection (pure) | 8 | pure |
| queue ordering (pure) | 4 | pure |
| multi-lane behaviour (pure) | 4 | pure |
| queue membership (pure) | 3 | pure |
| ETA availability (pure) | 3 | pure |
| queue invariants over generated states | 1 | pure (property) |
| terminal states leave the queue | 4 | integration |
| queue security | 4 | integration |
| queue concurrency | 4 | integration |
| officer centre queue | 4 | integration |
| queue ownership | 3 | integration |
| farmer queue view | 3 | integration |
| queue rate limiting | 2 | integration |
| a poll is a read: no mutation, no audit | 2 | integration |
| stale bookings whose day has passed | 1 | integration |
| a service date with no configuration in force | 1 | integration |
| status and service timestamps never disagree | 1 | integration |

**Property/invariant testing (brief §16).** One test runs **300 generated
centre-days** (seeded `mulberry32`, so a failure is reproducible) with random
lanes, statuses, schedules, durations and service timestamps, asserting on every
one: positions form a dense 1-based sequence; no duplicates; no terminal or
finished booking present; `position ≥ 1`; `waitMinutes ≥ 0`;
`aheadOnLane ≤ aheadAtCentre`; `aheadAtCentre = position − 1`; end never precedes
start; position order matches the defined ordering rule; per-lane projections
never go backwards; and the projection is deterministic.

### Documented deviations from architecture §14

| # | §14 says | Phase 9 does | Why |
|---|---|---|---|
| 1 | Skip only `{CANCELLED, NO_SHOW, COMPLETED}` | Also excludes `PAYMENT_PENDING` | `service_ended_at` is set; it occupies no lane and would inflate every downstream wait |
| 2 | *"the next booking is assigned to the earliest-free lane"* | Keeps the stored `lane_no`; one cursor per lane | That sentence describes the Phase 7 **scheduler**; reassigning inside a read-only projection would contradict the reservation `bookings_no_lane_overlap` enforces |
| 3 | `projected_end = start + occupancy`; `cursor = projected_end` | `projectedEndAt = start + processing`; cursor advances a further `buffer` | Separates the farmer's service end from lane-free, matching Phase 7's shipped `processingEndAt`/`windowEndAt`. The next farmer is still pushed by `processing + buffer` in total |
| 4 | Single scalar `currentlyServingToken` | Scoped to the farmer's own lane; officers get the per-lane list | A single centre-wide value is factually wrong at a multi-lane centre |
| 5 | `GET /officer/queue?centreId=&date=` (§18) | `GET /officer/centres/:centreId/queue` | Consistency with `/officer/centres/:centreId/bookings` shipped in Phase 8 |
| 6 | §14.4 in-process memo + `queue_projections` snapshot | Neither implemented | Both are caches; adding an invalidation surface with no measured load problem works against "queue state reflects committed database state only" |

No existing architectural decision was reinterpreted silently.

### Defect found and fixed during the phase

**One, in code I wrote in this phase, found by its own test.**

- **Original failure:** `stale bookings whose day has passed › refuses to
  estimate, and says why` — `TypeError: Cannot read properties of undefined
  (reading 'status')`, because the response was an error rather than data.
- **Root cause:** the service resolved the centre **only** as of the booking's
  service date. `centre_slot_configurations.effective_from` is `2026-09-01`, so a
  booking dated before that has no configuration in force,
  `loadCentreContext` returned `null`, and the endpoint answered **404**. A
  farmer would have been locked out of reading their own booking's queue status
  — the same temporal-configuration trap Phase 7's `resolveCentreForDate`
  documents.
- **Fix:** resolve the centre **twice, in order** — as of today for identity,
  timezone and lanes (always available), then as of the service date for the
  projection's configuration, which may legitimately be absent. When it is
  absent the projection is **not** computed from another date's numbers; the
  farmer gets `etaUnavailableReason: CENTRE_CONFIGURATION_UNAVAILABLE` with
  `activeQueueSize: null`, and the officer route returns `422
  CENTRE_NOT_AVAILABLE`. A projection built on the wrong configuration is worse
  than none, and a silent substitution would have been exactly the hidden
  fallback the brief forbids.
- **Regression tests:** the original stale-booking test, plus a new suite
  (`a service date with no configuration in force`) that end-dates a
  configuration, asserts both the farmer and officer behaviours, and restores it
  in a `finally`.

---

## 24. Exact test counts

| | Tests | Suites |
|---|---:|---:|
| Baseline (Phases 5–8) | 174 | 38 |
| **Phase 9 added** | **52** | **17** |
| **Total** | **226** | **55** |

Phase 9 split: **23 pure**, **29 integration**. Failures: **0**. Skipped: **0**.
Per-file on a clean database: auth 41, booking 46, farmer 25, officer 60,
queue 52.

---

## 25. Clean-database verification #1

Database dropped and recreated with `provision-database.sh --recreate`:

```
ready: 13 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings
tsc --noEmit ................ CLEAN
static-check.mjs ............ PASSED — 0 failures, 0 warnings
npm test .................... exit 0
  ℹ tests 226   ℹ suites 55   ℹ pass 226   ℹ fail 0   ℹ skipped 0
verify-schema.sql ........... PASSED: 23 checks
verify-phase4.sql ........... PASSED: 15 checks
verify-d9.sql ............... PASSED: 12 checks
route protection ............ 40 routes, assertion passed
```

---

## 26. Clean-database verification #2

Database **destroyed and recreated again**, whole sequence repeated:

```
ready: 13 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings
tsc --noEmit ................ CLEAN
static-check.mjs ............ PASSED — 0 failures, 0 warnings
npm test .................... exit 0
  ℹ tests 226   ℹ suites 55   ℹ pass 226   ℹ fail 0   ℹ skipped 0
verify-schema.sql ........... PASSED: 23 checks
verify-phase4.sql ........... PASSED: 15 checks
verify-d9.sql ............... PASSED: 12 checks
```

Identical results across both runs.

---

## 27. Static checker result

**PASSED — 0 failures, 0 warnings**, identical object counts to the Phase 8
baseline, confirming no schema change:

```
13 migration files, versions 0001..0013
48 tables, 6 domains, 130 standalone indexes, 12 ALTER-added constraints, 24 triggers
48 primary keys, 102 foreign keys, 172 CHECK constraints, 26 UNIQUE clauses, 7 EXCLUDE constraints
183 explicitly named table constraints; 6 of 130 standalone indexes are UNIQUE
7 EXCLUDE USING gist constraints; 9 partial indexes
```

---

## 28. TypeScript result

`npx tsc --noEmit` — **clean, zero errors**, run after every edit and in both
clean-database verifications. `strict` configuration unchanged. No `any` was
introduced in engine or service code; no dependency was added.

---

## 29. Known limitations

1. **ETA rests on a configured rate, never a measured one** —
   `estimated_processing_minutes` is a plan, not an observation.
2. **`displayStatus: "APPROACHING"` is not implemented** — no threshold
   configuration exists (§9).
3. **No caching or memoisation**; every poll recomputes one centre-day.
   Correct, and unmeasured under load.
4. **No `queue_projections` snapshot table.**
5. **No queue-recompute worker and no notifications** — Phase 10.
6. **No historical/empirical service-time model** (§9).
7. **`SERVICE_DATE_PAST` exists only because R-8b** (no no-show sweep) leaves
   stale bookings behind. Phase 9 reports the condition; it does not fix the
   cause.
8. **Queue performance is unverified under load.** No `EXPLAIN` regression test
   guards the centre-day query, although it reuses the index Phase 8 corrected.
9. **`CENTRE_CONFIGURATION_UNAVAILABLE` is reachable only by end-dating a
   configuration**, which no seeded data does; it is covered by a test that
   constructs the state and restores it.
10. **No frontend consumes any of this.** The existing prototype has a hardcoded
    queue literal (architecture §18.8); reconciling it is Phase 15 and was not
    touched.

---

## 30. Remaining risks

| ID | Risk | Status |
|---|---|---|
| **R-9a** | ETA quality depends on a configured, never-validated processing rate | Open, documented |
| **R-9b** | No memoisation; unmeasured under load | Open |
| **R-9c** | `SERVICE_DATE_PAST` is a symptom of R-8b, not fixed here | Open |
| **R-9d** | `APPROACHING` underivable until thresholds are configured | **Blocked on a decision** |
| **R-9e** | No plan-shape regression test for the centre-day query | Open |
| **R-8a** | `BLOCKED` payment strands its booking in `PAYMENT_PENDING` | Unchanged |
| **R-8b** | No no-show sweep job | Unchanged |
| **R-8d** | No correction path once quality is recorded (conflicts with §15.1) | Unchanged |
| **R-8g** | MSP rates not independently cross-checked, yet drive payment amounts | Unchanged — **still the highest-value open item** |
| **R-7a** | 7-digit booking-code space; mitigated by ownership and scope | Unchanged |
| **R-7c** | Integration tests require a freshly provisioned database | Unchanged |
| **R-L** | `origin/faramqueue-feature` unmerged and conflicting with `main` | Unchanged since Phase 4 |

---

## 31. Deferred work

| Item | Blocked on |
|---|---|
| `APPROACHING` display status | A threshold migration **and an approved value** |
| Historical service-time model | Lookback window, minimum sample, grouping, outlier rule |
| In-process memo (`QUEUE_CACHE_TTL_SECONDS`) | A measured performance need |
| `queue_projections` snapshot | Same |
| Queue-recompute worker, `QUEUE_APPROACHING` / `TURN_APPROACHING` notifications | Phase 10 |
| SSE / WebSocket push | Nothing — the payload is already transport-agnostic (§14.5) |
| Frontend integration | Phase 15 |

---

## 32. What was NOT implemented — explicit statement

Stated plainly so nothing is assumed present:

- **No `displayStatus: "APPROACHING"`** — no configured threshold exists. This
  is the phase's one stop-condition, reported rather than resolved by guessing.
- **No migration.** No table, column, index, constraint or trigger created,
  altered or dropped. No existing constraint weakened.
- **No stored queue position.** Nothing derived was persisted.
- **No new permission and no grant change.**
- **No new audit action.**
- **No queue mutation endpoint**, no reordering, no priority, no override.
- **No notifications, SMS, push, payment disbursal, reports or analytics.**
- **No caching, memoisation or snapshot table.**
- **No worker or scheduled job.**
- **No historical averaging, no fixed service duration, no productivity
  assumption, no lane-balancing rule, no capacity assumption, no government
  operating policy.**
- **No government data created, read for interpretation, or verified.**
- **No frontend file modified.**
- **No Phase 8 documentation edited**, including the known permission-count
  wording discrepancy.
- **No Phase 10 work begun.**

---

## Phase Completion Report

**IMPLEMENTED:** A deterministic, derived queue model and an evidence-based ETA
across two read endpoints, a pure projection engine, and per-lane cursors — with
position, ETA and confidence kept as separate, separately-nullable concepts.

**TESTS:** **226/226 pass** overall (was 174); **52/52** for Phase 9 (23 pure +
29 integration, including a 300-case invariant property test). **50/50** SQL
probes. `tsc --noEmit` clean. Static checker passed. 40 routes protected.

**FAILED TESTS:** One on the first Phase 9 run — a real defect in this phase's
code (a farmer locked out of their own stale booking by centre-configuration
resolution order), diagnosed, fixed without a hidden fallback, and covered by
two regression tests. Details in §23.

**MIGRATIONS:** None.

**DESIGN CHANGES:** None to the Phase 9 design contract. Six documented
deviations from architecture §14, all recorded in §23 with reasons.

**NEXT PHASE:** Phase 10 — notifications, which is what §16.4's thresholds and
§14.4's recompute worker exist for, and which would also give
`APPROACHING` a home. **Before that, R-8g (independent MSP cross-check) remains
the highest-value open item, because payment amounts already depend on it.**

**STOP.** Awaiting approval.
