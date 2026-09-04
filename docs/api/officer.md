# Mandi Sahayak — Officer Operations API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phase 8)
**Base path:** `/api/v1`
**Companion:** [`authentication.md`](./authentication.md) — cookies, CSRF, error envelope
**Companion:** [`bookings.md`](./bookings.md) — how a booking comes to exist
**Design contract:** [`../phase-8-officer-operations.md`](../phase-8-officer-operations.md)

> Every rule below is enforced by the code and covered by the 60 Phase 8 tests.
> Where a value comes from configuration or from government data rather than
> from the code, this document says so and names the table.

---

## 1. Endpoint index

| Method | Path | Permission | CSRF | Transition |
|---|---|---|:--:|---|
| GET | `/officer/centres/:centreId/bookings` | `booking.read.centre` | — | — |
| GET | `/officer/bookings/search` | `booking.search.centre` | — | — |
| GET | `/officer/bookings/:bookingCode` | `booking.read.centre` | — | — |
| POST | `/officer/bookings/:bookingCode/arrive` | `booking.advance_state` | yes | `CONFIRMED` → `ARRIVED` |
| POST | `/officer/bookings/:bookingCode/no-show` | `booking.mark_no_show` | yes | `CONFIRMED` → `NO_SHOW` |
| POST | `/officer/bookings/:bookingCode/weighing` | `booking.advance_state` | yes | `ARRIVED` → `WEIGHING` |
| POST | `/officer/bookings/:bookingCode/weight` | `procurement.record_weight` | yes | `WEIGHING` → `QUALITY_CHECK` |
| POST | `/officer/bookings/:bookingCode/quality` | `procurement.record_quality` | yes | `QUALITY_CHECK` → `PROCUREMENT_RECORDED` |
| POST | `/officer/bookings/:bookingCode/complete` | `procurement.complete` | yes | `PROCUREMENT_RECORDED` → `PAYMENT_PENDING` |
| POST | `/officer/bookings/:bookingCode/cancel` | `booking.advance_state` | yes | `ARRIVED`/`WEIGHING`/`QUALITY_CHECK` → `CANCELLED` |
| POST | `/officer/bookings/:bookingCode/payment` | `payment.update_status` | yes | `PAYMENT_PENDING` → `COMPLETED` on `PAID` |
| GET | `/bookings/:bookingCode/procurement` | `procurement.read.own` | — | — |
| GET | `/bookings/:bookingCode/payment` | `payment.read.own` | — | — |

**No endpoint accepts an `Idempotency-Key`, and none needs one.** A replayed
`arrive` finds the booking already `ARRIVED` and returns `409` — which is the
correct answer to a double tap, not a failure to handle one. Booking *creation*
needs a key because a replay there would produce a second booking; a transition
defends itself.

---

## 2. Two authorization checks, always both

```
requirePermission(...)   may this ROLE do this kind of thing at all?
centre scope             may this ACTOR do it to THIS booking?
```

The scope comes from `officer_centre_assignments`, resolved into the session at
login. It is applied **inside the SQL**, not as a filter afterwards.

**A booking at an unassigned centre returns `404`, never `403`.** An officer at
Agra must not be able to learn from the shape of a refusal that a booking code
exists at Mathura. The same rule protects a farmer's booking from another farmer
(`bookings.md` §2).

An **ADMIN** carries an unrestricted scope, because an admin's authority does not
come from an assignment. An officer assigned to no centre carries an empty scope
and can act on nothing.

### 2.1 What an ADMIN cannot do

The seeded grant matrix separates operating from administering. An admin holds
`booking.read.centre`, `booking.search.centre` and `payment.update_status` — and
**not** `booking.advance_state`, `booking.mark_no_show`, `procurement.record_weight`,
`procurement.record_quality` or `procurement.complete`.

An admin calling `/arrive` or `/weight` gets **`403`**. Admins configure centres,
import MSP and assign officers; they do not stand at the weighbridge. This is
verified by test, not assumed.

---

## 3. The lifecycle

```
CONFIRMED ──arrive──> ARRIVED ──weighing──> WEIGHING ──weight──> QUALITY_CHECK
    │                    │                     │                      │
    │                    └─────────cancel──────┴──────────────────────┘
    │                                                                 │
    ├──no-show──> NO_SHOW  (terminal)                              quality
    │                                                                 │
    └──cancel(farmer)──> CANCELLED (terminal)                         v
                                                    PROCUREMENT_RECORDED
                                                                      │
                                                                 complete
                                                                      v
                                                         PAYMENT_PENDING
                                                                      │
                                                          payment → PAID
                                                                      v
                                                              COMPLETED
```

The lifecycle is stored **as data** in `booking_status_transitions` and enforced
by a `BEFORE UPDATE` trigger. Any pair absent from that table is rejected by the
database even if every line of application code is wrong — a test moves a
booking illegally with raw SQL and the database refuses it.

