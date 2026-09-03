# FarmQueue — Booking API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phase 7)
**Base path:** `/api/v1`
**Companion:** [`authentication.md`](./authentication.md) — cookies, CSRF, error envelope
**Design contract:** [`../phase-7-booking-engine.md`](../phase-7-booking-engine.md)

> Every rule below is enforced by the code and covered by the 48 Phase 7 tests.
> Where a value comes from configuration rather than from the code, this
> document says so and names the table.

---

## 1. Endpoint index

| Method | Path | Permission | CSRF | Idempotency-Key |
|---|---|---|:--:|:--:|
| POST | `/bookings/availability` | `slot.query` | ✔ | — |
| POST | `/bookings` | `booking.create.own` | ✔ | **required** |
| GET | `/bookings/me` | `booking.read.own` | — | — |
| GET | `/bookings/:bookingCode` | `booking.read.own` | — | — |
| POST | `/bookings/:bookingCode/cancel` | `booking.cancel.own` | ✔ | — |

`POST /bookings/availability` is a POST because it carries a request body, not
because it changes anything. It is side-effect free.

---

## 2. Identity comes from the session

No endpoint accepts a `farmerId`. The session identifies the farmer, and a
booking is reached only through its `bookingCode`. A code belonging to another
farmer returns **`404`, never `403`** — a 403 would confirm the code exists and
turn the endpoint into an enumeration oracle.

This matters here more than elsewhere: `booking_code` is 7 digits by database
CHECK, so the code space is 10⁷ and the code is **not** secret enough to protect
a booking on its own. Ownership enforcement is what protects it.

---

## 3. The two durations

Every response that describes a window exposes the derivation rather than a
single opaque number:

| Field | Meaning |
|---|---|
| `processingMinutes` | How long the produce is actually handled. **This is what the farmer is told.** |
| `bufferMinutes` | Vehicle clearance after processing, from `transition_buffer_minutes` |
| `occupancyMinutes` | `processing + buffer` — how long the **lane** is held |
| `scheduledStartAt` | Arrive by this time (UTC, ISO 8601) |
| `processingEndAt` | `scheduledStartAt + processingMinutes` |
| `windowEndAt` | `scheduledStartAt + occupancyMinutes` — when the lane frees |
| `estimatedApproachAt` | **Equal to `scheduledStartAt`.** No arrival lead time is configured, so none is invented |

Duration is derived from `centre_slot_configurations`, never hardcoded:

```
ratio      = quantityKg / reference_quantity_kg
raw        = round(reference_processing_minutes x ratio)
processing = clamp(raw, minimum_processing_minutes, maximum_processing_minutes)
occupancy  = processing + transition_buffer_minutes
```

2 500 kg at Agra is 60 minutes; 5 000 kg is 120. The same 5 000 kg at Aligarh is
**150** minutes, because Aligarh's configured reference rate is 75 min / 2 500 kg.
Changing a row changes the answer with no code edit.

---

## 4. POST `/bookings/availability`

Finds the earliest bookable window. Reserves nothing.

**Request**

```json
{
  "centreId": "uuid",
  "cropId": "uuid",
  "quantityKg": 5000,
  "fromDate": "2026-09-07"
}
```

`fromDate` is optional and defaults to the centre's local today. `quantityKg`
must satisfy 2 500 <= q <= 5 000.

**200 — a window exists**

