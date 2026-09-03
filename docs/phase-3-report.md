# FarmQueue — Phase 3 Report

**Phase:** 3 — Real PostgreSQL verification + official government-source research
**Date:** 2026-09-02
**Status:** **PHASE 3A VERIFIED · PHASE 3B PARTIALLY COMPLETE**

> This report supersedes the earlier `POSTGRESQL_VERIFICATION_BLOCKED` version.
> Every claim marked **VERIFIED** below was produced by executing SQL against a
> real PostgreSQL 17.11 server. Everything else is explicitly marked
> **UNVERIFIED**, **NOT IMPORTED** or **NOT AVAILABLE**.

---

## PART A — POSTGRESQL VERIFICATION · **VERIFIED**

### A.1 Environment

| Item | Value |
|---|---|
| **PostgreSQL version** | `PostgreSQL 17.11 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit` |
| `server_version_num` | `170011` |
| Binaries | Official EnterpriseDB PostgreSQL 17.11-2 Windows x64 archive |
| Install type | **Private cluster.** No system-wide install, no Windows service, no administrator/UAC, nothing written outside the session temp directory |
| Port | `55432` (non-default), `listen_addresses=127.0.0.1` only |
| Data directory | Temporary, inside the session scratchpad |
| Auth | `trust`, loopback only — the cluster is unreachable from outside this machine |
| Database | `farmqueue_verify` |
| `btree_gist` | **1.7, installed and working** |
| `pgcrypto` | **Not installed and not required** — `gen_random_uuid()` is core from PG13; confirmed working without it |

No credential exists to leak: the cluster uses loopback trust authentication and
has no password. Nothing was written to `server/.env`, and no connection string
appears in any committed file.

### A.2 Migration and verification results

| Step | Result |
|---|---|
| Clean database created, 0 tables in `public` | **VERIFIED** |
| Migrations 0001–0011 applied with `ON_ERROR_STOP=1` | **11/11 PASS, first attempt, zero fixes** |
| `verify-schema.sql` — 22 probes | **22/22 PASS** |
| Database dropped entirely (`dropdb`, existence count 0) | **VERIFIED** |
| Full sequence re-run from zero on a fresh database | **11/11 PASS** |
| `verify-schema.sql` on the second database | **22/22 PASS** |
| Runner idempotency — third invocation | **All 11 correctly skipped** |
| Object counts identical across both runs | **VERIFIED** (48 tables, 102 FKs, 7 EXCLUDE, 209 indexes) |

Migrations are **reproducible**: two independent clean-database runs produced
byte-identical object counts.

### A.3 Every feature you listed, as PostgreSQL actually reports it

| Feature | Status | Evidence |
|---|---|---|
| `btree_gist` | **VERIFIED** | `pg_extension` reports `btree_gist v1.7` |
| `pgcrypto` | **N/A — not required** | `gen_random_uuid()` returns a value with no extension installed |
| `EXCLUDE USING GIST` | **VERIFIED** | All 7 created; `pg_get_constraintdef` reproduces each |
| `tstzrange` | **VERIFIED** | `service_window` is type `tstzrange`; overlap probes behave correctly |
| `daterange` | **VERIFIED** | 5 temporal constraints use `daterange(effective_from, effective_to)`; accepted as immutable |
| **Generated columns** | **VERIFIED — risk R-A RESOLVED** | `service_window` has `attgenerated='s'` (STORED) **and** backs two exclusion constraints. This was Phase 2's single highest unknown |
| Triggers | **VERIFIED** | 24 non-internal triggers, incl. the statement-level `TRUNCATE` trigger |
| Partial indexes | **VERIFIED** | 11 partial indexes reported by `pg_index.indpred` |
| CHECK constraints | **VERIFIED** | 178 (172 table + 6 domain) |
| UNIQUE constraints | **VERIFIED** | 26 |
| Foreign keys | **VERIFIED** | 102, and every one is the leading column of an index (probe A6) |
| Audit immutability | **VERIFIED** | UPDATE, DELETE **and** TRUNCATE all refused (probe B11) |
| `OFFICIAL` ⇒ `source_id` | **VERIFIED** | Enforced on every classified table (A4); unsourced insert refused (B6) |
| `data_scope` protection | **VERIFIED** | STATE capacity cannot attach to a facility; FACILITY scope cannot float free (B7) |
| Quantity 2500–5000 | **VERIFIED** | 2500 and 5000 accepted; **2499 and 5001 refused by the database** (B1, B2) |
| Procurement invariants | **VERIFIED** | `accepted + rejected > gross` refused (B8) |
| Booking overlap protection | **VERIFIED** | Same-lane overlap refused; back-to-back allowed; cross-centre farmer conflict refused (B3, B4) |
| Duplicate booking protection | **VERIFIED** | Same farmer/centre/crop/date refused (B12) |
| State machine | **VERIFIED** | `ARRIVED → COMPLETED` refused, `ARRIVED → WEIGHING` allowed (B5) |

