# FarmQueue — Phase 7: Booking & Scheduling Engine

**Status:** design document, written **before** implementation as required
**Date:** 2026-09-02
**Scope:** availability search, booking creation, cancellation. **No** SMS, payment, procurement workflow, officer UI or frontend integration.

---

## 1. Why this is not "6 slots available"

The prototype models a day as fixed one-hour buckets each holding N farmers. That cannot represent this business: a 5 000 kg booking genuinely takes about twice as long as a 2 500 kg one, so a bucket either wastes capacity or overruns.

Capacity here is **time on a lane**. A booking consumes a quantity-dependent interval on exactly one lane at one centre, and two active bookings may never overlap on the same lane. Everything below follows from that.

---

## 2. Configuration is authoritative — nothing is hardcoded

Every number the engine uses comes from `centre_slot_configurations`, `centre_operating_hours`, `centre_holidays` and `centre_service_lanes`. The values currently configured (all `CONFIGURED` demonstration data, Phase 4):

| Centre | Lanes | Hours (Mon–Sat) | ref | min | max | buffer | granularity | horizon | cutoff |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|
| `DEMO-UP-ALIGARH-01` | 3 | 08:00–18:00 | 75 min / 2 500 kg | 30 | 180 | 15 | 15 | 7 d | 24 h |
| `DEMO-UP-AGRA-01` | 2 | 08:00–18:00 | 60 min / 2 500 kg | 30 | 180 | 15 | 15 | 7 d | 24 h |
| `DEMO-UP-HATHRAS-01` | 1 | **09:00–17:00** | 60 min / 2 500 kg | 30 | 180 | 15 | 15 | 7 d | 24 h |
| `DEMO-UP-MATHURA-01` | 2 | 08:00–18:00 | 60 min / 2 500 kg | 30 | 180 | 15 | 15 | 7 d | 24 h |
| `DEMO-UP-BULANDSHAHR-01` | 1 | 08:00–18:00 | 60 min / 2 500 kg | 30 | 180 | 15 | 15 | 7 d | 24 h |

`max_daily_processing_kg` is **NULL** everywhere — meaning *no configured daily ceiling*, not zero. Sunday (`day_of_week = 0`) has no row, which is how closure is expressed.

Change any of these rows and scheduler behaviour changes with no code edit. Hathras running 09:00–17:00 is not a special case in the engine; it is just its configuration.

---

## 3. Processing time — the exact implementation

```
ratio       = quantityKg / reference_quantity_kg
raw         = round(reference_processing_minutes × ratio)      // half away from zero
clamped     = min(max(raw, minimum_processing_minutes), maximum_processing_minutes)
processing  = clamped                                          // MINUTES OF WORK
occupancy   = processing + transition_buffer_minutes           // MINUTES THE LANE IS HELD
```

**Processing and buffer are deliberately separate quantities.**

- `processing` is how long the farmer's produce is actually being handled. It is what the farmer is told, and what ETA projection consumes.
- `occupancy = processing + buffer` is how long the **lane** is unavailable. The buffer is vehicle clearance: the next farmer must not be told to arrive while the previous vehicle is still in the bay.

The lane exclusion is computed on `occupancy`, so the next booking's start is at or after the previous booking's `start + occupancy`. `bookings.scheduled_end_at` therefore stores the **occupancy** end, and `bookings_occupancy_not_below_processing` already guarantees the relationship.

Start times are snapped **up** to `slot_granularity_minutes` so windows tile predictably and a farmer is never given an 08:07 start.

### Worked values under the configuration above

| Centre | Quantity | ratio | raw | clamped | processing | + buffer | occupancy |
|---|---|---|---|---|---|---|---|
| Agra | 2 500 kg (25 q) | 1.0 | 60 | 60 | **60 min** | +15 | **75 min** |
| Agra | 5 000 kg (50 q) | 2.0 | 120 | 120 | **120 min** | +15 | **135 min** |
| Agra | 3 750 kg (37.5 q) | 1.5 | 90 | 90 | **90 min** | +15 | **105 min** |
| Aligarh | 2 500 kg | 1.0 | 75 | 75 | **75 min** | +15 | **90 min** |
| Aligarh | 5 000 kg | 2.0 | 150 | 150 | **150 min** | +15 | **165 min** |

The brief's "50 quintal ≈ 2 hours" is **produced by** Agra's configuration, not asserted by the code. Aligarh's slower configured rate yields 150 minutes for the same quantity — which is the point of making it configuration.

