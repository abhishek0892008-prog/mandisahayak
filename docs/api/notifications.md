# Mandi Sahayak — Notifications API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phase 10)
**Base path:** `/api/v1`
**Companion:** [`authentication.md`](./authentication.md) — cookies, CSRF, error envelope
**Design contract:** [`../phase-10-notifications.md`](../phase-10-notifications.md)

> **Real SMS delivery is NOT configured. There is no approved provider, no credentials, no sender ID and no TRAI DLT template registration. Every delivery record in this system is produced by a DEMO adapter and is labelled as such.**

---

## 1. Endpoints

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/notifications?unread=true&limit=50` | `notification.read.own` | — |
| GET | `/notifications/unread-count` | `notification.read.own` | — |
| POST | `/notifications/:id/read` | `notification.update.own` | yes |
| POST | `/notifications/read-all` | `notification.update.own` | yes |

Both permissions already existed and were already granted to **FARMER only**. Phase 10 adds no permission and changes no grant, so **officers and admins receive `403`** on all four.

---

## 2. Identity and ownership

**There is no `farmerId` or `userId` parameter anywhere** — not ignored, absent. Identity comes from the session, and ownership is resolved **inside the SQL** on every read and every write.

- Another farmer's notification id → **`404`**, identical to an id that does not exist, and **no row is modified**.
- Supplying `?userId=` or `?farmerId=` changes nothing; both are tested.
- Unauthenticated → `401`.

---

## 3. Response shape

```jsonc
{
  "count": 3,
  "unreadCount": 2,
  "notifications": [
    {
      "id": "e0b1…-…-…",              // the resource address; the only UUID exposed
      "type": "PAYMENT_BLOCKED",
      "title": "Payment needs attention",
      "message": "Payment for booking FQ-2026-1234567 is on hold because the grade of your crop has not been recorded yet, so the support price cannot be determined. Please contact the procurement centre.",
      "bookingCode": "FQ-2026-1234567",  // the booking by CODE, never by UUID
      "locale": "en",
      "read": false,
      "readAt": null,
      "createdAt": "2026-09-03T05:12:44.001Z",
      "delivery": {
        "channel": "IN_APP",
        "status": "SENT",
        "sentAt": "2026-09-03T05:12:45.100Z",
        "attempts": 1,
        "demo": true,               // this record came from the DEMO adapter
        "realSmsDelivered": false   // always false in this build
      }
    }
  ]
}
```

**`realSmsDelivered` is present on every notification and is always `false`.** It exists so no consumer — UI, demo audience or report — can mistake a persisted record for a message that reached a phone.

**UUID exposure:** only the notification's own `id`, because it is the address of the resource. `user_id`, `booking_id` and `template_id` never leave the server; the booking appears as its public `bookingCode`.

---

## 4. Events

| Event | Fires when | Content |
|---|---|---|
| `BOOKING_CONFIRMED` | Booking transaction commits | Booking code, crop, centre, service date, local start time, token |
| `BOOKING_ARRIVED` | Officer records arrival | Centre, booking code, token, wait instruction |
| `PROCUREMENT_COMPLETED` | Officer completes procurement | Booking code, resulting payment status |
| `PAYMENT_BLOCKED` | Completion could not resolve an MSP rate | Booking code **and the reason in plain language** |
| `PAYMENT_UPDATED` | Payment status advances | Booking code, new status, amount when one exists |
| `QUEUE_APPROACHING` | **Never — see §8** | — |

All copy is rendered in the farmer's own locale from `users.locale` (`en` / `hi`); an unrecognised locale falls back to `en`.

**`PAYMENT_BLOCKED` explains itself.** It renders the same reason code `GET /bookings/:code/payment` already returns (`MSP_AMBIGUOUS`, `NO_ACTIVE_MSP`) into plain language — no new disclosure, and the raw code is not shown as prose.

**Nothing sensitive is renderable.** The renderer is a pure function given only booking code, crop, centre, date, time, token, payment status, amount and a blocked-reason code. It has no access to internal ids, SQL errors, audit metadata, officer identity or authentication material — verified by test across every event and both locales.

---

## 5. Durability and idempotency

Notifications are written by the **same transaction** as the business change that causes them (architecture §16.1):

```
BEGIN
  → lock entity → mutate → status history → audit → enqueue notification
