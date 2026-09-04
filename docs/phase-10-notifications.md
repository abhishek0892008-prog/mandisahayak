# Mandi Sahayak — Phase 10: Notifications & Farmer Status Updates

**Status:** design document, written **before** implementation
**Date:** 2026-09-03
**Scope authority:** explicitly authorised by the product owner for PS 26032 submission
**Governing architecture:** §16 (SMS and notification architecture), §16.1 outbox, §16.2 dedupe-by-constraint, §16.5 provider abstraction

> **Real SMS delivery is NOT configured in this phase because no approved provider credentials/configuration exist. The system implements a provider-neutral notification/outbox layer and DEMO delivery adapter.**

---

## 1. Scope

Connect the state changes Phases 7–9 already produce to a durable, farmer-readable notification system.

Six events, transactionally enqueued with the business change that causes them:

| Event | Fires when | Enqueued in |
|---|---|---|
| `BOOKING_CONFIRMED` | Booking committed | `bookings.service.createBooking` |
| `BOOKING_ARRIVED` | Officer records arrival | `officer.service.recordArrival` |
| `PROCUREMENT_COMPLETED` | Officer completes procurement | `officer.service.completeProcurement` |
| `PAYMENT_BLOCKED` | Completion could not resolve an MSP rate | `officer.service.completeProcurement` |
| `PAYMENT_UPDATED` | Payment status advances | `officer.service.updatePaymentStatus` |
| `QUEUE_APPROACHING` | **Infrastructure only — never fires automatically** | — (see §9) |

Plus an authenticated farmer feed: list, unread count, mark read, mark all read.

## 2. Explicit non-scope

