# Mandi Sahayak — Phase 8 Report: Officer Operations

**Phase:** 8 — arrival, weighing, quality, procurement, MSP pricing, payment
**Date:** 2026-09-02
**Status:** **IMPLEMENTED AND VERIFIED** against PostgreSQL 17.11
**Design contract:** [`phase-8-officer-operations.md`](./phase-8-officer-operations.md), written before implementation
**API contract:** [`api/officer.md`](./api/officer.md)

---

## 1. Result

| Check | Result |
|---|---|
| `tsc --noEmit` | **clean** |
| `npm test` | **174 / 174 pass**, 38 suites, 0 fail, 0 skipped |
| Phase 8 tests alone (`officer.test.ts`) | **60 / 60 pass**, 12 suites |
| `static-check.mjs` | **PASSED** — 0 failures, 0 warnings |
| `verify-schema.sql` | **23 / 23** |
| `verify-phase4.sql` | **15 / 15** |
| `verify-d9.sql` | **12 / 12** |
| **SQL probes total** | **50 / 50, 0 failures** |
| Route protection assertion | **passes** — 38 routes, every one declaring a permission |

Run against a database provisioned from zero in this session. Phases 5–7 pass
unchanged: Phase 8 is additive.

---

## 2. Two defects found in delivered work, before any new code

### 2.1 The documented test command was broken (Phase 7 regression)

`node --test tests/*.test.ts` — the command in the Phase 7 report and in
`server/README.md` — **failed around 20 tests** on this machine, every time.

Node's test runner executes each file in its own process, in parallel, and the
three suites share one database. They collide: `PHONE_RUN_PREFIX` is
`Date.now() % 100000` and two processes launched in the same millisecond
generate identical phone sequences (`PHONE_ALREADY_REGISTERED`), while
`resetRateLimits()` in one file truncates `rate_limit_buckets` out from under a
rate-limit assertion in another (`expected a 429, got 201,201,201,201,201`).

**This was never a Phase 7 code defect** — running the same files sequentially
gave 114/114 immediately. It was a reproducibility defect: the published command
did not reproduce the published result.

Fixed by pinning the runner in the script itself, so the documented command *is*
the correct one:

```json
"test": "node --test --test-concurrency=1 tests/*.test.ts"
```

Isolating the files would need a database per file. Sequencing them is the
cheaper correct answer and the suite still runs in seconds. `server/README.md`
and the Phase 7 report now say so.

### 2.2 An index-defeating predicate, caught by EXPLAIN

The officer day list is the query an officer reloads all day. Written the
obvious way it filtered on `service_date`, which `BOOKING_SELECT` renders with
`::text` — putting a cast on the indexed column:

```
->  Seq Scan on bookings b
      Filter: ((centre_id = ...) AND ((service_date)::text = ...))
```

`bookings_centre_date_start_idx (centre_id, service_date, scheduled_start_at)`
**could not be used at all** for the date component. At 77 rows nothing was
visibly wrong; at 77 000 it would be.

`BOOKING_SELECT` now also exposes the uncast date as `service_date_on`, and the
predicate uses it. Forcing the choice confirms the index is reachable:

```
->  Bitmap Heap Scan on bookings b
      Recheck Cond: ((centre_id = ...) AND (service_date = '2026-09-10'::date))
      ->  Bitmap Index Scan on bookings_centre_date_start_idx
```

The planner still prefers a sequential scan at this size, which is it being
right rather than the index being missing — the same finding, and the same
honest limitation, as Phase 7 §5. **This is demonstration-scale data. No load
test was run and none is claimed.**

---

## 3. What was built

```
server/src/
  engines/procurement.ts             PURE — quality derivation, MSP choice, money
  modules/officer/
    officer.repository.ts            SQL, centre scope, the FOR UPDATE, the money
    officer.service.ts               transitions, transaction boundaries, audit
    officer.routes.ts                HTTP, permissions, scope resolution
```

**No migration.** Every table, constraint, transition and permission this phase
needed already existed — `procurements`, `payments`, `booking_status_transitions`,
and ten permission codes granted to `OFFICER` that no route had yet claimed.
Phase 8 is the code that finally uses them. Needing a schema change here would
have been evidence that the Phase 2 design was wrong; it did not.

Thirteen endpoints, each declaring a permission (the startup assertion refuses to
boot otherwise). Full list in [`api/officer.md`](./api/officer.md) §1.

### 3.1 Deviations from the design

Two, both recorded because the design said otherwise, not because they caused a
problem.

1. **`bookings.schemas.ts`-style split not made, again.** The Zod contracts live
   at the top of `officer.routes.ts`, consistent with Phase 7 §2.1.
2. **`domain/quantity.ts` gained two schemas, not one.** The design named
   `WeighedKgSchema`; a second, `MeasuredKgSchema`, was needed because accepted
   and rejected quantities may legitimately be **zero** while a gross weight may
   not. One schema could not express both without weakening the gross check.

