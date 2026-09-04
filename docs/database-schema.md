# Mandi Sahayak — Database Schema

**Phase:** 2 (Database + migrations)
**Engine:** PostgreSQL 13+ (target 16)
**Status:** **VERIFIED — executed against PostgreSQL 17.11 on 2026-09-02.**
**Migrations:** `server/migrations/0001` … `0011`

> All 11 migrations were applied twice from clean databases against PostgreSQL
> 17.11, and all 22 behavioural probes passed on both runs. See §9 for the
> verification record and the few items that remain outstanding.

---

## 1. Inventory

Counted from the migration source by `server/scripts/static-check.mjs`:

| Object | Count |
|---|---|
| Migration files | 11 (2 847 lines of SQL) |
| Tables | 48 |
| Domains | 6 |
| Primary keys | 48 |
| Foreign keys | 102 |
| `CHECK` constraints | 172 |
| `UNIQUE` clauses (table-level and column-level) | 26 |
| `EXCLUDE USING gist` constraints | 6 (was 7; the MSP one was replaced under D-9, migration 0013) |
| Standalone indexes | 128 (4 unique, 7 partial) |
| Triggers | 24 |
| Extensions | 1 (`btree_gist`) |

---

## 2. Migration order and contents

| File | Contents | Why it sits here |
|---|---|---|
| `0001_bootstrap` | Version guard, `btree_gist`, `schema_migrations`, 6 domains, `set_updated_at()`, `forbid_mutation()` | Everything downstream depends on the domains and the extension |
| `0002_provenance` | `data_sources` | Must exist before anything that can be classified `OFFICIAL` |
| `0003_reference` | `seasons`, `states`, `districts`, `villages`, `mandis`, `crops`, `crop_aliases` | Geography and crops precede the entities that locate themselves |
| `0004_identity` | `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `farmers`, `officers`, `sessions`, `pending_registrations`, `otp_challenges`, `consents`, `rate_limit_buckets`; adds the deferred FKs onto `data_sources` | Farmers reference districts and villages, so identity follows reference |
| `0005_centres` | `procurement_centres`, `centre_service_lanes`, `centre_operating_hours`, `centre_holidays`, `centre_crop_configurations`, `centre_slot_configurations`, `centre_daily_capacity`, `officer_centre_assignments` | Needs geography, crops, seasons and users |
| `0006_storage` | `storage_facilities`, `storage_capacity`, `storage_inventory`, `centre_storage_links` | Links to both geography and centres |
| `0007_msp` | `msp_import_batches`, `msp_rates`, `msp_import_rows` | Needs crops, seasons, data_sources and users |
| `0008_operations` | `booking_status_transitions`, `bookings`, `booking_status_history`, `booking_policies`, `procurements`, `payments`, `idempotency_keys` | Needs everything above |
| `0009_messaging` | `notification_templates`, `notifications` | References users and bookings |
| `0010_governance` | `audit_logs` (+ immutability), `reference_versions`, `job_runs` | Last, so `ON DELETE RESTRICT` covers every actor table |
| `0011_seed_system_vocabulary` | Roles, 37 permissions, the grant matrix, 2 seasons, 11 state transitions, version counters — **and the no-government-data assertion** | Seeds only after all target tables exist |

There is a circular reference between `data_sources` (which records *who*
retrieved a source) and `users` (whose reference tables are provenanced). It is
broken by creating `data_sources.retrieved_by_user_id` and
`last_verified_by_user_id` without foreign keys in `0002`, then adding those
constraints by `ALTER TABLE` in `0004`.

---

## 3. Domains (controlled vocabularies)

Defined once in `0001` and reused, so allowed values cannot drift between tables.

| Domain | Values |
|---|---|
| `data_type_t` | `OFFICIAL`, `CONFIGURED`, `TEST` |
| `data_scope_t` | `NATIONAL`, `STATE`, `DISTRICT`, `FACILITY`, `CENTRE` |
| `locale_t` | `en`, `hi` |
| `e164_t` | `text` matching `^\+[1-9][0-9]{7,14}$` |
| `booking_status_t` | the 9 canonical booking states (§5) |
| `notification_event_t` | the 8 notification event keys |

---

## 4. The invariants the database enforces

These are the constraints that make business rules structural rather than
merely conventional. Each is exercised by a probe in
`server/scripts/verify-schema.sql`.

### 4.1 Quantity — 25 to 50 quintal

```sql
CONSTRAINT bookings_quantity_within_business_rule
    CHECK (requested_quantity_kg BETWEEN 2500 AND 5000)
