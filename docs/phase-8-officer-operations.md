# FarmQueue — Phase 8: Officer Operations

**Status:** design document, written **before** implementation as required
**Date:** 2026-09-02
**Scope:** the booking lifecycle from arrival at the centre to a resolved payment, driven by officers; plus the farmer's read of their own procurement and payment record.
**Not in scope:** live queue position and dynamic ETA (Phase 9), SMS, notifications, frontend, officer UI, real payment disbursal, the no-show sweep job.

---

## 1. What Phase 8 adds, and what it deliberately does not

Phase 7 ends at `CONFIRMED`. A farmer holds a window on a lane. Nothing that happens **at** the centre is recorded anywhere.

Phase 8 records it. The unit of work is a **procurement**: one row, one booking, created when the farmer arrives and closed when the produce has been weighed, graded, and priced against MSP.

**No migration is written in this phase.** Every table, constraint, transition and permission Phase 8 needs already exists — `procurements`, `payments`, `booking_status_transitions`, `booking_status_history`, and ten permission codes granted to `OFFICER` that no route has yet claimed. Phase 8 is the code that finally uses them. If this phase needed a schema change, that would be evidence the Phase 2 design was wrong; it did not.

---

## 2. The state machine is already the contract

`booking_status_transitions` holds the lifecycle **as data**, and a `BEFORE UPDATE` trigger on `bookings` rejects any pair absent from it. The eleven rows, unchanged by this phase:

| from | to | who acts |
|---|---|---|
| `CONFIRMED` | `ARRIVED` | officer |
| `CONFIRMED` | `NO_SHOW` | officer (or a future sweep job) |
| `CONFIRMED` | `CANCELLED` | farmer — **Phase 7** |
| `ARRIVED` | `WEIGHING` | officer |
| `WEIGHING` | `QUALITY_CHECK` | officer, on recording gross weight |
| `QUALITY_CHECK` | `PROCUREMENT_RECORDED` | officer, on recording accepted/rejected |
| `PROCUREMENT_RECORDED` | `PAYMENT_PENDING` | officer, on completing the procurement |
| `PAYMENT_PENDING` | `COMPLETED` | officer/admin, when payment resolves |
| `ARRIVED`, `WEIGHING`, `QUALITY_CHECK` | `CANCELLED` | officer, at the centre |

**Every Phase 8 endpoint performs exactly one of these transitions.** The service layer checks the current status to produce a good error code; the database refuses the transition regardless. Both layers exist on purpose: the check gives a `409 INVALID_STATE_TRANSITION` with a readable code, the trigger guarantees that no code path — including a future one written carelessly — can move a booking sideways.

There is no generic "set status to X" endpoint, and there will not be one.

### 2.1 What has no transition, and therefore cannot happen

`NO_SHOW` and `COMPLETED` have no outgoing rows. A no-show cannot be un-marked and a completed booking cannot be reopened. That is a deliberate property of the seeded machine, not an oversight, and Phase 8 does not add an escape hatch: a correction to a closed record is an administrative act with its own audit requirements, and inventing one here would put it behind an officer's ordinary permission.

`CANCELLED` likewise has no outgoing rows, so the capacity released by a centre-side cancellation cannot be silently reclaimed by the same booking.

---

## 3. Authorization: assignment, not role

An officer's `OFFICER` role grants the *ability* to record arrivals. It does not say **where**. The scope is `officer_centre_assignments`, resolved into `Actor.centreIds` at session load, and applied by `actorMayActOnCentre()` — defined in Phase 5, unused until now, and used by every officer route below.

```
role       -> may I perform this kind of act at all?   (requirePermission)
assignment -> may I perform it on THIS booking?        (actorMayActOnCentre)
```

Both are required. Neither substitutes for the other.

**A booking outside the officer's assigned centres returns `404`, never `403`** — the same rule Phase 7 applies to a farmer reading another farmer's booking. An officer at Agra must not be able to confirm that a booking code exists at Mathura by the shape of the refusal.

### 3.1 The grant matrix already separates operating from administering

