# Mandi Sahayak — D-9 Correction Report

**Task:** Implement the approved D-9 correction to MSP identity and effective period
**Date:** 2026-09-02
**Status:** **COMPLETE — VERIFIED against PostgreSQL 17.11**
**Result:** **50/50 probes pass, twice, from clean databases**

---

## 1. What was wrong

`0007_msp.sql` declared `msp_rates.effective_from NOT NULL` and enforced
uniqueness with a date-range exclusion constraint. Neither Cabinet release
publishes an effective period, so the Phase 3 import had to write *something*
into that column and used the Cabinet approval date.

That converted a **provenance fact** — when the rate was decided — into a
**policy claim the source never made** — when the rate applies. The visible
symptom: a date-based lookup for KMS 2026-27 before 13 May 2026 returned nothing,
implying no MSP existed for that marketing season, which is false.

---

## 2. Migration created

**`server/migrations/0013_msp_identity_resolution.sql`** — one forward-only
migration. No earlier migration was rewritten, and no migration history was
deleted.

### 2.1 Schema changes

| # | Change | Purpose |
|---|---|---|
| 1 | `ALTER TABLE msp_rates ALTER COLUMN effective_from DROP NOT NULL` | A source may legitimately publish no effective period. NULL now means *"the publication stated no period"*, not *"unknown"* |
| 2 | `ADD CONSTRAINT msp_rates_effective_to_requires_from CHECK (effective_to IS NULL OR effective_from IS NOT NULL)` | **New constraint.** Closes a gap the change would otherwise open: the pre-existing range CHECK evaluates to NULL — and so passes — when `effective_from` is NULL, which would have allowed a dangling end date |
| 3 | `DROP CONSTRAINT msp_rates_no_active_overlap` | A date-range exclusion cannot express identity once the dates are NULL: two NULL ranges never overlap, so both rows would be permitted |
| 4 | `CREATE UNIQUE INDEX msp_rates_one_active_per_identity ON msp_rates (crop_id, season_id, marketing_year, COALESCE(variety_or_grade, '')) WHERE status = 'ACTIVE'` | States the D-9 identity directly. `COALESCE` is retained because two NULL grades would otherwise never collide — exactly the duplicate the index exists to prevent |

Net: exclusion constraints 7 → **6**; indexes 209 → **210**; CHECK constraints
178 → **180** (the new one plus its domain counterpart). Nothing else touched.

### 2.2 Data correction

```sql
UPDATE msp_rates m
SET    effective_from = NULL, effective_to = NULL
FROM   data_sources s
WHERE  m.source_id = s.id
  AND  m.effective_from IS NOT NULL
  AND  m.effective_from = s.reference_date
  AND  m.effective_to IS NULL;
```

**Precisely targeted.** It corrects only rows whose `effective_from` exactly
equals *their own source's* published `reference_date` — the signature of an
approval date having been written into the effective-period column. A rate
carrying a genuinely published effective period would not match and is left
alone.

The migration then **asserts** the outcome and raises if any row still carries
its source's reference date as `effective_from`, so a partial correction cannot
pass silently.

### 2.3 What the migration deliberately does not do

- Does not alter a single rate value.
- Does not create or delete any MSP record.
- Does not touch `source_id`, `source_reference`, `retrieved_at`, `verified_at`
  or `import_batch_id`.
- Does not add a duplicate date column — the Cabinet approval date is already
  preserved in `data_sources.reference_date`, which exists for that purpose.
- Does not weaken provenance in any way.

---

## 3. Import corrected

**`server/imports/0001_msp_rms_2026_27_kms_2026_27.sql`** now sets **neither**
`effective_from` nor `effective_to`. Both columns were removed from the two
`INSERT` column lists and from their value rows.

The `SUPERSEDED IN PART BY D-9` warning banner added during Phase 4 has been
replaced with a statement of compliance. The Cabinet approval dates remain in the
file exactly once each — as `data_sources.reference_date` (2025-10-01 for RMS,
2026-05-13 for KMS), which is provenance, not policy.

---

## 4. Resolver contract

Documented in `docs/msp-data.md` §5, before implementation, as D-9 required.