COMMIT
```

- **If the enqueue fails, the business mutation rolls back.** Tested directly.
- **A duplicate is not a failure.** `dedupe_key` is `UNIQUE`, and a replay is absorbed by the database rather than by an application check (§16.2) — the check that fails under concurrency. Tested by bypassing the service and re-inserting the identical key.
- **No network call happens inside the business transaction.** A booking never depends on a transport to commit. Tested by asserting the row is `QUEUED`, not `SENT`, immediately after booking.

Dedupe keys follow the established `entity:id:EVENT[:qualifier]` convention:

```
booking:<bookingId>:BOOKING_CONFIRMED
booking:<bookingId>:BOOKING_ARRIVED
booking:<bookingId>:PROCUREMENT_COMPLETED
payment:<paymentId>:PAYMENT_BLOCKED
payment:<paymentId>:PAYMENT_UPDATED:<status>     ← per status, so each transition is its own fact
```

---

## 6. Delivery

```
QUEUED → SENT
       → FAILED     (attempts bounded by max_attempts)
```

Delivery is a **separate step** from enqueue and is invoked explicitly. Phase 10 builds **no worker, no cron and no retry daemon**; `notifications_attempts_within_limit` is a schema CHECK, so an infinite retry loop is structurally impossible.

The only provider is `DevNotificationProvider`:

- performs **no network call**
- logs at `warn` with an explicit `DEMO` marker
- returns a provider id prefixed **`DEMO-`**
- declares `isRealDelivery = false`

A dispatch run writes one `notification.dispatched` audit row recording the provider name and `realDelivery: false`.

**Persisted ≠ delivered.** A `QUEUED` row means recorded. A `SENT` row in this build means the DEMO adapter accepted it.

---

## 7. Read state

`read_at` is the **only** column a read touches. `status`, `attempts`, `sent_at` and `provider_message_id` are untouched — reading a notification is not delivering one, and this is asserted by a before/after comparison in the suite.

Marking read is idempotent: re-marking an already-read notification still returns `200`.

---

## 8. `QUEUE_APPROACHING` is deliberately never sent

The event key is permitted by the schema and fully supported by the renderer, dedupe keys and feed — **but nothing enqueues it.**

Architecture §16.4 fires it when `position ≤ approaching_position_threshold`, and D-4 derives `displayStatus: "APPROACHING"` from the same threshold. **No such threshold exists anywhere in the schema**, and no value has been approved:

```sql
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND column_name ILIKE '%threshold%';
-- 0
```

Phase 10 does not invent one. This is an **explicit configuration gap** (R-9d), asserted by a test that checks both that no such notification exists and that no threshold column exists to evaluate.

---

## 9. Rate limiting

`notification_read_session` — 400 per 15 minutes, per session. Sized like the Phase 9 queue buckets: comfortably above any realistic UI refresh rate, so it bounds a looping client without ever interrupting a farmer checking their updates. Exceeding it returns `429` with `details.retryAfterSeconds`. Limits are per session; one farmer's exhausted bucket does not affect another's.

---

## 10. Errors

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Malformed notification id or limit |
| `UNAUTHENTICATED` | 401 | No session |
| `FORBIDDEN` | 403 | Role lacks the permission (officers, admins), or missing/invalid CSRF |
| `NOT_FOUND` | 404 | Unknown id **or** another farmer's notification — deliberately indistinguishable |
| `RATE_LIMITED` | 429 | See §9 |

---

## 11. What this API deliberately does not do

- **No real SMS.** No provider, no credentials, no sender ID, no DLT template id, no fabricated delivery receipt.
- **No SMS-channel rows.** Only `IN_APP` is created, because creating an SMS row would assert a delivery path that does not exist. The provider interface accepts SMS so a real provider drops in without a contract change.
- **No `QUEUE_APPROACHING`, `TURN_APPROACHING`, `ONE_DAY_REMINDER`, `NO_SHOW_RECORDED`, `BOOKING_CANCELLED`** — permitted by the domain, wired to nothing.
- **No worker, cron or background dispatcher.**
- **No template rows.** Copy is rendered from a pure module; `template_id` stays NULL (documented deviation from §16.3).
- **No quiet hours, daily caps or kill switch** — dispatcher policies with no approved values.