Read from the seeded database, not restated by hand:

| permission | FARMER | OFFICER | ADMIN |
|---|:--:|:--:|:--:|
| `booking.advance_state` | | yes | |
| `booking.mark_no_show` | | yes | |
| `booking.read.centre` | | yes | yes |
| `booking.search.centre` | | yes | yes |
| `procurement.record_weight` | | yes | |
| `procurement.record_quality` | | yes | |
| `procurement.complete` | | yes | |
| `payment.update_status` | | yes | yes |
| `procurement.read.own` | yes | | |
| `payment.read.own` | yes | | |

**An ADMIN cannot record a weight.** Admins configure centres, import MSP and assign officers; they do not stand at the weighbridge. This is a real non-grant and is verified by test, not assumed.

---

## 4. Endpoints

`{code}` is the public `FQ-YYYY-NNNNNNN` booking code. UUIDs never appear in an officer-facing URL any more than in a farmer-facing one.

### Officer

| Method | Path | Permission | Transition |
|---|---|---|---|
| GET | `/api/v1/officer/centres/{centreId}/bookings` | `booking.read.centre` | — |
| GET | `/api/v1/officer/bookings/search` | `booking.search.centre` | — |
| GET | `/api/v1/officer/bookings/{code}` | `booking.read.centre` | — |
| POST | `/api/v1/officer/bookings/{code}/arrive` | `booking.advance_state` | `CONFIRMED` to `ARRIVED` |
| POST | `/api/v1/officer/bookings/{code}/no-show` | `booking.mark_no_show` | `CONFIRMED` to `NO_SHOW` |
| POST | `/api/v1/officer/bookings/{code}/weighing` | `booking.advance_state` | `ARRIVED` to `WEIGHING` |
| POST | `/api/v1/officer/bookings/{code}/weight` | `procurement.record_weight` | `WEIGHING` to `QUALITY_CHECK` |
| POST | `/api/v1/officer/bookings/{code}/quality` | `procurement.record_quality` | `QUALITY_CHECK` to `PROCUREMENT_RECORDED` |
| POST | `/api/v1/officer/bookings/{code}/complete` | `procurement.complete` | `PROCUREMENT_RECORDED` to `PAYMENT_PENDING` |
| POST | `/api/v1/officer/bookings/{code}/cancel` | `booking.advance_state` | `ARRIVED`/`WEIGHING`/`QUALITY_CHECK` to `CANCELLED` |
| POST | `/api/v1/officer/bookings/{code}/payment` | `payment.update_status` | `PAYMENT_PENDING` to `COMPLETED` on `PAID` |

