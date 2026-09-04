# Mandi Sahayak — Phase 10 Design Check

**Status:** **BLOCKED AT THE APPROVAL GATE — no implementation performed**
**Date:** 2026-09-02
**Baseline at time of check:** 226/226 tests, 55 suites, tsc clean, static-check 0/0, 50/50 SQL probes
**Outcome:** two blockers, both requiring a product-owner decision. No code was written.

---

## 0. Summary of the gate

Two independent blockers were found during discovery. Either alone stops the phase.

| # | Blocker | Nature |
|---|---|---|
| **B-1** | **"Phase 10" is not defined anywhere in the repository.** Two mutually inconsistent phase numberings exist, and the architecture document contains no phase roadmap at all | Scope undefined |
| **B-2** | Under the most probable reading (notifications, architecture §16), **at least nine required policy values do not exist**, including the two Phase 9 thresholds already carried forward | Policy undefined |

The correct output here is BLOCKED, not an implementation built on a guessed scope.

---

## 1. Scope

**Cannot be stated.** Determining it is blocker B-1.

### 1.1 What the repository actually says

There is **no canonical phase roadmap** in `docs/architecture.md`, `BACKEND_READINESS_AUDIT.txt`, or any other document. Section headings §1–§25 are architectural, not sequential. Phase numbers appear only as scattered forward references, and they disagree.

**Numbering A — the original, from the Phase 0–6 documents and one source file:**

| Phase | Meaning | Evidence |
|---|---|---|
| 10 | **Officer operations** | `docs/phase-4-report.md:156` — *"Officer operations are Phase 10."* |
| 11 | **Payment calculation / MSP** | `phase-4-report.md:157` *"Calculation is Phase 11"*; `phase-3-report.md:336`; `msp-data.md:188`; `phase-5-authentication.md:175`; `phase-6-farmer-domain.md:164` |
| 12 | **SMS / notifications** | `phase-4-report.md:155`; `phase-5-authentication.md:158`; `api/bookings.md:293`; **`server/.env.example:44`** |
| 13 | Offline strategy | `architecture.md:1459` |
| 14 | Admin/officer provisioning API | `phase-5-authentication.md:161`; `phase-0-audit.md:469` |
| 15 | Frontend integration | `architecture.md:124`, §18.8 |
| 17 | Backups | `architecture.md:1475` |

**Numbering B — the drifted one, from the Phase 7–9 reports:**

| Phase | Delivered |
|---|---|
| 7 | Booking and scheduling engine |
| 8 | Officer operations **and** payment calculation |
| 9 | Queue and ETA |
| 10 | *"notifications"* — asserted only in `docs/phase-9-report.md:766`, `docs/phase-9-queue-eta.md:469`, `docs/api/queue.md:314` |

### 1.2 Why this is a real conflict, not pedantry

Under Numbering A, **Phase 10 has already been built** — officer operations shipped as "Phase 8", and Phase 11 (payment calculation) shipped with it. Under Numbering B, Phase 10 is notifications, which Numbering A calls Phase 12.

**The only documents asserting "Phase 10 = notifications" are the Phase 9 documents produced in the immediately preceding session.** The instruction for this phase is explicit: *"Nothing should be assumed to be implemented merely because it is mentioned in a report"*, and *"Treat the existing architecture and approved decisions as authoritative."* The architecture does not assign phase numbers, and the older, independently-written documents — including `server/.env.example`, which is source rather than narrative — say Phase 12.

Choosing between them is a scope decision, not an engineering one.

---

## 2. Explicit non-scope

Regardless of how B-1 is resolved, the following were **not** touched and no work on them was begun:

- Phase 11+ under any numbering: offline strategy, admin provisioning API, reports/analytics, backups, frontend integration.
- Any change to Phases 1–9 behaviour.
- Any frontend file.
- The Phase 8 documentation discrepancy (permission-count wording) — left unchanged per instruction.
- The 23 MSP rates and their `last_verified_at IS NULL` status — untouched (see §14).
- Any commit.

---

## 3. Existing architecture reused

Discovery confirms the **schema for notifications is already complete and correct**. This is worth stating precisely, because it narrows the blocker to policy rather than structure.

