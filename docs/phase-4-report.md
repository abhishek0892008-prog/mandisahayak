# Mandi Sahayak — Phase 4 Report

**Phase:** 4 — Procurement centres, mandi relationships, storage, operational configuration
**Date:** 2026-09-02
**Status:** **COMPLETE — verified against PostgreSQL 17.11**

> Supersedes the earlier `GEOGRAPHIC_SCOPE_UNDEFINED` version of this document,
> which was correct at the time: PS 26032 specifies no geography, and you have
> since supplied one explicitly as demonstration configuration.

---

## 1. What PS 26032 actually says about geography — nothing

Problem Statement **26032** describes farmers facing long waits, poor visibility
of procurement schedules, and uncertainty about procurement status, and asks for
a platform providing registration, slot booking, real-time queue management,
SMS/app notifications, and procurement and payment status tracking.

**It names no state, district, mandi or procurement centre.**

The Uttar Pradesh geography used below is therefore **your explicit demonstration
choice**, recorded as `CONFIGURED`. It is not official SIH scope, not official
government scope, and not official procurement geography. Nothing in the database
claims otherwise, and probe **P4-4** enforces that: zero demonstration rows carry
`OFFICIAL` status.

---

## 2. Source research — what was actually obtainable

| Target | Outcome |
|---|---|
| **Uttar Pradesh LGD state code** | **OBTAINED — code `9`**, read from the state selector on the official Local Government Directory portal. Recorded `OFFICIAL` with a `data_sources` row. |
| **District LGD codes** (Aligarh, Agra, Hathras, Mathura, Bulandshahr) | **UNAVAILABLE.** LGD's bulk download is **CAPTCHA-protected** (the form carries a `captchaAnswer` field); the `data.gov.in` LGD dataset requires a **registered API key**; the eGramSwaraj state report was **unreachable** (connection failure). **Neither access control was circumvented.** |
| **UP mandi list and codes** | **UNAVAILABLE in machine-readable form.** Agmarknet's eNAM market page returned a 1 KB stub; eNAM's APMC page contained no UP market names. No authoritative list of mandi codes was retrieved. |
| **Centre-level storage capacity** | **UNAVAILABLE**, as established in Phase 3. Official FCI figures are national and state-scope only. |
| **Centre-level operational data** (hours, lanes, processing rates) | **NOT PUBLISHED by any government source.** Expected — this is operational configuration, not policy. |

Three separate government access controls blocked automated retrieval. I did not
attempt to defeat any of them, and I did not substitute a value for anything they
protect.

---

## 3. What was created, and how it is classified

| Entity | Rows | Classification |
|---|---:|---|
| `states` — Uttar Pradesh, LGD code 9 | 1 | **OFFICIAL** (sourced) |
| `crops` (from Phase 3 MSP import) | 20 | **OFFICIAL** |
| `msp_rates` (from Phase 3 MSP import) | 23 | **OFFICIAL** |
| `districts` — the five demonstration districts | 5 | **CONFIGURED** |
| `procurement_centres` — one per district | 5 | **CONFIGURED** |
| `centre_service_lanes` | 9 | configuration |
| `centre_operating_hours` | 30 | **CONFIGURED** |
| `centre_slot_configurations` | 5 | **CONFIGURED** |
| `centre_crop_configurations` | 7 | **CONFIGURED** |
| `mandis` | **0** | — none created |
| `storage_facilities` / `storage_capacity` / `storage_inventory` | **0 / 0 / 0** | — none created |
| Anything `TEST` | **0** | — |

Verified by query: the classification split is exactly OFFICIAL for
state/crops/MSP, CONFIGURED for every demonstration row, and nothing mixed.

### 3.1 What was deliberately NOT created, and why

- **No mandis.** `mandis.code` is `NOT NULL`, and no authoritative list of UP
  mandi codes was retrievable. Creating rows would have meant inventing
  government identifiers. `procurement_centres.mandi_id` is nullable by design,
  so centres simply have no mandi linked — the relationship is modelled and
  available the moment real data arrives.
- **No storage rows.** Per **D-10**, national and state figures are never
  converted to centre level. Every centre therefore reports
  `NO_CAPACITY_DATA_FOR_CENTRE` under `ADVISORY` mode (probe **P4-7**).