`NO_SHOW`, `CANCELLED` and `COMPLETED` have **no outgoing transitions**. A
no-show cannot be un-marked and a completed booking cannot be reopened.

---

## 4. Recording the work

### 4.1 `POST /officer/bookings/:bookingCode/arrive`

Creates the procurement record. No body.

```json
{ "data": {
  "booking": { "bookingCode": "FQ-2026-1234567", "status": "ARRIVED",
               "displayStatus": "WAITING", "tokenNumber": 4, "…": "…" },
  "procurement": { "status": "IN_PROGRESS", "arrivedAt": "2026-09-08T03:30:00.000Z",
                   "qualityStatus": "PENDING", "grossQuantityKg": null }
} }
```

`arrivedAt` is `now()` from the database, never a client-supplied time.

### 4.2 `POST /officer/bookings/:bookingCode/weight`

```json
{ "grossQuantityKg": 2480.5 }
```

| Rule | Detail |
|---|---|
| Strictly positive | A gross weight of zero is a farmer who did not arrive |
| Up to 3 decimals | A weighbridge reads to the gram; `numeric(12,3)` |
| **Not** 2 500–5 000 kg | That range constrains what a farmer may **request**. What arrives is a measurement, and 1 200 kg is a valid reading |
| No ceiling | **No business ceiling is configured, because none is specified.** The bound applied is the column's headroom, not a policy |

### 4.3 `POST /officer/bookings/:bookingCode/quality`

```json
{ "acceptedQuantityKg": 2400, "rejectedQuantityKg": 80.5,
  "grade": "Grade A", "moisturePercent": 11.5,
  "rejectionReason": "Moisture above the permitted limit" }
```

**`qualityStatus` is derived, never accepted from the client** — the field does
not exist in the request schema:

| Condition | Result |
|---|---|
| `accepted = 0` | `REJECTED` |
| `accepted = gross` and `rejected = 0` | `ACCEPTED` |
| otherwise | `PARTIALLY_ACCEPTED` |

An unexplained shortfall (2 450 accepted of 2 500 gross, nothing rejected) is
`PARTIALLY_ACCEPTED`, not `ACCEPTED`: the missing 50 kg stays visible.

`accepted + rejected` may be **less than** gross — moisture loss, cleaning and
screenings are real. It may not exceed it (`QUANTITY_EXCEEDS_GROSS`).

`rejectionReason` is required when `rejected > 0` and refused when `rejected = 0`.

`grade` is the field that decides the price — see §5.

---

## 5. Payment: what `complete` computes

`POST /officer/bookings/:bookingCode/complete` closes the procurement and prices
it in the same transaction.

### 5.1 The rate is resolved by identity, not by guesswork

Decision **D-9** fixes the identity of an MSP rate as
`crop + season + marketing_year + grade`. A booking carries the first three.
**The grade recorded at quality check supplies the fourth** — it is the only
point in the lifecycle where a grade exists at all.

| Active rates for the crop/season/year | Recorded grade | Outcome |
|---|---|---|
| 0 | any | `BLOCKED` / `NO_ACTIVE_MSP` |
| exactly 1 | any | resolved |
| more than 1 | none | `BLOCKED` / `MSP_AMBIGUOUS` |
| more than 1 | matches one | resolved |
| more than 1 | matches none | `BLOCKED` / `NO_ACTIVE_MSP` |

Grade matching is case-insensitive and whitespace-trimmed. It is not fuzzy.

### 5.2 In the seeded data

| Crop | Rates | Result |
|---|---|---|
| **Wheat** RMS 2026-27 | one, ungraded, 2 585.00/quintal | prices with or without a grade |
| **Paddy** KMS 2026-27 | `Common` 2 441.00, `Grade A` 2 461.00 | **blocked** until a grade is recorded |

**A blocked payment is not an error.** It is the system declining to invent a
price for produce nobody graded, and saying which of the two reasons applies.
The procurement still completes and the booking still advances to
`PAYMENT_PENDING`.

### 5.3 Arithmetic

Computed by PostgreSQL in `numeric` — the money never passes through a float:

```
base   = ROUND(accepted_quantity_kg / 100 * rate_per_quintal_paise)
amount = GREATEST(base - deductions, 0)
```

`rate_per_quintal_paise_snapshot` records the rate **as it was at that moment**.
A later MSP revision cannot retroactively change what a farmer was told.

`deductionsPaise` is **0** and `deductionBreakdown` is `[]`. No deduction policy
is configured, and an empty policy means *no deductions*, not *deductions
unknown*. Mandi fee, commission and transport are deliberately absent: none has
an authoritative configured source in this system yet.

All money is **integer paise** on the wire. `amountRupees` is a formatted string
provided for display only.