### A.4 Fixes

**Zero migration fixes were required.** No migration file was altered during
Phase 3, and the schema was not weakened to accommodate anything.

One fix was made to a **new Phase 3 import file** (not a migration) — see B.4.

### A.5 Outstanding from Part A

1. **`audit_logs` privilege revocation was skipped.** `0010` looks for a
   `farmqueue_app` role, which does not exist in the verification cluster, so it
   emitted its NOTICE and continued. The three immutability triggers were active
   and refused every mutation regardless, but the `REVOKE` must be applied in a
   real deployment once the role exists. **UNVERIFIED in production form.**
2. **Index usefulness is unmeasured** — no query plan was examined. Belongs with
   the Phase 7/8 engines under realistic volumes.
3. **The verification database is ephemeral.** It lives in a temp directory and
   will not survive. Everything in Part B must be re-run against the real
   database when one exists.

---

## PART B — GOVERNMENT DATA

### B.1 MSP sources found — both official, both retrieved

| # | Source | Publisher | Scope | Published | Retrieved |
|---|---|---|---|---|---|
| 1 | [Cabinet approves MSP for Rabi Crops for Marketing Season 2026-27](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2173567) — PRID 2173567 | Press Information Bureau, Ministry of Agriculture & Farmers Welfare, GoI | **NATIONAL** | 01 Oct 2025, 3:31 PM | 2026-09-02 |
| 2 | [Cabinet approves MSP for Kharif Crops for Marketing Season 2026-27](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2260618) — PRID 2260618 | Press Information Bureau, Ministry of Agriculture & Farmers Welfare, GoI | **NATIONAL** | 13 May 2026, 3:25 PM | 2026-09-02 |

Both are primary Government of India publications on `pib.gov.in`. **No
third-party aggregator was used, and nothing scraped from one has been labelled
OFFICIAL.** Values were read directly from the published HTML tables.

Also identified as authoritative but **not used this phase**: the Directorate of
Economics & Statistics MSP statement (`desagri.gov.in`), CACP, and the Farmers'
Portal. These are the correct sources for a cross-check (see B.5).

### B.2 MSP data imported — **23 rows, all OFFICIAL, all NATIONAL scope**

Imported into the verification database by
`server/imports/0001_msp_rms_2026_27_kms_2026_27.sql`.
20 crops, 2 sources, 2 import batches, 23 rate rows, all in **rupees per quintal
exactly as published**, stored as integer paise.

**RMS 2026-27** (6 crops, single rate each): Wheat 2585 · Barley 2150 ·
Gram 5875 · Lentil (Masur) 7000 · Rapeseed & Mustard 6200 · Safflower 6540.

**KMS 2026-27** (14 crops, 17 rows — three crops are published per variety):
Paddy **Common 2441 / Grade A 2461** · Jowar **Hybrid 4023 / Maldandi 4073** ·
Bajra 2900 · Ragi 5205 · Maize 2410 · Tur (Arhar) 8450 · Moong 8780 · Urad 8200 ·
Groundnut 7517 · Sunflower Seed 8343 · Soybean (Yellow) 5708 · Sesamum 10346 ·
Nigerseed 10052 · Cotton **Medium Staple 8267 / Long Staple 8667**.