```

Canonical unit is kilograms; quintal never reaches the database. 2 499 and
5 001 are rejected by PostgreSQL itself, so no application path, admin script or
manual `INSERT` can bypass the rule.

### 4.2 Overbooking — structurally impossible

`bookings.service_window` is a generated column:

```sql
service_window tstzrange
    GENERATED ALWAYS AS (tstzrange(scheduled_start_at, scheduled_end_at)) STORED
```

`tstzrange(a, b)` defaults to `[)` — start inclusive, end exclusive — which is
what makes a booking starting exactly when another ends legal, and any true
overlap illegal.

```sql
CONSTRAINT bookings_no_lane_overlap
    EXCLUDE USING gist (centre_id WITH =, lane_no WITH =, service_window WITH &&)
    WHERE (status IN ('CONFIRMED','ARRIVED','WEIGHING','QUALITY_CHECK',
                      'PROCUREMENT_RECORDED','PAYMENT_PENDING'))
```

Two active bookings can never occupy the same lane at the same centre at
overlapping times. This holds even if every line of application code is wrong.
The constraint is partial: cancelled and completed bookings free their interval.

**Service lanes exist because of this constraint.** Without modelling parallel
counters, it would serialise a busy centre to one farmer at a time.
`centre_service_lanes` carries `UNIQUE (centre_id, lane_no)`, which also lets
`bookings` hold a composite foreign key onto a real lane.

### 4.3 Booking conflicts and duplicates (replacing the withdrawn A-3 rule)

You asked for uniqueness designed around the actual requirement rather than a
blanket per-crop rule. Two constraints, each targeting one real failure:

```sql
-- A farmer cannot be in two places at once.
CONSTRAINT bookings_no_farmer_overlap
    EXCLUDE USING gist (farmer_id WITH =, service_window WITH &&)
    WHERE (status IN (...active...))

-- An accidental double submission.
CREATE UNIQUE INDEX bookings_no_duplicate_active_per_farmer_centre_crop_date
    ON bookings (farmer_id, centre_id, crop_id, service_date)
    WHERE status IN (...active...)
```

What remains freely bookable: several future bookings, different centres,
different crops, different dates, and even two bookings on the same date at
non-overlapping times. **Volume limits are deliberately not constraints** — they
live as data in `booking_policies`, which this migration leaves empty pending
your policy decision, so changing the rule later is an `UPDATE` rather than a
migration against live bookings.

### 4.4 Provenance — `OFFICIAL` cannot be unsourced

Every table carrying `data_type` also carries:

```sql
CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL)
```

`msp_rates` and `storage_capacity` go further and additionally require
`source_reference` and `retrieved_at`; `msp_rates` also requires an
`import_batch_id`, so an `OFFICIAL` rate cannot be hand-inserted at all — only
the import pipeline can produce one.

### 4.5 Data scope cannot be laundered

`storage_capacity` records capacity at the granularity the source actually
published, and the schema refuses to let that change:

```sql
CONSTRAINT storage_capacity_scope_target CHECK (
    (data_scope = 'FACILITY' AND facility_id IS NOT NULL
                             AND district_id IS NULL AND state_id IS NULL)
 OR (data_scope = 'DISTRICT' AND facility_id IS NULL
                             AND district_id IS NOT NULL AND state_id IS NULL)
 OR (data_scope = 'STATE'    AND facility_id IS NULL
                             AND district_id IS NULL AND state_id IS NOT NULL)
 OR (data_scope = 'NATIONAL' AND facility_id IS NULL
                             AND district_id IS NULL AND state_id IS NULL)
)
```

A state-level figure physically cannot be attached to a warehouse. There is no
admin screen and no import script that can turn a state total into a facility's
capacity.

### 4.6 Temporal configuration is unambiguous

Five `EXCLUDE` constraints prevent overlapping validity ranges, so "which
configuration applied on 12 March" always has exactly one answer:

- `centre_operating_hours_no_overlap` — per centre, per weekday
- `centre_slot_configurations_no_overlap` — per centre
- `centre_crop_configurations_no_overlap` — per centre, crop, season, year
- `storage_capacity_facility_no_overlap` — per facility and capacity type
**MSP is no longer among them.** Migration `0013` (decision D-9) removed
`msp_rates_no_active_overlap` and replaced it with a partial unique index,
`msp_rates_one_active_per_identity`, on
`(crop_id, season_id, marketing_year, COALESCE(variety_or_grade, ''))`
`WHERE status = 'ACTIVE'`. A date-range exclusion cannot express identity once
`effective_from` may be NULL — two NULL ranges never overlap, so both rows would
be permitted. The `COALESCE` is retained because two NULL grades would otherwise
never conflict, leaving exactly the duplicate the rule exists to prevent.
See `docs/msp-data.md` and `docs/d9-correction-report.md`.

### 4.7 Physical and arithmetic sanity

```sql
-- procurements
CHECK (accepted_quantity_kg + rejected_quantity_kg <= gross_quantity_kg)
CHECK (status <> 'COMPLETED' OR (gross, accepted, rejected all present
                                 AND quality_status <> 'PENDING'))

