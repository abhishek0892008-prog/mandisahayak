# FarmQueue backend

Node.js + TypeScript + PostgreSQL backend for FarmQueue.
Design contract: [`../docs/architecture.md`](../docs/architecture.md).
Schema reference: [`../docs/database-schema.md`](../docs/database-schema.md).

**Current phase: 14 — officer provisioning.**

| Phase | Delivers | Report |
|---|---|---|
| 2 | Schema and migrations | [`../docs/database-schema.md`](../docs/database-schema.md) |
| 3 | PostgreSQL verification, official MSP data | [`../docs/phase-3-report.md`](../docs/phase-3-report.md) |
| 4 | Centres, lanes, hours, slot configuration | [`../docs/phase-4-report.md`](../docs/phase-4-report.md) |
| 5 | Authentication, sessions, RBAC, audit | [`../docs/phase-5-authentication.md`](../docs/phase-5-authentication.md) |
| 6 | Farmer profile and reference data | [`../docs/phase-6-farmer-domain.md`](../docs/phase-6-farmer-domain.md) |
| 7 | Availability, booking, cancellation | [`../docs/phase-7-report.md`](../docs/phase-7-report.md) |
| 8 | Officer operations and payment | [`../docs/phase-8-report.md`](../docs/phase-8-report.md) |
| 9 | Queue position and ETA | [`../docs/phase-9-report.md`](../docs/phase-9-report.md) |
| 10 | Notification outbox, farmer notifications | [`../docs/phase-10-report.md`](../docs/phase-10-report.md) |
| 12 | Templates, preferences, delivery provider, retry | *no report yet* |
| 13 | Admin centre configuration | [`../docs/api/admin.md`](../docs/api/admin.md) |
| 14 | Officer provisioning | [`../docs/api/admin.md`](../docs/api/admin.md) |

API contracts live in [`../docs/api/`](../docs/api/).

> ### Status
> Migrations are **applied and verified** against PostgreSQL 17.11, twice from
> clean databases, with identical object counts. 50 SQL probes and 323 tests
> pass, and the deny-by-default assertion clears all 68 declared routes.
> See the Phase 10 report for the full result table.

## Layout

```
server/
  migrations/          0001..0015, plain SQL, forward-only
  imports/             data, not schema; each requires an accountable ADMIN
  src/
    core/              config, db, http, session, rbac, crypto, audit, rate limiting
    domain/            shared business rules (quantity)
    engines/           scheduling, procurement, queue, notifications — PURE, no I/O and no clock
    modules/           auth, identity, reference, bookings, officer, queue, notifications
    integrations/      notifications/ — provider abstraction; DEMO adapter only
  tests/               integration over real HTTP against real PostgreSQL
  scripts/
    provision-database.sh    zero to bookable in one command
    seed-bootstrap-admin.sql the accountable ADMIN the imports demand
    apply-migrations.sh/.ps1 psql runners
    static-check.mjs         structure checker; no database, no dependencies
    verify-schema.sql        catalog assertions + behavioural probes; rolls back
    verify-phase4.sql        centre and slot configuration probes
    verify-d9.sql            MSP identity and effective-period probes
```

## Prerequisites

- PostgreSQL 13 or newer (17 is what this is verified against). Migration `0001`
  refuses to run on anything older.
- The `psql` client on PATH.
- A database, and a role able to `CREATE EXTENSION btree_gist`.
- Node 22.18+ to run the server or the tests (type stripping is used; there is no
  build step).

## Provision

One command takes an empty database to a bookable one — migrations, the
bootstrap administrator, then both imports under that administrator:

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/farmqueue"
bash server/scripts/provision-database.sh
```

Add `--recreate` to drop and recreate the database first.

Both imports **refuse to run without a real `ADMIN` user**, so that no MSP rate
and no centre configuration ever enters the system unattributed.
`seed-bootstrap-admin.sql` supplies that administrator at a fixed id with
**no password**, so the account can be attributed to but never logged in as.
Give real administrators real credentials through the staff account flow.

To apply migrations alone, without the imports:

```bash
bash server/scripts/apply-migrations.sh
```

Each migration file opens its own transaction and records itself in
`schema_migrations`, so a failure leaves the database exactly as it was and the
runner skips files already applied. Do not pass `--single-transaction`.

## Test

```bash
npm run typecheck        # tsc --noEmit
npm run static-check     # structure, without a database
npm test                 # 323 tests over real HTTP against real PostgreSQL
```

Point the suite at a database with `TEST_DATABASE_URL`.

> **The suite runs sequentially, and must.** `npm test` pins
> `--test-concurrency=1`. Node's test runner otherwise executes each file in its
> own process in parallel, and the three files share one database: they collide
> on registered phone numbers, and `resetRateLimits()` in one file truncates
> `rate_limit_buckets` out from under a rate-limit assertion in another. Running
> `node --test tests/*.test.ts` without the flag fails around 20 tests for that
> reason alone. Isolating the files would need a database per file; sequencing
> them is the cheaper correct answer, and the suite takes seconds.

> **Provision a fresh database before each run.**
>
> ```bash
> TEST_DATABASE_URL=... bash server/scripts/provision-database.sh --recreate
> TEST_DATABASE_URL=... npm test
> ```
>
> The suite is **not self-cleaning, and cannot be**: it books real windows
> against real lanes. A database still holding an earlier run's bookings has no
> free window left, so a *correct* scheduler answers `NO_AVAILABILITY` and the
> booking tests fail. That is stale fixture data, not a defect. Nothing is
> mocked — session revocation, CSRF, rate limiting, audit immutability, RBAC and
> lane exclusion only exist end to end.

Then verify the schema itself against the migrated database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-phase4.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-d9.sql
```

Each inserts TEST-classified fixtures, attempts operations that must be refused
(a 2 499 kg booking, an overlapping lane, an illegal state transition, an
unsourced OFFICIAL row, a tampered audit row), reports one line per check, and
**ends with `ROLLBACK`** — nothing they create is ever committed.

## Run

```bash
npm start                # node src/index.ts
```

The server refuses to start if any route declares no permission, so "I forgot to
protect the endpoint" is a boot failure rather than a security incident.

## Data policy

`data_type` is `NOT NULL` on every externally-sourced table, and
`CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL)` means the database
itself refuses an unsourced official claim.

**No migration inserts government data.** Migration `0011` ends with an assertion
that aborts the run if any government-data table has been populated. MSP and
geography arrive through `imports/`, with provenance and a named administrator.

Where a value is genuinely unavailable it is reported as unavailable. Centre-level
storage capacity is the standing example: it is published at national and state
level only, so no centre-level figure is derived, and the booking API returns
`NO_CAPACITY_DATA_FOR_CENTRE` rather than a number.

## Conventions

| Concern | Rule |
|---|---|
| Money | `BIGINT` paise. Never floating point |
| Mass | kilograms. `INTEGER` for farmer-declared quantities, `NUMERIC(12,3)` for measured weights |
| Time | `TIMESTAMPTZ` in UTC; centre hours as `TIME` plus the centre's IANA timezone |
| Identifiers | `uuid` primary keys; `booking_code` and `token_number` are the human-facing ones |
| Enumerations | `TEXT` with a `CHECK`, or a domain where the vocabulary is reused |
| Deletion | Entities with history are never hard-deleted; they carry a status |
| Migrations | Forward-only. Never edit an applied file; add a new one |
| Configuration | Scheduling reads `centre_slot_configurations`. No duration, buffer or horizon is hardcoded |