| Object | State | Source |
|---|---|---|
| `notifications` | **Exists, fully constrained** — `dedupe_key UNIQUE`, `notifications_dispatch_idx` partial on `(scheduled_for) WHERE status IN ('QUEUED','SENDING')`, `attempts ≤ max_attempts` CHECK, `max_attempts` default 5, `sent_consistent` CHECK, `sms_requires_phone` CHECK, unread partial index | migration 0009 |
| `notification_templates` | **Exists** — one ACTIVE per `(event_key, channel, locale)` partial unique, version unique, `dlt_template_id`, `variables` JSONB | migration 0009 |
| `notification_event_t` | **Exists as a DOMAIN over text** with 8 allowed keys: `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `ONE_DAY_REMINDER`, `QUEUE_APPROACHING`, `TURN_APPROACHING`, `PROCUREMENT_COMPLETED`, `PAYMENT_UPDATED`, `NO_SHOW_RECORDED` | migration 0001 |
| `job_runs` | **Exists** — worker bookkeeping with `SUCCESS`/`FAILED`/`SKIPPED_LOCKED` outcomes, ready for `pg_try_advisory_lock` jobs | migration 0008 |
| `users.locale` | **Exists** (`locale_t`), so per-locale rendering is possible | migration 0004 |
| `notification.read.own`, `notification.update.own`, `notification_template.manage` | **Exist and are granted** (first two to FARMER, third to ADMIN); **no route claims them** | migration 0010 seed |

> **A correction made during discovery, recorded because it nearly became a false finding.** An initial probe of `pg_enum` returned zero rows for `notification_event_t`, which looked like an empty enum and therefore an absolute blocker on inserting any notification. That was wrong: the type is a **domain over `text`**, not an enum, so `pg_enum` is simply the wrong catalogue. The domain's CHECK constraint carries all eight event keys. **No migration is required for event keys.**

**Also reusable unchanged:** `withTransaction` (P-9 same-transaction writes), `writeAudit`, the `requirePermission` / `declareRoute` deny-by-default registry, `consumeAll` rate limiting, the `404`-not-`403` ownership pattern, and `engines/queue.ts` (which already computes the `position` and `estimatedWaitMinutes` that §16.4's thresholds would be compared against).

---

## 4. Requirements mapped to implementation

Mapping architecture §16 against the repository. **"Exists" means verified in the live schema or source, not inferred from a report.**

| §16 requirement | Schema | Code | Policy value | Status |
|---|---|---|---|---|
| Transactional outbox (§16.1) | ready | **none** | — | Implementable |
| Dedupe by constraint (§16.2) | ready | **none** | — | Implementable |
| Per-locale templates (§16.3) | ready | **none** | **template bodies: 0 rows seeded** | **BLOCKED — content** |
| `BOOKING_CONFIRMED` | ready | **none** | — | Implementable |
| `BOOKING_CANCELLED` | ready | **none** | — | Implementable |
| `PROCUREMENT_COMPLETED` | ready | **none** | — | Implementable |
| `NO_SHOW_RECORDED` | ready | **none** | — | Implementable |
| `ONE_DAY_REMINDER` | ready | **none** | **`REMINDER_SEND_HOUR_LOCAL` has no value** | **BLOCKED** |
| `QUEUE_APPROACHING` | **column missing** | none | **`approaching_position_threshold` does not exist** | **BLOCKED** |
| `TURN_APPROACHING` | **column missing** | none | **`turn_threshold_minutes` does not exist** | **BLOCKED** |
| `PAYMENT_UPDATED` | ready | none | **which payment statuses are "notifiable" is undefined** | **BLOCKED** |
| Dispatcher: quiet hours (§16.5) | — | none | **window undefined** | **BLOCKED** |
| Dispatcher: per-farmer daily cap (§16.5) | — | none | **cap undefined** | **BLOCKED** |
| Dispatcher: global kill switch (§16.5) | — | none | **default undefined** | **BLOCKED** |
| Retry backoff (§16.1) | `max_attempts` = 5 | none | **backoff schedule undefined** | **BLOCKED** |
| `SmsProvider` + `MockSmsProvider` (§16.5) | — | **none** | — | Implementable |
| `dlt_template_id` (TRAI DLT) | column ready | none | **requires real DLT registration** | **BLOCKED — external** |
| Farmer notification feed (`IN_APP`) | ready | **none** | template content | Partly blocked |
| Notification retention | — | none | **§21 / A-5 "needs confirmation"** | **BLOCKED** |

### 4.1 Gap found in already-shipped work

Architecture **§13.1 step 9** specifies the booking transaction as:

```
9. INSERT booking_status_history, audit_logs, notifications(BOOKING_CONFIRMED, QUEUED)
```

**Phase 7 implemented the first two and not the third.** Verified: `grep -rn "notifications" server/src/` returns nothing, and `SELECT count(*) FROM notifications` is 0. This is a real divergence from the architecture in delivered code. It is almost certainly deliberate deferral to the notifications phase, but it was never recorded as a deviation in the Phase 7 report, so it is recorded here.

---

## 5. Data model requirements

**No migration is required for the outbox itself.** Everything §16.1–§16.3 needs already exists (§3).

**A migration IS required for the two thresholds**, and only for them. The exact statement is given in §19.3. It is not written, because writing it without an approved value would ship a column whose only possible meaning is "policy nobody decided".

**No migration may add government data**, and none would: thresholds are operational configuration (`CONFIGURED`), not government values.

---

## 6. API requirements

Justified by §16.3 (`notifications` doubles as the in-app feed) and by the two unclaimed farmer permissions:

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/notifications?unread=` | `notification.read.own` | Architecture §18 line 1320 |
| PATCH | `/api/v1/notifications/:id/read` | `notification.update.own` | §18 |
| POST | `/api/v1/notifications/read-all` | `notification.update.own` | §18 |