```json
{
  "data": {
    "centre": { "code": "DEMO-UP-AGRA-01", "name": "...", "district": "Agra",
                "timezone": "Asia/Kolkata", "laneCount": 2, "dataType": "CONFIGURED" },
    "crop": { "name": "Wheat", "season": "RMS", "marketingYear": "2026-27" },
    "quantityKg": 5000,
    "duration": { "processingMinutes": 120, "bufferMinutes": 15, "occupancyMinutes": 135 },
    "available": true,
    "window": {
      "serviceDate": "2026-09-07",
      "laneNo": 1,
      "scheduledStartAt": "2026-09-07T02:30:00.000Z",
      "estimatedApproachAt": "2026-09-07T02:30:00.000Z",
      "processingEndAt": "2026-09-07T04:30:00.000Z",
      "windowEndAt": "2026-09-07T04:45:00.000Z",
      "processingMinutes": 120, "bufferMinutes": 15, "occupancyMinutes": 135,
      "centreTimezone": "Asia/Kolkata"
    },
    "reasonCode": null,
    "horizonDays": 7,
    "storageCheck": { "checkMode": "ADVISORY", "status": "NOT_AVAILABLE",
                      "reasonCode": "NO_CAPACITY_DATA_FOR_CENTRE" }
  }
}
```

**200 — no window** returns `available: false`, `window: null` and a
`reasonCode`. A search that finds nothing is **not** an error; the caller asked a
legitimate question and got a truthful answer.

Note `02:30:00Z` is 08:00 Asia/Kolkata. Times cross the wire in UTC;
`centreTimezone` is supplied so a client renders local wall clock without
guessing.

Rate limit: 120 per session per 15 minutes.

---

## 5. POST `/bookings`

Reserves the earliest available window. **`Idempotency-Key` (8–200 chars) is
required** — omitting it is `400 IDEMPOTENCY_KEY_REQUIRED`.

**Request** — identical to availability, except the date field is
`preferredDate`:

```json
{ "centreId": "uuid", "cropId": "uuid", "quantityKg": 5000, "preferredDate": "2026-09-07" }
```

`preferredDate` is a **search start, not a demand**. If nothing fits that day the
engine rolls forward to the next working day inside the horizon.

**201**

```json
{
  "data": {
    "bookingCode": "FQ-2026-4820193",
    "tokenNumber": 1,
    "status": "CONFIRMED",
    "displayStatus": "BOOKED",
    "centre": { "code": "...", "name": "...", "district": "...",
                "timezone": "Asia/Kolkata", "dataType": "CONFIGURED" },
    "crop": { "name": "Wheat", "season": "RMS", "marketingYear": "2026-27" },
    "quantityKg": 5000,
    "serviceDate": "2026-09-07",
    "laneNo": 1,
    "scheduledStartAt": "2026-09-07T02:30:00.000Z",
    "estimatedApproachAt": "2026-09-07T02:30:00.000Z",
    "processingEndAt": "2026-09-07T04:30:00.000Z",
    "windowEndAt": "2026-09-07T04:45:00.000Z",
    "processingMinutes": 120, "bufferMinutes": 15, "occupancyMinutes": 135,
    "storageCheck": { "checkMode": "ADVISORY", "status": "NOT_AVAILABLE",
                      "reasonCode": "NO_CAPACITY_DATA_FOR_CENTRE" }
  }
}
```

### 5.1 The two identifiers are different things

| | Purpose | Shape | Sequential |
|---|---|---|---|
| `bookingCode` | The farmer's public reference | `FQ-YYYY-NNNNNNN`, digits from `crypto.randomInt` | **No** |
| `tokenNumber` | The number called out at the centre that day | `1, 2, 3 …` per centre and date | **Yes** — it is the calling order |

The internal `bookings.id` UUID is never exposed.

### 5.2 Idempotency

| Situation | Result |
|---|---|
| Same key, same body | The stored response is replayed. No second booking |
| Same key, different body | `409 IDEMPOTENCY_KEY_REUSED` |
| New key | Processed normally |

Keys expire after 24 hours. The body hash is SHA-256 over the parsed request, so
a retried double-click replays and a genuinely different request does not.

### 5.3 Concurrency

Two farmers requesting the same 08:00 window is the expected case. Booking runs
in one transaction that locks `centre_daily_capacity` for the centre-day
`FOR UPDATE`, **recomputes availability under that lock** and only then inserts.
The client's chosen window is re-validated, never trusted.