- **No real SMS provider.** No Twilio/MSG91/SNS/Firebase, no credentials, no sender ID, no DLT template id, no fabricated delivery receipt.
- **No background worker, no cron, no retry daemon** (§16.1's dispatch job is deferred; the brief says not to build worker infrastructure in this phase).
- No `ONE_DAY_REMINDER`, `TURN_APPROACHING`, `NO_SHOW_RECORDED`, `BOOKING_CANCELLED` wiring — the domain permits them; nothing enqueues them.
- No changes to MSP resolution, payment arithmetic, queue membership, the booking state machine, authentication, RBAC, geography, or government data.
- No frontend changes.
- No `notification_templates` rows (§7.2).

## 3. Existing architecture reused

Everything below already exists and is reused unchanged:

| Asset | Use |
|---|---|
| `notifications` table | The outbox. `dedupe_key UNIQUE`, `notifications_dispatch_idx`, `attempts ≤ max_attempts`, `sent_consistent`, unread partial index |
| `notification_event_t` domain | Event keys (widened by one migration — §5) |
| `locale_t` (`en`/`hi`), `users.locale` | Per-locale rendering |
| `withTransaction` + `writeAudit` | P-9 same-transaction writes |
| `declareRoute` / `requirePermission` | Deny-by-default route registry |
| `notification.read.own`, `notification.update.own` | **Already exist, already granted to FARMER.** No new permission |
| `consumeAll` / `RateLimits` | Rate limiting, Phase 9 convention |
| 404-not-403 ownership pattern | Enumeration resistance |

## 4. Data model requirements

**Reused as-is.** Delivery states are the schema's own: `QUEUED → SENDING → SENT | FAILED | SUPPRESSED`. The brief's `PENDING` maps to the existing `QUEUED`; no state is invented and no constraint is weakened.

`title` is **not** a column. It is derived deterministically from `event_key` by the pure renderer at read time, so no schema churn is needed for presentation.

## 5. The one migration required

`notification_event_t` currently allows eight keys. Two required events are absent:

- `BOOKING_ARRIVED` — not in the domain
- `PAYMENT_BLOCKED` — not in the domain

`PAYMENT_STATUS_UPDATED` from the brief is **not** added: the established convention in this repository is `PAYMENT_UPDATED` (architecture §16.4 and the domain). The brief says not to copy its example naming when a convention already exists, so the existing name is used.

**Migration `0014_notification_events.sql`** — forward-only, widening only:

```sql
ALTER DOMAIN notification_event_t DROP CONSTRAINT notification_event_t_allowed_values;
ALTER DOMAIN notification_event_t ADD CONSTRAINT notification_event_t_allowed_values
    CHECK (VALUE IN ( ...the original 8..., 'BOOKING_ARRIVED', 'PAYMENT_BLOCKED' ));
```

This **widens** an allowed set; it weakens no invariant, drops no data, and touches migrations 0001–0013 not at all.

## 6. Transaction boundaries

Exactly the existing pattern, with one added step:

```
BEGIN
  → lock the entity (SELECT … FOR UPDATE)
  → mutate business state
  → booking_status_history / procurement / payment write
  → writeAudit                       (P-9)
  → enqueueNotification              (Phase 10 — same transaction)
COMMIT
```

- **If the enqueue fails, the business mutation rolls back.** The insert is not wrapped in a swallow-everything guard.
- **A duplicate is not a failure.** `ON CONFLICT (dedupe_key) DO NOTHING` absorbs replays; any *other* error propagates and aborts the transaction.
- **No network call happens inside the business transaction.** The row is written; delivery is a separate, later step (§8). This is the entire point of the outbox.

## 7. Content

### 7.1 Farmer-safe by construction

The renderer is pure and receives only: booking code, crop name, centre name, service date/time, token, queue position/ETA, payment status, payment amount, and a blocked-reason code. It has no access to SQL errors, audit metadata, internal ids, officer identity, or authentication material.

`PAYMENT_BLOCKED` surfaces the reason **as the farmer-facing code already exposed by `GET /bookings/:code/payment`** (`MSP_AMBIGUOUS`, `NO_ACTIVE_MSP`) rendered into plain language — no new disclosure.

### 7.2 Deviation: copy lives in code, not `notification_templates`

Architecture §16.3 puts per-locale bodies in `notification_templates`. **This phase renders from a pure module and leaves `template_id` NULL** (the column is nullable).

Reason: template rows are versioned product content that must be DLT-registerable before any real SMS; seeding them now would imply an approval that has not happened. A pure renderer is reviewable as code, is exhaustively unit-testable, and keeps one definition of the copy. **Recorded as a documented deviation.** When real SMS is approved, the copy moves into the table and the renderer becomes the fallback.

## 8. Delivery model

```ts
interface NotificationProvider {
  readonly name: string;
  send(input: { notificationId, channel, toPhoneE164, body }): Promise<{ providerMessageId: string }>;
}
```

`DevNotificationProvider` is the only implementation. It performs **no network call**, logs at `warn` with an explicit `DEMO` marker, and returns a provider id prefixed **`DEMO-`** so a delivery record can never be mistaken for a real one.

- Channel used: **`IN_APP`**. No `SMS` row is created, because creating one would assert a delivery path that does not exist. The interface accepts SMS so a real provider drops in without a contract change.
- Dispatch is an **explicit call** (`dispatchPending`), not a daemon. No worker, no cron, no infinite retry.
- `attempts` is incremented and `max_attempts` (schema default 5) is respected; exceeding it lands the row in `FAILED` terminally.
- **Persisted ≠ delivered.** A `QUEUED` row means recorded, not sent.

## 9. `QUEUE_APPROACHING` — infrastructure without a trigger

Phase 9 established that `approaching_position_threshold` and `turn_threshold_minutes` **do not exist in the schema**, and no approved value exists.

Per instruction, and unchanged by this phase: **`QUEUE_APPROACHING` is fully supported by the outbox, the renderer and the feed, but nothing fires it automatically.** No threshold is invented. This remains an explicit configuration gap (carried as R-9d), and the migration that would host a threshold is *not* written here.

## 10. Idempotency

`dedupe_key UNIQUE` — the database, not an application check (§16.2). Keys follow the established `entity:id:EVENT[:qualifier]` convention:

| Event | Key |
|---|---|
| `BOOKING_CONFIRMED` | `booking:<bookingId>:BOOKING_CONFIRMED` |
| `BOOKING_ARRIVED` | `booking:<bookingId>:BOOKING_ARRIVED` |
| `PROCUREMENT_COMPLETED` | `booking:<bookingId>:PROCUREMENT_COMPLETED` |
| `PAYMENT_BLOCKED` | `payment:<paymentId>:PAYMENT_BLOCKED` |
| `PAYMENT_UPDATED` | `payment:<paymentId>:PAYMENT_UPDATED:<status>` — dedupe per §16.4 is payment + status |

## 11. API

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/api/v1/notifications?unread=true&limit=` | `notification.read.own` | — |
| GET | `/api/v1/notifications/unread-count` | `notification.read.own` | — |
| POST | `/api/v1/notifications/:id/read` | `notification.update.own` | yes |
| POST | `/api/v1/notifications/read-all` | `notification.update.own` | yes |

Route ordering is safe: `unread-count` is GET (the `:id` route is POST), and `read-all` is two segments where `:id/read` is three.

**UUID exposure:** the notification's own `id` is exposed because it is the address of the resource. **No other UUID is** — the booking is referenced by `bookingCode`, and `user_id`, `template_id` and `booking_id` never appear.

## 12. Ownership & security

- Ownership is resolved **inside the SQL** from the session's `user_id`. There is no `farmerId` parameter anywhere.
- Another farmer's notification id → **`404`**, identical to a nonexistent id. Marking it read → `404`, and **no row is modified**.
- Officers and admins hold neither `notification.read.own` nor `notification.update.own` → `403`.
- Unauthenticated → `401`.
- CSRF enforced on both POSTs by the app-wide mutating-method guard.
- Rate limiting: a new `NOTIFICATION_READ_PER_SESSION` bucket, derived like Phase 9's from the polling cadence.
- Marking read sets `read_at` only; it **never** touches `status`, `attempts`, `sent_at` or `provider_message_id`.

## 13. Audit

Follows existing architecture: **state changes are audited, reads are not.**

- Enqueue is audited implicitly — it is part of the already-audited business transaction, and the notification row is itself the durable record.
- `notification.dispatched` is added for delivery attempts (a state change with an external-ish effect).
- Marking read is a farmer-private UI action on their own row; not audited, consistent with the Phase 9 decision not to audit reads.
- No OTP, credential, secret or authentication material is ever written to a notification or an audit row.

## 14. Failure modes

| Failure | Behaviour |
|---|---|
| Duplicate event | `ON CONFLICT DO NOTHING` — no duplicate row, no error |
| Enqueue fails for any other reason | Transaction rolls back; the business change does not happen |
| Provider throws | Row → `FAILED`, `attempts` incremented, `last_error` recorded (message only, no stack) |
| `attempts` reaches `max_attempts` | Terminal `FAILED`; no infinite retry |
| Business transaction rolls back | No notification exists |

## 15. Testing strategy

**Pure** (`engines/notifications.ts`): dedupe-key construction, title/body rendering for all six events in `en` and `hi`, farmer-safe content (no internal identifiers), unknown-locale fallback.

**Integration:** each of the five wired events produces exactly one row; replay produces no duplicate; rollback leaves none; the provider is **not** called inside the business transaction (row is `QUEUED` after the call); dispatch marks `SENT` with a `DEMO-` id; ownership isolation on read and on mark-read; RBAC negatives; unauthenticated; CSRF; rate limiting; unread count; no sensitive leakage; route protection.

## 16. Unresolved / carried forward

- **R-9d** — no `APPROACHING` threshold; `QUEUE_APPROACHING` cannot fire (§9).
- **R-8g / R-J** — MSP rates still `last_verified_at IS NULL`. `PAYMENT_UPDATED` transports an amount computed from them. **Recommendation unchanged: do not enable a real SMS channel for payment amounts until this is closed.** No amount is altered by this phase.
- **R-K** — state bonuses unresearched; the payment notification states the recorded amount without claiming it is the final payable rate.
- Real SMS, DLT registration, template rows, dispatch worker, quiet hours, daily caps, retention — all deferred with reasons.
