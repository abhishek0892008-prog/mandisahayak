# FarmQueue — Phase 9: Queue and ETA Engine

**Status:** design document, written **before** implementation as required
**Date:** 2026-09-02
**Governing contract:** `docs/architecture.md` **§14 (Queue and ETA architecture)**, §13.5 (D-4), P-1, P-3
**Scope:** live queue projection, queue position, ETA where evidence supports it, farmer and officer read endpoints.
**Not in scope:** notifications, SMS, thresholds that trigger them, the queue-recompute worker job, payment disbursal, reports, analytics, frontend.

---

## 0. One stop-condition, reported rather than guessed

Architecture §13.5 (D-4) defines `APPROACHING` as *"Derived from live queue position/ETA against **the configured threshold**"*, and §16.4 names two thresholds — `approaching_position_threshold` and `turn_threshold_minutes` — stating *"Thresholds are configuration, not constants, and live with the centre/queue configuration."*

**Those thresholds do not exist.** Verified against the live schema:

```sql
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='public'
   AND (column_name ILIKE '%threshold%' OR column_name ILIKE '%approach%');
-- (0 rows)
```

`centre_slot_configurations` has no threshold column, and there is no queue-configuration table.

**Consequence: Phase 9 does not implement `displayStatus: "APPROACHING"`.** Deriving it would require choosing a threshold value, and no approved source specifies one. Inventing "position ≤ 3" or "wait ≤ 15 minutes" would be fabricating operational policy, which §5 of the phase brief forbids.

`displayStatus` therefore continues to map exactly as Phases 7–8 already ship it (`CONFIRMED`→`BOOKED`, `ARRIVED`→`WAITING`, otherwise the canonical status). **This is a deliberate non-implementation, recorded in §14 and in the phase report, not an oversight.** What would unblock it is stated in §14.1.

---

## 1. What Phase 9 is, and the three things it must not conflate

The phase brief states them, and this design keeps them apart in the response contract itself:

```
QUEUE POSITION  ≠  ETA
QUEUE POSITION  ≠  GUARANTEED SERVICE TIME
ETA             ≠  PROMISE
```

- **Position** is an ordinal derived from committed records. It is knowable exactly.
- **ETA** is a projection. It is knowable only when evidence supports it, and carries an explicit confidence.
- **Neither is a commitment.** Nothing in the response is phrased as one, and the ETA always travels with the basis it was computed from.

---

## 2. Derived, never stored (P-1, §14.1)

> *"There is no `farmers_ahead = 17` column. Queue position and ETA are projections computed from authoritative data."* — §14.1

**Phase 9 writes no migration and stores no queue state.** Position and ETA are computed per request from:

| Input | Source | Authority |
|---|---|---|
| lane, token, scheduled window, quantity-derived durations | `bookings` | committed reservation |
| actual arrival / service start / service end | `procurements` | recorded by officers (Phase 8) |
| minimum processing floor, transition buffer | `centre_slot_configurations` | CONFIGURED |
| active lanes | `centre_service_lanes` | CONFIGURED |
| the clock | server `now()` | — |

If this projection were dropped entirely, nothing would be lost. That is the test of a derived value, and it passes.

**`queue_projections` is NOT created.** §14.4 says it *"may be persisted as a snapshot … It is a cache, never an authority."* A cache with no measured load problem is a second source of truth waiting to drift, so it is deferred (§14.3).

---

## 3. Queue membership — answering (E), (F), (G)

### 3.1 Membership is decided by TIMESTAMPS, not by status

Status and timestamps agree today, but the timestamps are the physical facts and the status is a label. Membership keys off `procurements.service_started_at` / `service_ended_at`, and a test asserts the two never disagree.

| Booking status | `service_started_at` | `service_ended_at` | In queue? | Queue state |
|---|---|---|---|---|
| `CONFIRMED` | NULL | NULL | **YES** | `WAITING` — booked, not yet arrived |
| `ARRIVED` | NULL | NULL | **YES** | `WAITING` — at the centre, lane not yet started |
| `WEIGHING` | set | NULL | **YES** | `IN_SERVICE` |
| `QUALITY_CHECK` | set | NULL | **YES** | `IN_SERVICE` |
| `PROCUREMENT_RECORDED` | set | NULL | **YES** | `IN_SERVICE` |
| `PAYMENT_PENDING` | set | **set** | **NO** | `SERVICE_COMPLETE` |
| `COMPLETED` | set | set | **NO** | terminal |
| `CANCELLED` | any | any | **NO** | terminal |
| `NO_SHOW` | NULL | NULL | **NO** | terminal |