- **No coordinates.** Plausible-looking latitude and longitude are still
  invented data. Both columns are NULL on all five centres (probe **P4-6**).
- **No government-style centre IDs.** Centre codes use the form
  `DEMO-UP-<DISTRICT>-01`. The prefix is deliberate so that no reader and no
  future importer mistakes them for official identifiers (probe **P4-6**).

---

## 4. The one schema change, and why it is not a weakening

Creating honest CONFIGURED districts was blocked by `districts.lgd_code NOT NULL`
— a Phase 2 assumption that every district would arrive from an LGD import. With
LGD codes unobtainable, the only ways to satisfy that column were to **invent a
government identifier** or to **relax integrity**. You forbade both.

**Migration `0012_configured_geography_codes.sql`** resolves this by fixing the
model rather than bending it:

```sql
ALTER TABLE districts ALTER COLUMN lgd_code DROP NOT NULL;

ALTER TABLE districts
    ADD CONSTRAINT districts_official_requires_lgd_code
    CHECK (data_type <> 'OFFICIAL' OR lgd_code IS NOT NULL);
```

**For OFFICIAL rows the requirement is identical to before** — an OFFICIAL
district still cannot exist without an LGD code, and probe **P4-1** proves it by
attempting exactly that insert and confirming refusal. What changes is that a
CONFIGURED district, which was never an LGD entity and has no code *to* record,
can now say so truthfully. This is the same conditional-provenance pattern
(`data_type <> 'OFFICIAL' OR source_id IS NOT NULL`) already used on every
provenanced table.

A new partial unique index also prevents duplicate configured districts by name
within a state — so the change is net *stricter*, not looser.

`states.lgd_code` remains `NOT NULL`, untouched, because the UP code was obtained.

**I am flagging this for your review** because you said not to weaken constraints
to fit seed data. I believe this is the opposite — a correction that makes the
OFFICIAL path explicit and adds two new checks — but it is a schema change made
during a data phase, and you should see it rather than find it.

---

## 5. Operational configuration is configuration, not code

Every parameter the scheduling engine will read lives in the database and varies
per centre. Probe **P4-8** proves heterogeneity is real, not theoretical:

| Centre | Lanes | Hours (Mon–Sat) | Reference processing |
|---|---:|---|---|
| Aligarh | 3 | 08:00–18:00 | 75 min / 2500 kg |
| Agra | 2 | 08:00–18:00 | 60 min / 2500 kg |
| Hathras | 1 | **09:00–17:00** | 60 min / 2500 kg |
| Mathura | 2 | 08:00–18:00 | 60 min / 2500 kg |
| Bulandshahr | 1 | 08:00–18:00 | 60 min / 2500 kg |

Common configured parameters: minimum 30 min, maximum 180 min, transition buffer
15 min, slot granularity 15 min, booking horizon 7 days, cancellation cutoff
24 h, `max_daily_processing_kg` **NULL** (meaning *no configured ceiling*, not
zero).

Sunday closure is expressed by the **absence** of a `day_of_week = 0` row, which
is how the engine will read it — 30 rows for 5 centres × 6 days (probe **P4-14**).

Every configured row names the administrator who set it (probe **P4-11**), and
temporal overlap is refused by the exclusion constraint (probe **P4-10**).

---

## 6. PS 26032 requirement mapping

| PS 26032 requirement | Backend domain | Status after Phase 4 |
|---|---|---|
| **Farmer registration** | `identity` + `auth` — `users`, `farmers`, `otp_challenges`, `pending_registrations`, `consents`, `sessions` | Schema verified. Minimal-data model (no Aadhaar, no bank details — D-6/D-7). Endpoints are Phase 5. |
| **Slot booking** | `bookings` + `scheduling` — `bookings`, `centre_slot_configurations`, `centre_service_lanes`, `centre_daily_capacity`, `idempotency_keys` | Schema verified; centres and parameters now configured. Engine is Phase 7/8. |
| **Real-time queue management** | `queue` — derived projection over `bookings` + `booking_status_history` | Schema verified; multi-lane centres configured so the projection has something real to order. Engine is Phase 9. |
| **SMS / app notifications** | `notifications` outbox + `notification_templates`, per-locale (en/hi) | Schema verified, dedupe key unique. Templates and sending are Phase 12. |
| **Procurement status tracking** | `procurements` + the 9-state machine in `booking_status_transitions`, enforced by trigger | Verified: illegal transitions refused by the database. Officer operations are Phase 10. |
| **Payment status** | `payments` + `msp_rates` | Schema verified; 23 OFFICIAL national MSP rates loaded. Calculation is Phase 11. |
| **Reduced waiting time** | quantity-proportional processing duration → per-lane time-window capacity → ETA | The mechanism now has real inputs: per-centre reference rates, lane counts and working hours differ, so schedules genuinely differ by centre. |