-- payments
CHECK (amount_paise = GREATEST(base_amount_paise - deductions_paise, 0))
CHECK (status <> 'BLOCKED' OR blocked_reason IS NOT NULL)
CHECK (status <> 'BLOCKED' OR amount_paise IS NULL)
CHECK (status = 'BLOCKED' OR (amount_paise, base_amount_paise,
                              msp_rate_id, rate snapshot all present))
```

A blocked payment cannot assert an amount, and an unblocked one cannot exist
without the rate it was derived from — so every figure stays explainable after
the next MSP import.

### 4.8 Notification idempotency

`notifications.dedupe_key` is `NOT NULL UNIQUE`. If the reminder job runs twice
or two workers race, the second `INSERT` violates the constraint and is
discarded. Duplicate suppression is never an application-level "have we sent
this?" check, which is the check that fails under concurrency.

### 4.9 Audit immutability

Two independent mechanisms:

1. Three **statement-level** `BEFORE` triggers on `UPDATE`, `DELETE` and
   `TRUNCATE` that raise unconditionally. Statement-level rather than row-level
   so that even a zero-row `DELETE FROM audit_logs` is refused.
2. A conditional `REVOKE UPDATE, DELETE, TRUNCATE` for the application role,
   applied only if that role exists in the target environment.

`audit_logs.actor_user_id` uses `ON DELETE RESTRICT`, not `SET NULL` — a
`SET NULL` would be an `UPDATE` and would be blocked by the table's own trigger.
It also means a user who has acted can never be hard-deleted, which is the
correct outcome for an audit trail.

---

## 5. Booking state machine (Decision D-4)

Nine canonical states in `booking_status_t`:

```
CONFIRMED ─→ ARRIVED ─→ WEIGHING ─→ QUALITY_CHECK ─→ PROCUREMENT_RECORDED
                                                            │
                                                            ▼
                                                     PAYMENT_PENDING ─→ COMPLETED