If the insert still hits `bookings_no_lane_overlap` (SQLSTATE `23P01`), the
engine recomputes and retries the next window at most **3** times, then returns
`409 SLOT_NO_LONGER_AVAILABLE`. It never retries indefinitely.

The database is the final arbiter regardless of application logic:

```sql
EXCLUDE USING gist (centre_id WITH =, lane_no WITH =, service_window WITH &&)
  WHERE (status IN (...active...))
```

Rate limit: 10 bookings per farmer per hour.

### 5.4 Storage is advisory, never invented

`storage_check_mode` is `ADVISORY` at all five centres and no centre has a linked
facility, so **there is no headroom figure to report**. The response says exactly
that (`NO_CAPACITY_DATA_FOR_CENTRE`) rather than defaulting to a number. See
decision D-8/D-10.

---

## 6. GET `/bookings/me`

Returns the authenticated farmer's bookings, active only by default. Pass
`?includeInactive=true` to include `CANCELLED` and terminal states. Each element
has the same shape as §5.

---

## 7. GET `/bookings/:bookingCode`

One booking, same shape as §5. Ownership is part of the SQL predicate, so
another farmer's code is indistinguishable from a code that does not exist:
both are `404`.

---

## 8. POST `/bookings/:bookingCode/cancel`

**Request** (body optional)

```json
{ "reason": "Harvest delayed" }
```

Allowed only while the booking is `CONFIRMED` **and**

```
now < scheduledStartAt - cancellation_cutoff_hours     (24 h as configured)
```

No penalty and no cancellation limit exist, because none is configured. On
success the booking becomes `CANCELLED` and **immediately stops blocking
scheduling** — both exclusion constraints and the duplicate index are partial on
active statuses, so that is a property of the schema, not of cleanup code.

`displayStatus` is derived on read and never stored: `CONFIRMED` becomes
`BOOKED`, `ARRIVED` becomes `WAITING`. `APPROACHING` and live queue position
arrive in Phase 9.

---

## 9. Errors

The envelope is defined in `authentication.md`. Booking-specific codes:

| Condition | Code | Status |
|---|---|---|
| Quantity below 2 500 kg | `QUANTITY_BELOW_MINIMUM` | 400 |
| Quantity above 5 000 kg | `QUANTITY_ABOVE_MAXIMUM` | 400 |
| `Idempotency-Key` missing or malformed | `IDEMPOTENCY_KEY_REQUIRED` | 400 |
| Crop not configured at this centre | `CROP_NOT_CONFIGURED_AT_CENTRE` | 422 |
| Centre unknown or not `ACTIVE` | `CENTRE_NOT_AVAILABLE` | 422 |
| Holiday or non-working weekday | `CENTRE_CLOSED_ON_DATE` | 422 |
| Date in the past or beyond the horizon | `OUTSIDE_BOOKING_HORIZON` | 422 |
| No window anywhere in the horizon | `NO_AVAILABILITY` | 422 |
| Window taken during the race | `SLOT_NO_LONGER_AVAILABLE` | 409 |
| Already booked this centre/crop/date | `DUPLICATE_ACTIVE_BOOKING` | 409 |
| Overlaps another of the farmer's bookings | `FARMER_TIME_CONFLICT` | 409 |
| Key reused with a different body | `IDEMPOTENCY_KEY_REUSED` | 409 |
| Cancelled after the cutoff | `CANCELLATION_WINDOW_CLOSED` | 409 |
| Not cancellable from this state | `INVALID_STATE_TRANSITION` | 409 |
| Someone else's booking, or no such code | `NOT_FOUND` | 404 |

`QUANTITY_*` codes arrive under `error.fields.quantityKg`; the rest under
`error.code`.

---

## 10. What this API deliberately does not do

- **No live queue position or dynamic ETA.** Both depend on what is happening at
  the centre today. Phase 9.
- **No SMS.** Phase 12.
- **No officer operations.** `ARRIVED` onward is not driven from here.
- **No volume policy.** `booking_policies` is empty, so no volume rule applies.
  An empty policy table means *no policy configured*, and none is invented.