Everything else in §1–§14 of the design was implemented as written.

---

## 4. The decision this phase actually turns on

Decision **D-9** fixed the identity of an MSP rate as
`crop + season + marketing_year + grade`. A booking carries three of the four.
It cannot carry a grade, because **grade is not knowable at booking time**.

That leaves exactly one place where the fourth component can enter the system:
the quality check. So the grade an officer records is what resolves the price —
not a convenience, a consequence.

The seeded government data makes both branches real, and both are tested end to
end rather than simulated:

| Crop | Active rates | Result |
|---|---|---|
| **Wheat** RMS 2026-27 | one, ungraded, 2 585.00/quintal | prices with or without a grade |
| **Paddy** KMS 2026-27 | `Common` 2 441.00, `Grade A` 2 461.00 | **`BLOCKED` / `MSP_AMBIGUOUS`** until a grade is recorded |

Recording `Grade A` on that same paddy resolves it to 2 461.00; recording
`common` resolves it to 2 441.00 (matched case-insensitively); recording
`Premium Export` blocks it as `NO_ACTIVE_MSP`, because a grade with no rate is a
different fact from "we cannot tell which of several applies".

**Nothing picks the cheaper rate, the first rate, or the most common rate.** A
blocked payment is the system declining to invent a price for produce nobody
graded, and saying which of the two reasons applies — to the officer, and to the
farmer, as a code the UI can translate.

### 4.1 Money

Computed by PostgreSQL in `numeric`, never in JavaScript floating point:

```sql
base   = ROUND(accepted_quantity_kg / 100.0 * rate_per_quintal_paise)::bigint
amount = GREATEST(base - deductions_paise, 0)
```

`engines/procurement.ts` holds the same arithmetic in TypeScript **so it can be
tested without a database**, and one integration test asserts the two agree on a
value with a rounding boundary: 2 480.5 kg of wheat is 24.805 quintal at
2 585.00, which is 64 120.925 — stored as **6 412 093 paise**, by both paths.

`rate_per_quintal_paise_snapshot` is mandatory for any non-blocked payment
(`payments_unblocked_requires_amount`), so a later MSP revision cannot
retroactively change what a farmer was told. A test asserts the snapshot is a
stored value and not a join.

`deductions_paise` is **0**. No deduction policy is configured, and an empty
policy means *no deductions*, not *deductions unknown*.

---

## 5. Test design

**17 pure tests** exercise `engines/procurement.ts` with no database:

| Suite | Covers |
|---|---|
| quality classification | all three outcomes, and that an unexplained shortfall is `PARTIALLY_ACCEPTED` rather than `ACCEPTED` |
| MSP resolution | 0 / 1 / many candidates; grade present, absent, blank, whitespace, wrong case, matching none |
| payment arithmetic | the seeded rates, zero accepted, the rounding boundary, the deduction floor, paise formatting |

**43 integration tests** drive the real app over real HTTP:

| Suite | Covers |
|---|---|
| the officer lifecycle | `CONFIRMED` → `COMPLETED` end to end, the derived amount, the full status history |
| MSP resolution end to end | both paddy grades, the block, the refusal to advance a blocked payment, the rate snapshot |
| state machine | every out-of-order step refused; **refused by the database when the service layer is bypassed**; a completed booking cannot be reopened; two officers arriving concurrently |
| measurement validation | overflow, permitted shortfall, rejection-reason symmetry, zero/negative gross, moisture range |
| centre scope | `404` (never `403`) on read, arrive, weighing, weight, no-show, complete and cancel from another centre; day list; search |
| permissions | a farmer refused everything; **an ADMIN refused `arrive`, `weight`, `complete` and `no-show`**; denials audited |
| no-show and cancellation | capacity released, attribution recorded, the transitions that are *not* the officer's refused |
| payment status | reference required for `PAID`, illegal jumps refused, `FAILED` leaves the booking open |
| farmer reads | `404` before the procurement begins, amounts and measurements after, `blockedReason` surfaced, another farmer refused, no UUID in any response |

### 5.1 Claims proved rather than asserted

- **The state machine is enforced by the database.** One test issues
  `UPDATE bookings SET status='COMPLETED'` on a `CONFIRMED` booking with raw SQL
  and asserts the trigger's message; another does the same to reopen a
  `COMPLETED` booking.
- **An admin genuinely cannot operate a centre.** Not "the UI hides it" — the
  grant matrix never gave `ADMIN` `procurement.record_weight`, and the request
  returns `403`.
- **Concurrency is real.** Two officers `arrive` the same booking in parallel;
  exactly one gets `200`, and the database holds exactly one procurement row.
- **Configuration drives the price.** The same 2 500 kg of paddy yields
  6 152 500 paise at Grade A and 6 102 500 at Common, from `msp_rates` alone.
