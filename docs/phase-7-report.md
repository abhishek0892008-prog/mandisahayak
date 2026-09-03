# FarmQueue — Phase 7 Report: Booking & Scheduling Engine

**Phase:** 7 — availability search, booking creation, cancellation
**Date:** 2026-09-02
**Status:** **IMPLEMENTED AND VERIFIED** against PostgreSQL 17.11
**Design contract:** [`phase-7-booking-engine.md`](./phase-7-booking-engine.md), written before implementation
**API contract:** [`api/bookings.md`](./api/bookings.md)

---

## 1. Result

| Check | Result |
|---|---|
| `tsc --noEmit` | **clean** |
| `node --test --test-concurrency=1 tests/*.test.ts` | **114 / 114 pass**, 26 suites, 0 fail, 0 skipped |
| Phase 7 tests alone (`booking.test.ts`) | **48 / 48 pass**, 11 suites |
| `static-check.mjs` | **PASSED** — 0 failures, 0 warnings |
| `verify-schema.sql` | **23 / 23** |
| `verify-phase4.sql` | **15 / 15** |
| `verify-d9.sql` | **12 / 12** |
| **SQL probes total** | **50 / 50, 0 failures** |

Everything above was run against a database **provisioned from zero in this
session**, not against accumulated state. Phases 5 and 6 still pass unchanged:
Phase 7 is additive.

---

## 2. What was actually built

```
server/src/
  engines/scheduling.ts              PURE — no I/O, no clock, no database
  modules/bookings/
    bookings.repository.ts           SQL, both locks, the transactional insert
    bookings.service.ts              orchestration, retries, state transitions
    bookings.routes.ts               HTTP, permissions, idempotency
```

Five endpoints, each declaring a permission (the deny-by-default startup
assertion refuses to boot otherwise):

| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/bookings/availability` | `slot.query` |
| POST | `/api/v1/bookings` | `booking.create.own` |
| GET | `/api/v1/bookings/me` | `booking.read.own` |
| GET | `/api/v1/bookings/:bookingCode` | `booking.read.own` |
| POST | `/api/v1/bookings/:bookingCode/cancel` | `booking.cancel.own` |

**The design document required no amendments.** Nothing in §1–§18 was walked
back during implementation.

### 2.1 One deviation from the planned layout

The design (§18) lists a `bookings.schemas.ts`. The Zod contracts are small — four
schemas totalling about thirty lines — and are defined at the top of
`bookings.routes.ts` beside the routes that use them. Splitting them into a file
of their own would have added an import without adding a reader any clarity.
Recording it because the design said otherwise, not because it caused a problem.

---

## 3. Test design: pure engine, then real database

The 48 tests split deliberately.

**18 pure tests** exercise `engines/scheduling.ts` with no database and no clock,
which is what makes the timing edges reachable at all:

| Suite | Covers |
|---|---|
| processing time | ratio, rounding, both clamps, processing/buffer separation |
| time and timezone | zoned→UTC, local weekday, date arithmetic across a month end, granularity snapping |
| interval maths | free-gap computation, overlap merging, closing-time overrun, never scheduling in the past |
| lane selection | earliest start across lanes, full single-lane day, closed weekday, holiday, differing hours |

**30 integration tests** drive the real app over real HTTP against real
PostgreSQL, because the properties under test only exist end to end:

| Suite | Covers |
|---|---|
| booking creation | derived window, random code, quantity bounds, unconfigured crop, horizon, missing key, token sequence, no UUID leak, advisory storage |
| idempotency | replay on identical body, `409` on a different body |
| concurrency | parallel bookings never overlap, the exclusion constraint catching a bypass, farmer time conflict, duplicate active booking |
| availability and scheduling | derived duration and earliest window, roll to next working day, capacity freed on cancellation |
| booking ownership | another farmer's booking is unreadable and uncancellable |
| cancellation and state machine | cutoff, double-cancel, illegal transition refused by the database, cancelled rows leave the active list |
| crop and MSP integrity | canonical crop id, display strings rejected, "Other" excluded, Paddy grade ambiguity still explicit |

### 3.1 Claims proved rather than asserted

- **Configuration drives duration.** `processingMinutes(5000, ALIGARH)` is 150,
  not 120, purely because Aligarh's configured reference is 75 min / 2 500 kg.
  The brief's "50 quintal ≈ 2 hours" is *produced by* Agra's configuration.
- **The lane exclusion is real.** One test bypasses the service layer entirely
  and inserts an overlapping row directly; the database rejects it.
- **Concurrency is not theoretical.** Parallel booking requests are fired at the
  same centre-day and the resulting rows are checked for overlap.
- **Ownership, not obscurity, protects a booking.** A second farmer requesting
  another's `bookingCode` gets `404`.

---

## 4. Reproducibility gap found and closed

The Phase 7 suite could not be run from a clean checkout. Two things were missing.

**1. The database could not be provisioned without manual steps.** Both imports
refuse to run without a real `ADMIN` user — correctly, since no MSP rate or
centre configuration may enter the system unattributed. But the documented
reproduction steps said `A=<uuid-of-an-admin-user>` without saying how to obtain
one, and the admin in use (`Seed Operator`) had been created by hand in an
earlier session and never committed. Added:

- `server/scripts/seed-bootstrap-admin.sql` — the accountable administrator, at a
  fixed id, **with `password_hash` NULL so it cannot log in**. `verifyPassword()`
  returns false for a NULL hash after burning comparable work, so the account is
  attributable but not authenticable, and not enumerable by timing.
- `server/scripts/provision-database.sh` — migrations, admin, both imports in one
  command; `--recreate` drops and recreates first.

```
$ TEST_DATABASE_URL=... bash server/scripts/provision-database.sh --recreate
ready: 13 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings
```

**2. The integration suite is not self-cleaning, and cannot be.** It books real
windows against real lanes. A database carrying an earlier run's bookings has no
free window, so a *correct* engine reports `NO_AVAILABILITY`.

This is exactly what happened here. The first run of this session failed 25 of
48 tests, all with `422 NO_AVAILABILITY / ALL_DAYS_FULL`, against a database
holding 127 bookings left by a previous run that was interrupted mid-suite. The
scheduler was right and the fixture was stale: Agra's three lanes were genuinely
full for every day in the horizon. Re-provisioning and re-running gave 48/48
with no code change.

**Run the integration suite against a freshly provisioned database.** This is now
stated in `server/README.md` rather than left to be rediscovered.

---

## 5. Performance — measured, not assumed

The design (§17) promised a query plan in this report rather than speculative
optimisation. Here it is, for the one query availability runs per candidate day.

With **36 bookings** in the table, PostgreSQL chooses a sequential scan:

```
Sort  (cost=3.05..3.08 rows=13) (actual time=0.089..0.090 rows=12)
  ->  Seq Scan on bookings  (cost=0.00..2.81 rows=13) (actual rows=12)
        Rows Removed by Filter: 24
        Buffers: shared hit=2