```json
{ "data": { "payment": {
  "status": "PENDING", "blockedReason": null, "currency": "INR",
  "ratePerQuintalPaise": 258500, "baseAmountPaise": 6412093,
  "deductionsPaise": 0, "deductionBreakdown": [],
  "amountPaise": 6412093, "amountRupees": "64120.93"
} } }
```

### 5.4 Payment status

`POST /officer/bookings/:bookingCode/payment`

```json
{ "status": "PAID", "paymentReference": "UTR-…" }
```

```
BLOCKED  (no outgoing edge — see below)
PENDING   -> INITIATED | ON_HOLD | FAILED
INITIATED -> PAID | FAILED | ON_HOLD
ON_HOLD   -> PENDING | INITIATED | FAILED
FAILED    -> PENDING | INITIATED
PAID      (terminal)
```

- `PAID` requires `paymentReference`. There is no disbursal integration in this
  phase; the reference is what an external system provides.
- **Only `PAID` closes the booking.** `FAILED` and `ON_HOLD` leave it
  `PAYMENT_PENDING`, because the work is not finished.
- A `BLOCKED` payment cannot be advanced (`PAYMENT_BLOCKED`). Unblocking needs
  an MSP import or a grade correction — administrative acts outside this phase.

---

## 6. Reads

### 6.1 `GET /officer/centres/:centreId/bookings`

| Query | Default |
|---|---|
| `date` | **today in the centre's timezone**, never the server's |
| `status` | comma-separated filter; omitted means all |

Ordered by `scheduled_start_at`, then token. **This is not the live queue** —
position and dynamic ETA are Phase 9 and derive from what the transitions above
actually record.

### 6.2 `GET /officer/bookings/search?q=`

Accepts one of:

| Shape | Interpreted as |
|---|---|
| `FQ-YYYY-NNNNNNN` | booking code |
| 1–6 digits | token number |
| exactly 10 digits | phone |

Anything else returns an empty list rather than an error. Results are restricted
to assigned centres **in the SQL**. A phone belonging to nobody and a phone whose
farmer has no booking at an assigned centre return the same empty list, so the
endpoint cannot be used to test whether a number is registered.

Rate limited per session (`officer_search_session`, 240 per 15 minutes) —
deliberately far above what a busy centre needs, so it bounds scripted probing
without ever interrupting real work.

### 6.3 Farmer reads

`GET /bookings/:bookingCode/procurement` and `GET /bookings/:bookingCode/payment`
return the record for the farmer's own booking; anything else is `404`. Before
the officer records an arrival the answer is `404` — a procurement that has not
begun is absent, not empty.

**The farmer is shown `blockedReason`**, not an empty amount with no explanation.
"We cannot price this until a grade is recorded" is something the farmer is
entitled to know, and it is delivered as a code the UI can translate.

---

## 7. Error codes

| Code | Status | Meaning |
|---|---|---|
| `INVALID_STATE_TRANSITION` | 409 | The booking is not in a state that accepts this step. `details.currentStatus` says what it is |
| `WEIGHT_ALREADY_RECORDED` | 409 | Gross weight is already set |
| `QUANTITY_EXCEEDS_GROSS` | 400 | `accepted + rejected > gross` |
| `REJECTION_REASON_REQUIRED` | 400 | `rejected > 0` with no reason |
| `REJECTION_REASON_NOT_APPLICABLE` | 400 | Reason supplied with `rejected = 0` |
| `PROCUREMENT_NOT_STARTED` | 404 | No procurement record for this booking |
| `PAYMENT_NOT_READY` | 409 | Status change attempted before `complete` |
| `PAYMENT_BLOCKED` | 409 | Status change on a blocked payment; `details.blockedReason` says why |
| `PAYMENT_REFERENCE_REQUIRED` | 400 | `PAID` without a reference |
| `INVALID_PAYMENT_TRANSITION` | 409 | e.g. `PENDING` straight to `PAID` |
| `VALIDATION_FAILED` | 400 | Field-level; `fields` names each one |
| `NOT_FOUND` | 404 | Unknown booking **or** a booking outside the caller's centre scope — deliberately indistinguishable |
| `FORBIDDEN` | 403 | The role lacks the permission. Audited as `auth.authorization_denied` |

---

## 8. What this API deliberately does not do

- **No live queue position or ETA.** Phase 9.
- **No SMS or notification.** The templates table exists; nothing sends.
- **No real disbursal.** `PAID` records a reference from elsewhere.
- **No correction path.** The state machine has no reverse edge, so a mistyped
  weight cannot be amended after quality is recorded. Correcting a closed record
  is an administrative act with its own audit requirements, and putting it
  behind an officer's ordinary permission would be wrong.
- **No no-show sweep job.** A farmer who never arrives stays `CONFIRMED` until an
  officer marks it.
- **No storage headroom check.** Every centre is `ADVISORY` with no linked
  facility, so there is no capacity to check (D-10).
