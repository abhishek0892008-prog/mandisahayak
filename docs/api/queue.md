# Mandi Sahayak — Queue and ETA API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phase 9)
**Base path:** `/api/v1`
**Companion:** [`authentication.md`](./authentication.md) — cookies, CSRF, error envelope
**Companion:** [`officer.md`](./officer.md) — the transitions that move the queue
**Design contract:** [`../phase-9-queue-eta.md`](../phase-9-queue-eta.md)
**Governing architecture:** `architecture.md` §14

> Every rule below is enforced by code and covered by the 52 Phase 9 tests.

---

## 1. Endpoints

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/bookings/:bookingCode/queue` | `queue.read.own` | — |
| GET | `/officer/centres/:centreId/queue?date=` | `queue.read.centre` | — |

Both are reads. **There is no mutating queue endpoint and there will not be
one**: queue order is a pure function of committed booking and procurement
records, so there is nothing an endpoint could reorder (§5).

Both permissions already existed and were already granted. Phase 9 adds no
permission and changes no grant.

---

## 2. Three concepts, never collapsed

```
QUEUE POSITION  ≠  ETA
QUEUE POSITION  ≠  GUARANTEED SERVICE TIME
ETA             ≠  PROMISE
```

- **Position** is an ordinal derived from committed records. Exact.
- **ETA** is a projection, and always travels with `etaConfidence` saying what
  it was computed from.
- **Neither is a commitment.** Nothing in either response is phrased as one.

They are separate fields with separate nullability. A booking can have a
position and no ETA. Neither is ever encoded as the other.

---

## 3. Who is in the queue

Membership is decided by the **procurement timestamps**, not the status label —
the timestamps are the physical facts.

| Status | `service_started_at` | `service_ended_at` | `queueState` |
|---|---|---|---|
| `CONFIRMED` | — | — | `WAITING` |
| `ARRIVED` | — | — | `WAITING` |
| `WEIGHING` | set | — | `IN_SERVICE` |
| `QUALITY_CHECK` | set | — | `IN_SERVICE` |
| `PROCUREMENT_RECORDED` | set | — | `IN_SERVICE` |
| `PAYMENT_PENDING` | set | **set** | `NOT_IN_QUEUE` |
| `COMPLETED` | set | set | `NOT_IN_QUEUE` |
| `CANCELLED` / `NO_SHOW` | — | — | `NOT_IN_QUEUE` |

**`PAYMENT_PENDING` leaves the queue** even though it is still an *active*
booking for the lane exclusion constraint and daily capacity. Its produce has
been handled; the farmer is waiting on payment paperwork, not on a lane.
Counting it would inflate every downstream farmer's wait with finished work.

Four events remove a member, all of them existing Phase 7/8 transitions:
`complete`, farmer cancellation, officer cancellation, no-show. Removal is
immediate and atomic with the transaction that caused it, because membership is
a query predicate rather than stored state.

---

## 4. Ordering

**Primary order is `scheduled_start_at`** — the reserved window. Not creation
order, not token order, not arrival order: arriving early does not buy an
earlier turn.

Ties break by `(lane_no, token_number)`, which makes the order **total and
deterministic**. `token_number` is unique per centre-day, so no two members can
tie on all three keys. The same committed state always produces the same output,
and this is asserted by test.

Position itself is assigned by **projected** start, which diverges from
scheduled start once a lane runs late — a free lane is genuinely served before a
backed-up one, and the position says so.

### 4.1 Two "ahead of me" numbers, because one would mislead

| Field | Meaning |
|---|---|
| `aheadAtCentre` | Served before me **anywhere at this centre** |
| `aheadOnLane` | Served before me **on my own lane** |

`aheadOnLane` is what predicts my wait — I am served on the lane my booking
reserved. `aheadAtCentre` is what a farmer means by "how many people are in
front of me". Two bookings at the same centre-wide position on different lanes
can have very different waits, which is exactly why both are reported.

`queuePosition` = `aheadAtCentre + 1`.

### 4.2 Lanes are not reassigned

The stored `lane_no`, assigned by the Phase 7 scheduler and enforced by
`bookings_no_lane_overlap`, is authoritative. The projection keeps one cursor
per lane and never moves a booking to an idle one — a forecast that contradicted
the reservation the database is enforcing would be worse than useless.

### 4.3 No manual reordering, no priority

There is **no reorder, no bump, no priority flag and no override**. No priority
concept exists in the approved requirements, the schema or the brief, and none
was invented. Every member is ordered by the same rule.

---

## 5. `GET /bookings/:bookingCode/queue`

Ownership is resolved inside the query. Another farmer's code returns `404`,
byte-identical to a code that does not exist — asserted by test. There is no
`farmerId` parameter to supply; identity comes from the session.

```jsonc
{
  "bookingCode": "FQ-2026-1234567",
  "tokenNumber": 42,
  "status": "ARRIVED",
  "displayStatus": "WAITING",
  "queueState": "WAITING",
  "inQueue": true,

  "queuePosition": 5,
  "aheadAtCentre": 4,
  "aheadOnLane": 1,
  "activeQueueSize": 11,
  "laneNo": 2,
  "laneCount": 3,
  "currentlyServingToken": 38,

  "estimatedStartAt": "2026-03-12T05:10:00Z",
  "estimatedEndAt": "2026-03-12T06:25:00Z",
  "estimatedWaitMinutes": 35,
  "etaConfidence": "PROJECTED",
  "etaUnavailableReason": null,
  "etaBasis": "Configured processing time for this booking's quantity, …",

  "scheduledStartAt": "2026-03-12T05:00:00Z",
  "serviceDate": "2026-03-12",
  "centreTimezone": "Asia/Kolkata",
  "observedAt": "2026-03-12T04:35:02Z",
  "serverTime": "2026-03-12T04:35:02Z",
  "pollAfterSeconds": 5
}
```

- `currentlyServingToken` is the token being served **on this farmer's lane**,
  or `null` if that lane is idle. A single centre-wide value would be factually
  wrong at a multi-lane centre.
- `estimatedEndAt` is when **this farmer's handling** finishes. The lane frees a
  further `transition_buffer_minutes` later, consistent with Phase 7's
  `processingEndAt` / `windowEndAt` distinction.
- `observedAt` is the freshness statement: the instant the committed state was
  read. Nothing is cached, so it always equals `serverTime`.
- `pollAfterSeconds` is **set by the server**, so cadence is an operational
  decision and is never hardcoded in the UI.

---

## 6. ETA — evidence, and the confidence to match

| `etaConfidence` | Meaning |
|---|---|
| `OBSERVED` | Being served now. The start is a **recorded fact**; the end is that fact plus the configured processing time less elapsed, floored at the configured minimum |
| `PROJECTED` | Service date is **today**. The lane cursor incorporates real arrivals and real service timestamps upstream |
| `SCHEDULED` | Service date is in the **future**. No arrival has been recorded, so this is the reservation and explicitly **not** a live estimate |
| `UNAVAILABLE` | No defensible estimate exists; see below |

### 6.1 When ETA is unavailable

`estimatedStartAt`, `estimatedEndAt` and `estimatedWaitMinutes` are **all
`null`. Never `0`, never a placeholder.** `queuePosition` is `null` too — an
ordinal in a queue that is not running would mislead as much as a fabricated
time.

| `etaUnavailableReason` | When |
|---|---|
| `BOOKING_NOT_ACTIVE` | `CANCELLED`, `NO_SHOW` or `COMPLETED` |
| `SERVICE_COMPLETE` | `PAYMENT_PENDING` — handling finished, nothing left to wait for |
| `SERVICE_DATE_PAST` | The service date has passed but the booking is still `CONFIRMED`/`ARRIVED` |
| `CENTRE_CONFIGURATION_UNAVAILABLE` | No slot configuration is in force on the service date, so the processing floor and transition buffer the projection needs do not exist |

`SERVICE_DATE_PAST` is reachable because **no no-show sweep job exists**
(Phase 8, R-8b), so a booking can outlive its day. The system says it cannot
estimate, and why.

`CENTRE_CONFIGURATION_UNAVAILABLE` is reported rather than silently substituting
another date's configuration. A projection built on the wrong numbers is worse
than no projection. In this case `activeQueueSize` is `null` as well — not a
misleading `0`.

### 6.2 What is deliberately NOT used

**No average, no historical mean, no fixed minutes per farmer or per tonne, no
officer productivity assumption, and no lane-balancing rule.**

Duration comes from `bookings.estimated_processing_minutes`, computed at booking
time from **that booking's own quantity** and the centre's configured reference
rate. A 5 000 kg booking genuinely projects longer than a 2 500 kg one at the
same centre.

Historical completed procurements are **not** used, although the timestamps make
an empirical mean computable. Doing so would require choosing a lookback window,
a minimum sample size, a grouping and an outlier rule — four operational
policies that no approved requirement specifies.

---

## 7. `GET /officer/centres/:centreId/queue`

`date` defaults to **today in the centre's timezone**, never the server's. A
centre outside the officer's assignments returns `404`, never `403`.

```jsonc
{
  "centreCode": "DEMO-UP-ALIGARH-01",
  "serviceDate": "2026-03-12",
  "centreTimezone": "Asia/Kolkata",
  "activeQueueSize": 11,
  "lanes": [
    { "laneNo": 1, "nowServing": { "bookingCode": "…", "tokenNumber": 38, … },
      "next": { "bookingCode": "…", "tokenNumber": 41, … }, "waitingCount": 5 },
    { "laneNo": 2, "nowServing": null, "next": { … }, "waitingCount": 6 },
    { "laneNo": 3, "nowServing": null, "next": null, "waitingCount": 0 }
  ],
  "queue": [ { "position": 1, "bookingCode": "…", "tokenNumber": 38, "laneNo": 1,
               "queueState": "IN_SERVICE", "farmer": { "name": "…", "phone": "…" }, … } ],
  "observedAt": "…", "serverTime": "…", "pollAfterSeconds": 5
}
```

- Every **configured** lane appears, including idle ones — an idle lane is
  operational information, not an absence.
- `nowServing` / `next` answer "what is the current and next work on this lane".
- The officer view carries farmer name and phone, exactly as
  `/officer/centres/:centreId/bookings` already does: an officer calling the
  next farmer has to be able to identify them. It is centre-scoped in SQL.
- A date with no configuration in force returns **`422 CENTRE_NOT_AVAILABLE`**.

---

## 8. A poll is a read

**A poll never mutates state and never sends a notification** — architecture
§14.5 requires this as an explicit, tested invariant, and Phase 9 tests it by
snapshotting `bookings`, `procurements`, `booking_status_history`, `audit_logs`
and `notifications` around ten polls and asserting nothing changed.

Consequently **successful polls are not audited**. Auditing a five-second poll
per waiting farmer would write tens of thousands of rows a day into an
append-only log retained for seven years, with no decision in any of them.
Authorization denials and rate-limit rejections on these routes remain audited,
as everywhere else.

---

## 9. Rate limiting

| Rule | Limit / 15 min | Subject |
|---|---|---|
| `queue_read_session` | 400 | session |
| `officer_queue_session` | 900 | session |

**Derived, not picked.** A 15-minute window is 900 seconds; at the advertised
`pollAfterSeconds = 5` one compliant client issues **180** requests per window.
400 gives a farmer 2.2× headroom (a refresh, a second tab, clock jitter); 900
gives an officer 5×, because a dashboard legitimately watches a whole centre
from more than one screen and blocking it would stop the centre working.

**No client obeying `pollAfterSeconds` can ever trip either limit** — that is
the design requirement, and it is asserted by test. Limits are per session, so
one farmer's exhausted bucket cannot affect another's. No existing limit was
weakened or reused.

Exceeding a limit returns `429 RATE_LIMITED` with `details.retryAfterSeconds`.

---

## 10. Errors

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Malformed booking code, centre id or date |
| `FORBIDDEN` | 403 | The role lacks the permission. Audited |
| `NOT_FOUND` | 404 | Unknown booking, **or** another farmer's booking, **or** a centre outside the officer's assignments — deliberately indistinguishable |
| `CENTRE_NOT_AVAILABLE` | 422 | Officer queue: no configuration in force on that date |
| `RATE_LIMITED` | 429 | See §9 |

---

## 11. What this API deliberately does not do

- **No `displayStatus: "APPROACHING"`.** D-4 defines it as derived "against the
  configured threshold", and **no threshold exists anywhere in the schema**.
  Choosing one would be inventing operational policy. `displayStatus` maps
  exactly as Phases 7–8 ship it.
- **No caching or memoisation.** Every response reflects committed state read at
  `observedAt`.
- **No persisted `queue_projections` snapshot.** §14.4 makes it optional; a
  cache with no measured load problem is a second source of truth waiting to
  drift.
- **No notifications, no SMS, no queue-recompute worker.** Phase 10.
- **No queue mutation of any kind.**
