# Mandi Sahayak — Phase 10 Report: Notifications & Farmer Status Updates

**Phase:** 10 — notification outbox, farmer status updates, DEMO delivery
**Date:** 2026-09-03
**Status:** **COMPLETE AND VERIFIED** against PostgreSQL 17.11
**Design contract:** [`phase-10-notifications.md`](./phase-10-notifications.md), written before implementation
**API contract:** [`api/notifications.md`](./api/notifications.md)

> **Real SMS delivery is NOT configured in this phase because no approved provider credentials/configuration exist. The system implements a provider-neutral notification/outbox layer and DEMO delivery adapter.**

---

## 1. Scope

Connect the state changes Phases 7–9 already produce to a durable, farmer-readable notification system, and expose it through authenticated farmer APIs.

**Scope note.** The roadmap ambiguity reported in `phase-10-roadmap-recovery.md` was resolved by explicit product-owner authorisation of the scope implemented here. The historical numbering conflict itself is **not** resolved by this phase and remains recorded in that document.

---

## 2. Architecture

Transactional outbox, exactly as architecture §16.1 specifies:

```
BEGIN
  → lock entity (SELECT … FOR UPDATE)
  → mutate business state
  → booking_status_history / procurement / payment
  → writeAudit                     (P-9)
  → enqueue notification           (Phase 10, SAME transaction, no network call)
COMMIT
                    │
                    ▼   separate transaction, invoked explicitly
      dispatchPending() → claim FOR UPDATE SKIP LOCKED → DevNotificationProvider → SENT | FAILED
```

Three properties this buys, each tested:

1. **If the business transaction rolls back, no notification exists.**
2. **If the enqueue fails, the business mutation rolls back with it.**
3. **No transport is involved in a business transaction** — a booking cannot fail because a provider is down.

---

## 3. Files created

| Path | Lines | Purpose |
|---|---:|---|
| `server/migrations/0014_notification_events.sql` | 84 | Widen `notification_event_t` by two keys |
| `server/src/engines/notifications.ts` | 214 | **PURE** — dedupe keys, en/hi copy, titles |
| `server/src/integrations/notifications/provider.ts` | 88 | Provider interface + `DevNotificationProvider` |
| `server/src/modules/notifications/notifications.repository.ts` | 246 | Outbox SQL, ownership-scoped feed, dispatch claim |
| `server/src/modules/notifications/notifications.service.ts` | 233 | Enqueue helpers, feed views, dispatch |
| `server/src/modules/notifications/notifications.routes.ts` | 147 | Four farmer routes |
| `server/tests/notifications.test.ts` | 734 | 39 tests |
| `docs/phase-10-notifications.md` | — | Design contract |
| `docs/api/notifications.md` | — | API contract |
| `docs/phase-10-report.md` | — | This report (replaces the earlier BLOCKED report) |

## 4. Files modified

| Path | Change | Behaviour change |
|---|---|---|
| `server/src/core/audit.ts` | +`NOTIFICATION_DISPATCHED` | Additive |
| `server/src/core/rateLimit.ts` | +`NOTIFICATION_READ_PER_SESSION` (400/15 min) | Additive |
| `server/src/app.ts` | Mounts `buildNotificationsRouter()` | Additive |
| `server/src/modules/bookings/bookings.service.ts` | +1 call after the existing audit, inside the transaction | **Enqueues `BOOKING_CONFIRMED`** — closes the architecture §13.1 step-9 gap |
| `server/src/modules/officer/officer.service.ts` | +4 calls inside existing transactions | Enqueues arrival, completion, blocked and status events |
| `server/README.md` | Counts 226→265; layout | Docs only |
| `server/package.json` | 0.9.0 → 0.10.0; description | Metadata |

**No frontend file was modified.** No existing test was modified. No contract listed under "DO NOT BREAK" was touched: MSP resolution, payment arithmetic, queue membership, the booking state machine, authentication, RBAC, geography and government data are all unchanged.

## 5. Migrations

**One: `0014_notification_events.sql`.** Forward-only. Migrations 0001–0013 untouched.