```
BEFORE:  resolveMsp({ cropId, seasonId, marketingYear, grade?, onDate })
             -> one ACTIVE row whose effective range contains onDate

AFTER:   resolveMsp({ cropId, seasonId, marketingYear, grade? })
             -> one ACTIVE row for that identity
```

`onDate` is removed. This is safe because a booking already carries
`season_id` and `marketing_year` as `NOT NULL` columns, so the marketing season
is an attribute of the transaction and never has to be inferred from the
calendar. The change has **no callers** — no engine, service or endpoint exists
yet — so nothing running is affected. It was stated explicitly, not made silently.

### 4.1 NULL-grade ambiguity is handled explicitly, never silently

This is not a theoretical branch. **Paddy KMS 2026-27 is published as two graded
rates — Common ₹2441 and Grade A ₹2461 — with no ungraded fallback row.** A
grade-less lookup for Paddy therefore genuinely cannot resolve to one rate.

The contract is:

- exact grade match first;
- fall back to the NULL-grade row **only if the source published one**;
- **zero matches → `MSP_NOT_AVAILABLE`** — never a default, never a neighbouring
  year, never last season's rate;
- **more than one match → `MSP_AMBIGUOUS`** — never an arbitrary pick.

Probe **D9-7** asserts this exact shape in the real imported data: 2 graded
candidates, 0 ungraded fallback. The database cannot resolve it, and the resolver
is contractually required to fail loudly rather than choose.

---

## 5. Provenance preservation — verified

| Field | State after correction |
|---|---|
| `source_id` | intact on all 23 rows |
| `source_reference` | intact (PIB PRID and table name) |
| `retrieved_at` | intact |
| `import_batch_id` | intact — an OFFICIAL rate still cannot be hand-inserted |
| `verified_at` | still **NULL** on all 23 rows (D-11 — not independently cross-checked) |
| `data_scope` | still `NATIONAL` on all rows |
| Cabinet approval dates | preserved in `data_sources.reference_date` |

Probe **D9-9** confirms an unsourced OFFICIAL rate is still refused, and that all
23 rows retain complete provenance.

---

## 6. Tests

### 6.1 New — 12 D-9 probes (`server/scripts/verify-d9.sql`)

| Probe | Asserts |
|---|---|
| D9-1 | `effective_from` NULL on all 23 rows |
| D9-2 | No approval date used as an effective period; both approval dates still present as provenance |
| D9-3 | Duplicate **graded** ACTIVE rate refused |
| D9-4 | Duplicate **NULL-grade** rate refused — proves `COALESCE` closes the gap |
| D9-5 | A genuinely different grade is still accepted |
| D9-6 | A different marketing year is a distinct identity |
| D9-7 | Grade-less Paddy lookup is genuinely ambiguous, not silently resolvable |
| D9-8 | Ungraded crop resolves to exactly one rate |
| D9-9 | Provenance still mandatory and intact on all 23 rows |
| D9-10 | Dangling `effective_to` refused |
| D9-11 | An explicitly published effective period is still storable |
| D9-12 | Published rate values unchanged by the correction |

### 6.2 Existing suites updated

Probe **A5** expected 7 exclusion constraints and named
`msp_rates_no_active_overlap`. Since 0013 intentionally removes it, A5 now
expects **6** and a new probe **A5b** asserts the replacement exists *and* the old
constraint is gone — so the removal is verified as deliberate rather than silently
tolerated. Schema suite: 22 → **23 probes**.

### 6.3 A test-design defect I found and fixed

The first D-9 run reported 2 failures. Both were **my probe design, not the
schema**: D9-5 and D9-6 assert that an insert *succeeds*, and those rows then
persisted inside the transaction, inflating the counts asserted by D9-7 (3 Paddy
candidates instead of 2) and D9-9 (25 provenanced rows instead of 23).

Fixed by making every "accepted" probe self-undoing: it raises a sentinel
`SQLSTATE '99999'` after a successful insert and catches it, rolling that insert
back while still recording success. The probes are now order-independent and
cannot contaminate one another.

---

## 7. Clean-run result

**PostgreSQL version:** `PostgreSQL 17.11 on x86_64-windows, compiled by
msvc-19.44.35228, 64-bit` (`server_version_num` 170011), private cluster on
127.0.0.1:55432.

