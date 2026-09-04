# Mandi Sahayak — Backend Architecture

**Phase:** 1 (Design only — no implementation)
**Date:** 2026-09-02
**Stack decision:** Node.js + TypeScript + PostgreSQL (approved, Q1)
**Status:** Awaiting approval to proceed to Phase 2

> This document is the design contract for the Mandi Sahayak backend. It contains no implementation.
> Full DDL and migrations are the Phase 2 deliverable; this document defines what those migrations
> must express. Every design choice that needs your sign-off is collected in the
> **Decisions Register (§20)** and every open assumption in **§21**.

---

## Contents

1. [Principles](#1-principles)
2. [System context and topology](#2-system-context-and-topology)
3. [Module boundaries and code layout](#3-module-boundaries-and-code-layout)
4. [Authentication architecture](#4-authentication-architecture)
5. [RBAC architecture](#5-rbac-architecture)
6. [PII and minimal-data architecture](#6-pii-and-minimal-data-architecture)
7. [Database architecture](#7-database-architecture)
8. [Data classification and provenance](#8-data-classification-and-provenance)
9. [MSP data architecture](#9-msp-data-architecture)
10. [Storage and capacity architecture](#10-storage-and-capacity-architecture)
11. [Procurement-centre architecture](#11-procurement-centre-architecture)
12. [Slot and scheduling architecture](#12-slot-and-scheduling-architecture)
13. [Booking engine and concurrency / overbooking prevention](#13-booking-engine-and-concurrency--overbooking-prevention)
14. [Queue and ETA architecture](#14-queue-and-eta-architecture)
15. [Procurement and payment architecture](#15-procurement-and-payment-architecture)
16. [SMS and notification architecture](#16-sms-and-notification-architecture)
17. [Audit logging architecture](#17-audit-logging-architecture)
18. [API architecture and frontend–backend contract](#18-api-architecture-and-frontendbackend-contract)
19. [Admin backend architecture](#19-admin-backend-architecture)
20. [Offline and synchronisation architecture](#20-offline-and-synchronisation-architecture)
21. [Operations, configuration and observability](#21-operations-configuration-and-observability)
22. [Testing strategy](#22-testing-strategy)
23. [Decisions register](#23-decisions-register)
24. [Assumptions requiring confirmation](#24-assumptions-requiring-confirmation)
25. [Phase 2 handoff](#25-phase-2-handoff)

---

## 1. Principles

These are binding on every later phase. Where a later design choice conflicts with one of these,
the principle wins.

| # | Principle |
|---|---|
| P-1 | **The database is the source of truth.** No authoritative state exists in the browser, in memory, or in a cache that cannot be rebuilt from PostgreSQL. |
| P-2 | **The client is untrusted input.** Role, identity, price, weight, quantity, status, position and availability are never read from the request body; they are resolved server-side. |
| P-3 | **One formula, one home.** Processing time, slot generation, queue/ETA, MSP resolution and payment calculation each exist in exactly one module and are called from everywhere else. Never duplicated into a controller. |
| P-4 | **Data scope is preserved forever.** A state-level figure is stored as a state-level figure. Nothing is re-scoped, rounded up to, or attributed down to a level its source does not support. |
| P-5 | **Provenance or nothing.** Any record claiming to be `OFFICIAL` carries a `source_id`. `OFFICIAL` cannot be set by hand — only by an importer that recorded a source. |
| P-6 | **Storage capacity, daily processing capacity and time-window capacity are three different things.** None is derived from another by division. |
| P-7 | **Integers for physical and monetary truth.** Money in paise (`BIGINT`). Mass in kilograms with fixed scale (`NUMERIC`). No floating point ever holds a rupee or a weight. |
| P-8 | **Codes, not sentences.** The API returns stable machine-readable codes and enum values. All human-facing text is produced by the client from its i18n bundles. The UI is bilingual; a backend that returns English prose is a backend that cannot be translated. |
| P-9 | **Every state change is audited in the same transaction that makes it.** If the audit write fails, the change does not happen. |
| P-10 | **Configuration is temporal.** Operating hours, slot parameters and MSP have validity periods. A booking made last month must remain explainable by the configuration in force when it was made. |
| P-11 | **Fail honest, not fake.** When data is unavailable the API says so with a reason code. It never substitutes a plausible number. |
| P-12 | **The frontend is not final.** No table, column or endpoint is shaped by a React component. |

---

## 2. System context and topology

### 2.1 Actors and systems

```
   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
   │ Farmer (web) │      │ Officer (web)│      │ Admin (web)  │
   │  existing UI │      │  future UI   │      │  future UI   │
   └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
          │ HTTPS, session cookie │                    │
          └───────────────┬───────┴────────────────────┘
                          ▼
              ┌───────────────────────┐
              │  Mandi Sahayak API        │   Node.js + TypeScript
              │  /api/v1              │   Express, Zod, session auth
              └───┬───────────────┬───┘
                  │               │
      ┌───────────▼──┐      ┌─────▼────────────┐
      │ PostgreSQL 16│      │ Worker process   │  (same codebase,
      │  SOURCE OF   │◄────►│ scheduler + SMS  │   different entrypoint)
      │  TRUTH       │      │ dispatcher       │
      └──────────────┘      └─────┬────────────┘
                                  │
                        ┌─────────▼─────────┐
                        │ SmsProvider       │
                        │ Mock (dev/demo)   │
                        │ Real (env-config) │
                        └───────────────────┘

   Offline, human-in-the-loop:  Official MSP / storage / LGD datasets
                                → admin-triggered importer → data_sources + staged rows
```

### 2.2 Processes

Two entrypoints, one codebase, one database:

| Process | Responsibility | Scaling |
|---|---|---|
| **api** | HTTP request handling only. Never runs timers. | Horizontally scalable; stateless (sessions live in PostgreSQL) |
| **worker** | Scheduled jobs: queue recomputation, one-day reminders, threshold notifications, no-show sweep, notification dispatch, pending-record purge | Safe to run multiple copies — every job acquires `pg_try_advisory_lock` first and exits if it cannot |

Rationale for a separate worker: an API process that also runs timers cannot be scaled or restarted
without duplicating or dropping scheduled work. Separating them makes both operations trivial and
makes the SMS story testable in isolation.

### 2.3 Deployment shape for the SIH demo

Single API process + single worker + one PostgreSQL instance, all behind one reverse proxy so the
frontend and API share an origin in production. No Redis, no message broker, no external service is
required for the system to run end to end. This is a deliberate constraint: fewer moving parts is
fewer things that can fail on a stage.

### 2.4 Repository layout (additive — the frontend does not move)

```
mandi-sahayak/
  src/                        # EXISTING FRONTEND — untouched until Phase 15
  docs/
  server/                     # NEW — the entire backend
    src/
      index.ts                # api entrypoint
      worker.ts               # worker entrypoint
      core/                   # config, db, errors, http, logging, rbac, validation, time, money
      modules/                # one folder per bounded context (§3)
      engines/                # scheduling-engine, queue-engine, payment-calculator
      jobs/                   # reminder, queue-recompute, no-show-sweep, notification-dispatch, purge
      integrations/           # sms/, importers/
    migrations/               # numbered forward-only SQL
    seeds/
      test/                   # TEST-labelled fixtures ONLY
    tests/
    openapi/                  # OpenAPI 3.1 contract (source of truth for the API shape)
```

---

## 3. Module boundaries and code layout

### 3.1 Layering

```
 HTTP route
   → request validation (Zod schema; parse, never cast)
     → authentication (resolve session → user + roles)
       → authorization (permission + resource scope)
         → service            ← business rules and state machines live here
           → engine           ← pure computation: scheduling, queue/ETA, payment
             → repository     ← SQL, transactions, locking
               → PostgreSQL
```

**Rules enforced by review and by lint boundaries:**

- A route handler contains no `if` that expresses a business rule and no SQL.
- A service never reads `req`/`res`. It receives a typed command object and an actor context.
- An engine is **pure**: it takes data in, returns a result, performs no I/O, and is therefore
  exhaustively unit-testable without a database. This is what makes the scheduling and ETA logic
  provable.
- A repository never contains business rules — only queries, and the locks those queries need.

### 3.2 Bounded contexts

| Module | Owns | Key rule it protects |
|---|---|---|
| `auth` | OTP challenges, sessions, staff credentials, rate limits | No OTP ever leaves the server |
| `identity` | users, roles, permissions, farmers, officers, consents | Role comes from the DB, never the request |
| `reference` | states, districts, villages, mandis, crops | Master data is read-only to everyone but the importer/admin |
| `centres` | procurement centres, operating hours, holidays, crop eligibility, slot config, lanes | Centre config is temporal and `CONFIGURED` |
| `storage` | facilities, capacity, inventory, centre↔facility links | Scope is never changed |
| `msp` | data sources, MSP rates, import batches, crop aliases | MSP is never hardcoded; ambiguity is an error |
| `scheduling` | availability queries, next-available-date search | Delegates all maths to `engines/scheduling-engine` |
| `bookings` | booking lifecycle, tokens, cancellation | Transactional capacity reservation |
| `queue` | derived queue state, ETA projection, thresholds | Never stores position as truth |
| `procurement` | arrival, weighing, quality, accepted/rejected | `accepted + rejected ≤ gross` |
| `payments` | payment records, MSP-based valuation, status | Amount computed server-side only |
| `notifications` | templates, outbox, delivery state | Idempotent by DB constraint |
| `audit` | append-only audit log | Same transaction as the change |
| `admin` | administrative use cases across the above | Cannot fabricate `OFFICIAL` data |

Cross-module access is through the owning module's service interface, never by another module's
repository reaching into its tables.

---

## 4. Authentication architecture

### 4.1 Two entry paths, one OTP subsystem

Farmers and staff have different threat profiles, so they authenticate differently — but both use
the same OTP machinery so there is only one place where OTPs are generated, hashed, rate-limited
and verified.

```
FARMER REGISTER            FARMER LOGIN               STAFF LOGIN (officer/admin)
──────────────────         ──────────────────         ──────────────────────────────
POST register/start-otp    POST login/start-otp       POST staff/login {username,password}
  ↓ pending_registration     ↓ user must exist          ↓ verify Argon2id hash
  ↓ otp_challenge            ↓ otp_challenge            ↓ otp_challenge (purpose STAFF_2FA)
        ╰──────────────┬───────────────╯──────────────────────╯
                       ▼
             POST /auth/otp/verify {challengeId, otp}
                       ▼
             session created → __Host-fq_session cookie
```

**Why staff get a password as well as an OTP:** an officer can change a recorded weight and a
payment status; an admin can change MSP and capacity. Protecting those accounts with SIM possession
alone is not acceptable given SIM-swap risk. Password (knowledge) + OTP to a registered device
(possession) is genuine two-factor authentication and reuses machinery we already need.

### 4.2 OTP design

| Concern | Design |
|---|---|
| Length / alphabet | 6 numeric digits, generated with a CSPRNG (`crypto.randomInt`), never `Math.random` |
| Storage | **Never stored in plaintext.** `HMAC-SHA256(otp, server_pepper)` stored; pepper from env/KMS, not in the database. Constant-time comparison |
| Why HMAC and not bcrypt/Argon2 | A 6-digit space (10⁶) cannot be protected by hashing cost alone — it is protected by the **attempt limit** and **short expiry**. A fast keyed hash plus a hard limit of 5 attempts is the correct control; a slow hash here only makes the verify endpoint a DoS amplifier |
| Expiry | 5 minutes (`OTP_TTL_SECONDS`, configurable) |
| Attempts | Max 5 per challenge; challenge is consumed and marked `FAILED` on exhaustion. Failure responses are indistinguishable for wrong/expired/exhausted (`OTP_INVALID`) to avoid oracles |
| Resend | Cooldown 60 s between sends; max 3 resends per challenge; resend **reuses the same challenge** and issues a new code, invalidating the old |
| Binding | A challenge is bound to `purpose` + `phone` + (for registration) `pending_registration_id`. A LOGIN challenge can never be redeemed for a REGISTER outcome |
| Enumeration | `login/start-otp` returns the **same** response shape and timing whether or not the phone is registered. The SMS is simply not sent for an unknown number |
| Response body | Contains `challengeId`, `expiresAt`, `resendAvailableAt`, `attemptsRemaining`. **Never the OTP**, in any mode |

### 4.3 DEMO_MODE (D-3)

The demo needs a working OTP flow on stage without live SMS. Design:

- `DEMO_MODE=false` by default; setting it true in an environment where `NODE_ENV=production` and
  `ALLOW_DEMO_IN_PRODUCTION` is unset causes the process to **refuse to start**.
- When enabled, the OTP is written to the structured server log at `warn` level and is retrievable
  from `GET /api/v1/dev/last-otp?phone=…`, which requires a static `DEV_TOOLS_TOKEN` header.
- The OTP is **never** placed in the response body of any authentication endpoint, in any mode.
  The current prototype's "OTP visible on screen" behaviour is a UI mock and is not reproduced.
- Every `dev/last-otp` call is audited.

### 4.4 Sessions

Opaque server-side sessions, not JWTs.

| Concern | Design |
|---|---|
| Why not JWT | Revocation. Deactivating an officer or logging out must take effect **immediately**; a stateless token cannot do that without a denylist, which is a session table with extra steps |
| Token | 256-bit CSPRNG value; only `SHA-256(token)` is stored in `sessions`. A database leak does not yield usable sessions |
| Cookie | `__Host-fq_session`; `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`. The `__Host-` prefix makes it impossible to set from a subdomain |
| Lifetime | Idle timeout 12 h (farmer) / 30 min (staff); absolute maximum 7 d (farmer) / 12 h (staff) |
| Rotation | Session id is regenerated on privilege change and on OTP verification (prevents fixation) |
| Revocation | `POST /auth/logout` deletes the row. Admin deactivating an officer deletes **all** that user's sessions in the same transaction |
| Records | `user_id`, `token_hash`, `created_at`, `last_seen_at`, `expires_at`, `ip`, `user_agent`, `revoked_at`, `revoked_reason` |

### 4.5 CSRF

Cookie authentication requires CSRF defence.

- `SameSite=Lax` blocks cross-site POSTs from forms and simple requests.
- **Additionally**, every state-changing request (`POST`/`PATCH`/`DELETE`) must carry an
  `X-CSRF-Token` header matching a non-`HttpOnly` `fq_csrf` cookie (double-submit). Defence in depth
  for browsers or flows where `SameSite` is not sufficient.
- In development the frontend runs on Vite's port; **the Vite dev server proxies `/api` to the
  backend**, keeping everything same-origin so no cookie or CORS special-casing is needed in dev or
  prod. Cross-origin CORS with credentials is deliberately avoided.

### 4.6 Registration flow detail

1. `POST /auth/farmer/register/start-otp` validates the payload, checks phone uniqueness, writes a
   `pending_registrations` row (TTL 15 min) and an `otp_challenge`, sends the SMS.
   **No `users` or `farmers` row exists yet** — an unverified person creates no identity.
2. `POST /auth/otp/verify` on success, **in one transaction**: re-validates the pending payload,
   creates `users` + `farmers` + `user_roles(FARMER)` + `consents`, consumes the challenge, deletes
   the pending row, creates the session, writes the audit entry.
3. Expired pending registrations are purged by the worker; unverified PII never lingers.

### 4.7 Rate limiting

DB-backed fixed-window counters (`rate_limit_buckets`, upserted atomically) rather than in-memory,
so limits survive restarts and hold across multiple API instances.

| Scope | Limit (configurable) |
|---|---|
| OTP send per phone | 3 / 15 min, 10 / day |
| OTP send per IP | 20 / hour |
| OTP verify per challenge | 5 total (attempt counter) |
| Staff login per username | 5 / 15 min, then exponential lockout |
| Staff login per IP | 30 / hour |
| Authenticated API, per session | 300 / min (generous; catches runaway polling) |
| Booking creation per farmer | 10 / hour |

Exceeding a limit returns `429` with `RATE_LIMITED` and a `retryAfterSeconds` field.

---

## 5. RBAC architecture

### 5.1 Model

Role-based with explicit permissions, plus a **resource scope** check that roles alone cannot express.

```
users ──< user_roles >── roles ──< role_permissions >── permissions
  │
  └──< officer_centre_assignments >── procurement_centres
```

- `roles`: `FARMER`, `OFFICER`, `ADMIN`. (`SUPER_ADMIN` is deliberately **not** created — the model
  supports adding it later without migration of existing rows.)
- `permissions`: stable `resource.action` strings, seeded by migration, never user-editable.
- `role_permissions`: the grant matrix, seeded by migration and editable by admin **only for
  officer-level permissions** (an admin cannot grant themselves something new, and cannot alter the
  FARMER grant set).

### 5.2 Enforcement

Three checks, in order, on every request:

1. **Authenticated?** Valid, unexpired, unrevoked session → actor context `{userId, roles, permissions, centreIds}`.
2. **Permitted?** `requirePermission('procurement.record_weight')` — declarative, on the route.
3. **In scope?** A scope resolver appropriate to the resource:
   - `own` — farmer resources are loaded by `(id AND farmer_id = actor.userId)`. Never by id alone;
     an unauthorised id therefore yields `404`, not `403`, so ids cannot be probed for existence.
   - `assigned_centre` — officer actions load the booking and assert
     `booking.centre_id ∈ actor.centreIds`.
   - `global` — admin only.

**Deny by default.** Every route must declare a permission. A startup assertion walks the route
registry and **refuses to boot** if any route lacks a declaration — this makes "I forgot to protect
the endpoint" a build failure rather than a security incident.

### 5.3 Grant matrix (abridged; the full matrix is a Phase 2 seed)

| Permission | FARMER | OFFICER | ADMIN |
|---|:---:|:---:|:---:|
| `profile.read.own` / `profile.update.own` | ✔ | ✔ | ✔ |
| `reference.read` (crops, centres, districts) | ✔ | ✔ | ✔ |
| `slot.query` | ✔ | ✔ | ✔ |
| `booking.create.own` | ✔ | — | — |
| `booking.read.own` / `booking.cancel.own` | ✔ | — | — |
| `booking.read.centre` / `booking.search.centre` | — | ✔ | ✔ |
| `booking.advance_state` (arrive → … → complete) | — | ✔ | — |
| `procurement.record_weight` / `.record_quality` | — | ✔ | — |
| `payment.read.own` | ✔ | — | — |
| `payment.update_status` | — | ✔ | ✔ |
| `centre.create` / `.update` / `.configure` | — | — | ✔ |
| `storage.configure` | — | — | ✔ |
| `msp.import` / `.activate` | — | — | ✔ |
| `crop.manage` | — | — | ✔ |
| `officer.create` / `.deactivate` / `.assign_centre` | — | — | ✔ |
| `notification_template.manage` | — | — | ✔ |
| `report.read` | — | *centre-scoped* | ✔ |
| `audit.read` | — | — | ✔ |

Explicit non-grants required by the brief and verified by test in Phase 5:
a FARMER calling any `/admin/*` route → `403`; an OFFICER calling `POST /admin/msp/import` → `403`;
an OFFICER acting on a booking at an unassigned centre → `403`.

### 5.4 What officers deliberately cannot do

Change MSP; change storage capacity; create or modify users; change system configuration; act on a
centre they are not assigned to; edit a completed procurement (a correction is a new, audited
adjustment record, never an in-place edit).

---

## 6. PII and minimal-data architecture

You asked for a minimal-data proposal that identifies what is *actually* necessary. This section is
that proposal.

### 6.1 Necessity analysis of the fields the prototype collects

| Field | Purpose it would serve | Necessary? | Decision |
|---|---|---|---|
| Mobile number (E.164) | Identity, OTP delivery, all SMS notifications | **Yes — load-bearing** | Store. Unique. The primary identifier |
| Full name | The officer must match a person to a token at the gate | **Yes** | Store |
| District, village | Centre eligibility, catchment reporting | **Yes** | Store as FKs to LGD-sourced masters, not free text |
| **Aadhaar last 4 digits** | Claimed: identity verification | **No.** Four digits cannot verify anything — the space is 10⁴ and there is nothing to check them against. It provides no security value while creating a real disclosure liability | **Recommend removing entirely** (D-6). If a legal basis and a real verification mechanism are later provided, that is a separate, consent-gated design |
| **Bank IFSC code** | Claimed: payment | **No — and insufficient.** An IFSC without an account number cannot receive a payment. Collecting it enables nothing | **Recommend removing from registration** (D-6) |
| Language preference | Correct-language SMS | Yes, but not PII | Store on `users.locale` |
| Consent | Lawful basis for the above | **Yes** | Store as an explicit record, not a boolean |

### 6.2 Payment scope decision (D-7)

Mandi Sahayak **tracks payment status; it does not disburse money.** Disbursement in Indian procurement
runs through the state's own DBT/PFMS rails, not through a booking application. Therefore:

- No bank account number, no account holder name, no IFSC is collected in v1.
- `payments` stores the computed entitlement, a status, and an **opaque `payment_reference`** string
  supplied by whoever actually paid (recorded by an officer or admin).
- If disbursement is later brought in scope, bank details are collected in a **separate, purpose-
  specific, consent-gated flow** with envelope encryption and a restricted read permission — not
  bolted onto registration.

This removes the entire class of "we hold farmers' bank details in an SIH prototype" risk while
losing no demonstrable functionality.

### 6.3 Controls on the PII that remains

| Control | Design |
|---|---|
| Minimisation | The `farmers` table holds exactly: name, phone (on `users`), district_id, village_id, status, timestamps |
| Officer projection | Officers never receive the farmer record. They receive a purpose-built projection: `{ name, maskedPhone: "+91 ●●●●● ●2345", tokenNumber, crop, requestedQuantityKg, status }`. Enforced by a dedicated repository method, not by trusting the caller to omit fields |
| Search | Officer search by phone requires the **full 10 digits** (exact match on a hash-indexed column). Partial-prefix search is not offered — it would be a bulk-enumeration tool |
| Encryption at rest | Full-disk/volume encryption for the database. Application-level AES-256-GCM is specified for any future sensitive column (none in v1 after §6.2), with keys from env/KMS and never in the DB |
| Logging | A log redaction layer masks phone numbers, session tokens, OTPs and CSRF tokens before any log line is written. `audit_logs` before/after snapshots pass through the same redactor |
| Consent | `consents(user_id, purpose, policy_version, policy_text_hash, granted_at, ip, withdrawn_at)`. Recording the hash of the exact text shown means we can later prove what was agreed to |
| Retention | Proposed: active account data retained while the account is active; `otp_challenges` purged after 24 h; `pending_registrations` after 15 min; `sessions` after expiry + 30 d; `audit_logs` retained 7 years (government record-keeping expectation — **needs confirmation**, §24 A-5) |
| Right to erasure | An erasure request anonymises `users`/`farmers` (name → `[erased]`, phone → a non-reversible token) while retaining procurement and audit rows, which are statutory records. Documented, not implemented in v1 |

---

## 7. Database architecture

### 7.1 Platform conventions

| Concern | Decision | Rationale |
|---|---|---|
| Engine | PostgreSQL 16 | Range types + `EXCLUDE` constraints, `FOR UPDATE`, advisory locks, partial indexes, `JSONB`, `NUMERIC` — every one of which this design depends on |
| Extensions | `pgcrypto` (`gen_random_uuid`), `btree_gist` (composite exclusion constraints) | Both required by §13 |
| Naming | `snake_case`, plural tables, singular column names, `_id` suffix for FKs, `_at` for timestamps, `_kg`/`_paise`/`_minutes` unit suffixes **mandatory** | A column named `quantity` is a bug waiting to happen; `requested_quantity_kg` cannot be misread |
| Primary keys | `UUID` default `gen_random_uuid()` | Non-enumerable in URLs. At this scale the index-locality cost is irrelevant. (UUIDv7 generated in-app is a drop-in future optimisation) |
| Human identifiers | Separate from PKs: `booking_code` (e.g. `FQ-2026-0001234`) and `token_number` (per centre per day) | Farmers and officers speak in codes; codes must be short, stable and never be the PK |
| Timestamps | `TIMESTAMPTZ`, always UTC. Wall-clock config stored as `TIME` + the centre's IANA `timezone` | A centre opens at 08:00 *local*; storing that as an instant is wrong |
| Money | `BIGINT` paise | P-7 |
| Mass | `NUMERIC` kg, scale 3 (see §7.2) | P-7 |
| Enumerations | `TEXT` + `CHECK (col IN (...))`, with the authoritative list in one TypeScript module and asserted equal by a test | Native PG enums are painful to extend; lookup tables are overkill for fixed domains. The test prevents drift |
| Deletion | Entities with history are never hard-deleted; they get a `status` or `deactivated_at` | Referential and audit integrity |
| Migrations | Numbered, forward-only, plain SQL, reviewed as code. No auto-generated diffs. No destructive down-migrations against real data | The schema *is* the contract; it must be readable |

### 7.2 Unit representation

| Quantity | Type | Why |
|---|---|---|
| `bookings.requested_quantity_kg` | `INTEGER`, `CHECK (BETWEEN 2500 AND 5000)` | Farmer-declared whole kilograms. The business rule lives in the column, not only in code |
| `procurements.gross_quantity_kg`, `accepted_quantity_kg`, `rejected_quantity_kg` | `NUMERIC(12,3)` | Measured on a weighbridge; fractional and must not be rounded on the way in |
| Storage capacity / occupancy / reservation | `NUMERIC(14,3)` kg | Facility scale; same unit as everything else (P-6 keeps the *meaning* separate, not the unit) |
| `msp_rates.rate_per_quintal_paise` | `BIGINT` | Stored **exactly as published** (per quintal) to preserve source fidelity. Per-kg is derived at calculation time, never stored |
| `payments.amount_paise` | `BIGINT` | P-7 |

### 7.3 Entity map

```
                          ┌──────────────┐
                          │ data_sources │◄──────────── every OFFICIAL row
                          └──────────────┘

 identity ───────────────────────────────────────────────────────────────
   users ──< user_roles >── roles ──< role_permissions >── permissions
   users ──1:1── farmers          users ──1:1── officers ──< officer_centre_assignments
   users ──< sessions             users ──< consents
   otp_challenges     pending_registrations     rate_limit_buckets

 reference ──────────────────────────────────────────────────────────────
   states ──< districts ──< villages
   districts ──< mandis
   crops ──< crop_aliases          seasons (RMS / KMS)

 centres ────────────────────────────────────────────────────────────────
   procurement_centres ──> districts, mandis (nullable)
     ──< centre_operating_hours          (temporal)
     ──< centre_holidays
     ──< centre_crop_configurations      (which crop, which season)
     ──< centre_slot_configurations      (temporal; the scheduling parameters)
     ──< centre_service_lanes
     ──< centre_daily_capacity           (per service_date counters — the lock row)
     ──< centre_storage_links >── storage_facilities

 storage ────────────────────────────────────────────────────────────────
   storage_facilities ──< storage_capacity     (scoped, provenanced)
                      ──< storage_inventory    (occupied / reserved)

 msp ────────────────────────────────────────────────────────────────────
   msp_rates ──> crops, seasons, data_sources
   msp_import_batches ──< msp_import_rows

 operations ─────────────────────────────────────────────────────────────
   bookings ──> farmers, procurement_centres, crops, centre_service_lanes
     ──< booking_status_history
     ──1:1── procurements ──1:1── payments
   idempotency_keys

 messaging ──────────────────────────────────────────────────────────────
   notification_templates ──< notifications   (outbox; dedupe_key UNIQUE)

 governance ─────────────────────────────────────────────────────────────
   audit_logs        reference_versions       job_runs
```

Approximately 40 tables. Every one of them exists because a business rule or an integrity guarantee
requires it. There is no `dashboard_cards`, no `screen_state`, no UI-shaped table.

### 7.4 Key structural constraints (the schema enforces the business, not just the code)

| Constraint | Table | Guarantee |
|---|---|---|
| `CHECK (requested_quantity_kg BETWEEN 2500 AND 5000)` | `bookings` | The 25–50 quintal rule cannot be bypassed by any code path, including a future admin script |
| `EXCLUDE USING gist (centre_id WITH =, lane_no WITH =, tstzrange(scheduled_start_at, scheduled_end_at) WITH &&) WHERE (status IN (active…))` | `bookings` | **Two active bookings can never occupy the same lane at the same time.** Overbooking is structurally impossible, not merely checked |
| `UNIQUE (farmer_id, crop_id) WHERE status IN (active…)` (partial) | `bookings` | The one-active-booking rule (A-3) |
| `UNIQUE (centre_id, service_date, token_number)` | `bookings` | Tokens are unique where they are spoken |
| `CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL)` | every provenanced table | P-5 — `OFFICIAL` without a source is rejected by the database |
| `CHECK (accepted_quantity_kg + rejected_quantity_kg <= gross_quantity_kg)` | `procurements` | Physical impossibility rejected at the storage layer |
| `UNIQUE (dedupe_key)` | `notifications` | Duplicate SMS is impossible even if a job runs twice |
| `UNIQUE (key)` | `idempotency_keys` | A double-submitted booking returns the first result |
| `EXCLUDE` on overlapping validity ranges | `msp_rates`, `centre_slot_configurations`, `centre_operating_hours` | Temporal configuration can never be ambiguous (§9.3) |

---

## 8. Data classification and provenance

### 8.1 The three classes

Every externally-sourced or operator-supplied record carries a non-null `data_type`:

| Class | Meaning | Requirements | Where it may appear |
|---|---|---|---|
| `OFFICIAL` | Taken from a verifiable government publication | `source_id` **required**; `retrieved_at` required; `source_reference` (page/table/document identifier) required | Production, demo, reports — may be attributed to the government |
| `CONFIGURED` | Entered by an authorised operator because the exact operational value is not published | `configured_by_user_id`, `configured_at`, `configuration_note` required. `source_id` optional (a source may inform, without stating, the value) | Production, demo — **must be labelled as operational configuration, never as government policy** |
| `TEST` | Development or demonstration fixture | Only creatable by the seed runner, which refuses to run when `NODE_ENV=production` unless `ALLOW_TEST_DATA=true` | Development and clearly-labelled demo only |

### 8.2 Enforcement

- The `data_type` column is `NOT NULL` with a `CHECK` on the three values, on every table that
  carries external or operational data.
- `CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL)` — the database refuses an unsourced
  official claim.
- No API route can set `data_type = 'OFFICIAL'`. Only the import pipeline (§9.4), which has just
  written the `data_sources` row, can. This is a hard code-path restriction, not a convention.
- **Every API response that carries a classified value carries its classification** (§18.5). The
  Admin UI and the farmer UI are therefore *able* to label it, and a reviewer can always ask the
  API where a number came from.
- A startup check counts `TEST` rows in a production environment and logs a prominent warning.

### 8.3 `data_sources`

```
data_sources
  id, source_name, source_url, source_type (PORTAL|DOCUMENT|DATASET|API|MANUAL),
  publisher, dataset_name, document_reference,
  data_scope (NATIONAL|STATE|DISTRICT|FACILITY|CENTRE),   ← P-4 lives here
  season_id, marketing_year, reference_date,
  retrieved_at, retrieved_by_user_id, last_verified_at, last_verified_by_user_id,
  version, checksum, status (ACTIVE|SUPERSEDED|RETRACTED), notes
```

`data_scope` is on the **source**, and copied to each imported row, precisely so that a state-level
publication can never silently become a centre-level claim.

---

## 9. MSP data architecture

### 9.1 Position on data

No MSP value appears anywhere in this document, and none will appear in code, configuration or a
seed file. MSP enters the system only through the import pipeline described below, sourced from an
official publication recorded in `data_sources`. Until such an import happens, the system has no MSP
and says so (§9.5).

### 9.2 Model

```
seasons          id, code (RMS|KMS), name
crops            id, code, canonical_name, is_active, data_type, source_id
crop_aliases     id, crop_id, alias, source_id          ← import-time name normalisation
msp_rates        id, crop_id, season_id, marketing_year, variety_or_grade,
                 rate_per_quintal_paise, effective_from, effective_to,
                 status (DRAFT|ACTIVE|SUPERSEDED|RETRACTED),
                 data_type, source_id, source_reference, retrieved_at, verified_at,
                 import_batch_id, created_at
```

- **Season is never inferred.** `season_id` and `marketing_year` come from the source publication.
  Wheat is not assumed to be RMS by the code; the source says which season a rate belongs to, and if
  the source is ambiguous the row fails validation rather than being guessed.
- `marketing_year` is stored as the publication's own label (e.g. `2026-27`), not as an integer, so
  it round-trips exactly.
- `variety_or_grade` is nullable — some crops are published with variety-level rates and some are not.
  A null means "the source published a single rate", not "we do not know".

### 9.3 Resolution (the single lookup, `engines/msp-resolver`)

```
resolveMsp({ cropId, seasonId, marketingYear, grade?, onDate }) →
    exactly one ACTIVE msp_rates row whose effective range contains onDate
```

- Grade matching: exact grade first; fall back to the null-grade row only if the source published one.
- **Zero matches → `MSP_NOT_AVAILABLE`.** Not a default, not a nearby year, not last season's rate.
- **More than one match → `MSP_AMBIGUOUS`**, an operational error surfaced to admins. This cannot
  normally happen: an `EXCLUDE` constraint prevents two ACTIVE rows for the same
  (crop, season, marketing_year, grade) with overlapping effective ranges. The code path exists
  because silently picking one would be worse than failing.

### 9.4 Import pipeline

Reproducible, staged, non-destructive, human-gated:

```
1. REGISTER   admin records the source in data_sources
              (url, publisher, document reference, scope, retrieval date, checksum)
2. STAGE      importer parses the official file into msp_import_rows
              (raw_payload JSONB kept verbatim, alongside normalised columns)
3. VALIDATE   per-row: crop resolvable via crops/crop_aliases; season present;
              marketing year present; rate parses to integer paise; effective range sane;
              no overlap with an existing ACTIVE row.
              Failures are recorded per row with a reason — the batch is not aborted
4. REVIEW     admin reads the batch summary: N valid, N failed, N would-supersede,
              plus a diff against currently ACTIVE rates
5. ACTIVATE   one transaction: insert new rows as ACTIVE, mark superseded rows
              SUPERSEDED (never UPDATE, never DELETE), write audit entry
```

- **No destructive overwrite, ever.** History is retained; a past payment can always be re-derived
  from the rate that was ACTIVE at the time.
- Re-running an identical import is a no-op (batch checksum + row-level natural key).
- `msp_import_batches` records: source_id, initiated_by, file checksum, counts, status, activated_at.
- **If no machine-readable government API exists, one is not invented.** The pipeline's input is an
  official published dataset/document; the transport is a file, and the provenance record is what
  makes it trustworthy. Phase 3 will report exactly what was found and at what granularity.

### 9.5 Behaviour when MSP is unavailable

The system continues to function and tells the truth. A procurement can be recorded and completed;
the payment record is created with `status = BLOCKED` and
`blocked_reason = 'NO_ACTIVE_MSP'`, `amount_paise = NULL`. The farmer's payment screen receives
`{ status: "BLOCKED", reasonCode: "NO_ACTIVE_MSP" }` and shows a translated explanation. No amount
is estimated, and none is shown.

---

## 10. Storage and capacity architecture

### 10.1 The three capacities (P-6)

| Capacity | Question it answers | Unit | Model | Class |
|---|---|---|---|---|
| **Physical storage** | Is there room in a warehouse for this grain? | kg | `storage_facilities` + `storage_capacity` + `storage_inventory` | `OFFICIAL` where published, else `CONFIGURED` |
| **Daily processing** | How much can this centre physically handle in one day? | kg/day and minutes/day | `centre_slot_configurations.max_daily_processing_kg` + working-hour minutes | `CONFIGURED` |
| **Time-window** | Is this specific interval free on a lane? | minutes | derived: working hours − booked intervals | derived |

`available_storage = total_capacity − occupied − reserved` is a **storage** statement and has nothing
to do with how many farmers a centre can serve in a day. The system never divides a storage figure by
a quantity to obtain a slot count.

### 10.2 Model

```
storage_facilities   id, name, facility_type (WAREHOUSE|SILO|GODOWN|OPEN_PLINTH|OTHER),
                     owner_agency, state_id, district_id, address, latitude, longitude,
                     status, data_type, source_id
storage_capacity     id, facility_id, capacity_kg, capacity_type (COVERED|OPEN|TOTAL),
                     data_scope, effective_from, effective_to,
                     data_type, source_id, source_reference, retrieved_at, verified_at
storage_inventory    id, facility_id, occupied_kg, reserved_kg, as_of, updated_by_user_id,
                     data_type, source_id
centre_storage_links id, centre_id, facility_id, priority, is_active
```

- `data_scope` on `storage_capacity` is copied from the source. **If a publication states a
  state-level figure, `data_scope = STATE` and it is stored against a facility only when the
  publication actually names that facility.** State-level totals are held as their own rows and are
  never presented as a facility's capacity (P-4).
- A centre links to zero or more facilities. A centre **is not** a warehouse; a mandi **is not** a
  warehouse; the model refuses to conflate them.
- `available_kg` is **not a stored column** — it is computed (`capacity − occupied − reserved`) so it
  cannot drift out of agreement with its inputs.

### 10.3 Reservation lifecycle

| Event | Effect on `storage_inventory` |
|---|---|
| Booking created | `reserved_kg += requested_quantity_kg` (in the booking transaction, under `FOR UPDATE`) |
| Booking cancelled / no-show | `reserved_kg -= requested_quantity_kg` |
| Procurement completed | `reserved_kg -= requested_quantity_kg`; `occupied_kg += accepted_quantity_kg` |
| Admin correction | Explicit adjustment, audited, never a silent recalculation |

### 10.4 When storage data does not exist (D-8)

This is expected to be the common case (Phase 0 §8.3). The design must not fabricate and must not
deadlock:

- Each centre has `storage_check_mode ∈ {DISABLED, ADVISORY, ENFORCED}`, default **`ADVISORY`**.
- `ENFORCED` — booking is refused when reserved + requested exceeds available. Only usable where real
  capacity data exists.
- `ADVISORY` — booking proceeds; the response includes
  `storageCheck: { status: "NOT_AVAILABLE", reasonCode: "NO_CAPACITY_DATA_FOR_CENTRE" }`.
- `DISABLED` — not evaluated, and the response says so.

The API never returns a storage headroom number it does not have. It returns the reason it does not
have one.

---

## 11. Procurement-centre architecture

### 11.1 Three separate entities, deliberately

`procurement_centres`, `mandis` and `storage_facilities` are distinct tables with optional
relationships. A procurement centre may sit inside a mandi (`mandi_id` nullable), may draw on one or
more storage facilities (`centre_storage_links`), or may relate to neither. Nothing in the schema
lets one become another.

```
procurement_centres
  id, name, code (unique), state_id, district_id, mandi_id (nullable),
  address, latitude, longitude, timezone (IANA, default 'Asia/Kolkata'),
  status (ACTIVE|INACTIVE|SUSPENDED),
  storage_check_mode, lane_count,
  data_type, source_id, created_at, updated_at
```

### 11.2 Temporal operating configuration (P-10)

```
centre_operating_hours   centre_id, day_of_week (0-6), opens_at TIME, closes_at TIME,
                         effective_from DATE, effective_to DATE, data_type, configured_by
centre_holidays          centre_id, holiday_date, reason, data_type, configured_by
centre_crop_configurations  centre_id, crop_id, season_id, marketing_year,
                            is_active, effective_from, effective_to
centre_slot_configurations  centre_id,
                            reference_quantity_kg, reference_processing_minutes,
                            minimum_processing_minutes, maximum_processing_minutes,
                            transition_buffer_minutes, slot_granularity_minutes,
                            booking_horizon_days, cancellation_cutoff_hours,
                            max_daily_processing_kg,
                            effective_from, effective_to, data_type, configured_by, note
centre_service_lanes     centre_id, lane_no, name, is_active
```

- Operating hours and slot configuration are **versioned by validity range**, never updated in place.
  An `EXCLUDE` constraint prevents overlapping ranges for the same centre, so "which configuration
  applied on 12 March" always has exactly one answer.
- Every one of these rows is `CONFIGURED` with an operator and a note, because no government source
  is expected to publish a centre's transition buffer. The API labels them accordingly.
- **The numbers in the brief (50 Q ≈ 2 h, 25 Q ≈ 1 h, 08:00–18:00) are operational configuration,
  not policy.** They are seeded as `CONFIGURED` defaults for a centre, editable by an admin, and
  never hardcoded in the engine.

### 11.3 Service lanes

`lane_count` models parallel service points (weighbridges/counters) at a centre. A centre with three
lanes can serve three farmers concurrently. This is what makes the exclusion constraint in §13
correct rather than artificially restrictive — without lanes, we would either serialise a busy centre
to one farmer at a time or abandon structural overbooking prevention. Default `lane_count = 1`.

---

## 12. Slot and scheduling architecture

**The fixed one-hour bucket model of the prototype is discarded** (your instruction). Capacity is
time, and time is allocated in intervals sized to the actual quantity.

### 12.1 Processing time

```
processing_minutes =
    clamp(
        round( reference_processing_minutes × (quantityKg / reference_quantity_kg) ),
        minimum_processing_minutes,
        maximum_processing_minutes
    )

occupancy_minutes = processing_minutes + transition_buffer_minutes
```

- All four parameters come from the `centre_slot_configurations` row **in force on the service
  date** — never from a constant in code.
- The function lives in `engines/scheduling-engine` and is called by availability queries, booking
  creation, queue projection and admin reporting. It is defined once (P-3).
- Rounding is to the nearest whole minute, then clamped, then snapped **up** to the configured
  `slot_granularity_minutes` so that intervals tile cleanly.

### 12.2 Availability algorithm

`getAvailableWindows(centreId, cropId, serviceDate, quantityKg)`:

```
1. GUARDS   centre ACTIVE? crop configured for this centre, season and marketing year?
            serviceDate within [today, today + booking_horizon_days]?
            serviceDate not a centre holiday? a working day with hours defined?
            quantityKg within [2500, 5000]?
            → any failure returns a reason code, not an empty list (P-11)
2. FRAME    build the working interval(s) for the date in the centre's local timezone,
            convert to UTC instants
3. OCCUPIED load active bookings for (centre, serviceDate) as [start,end) intervals per lane
4. FREE     per lane, subtract occupied from the working frame → free intervals
5. FIT      occupancy_minutes = processingTime(quantityKg, config)
            slide a cursor over each free interval on the slot_granularity_minutes grid;
            every position where the whole occupancy window fits is a candidate
6. LIMIT    drop candidates that would breach max_daily_processing_kg,
            or (if storage_check_mode = ENFORCED) available storage
7. RETURN   deduplicate across lanes, sort by start time, cap the list,
            annotate each with { startAt, endAt, durationMinutes, processingMinutes }
```

`findNextAvailableDate(centreId, cropId, quantityKg, fromDate)` walks forward day by day to the
booking horizon, running steps 1–6 and returning the first date with at least one candidate — plus,
when there is none, the **reason** the horizon was exhausted (`ALL_DAYS_FULL`, `CENTRE_CLOSED`,
`CROP_NOT_CONFIGURED`, `HORIZON_EXCEEDED`).

### 12.3 Properties of this design

- **Quantity determines duration.** A 50-quintal booking genuinely occupies about two hours and
  cannot be squeezed into a one-hour bucket.
- **Candidates are advisory.** Between a farmer seeing a window and confirming it, someone else may
  take it. The authoritative check is inside the booking transaction (§13); an availability response
  is a suggestion, never a reservation. The API documents this explicitly so the client shows the
  right error on conflict.
- **The engine is pure.** It receives config, holidays, working hours and existing intervals as data
  and returns candidates. It touches no database and no clock, so every rule above is unit-testable
  with fabricated inputs — including DST-adjacent and midnight-crossing cases.
- **Timezone-correct.** All arithmetic is in centre-local wall-clock time; only the resulting
  instants are persisted, in UTC.
- The UI shape barely changes: it still renders a vertical list of selectable time windows. What
  changes is that the windows are computed for the quantity the farmer actually entered.

---

## 13. Booking engine and concurrency / overbooking prevention

### 13.1 Booking creation — one transaction

`POST /api/v1/bookings` with `{ centreId, cropId, quantityKg, serviceDate, startAt }` and an
`Idempotency-Key` header.

```
BEGIN  (READ COMMITTED)

 0. idempotency  INSERT INTO idempotency_keys … ON CONFLICT → return the stored response
 1. validate     Zod-parsed body; farmer from session (never from the body)
 2. re-check     every guard from §12.2 step 1, re-evaluated server-side —
                 quantity range, centre active, crop configured, horizon,
                 holiday, working hours, cancellation/booking policy
 3. LOCK         SELECT … FROM centre_daily_capacity
                   WHERE centre_id = $1 AND service_date = $2 FOR UPDATE
                 (row created on first booking of the day)
 4. LOCK         SELECT … FROM storage_inventory WHERE facility_id = ANY(…) FOR UPDATE
                 (only when storage_check_mode = ENFORCED)
 5. recompute    occupancy_minutes from the config in force; verify the requested interval
                 is still free and still inside working hours
 6. capacity     booked_kg + quantityKg ≤ max_daily_processing_kg ?
                 booked_minutes + occupancy_minutes ≤ available working minutes × lane_count ?
 7. INSERT       bookings(… scheduled_start_at, scheduled_end_at, lane_no,
                          booking_code, token_number, status = 'CONFIRMED')
                 ← the EXCLUDE constraint is the final arbiter here
 8. UPDATE       centre_daily_capacity counters; storage_inventory.reserved_kg
 9. INSERT       booking_status_history, audit_logs, notifications(BOOKING_CONFIRMED, QUEUED)
10. store        the response against the idempotency key

COMMIT
```

Lane assignment (step 7): the first lane on which the requested interval is free, in lane order.
If the exclusion constraint rejects the insert (a concurrent booking won the race), the transaction
retries against the next free lane; if no lane is free, it returns `409 SLOT_NO_LONGER_AVAILABLE`
with a freshly computed list of alternative windows — so the farmer gets a usable next step rather
than a dead end.

### 13.2 Six independent layers against overbooking

Defence in depth: any single layer failing does not produce a double booking.

| # | Layer | Prevents |
|---|---|---|
| 1 | `EXCLUDE USING gist` on (centre, lane, time range) for active bookings | Two farmers occupying the same lane at the same time — **structurally impossible** |
| 2 | `FOR UPDATE` on `centre_daily_capacity` | Two concurrent transactions each seeing spare daily kg/minutes that only one can have |
| 3 | `FOR UPDATE` on `storage_inventory` | Concurrent over-reservation of storage |
| 4 | Partial unique index on `bookings(farmer_id, crop_id)` for active statuses | One farmer holding two active bookings via a double-submit |
| 5 | `idempotency_keys` | A retried or double-clicked request creating two bookings |
| 6 | Server-side re-validation of every guard inside the transaction | A stale client acting on availability it fetched minutes ago |

**Isolation level:** `READ COMMITTED` with explicit pessimistic locks, rather than `SERIALIZABLE`.
Explicit locks give deterministic behaviour and no serialisation-failure retry storms under the
convoy of concurrent bookings this system expects at 8 a.m.

**Lock ordering** is fixed and documented — `centre_daily_capacity → storage_inventory → bookings` —
and never varied, which makes deadlock between booking transactions impossible.

### 13.3 Cancellation

`POST /api/v1/bookings/:id/cancel` — allowed while status is `CONFIRMED` and
`now < scheduled_start_at − cancellation_cutoff_hours` (from the centre's configuration). In one
transaction: status → `CANCELLED`, reason recorded, capacity counters decremented, storage
reservation released, status history + audit written, `BOOKING_CANCELLED` notification queued.

Cancellation immediately frees the interval, and the queue (§14) reprojects on the next
recomputation — which is exactly the dynamic behaviour the brief requires.

### 13.4 Changing a booking (A-2)

There is **no in-place amendment** in v1. "Change booking" is cancel + create: two independently
validated, independently audited operations. In-place amendment would require re-running every
capacity, storage and scheduling check while holding the original reservation — a materially more
complex transaction for no additional farmer-visible capability.

### 13.5 Booking status model (D-4)

The brief lists thirteen status values. Three of them are not lifecycle states; treating them as
such corrupts the state machine — a booking that has received a reminder is still simply confirmed.
Proposed canonical set, with a full mapping so the brief's vocabulary still reaches the farmer:

**Canonical `bookings.status`:**

```
CONFIRMED ─→ ARRIVED ─→ WEIGHING ─→ QUALITY_CHECK ─→ PROCUREMENT_RECORDED
                                                          │
                                                          ▼
                                                    PAYMENT_PENDING ─→ COMPLETED
CONFIRMED ─→ CANCELLED        (farmer, before cutoff)
CONFIRMED ─→ NO_SHOW          (officer or automatic sweep, after the window closes)
```

**Mapping of the brief's vocabulary:**

| Brief value | Treatment |
|---|---|
| `BOOKED` / `CONFIRMED` | Collapsed into `CONFIRMED` — a booking is confirmed the instant its transaction commits; there is no intermediate pending state |
| `REMINDER_SENT` | **Not a status.** A delivery fact in `notifications`; exposed as `reminderSentAt` |
| `APPROACHING` | **Not a status.** Derived from live queue position/ETA against the configured threshold; exposed as `displayStatus: "APPROACHING"` |
| `WAITING` | Display form of `ARRIVED` (arrived, not yet called) — exposed as `displayStatus` |
| `PROCUREMENT` | Renamed `PROCUREMENT_RECORDED` for precision |
| all others | Retained as-is |

The API returns both `status` (canonical, for logic) and `displayStatus` (derived, matching the
brief's vocabulary, for the UI's translated labels). The state machine stays clean and the UI story
stays intact.

**Transitions are table-driven** in a single module, enforced by the service layer, and every
transition writes `booking_status_history` + `audit_logs`. `COMPLETED → ARRIVED` and every other
illegal transition returns `409 INVALID_STATE_TRANSITION` naming the current and attempted states.

---

## 14. Queue and ETA architecture

### 14.1 Derived, never stored as truth (P-1)

There is no `farmers_ahead = 17` column. Queue position and ETA are **projections** computed from
authoritative data: booking intervals, statuses, and actual arrival/start/end timestamps.

### 14.2 Projection algorithm (`engines/queue-engine`, pure)

For one (centre, service_date), over active bookings ordered by `scheduled_start_at`:

```
cursor = max(now, first_scheduled_start)
for each booking b in order:
    skip if b.status ∈ {CANCELLED, NO_SHOW, COMPLETED}

    if b is currently being served:
        remaining = max(configured_minimum,
                        b.estimated_processing_minutes − elapsed_since(b.service_started_at))
        b.projected_start = b.service_started_at
        b.projected_end   = now + remaining
    else:
        b.projected_start = max(b.scheduled_start_at, cursor)
        b.projected_end   = b.projected_start + occupancy_minutes(b)

    cursor = b.projected_end

position      = index among remaining active bookings (1-based)
farmersAhead  = position − 1
estimatedWait = max(0, projected_start − now)
```

With multiple lanes the cursor is per-lane and the next booking is assigned to the earliest-free
lane — the same shape, generalised.

### 14.3 Dynamic response to reality

Because the projection is recomputed from live inputs, every event the brief requires is handled
without special-casing:

| Event | Effect |
|---|---|
| A farmer finishes early | Their actual `service_ended_at` moves the cursor back; everyone downstream shifts earlier |
| A farmer takes longer | The in-progress branch extends `projected_end` from `now`; downstream shifts later |
| A cancellation | The booking leaves the active set; everyone behind moves up |
| A no-show | Same, once the sweep or an officer marks it |
| Larger/smaller quantity | Occupancy differs per booking because it is derived from that booking's quantity |

### 14.4 Serving the projection efficiently

Recomputing per farmer per five-second poll would be wasteful. Design:

- The projection is computed **once per (centre, service_date)** in a single query plus pure
  computation, and memoised in-process for `QUEUE_CACHE_TTL_SECONDS` (default 5).
- Any state change **invalidates** the memo for that key immediately, so an officer's action is
  visible on the next poll rather than up to 5 s later.
- The worker recomputes every `QUEUE_RECOMPUTE_SECONDS` (default 30) for threshold evaluation
  (§16.4) — that job, not the polling endpoint, is what may trigger notifications.
- `queue_projections` may be persisted as a snapshot for reporting and for cheap reads under load,
  always with `computed_at`. It is a cache, never an authority: dropping the table changes nothing.

### 14.5 Polling contract

`GET /api/v1/bookings/:id/queue` →

```jsonc
{
  "bookingCode": "FQ-2026-0001234",
  "tokenNumber": 42,
  "currentlyServingToken": 38,
  "queuePosition": 5,
  "farmersAhead": 4,
  "status": "CONFIRMED",
  "displayStatus": "WAITING",
  "estimatedStartAt": "2026-03-12T05:10:00Z",
  "estimatedEndAt":   "2026-03-12T07:10:00Z",
  "estimatedWaitMinutes": 35,
  "centreTimezone": "Asia/Kolkata",
  "computedAt": "2026-03-12T04:35:02Z",
  "serverTime": "2026-03-12T04:35:02Z",
  "pollAfterSeconds": 5
}
```

- **`pollAfterSeconds` is set by the server**, so cadence is an operational decision (raise it under
  load, lower it near a farmer's turn) and is not hardcoded in the UI.
- Polling is for display only. **A poll never sends an SMS and never mutates state** — an explicit,
  tested invariant.
- The shape is transport-agnostic: adding SSE/WebSocket later means pushing this same payload, with
  no contract change.

---

## 15. Procurement and payment architecture

### 15.1 Procurement

```
procurements
  id, booking_id (unique), officer_id, centre_id,
  arrived_at, service_started_at, service_ended_at,
  gross_quantity_kg, accepted_quantity_kg, rejected_quantity_kg,
  grade, quality_status (PENDING|ACCEPTED|PARTIALLY_ACCEPTED|REJECTED),
  moisture_percent, rejection_reason,
  status, created_at, updated_at
```

Server-side validation, enforced in both the service layer and the schema:
`gross > 0`; `accepted ≥ 0`; `rejected ≥ 0`; `accepted + rejected ≤ gross`; recorded weights only in
`WEIGHING`/`QUALITY_CHECK` states; the officer must be assigned to the booking's centre; a completed
procurement is immutable — corrections are new audited adjustment rows.

### 15.2 Payment (`engines/payment-calculator`, pure)

```
resolve MSP for (crop, season, marketing year, grade, service date)   →  §9.3
    ├─ not found  → payment.status = BLOCKED, reason NO_ACTIVE_MSP, amount NULL   (§9.5)
    └─ found      →
         base_paise = round( accepted_quantity_kg × rate_per_quintal_paise / 100 )
         deductions_paise = Σ configured deductions (each itemised, each with a reason)
         amount_paise = max(0, base_paise − deductions_paise)
```

- Quintal→kg conversion happens **at calculation time** from the exactly-stored per-quintal rate; a
  derived per-kg rate is never persisted.
- Rounding: `NUMERIC` arithmetic throughout, rounded once at the end to whole paise, half away from
  zero. The rounding rule is stated in the API docs because a farmer may check the arithmetic.
- **`amount = quantity × MSP` is not assumed.** The calculator takes accepted quantity (not
  requested, not gross), the grade-appropriate rate, and an itemised deduction list. Where policy
  rules beyond this exist, they are added to this one function.
- The payment record snapshots `msp_rate_id`, the rate, and the deduction breakdown, so an amount
  computed today is still explainable after next season's MSP import.

```
payments
  id, procurement_id (unique), msp_rate_id,
  rate_per_quintal_paise_snapshot, base_amount_paise,
  deductions_paise, deduction_breakdown JSONB,
  amount_paise, currency ('INR'),
  status (BLOCKED|PENDING|INITIATED|PAID|FAILED|ON_HOLD),
  blocked_reason, payment_reference, paid_at,
  updated_by_user_id, created_at, updated_at
```

Status is advanced only by an authorised officer/admin via `payment.update_status`, along a
table-driven transition map, always audited. The farmer's payment endpoint is strictly read-only.

---

## 16. SMS and notification architecture

### 16.1 Transactional outbox

The pattern that makes "exactly once, eventually" achievable without a broker:

```
business transaction
   ├── state change      (e.g. booking INSERT)
   ├── audit_logs INSERT
   └── notifications INSERT (status = QUEUED, dedupe_key = …)      ← same transaction
COMMIT
                    │
                    ▼
   worker: notification-dispatch job
     claims rows with SELECT … FOR UPDATE SKIP LOCKED
     renders template → SmsProvider.send() → records provider id / failure
     retries with exponential backoff up to max_attempts
```

If the business transaction rolls back, no notification exists. If it commits, the notification is
guaranteed to exist and will eventually be attempted. Nothing is lost and nothing is sent for an
event that did not happen.

### 16.2 Idempotency by constraint (not by checking)

`notifications.dedupe_key` is `UNIQUE`, e.g.
`booking:{bookingId}:ONE_DAY_REMINDER:{serviceDate}`. If a scheduler runs twice, or two workers race,
the second insert violates the unique constraint and is discarded. **Duplicate SMS is prevented by
the database, not by application-level "have we sent this?" logic**, which is exactly the check that
fails under concurrency.

### 16.3 Model

```
notification_templates  id, event_key, channel (SMS|IN_APP), locale (en|hi),
                        body_template, dlt_template_id, variables JSONB,
                        status, version, updated_by_user_id
notifications           id, user_id, booking_id, event_key, channel, locale,
                        dedupe_key UNIQUE, rendered_body,
                        status (QUEUED|SENDING|SENT|FAILED|SUPPRESSED),
                        scheduled_for, attempts, last_error,
                        provider_message_id, sent_at, read_at, created_at
```

- Templates are **per locale**; the locale is chosen from `users.locale`, so a Hindi-preferring
  farmer receives Hindi SMS. This is a real requirement of a bilingual product and is easy to get
  wrong by rendering server-side in English.
- Templates carry `dlt_template_id` so the same rows serve as the registration record for TRAI DLT
  compliance when a real provider is connected.
- `notifications` doubles as the in-app notification feed (`channel = IN_APP`) — replacing the
  prototype's client-side synthesised array with real, persisted, timestamped, read/unread events.

### 16.4 Events and triggers

| Event key | Trigger | Deduplicated per |
|---|---|---|
| `BOOKING_CONFIRMED` | Booking transaction | booking |
| `BOOKING_CANCELLED` | Cancellation transaction | booking + cancellation |
| `ONE_DAY_REMINDER` | Worker job, daily at a configured hour, for tomorrow's active bookings | booking + service date |
| `QUEUE_APPROACHING` | Queue recompute job when `position ≤ approaching_position_threshold` | booking + service date |
| `TURN_APPROACHING` | Queue recompute job when `estimatedWaitMinutes ≤ turn_threshold_minutes` | booking + service date |
| `PROCUREMENT_COMPLETED` | Procurement completion transaction | procurement |
| `PAYMENT_UPDATED` | Payment status transition to a notifiable state | payment + status |

**Thresholds are configuration**, not constants, and live with the centre/queue configuration.
**Only the worker evaluates thresholds.** The polling endpoint cannot send anything (§14.5).

### 16.5 Provider abstraction

```ts
interface SmsProvider {
  send(input: { toE164: string; body: string; templateId?: string })
      : Promise<{ providerMessageId: string }>;
}
```

- `MockSmsProvider` (default in dev/demo): persists and logs the message, returns a synthetic id.
  The full pipeline — outbox, dedupe, retry, delivery state, in-app feed — is demonstrable and
  testable with zero external dependencies.
- A real provider is selected by `SMS_PROVIDER` env var and configured entirely through env.
- **No provider-specific code exists outside `integrations/sms/`.** Business logic writes a
  notification row and knows nothing about transports.
- Quiet hours, per-farmer daily caps and a global kill switch are enforced by the dispatcher
  (status `SUPPRESSED`, with a reason), never by the business layer.

---

## 17. Audit logging architecture

### 17.1 Model

```
audit_logs
  id, occurred_at, actor_user_id, actor_role, actor_ip, request_id,
  action, entity_type, entity_id,
  before_state JSONB, after_state JSONB, metadata JSONB
```

### 17.2 Guarantees

- **Same transaction (P-9).** The audit write is issued by the same service call that makes the
  change. If either fails, both roll back. There is no path where a weight changes and the audit does not.
- **Append-only.** The application database role is granted `INSERT` and `SELECT` on `audit_logs` and
  explicitly **not** `UPDATE` or `DELETE`. A trigger raises on any attempt. Tampering requires a
  superuser and leaves its own trace.
- **Redacted.** `before_state`/`after_state` pass through the same redactor as logs: no OTP, no
  session token, no full phone number, no bank data ever enters the audit table.
- **Attributed.** `request_id` correlates an audit entry with the HTTP access log and the
  application log for the same request.

### 17.3 Audited actions (minimum set)

`booking_created`, `booking_cancelled`, `booking_no_show`, `farmer_arrived`, `weighing_started`,
`weight_recorded`, `quality_updated`, `procurement_completed`, `payment_status_updated`,
`officer_created`, `officer_deactivated`, `officer_centre_assigned`, `centre_created`,
`centre_updated`, `centre_config_changed`, `storage_configured`, `storage_adjusted`,
`msp_import_started`, `msp_batch_activated`, `msp_rate_retracted`, `crop_created`, `crop_updated`,
`slot_configuration_changed`, `notification_template_updated`, `session_revoked`,
`demo_otp_revealed`, `login_succeeded`, `login_failed`.

---

## 18. API architecture and frontend–backend contract

### 18.1 Shape

- Base path `/api/v1`. JSON in, JSON out, UTF-8.
- Authentication by session cookie; CSRF header on writes.
- **OpenAPI 3.1 in `server/openapi/` is the contract of record**, written before the endpoints and
  reviewed by whoever builds each client. The frontend generates its types from it. This is how the
  Admin UI teammate builds against a stable target without reading backend code (mitigating Phase 0
  risk R-2).

### 18.2 Response envelope

```jsonc
// success (single)          // success (collection)
{ "data": { … } }            { "data": [ … ], "meta": { "nextCursor": "…", "count": 20 } }

// error
{ "error": {
    "code": "QUANTITY_OUT_OF_RANGE",       // stable, machine-readable, translatable
    "message": "…",                        // English; for developers and logs, NOT for the UI
    "fields": { "quantityKg": "OUT_OF_RANGE" },
    "details": { "minKg": 2500, "maxKg": 5000 },
    "requestId": "01J…"
} }
```

**P-8 in practice:** the client renders `error.code` through its i18n bundle. `error.message` exists
for developers and logs and must never be shown to a farmer — because it cannot be shown in Hindi.

### 18.3 Status codes

`200`/`201` success · `400` validation (`VALIDATION_FAILED`) · `401` unauthenticated ·
`403` authenticated but not permitted · `404` not found *or* not visible to this actor (§5.2) ·
`409` conflict — `SLOT_NO_LONGER_AVAILABLE`, `INVALID_STATE_TRANSITION`, `ACTIVE_BOOKING_EXISTS` ·
`422` semantically invalid but well-formed (e.g. `MSP_NOT_AVAILABLE`) · `429` `RATE_LIMITED` ·
`500` `INTERNAL_ERROR` (never leaks internals) · `503` `MAINTENANCE`.

### 18.4 Conventions

| Concern | Convention |
|---|---|
| Quantities | `quantityKg` — **integer kilograms**, always. Quintal never crosses the wire |
| Money | `amountPaise` — integer, plus `"currency": "INR"`. The client formats |
| Calendar dates | `serviceDate: "2026-03-12"` — the centre's local calendar date |
| Instants | ISO-8601 UTC with `Z`, plus `centreTimezone` where the client must render local time |
| Enums | `UPPER_SNAKE_CASE`, stable for the life of v1 |
| Field case | `camelCase` in JSON (`snake_case` stays in the database) |
| Pagination | Cursor-based: `?limit=&cursor=`; never offset, which drifts under concurrent inserts |
| Idempotency | `Idempotency-Key` header required on `POST /bookings`, honoured for 24 h |
| Caching | `ETag` + `If-None-Match` on reference data; `Cache-Control: no-store` on everything personal |
| Time | Every response carries `serverTime`; cacheable ones carry `lastUpdatedAt` |
| Versioning | Additive changes only within v1 (new optional fields, new endpoints). Any breaking change means `/api/v2` with an overlap period. Documented in `docs/api-contract.md` |

### 18.5 Provenance envelope

Any value whose credibility depends on its origin is wrapped:

```jsonc
"storageCapacity": {
  "valueKg": null,
  "dataType": null,
  "status": "NOT_AVAILABLE",
  "reasonCode": "NO_CAPACITY_DATA_FOR_CENTRE"
},
"mspRate": {
  "ratePerQuintalPaise": 0,          // illustrative shape only — no value is asserted here
  "dataType": "OFFICIAL",
  "dataScope": "NATIONAL",
  "season": "RMS",
  "marketingYear": "…",
  "source": { "name": "…", "url": "…", "documentReference": "…",
              "retrievedAt": "…", "lastVerifiedAt": "…" }
}
```

The UI can therefore always show "Source · Last updated · Verified", and a `CONFIGURED` value is
never presentable as government policy. **No MSP or storage figure is asserted anywhere in this
document** — the shapes above are structural illustrations only.

### 18.6 Endpoint surface (v1)

**Auth**
```
POST /auth/farmer/register/start-otp     POST /auth/farmer/login/start-otp
POST /auth/staff/login                   POST /auth/otp/verify
POST /auth/otp/resend                    POST /auth/logout
GET  /me                                 PATCH /me
```

**Reference**
```
GET /reference/districts                 GET /reference/villages?districtId=
GET /reference/crops                     GET /reference/seasons
GET /centres?districtId=&cropId=         GET /centres/:id
```

**Scheduling & booking (farmer)**
```
GET  /centres/:id/availability?cropId=&quantityKg=&from=&to=     → next available dates
GET  /centres/:id/slots?cropId=&quantityKg=&date=                → candidate time windows
POST /bookings                                                   (Idempotency-Key)
GET  /bookings/current      GET /bookings/history      GET /bookings/:id
POST /bookings/:id/cancel
GET  /bookings/:id/queue    GET /bookings/:id/procurement   GET /bookings/:id/payment
```

**Notifications & sync (farmer)**
```
GET   /notifications?unread=      PATCH /notifications/:id/read
POST  /notifications/read-all     GET   /sync/bootstrap
```

**Officer**
```
GET  /officer/centres                    GET  /officer/queue?centreId=&date=
GET  /officer/bookings?centreId=&date=&status=
GET  /officer/search?token=|bookingCode=|phone=
POST /officer/bookings/:id/arrive        POST /officer/bookings/:id/start-weighing
POST /officer/bookings/:id/weight        POST /officer/bookings/:id/quality
POST /officer/bookings/:id/complete      POST /officer/bookings/:id/no-show
PATCH /officer/payments/:id/status
```

**Admin** — §19.

### 18.7 What the frontend must never compute (P-2)

Queue position · farmers ahead · ETA · slot availability · processing time · token number · booking
id · payment amount · MSP · storage headroom · eligibility · whether a transition is allowed · the
user's role.

The client's job is: collect input, send it, render what comes back, translate codes, and show
loading/error/stale states.

### 18.8 Migration path for the existing prototype (Phase 15 preview — no changes now)

| Today | Becomes |
|---|---|
| `localStorage.farmerData` | `GET /me` |
| `localStorage.bookingData` | `GET /bookings/current` |
| `localStorage.bookingHistory` | `GET /bookings/history` |
| Client-generated `FQ-nnnn` | `booking_code` + `token_number` from the server |
| Hardcoded queue literal | `GET /bookings/:id/queue`, polled at `pollAfterSeconds` |
| Hardcoded centres/crops/slots | `GET /centres`, `/reference/crops`, `/centres/:id/slots` |
| Synthesised notification array | `GET /notifications` |
| `localStorage.removeItem` logout | `POST /auth/logout` |
| localStorage for language | **Legitimate** — the only sanctioned localStorage use, mirrored to `users.locale` when signed in |

Also required in Phase 15: the missing `/booking-confirmation` route, a 404 route, `ProtectedRoute`,
and quintal→kg conversion at the quantity input. All frontend work; none of it is done now.

---

## 19. Admin backend architecture

The Admin UI does not exist and is not being built. The backend is nonetheless complete and
contract-first, so a teammate can build that UI without touching backend code or reimplementing a
single rule.

### 19.1 Endpoints

```
GET   /admin/dashboard                       aggregate counters, all computed server-side

GET   /admin/farmers        GET  /admin/farmers/:id
GET   /admin/officers       POST /admin/officers        PATCH /admin/officers/:id
POST  /admin/officers/:id/deactivate         POST /admin/officers/:id/centres

GET   /admin/centres        POST /admin/centres         PATCH /admin/centres/:id
GET   /admin/centres/:id/operating-hours     PUT  /admin/centres/:id/operating-hours
GET   /admin/centres/:id/holidays            POST /admin/centres/:id/holidays
GET   /admin/centres/:id/crops               PUT  /admin/centres/:id/crops
GET   /admin/centres/:id/slot-config         PUT  /admin/centres/:id/slot-config
GET   /admin/centres/:id/storage             PUT  /admin/centres/:id/storage-links

GET   /admin/storage/facilities   POST /admin/storage/facilities
PUT   /admin/storage/facilities/:id/capacity
PUT   /admin/storage/facilities/:id/inventory
GET   /admin/storage/sources

GET   /admin/crops          POST /admin/crops           PATCH /admin/crops/:id
GET   /admin/msp            GET  /admin/msp/sources
POST  /admin/msp/imports                     → create batch (register + stage)
GET   /admin/msp/imports/:id                 → validation report + diff
POST  /admin/msp/imports/:id/activate        → transactional activation

GET   /admin/notification-templates          PATCH /admin/notification-templates/:id
GET   /admin/reports/:reportKey              GET   /admin/audit-logs
```

### 19.2 Integrity rules the Admin API enforces

1. **An admin cannot create `OFFICIAL` data.** Only the import pipeline can, and only with a
   `data_sources` row. An admin writing a capacity figure by hand produces a `CONFIGURED` record
   carrying their user id, timestamp and note — and the API says so to every consumer.
2. **Configuration is versioned, not overwritten** (P-10). `PUT slot-config` closes the current
   validity range and opens a new one. Historic bookings remain explainable.
3. **Every write is audited** with before/after state.
4. **Deactivating an officer revokes their sessions in the same transaction.**
5. **Reports are computed server-side.** The Admin UI receives finished numbers. It must never
   compute storage availability, utilisation, MSP or payment totals itself — that would create a
   second, divergent implementation of rules that P-3 says exist exactly once.
6. Admins cannot alter the FARMER permission set or grant themselves new permissions.

### 19.3 Reports (read-only aggregates)

Bookings by day/centre/crop · quantity booked vs procured · storage utilisation (with `dataType` and
scope on every figure) · centre utilisation (booked minutes ÷ available minutes) · payment status
breakdown · cancellations · no-shows · average wait vs estimate · average processing time by
quantity band (which is also the empirical feedback that tells an admin whether the configured
`reference_processing_minutes` is right).

---

## 20. Offline and synchronisation architecture

### 20.1 Honest position

**The backend APIs do not work offline, and the system will not claim they do.** What is designed is
a cache-and-resync contract that lets the existing UI degrade gracefully.

### 20.2 Contract

| Capability | Design |
|---|---|
| Cache priming | `GET /sync/bootstrap` returns one coherent snapshot — profile, active booking, queue state, recent notifications, and reference-data versions — so the client fills its cache in a single round trip and does not stitch together reads taken at different instants |
| Freshness | Every cacheable response carries `serverTime` and `lastUpdatedAt`; the UI shows **"Last updated at …"** on cached content, always |
| Staleness | `STALE_AFTER_SECONDS` per resource class is served in the bootstrap payload, so the client marks data stale on the server's terms |
| Reference data | `reference_versions` (crops, centres, districts, villages, templates) lets the client ask "has this changed?" with `ETag`/`If-None-Match` and skip large refetches |
| Conflict policy | **The server always wins** (P-1). The client holds no authoritative writes, so there is no merge to perform — reconciliation is "discard the cache, take the server's answer" |

### 20.3 Writes while offline — deliberately not queued

Booking creation, cancellation and every officer action require a live connection.

**Why:** a booking is a *reservation of contended capacity*. A queued-offline booking would be
either a promise the system cannot keep (the slot is gone by the time it syncs) or a reservation
made without a transaction. Both are worse for a farmer than an honest "you need to be online to
book". The UI therefore disables the confirm action while offline and says why.

**What does work offline:** viewing the cached booking, token, queue snapshot, profile,
notifications and reference data — each stamped with when it was captured.

Officer operations in a low-connectivity mandi are a genuine, harder problem (offline weighing with
later reconciliation) and are explicitly **out of scope for v1**, recorded here rather than
half-solved.

`docs/offline-strategy.md` (Phase 13) will document online/offline/sync/conflict behaviour per screen.

---

## 21. Operations, configuration and observability

| Concern | Design |
|---|---|
| Configuration | Environment variables only, parsed and **validated by a Zod schema at startup**. A missing or malformed variable stops the process immediately rather than failing at 3 a.m. `server/.env.example` documents every key; no secret is ever committed |
| Key settings | `DATABASE_URL`, `SESSION_*`, `OTP_PEPPER`, `OTP_TTL_SECONDS`, `SMS_PROVIDER`, `DEMO_MODE`, `QUEUE_CACHE_TTL_SECONDS`, `QUEUE_RECOMPUTE_SECONDS`, `REMINDER_SEND_HOUR_LOCAL`, `ALLOW_TEST_DATA` |
| Security headers | HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, a restrictive CSP, `Referrer-Policy` — via Helmet-equivalent middleware |
| Transport | HTTPS enforced; HTTP redirects; `Secure` cookies only |
| Logging | Structured JSON with `requestId`; PII redaction before write; no request body logged for auth routes |
| Health | `GET /healthz` (process) and `GET /readyz` (database + migration version) |
| Jobs | Every job run recorded in `job_runs` (started, finished, outcome, counts) — so "did the reminder job run?" is answerable, and so is "why did it send nothing?" |
| Job safety | `pg_try_advisory_lock` per job; a second worker exits cleanly rather than duplicating work |
| Backups | Documented in Phase 17; at minimum a pre-demo dump and a restore rehearsal |
| Errors | A single error mapper converts typed domain errors to HTTP responses. Internal details never reach a client |

---

## 22. Testing strategy

Tests are written **with** each phase, not after all of them.

| Level | What it covers | Notes |
|---|---|---|
| **Unit (pure engines)** | Processing time at 2500/5000 kg and every boundary; slot fitting; working-hour edges; holiday skipping; next-available-date search; queue projection under early finish, overrun, cancellation, no-show, mixed quantities; MSP resolution incl. not-found and ambiguous; payment rounding | No database needed — this is the payoff of pure engines |
| **Integration (real PostgreSQL)** | Every endpoint with a disposable database per run; migrations applied from scratch each time | Truth-in-testing: no mocked database |
| **Concurrency** | N parallel `POST /bookings` for one window → exactly one `201`, the rest `409`; capacity counters exactly consistent afterwards | The single most important test in the suite |
| **Authorisation matrix** | Every role × every endpoint, asserting the expected 200/403/404 — generated from the route registry so a new unprotected route fails the suite | Directly implements the brief's RBAC cases |
| **Auth security** | OTP expiry, wrong OTP, attempt exhaustion, resend cooldown, enumeration-resistance, session revocation on deactivation, CSRF rejection, OTP absent from every response body in every mode | |
| **State machine** | Every legal transition passes; a representative set of illegal ones (incl. `COMPLETED → ARRIVED`) returns `409` | |
| **Notification** | Scheduler run twice → exactly one row and one send; threshold fires once; polling sends nothing | |
| **Data integrity** | `OFFICIAL` without a source rejected; `accepted + rejected > gross` rejected; quantity outside 2500–5000 rejected **at the database level** | Asserts the schema, not just the service |

Target: every business rule in this document has at least one test that fails if the rule is removed.

---

## 23. Decisions register

Decisions taken in this phase. **D-4, D-6, D-7 and D-8 change behaviour or scope and need your
explicit sign-off**; the rest are architectural and are flagged for visibility.

| # | Decision | Status |
|---|---|---|
| D-1 | Node.js + TypeScript + Express + PostgreSQL 16; two processes (api, worker), one codebase | **Approved by you (Q1)** |
| D-2 | Opaque server-side sessions in an `__Host-` cookie rather than JWT, for immediate revocability | Proposed |
| D-3 | Staff (officer/admin) authenticate with password **plus** OTP 2FA; farmers with OTP alone. `DEMO_MODE` reveals OTPs only to logs and a token-protected dev endpoint, never in a response body | Proposed |
| D-4 | Booking status machine reduced to 9 canonical states; `REMINDER_SENT`/`APPROACHING`/`WAITING` become derived `displayStatus` and notification facts (§13.5) | **Needs sign-off** |
| D-5 | Time-window capacity with per-centre service lanes, enforced by a PostgreSQL `EXCLUDE` constraint; fixed hourly buckets discarded | **Approved by you** (slot instruction) |
| D-6 | **Aadhaar last-4 and bank IFSC are removed from registration.** Neither is necessary; the first verifies nothing and the second cannot pay (§6.1) | **Needs sign-off** |
| D-7 | Mandi Sahayak tracks payment **status**; it does not disburse. No bank details are collected in v1 (§6.2) | **Needs sign-off** |
| D-8 | Per-centre `storage_check_mode` (`DISABLED`/`ADVISORY`/`ENFORCED`), default `ADVISORY`, because centre-level storage data is expected to be unavailable (§10.4) | **Needs sign-off** |
| D-9 | MSP stored per quintal exactly as published; per-kg derived at calculation time only | Proposed |
| D-10 | Transactional outbox + `UNIQUE` dedupe key for all notifications; only the worker evaluates thresholds | Proposed |
| D-11 | `READ COMMITTED` with explicit lock ordering, not `SERIALIZABLE` | Proposed |
| D-12 | No offline writes. Reads are cacheable with server-stamped freshness; server always wins | Proposed |
| D-13 | OpenAPI 3.1 is the contract of record, written before implementation of each endpoint group | Proposed |
| D-14 | API returns error **codes** and enum values; all human text is produced by the client's i18n | Proposed |

---

## 23a. Locked decisions (Phase 3 sign-off, 2026-09-02)

> **Numbering collision — needs your ruling.** The labels D-9, D-10 and D-11 were
> already in use in the register above (MSP stored per quintal; transactional
> outbox; READ COMMITTED isolation). The three decisions locked at Phase 3
> sign-off reuse those same labels for different subjects. Both sets are still in
> force and neither contradicts the other — only the labels clash. I have not
> renumbered anything unilaterally. **When someone says "D-9", assume the locked
> decision below unless the context is clearly the isolation/outbox/units
> discussion.** Tell me which set you want renumbered and I will do it in one pass.

| # | Locked decision | Status |
|---|---|---|
| **D-9 (locked)** | **MSP resolution identity is `crop + season + marketing_year + grade`.** The Cabinet approval date is provenance metadata and must not be represented as an official `effective_from` unless the source explicitly supports it. The contract change must be documented before implementation and never made silently. | **LOCKED. Documented in `docs/msp-data.md`. NOT YET IMPLEMENTED — the repository is currently non-compliant; see that document §6.** |
| **D-10 (locked)** | **No fabricated centre-level storage capacity.** National, state or district figures are never converted into procurement-centre capacity. Centre behaviour stays `storage_check_mode = ADVISORY`, returning `NO_CAPACITY_DATA_FOR_CENTRE` when no authoritative centre-level capacity exists. | **LOCKED and already enforced.** The `storage_capacity_scope_target` constraint makes the conversion structurally impossible (verified, Phase 3 probe B7); `ADVISORY` is the column default. |
| **D-11 (locked)** | **Government data provenance.** Every official record retains source, source URL, publication reference, retrieval date, data scope and verification status. Data is never marked verified merely because it came from an official website; without independent verification, `verified_at` stays NULL. | **LOCKED and already enforced.** All 23 MSP rows carry full provenance with `verified_at` NULL. |

---

## 24. Assumptions requiring confirmation

Adopted so Phase 2 is not blocked. Each is implemented as **configuration**, so changing your mind
later is a settings change, not a migration.

| # | Assumption | Affects | Ask |
|---|---|---|---|
| A-1 | Cancellation is permitted until `cancellation_cutoff_hours` (default 24) before the scheduled start | Booking policy | Confirm the cutoff, and whether repeat cancellations or no-shows carry any consequence (Q5) |
| A-2 | "Change booking" = cancel + rebook; no in-place amendment in v1 (§13.4) | Booking policy | Confirm (Q5) |
| A-3 | **One active booking per farmer per crop** (enforced by a partial unique index) | Schema constraint | Confirm; per-farmer-overall or a seasonal quantity cap are both easy alternatives (Q7) |
| A-4 | Officers are created by an admin; no self-registration (Q8) | Auth, admin API | Confirm |
| A-5 | Audit logs retained 7 years; OTP challenges 24 h; sessions 30 d past expiry | Retention | Confirm, or supply the applicable policy |
| A-6 | Geographic scope is western Uttar Pradesh, consistent with the prototype's districts; schema stays state-agnostic regardless | Phases 3–4 data sourcing | Confirm (Q2) — it determines which state authority is the correct source |
| A-7 | Default centre timezone `Asia/Kolkata`, stored per centre rather than assumed globally | Scheduling | Confirm |
| A-8 | Booking horizon default 7 days, configurable per centre | Scheduling | Confirm |
| A-9 | Slot granularity default 15 minutes | Scheduling | Confirm |
| A-10 | Queue notification thresholds: `QUEUE_APPROACHING` at position ≤ 5, `TURN_APPROACHING` at ETA ≤ 30 min | Notifications | Confirm |

None of A-1 … A-10 blocks Phase 2 schema work except **A-3**, which is a database constraint — and
even that is a one-line index change if you decide differently.

---

## 25. Phase 2 handoff

Phase 2 (Database + migrations) will implement, in this order:

1. Extensions (`pgcrypto`, `btree_gist`), conventions, and the migration runner.
2. Identity: `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `farmers`,
   `officers`, `officer_centre_assignments`, `sessions`, `otp_challenges`,
   `pending_registrations`, `consents`, `rate_limit_buckets`.
3. Reference: `states`, `districts`, `villages`, `mandis`, `seasons`, `crops`, `crop_aliases`.
4. Provenance: `data_sources` (before anything that references it).
5. Centres: `procurement_centres`, `centre_operating_hours`, `centre_holidays`,
   `centre_crop_configurations`, `centre_slot_configurations`, `centre_service_lanes`,
   `centre_daily_capacity`.
6. Storage: `storage_facilities`, `storage_capacity`, `storage_inventory`, `centre_storage_links`.
7. MSP: `msp_rates`, `msp_import_batches`, `msp_import_rows`.
8. Operations: `bookings` (with the `EXCLUDE` and partial unique constraints),
   `booking_status_history`, `procurements`, `payments`, `idempotency_keys`.
9. Messaging: `notification_templates`, `notifications`.
10. Governance: `audit_logs` (append-only grants + trigger), `reference_versions`, `job_runs`.
11. Seeds: roles, permissions, the role→permission matrix, seasons. **No MSP. No centres. No storage
    figures. No crops beyond a `TEST`-labelled minimum for local development.**
12. Tests: migrations apply from scratch; every structural constraint in §7.4 is asserted by a test
    that attempts to violate it and expects rejection.

Phase 2 will contain **no government data of any kind**. MSP is Phase 3; centres and storage are
Phase 4 — each preceded by the source verification those phases require.

---

## Phase 1 Completion Report

**PHASE:** 1 — Backend architecture

**STATUS:** COMPLETE — awaiting approval

**WHAT I INSPECTED:** `docs/phase-0-audit.md` (the Phase 0 findings), `BACKEND_READINESS_AUDIT.txt`,
and the existing frontend's data expectations as an *input constraint only* — specifically the
shapes the UI consumes, so the API contract can serve them without letting any React component
shape a table or an endpoint.

**WHAT I IMPLEMENTED:** nothing executable. Design only, as instructed. All fifteen required areas
are resolved and documented: authentication (§4), RBAC (§5), database (§7), API (§18), MSP (§9),
storage/capacity (§10), procurement centres (§11), slot/scheduling (§12), queue/ETA (§14),
SMS/notifications (§16), offline/sync (§20), audit logging (§17), concurrency/overbooking (§13),
frontend–backend contract (§18), admin backend (§19).

**FILES CREATED:** `docs/architecture.md`

**FILES MODIFIED:** NONE — `src/index.css` and every other frontend file are untouched
(`git status` shows only untracked `docs/`).

**FILES DELETED:** NONE

**DATABASE CHANGES:** NONE — no migration was written or run. The schema is *specified*
(≈40 entities, §7.3) for Phase 2 to implement.

**API CHANGES:** NONE implemented. The v1 surface is *specified* in §18.6 and §19.1.

**BUSINESS RULES (specified, not implemented):** quantity `2500 ≤ quantityKg ≤ 5000` enforced by a
database `CHECK` as well as by validation; processing time
`clamp(round(ref_minutes × qty/ref_qty), min, max)` from per-centre temporal configuration; storage,
daily processing and time-window capacity kept as three separate models; MSP resolved by
crop × season × marketing year × grade × effective date with *not-found* and *ambiguous* as errors
rather than guesses; payment from **accepted** quantity × the grade-appropriate published rate,
minus itemised deductions, rounded once; a 9-state booking machine with table-driven transitions;
queue position and ETA derived on read, never stored as truth.

**SECURITY CHANGES (specified, not implemented):** OTP hashed with a peppered HMAC, 5-minute expiry,
5-attempt limit, 60-second resend cooldown, enumeration-resistant responses, and **never present in
any response body in any mode**; opaque revocable sessions in `__Host-` cookies; CSRF double-submit;
password + OTP 2FA for staff; deny-by-default RBAC with a startup assertion that fails the build if
a route declares no permission; DB-backed rate limits; append-only audit logs with revoked
UPDATE/DELETE grants; log and audit redaction; **removal of Aadhaar last-4 and bank IFSC from
registration** (D-6/D-7).

**TESTS CREATED:** NONE (design phase). The strategy, including the concurrency and
authorisation-matrix suites, is specified in §22 and will be written alongside each phase.

**TEST RESULTS:** none run this phase. The Phase 0 baseline is unchanged: `npm run lint` still
reports the same 6 pre-existing frontend errors; no backend code exists to test.

**REAL GOVERNMENT SOURCES USED:** NONE. No government source was accessed in this phase.

**SOURCE URLS:** none used. Source verification is Phase 3 (MSP) and Phase 4 (centres/storage).

**DATA IMPORTED:** NONE.

**DATA CLASSIFICATION:** no data created. The classification *mechanism* is specified: `data_type`
`NOT NULL` on every externally-sourced or operator-supplied table; `CHECK (data_type <> 'OFFICIAL'
OR source_id IS NOT NULL)` so the database itself rejects an unsourced official claim; `OFFICIAL`
settable only by the import pipeline and by no API route; `data_scope` carried from source to row so
a state-level figure can never become a centre-level one; classification and provenance returned on
every API response that carries such a value. **No MSP value and no storage capacity appears
anywhere in this document.**

**KNOWN LIMITATIONS:** officer offline operation is out of scope for v1 (§20.3). No in-place booking
amendment (D-4/A-2). Payment is status-tracking only, not disbursement (D-7). Centre-level storage
data is expected to be unavailable and is handled by `ADVISORY` mode rather than invented (D-8).
Multi-instance API scaling works, but the worker relies on advisory locks rather than a broker —
adequate at this scale, and noted.

**UNRESOLVED QUESTIONS:** D-4, D-6, D-7, D-8 need sign-off (§23). A-1 … A-10 are working assumptions
(§24); only **A-3** (one active booking per farmer per crop) is a database constraint and therefore
worth confirming before Phase 2 — and it remains a one-line change if you decide otherwise.

**RISKS:** Phase 0's R-1 … R-10 stand. This phase materially reduces R-5 (overbooking — now six
independent layers, one of them a structural database constraint), R-2 (officer/admin have no UI
reference — mitigated by OpenAPI-first contracts), R-7 (test data mistaken for official — mitigated
by DB-enforced classification) and R-9 (duplicate SMS — mitigated by a unique constraint). R-1
(government data granularity) is unchanged and remains unknowable until Phase 3/4.

**NEXT PHASE:** Phase 2 — Database and migrations, in the order set out in §25. No government data
will be created in Phase 2.

**STOP.** Awaiting approval.