### 3.2 Why `PAYMENT_PENDING` leaves the queue

`PAYMENT_PENDING` is in the six-status *active* set used by the lane exclusion constraints and by capacity accounting — Phase 7 and 8 correctly treat it as an active booking.

**It is not in the physical queue.** `complete` sets `service_ended_at`; the produce has been weighed, graded and recorded, and the farmer is waiting on payment paperwork, not on a lane. Counting them as "ahead of you" would inflate every downstream farmer's wait with work that is already finished.

**This is a deliberate refinement of §14.2**, which says only *"skip if b.status ∈ {CANCELLED, NO_SHOW, COMPLETED}"*. Recorded as a documented deviation (§14.2 of this document), because a booking that has finished being served must not occupy a lane in a projection whose entire purpose is predicting lane availability.

### 3.3 What removes a booking from the queue (G)

Exactly four events, all of them existing Phase 7/8 transitions — Phase 9 adds none:

1. `complete` (sets `service_ended_at`, → `PAYMENT_PENDING`)
2. farmer cancellation (→ `CANCELLED`)
3. officer cancellation at the centre (→ `CANCELLED`)
4. no-show (→ `NO_SHOW`)

Because membership is a query predicate, removal is immediate and atomic with the transaction that caused it. There is no queue to "update".

---

## 4. Ordering — answering (A), (B), (D), (H), (I), (J)

### 4.1 The ordering rule

**Primary ordering is `scheduled_start_at`**, exactly as §14.2 specifies: *"over active bookings ordered by `scheduled_start_at`"*.

Not booking-creation order (a later booking may hold an earlier window), not token order (tokens are allocated in creation order, not service order), not arrival order (arriving early does not buy an earlier turn — the reservation does).

**Projection order** is `(scheduled_start_at, lane_no, token_number)`. The last two are tie-breakers that make the order **total and deterministic**: `token_number` is unique per centre-day (allocated as `MAX+1` under the daily-capacity lock), so no two members can tie. Determinism is asserted by test — the same committed state produces byte-identical output.

### 4.2 "Ahead of me" (A) — two distinct, separately-labelled answers

With multiple lanes a single number is misleading, so the response carries both and names them:

| Field | Meaning |
|---|---|
| `aheadAtCentre` | How many queue members will be served before me **anywhere at this centre**, ordered by projected start |
| `aheadOnLane` | How many are before me **on my own lane** |

`aheadOnLane` is what actually predicts my wait, because I am served on the lane my booking reserved. `aheadAtCentre` is what a farmer means by "how many people are in front of me". Reporting only the first would be misleading; reporting only the second would answer a question nobody asked.

`queuePosition` = `aheadAtCentre + 1`, centre-wide and 1-based, matching §14.5's contract field.

### 4.3 Multiple lanes (C), and cross-lane comparison (D)

**The stored `lane_no` is authoritative.** It was assigned at booking time by the Phase 7 scheduler and is enforced by `bookings_no_lane_overlap`. The projection **does not reassign lanes**.

§14.2 says *"With multiple lanes the cursor is per-lane and the next booking is assigned to the earliest-free lane."* That sentence describes the **scheduling** engine's lane choice at booking time (Phase 7, already shipped). Re-deciding it inside a read-only projection would produce a forecast contradicting the reservation the database is actually enforcing. **The projection therefore keeps one cursor per lane and advances each booking on its own lane.** Recorded as a documented interpretation (§14.2 of this document).

**(D) — can a booking in one lane be compared with one in another?** For *ordering*, yes: both have a projected start on the same clock, so a centre-wide ordinal is well-defined. For *wait prediction*, no: two bookings at the same centre-wide position on different lanes can have very different waits, which is precisely why `aheadOnLane` exists as its own field.

### 4.4 (I) Manual reordering — none

**No endpoint alters queue order, and none is designed.** Queue order is a pure function of committed records. There is no reorder, no bump, no priority flag and no override.