`notification_template.manage` (ADMIN) would gate template CRUD — but template *content* is blocked (§4), so the endpoint has nothing meaningful to manage yet.

**Note:** §18 addresses a notification by `:id`, which is a UUID. Every farmer-facing route shipped in Phases 7–9 deliberately avoids UUIDs in URLs. Reconciling that is a small contract decision, listed in §19.

---

## 7. Authentication / RBAC requirements

No new permission is needed — all three already exist and are granted correctly. Requirements, all satisfiable with existing mechanisms:

- Every route declares a permission (startup assertion, currently passing over 40 routes).
- Farmer sees **only their own** notifications; ownership resolved **inside the SQL**, never post-filtered.
- Another farmer's notification id returns `404`, never `403` — enumeration resistance, matching Phases 7–9.
- `PATCH`/`POST` require CSRF (enforced app-wide for mutating methods).
- Officers and admins gain **no** farmer notification access; `notification.read.own` is FARMER-only.

---

## 8. Transaction boundaries

- **Business event → outbox row in the SAME transaction** (§16.1, P-9). If the business transaction rolls back, no notification exists; if it commits, the notification is guaranteed to exist.
- The dispatcher runs in its own transaction per claimed batch.
- Marking read is a single-row update inside one transaction.

---

## 9. Concurrency model

- **Dispatcher claim:** `SELECT … FOR UPDATE SKIP LOCKED` (§16.1), so multiple workers never send the same row twice.
- **Job singleton:** `pg_try_advisory_lock` (§2.2 line 107), recorded in `job_runs` with outcome `SKIPPED_LOCKED`.
- **Duplicate prevention:** by the `dedupe_key` UNIQUE constraint, **not** by an application "have we sent this?" check (§16.2) — the check that fails under concurrency.
- Read-marking is idempotent (`read_at` set once).

---

## 10. Audit requirements

- Notification **dispatch** is a state change and would be audited.
- Notification **reads** would not be audited, consistent with the Phase 9 decision that polling reads are not audited.
- Template changes (`notification_template.manage`) would be audited with before/after.
- `audit_logs` remains append-only; nothing here weakens that.

---

## 11. Error codes

None required beyond existing `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`. New codes would only be needed for template management, which is blocked on content.

---

## 12. State transitions

`notifications.status`: `QUEUED → SENDING → SENT | FAILED | SUPPRESSED`, with `FAILED → QUEUED` on retry until `attempts = max_attempts`.

