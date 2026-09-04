# PS 26032 — Requirement Traceability Matrix

**Problem:** *"Farmers often face long waiting times, lack of information regarding procurement schedules and uncertainty about procurement status."*

**Description:** *"A platform like this enables farmer registration and slot booking, provides real time queue management, sends SMS/app notifications, tracks procurement and payment status."*

> Nothing below is claimed without repository evidence. Where a capability exists only in the API and not in the UI, the table says so.

---

## 1. Matrix

| PS Requirement | Implementation | API / Screen | Database / Domain | Tests | Status |
|---|---|---|---|---|---|
| **Farmer registration** | OTP registration, consent capture, minimal-data model (no Aadhaar, no bank details — D-6/D-7) | `POST /auth/farmer/register/start-otp`, `/auth/otp/verify`, `/auth/otp/resend` · UI `/` `/verify-otp` `/login` | `users`, `farmers`, `otp_challenges`, `pending_registrations`, `consents`, `sessions` | `auth.test.ts` (41), incl. **public-only registration bootstrap** | **API complete.** UI is a prototype, not wired |
| **Slot booking** | Quantity-derived time windows on lanes; six independent overbooking defences | `POST /bookings/availability`, `POST /bookings` (Idempotency-Key), `GET /bookings/me`, `GET /bookings/:code`, `POST /bookings/:code/cancel` · UI `/book-slot` `/booking-confirmation` `/my-booking` | `bookings`, `centre_slot_configurations`, `centre_service_lanes`, `centre_daily_capacity`, `idempotency_keys` · `engines/scheduling.ts` | `booking.test.ts` (46) — incl. concurrent-booking non-overlap, exclusion constraint proven at DB level | **API complete.** UI not wired |
| **Procurement schedule information** | Centre operating hours, holidays, lane counts, booking horizon, per-centre slot configuration — all temporal and configured, none hardcoded | `GET /reference/centres`, `/reference/crops`, `/reference/booking-constraints`, `POST /bookings/availability` | `procurement_centres`, `centre_operating_hours`, `centre_holidays`, `centre_crop_configurations` | `farmer.test.ts` (29), `booking.test.ts` — Hathras' 09:00–17:00 proven to be configuration, not a special case | **API complete** |
| **Real-time queue management** | Derived queue projection: membership by procurement timestamps, per-lane cursors, deterministic total ordering | `GET /bookings/:code/queue`, `GET /officer/centres/:id/queue` · UI `/queue` | Derived from `bookings` + `procurements`; **nothing stored** (P-1) · `engines/queue.ts` | `queue.test.ts` (52) — incl. **300-case generated-state invariant test** | **API complete.** UI not wired |
| **ETA** | Evidence-based, with explicit confidence: `OBSERVED` / `PROJECTED` / `SCHEDULED` / `UNAVAILABLE`+reason. Never a fabricated number | Same endpoints; `etaConfidence`, `etaBasis`, `etaUnavailableReason` | `centre_slot_configurations.minimum_processing_minutes`, `transition_buffer_minutes`, `procurements.service_started_at` | `queue.test.ts` — early finish, overrun, floor, all four unavailable reasons | **API complete** |
| **SMS / app notifications** | Transactional outbox; dedupe by UNIQUE constraint; per-locale (en/hi); provider-neutral | `GET /notifications`, `/notifications/unread-count`, `POST /notifications/:id/read`, `/notifications/read-all` · UI `/notifications` | `notifications`, `notification_templates`, `notification_event_t` (10 keys) · `engines/notifications.ts` | `notifications.test.ts` (39) — rollback safety, dedupe at DB level, ownership isolation | **App notifications complete. Real SMS NOT configured — DEMO adapter only** |
| **Track procurement status** | Full lifecycle recorded by officers: arrival, weighing, gross weight, quality, completion | `POST /officer/bookings/:code/{arrive,weighing,weight,quality,complete}`, `GET /bookings/:code/procurement` · UI `/procurement` | `procurements`, `booking_status_transitions` (11 rows) + BEFORE UPDATE trigger, `booking_status_history` | `officer.test.ts` (60) — illegal transitions refused **by the database** when the service is bypassed | **API complete.** No officer UI |
| **Track payment status** | MSP resolved by D-9 identity (crop+season+year+**grade**); money computed in PostgreSQL `numeric` | `POST /officer/bookings/:code/complete`, `/payment`, `GET /bookings/:code/payment` · UI `/payment` | `payments`, `msp_rates` (23 OFFICIAL) · `engines/procurement.ts` | `officer.test.ts` — wheat prices; **paddy blocks with `MSP_AMBIGUOUS` until graded** | **Status tracking complete. No disbursal — by design (D-7)** |
| **Reduction of waiting time** | A booking reserves a *quantity-sized interval on a specific lane*, not a bucket. Two bookings can never overlap on a lane (GiST exclusion constraint). Arrival is by appointment | `POST /bookings` + `GET /bookings/:code/queue` | `bookings_no_lane_overlap`, `bookings_no_farmer_overlap`, `centre_daily_capacity` | `booking.test.ts` — parallel bookings asserted non-overlapping | **Mechanism implemented.** Real-world reduction not measured — no field data |
| **Reduction of uncertainty** | The farmer can see, at any time: booking, token, lane, queue position, ETA **with its confidence**, procurement stage, payment status, and *why* a payment is blocked | `/bookings/:code`, `/queue`, `/procurement`, `/payment`, `/notifications` | All of the above | All suites | **Implemented at API level** |

---

## 2. Evidence summary

| | Count |
|---|---|
| Automated tests | **269**, 66 suites, 0 fail, 0 skipped |
| SQL verification probes | **50** (schema 23, Phase 4 15, D-9 12) |
| API routes, all permission-declared | **44** |
| Migrations | **14**, forward-only |
| Database tables | 48, with 172 CHECK constraints and 7 GiST exclusion constraints |

---

## 3. Where the claim stops

Stated plainly so nothing in this matrix is over-read:

1. **The React frontend is a prototype and is not connected to the API.** Every screen reads `localStorage`. The capabilities above are demonstrated through the API.
2. **There is no officer UI.** Officer operations are API-only.
3. **No real SMS is sent.** The outbox and provider interface are real; the adapter is DEMO.
4. **No money moves.** Mandi Sahayak tracks payment *status* (decision D-7); it does not disburse.
5. **"Reduction of waiting time" is a mechanism, not a measurement.** No field trial has been run.
6. **The five centres are CONFIGURED demonstration data**, not real government procurement centres.
7. **The 23 MSP rates are OFFICIAL but single-sourced** and remain independently unverified (`last_verified_at IS NULL`).