Consequence for audit: see §9.

### 4.5 (J) Priority bookings — none

**No priority concept exists in the approved requirements, the schema, or the brief. None is invented.** There is no priority column, no seniority rule, no emergency lane. Every queue member is ordered by the same rule.

---

## 5. The projection algorithm (`engines/queue.ts`, PURE)

Implements §14.2 with the two documented refinements (§4.3, §3.2) and one precision fix (§5.2).

```
input:  members (one centre, one service_date), now, config{minimumProcessingMinutes, transitionBufferMinutes}
sort:   by (scheduledStartAt, laneNo, tokenNumber)
laneFreeAt: Map<laneNo, Date> = {}          // empty = lane free now

for each member m in sorted order:
    if m.serviceStartedAt != null and m.serviceEndedAt == null:      // IN_SERVICE
        elapsed   = minutesBetween(m.serviceStartedAt, now)
        remaining = max(configured minimumProcessingMinutes,
                        m.processingMinutes - elapsed)
        m.projectedStartAt   = m.serviceStartedAt                     // an observed FACT
        m.projectedEndAt     = now + remaining
        m.confidence         = OBSERVED
    else:                                                             // WAITING
        m.projectedStartAt   = max(m.scheduledStartAt,
                                   laneFreeAt[m.laneNo] ?? now)
        m.projectedEndAt     = m.projectedStartAt + m.processingMinutes
        m.confidence         = PROJECTED | SCHEDULED                  // §6.2

    laneFreeAt[m.laneNo] = m.projectedEndAt + transitionBufferMinutes // §5.2

    m.waitMinutes = max(0, minutesBetween(now, m.projectedStartAt))

position ordering = by (projectedStartAt, laneNo, tokenNumber)
queuePosition  = 1-based index in that ordering
aheadAtCentre  = queuePosition - 1
aheadOnLane    = count of members on the same lane ordered before me
```

### 5.1 Every input is evidence, not an assumption

- `m.processingMinutes` is `bookings.estimated_processing_minutes`, **computed and stored at booking time** from that booking's own quantity and the centre's configured reference rate (Phase 7). It is not a fixed per-farmer or per-tonne constant, and a 5 000 kg booking genuinely projects longer than a 2 500 kg one at the same centre.
- `minimumProcessingMinutes` is `centre_slot_configurations.minimum_processing_minutes` — §14.2's *"configured_minimum"*. It is the floor on remaining time for an in-progress booking, so an overrunning service never projects a negative or zero remainder.
- `transitionBufferMinutes` is the configured vehicle-clearance gap already used by the Phase 7 scheduler.
- `serviceStartedAt` is a database `now()` recorded by an officer. No client supplies it.

**No average, no historical mean, no productivity assumption, and no fixed duration is used anywhere.** See §7.

### 5.2 Precision fix: service end and lane-free are two different instants

§14.2 sets `projected_end = projected_start + occupancy_minutes` and then `cursor = projected_end`. `occupancy = processing + buffer`, so that single value conflates:

- when **this farmer's** produce is finished being handled, and
- when the **lane** becomes available to the next farmer.

Phase 7's shipped API already separates these (`processingEndAt` vs `windowEndAt`). Phase 9 keeps that separation: `projectedEndAt` is the farmer's service end (`+ processingMinutes`), and the lane cursor advances by a further `transitionBufferMinutes`.

**This changes no arithmetic for the next farmer** — the cursor still advances by `processing + buffer` in total — but it stops telling a farmer their handling ends fifteen minutes after it does. Recorded as a documented refinement.

### 5.3 Dynamic behaviour falls out, exactly as §14.3 requires

| Event | Effect, with no special-casing |
|---|---|
| Farmer finishes early | `service_ended_at` is set, they leave the queue, the lane cursor is not advanced by them; everyone behind moves earlier |
| Farmer overruns | `remaining` floors at the configured minimum and `projectedEnd = now + remaining` keeps sliding forward; downstream shifts later |
| Cancellation / no-show | The row fails the membership predicate; everyone behind moves up |
| Larger/smaller quantity | `processingMinutes` differs per booking |
| A lane is idle | Its cursor is unset, so its next booking starts at `max(scheduled, now)` |

