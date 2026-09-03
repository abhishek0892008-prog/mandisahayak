# FarmQueue — MSP Data and Resolver Design

**Status:** **D-9 IMPLEMENTED and VERIFIED** — migration `0013_msp_identity_resolution.sql`, PostgreSQL 17.11, 2026-09-02.
**Last updated:** 2026-09-02

> This document was written before implementation, as D-9 required. The design in
> §4 and §5 has now been **implemented and verified**: migration 0013 applies it,
> the import was corrected, and 12 D-9 probes pass from clean databases. §6 records
> the outcome. See `docs/d9-correction-report.md` for the full result.

---

## 1. What is currently in the system

Imported and verified against PostgreSQL 17.11 (Phase 3):

| | |
|---|---|
| Sources | 2 — PIB PRID 2173567 (Rabi, RMS 2026-27), PIB PRID 2260618 (Kharif, KMS 2026-27) |
| Crops | 20 |
| Rate rows | 23 (6 RMS + 17 KMS) |
| Scope | `NATIONAL` on every row |
| Classification | `OFFICIAL`, each with `source_id`, `source_reference`, `retrieved_at` |
| `verified_at` | **NULL on all 23 rows** — retrieved from an official source, not independently cross-checked |

Three crops are published per variety and are stored as separate rows:
Paddy (Common / Grade A), Jowar (Hybrid / Maldandi), Cotton (Medium / Long Staple).

---

## 2. The problem D-9 addresses

Neither Cabinet release states an effective period. The pre-D-9 schema declared
`msp_rates.effective_from NOT NULL`, so the import had to put *something* there,
and it used the Cabinet approval date printed on the release.

That is wrong in a specific and consequential way. The approval date is **when
the rate was decided**, not **when it applies**. Storing it in `effective_from`
silently converts a provenance fact into a policy claim the source never made.
The visible symptom: a date-based lookup for KMS 2026-27 on any date before
13 May 2026 returns nothing, implying "no MSP existed", which is false — the MSP
for that marketing season exists; only its start date is unpublished.

**D-9, locked:** the authoritative identity of an MSP rate is

```
crop + season + marketing_year + grade
```

The publication date is provenance metadata. It is **not** `effective_from`.

---

## 3. Why identity alone is sufficient

A booking already carries the season and marketing year it belongs to —
`bookings.season_id` and `bookings.marketing_year` are `NOT NULL` columns
populated when the booking is created. Payment is computed from a procurement,
which belongs to a booking.

So the resolver never needed a date: the marketing season is an attribute of the
transaction, not something to be inferred from the calendar. Removing the date
from the lookup removes a whole class of boundary bugs (what is the MSP on the
first day of the season? on the last? in the gap between seasons?) rather than
solving them.

---

## 4. Schema change — IMPLEMENTED in migration 0013

### 4.1 Effective period becomes optional metadata

```sql
ALTER TABLE msp_rates ALTER COLUMN effective_from DROP NOT NULL;
```

- `effective_from` / `effective_to` are populated **only when the source
  explicitly publishes them**. NULL means "the source stated no effective
  period", which is the honest reading for both current sources.
- The Cabinet approval date is already preserved as provenance in
  `data_sources.reference_date` (2025-10-01 and 2026-05-13) and in
  `source_reference`, which names the release and its posting timestamp. Nothing
  is lost by clearing `effective_from`.

### 4.2 Identity uniqueness replaces the date-range exclusion

Drop the date-range exclusion constraint, which cannot express identity when the
dates are NULL:

```sql
ALTER TABLE msp_rates DROP CONSTRAINT msp_rates_no_active_overlap;
```

Replace it with a partial unique index that states the D-9 identity directly:

```sql
CREATE UNIQUE INDEX msp_rates_one_active_per_identity
    ON msp_rates (crop_id, season_id, marketing_year, COALESCE(variety_or_grade, ''))
    WHERE status = 'ACTIVE';
```

`COALESCE(variety_or_grade, '')` is retained for the reason Phase 3 probe C1
demonstrated: two NULL grades would otherwise never collide, leaving exactly the
duplicate this index exists to prevent.

**Net effect on the schema:** one `EXCLUDE USING gist` constraint is removed and
one partial unique index is added. Exclusion constraints on `msp_rates` drop from
1 to 0; the project total drops from 7 to 6. Every other constraint is untouched.

### 4.3 What is deliberately *not* changed