The `min`/`max` clamps never bind at the current settings (30 ≤ 60…150 ≤ 180). They exist for configurations where they would, and are tested directly at the engine level.

---

## 4. Timezone

Operating hours are stored as local `TIME` plus the centre's IANA `timezone`; bookings store `TIMESTAMPTZ`. Conversion happens once, in the engine:

```
localDate + localTime + centre.timezone  ->  UTC instant
```

Implemented with `Intl.DateTimeFormat` offset resolution and a second refinement pass, so it is correct across a DST boundary even though `Asia/Kolkata` has none. A `service_date` is always the centre's **local calendar date**.

---

## 5. Availability algorithm

`findEarliestWindow(centre, crop, quantityKg, fromDate, horizon)`:

```
1. GUARDS      centre ACTIVE; crop configured for this centre + season + marketing year;
               quantity within 2500..5000; date within [today, today + horizon]
2. FOR EACH working day from fromDate forward (skip holidays and unconfigured weekdays):
     a. build the local working window(s) for that weekday -> UTC interval
     b. load ACTIVE bookings for (centre, service_date), grouped by lane
     c. FOR EACH lane, ascending:
          free := workingWindow minus that lane's occupied intervals
          cursor := max(windowStart, now + minimum lead)   // never schedule in the past
          snap cursor up to granularity
          first position where [cursor, cursor+occupancy) fits entirely inside a free
          interval and inside working hours -> candidate {lane, start}
     d. choose the candidate with the EARLIEST start; ties break to the lowest lane number
     e. if a candidate exists -> return it
3. horizon exhausted -> NO_AVAILABILITY with a reason code
```

**A later lane opening is never selected when an earlier one exists**, because step (d) takes the minimum start across all lanes rather than returning the first lane that happens to fit. Tie-breaking on lane number makes allocation deterministic and therefore testable.

Windows must fit **entirely** within working hours — a booking that would run past `closes_at` is not offered; the search moves to the next working day.

---

## 6. Lane allocation

Lanes are independent resources at the same centre. Two farmers may be served concurrently on lanes 1 and 2 at Aligarh; they may not both occupy lane 1.

The database is the final arbiter:

```sql
CONSTRAINT bookings_no_lane_overlap
  EXCLUDE USING gist (centre_id WITH =, lane_no WITH =, service_window WITH &&)
  WHERE (status IN (…active…))
```

`service_window` is `tstzrange(scheduled_start_at, scheduled_end_at)` with `[)` bounds, so back-to-back bookings are legal and any true overlap is not. Application scheduling still computes availability correctly first; the constraint exists so that a bug, a race, or a manual `INSERT` cannot produce an overlap regardless.

---

## 7. Concurrency

Two farmers requesting the same earliest window is the expected case at 08:00, not an edge case.

**Transaction shape** (fixed lock order, as the architecture specifies):

```
BEGIN  (READ COMMITTED)
  1. idempotency key   INSERT … ON CONFLICT -> replay stored response
  2. LOCK              SELECT … FROM centre_daily_capacity
                         WHERE centre_id=$1 AND service_date=$2 FOR UPDATE
                       (row created on first booking of that day)
  3. storage           ADVISORY -> not enforced; reason reported (§9)
  4. RECOMPUTE         availability re-derived INSIDE the transaction, from rows
                       now visible under the lock — the client's chosen window is
                       re-validated, never trusted
  5. INSERT booking    the EXCLUDE constraint is the final arbiter
  6. UPDATE counters   centre_daily_capacity
  7. INSERT            booking_status_history + audit_logs
  8. store             response against the idempotency key
COMMIT
```

The `FOR UPDATE` on `centre_daily_capacity` serialises concurrent bookings **for the same centre and day**, which is precisely the contended resource. Different centres and different days proceed in parallel.

**Bounded retry.** If the insert still raises `exclusion_violation` (SQLSTATE `23P01`), the engine recomputes and tries the next available window, at most `MAX_BOOKING_ATTEMPTS = 3` times, then returns `409 SLOT_NO_LONGER_AVAILABLE` with freshly computed alternatives. It never retries indefinitely.

---

## 8. Idempotency

`POST /bookings` requires an `Idempotency-Key` header. The key, the caller and a hash of the request body are inserted into `idempotency_keys` as the first statement of the transaction.

- Same key **and** same body → the stored response is replayed; no second booking.
- Same key, **different** body → `409 IDEMPOTENCY_KEY_REUSED`. Silently returning the first response would be wrong when the caller asked for something else.
- Keys expire after 24 hours.

This covers double-click, network retry and client retry-after-timeout.