---

## 6. ETA — evidence-based, with explicit confidence (brief §4)

### 6.1 The system distinguishes four outcomes

| `etaConfidence` | Meaning | Evidence |
|---|---|---|
| `OBSERVED` | The booking is being served **now**. Start is a recorded fact; end is that fact plus configured remaining time | `service_started_at` |
| `PROJECTED` | Service date is **today**. The lane cursor incorporates real arrivals and real service timestamps upstream | live `procurements` rows |
| `SCHEDULED` | Service date is in the **future**. No live signal exists yet, so the reservation window is the honest statement — explicitly *not* a live estimate | `bookings` only |
| `UNAVAILABLE` | No defensible estimate exists. `etaUnavailableReason` says which case | — |

`SCHEDULED` exists because labelling a future-dated booking `PROJECTED` would claim live evidence that has not been recorded yet. The number may be identical to the reservation; the *claim* about it is not.

### 6.2 `UNAVAILABLE` reasons — a reason, never a misleading number

When ETA is unavailable, `estimatedStartAt`, `estimatedEndAt` and `estimatedWaitMinutes` are all **`null`**. Never `0`, never a placeholder.

| Reason | When |
|---|---|
| `BOOKING_NOT_ACTIVE` | `CANCELLED`, `NO_SHOW` or `COMPLETED` |
| `SERVICE_COMPLETE` | `PAYMENT_PENDING` — handling finished; nothing left to wait for |
| `SERVICE_DATE_PAST` | Service date is before today at the centre, yet the booking is still `CONFIRMED`/`ARRIVED` |

`SERVICE_DATE_PAST` is not hypothetical: **R-8b** (Phase 8) records that no no-show sweep job exists, so a booking whose day has passed can sit `CONFIRMED` indefinitely. Projecting a queue position for it would be fabricating. The system says it cannot estimate, and why.

### 6.3 What is deliberately NOT used as evidence

**Historical completed procurements are not used**, although `service_started_at`/`service_ended_at` make an empirical mean computable.

Using one would require choosing a lookback window, a minimum sample size, a grouping (per centre? per crop? per lane? per officer?), and an outlier rule. **None of those is specified by any approved requirement**, and each is an operational policy decision. At demonstration scale the sample is also near zero. Implementing it would mean inventing four policies to replace a value the system already derives honestly from configuration.

Recorded as deferred work (§14.3) with the exact inputs that would be required.

---

## 7. Values this phase does NOT invent (brief §5)

Explicitly, none of the following exists in Phase 9 code:

- average or historical service duration
- fixed minutes per farmer, per quintal or per tonne
- officer productivity assumptions
- lane-balancing or re-assignment rules
- priority, seniority or emergency handling
- capacity assumptions beyond the CONFIGURED slot configuration
- any government operating policy

**One new configuration parameter is introduced**, and it is operational rather than governmental:

| Key | Default | Classification | Source of the default |
|---|---|---|---|
| `QUEUE_POLL_AFTER_SECONDS` | `5` | **CONFIGURED** | Architecture §14.4 (`QUEUE_CACHE_TTL_SECONDS` default 5) and the §14.5 polling contract |

It controls only the `pollAfterSeconds` hint the server returns, so cadence is a server-side operational decision and is never hardcoded in the UI (§14.5). It is **not** labelled OFFICIAL, is not government data, and changes no computed value.

---

## 8. Data classification (brief §6)

Unchanged. Phase 9 **creates no data of any kind** and requires **no government source**.

| Class | Touched by Phase 9 |
|---|---|
| **OFFICIAL** | MSP rates — read by neither queue nor ETA. Untouched |
| **CONFIGURED** | Slot configuration, lanes, operating hours, the five `DEMO-UP-*` centres — **read only** |
| **TEST** | Bookings and procurements created by the suite |

No centre capacity is inferred from national or state data. Demonstration centres remain `CONFIGURED`. No `verified_at` is set anywhere.

---

## 9. Audit (brief §13)

**Phase 9 adds no audit actions.**

Two reasons, both structural:

1. **These are reads.** The existing architecture audits state changes, authorization denials and rate-limit rejections — not reads. A queue endpoint polled every five seconds by every waiting farmer would write tens of thousands of rows a day into `audit_logs`, which is append-only and retained for seven years (§21 A-5). That would degrade the audit log's value as a record of *decisions*.
2. **There is nothing to audit.** Queue order is derived and immutable from source records (§4.4). No actor can alter it. Every event that changes the queue is a Phase 7/8 transition **already audited** at the point it occurs, and `booking_status_history` already carries the full ordered trail.

Unchanged and still in force: authorization denials on the new routes are audited by `requirePermission`, and rate-limit rejections are audited.

**A poll never mutates state and never sends a notification** — §14.5 requires this as *"an explicit, tested invariant"*, and Phase 9 tests it directly (§12, category Q).

---

## 10. Rate limiting (brief §14)

### 10.1 Threat model

The queue endpoints are authenticated, ownership-scoped and centre-scoped. A farmer can read only their own booking, and an unknown or foreign booking code returns `404` identically — so these are **not** enumeration oracles, and the risk is not information disclosure.

The real risk is **resource exhaustion**: the server itself advertises a 5-second poll cadence, so a compliant client is a high-frequency client, and a misbehaving or looping client is indistinguishable from one until it is counted.

### 10.2 Limits derived from the advertised cadence, not picked

A 15-minute window is 900 seconds. At the advertised `pollAfterSeconds = 5`, one compliant client issues **180 requests per window**.

| Rule | Limit / 15 min | Headroom vs compliant client | Subject |
|---|---|---|---|
| `QUEUE_READ_PER_SESSION` | **400** | 2.2× | session |
| `OFFICER_QUEUE_PER_SESSION` | **900** | 5× | session |

Farmers and officers are limited **separately and deliberately**: an officer dashboard legitimately polls a whole centre, may be open on several screens at one centre, and blocking it would stop the centre working. Neither limit can be reached by a client obeying `pollAfterSeconds`, which is the design requirement — the limit must bound abuse without ever making the system unusable.

**No existing limit is weakened or reused.** Both are new buckets.

---

## 11. API contract (brief §11, §12)

### 11.1 Endpoints — only what the contract justifies

| Method | Path | Permission | Actor |
|---|---|---|---|
| GET | `/api/v1/bookings/:bookingCode/queue` | `queue.read.own` | farmer |
| GET | `/api/v1/officer/centres/:centreId/queue` | `queue.read.centre` | officer, admin |

Both permissions **already exist and are already granted** (`queue.read.own` → FARMER; `queue.read.centre` → OFFICER, ADMIN). Phase 9 adds no permission, changes no grant, and does not give admins any operational officer permission.

Deliberately **not** created: a bare `/queue` listing, a queue-position-only endpoint, a separate ETA endpoint, any queue mutation endpoint. Each would be a second way to ask the same question, or a capability nothing requires.

**Route ordering.** `/bookings/:bookingCode/queue` is three segments and cannot collide with `/bookings/me` (two) or `/bookings/:bookingCode` (two). The officer route sits under `/officer/centres/:centreId/`, disjoint from `/officer/bookings/search`. Asserted by test.

**Addressing.** The farmer route uses the public `FQ-YYYY-NNNNNNN` booking code. The officer route uses `:centreId`, consistent with `/officer/centres/:centreId/bookings` shipped in Phase 8. **No response contains a UUID**, asserted by test.

### 11.2 Farmer response — every concept separately named

```jsonc
{
  "bookingCode": "FQ-2026-1234567",
  "tokenNumber": 42,
  "status": "ARRIVED",                  // canonical lifecycle status
  "displayStatus": "WAITING",           // D-4 derived label
  "queueState": "WAITING",              // WAITING | IN_SERVICE | NOT_IN_QUEUE
  "inQueue": true,

  "queuePosition": 5,                   // centre-wide, 1-based, null if not in queue
  "aheadAtCentre": 4,
  "aheadOnLane": 1,                     // what actually predicts my wait
  "activeQueueSize": 11,                // members at this centre-day
  "laneNo": 2,
  "laneCount": 2,
  "currentlyServingToken": 38,          // on MY lane; null if that lane is idle

  "estimatedStartAt": "2026-03-12T05:10:00Z",
  "estimatedEndAt":   "2026-03-12T06:25:00Z",
  "estimatedWaitMinutes": 35,
  "etaConfidence": "PROJECTED",         // OBSERVED | PROJECTED | SCHEDULED | UNAVAILABLE
  "etaUnavailableReason": null,
  "etaBasis": "Configured processing time for this booking's quantity, advanced along this lane by observed service timestamps.",

  "scheduledStartAt": "2026-03-12T05:00:00Z",   // the reservation, for comparison
  "serviceDate": "2026-03-12",
  "centreTimezone": "Asia/Kolkata",
  "observedAt": "2026-03-12T04:35:02Z",         // committed state this reflects
  "serverTime": "2026-03-12T04:35:02Z",
  "pollAfterSeconds": 5
}
```