```

**That is the planner being right, not an index being missing.** At two heap
pages, a scan is cheaper than an index descent. Forcing the choice confirms the
index is present and correctly shaped for the predicate:

```
SET enable_seqscan=off;
  ->  Bitmap Heap Scan on bookings  (cost=4.29..6.63 rows=13) (actual rows=12)
        Recheck Cond: ((centre_id = ...) AND (service_date = '2026-09-07'))
```

`bookings_centre_date_start_idx (centre_id, service_date, scheduled_start_at)`
matches the `(centre_id, service_date)` prefix, so the plan flips to the index as
the table grows. Execution time is 0.056–0.103 ms either way at this scale.

**Honest limitation:** this is demonstration-scale data. The plan is *correct*,
but 36 rows do not demonstrate behaviour at 36 000. No load test was run, and
none is claimed. No caching was introduced.

---

## 6. Risks and limitations carried forward

| | Item | Status |
|---|---|---|
| **R-7a** | `bookings_booking_code_format` fixes the code at 7 digits, so the space is 10⁷ — too small to be unguessable. Mitigated by ownership enforcement (`404`, never `403`), not by secrecy. Widening needs a migration | **Open, accepted** |
| **R-7b** | Storage is `ADVISORY` at all five centres and no centre has a linked facility, so no headroom is checked. `ENFORCED` mode is implemented but unreachable until real capacity data exists (D-8/D-10) | **Open by design** |
| **R-7c** | Integration tests require a freshly provisioned database (§4) | **Documented** |
| **R-7d** | Performance verified for plan shape only, not under load (§5) | **Open** |
| **R-7e** | `provision-database.sh` is bash only; `apply-migrations.ps1` has a PowerShell twin but this script does not. Not written because it could not be verified in this session | **Open** |
| **R-L** | `origin/faramqueue-feature` is still unmerged and conflicts with `main` | **Unchanged from Phase 4** |

### Deliberately absent

No SMS, no payment, no procurement workflow, no officer UI, no frontend
integration — all out of scope for Phase 7. Live queue position and dynamic ETA
are Phase 9; `estimatedApproachAt` therefore equals `scheduledStartAt`, because
no arrival lead time is configured and none is invented. `REMINDER_SENT`,
`APPROACHING` and `WAITING` remain derived `displayStatus`, never stored. The
withdrawn A-3 "one active booking per farmer per crop" rule was not reintroduced.
`booking_policies` is empty, so no volume limit applies — an empty policy table
means *no policy configured*.

---

## 7. How to reproduce

```bash
export PATH="<postgres>/bin:$PATH"
export TEST_DATABASE_URL="postgres://<user>@127.0.0.1:55432/farmqueue_test"

bash server/scripts/provision-database.sh --recreate

cd server
npx tsc --noEmit
node scripts/static-check.mjs
node --test --test-concurrency=1 tests/*.test.ts

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-schema.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-phase4.sql
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-d9.sql
```

Re-provision before re-running the tests (§4).

---

## Phase Completion Report

**IMPLEMENTED:** Availability search, booking creation, and cancellation across
five endpoints, a pure scheduling engine, and the transactional repository
holding both locks.

**TESTS:** **114/114 pass** overall; **48/48** for Phase 7 (18 pure + 30
integration). **50/50** SQL probes. `tsc --noEmit` clean. Static checker passed.

**FAILED TESTS:** 25 on the first run of this session — every one caused by stale
fixture data in a database left populated by an interrupted earlier run, not by a
defect. Diagnosed in §4, resolved by provisioning cleanly. **Zero application-code
fixes were required in Phase 7.**

**DESIGN CHANGES:** None. One layout deviation recorded in §2.1 (Zod schemas kept
in the routes file rather than a separate `bookings.schemas.ts`).

**NEW FILES:** `server/scripts/provision-database.sh`,
`server/scripts/seed-bootstrap-admin.sql`, `docs/api/bookings.md`, this report.

**NEXT PHASE:** Phase 8 — officer operations (`ARRIVED` through
`PROCUREMENT_RECORDED`), which the state machine and permission matrix already
anticipate. Phase 9 (live queue and dynamic ETA) depends on it, since queue
position is derived from what officers have actually recorded.

**STOP.** Awaiting approval.