### Farmer

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/bookings/{code}/procurement` | `procurement.read.own` |
| GET | `/api/v1/bookings/{code}/payment` | `payment.read.own` |

Both resolve ownership inside the query, exactly as Phase 7 does.

---

## 5. Why no `Idempotency-Key`

Phase 7 requires one on `POST /bookings` because a replayed create has no natural defence: it would produce a second booking.

Phase 8's transitions defend themselves. A replayed `arrive` finds the booking already `ARRIVED` and returns `409 INVALID_STATE_TRANSITION` — which is the correct answer to a double-tap, not a failure to handle one. Adding idempotency keys would add a table write, a header requirement and a second way to be wrong, in exchange for turning a correct `409` into a replayed `200`.

Concurrency between two officers is handled where it actually occurs: the booking row is taken `FOR UPDATE` at the top of every mutating transaction, so the second officer's transaction waits, then observes the new status and is refused.

---

## 6. The procurement record

One row per booking, `UNIQUE (booking_id)`. Created by `arrive`, never by anything else.

| Step | Columns written |
|---|---|
| `arrive` | `booking_id`, `centre_id`, `officer_user_id`, `arrived_at = now()`, `status = 'IN_PROGRESS'` |
| `weighing` | `service_started_at = now()` |
| `weight` | `gross_quantity_kg` |
| `quality` | `accepted_quantity_kg`, `rejected_quantity_kg`, `grade`, `moisture_percent`, `quality_status`, `rejection_reason` |
| `complete` | `service_ended_at = now()`, `completed_at = now()`, `status = 'COMPLETED'` |

`officer_user_id` is the officer who **received** the farmer, and is not overwritten by later steps. Per-step attribution is not lost: every transition writes `booking_status_history.changed_by_user_id` and an `audit_logs` row in the same transaction.

### 6.1 `quality_status` is derived, never accepted from the client

The officer reports two measured quantities. The classification follows from them:

```
accepted = 0                     -> REJECTED
accepted = gross and rejected = 0 -> ACCEPTED
otherwise                        -> PARTIALLY_ACCEPTED
```

Sending `qualityStatus` in the request body is not supported — the field does not exist in the schema. A status that could disagree with the numbers it summarises is a status worth deriving.

`rejection_reason` is **required** when `rejected > 0` and refused when `rejected = 0`.

### 6.2 `accepted + rejected <= gross`, not `=`

`procurements_quantity_balance` permits a shortfall, and Phase 8 does not tighten it. Moisture loss, cleaning and screenings are real; a system that insists the arithmetic closes exactly forces officers to falsify one of the three numbers. The API validates the same inequality so the error is a `400` with a code rather than a constraint violation.

### 6.3 Weighed quantity is not booked quantity

`QuantityKgSchema` (2 500–5 000 kg, integer) constrains what a farmer may **request**. It must not be reused here. What actually arrives on the weighbridge is a measurement: `numeric(12,3)`, strictly positive, at most three decimal places.

**No business ceiling on gross weight is configured, because none has been specified.** The upper bound applied is the column's own headroom, not a policy, and is documented as such. Inventing "gross must be within 10 % of booked" would be fabricating a rule the brief never states.

---

## 7. Payment: MSP resolution is where the honesty lives

`complete` computes the payment entitlement in the same transaction that closes the procurement.

### 7.1 The identity that must be matched

Decision **D-9** (migration 0013) fixed the identity of an MSP rate as:

```
crop + season + marketing_year + grade
```

A booking carries `crop_id`, `season_id` and `marketing_year`. It does **not** carry a grade — grade is not knowable at booking time. It becomes knowable at quality check, and only then.

**So the grade the officer records is what resolves the rate.** This is not a convenience; it is the only point in the lifecycle where the fourth component of the identity exists.

### 7.2 The resolution rule

Candidates are the `ACTIVE` rates for the booking's crop, season and marketing year.

| Candidates | Recorded grade | Outcome |
|---|---|---|
| 0 | any | `BLOCKED` / `NO_ACTIVE_MSP` |
| exactly 1 | any | resolved to that rate |
| more than 1 | none recorded | `BLOCKED` / `MSP_AMBIGUOUS` |
| more than 1 | matches one | resolved to that rate |
| more than 1 | matches none | `BLOCKED` / `NO_ACTIVE_MSP` |

Grade comparison is case-insensitive and trimmed. It is not fuzzy: `Grade A` matches `grade a`, and nothing matches `Premium`.

### 7.3 This is observable in the seeded data, not hypothetical

| Crop | Active rates | Behaviour |
|---|---|---|
| **Wheat** (RMS 2026-27) | one, ungraded, 2 585.00 per quintal | resolves with or without a grade |
| **Paddy** (KMS 2026-27) | two — `Common` 2 441.00, `Grade A` 2 461.00 | **blocks** unless the officer records a grade |

Wheat is bookable at four of the five demonstration centres and Paddy at two, so both paths are reachable end to end and both are tested.

A blocked payment is not an error. It is the system declining to invent a price for produce whose grade nobody recorded, and saying which of the two it needs.

### 7.4 Arithmetic

Computed **in SQL, in `numeric`** — never in JavaScript floating point, and never on a value that has passed through a `double precision`:

```sql
base_amount_paise = ROUND(accepted_quantity_kg / 100.0 * rate_per_quintal_paise)::bigint
amount_paise      = GREATEST(base_amount_paise - deductions_paise, 0)
```

`rate_per_quintal_paise_snapshot` stores the rate **as it was at the moment of computation**. A later MSP revision must never retroactively change what a farmer was told they would be paid; `payments_unblocked_requires_amount` makes the snapshot mandatory for any non-blocked payment.

`deductions_paise` is **0** and `deduction_breakdown` is `[]`. No deduction policy is configured, and an empty policy means *no deductions*, not *deductions unknown*. Mandi fees, commission and transport are real in the domain and deliberately absent here: none of them has an authoritative configured source in this system yet.

### 7.5 Accepted quantity of zero

A fully rejected consignment still produces a payment row, with `base = amount = 0` and status `PENDING`. Zero is the correct entitlement and is a different fact from "blocked" — the price *was* resolvable; the accepted quantity was nil.

### 7.6 Payment status, and what closes the booking

`payments.status`: `BLOCKED` -> `PENDING` -> `INITIATED` -> `PAID` / `FAILED` / `ON_HOLD`.

`POST /officer/bookings/{code}/payment` moves it. **`PAID` requires a `paymentReference`**, enforced by `payments_paid_requires_reference`; there is no disbursal integration in this phase and the reference is what an external system provides.

**The booking transitions `PAYMENT_PENDING` to `COMPLETED` only when the payment reaches `PAID`.** `FAILED` and `ON_HOLD` leave the booking open, because the work is not finished.

A `BLOCKED` payment cannot reach `PAID`, so its booking stays in `PAYMENT_PENDING` until the MSP situation is resolved. **This is a real, deliberate dead end and it is documented as a carried risk (R-8a), not hidden.** Unblocking requires an MSP import or a grade correction, both administrative acts outside this phase.

---

## 8. Capacity: what a no-show and a centre cancellation release

The lane exclusion constraints are partial on the six active statuses. `NO_SHOW`, `CANCELLED` and `COMPLETED` are not among them, so the interval is released by the status change itself, with no code.

`centre_daily_capacity` is a counter and is not automatic. Phase 7 decrements it on farmer cancellation. Phase 8 decrements it on **no-show** and on **centre-side cancellation** — the produce never arrived, or arrived and was turned away, so the day's booked total should not continue to include it.

It is **not** decremented on `COMPLETED`. That capacity was genuinely consumed; the work was done.

---

## 9. Officer reads

### 9.1 The day list

`GET /officer/centres/{centreId}/bookings?date=YYYY-MM-DD&status=...`

Ordered by `scheduled_start_at`, which is what `bookings_centre_date_start_idx` is for. `date` defaults to **today in the centre's timezone**, never the server's. The centre must be one of the officer's assignments.

This is not the live queue. Queue position and dynamic ETA are Phase 9 and are derived from what officers have recorded here — which is why they come after this phase and not before.

### 9.2 Search

`GET /officer/bookings/search?q=`

Accepts a booking code (`FQ-...`), a bare token number, or a 10-digit phone. **Results are restricted to the officer's assigned centres in the SQL**, not filtered afterwards — a query that could return a row and then hide it is a query that will eventually leak one.

A phone that belongs to no farmer, and a phone whose farmer has no booking at an assigned centre, return the same empty list.

---

## 10. Farmer reads

`GET /bookings/{code}/procurement` and `GET /bookings/{code}/payment` return the record for the farmer's own booking, `404` otherwise.

The procurement view exposes the measurements and timestamps. The payment view exposes the rate snapshot, base, deductions, amount, status and — when blocked — the reason code. **The farmer is shown `blockedReason` rather than an empty amount with no explanation**, because "we cannot price this until a grade is recorded" is information the farmer is entitled to, and P-8 requires it as a code the UI can translate.

`404` before the officer has created anything: a procurement that has not begun is not an empty object, it is absent.

---

## 11. Error codes added

All follow P-8: stable, machine-readable, never English prose as the contract.

| Code | Status | Meaning |
|---|---|---|
| `PROCUREMENT_NOT_STARTED` | 404 | No procurement row exists for this booking yet |
| `WEIGHT_ALREADY_RECORDED` | 409 | Gross weight is already set |
| `QUANTITY_EXCEEDS_GROSS` | 400 | `accepted + rejected > gross` |
| `REJECTION_REASON_REQUIRED` | 400 | `rejected > 0` with no reason |
| `REJECTION_REASON_NOT_APPLICABLE` | 400 | reason supplied with `rejected = 0` |
| `PAYMENT_NOT_READY` | 409 | Payment status change attempted before `complete` |
| `PAYMENT_BLOCKED` | 409 | Status change attempted on a `BLOCKED` payment |
| `PAYMENT_REFERENCE_REQUIRED` | 400 | `PAID` without a reference |
| `INVALID_PAYMENT_TRANSITION` | 409 | e.g. `PAID` back to `PENDING` |

A booking at a centre the officer is not assigned to has **no code of its own**: it is `NOT_FOUND`, deliberately indistinguishable from a booking that does not exist (§3).

`INVALID_STATE_TRANSITION`, `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED` and `RATE_LIMITED` are reused from Phases 5–7 rather than duplicated.

---

## 12. Test plan

Split the way Phase 7 split, for the same reason: what can be proved without a database should be, and what cannot must be proved against a real one.

**Pure** (`engines/procurement.ts` — no I/O, no clock):
- `quality_status` derivation across all three outcomes and the boundaries
- MSP candidate resolution: 0 / 1 / many, grade present, absent, matching, non-matching, case and whitespace
- payment arithmetic including the zero-accepted case and rounding

**Integration** (real HTTP, real PostgreSQL):
- the full happy path `CONFIRMED` through `COMPLETED` for **wheat**, asserting the amount against the seeded rate
- **paddy without a grade** blocks with `MSP_AMBIGUOUS`; **paddy with `Grade A`** resolves to 2 461.00 per quintal
- every out-of-order transition refused with `409`, and refused **by the database** when the service check is bypassed
- an officer at another centre gets `404` on read, arrive, weight, quality and complete
- an **ADMIN** is refused `procurement.record_weight` with `403`
- a **farmer** is refused every officer endpoint
- no-show releases the lane: the freed window becomes bookable again
- two officers arriving the same booking concurrently: one `200`, one `409`
- a farmer reads their own procurement and payment; another farmer gets `404`
- `PAID` without a reference is refused; with one, the booking completes
- the payment `blockedReason` reaches the farmer's payment view

---

## 13. Files

```
server/src/
  engines/procurement.ts               PURE — quality derivation, MSP choice, money
  modules/officer/
    officer.routes.ts                  HTTP, permissions, centre scope
    officer.service.ts                 transitions, transaction boundaries
    officer.repository.ts              SQL, the FOR UPDATE, the day list, search
  domain/quantity.ts                   + WeighedKgSchema (measurement, not request)
  core/errors.ts                       + the codes in §11
  core/audit.ts                        + the Phase 8 audit actions
server/tests/officer.test.ts
docs/api/officer.md
```

`bookings.repository.ts` is **reused, not forked** — `BOOKING_SELECT`, `recordStatusChange`, `bumpDailyCapacity` and `ACTIVE_STATUSES` already say what Phase 8 needs them to say. A second definition of any of them would be a second thing to keep true.

---

## 14. Risks accepted going in

| | Item |
|---|---|
| **R-8a** | A `BLOCKED` payment strands its booking in `PAYMENT_PENDING`; there is no unblock path in this phase (§7.6) |
| **R-8b** | No no-show sweep job. A farmer who never arrives keeps the booking `CONFIRMED` until an officer marks it. The `bookings_service_date_active_idx` partial index exists for that job; the job does not |
| **R-8c** | `deductions_paise` is always 0 (§7.4) — correct as configuration, incomplete as procurement domain |
| **R-8d** | No correction path for a mistyped weight once quality is recorded; the state machine has no reverse edge (§2.1) |
| **R-8e** | Grade is free text validated only against active MSP rates at completion. A typo is discoverable at `complete`, not at `quality` |