- **Position and ETA are separate fields with separate nullability.** A booking can have a position and no ETA (`SERVICE_DATE_PAST` cannot happen with a position — but `queuePosition` is null there too and both say so independently).
- **`observedAt` is the freshness statement (L).** It is the instant the projection was computed from committed state. Because there is no cache (§14.3), `observedAt` always equals `serverTime`; the field exists so that adding a snapshot later is not a contract change.
- **`etaBasis`** is a short human-readable statement of what the number was computed from. It is not the machine contract — `etaConfidence` is — but it makes an ETA explicable to whoever has to defend it.
- `currentlyServingToken` is scoped to **the farmer's own lane**. §14.5 shows a single scalar; at a multi-lane centre a single centre-wide "currently serving" token is factually wrong. Recorded as a documented interpretation (§14.2 of this doc).

### 11.3 Officer response

Per-lane operational view plus the ordered queue:

```jsonc
{
  "centreCode": "DEMO-UP-MATHURA-01",
  "serviceDate": "2026-03-12",
  "centreTimezone": "Asia/Kolkata",
  "activeQueueSize": 11,
  "lanes": [
    { "laneNo": 1, "nowServing": { "tokenNumber": 38, "bookingCode": "…", "projectedEndAt": "…" },
      "next": { "tokenNumber": 41, "bookingCode": "…", "projectedStartAt": "…" }, "waitingCount": 5 },
    { "laneNo": 2, "nowServing": null, "next": { … }, "waitingCount": 6 }
  ],
  "queue": [ /* ordered members, each with position, lane, queueState, projections */ ],
  "observedAt": "…", "serverTime": "…", "pollAfterSeconds": 5
}
```

`nowServing` / `next` answer "what is the current and next operational work", which is the officer requirement. The officer view **does** carry farmer name and phone — as `/officer/centres/:centreId/bookings` already does — because an officer calling the next farmer needs to identify them. It is centre-scoped in SQL.

---

## 12. Test plan (brief §15, §16)

Pure tests carry the algorithm; integration tests carry everything that only exists end to end.

**Pure** (`engines/queue.ts` — no database, injected clock):

| Category | Cases |
|---|---|
| A ordering | scheduled-start order; tie-break determinism; identical input → identical output |
| C/D multi-lane | independent lane cursors; same centre position, different lane waits; idle lane |
| E lifecycle | every one of the nine statuses mapped to membership |
| I ETA | early finish pulls downstream in; overrun pushes out; minimum-processing floor binds; quantity changes duration |
| B/H membership | terminal excluded; `PAYMENT_PENDING` excluded; in-service included |
| **Invariants (§16)** | over generated states: no duplicate position, no position < 1, no gap in the sequence, no terminal member, position order agrees with projected-start order, no negative wait, `aheadOnLane ≤ aheadAtCentre` |

**Integration** (real HTTP, real PostgreSQL):

| Category | Cases |
|---|---|
| E ownership | another farmer's code → `404`, identical to a nonexistent code |
| F centre scope | officer at another centre → `404` on the queue |
| G RBAC | farmer refused the officer queue; officer refused the farmer route; admin retains read, gains no operational permission |
| H terminal removal | cancel / no-show / complete each remove the member and move everyone behind up |
| J ETA unavailable | `PAYMENT_PENDING`, `CANCELLED`, `NO_SHOW`, `COMPLETED`, past-dated — all `null` ETA with a reason, never `0` |
| K read consistency | repeated reads of unchanged state are identical; a read during another booking's transition never shows a half-applied state |
| L/M concurrency | two arrivals at once; two officers on different bookings; two officers on the same booking; completion/cancellation/no-show racing a queue read; multiple lanes progressing together |
| N invalid input | malformed code, unknown code, bad date, bad centre id |
| O UUID leakage | no UUID in either response |
| P rate limiting | the new buckets fire; a client obeying `pollAfterSeconds` never trips them |
| Q audit | **a poll writes no audit row and mutates nothing** — §14.5's required invariant |