**The schema does not enforce this machine** — unlike `bookings`, there is no `notification_status_transitions` table and no trigger. Whether to add one is a design decision, not an invention, and is listed in §19.

`SUPPRESSED` requires a reason (`suppressed_reason` column exists) — and the reasons are quiet hours, daily cap and kill switch, all three of which are **blocked policy values**.

---

## 13. Idempotency requirements

Satisfied structurally by `dedupe_key UNIQUE` (§16.2). Dedupe scopes are specified per event in §16.4 (booking, booking+cancellation, booking+service date, procurement, payment+status) and need no new decision.

---

## 14. Government-data dependencies

**None for the outbox mechanics.** Notifications transport values computed elsewhere; they neither create nor interpret government data.

**One external dependency that is not government data but behaves like it:** `dlt_template_id` requires registration of each SMS template with an Indian telecom operator under TRAI DLT rules. That identifier **cannot be fabricated** — a real one is issued by a registrar. Consistent with the Phase 3 LGD position (CAPTCHA/API-key-gated sources were not circumvented), this is recorded as unavailable rather than invented.

### 14.1 MSP verification status — assessed as instructed

`PAYMENT_UPDATED` would notify a farmer about a payment whose amount derives from the 23 MSP rates that still carry `last_verified_at IS NULL`.

**Assessment: this raises the stakes of R-8g but does not itself block the mechanics.** The notification transports an amount already computed and already visible through `GET /bookings/:code/payment`; it introduces no new reliance on MSP correctness.

**However** — sending an unverified amount to a farmer's phone is materially different from showing it in an app they chose to open, because an SMS is pushed, is quoted later, and is hard to retract. **Recommendation: `PAYMENT_UPDATED` over the SMS channel should not be enabled until R-8g is closed.** That is a recommendation, not a decision I can take. The rates are untouched and remain unverified; nothing was marked verified.

---

## 15. OFFICIAL / CONFIGURED / TEST classification

| Class | Phase 10 interaction |
|---|---|
| **OFFICIAL** | 23 MSP rates — **untouched**, `last_verified_at` still NULL |
| **CONFIGURED** | Thresholds, reminder hour, quiet hours, daily cap, backoff — **all would be CONFIGURED**, none exists yet |
| **TEST** | Any notification rows a suite creates |

Template bodies are **product content**, a fourth thing that is neither government data nor operational tuning. They must be authored and approved by a person, not generated. Demonstration templates, if used, must be labelled `CONFIGURED` and never `OFFICIAL`.

---

## 16. Security considerations

Assessed for the endpoints §6 would add:

| Question | Answer |
|---|---|
| Authentication required? | Yes, session-based |
| Correct permission? | `notification.read.own` / `notification.update.own`, both already granted to FARMER only |
| Actor scope / ownership | Resolved in SQL; no `userId` parameter accepted |
| Admin/officer separation | Neither role holds `notification.read.own` |
| CSRF | Required on `PATCH`/`POST`, enforced app-wide |
| Rate limiting | An in-app feed is pollable; a new bucket derived from the advertised cadence would be needed, as in Phase 9 |
| Enumeration resistance | `404` not `403` for a foreign notification id |
| UUID leakage | **Open question** — §18 addresses notifications by UUID, which conflicts with the Phase 7–9 convention (§19) |
| Transaction atomicity | Outbox insert in the business transaction (§8) |
| Replay | Dedupe by UNIQUE constraint |
| Concurrency | `FOR UPDATE SKIP LOCKED` + advisory lock |
| **PII in SMS bodies** | **Significant.** A rendered body is stored in `notifications.rendered_body` and sent to a phone. Template content must be reviewed for PII minimisation (§6.3) — another reason template bodies are a product decision, not an engineering one |

---

## 17. Failure modes

- Provider unreachable → `FAILED`, retried with backoff (**schedule undefined**).
- Attempts exhausted → terminal `FAILED`; the row remains as evidence.
- Business transaction rolls back → no notification exists (the point of the outbox).
- Worker crashes mid-batch → `SKIP LOCKED` rows are released; `job_runs` records `FAILED`.
- Two workers race → advisory lock makes the second `SKIPPED_LOCKED`.
- Template missing for a locale → **undefined behaviour: fall back to `en`, or suppress?** Listed in §19.