| | Run 1 | Run 2 |
|---|---|---|
| `dropdb` + `createdb` | clean | clean |
| Migrations 0001–**0013** | **13/13 PASS** | **13/13 PASS** |
| Import 0001 — OFFICIAL MSP | PASS, 23 rates | PASS, 23 rates |
| Import 0002 — CONFIGURED geography | PASS | PASS |
| `verify-schema.sql` | **23/23** | **23/23** |
| `verify-phase4.sql` | **15/15** | **15/15** |
| `verify-d9.sql` | **12/12** | **12/12** |
| **Total** | **50/50, 0 failures** | **50/50, 0 failures** |

Static checker: **PASSED**, 0 failures, 0 warnings.

### 7.1 Upgrade path proven separately

A clean run exercises steps 1–3 of the migration but leaves the data correction a
no-op, since `msp_rates` is empty. So the correction was tested on a database
carrying the pre-D-9 data: migrations 0001–0012 only, then MSP rows inserted with
`effective_from = 2025-10-01` (the approval date), then 0013 applied.

| | Before 0013 | After 0013 |
|---|---|---|
| Wheat `effective_from` | `2025-10-01` | **NULL** |
| Barley `effective_from` | `2025-10-01` | **NULL** |
| Wheat rate | 258500 paise | **258500 paise** |
| Barley rate | 215000 paise | **215000 paise** |
| `source_reference` / `retrieved_at` / `source_id` / `import_batch_id` | present | **all present** |
| `data_sources.reference_date` | 2025-10-01 | **2025-10-01** |

The migration reported `D-9: msp_rates identity is now
crop+season+marketing_year+grade; 2 rate(s) present.` and its post-condition
assertion passed.

---

## 8. Risks and limitations

| # | Item |
|---|---|
| **R-M — CLOSED** | D-9 non-compliance is resolved. The repository no longer represents an approval date as an effective period anywhere |
| **R-J — unchanged, high** | The 23 MSP values remain **single-sourced**, `verified_at` NULL. A transcription error would still propagate into payment. The cross-check against a second official source (DES statement, `desagri.gov.in`) must happen **before** any payment is computed from these rates |
| **R-K — unchanged** | National MSP is not necessarily the final payable rate; state bonuses and procurement incentives are unresearched |
| **New limitation** | The resolver *function* is not written — only its contract and the schema that enforces it. `MSP_NOT_AVAILABLE` and `MSP_AMBIGUOUS` must be implemented as real error codes in the phase that builds the payment engine |
| **New limitation** | No source publishing an explicit effective period has been encountered, so probe D9-11 verifies that path synthetically rather than against real data |
| **Unchanged** | The verification database remains ephemeral |
| **R-L — unchanged** | `origin/faramqueue-feature` is still unmerged and conflicts with `main` |

---

## 9. Files changed

| File | Change |
|---|---|
| `server/migrations/0013_msp_identity_resolution.sql` | **New** — the correction |
| `server/imports/0001_msp_rms_2026_27_kms_2026_27.sql` | Modified — no longer writes `effective_from` / `effective_to` |
| `server/scripts/verify-d9.sql` | **New** — 12 D-9 probes |
| `server/scripts/verify-schema.sql` | A5 updated to 6 exclusion constraints; A5b added |
| `docs/msp-data.md` | Status moved from *design* to *implemented and verified* |
| `docs/d9-correction-report.md` | **New** — this document |

Migrations 0001–0012 are **untouched**. The frontend is untouched. Among tracked
files only `.gitignore` remains modified, from Phase 3.

---

## 10. Reproducing

```bash
export DATABASE_URL="postgres://<user>@<host>:<port>/mandi-sahayak"
A=<uuid-of-an-admin-user>

bash server/scripts/apply-migrations.sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v activating_admin=$A \
     -f server/imports/0001_msp_rms_2026_27_kms_2026_27.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v configured_by=$A \
     -f server/imports/0002_up_demonstration_geography.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-schema.sql   # 23
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-phase4.sql   # 15
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-d9.sql       # 12
```

**STOP.** Awaiting approval before Phase 5.