---

## 9. Storage — advisory, never invented

`storage_check_mode` is `ADVISORY` on all five centres, and no centre has a linked facility, so there is no capacity figure to consult.

- `ADVISORY` → the booking proceeds and the response carries
  `storageCheck: { status: "NOT_AVAILABLE", reasonCode: "NO_CAPACITY_DATA_FOR_CENTRE" }`.
- `ENFORCED` → available headroom would be locked and checked. Reachable only where real capacity data exists.
- `DISABLED` → not evaluated; reported as such.

**No headroom figure is computed, defaulted or assumed.** The scheduler does not silently treat storage as known (D-8/D-10).

---

## 10. Token and booking code

Two distinct identifiers, as the schema already separates them:

| | Purpose | Shape | Sequential? |
|---|---|---|---|
| `bookingCode` | The farmer's public reference, used for lookup and later officer search | `FQ-YYYY-NNNNNNN`, the 7 digits **cryptographically random** | No |
| `tokenNumber` | The number called out in the queue at a centre on a day | `1, 2, 3 …` per `(centre, service_date)` | **Yes, necessarily** — it is the calling order |

The internal `bookings.id` UUID is **never** exposed. `bookingCode` is generated with `crypto.randomInt`, retried on the unique constraint (bounded), and never derived from a sequence.

`tokenNumber` is allocated inside the transaction as `max(token_number)+1` for that centre and date, under the same `centre_daily_capacity` lock, and is protected by `bookings_token_unique_per_centre_date`.

**Honest limitation:** the existing `bookings_booking_code_format` CHECK fixes the code at 7 digits, so the space is 10⁷. That is not enough entropy to be unguessable on its own. Enumeration is prevented by **ownership enforcement** — a lookup for a code you do not own returns `404`, not `403` — rather than by the code's secrecy. Widening the format would need a migration and is recorded as a risk, not silently assumed away.

---

## 11. ETA — derived, never fabricated

Phase 7 returns only what follows deterministically from the booking's own configuration:

| Field | Meaning |
|---|---|
| `scheduledStartAt` | When the reserved window begins — **arrive by this time** |
| `processingEndAt` | `scheduledStartAt + processingMinutes` — expected end of handling |
| `windowEndAt` | `scheduledStartAt + occupancyMinutes` — when the lane is released |
| `processingMinutes`, `bufferMinutes`, `occupancyMinutes` | The derivation, exposed so nothing is a black box |

**A 2 500 kg and a 5 000 kg booking produce different durations**, from configuration.

`estimatedApproachAt` is deliberately **equal to `scheduledStartAt`**. No "arrive 30 minutes early" lead time is invented, because none is configured. If an approach lead is wanted it must be added to `centre_slot_configurations` first.

Live queue position and dynamic ETA — which depend on what is actually happening at the centre today — are **Phase 9**, not this phase. Nothing here is persisted as a status.

---

## 12. Booking rules enforced

Session identity only; a `farmerId` in a request body is ignored (there is nowhere for it to go). Beyond that:

| Rule | Enforced by |
|---|---|
| 2 500 ≤ quantityKg ≤ 5 000 | Zod + `bookings_quantity_within_business_rule` |
| Crop configured for this centre, season and marketing year | `centre_crop_configurations` lookup |
| Centre `ACTIVE`, working day, inside hours, within horizon | engine guards |
| No overlap with the farmer's other active bookings | `bookings_no_farmer_overlap` |
| No duplicate active booking, same farmer/centre/crop/date | partial unique index |
| Volume limits | `booking_policies` — **empty, so none apply**. Not invented here |

The withdrawn A-3 "one active per farmer per crop" rule is **not** reintroduced.

---

## 13. State machine

The canonical nine states are used unchanged. A booking is created `CONFIRMED`. Phase 7 performs exactly two transitions:

```
CONFIRMED -> CANCELLED     (farmer, before the cutoff)
```

`ARRIVED`, `WEIGHING`, `QUALITY_CHECK`, `PROCUREMENT_RECORDED`, `PAYMENT_PENDING`, `COMPLETED`, `NO_SHOW` belong to later phases and are not driven from here. `REMINDER_SENT`, `APPROACHING` and `WAITING` remain **derived `displayStatus`**, never stored.

Illegal transitions are refused by the database trigger against `booking_status_transitions`.

---

## 14. Cancellation

The approved rule only: allowed while `CONFIRMED` and
`now < scheduled_start_at − cancellation_cutoff_hours` (24 h as configured). No new policy is invented; no penalty, no limit.