---

## 18. Testing strategy

Would follow the Phase 8/9 shape: a pure renderer/threshold-evaluator engine tested exhaustively without a database, plus integration tests for outbox atomicity (rollback leaves no row), dedupe under concurrent inserts, `SKIP LOCKED` claim behaviour, ownership `404`, RBAC negatives, and the invariant that **no notification is ever created by a read**.

**Not written**, because the phase is blocked.

---

## 19. Unresolved decisions

### 19.1 Blocker B-1 — what is Phase 10?

**Decision required:** which numbering governs.

- **Option A:** Phase 10 = notifications (Numbering B). Then §19.2 applies.
- **Option B:** Phase 10 was officer operations and is already delivered; the next unbuilt item is chosen explicitly — notifications (orig. 12), admin/officer provisioning API (orig. 14, and the largest block of unclaimed permissions: `officer.create`, `officer.assign_centre`, `officer.deactivate`, `centre.*`, `msp.*`, `crop.manage`, `storage.configure`, `data_source.manage`), or reports (`report.read`, `report.read.centre`).
- **Recommended:** renumber explicitly and record the decision, because 16 of 37 permissions are still unclaimed and the ordering of the remaining work is a product decision.

### 19.2 Blocker B-2 — undefined policy values

| # | Value | Architecture reference | Why it cannot be chosen here |
|---|---|---|---|
| 1 | `approaching_position_threshold` | §16.4, §13.5 (D-4) | Determines when a farmer is told to set off. Too low, they arrive late; too high, they wait at the centre — the exact problem Mandi Sahayak exists to remove |
| 2 | `turn_threshold_minutes` | §16.4, §13.5 | Same, in time |
| 3 | `REMINDER_SEND_HOUR_LOCAL` | §16.4, §19 | When a farmer's phone rings. A social decision |
| 4 | Notifiable payment statuses | §16.4 `PAYMENT_UPDATED` | Which money events are worth an SMS |
| 5 | Quiet-hours window | §16.5 | Legal/social; TRAI restricts commercial messaging hours |
| 6 | Per-farmer daily cap | §16.5 | Cost and nuisance trade-off |
| 7 | Global kill-switch default | §16.5 | Operational safety posture |
| 8 | Retry backoff schedule | §16.1 | Cost and provider rate-limit interaction |
| 9 | Notification retention | §21 / A-5 (*"needs confirmation"*) | Statutory; A-5 is explicitly unconfirmed |
| 10 | Template bodies, en + hi, 8 events × 2 channels | §16.3 | Product copy sent to real people, subject to PII review |
| 11 | `dlt_template_id` per template | §16.3 | Issued by a telecom registrar; cannot be fabricated |

### 19.3 Smaller design questions, also unanswered

- Notification addressing: UUID (§18) vs the Phase 7–9 no-UUID-in-URL convention.
- Whether `notifications.status` should get a transition table + trigger, as `bookings` has.
- Missing-locale behaviour: fall back to `en`, or `SUPPRESSED`?
- Whether `BOOKING_CONFIRMED` should be backfilled for the bookings that already exist without it (§4.1).

---

## 20. Approval gate

**STOPPED HERE. No implementation was performed. No source file was created or modified. No migration was written. No test was added. Nothing was committed.**

### 20.1 The six points required by the phase brief, for the carried-forward threshold blocker

**1. What requirement is missing**
The two configured thresholds that decide when a farmer is warned their turn is near: `approaching_position_threshold` (a queue position) and `turn_threshold_minutes` (a wait in minutes).

**2. Where the architecture references it**
- `docs/architecture.md` §16.4 — `QUEUE_APPROACHING` fires when `position ≤ approaching_position_threshold`; `TURN_APPROACHING` fires when `estimatedWaitMinutes ≤ turn_threshold_minutes`; *"Thresholds are configuration, not constants, and live with the centre/queue configuration."*
- `docs/architecture.md` §13.5 (D-4) — `APPROACHING` is *"Derived from live queue position/ETA against the configured threshold"*.

