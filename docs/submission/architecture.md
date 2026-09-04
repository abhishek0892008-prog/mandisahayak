# Mandi Sahayak — Submission Architecture Overview

**Full design contract:** [`../architecture.md`](../architecture.md) (§1–§25). This is the submission summary and the diagram specification.

---

## 1. System diagram (text specification)

```
┌──────────────────────────┐          ┌──────────────────────────┐
│  FARMER APP              │          │  OFFICER APP             │
│  React + Vite + i18n     │          │  ⚠ NOT IMPLEMENTED       │
│  en / hi                 │          │  officer operations are  │
│  ⚠ PROTOTYPE — NOT WIRED │          │  API-only today          │
└────────────┬─────────────┘          └────────────┬─────────────┘
             │                                      │
             │  (integration = next phase)          │
             ▼                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  API LAYER — Node.js + TypeScript + Express                     │
│  ─────────────────────────────────────────────────────────────  │
│  request context → security headers → body → cookies            │
│    → CSRF issue → actor resolution → CSRF verify (writes)        │
│    → route (44, EVERY one declares a permission)                 │
│                                                                  │
│  Deny by default: the server REFUSES TO BOOT if any route        │
│  omits a permission or any mutating route omits CSRF.            │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  AUTH / RBAC                                                    │
│  Farmer: OTP only          Officer/Admin: password + OTP 2FA    │
│  37 permissions · 3 roles · officer scoped to assigned centres   │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  DOMAIN SERVICES            │  PURE ENGINES (no I/O, no clock)  │
│  ─────────────────────────  │  ───────────────────────────────  │
│  bookings   officer         │  scheduling.ts   procurement.ts   │
│  queue      notifications   │  queue.ts        notifications.ts │
│  identity   reference       │                                    │
└────────────┬────────────────────────────────────────────────────┘
             │  every write in ONE transaction with its audit row
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL 17.11 — 48 tables · 172 CHECK · 7 GiST EXCLUDE      │
│  14 forward-only migrations                                      │
│                                                                  │
│  ├── Booking        bookings, centre_slot_configurations,        │
│  │                  centre_service_lanes, centre_daily_capacity  │
│  ├── Queue / ETA    ⚠ NO TABLE — derived on every request        │
│  ├── Procurement    procurements, booking_status_transitions,    │
│  │                  booking_status_history                       │
│  ├── MSP            msp_rates (23 OFFICIAL), data_sources        │
│  ├── Payments       payments (paise, BIGINT — never float)       │
│  ├── Notifications  notifications (outbox), notification_templates│
│  └── Audit          audit_logs — APPEND-ONLY (3 triggers)        │
└─────────────────────────────────────────────────────────────────┘

     NOTIFICATION OUTBOX FLOW
     ────────────────────────
     business transaction
        ├── state change
        ├── audit_logs INSERT
        └── notifications INSERT (QUEUED, dedupe_key UNIQUE)   ← same txn
     COMMIT
        │
        ▼
     dispatchPending()   ← explicit call; no worker in this build
        │
        ▼
     ┌───────────────────────────┐
     │ DevNotificationProvider   │  ✅ IMPLEMENTED
     │ no network call           │
     │ ids prefixed "DEMO-"      │
     └───────────────────────────┘
        │
        ▼
     ┌───────────────────────────┐
     │ Real SMS / Push provider  │  ⚠ NOT IMPLEMENTED
     │ needs approved provider   │     no credentials
     │ + TRAI DLT registration   │     no sender ID
     └───────────────────────────┘
```

---

## 2. The five ideas that matter

**1. Capacity is time on a lane, not a bucket.**
A 5 000 kg booking genuinely takes twice as long as 2 500 kg. Fixed hourly buckets either waste capacity or overrun. Every booking consumes a quantity-derived interval on exactly one lane, and `bookings_no_lane_overlap` — a GiST exclusion constraint — makes two overlapping bookings **structurally impossible**, independent of application code.

**2. Queue position and ETA are derived, never stored.**
There is no `farmers_ahead` column. The projection is computed per request from bookings, statuses and real service timestamps. An early finish pulls everyone forward, an overrun pushes them back, a cancellation moves them up — with no special-case code, because nothing was cached to go stale.

**3. The system refuses to invent numbers.**
ETA carries `OBSERVED` / `PROJECTED` / `SCHEDULED` / `UNAVAILABLE` + a reason. Paddy without a recorded grade returns `BLOCKED / MSP_AMBIGUOUS` and **no amount**, because Common and Grade A differ by ₹20/quintal and nobody may guess. `APPROACHING` is not derived at all, because no threshold has been configured.

**4. Money is computed in the database, in `numeric`.**
Amounts are integer paise (`BIGINT`). The MSP rate is snapshotted at computation, so a later revision cannot retroactively change what a farmer was told. A TypeScript mirror of the arithmetic exists only so it can be unit-tested and cross-checked.

**5. The database enforces the business, not just the code.**
The booking lifecycle lives in `booking_status_transitions` as *data*, enforced by a `BEFORE UPDATE` trigger — a test bypasses the entire service layer with raw SQL and the database still refuses an illegal transition. `audit_logs` is append-only at the database level. Duplicate notifications are prevented by a `UNIQUE` constraint, not an application check.

---

## 3. Workflows

**Farmer:** register (OTP) → browse centres/crops → check availability → book (idempotent) → confirmation + notification → track queue position and ETA → arrive → track procurement → track payment.

**Officer:** login (password + OTP 2FA) → today's bookings for an assigned centre → search by code/token/phone → mark arrived → begin weighing → record gross weight → record quality and grade → complete (MSP resolved, payment created) → advance payment status.

**Every officer action is scoped to assigned centres, enforced inside the SQL. A booking at another centre returns `404`, never `403`.**

---

## 4. Security posture

| Control | Implementation |
|---|---|
| Authentication | Farmer OTP; staff password + OTP 2FA. Password alone never yields a session |
| Authorization | 37 permissions, deny-by-default, verified at boot across 44 routes |
| Ownership | Resolved inside SQL. No `farmerId` parameter exists anywhere |
| Enumeration | `404` not `403` for foreign resources, everywhere |
| CSRF | Enforced on every mutating method, app-wide |
| Rate limiting | 13 buckets, each derived from a stated threat model |
| Audit | Written in the same transaction as the change; append-only |
| PII | No Aadhaar, no bank details collected (D-6/D-7) |
| Secrets | None committed; `.env` gitignored |

---

## 5. Deliberately not built

Real SMS delivery · payment disbursal · officer/admin UI · frontend–backend integration · offline sync · notification dispatch worker · reports and analytics · `APPROACHING` thresholds.

Each is recorded with the reason in [`limitations.md`](./limitations.md).