CONFIRMED ─→ CANCELLED        ARRIVED/WEIGHING/QUALITY_CHECK ─→ CANCELLED
CONFIRMED ─→ NO_SHOW
```

`REMINDER_SENT`, `APPROACHING` and `WAITING` are deliberately **not** states:
the first is a delivery fact in `notifications`, the second is derived from live
ETA against a threshold, the third is a presentation form of `ARRIVED`. All three
reach the client as a derived `displayStatus`.

The 11 legal transitions live in `booking_status_transitions` as data. A
`BEFORE UPDATE OF status` trigger with `WHEN (OLD.status IS DISTINCT FROM
NEW.status)` rejects any pair absent from that table, so `COMPLETED → ARRIVED`
fails in the database and not only in the service layer. `COMPLETED`,
`CANCELLED` and `NO_SHOW` appear only as `to_status`, never as `from_status`,
which is what makes them terminal.

---

## 6. Concurrency structures (application logic is Phase 7/8)

| Layer | Structure | Prevents |
|---|---|---|
| 1 | `bookings_no_lane_overlap` | Two farmers on one lane at one time |
| 2 | `centre_daily_capacity` (PK `centre_id, service_date`) — the row taken `FOR UPDATE` first | Concurrent transactions each claiming the same spare daily capacity |
| 3 | `storage_inventory` (PK `facility_id`) — taken `FOR UPDATE` second | Concurrent over-reservation of storage |
| 4 | `bookings_no_farmer_overlap` + the duplicate-active unique index | A farmer double-booked against themselves |
| 5 | `idempotency_keys` | A retried or double-clicked request creating two bookings |

Fixed lock order — `centre_daily_capacity` → `storage_inventory` → `bookings` —
makes deadlock between booking transactions impossible. Phase 8 implements the
transaction that uses these; Phase 2 only provides the structures.

---

## 7. Units and representation

| Quantity | Type | Rationale |
|---|---|---|
| `bookings.requested_quantity_kg` | `INTEGER` | Farmer-declared whole kilograms, range-constrained in the column |
| `procurements.*_quantity_kg` | `NUMERIC(12,3)` | Weighbridge readings are fractional and must not be rounded on the way in |
| Storage capacity / inventory | `NUMERIC(14,3)` kg | Facility scale, same unit throughout |
| `msp_rates.rate_per_quintal_paise` | `BIGINT` | Stored exactly as published, per quintal; per-kg is derived at calculation time and never stored |
| `payments.*_paise` | `BIGINT` | No floating point ever holds a rupee value |
| Timestamps | `TIMESTAMPTZ` (UTC) | Instants |
| Operating hours | `TIME` + `procurement_centres.timezone` | A centre opens at 08:00 *local*; storing that as an instant would be wrong |

---

## 8. Data policy in the schema

- `data_type` is `NOT NULL` on all 15 externally-sourced or operator-supplied
  tables.
- **No migration inserts government data.** `0011` ends with a `DO` block that
  queries every government-data table and raises — aborting and rolling back the
  entire migration run — if any of them is populated.
- `0011` seeds only system vocabulary: 3 roles, 37 permissions, the grant matrix,
  2 season codes (`RMS`, `KMS`), 11 state transitions, 8 version counters.
- Season codes are vocabulary, not sourced data: **which** season a given MSP
  rate belongs to always comes from the source publication, never from an
  assumption about the crop.
- **Decision D-6** is visible as an absence: there is no `aadhaar_last4` column
  and no `ifsc_code` column anywhere in the 48 tables. The static checker fails
  the build if one is ever added.
- **Decision D-7** likewise: no account number, no account holder name.
  `payments.payment_reference` is an opaque string from whichever system paid.
- There is no plaintext `otp` column and no plaintext session-token column.
  `otp_challenges.otp_hash` and `sessions.token_hash` are `bytea`.

---

## 9. Verification record

**Verified against PostgreSQL 17.11** (`x86_64-windows`, `server_version_num` 170011)
on 2026-09-02, using a private cluster on a non-default port — no system-wide
install, no Windows service, no administrator rights.

| Item | Result |
|---|---|
| Migrations 0001-0011 applied to a clean database | **PASS**, first attempt, zero fixes |
| Second run after full `dropdb` / `createdb` | **PASS**, reproducible |
| Runner idempotency (re-run skips all 11) | **PASS** |
| `verify-schema.sql`, 22 probes, both runs | **22/22 PASS** |
| SQL syntax across all 11 files | **PASS** |
| `btree_gist` 1.7 installed | **PASS** |
| Generated column in an exclusion constraint (risk R-A) | **RESOLVED** — `service_window` is `attgenerated='s'` (STORED) and backs both booking exclusion constraints |
| All 7 `EXCLUDE USING gist` constraints created | **PASS** |
| `tstzrange` / `daterange` expressions accepted as immutable | **PASS** |
| Statement-level `TRUNCATE` trigger on `audit_logs` | **PASS** |
| Domain CHECKs and regexes under `standard_conforming_strings` | **PASS** |
| Quantity 2500-5000 enforced by the column | **PASS** (2499 and 5001 refused) |
| Booking overlap / farmer overlap / duplicate booking | **PASS** |
| `OFFICIAL` without `source_id` refused | **PASS** |
| Scope guard: STATE capacity cannot attach to a facility | **PASS** |
| Audit append-only (UPDATE/DELETE/TRUNCATE) | **PASS** |

Object counts as reported by PostgreSQL: 48 tables, 6 domains, 48 primary keys,
102 foreign keys, 178 CHECK constraints (172 table + 6 domain), 26 UNIQUE,
7 EXCLUDE, 209 indexes (11 partial), 24 triggers.

### Still outstanding

1. **Privilege revocation on `audit_logs` was skipped.** The `mandi-sahayak_app`
   role does not exist in the verification cluster, so `0010` emitted its
   NOTICE and moved on. The three immutability triggers were still active and
   still refused every mutation, but the `REVOKE` must be applied in any real
   deployment once the role exists.
2. **Index usefulness is unmeasured.** No query plan has been examined; that
   belongs with the Phase 7/8 engines under realistic data volumes.
3. **`service_date` vs `scheduled_start_at` consistency** remains an
   application-layer invariant (it needs a timezone conversion, which is not
   immutable and therefore cannot be a CHECK).

**To reproduce:**

```bash
export DATABASE_URL="postgres://<user>@<host>:<port>/mandi-sahayak"
bash server/scripts/apply-migrations.sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-schema.sql
```