The requirement that most shapes the architecture is the last one. Reducing
waiting time is why capacity is modelled as **time on a lane** rather than as a
fixed hourly bucket, and why booking duration is derived from quantity.

---

## 7. Verification — everything re-run from a clean database

| Step | Result |
|---|---|
| `dropdb` + `createdb` — genuinely clean | done |
| Migrations 0001–**0012** with `ON_ERROR_STOP=1` | **12/12 PASS** |
| Import 0001 — OFFICIAL MSP (requires an ADMIN) | **PASS**, 23 rates |
| Import 0002 — CONFIGURED geography (requires an ADMIN) | **PASS** |
| `verify-schema.sql` | **22/22 PASS** |
| `verify-phase4.sql` | **15/15 PASS** |
| Full sequence repeated from zero a second time | **PASS** — identical results |
| `static-check.mjs` | **PASSED**, 0 failures, 0 warnings |

**37 probes, 0 failures.** PostgreSQL 17.11.

### 7.1 One existing probe was re-scoped — disclosed deliberately

Schema probe **A8** originally asserted that the government-data tables were
**empty**. That was the correct check while only migrations had run, but once
authorised imports populate those tables it can no longer distinguish *"a
migration smuggled in fake data"* from *"an import legitimately ran"* — so it
began failing on correct data.

A8 now asserts the invariant that holds at every point in the system's life:
**everything in a government-data table is correctly classified, and nothing
claims OFFICIAL without provenance** (including the new
OFFICIAL-requires-`lgd_code` rule, and no stray TEST data).

The original guarantee is **not lost**. "Migrations insert no government data" is
still enforced where it belongs — the `DO` block at the end of
`0011_seed_system_vocabulary.sql`, which aborts the entire migration run if any
of those tables is populated at migration time. That block is untouched and still
fires on every run.

---

## 8. Phase Completion Report

**PHASE:** 4 — Centres, mandis, storage, operational configuration

**STATUS:** **COMPLETE — VERIFIED** against PostgreSQL 17.11

**GEOGRAPHIC SCOPE:** Uttar Pradesh (LGD state code 9) with five demonstration
districts: Aligarh, Agra, Hathras, Mathura, Bulandshahr. **CONFIGURED
demonstration geography.**

**SOURCE FOR GEOGRAPHIC SCOPE:** **Your explicit instruction of 2026-09-02.**
PS 26032 specifies no geography and is not cited as authority for it. The state
identity alone is OFFICIAL (LGD); the district selection is a demonstration
choice.

**CENTRES ADDED:** 5 — one per district, all `CONFIGURED`, all `DEMO-`prefixed,
no coordinates, no government identifiers.

**MANDIS ADDED:** **0.** No authoritative mandi code list was retrievable, and
inventing codes is forbidden.

**STORAGE FACILITIES ADDED:** **0.** Also 0 capacity rows and 0 inventory rows.

**OFFICIAL DATA:** 1 state (LGD code 9), 20 crops, 23 MSP rates, 3 data sources.
Every OFFICIAL row carries source, URL, document reference, retrieval date and
data scope. `verified_at` remains NULL on all MSP rows (D-11).

**CONFIGURED DATA:** 5 districts, 5 centres, 30 operating-hour rows, 5 slot
configurations, 7 crop eligibility rows, 9 service lanes. Each attributable to a
named administrator.

**TEST DATA:** **0 persisted.** Fixtures exist only inside the two verification
scripts, both of which end in `ROLLBACK`.

**SOURCES:** Local Government Directory (state code); PIB MSP releases from
Phase 3. Agmarknet, eNAM, data.gov.in and eGramSwaraj were attempted and yielded
nothing usable.