It widens `notification_event_t` from 8 to 10 keys, adding `BOOKING_ARRIVED` and `PAYMENT_BLOCKED`, which were required by the phase and absent from the domain.

**This weakens no invariant.** Widening a permitted set is additive: every value legal before is still legal, every value legal now is still explicitly enumerated, and the migration asserts in a `DO` block that all eight original keys survived — a widening that silently dropped one would be a narrowing for existing rows.

**Naming:** the brief named an event `PAYMENT_STATUS_UPDATED`. The repository already established `PAYMENT_UPDATED` (architecture §16.4 and migration 0001), and the brief says not to copy its example when a convention exists — so the existing name is used and no second name was introduced for the same fact.

**No column, table, index or trigger was added, and no data of any kind was inserted.**

## 6. API endpoints

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/api/v1/notifications?unread=&limit=` | `notification.read.own` | — |
| GET | `/api/v1/notifications/unread-count` | `notification.read.own` | — |
| POST | `/api/v1/notifications/:id/read` | `notification.update.own` | yes |
| POST | `/api/v1/notifications/read-all` | `notification.update.own` | yes |

Registry total **44 routes**, deny-by-default assertion passing.

**Permissions added: none.** Both already existed and were already granted to FARMER only.

## 7. Notification event matrix

| Event | Trigger | Transaction | Dedupe key | Wired |
|---|---|---|---|:--:|
| `BOOKING_CONFIRMED` | Booking commits | `createBooking` | `booking:<id>:BOOKING_CONFIRMED` | yes |
| `BOOKING_ARRIVED` | Officer arrival | `recordArrival` | `booking:<id>:BOOKING_ARRIVED` | yes |
| `PROCUREMENT_COMPLETED` | Officer completes | `completeProcurement` | `booking:<id>:PROCUREMENT_COMPLETED` | yes |
| `PAYMENT_BLOCKED` | MSP unresolvable at completion | `completeProcurement` | `payment:<id>:PAYMENT_BLOCKED` | yes |
| `PAYMENT_UPDATED` | Payment status advances | `updatePaymentStatus` | `payment:<id>:PAYMENT_UPDATED:<status>` | yes |
| `QUEUE_APPROACHING` | — | — | — | **NO — §13** |

## 8. Transaction boundaries

Enqueue takes a `PoolClient`, never the pool — that is what makes the outbox an outbox. `ON CONFLICT (dedupe_key) DO NOTHING` absorbs replays; **any other error propagates and aborts the business transaction.** Dispatch runs in its own transaction and is the only place a provider is touched.

## 9. Idempotency strategy

`dedupe_key UNIQUE` — the database, not an application check (§16.2). Keys follow the established `entity:id:EVENT[:qualifier]` convention. `PAYMENT_UPDATED` is qualified by status because §16.4 scopes its dedupe to payment + status: `INITIATED` then `PAID` are two facts a farmer should hear about, not one repeated.

Proved by test in two ways: an idempotent booking replay produces exactly one notification, and a direct re-insert of an identical dedupe key **bypassing the service entirely** is absorbed by the constraint.

## 10. Ownership / security model

| Control | Implementation |
|---|---|
| Identity | From the session. **No `farmerId`/`userId` parameter exists** |
| Ownership | Inside the SQL on every read and every write |
| Cross-farmer read | `404`, and the row is not returned |
| Cross-farmer write | `404`, and **the row is not modified** (asserted on the row itself) |
| Unauthenticated | `401` |
| Officer / admin | `403` — permissions are FARMER-only |
| CSRF | Enforced on both POSTs; verified by sending without the token |
| Rate limiting | `notification_read_session`, 400/15 min, per session |
| UUID exposure | Only the notification's own id; booking by `bookingCode` |
| Sensitive leakage | Renderer is pure and given only farmer-visible values; a suite-wide scan asserts no body contains a UUID, credential, token or SQL fragment |

## 11. Delivery-provider model

`NotificationProvider { name, isRealDelivery, send() }`. One implementation: `DevNotificationProvider` — **no network call**, `warn`-level log with an explicit `DEMO` marker, provider id prefixed `DEMO-`, `isRealDelivery = false`.

`FAILED` records the error **message only** — never a stack, query or connection string — and `attempts` is bounded by the `notifications_attempts_within_limit` schema CHECK, so an infinite retry loop is structurally impossible.

## 12. Test results

**All green, twice, from zero.**

| Check | Result |
|---|---|
| `npm test` | **265 / 265 pass**, 65 suites, 0 fail, 0 skipped |
| Phase 10 alone | **39 / 39 pass**, 10 suites (13 pure + 26 integration) |
| `tsc --noEmit` | clean |
| `static-check.mjs` | PASSED — 0 failures, 0 warnings; 14 migrations, 48 tables, 130 indexes, 172 CHECK, 7 EXCLUDE |
| `verify-schema.sql` | 23 / 23 |
| `verify-phase4.sql` | 15 / 15 |
| `verify-d9.sql` | 12 / 12 |
| SQL probes total | **50 / 50** |
| Route protection | 44 routes, assertion passes |

**Baseline before Phase 10: 226 tests / 55 suites.** 265 − 226 = 39, exactly the Phase 10 additions, with **no existing test modified** and Phases 1–9 fully green.

### 12.1 Clean-database verification #1 and #2

Both runs: database dropped and recreated, all 14 migrations applied from zero, then the full sequence.

```
ready: 14 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings
tsc --noEmit ........ CLEAN
static-check ........ PASSED — 0 failures, 0 warnings
npm test ............ ℹ tests 265  ℹ suites 65  ℹ pass 265  ℹ fail 0  ℹ skipped 0
verify-schema ....... PASSED: 23 checks
verify-phase4 ....... PASSED: 15 checks
verify-d9 ........... PASSED: 12 checks
```

Identical across both runs. The `0014` domain widening was confirmed by reading the live constraint back, showing all ten keys.

### 12.2 The one failure, and its fix

- **Failure:** `audits a dispatch run` — `column "created_at" does not exist`.
- **Root cause:** **the test was wrong, not the code.** `audit_logs` timestamps its rows `occurred_at`; the test ordered by `created_at`.
- **Fix:** the test's `ORDER BY`. No production code changed.
- **Regression cover:** the corrected test, which asserts the dispatch audit row records `provider: DEV_DEMO` and `realDelivery: false`.

### 12.3 Coverage against the brief's 18 required cases

All present: booking-confirmation notification (1), persistence (2), duplicate suppression (3), own-list (4), cross-farmer read isolation (5), mark own read (6), cross-farmer mark-read refused **and row unmodified** (7), unread count (8), procurement completion (9), payment blocked (10), payment status (11), rollback on enqueue failure (12), provider not called in the business transaction (13), DEMO delivery clearly labelled (14), route protection (15), CSRF (16), rate limiting (17), no sensitive leakage (18).

## 13. Known limitations

1. **`QUEUE_APPROACHING` is never fired.** The event key, renderer and feed support it, but nothing enqueues it because **no `approaching_position_threshold` exists in the schema and no value has been approved.** Phase 10 does not invent one. Asserted by a test that checks both that no such notification exists and that no threshold column exists to evaluate. **Explicit configuration gap, carried as R-9d.**
2. **No worker, cron or background dispatcher.** `dispatchPending()` is called explicitly.
3. **`IN_APP` channel only.** No SMS row is created, because that would assert a delivery path that does not exist.
4. **No `notification_templates` rows.** Copy is rendered from a pure module and `template_id` stays NULL — a documented deviation from architecture §16.3, taken because template rows are versioned product content that must be DLT-registerable before real SMS.
5. **No quiet hours, per-farmer daily cap, kill switch, retry backoff schedule or retention policy** — dispatcher policies with no approved values.
6. **`ONE_DAY_REMINDER`, `TURN_APPROACHING`, `NO_SHOW_RECORDED`, `BOOKING_CANCELLED`** are permitted by the domain but wired to nothing.
7. **Existing bookings created before this phase have no `BOOKING_CONFIRMED` row.** No backfill was performed.

## 14. DEMO delivery versus real SMS — explicit

| | This build | Real SMS would require |
|---|---|---|
| Provider | `DevNotificationProvider` only | An approved provider + credentials |
| Network call | **None, ever** | Carrier API call |
| Provider message id | `DEMO-<notification id>` | A real carrier id |
| `isRealDelivery` | **`false`** | `true` |
| `realSmsDelivered` in API | **`false` on every notification** | `true` when confirmed |
| Channel | `IN_APP` | `SMS` rows + `to_phone_e164` |
| TRAI DLT | **Not registered; cannot be fabricated** | `dlt_template_id` per template from a registrar |
| Audit | `notification.dispatched` records `realDelivery: false` | Would record the real provider |

**A `SENT` row in this build means the DEMO adapter accepted it. It does not mean a message reached a phone, and nothing in the code, API or logs says otherwise.** No credentials were introduced and no external integration was fabricated.

## 15. PS 26032 requirement mapping

> *"Platform enables farmer registration and slot booking, provides real-time queue management, sends SMS/app notifications, and allows farmers to track procurement and payment status."*

| Requirement | Where | Status |
|---|---|---|
| Farmer registration | Phase 5 — OTP registration, sessions, RBAC | Complete |
| Slot booking | Phase 7 — quantity-derived windows, lane-aware, overbooking-proof | Complete |
| Real-time queue management | Phase 9 — derived position, per-lane ETA with confidence | Complete |
| **App notifications** | **Phase 10 — durable outbox + authenticated farmer feed, en/hi** | **Complete** |
| **SMS notifications** | **Phase 10 — provider-neutral interface; DEMO adapter only** | **Interface complete; real delivery NOT configured (§14)** |
| Track procurement status | Phase 8 read + Phase 10 `BOOKING_ARRIVED`, `PROCUREMENT_COMPLETED` | Complete |
| Track payment status | Phase 8 read + Phase 10 `PAYMENT_UPDATED`, `PAYMENT_BLOCKED` | Complete |

## 16. Remaining risks

| ID | Risk | Status |
|---|---|---|
| **R-9d** | No `APPROACHING` threshold; `QUEUE_APPROACHING` cannot fire | **Unchanged, now also blocking §16.4** |
| **R-8g / R-J** | MSP rates still `last_verified_at IS NULL`, and `PAYMENT_UPDATED` now *communicates* an amount derived from them. **Recommendation: do not enable a real SMS channel for payment amounts until this is closed** — an SMS is pushed, quoted later and hard to retract | **Unchanged, higher stakes** |
| **R-K** | State bonuses unresearched; notifications state the recorded amount without claiming it is the final payable rate | Unchanged |
| **R-10a** | Phase numbering drift unresolved (`phase-10-roadmap-recovery.md`) | Open |
| **R-10c** | Template copy authored in code, not reviewed as product content by a person | Open |
| **R-10d** *(new)* | No dispatcher runs automatically; notifications stay `QUEUED` until `dispatchPending()` is invoked | Open by design |
| R-8a, R-8b, R-8d, R-9b, R-7a, R-7c, R-L | Unchanged from earlier phases | Unchanged |

## 17. Carry-forward / next phase

**Not started, and not begun in this phase.** The natural next items are: a dispatch worker with quiet hours and caps, template rows with DLT ids once a provider is approved, the `APPROACHING` threshold decision, and the outstanding **R-8g MSP cross-check**, which remains the highest-value open item because payment amounts are now not only computed but communicated.

---

## Phase Completion Report

**IMPLEMENTED:** A durable transactional notification outbox wired to five real state changes, a farmer-facing feed with strict ownership isolation, bilingual farmer-safe copy, and a provider-neutral delivery layer with a clearly-labelled DEMO adapter.

**TESTS:** **265/265 pass** overall (was 226); **39/39** for Phase 10. **50/50** SQL probes. `tsc --noEmit` clean. Static checker passed. 44 routes protected. Verified twice from a database built from zero.

**FAILED TESTS:** One on the first run — a test-side column-name error (`created_at` vs `occurred_at`), fixed in the test; no production code changed.

**MIGRATIONS:** One, `0014`, widening a domain by two values. No invariant weakened.

**REAL SMS:** Not configured. No provider, no credentials, no DLT registration, no fabricated receipt.

**STOP.** Phase 10 complete. Phase 11 has not been started. Awaiting approval.