Every business rule gets a normal case, a boundary case and an adversarial case.

---

## 13. Files

```
server/src/
  engines/queue.ts                     PURE — projection, position, ETA, confidence
  modules/queue/
    queue.repository.ts                SQL — one query per (centre, service_date), scoped
    queue.service.ts                   assembly, ownership, scope, view mapping
    queue.routes.ts                    HTTP, permissions, rate limits
  core/config.ts                       + QUEUE_POLL_AFTER_SECONDS
  core/rateLimit.ts                    + 2 rules
server/tests/queue.test.ts
docs/api/queue.md
```

Reused, not forked: `BOOKING_SELECT`, `ACTIVE_STATUSES`, `localDateOf`, `CentreContext`, `actorMayActOnCentre`, `displayStatusFor`. **No migration.**

---

## 14. Deviations, deferrals and risks declared up front

### 14.1 Not implemented, with the reason

| Item | Why | What would unblock it |
|---|---|---|
| `displayStatus: "APPROACHING"` | No threshold configuration exists anywhere in the schema (§0) | A migration adding `approaching_position_threshold` / `turn_threshold_minutes` to centre configuration, **and an approved value or an explicit "operator sets this" decision** |
| Historical/empirical service times | Requires four unspecified policies (§6.3) | Approved lookback window, minimum sample, grouping and outlier rule |
| `queue_projections` snapshot table | §14.4 makes it optional; a cache with no measured load problem is a second source of truth | A measured performance need |
| In-process memoisation (`QUEUE_CACHE_TTL_SECONDS`) | Adds a staleness and invalidation surface that would need its own test matrix, against "queue state reflects committed database state only" | Same |
| Queue-recompute worker + `QUEUE_APPROACHING`/`TURN_APPROACHING` notifications | Notifications are explicitly out of Phase 9 scope | Phase 10 |

### 14.2 Documented deviations from architecture §14

| # | §14 says | Phase 9 does | Why |
|---|---|---|---|
| 1 | Skip only `{CANCELLED, NO_SHOW, COMPLETED}` | Also excludes `PAYMENT_PENDING` | Its `service_ended_at` is set; it occupies no lane and would inflate every downstream wait (§3.2) |
| 2 | *"the next booking is assigned to the earliest-free lane"* | Keeps the stored `lane_no`; one cursor per lane | Reassigning in a read-only projection would contradict the reservation the exclusion constraint enforces (§4.3) |
| 3 | `projected_end = start + occupancy`; `cursor = projected_end` | `projectedEndAt = start + processing`; cursor advances a further `buffer` | Separates the farmer's service end from lane-free, matching Phase 7's shipped `processingEndAt`/`windowEndAt` (§5.2) |
| 4 | Single scalar `currentlyServingToken` | Scoped to the farmer's own lane; officers get the per-lane list | A single centre-wide value is factually wrong at a multi-lane centre (§11.2) |
| 5 | `GET /officer/queue?centreId=&date=` (§18) | `GET /officer/centres/:centreId/queue` | Consistency with `/officer/centres/:centreId/bookings` shipped in Phase 8 |

### 14.3 Risks carried in

| | Risk |
|---|---|
| **R-9a** | ETA quality depends on `estimated_processing_minutes`, which is a *configured* rate, never measured against reality. It is honest and evidence-linked, but it is a plan, not an observation |
| **R-9b** | No memoisation; every poll recomputes one centre-day. Correct, and unmeasured under load |
| **R-9c** | `SERVICE_DATE_PAST` exists only because R-8b (no no-show sweep) leaves stale bookings behind. Phase 9 reports the condition; it does not fix the cause |
| **R-9d** | `APPROACHING` remains underivable until thresholds are configured (§0) |

**STOP after the report. No implementation begins until this document is written — it now is.**