- **The scope is in the SQL.** An officer at Agra searching a Mathura booking
  code gets `count: 0`, not a filtered-out row.

### 5.2 Two test bugs found and fixed — both were the test being wrong

1. The status-history test expected the path to begin at `ARRIVED`. It begins at
   `CONFIRMED`: booking *creation* writes that row in Phase 7, with
   `from_status` NULL. The assertion now checks the null explicitly.
2. The capacity and day-list tests assumed the booking landed on the date they
   asked for. **It does not have to.** The scheduler rolls forward when a day's
   lanes are full, and this suite books enough at Mathura to fill a Tuesday. The
   tests now follow the `serviceDate` the engine actually returned. The
   scheduler was right and the test was naive — the same lesson as Phase 7 §4.

---

## 6. Risks and limitations carried forward

| | Item | Status |
|---|---|---|
| **R-8a** | A `BLOCKED` payment strands its booking in `PAYMENT_PENDING`. There is no unblock path: it needs an MSP import or a grade correction, both administrative | **Open by design** |
| **R-8b** | No no-show sweep job. A farmer who never arrives stays `CONFIRMED` until an officer marks it. `bookings_service_date_active_idx` exists for that job; the job does not | **Open** |
| **R-8c** | `deductions_paise` is always 0 — correct as configuration, incomplete as procurement domain | **Open by design** |
| **R-8d** | No correction path for a mistyped weight once quality is recorded; the state machine has no reverse edge | **Open by design** |
| **R-8e** | Grade is free text, validated only against active MSP rates at `complete`. A typo is discoverable one step later than it is made | **Open** |
| **R-8f** | Performance verified for plan shape only, not under load (§2.2) | **Open** |
| **R-7a** | 7-digit booking code space; mitigated by ownership and scope enforcement, not secrecy | **Unchanged** |
| **R-7b** | Storage is `ADVISORY` everywhere; no headroom is checked | **Unchanged** |
| **R-7c** | Integration tests require a freshly provisioned database | **Unchanged** |
| **R-L** | `origin/faramqueue-feature` still unmerged and conflicting with `main` | **Unchanged since Phase 4** |

### Deliberately absent

No SMS, no notification delivery, no real disbursal, no officer UI, no frontend
integration. No live queue position and no dynamic ETA — those are Phase 9, and
they depend on this phase because queue position is derived from what officers
have actually recorded. `REMINDER_SENT`, `APPROACHING` and `WAITING` remain
derived `displayStatus`, never stored.

---

## 7. How to reproduce

```bash
export PATH="<postgres>/bin:$PATH"
export TEST_DATABASE_URL="postgres://<user>@127.0.0.1:55432/mandi-sahayak_test"

bash server/scripts/provision-database.sh --recreate

cd server
npx tsc --noEmit
node scripts/static-check.mjs
npm test                       # pins --test-concurrency=1; see §2.1

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-schema.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-phase4.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-d9.sql
```

Re-provision before re-running the tests (Phase 7 §4).

---

## Phase Completion Report

**IMPLEMENTED:** The booking lifecycle from arrival to a resolved payment across
thirteen endpoints, a pure procurement engine, centre-scoped authorization, and
MSP price resolution driven by the grade an officer records.

**TESTS:** **174/174 pass** overall (was 114); **60/60** for Phase 8 (17 pure +
43 integration). **50/50** SQL probes. `tsc --noEmit` clean. Static checker
passed. Route protection assertion passes over 38 routes.

**FAILED TESTS:** Three on the first Phase 8 run. One was a real code defect — a
`text = date` comparison that returned `500` on the day list, fixed. Two were
wrong test assumptions, described in §5.2. A separate pre-existing failure of
~20 tests in the *documented* Phase 7 command was diagnosed and fixed in §2.1.

**DESIGN CHANGES:** None to §1–§14. Two implementation deviations recorded in
§3.1.

**NEW FILES:** `server/src/engines/procurement.ts`,
`server/src/modules/officer/{repository,service,routes}.ts`,
`server/tests/officer.test.ts`, `docs/api/officer.md`,
`docs/phase-8-officer-operations.md`, this report.

**MODIFIED:** `core/errors.ts` (+9 codes), `core/audit.ts` (+11 actions),
`core/rateLimit.ts` (+1 rule), `domain/quantity.ts` (+2 measurement schemas),
`modules/bookings/bookings.repository.ts` (`BOOKING_SELECT` exported and given
the ids and the uncast date), `src/app.ts`, `tests/helpers.ts` (`staffLogin`
promoted from a private copy in `auth.test.ts`), `package.json`,
`server/README.md`, `docs/phase-7-report.md` (§2.1).

**NEXT PHASE:** Phase 9 — live queue position and dynamic ETA, which is now
possible because arrivals and service times are recorded rather than assumed.

**STOP.** Awaiting approval.