RMS and KMS are **not mixed**: season comes from the publication that carried the
rate, never inferred from the crop.

### B.3 MSP data scope

**NATIONAL for every row.** Confirmed by query: 0 rows at any narrower scope.
These are national MSPs; they are not state, district or centre values and the
schema records them as such.

### B.4 The import was refused once — correctly

The first import attempt **failed**, and it should have:

```
ERROR: new row for relation "msp_import_batches"
violates check constraint "msp_import_batches_activation_consistent"
```

I had set `activated_by_user_id` to NULL. The constraint requires an ACTIVATED
batch to name an accountable administrator. This is the governance control
working exactly as designed — no MSP rate can enter the system without a named
human accepting responsibility.

**Fix (to the import file, not the schema):** the import now requires
`-v activating_admin=<uuid>` and verifies that user actually holds the `ADMIN`
role. Both refusals were then tested:

| Probe | Result |
|---|---|
| Import with no activating admin | **Refused** — `activating_admin must be supplied` |
| Import naming a user who is not an ADMIN | **Refused** — `user … is not an ADMIN` |
| Import naming a genuine ADMIN | **Accepted**, 23 rows |

(A second, unrelated defect was fixed in the same file: psql does not substitute
`:variables` inside `$$` blocks, so the parameter is now resolved outside the
dollar quoting.)

### B.5 MSP constraints exercised against the real data — 4/4 PASS

| Probe | Result |
|---|---|
| C1 — a second ACTIVE Wheat RMS 2026-27 rate with NULL grade | **Refused.** Proves `COALESCE(variety_or_grade,'')` closes the NULL-vs-NULL gap that would otherwise let two ungraded rates coexist |
| C2 — duplicate Paddy "Common" refused, but a *different* grade accepted | **PASS.** Grade-level resolution works on genuinely graded government data |
| C3 — OFFICIAL rate without source/batch | **Refused** |
| C4 — every MSP row remains at NATIONAL scope | **PASS**, 0 violations |

C1 and C2 are the ones that matter: real published data has both ungraded crops
and multi-grade crops, and the schema handles both without ambiguity.

### B.6 Known gap in the MSP data — **effective period NOT PUBLISHED**

Neither release states an `effective_from` or `effective_to` date. The schema
requires `effective_from`, so it is set to the **Cabinet approval date printed on
the release** — a published fact, not a guess — and `effective_to` is NULL.

**Consequence, stated plainly:** a date-based lookup for KMS 2026-27 before
13 May 2026 will find nothing, because that is when the rate was approved. The
authoritative key for these rates is **(crop, season, marketing_year, grade)**,
not the date range.

**Proposed refinement for Phase 4 — not implemented:** make the MSP resolver key
primarily on season + marketing year, treating the date range as a secondary
filter only when a source actually publishes one. Requires your approval; I have
not changed the resolver contract.

### B.7 Verification status of the MSP values — **NOT INDEPENDENTLY VERIFIED**

`verified_at` is **NULL on all 23 rows**, deliberately. The values were read from
the official releases, but have **not** been cross-checked against a second
official publication (e.g. the DES MSP statement). Until that check is recorded,
these should be described as *retrieved from an official source*, not as
*verified*. The database reflects this honestly.

### B.8 Storage sources found — and the granularity gap