Cancelling sets `status = CANCELLED`, records reason and actor, decrements `centre_daily_capacity`, and writes status history plus audit — all in one transaction.

Because both exclusion constraints and the duplicate index are **partial on active statuses**, a cancelled booking immediately stops blocking scheduling. That is a property of the schema, not of cleanup code.

---

## 15. Failure modes

| Condition | Code | Status |
|---|---|---|
| Quantity outside range | `QUANTITY_BELOW_MINIMUM` / `QUANTITY_ABOVE_MAXIMUM` | 400 |
| Crop not accepted at centre | `CROP_NOT_CONFIGURED_AT_CENTRE` | 422 |
| Centre inactive / unknown | `CENTRE_NOT_AVAILABLE` | 422 |
| Date is a holiday or non-working day | `CENTRE_CLOSED_ON_DATE` | 422 |
| Beyond booking horizon | `OUTSIDE_BOOKING_HORIZON` | 422 |
| No window anywhere in the horizon | `NO_AVAILABILITY` | 422 |
| Chosen window taken during the race | `SLOT_NO_LONGER_AVAILABLE` | 409 |
| Farmer already booked that centre/crop/date | `DUPLICATE_ACTIVE_BOOKING` | 409 |
| Overlaps the farmer's other booking | `FARMER_TIME_CONFLICT` | 409 |
| Idempotency key reused with a different body | `IDEMPOTENCY_KEY_REUSED` | 409 |
| Cancel after the cutoff | `CANCELLATION_WINDOW_CLOSED` | 409 |
| Cancel a non-cancellable state | `INVALID_STATE_TRANSITION` | 409 |
| Someone else's booking | `NOT_FOUND` | 404 |

---

## 16. Worked examples

**Example A — 25 quintal at Agra, empty day**
2 500 kg → ratio 1.0 → 60 min processing → +15 buffer → 75 min occupancy.
Earliest lane is 1, day opens 08:00 local.
→ start **08:00**, processing ends **09:00**, lane released **09:15**.

**Example B — 50 quintal at Agra, empty day**
5 000 kg → ratio 2.0 → 120 min → +15 → 135 min.
→ start **08:00**, processing ends **10:00**, lane released **10:15**.
The same 5 000 kg at Aligarh yields 150 min processing, because Aligarh's configured reference rate is 75 min per 2 500 kg.

**Example C — all lanes occupied**
Hathras has 1 lane and 09:00–17:00 = 480 minutes. Three 5 000 kg bookings occupy 3 × 135 = 405 minutes (09:00–15:45). A fourth needs 135 minutes but only 75 remain before 17:00, so it does not fit.
→ the search rolls to the next working day and returns **the next day at 09:00**. Sunday is skipped because no `day_of_week = 0` row exists.

**Example D — two farmers, one window**
Both request the earliest slot at Agra lane 1, 08:00.

```
T1: BEGIN, lock centre_daily_capacity(Agra, date)   -- acquires
T2: BEGIN, lock same row                            -- BLOCKS
T1: recompute -> 08:00 free -> INSERT -> COMMIT
T2: proceeds, recomputes under the lock -> 08:00 now taken
    -> next free position on lane 1 is 09:15, or lane 2 at 08:00
    -> takes the earliest, which is lane 2 at 08:00
```

Both farmers get a booking; neither overlaps. Had they contended for the last remaining position, the loser would receive `409 SLOT_NO_LONGER_AVAILABLE` with alternatives after at most three attempts. If application logic were bypassed entirely, `bookings_no_lane_overlap` would still reject the second insert.

---

## 17. Performance

Availability for one centre-day reads `bookings` via `bookings_centre_date_start_idx (centre_id, service_date, scheduled_start_at)` — an index range scan over one day's rows, not a table scan. Free-interval computation is then in-memory over that small set.

The multi-day search stops at the first day with a candidate; the worst case is `booking_horizon_days` (7) index lookups.

No caching is introduced. Correctness first; a query plan is inspected in the report rather than optimised speculatively.

---

## 18. Module layout

```
server/src/
  engines/scheduling.ts        PURE. No I/O, no clock. Fully unit-testable.
  modules/bookings/
    bookings.schemas.ts        Zod contracts
    bookings.repository.ts     SQL, locking, the transactional insert
    bookings.service.ts        Orchestration, retries, state transitions
    bookings.routes.ts         HTTP, permissions, idempotency
```

The engine is pure so every rule above can be tested without a database, and the repository holds every lock so transaction behaviour is reviewable in one file.