- `data_scope` stays. National MSP remains `NATIONAL` (D-10 / D-11).
- `msp_rates_official_requires_source`, `..._requires_provenance` and
  `..._requires_import_batch` all stay. `OFFICIAL` still cannot exist without a
  source, a document reference, a retrieval date and an accountable activating
  administrator.
- `verified_at` stays NULL until an independent cross-check is recorded (D-11).

---

## 5. Resolver contract — APPROVED, documented before implementation

**This is an API contract change, stated explicitly rather than made silently.**
The schema now enforces it; the resolver function itself is written in the phase
that introduces the payment engine.

### 5.1 Before (Phase 1 architecture §9.3)

```
resolveMsp({ cropId, seasonId, marketingYear, grade?, onDate })
    -> exactly one ACTIVE row whose effective range contains onDate
```

### 5.2 After (D-9)

```
resolveMsp({ cropId, seasonId, marketingYear, grade? })
    -> exactly one ACTIVE row for that identity
```

- `onDate` is **removed**. It has no callers yet — no engine, service or endpoint
  has been implemented — so this change breaks nothing currently running.
- Grade matching is unchanged: exact grade first, falling back to the null-grade
  row only when the source published a single rate for the crop.
- **Zero matches → `MSP_NOT_AVAILABLE`.** Never a default, never a neighbouring
  year, never last season's rate.
- **More than one match → `MSP_AMBIGUOUS`.** This is NOT a theoretical branch.
  Paddy KMS 2026-27 is published as two graded rates (Common, Grade A) with **no
  ungraded fallback row**, so a grade-less lookup for Paddy genuinely cannot
  resolve. Probe D9-7 asserts exactly this shape in the real data. The resolver
  must raise `MSP_AMBIGUOUS`; it must never pick one arbitrarily.
- Where a source *does* publish an effective period, it is returned as metadata
  alongside the rate so a caller can display it. It does not participate in
  resolution.

### 5.3 Consequence for payment

`engines/payment-calculator` takes the season and marketing year from the
booking, not from the clock. A procurement recorded late, or corrected months
afterwards, still resolves the MSP of the season it actually belongs to.

---

## 6. Compliance status — IMPLEMENTED

| Artefact | State |
|---|---|
| `server/migrations/0013_msp_identity_resolution.sql` | **Applied.** `effective_from` nullable; date-range exclusion replaced by `msp_rates_one_active_per_identity`; dangling `effective_to` refused; approval dates cleared from `effective_from` by a precisely-targeted UPDATE |
| `server/migrations/0007_msp.sql` | **Unchanged.** Forward-only: no earlier migration was rewritten |
| `server/imports/0001_msp_rms_2026_27_kms_2026_27.sql` | **Corrected.** Sets neither `effective_from` nor `effective_to` |
| Cabinet approval dates | **Preserved** in `data_sources.reference_date` (2025-10-01 RMS, 2026-05-13 KMS). No new column was added |
| Rate values | **Unchanged.** Verified by probe D9-12 |
| Provenance | **Unchanged and still mandatory.** Verified by probe D9-9 |
| Verification | 12 D-9 probes plus 38 existing probes: **50/50 pass, twice, from clean databases** |

The upgrade path was also exercised on a database carrying the pre-D-9 data:
approval dates were cleared from `effective_from`, rates were untouched, and
`source_reference`, `retrieved_at`, `source_id` and `import_batch_id` all
survived intact.

---

## 7. Outstanding data work

| Item | Status |
|---|---|
| Independent cross-check of all 23 rates against a second official source (DES MSP statement, `desagri.gov.in`) | **NOT DONE.** Required before any payment is computed — a transcription error would propagate into money |
| State bonuses / procurement incentives above national MSP | **NOT RESEARCHED.** National MSP is not necessarily the final payable rate; Phase 11 must not present it as such without confirming state policy |
| Effective periods from a source that publishes them | None found |
| Historical marketing years | Not imported; only 2026-27 |

---

## 8. Sources

- [Cabinet approves MSP for Rabi Crops for Marketing Season 2026-27 — PIB PRID 2173567](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2173567) (posted 01 Oct 2025)
- [Cabinet approves MSP for Kharif Crops for Marketing Season 2026-27 — PIB PRID 2260618](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2260618) (posted 13 May 2026)
- [Directorate of Economics & Statistics — Latest MSP Statement](https://desagri.gov.in/statistics-type/latest-minimum-support-price-msp-statement/) (candidate for the cross-check)