**3. What database/schema object is missing**
No column, table or setting anywhere holds either value. Verified against the live schema:

```sql
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema='public'
   AND (column_name ILIKE '%threshold%' OR column_name ILIKE '%approach%');
-- (0 rows)
```

`centre_slot_configurations` — the natural home, being the temporal centre configuration — has 19 columns and none of them is a threshold.

**4. Why choosing a value would be inventing policy**
The threshold decides when a farmer leaves their village. Set it too low and farmers arrive after their turn; set it too high and they queue at the centre — which is the precise problem this system exists to eliminate. The right value depends on travel distances, transport availability and centre throughput, none of which is in this repository. A plausible-looking `position <= 3` would be an operational rule with real consequences, authored by no one accountable, that would then be quoted back as though it were designed.

**5. The minimum decision required from the product owner**
One of:
- **(a)** Concrete values for both thresholds, with the scope they apply at (per centre, or system-wide default with per-centre override); **or**
- **(b)** An explicit decision that both are **operator-set, defaulting to NULL = disabled**, meaning `QUEUE_APPROACHING`, `TURN_APPROACHING` and `displayStatus: "APPROACHING"` stay dormant until an administrator configures them per centre. This unblocks the code path without anyone inventing a number.

**(b) is the smaller decision and is recommended**, because it makes the absence explicit and configurable rather than hidden, and matches the project's existing "NULL means not configured" convention (`max_daily_processing_kg`, empty `booking_policies`).

**6. The exact migration/configuration change needed AFTER approval**

Migration `0014_queue_notification_thresholds.sql`, forward-only, adding nothing but two nullable columns and their guards:

```sql
BEGIN;

ALTER TABLE centre_slot_configurations
    ADD COLUMN approaching_position_threshold smallint,
    ADD COLUMN turn_threshold_minutes         smallint;

ALTER TABLE centre_slot_configurations
    ADD CONSTRAINT centre_slot_configurations_approaching_threshold_positive
    CHECK (approaching_position_threshold IS NULL OR approaching_position_threshold > 0),
    ADD CONSTRAINT centre_slot_configurations_turn_threshold_positive
    CHECK (turn_threshold_minutes IS NULL OR turn_threshold_minutes > 0);

COMMENT ON COLUMN centre_slot_configurations.approaching_position_threshold IS
    'Queue position at or below which QUEUE_APPROACHING fires and displayStatus '
    'becomes APPROACHING. NULL means NOT CONFIGURED — the event never fires and '
    'APPROACHING is never derived. It does not mean zero.';
COMMENT ON COLUMN centre_slot_configurations.turn_threshold_minutes IS
    'Estimated wait in minutes at or below which TURN_APPROACHING fires. '
    'NULL means NOT CONFIGURED, not zero.';

INSERT INTO schema_migrations (version, name)
VALUES ('0014', 'queue_notification_thresholds');

COMMIT;
```

**Under decision (b) no data change accompanies it** — every existing row keeps NULL, and the demonstration centres stay dormant until configured. Under decision (a), a separate `CONFIGURED` data change would set the approved values with `configured_by_user_id` attribution.

**This migration alone unblocks nothing.** With NULL everywhere, no threshold event can fire. What unblocks the feature is the *decision* in point 5; the migration only gives it somewhere to live.

### 20.2 What can proceed the moment B-1 is answered, even if B-2 is not

If the owner confirms Phase 10 = notifications, a **threshold-free slice** is fully implementable and needs no invented policy:

- transactional outbox writes for `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `PROCUREMENT_COMPLETED`, `NO_SHOW_RECORDED` — all transaction-triggered
- dedupe by UNIQUE constraint
- `IN_APP` channel only, so no DLT id, no quiet hours, no daily cap, no SMS cost
- the three farmer feed endpoints (§6)
- `MockSmsProvider` behind the `SmsProvider` interface, wired but unused
- closing the §13.1 step-9 gap (§4.1)

**Its one remaining dependency is template body text in `en` and `hi`** — product copy, subject to PII review. That is a single, concrete, small approval, and it is the shortest path from here to working software.

**Awaiting your decision on B-1 and B-2. No further work will begin until then.**