| Source | Scope actually published |
|---|---|
| [FCI storage capacity — PIB PRID 1945170](https://www.pib.gov.in/PressReleasePage.aspx?PRID=1945170) (02 Aug 2023) | **NATIONAL total + STATE-wise statement.** As on 01.07.2023: 1 923 warehouses, 371.93 LMT, "Statement showing State-wise covered storage capacity is given below" |
| [Storage of Foodgrains — PIB PRID 1578907](https://www.pib.gov.in/Pressreleaseshare.aspx?PRID=1578907&reg=3&lang=2) | **NATIONAL**, split covered vs CAP, aggregated across FCI + CWC + State agencies |
| Agmarknet / eNAM (`agmarknet.gov.in`, `enam.gov.in`) | Mandi/market master and price data — **market level**, no storage capacity |

**Finding: `NO_CAPACITY_DATA_FOR_CENTRE`.**

Official storage capacity is published at **national, state and agency level**.
No official source located in this phase publishes storage capacity **per
procurement centre**, and none publishes **live occupancy** at all. This is
exactly the gap Phase 0 predicted, now confirmed against real sources.

The figures above are cited **only to establish granularity**. They are dated
2019 and 2023, they are not current, and **none has been imported**.

### B.9 Storage data imported — **NONE**

`storage_facilities`, `storage_capacity`, `storage_inventory`,
`procurement_centres` and `mandis` all contain **0 rows**. Verified by query.

No state-level figure was converted into a centre-level capacity. The schema
makes that impossible anyway — probe B7 proves a STATE-scoped capacity row
cannot reference a facility.

**The approved D-8 behaviour is intact and verified in the running database:**
`procurement_centres.storage_check_mode` has default `'ADVISORY'`. A centre with
no capacity data will book normally and report
`NO_CAPACITY_DATA_FOR_CENTRE` rather than invent headroom.

### B.10 Procurement / mandi information

Authoritative candidates identified — Agmarknet, eNAM (1 522 markets across 23
states and 4 UTs), and the Local Government Directory for district/village codes.
**Nothing imported.** Centre and mandi master data is Phase 4 work, and it
depends on confirming the geographic scope (open question A-6).

---

## Data classification summary

| Class | Count | Detail |
|---|---|---|
| **OFFICIAL** | 23 MSP rates, 20 crops, 2 data sources, 2 import batches | All carry `source_id`, `source_reference`, `retrieved_at`, `data_scope`, and an activating administrator |
| **CONFIGURED** | **0** | No operational configuration entered yet |
| **TEST** | **0 persisted** | The only TEST rows are fixtures inside `verify-schema.sql`, which ends in `ROLLBACK` |
| **UNAVAILABLE** | Centre-level storage capacity; live storage occupancy; MSP effective periods | Reported as unavailable. **No substitute value invented for any of them** |

---

## Phase Completion Report

**POSTGRESQL VERSION:** PostgreSQL 17.11 on x86_64-windows (`server_version_num` 170011).

**SERVER STATUS:** Private cluster running on `127.0.0.1:55432`, temporary data
directory, loopback-only, no service, no admin rights, no system-wide install.
Still running — stop with `pg_ctl -D <scratchpad>/pgdata stop`.

**MIGRATIONS EXECUTED:** 11 of 11 — twice, from two independently created clean databases.

**MIGRATION RESULT:** **PASS** both times, first attempt, `ON_ERROR_STOP=1`, zero migration fixes.

**SCHEMA VERIFICATION:** **VERIFIED.** All 20 features listed in your Step 9
confirmed against the live server. Risk R-A (generated column in an exclusion
constraint) is **RESOLVED**.

**BEHAVIOURAL PROBES:** **22/22 PASS** on run 1, **22/22 PASS** on run 2, plus
**4/4 PASS** on the MSP-against-real-data probes. **26 probes total, 0 failures.**

**FAILED TESTS:** One — the first MSP import attempt, refused by
`msp_import_batches_activation_consistent` for naming no accountable
administrator. The schema was right and the import file was wrong.

**FIXES:** **Zero migration fixes.** Two fixes to the new import file: require and
validate an activating ADMIN; resolve the psql variable outside `$$` quoting.
Two documentation corrections (`database-schema.md` §9 and the static checker's
closing message) which still claimed the schema was unverified.

**SECOND CLEAN-RUN RESULT:** **PASS.** Database dropped entirely, recreated,
all 11 migrations re-applied, all 22 probes re-passed, identical object counts.
Runner idempotency confirmed. **Migrations are reproducible.**

**MSP SOURCES:** 2 official GoI publications (PIB PRID 2173567 for RMS 2026-27,
PIB PRID 2260618 for KMS 2026-27). No third-party source used.

**MSP DATA:** 23 rate rows across 20 crops, RMS and KMS 2026-27, rupees per
quintal exactly as published, stored as integer paise, with full provenance and
an accountable activating administrator. Grade-level rates preserved for Paddy,
Jowar and Cotton.

**MSP DATA SCOPE:** **NATIONAL** on every row. 0 rows at any narrower scope.

**STORAGE SOURCES:** FCI/PIB national and state-wise statements; Agmarknet/eNAM
for market master data. All identified, none imported.

**STORAGE DATA:** **NONE IMPORTED.** All storage tables contain 0 rows.

**STORAGE DATA SCOPE:** Official publication is **NATIONAL and STATE** only.
**`NO_CAPACITY_DATA_FOR_CENTRE`** — no official centre-level capacity exists, and
no state figure was converted into one. `ADVISORY` default verified in the schema.

**OFFICIAL DATA:** 23 MSP rates + 20 crops + 2 sources + 2 batches, each with
source URL, document reference, retrieval date and data scope.

**CONFIGURED DATA:** None.

**TEST DATA:** None persisted.

**UNAVAILABLE DATA:** Centre-level storage capacity · live storage occupancy ·
MSP effective periods · centre and mandi master data. All reported as
unavailable; **no example value substituted for any of them**.

**KNOWN LIMITATIONS:**
1. The verification database is **ephemeral** — in a temp directory, and will not
   survive. The MSP import must be re-run against a persistent database.
2. MSP values are **retrieved but NOT independently cross-checked** —
   `verified_at` is NULL on all 23 rows by design.
3. MSP **effective periods are not published**; `effective_from` uses the Cabinet
   approval date and date-based lookups behave accordingly (B.6).
4. The `audit_logs` privilege `REVOKE` was skipped because the `farmqueue_app`
   role does not exist in the verification cluster.
5. Index performance unmeasured.

**RISKS:**
- **R-A: CLOSED.** The overbooking guarantee is now proven on real PostgreSQL.
- **R-H: reduced.** Phase 2's verification debt is cleared; Phase 4 will build on
  a schema that has accepted and rejected real rows correctly.
- **R-J (new):** the MSP values are single-sourced. A transcription error would
  propagate into payment calculations. Mitigation: the cross-check in B.5 must be
  performed and `verified_at` set before any payment is computed from these rates.
- **R-K (new):** MSP rates are national, but procurement policy and any state
  bonus are not. Phase 11 must not present a national MSP as the final payable
  amount without confirming state-level policy.
- **R-I: unchanged** — no hosted database was used, so no project data left this
  machine.

**NEXT PHASE:** Phase 4 — procurement centres, mandi relationships, storage
facilities and operational configuration, with the same provenance discipline.
Blocked on open question A-6 (which state/districts are in scope), since that
determines which state procurement authority is the correct source.

**STOP.** Awaiting approval.

---

## Sources

- [Cabinet approves MSP for Rabi Crops for Marketing Season 2026-27 (PIB PRID 2173567)](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2173567)
- [Cabinet approves MSP for Kharif Crops for Marketing Season 2026-27 (PIB PRID 2260618)](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2260618)
- [FCI has 1923 warehouses with capacity of 371.93 LMT (PIB PRID 1945170)](https://www.pib.gov.in/PressReleasePage.aspx?PRID=1945170)
- [Storage of Foodgrains (PIB PRID 1578907)](https://www.pib.gov.in/Pressreleaseshare.aspx?PRID=1578907&reg=3&lang=2)
- [Directorate of Economics & Statistics — Latest MSP Statement](https://desagri.gov.in/statistics-type/latest-minimum-support-price-msp-statement/)
- [eNAM — National Agriculture Market](https://enam.gov.in/web/)
- [Agmarknet](https://agmarknet.gov.in)