**SOURCE URLS:** listed in §10.

**DATABASE CHANGES:** One migration — `0012_configured_geography_codes.sql`.
`districts.lgd_code` becomes nullable, with a new conditional CHECK preserving the
OFFICIAL requirement, plus a new partial unique index. Total: 48 tables,
102 foreign keys, 7 exclusion constraints, 129 standalone indexes (8 partial).

**CONSTRAINTS:** One added (`districts_official_requires_lgd_code`), one
`NOT NULL` replaced by that conditional CHECK, one partial unique index added.
**No constraint was weakened for OFFICIAL data**, proven by probe P4-1.

**INDEXES:** One added — `districts_configured_name_unique_per_state`.

**TESTS:** New `server/scripts/verify-phase4.sql` with 15 probes covering the
0012 change, classification separation, absence of fabricated data, centre
heterogeneity, referential integrity, temporal-config overlap, attributability
and MSP intactness. Existing 22 schema probes retained.

**TEST RESULTS:** **37/37 PASS** (22 schema + 15 Phase 4), twice, from clean
databases. Static checker: 0 failures, 0 warnings.

**UNAVAILABLE DATA:** District LGD codes (CAPTCHA/API-key protected) · UP mandi
list and codes · centre-level storage capacity · live storage occupancy · centre
coordinates · centre-level operational data from any government source. **No
substitute value was invented for any of these.**

**KNOWN LIMITATIONS:**
1. The five centres are demonstration constructs. They correspond to no verified
   government facility and must never be presented as such.
2. No mandi relationships exist, so that part of the domain is modelled but
   unexercised.
3. `districts.lgd_code` is NULL for all five districts — real districts remain
   importable later without schema change.
4. MSP values remain single-sourced with `verified_at` NULL (R-J).
5. The verification database is still ephemeral.
6. D-9 remains **unimplemented**; the repository is still non-compliant on the
   MSP effective-period question (`docs/msp-data.md` §6).

**RISKS:**
- **R-N (new):** demonstration centres could be mistaken for real ones in a demo
  or screenshot. Mitigated by `DEMO-` codes, `CONFIGURED` classification and
  names containing "Demonstration", but presenters must not describe them as
  government centres.
- **R-M (unchanged):** D-9 non-compliance is still mitigated only by a comment.
- **R-J (unchanged, high):** MSP cross-check outstanding before Phase 11.
- **R-L (unchanged):** `origin/faramqueue-feature` is still unmerged and
  conflicts with `main`.

**NEXT PHASE:** Phase 5 — authentication and RBAC (registration, OTP, sessions,
staff login, rate limiting, audit). The schema for all of it is verified and the
permission matrix is seeded. I recommend implementing D-9 first, as a small
migration plus import revision, since it is a known-incorrect representation
sitting in the data layer.

**STOP.** Awaiting approval.

---

## 9. How to reproduce

```bash
export DATABASE_URL="postgres://<user>@<host>:<port>/mandi-sahayak"
A=<uuid-of-an-admin-user>

bash server/scripts/apply-migrations.sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v activating_admin=$A \
     -f server/imports/0001_msp_rms_2026_27_kms_2026_27.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v configured_by=$A \
     -f server/imports/0002_up_demonstration_geography.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-phase4.sql
```

Both imports refuse to run without a named `ADMIN` user.

## 10. Sources

- [Local Government Directory — Download Directory](https://lgdirectory.gov.in/downloadDirectory.do) — Uttar Pradesh state code `9`; district codes CAPTCHA-gated
- [Local Government Directory (LGD) — Districts, data.gov.in](https://www.data.gov.in/resource/local-government-directory-lgd-districts) — requires a registered API key
- [Cabinet approves MSP for Rabi Crops, RMS 2026-27 — PIB PRID 2173567](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2173567)
- [Cabinet approves MSP for Kharif Crops, KMS 2026-27 — PIB PRID 2260618](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2260618)
- [FCI storage capacity — PIB PRID 1945170](https://www.pib.gov.in/PressReleasePage.aspx?PRID=1945170) — national/state scope only
- [eNAM](https://enam.gov.in/web/) · [Agmarknet](https://agmarknet.gov.in) — no usable UP mandi master retrieved
