# FarmQueue — Phase 6: Farmer Domain & Frontend API Contract

**Status:** **COMPLETE — VERIFIED** against PostgreSQL 17.11
**Date:** 2026-09-02
**Result:** **116 checks pass, twice, from clean databases** (50 SQL probes + 66 Node tests)
**Scope:** farmer domain, ownership security, quantity foundation, reference data, contract documentation. No booking, scheduling, queue, ETA, SMS, procurement or payment.

---

## 1. What Phase 6 delivers

| Deliverable | Where |
|---|---|
| Frontend-vs-backend divergence audit | `docs/phase-6-frontend-contract-audit.md` |
| Farmer API contract | `docs/api/farmer.md` |
| Quantity domain (one definition, DB-cross-checked) | `server/src/domain/quantity.ts` |
| Reference data API (districts, villages, crops, centres, constraints) | `server/src/modules/reference/reference.routes.ts` |
| 25 new tests, incl. 5 ownership-security tests | `server/tests/farmer.test.ts` |

**No migration was required.** Migrations 0001–0013 untouched; no constraint weakened. Phase 5's authentication primitives were reused, not duplicated or modified.

---

## 2. Step 1 — frontend re-inspection

Both frontends were read; **neither was modified**. Ten divergences are catalogued in the audit document. The four that most affect integration:

- **D1 — Aadhaar last-4 and IFSC** are still in `Registration.jsx`. There is no column for either; a test asserts none exists anywhere in the schema.
- **D2 — quantity.** Three inconsistent conventions exist: the farmer prototype's `min="1"` labelled kg; the officer branch's unlabelled `210/180/95`; and the backend's 2 500–5 000 kg. The officer figures fit neither unit under our rule.
- **D3 — crops are display strings, and `"Rice"` is not the official crop.** The Government of India publishes MSP for **Paddy**, per variety (Common / Grade A). "Rice" is the milled product. `"Mustard"` is officially "Rapeseed & Mustard".
- **D4 — `"Other"`** cannot map to a crop, carry an MSP, or have an eligibility rule. It must go.

The officer branch was inspected **for reference only**. Beyond the unit problem it uses its own statuses (`Queued`, `Verified` rather than the canonical nine) and exposes a farmer's full phone in an operator list, where the backend returns a masked projection.

---

## 3. Steps 2 & 5 — profile and ownership

The authoritative model is already `GET /me` and `PATCH /me` from Phase 5; Phase 6 hardened and tested it rather than adding a parallel surface.

**Identity resolution:**

```
authenticated session  ->  server-resolved user id  ->  farmer row
```

**There is deliberately no `/farmers/:id` endpoint.** A farmer id supplied by a client is not merely ignored — there is nowhere for it to be used. That is the structural version of the rule, rather than a check that could be forgotten on a future endpoint.

Five ownership tests, all passing:

| Test | Result |
|---|---|
| Farmer A reads B by id — `GET /farmers/<B>` | `404` (no such route exists) |
| Farmer A reads B by query — `GET /me?userId=<B>` | Returns **A**, not B |
| Farmer A updates B — `PATCH /me` with `{userId, farmerId, id}` = B | Only **A** changes; B's name unchanged |
| Farmer escalates — `PATCH /me` with `roles:["ADMIN"], status:"SUSPENDED"` | Stays `FARMER` / `ACTIVE`; no new permissions |
| Revoked session | Immediate `401` |

Unauthenticated access to every farmer-private and reference route returns `401`.

**PII:** unchanged and minimal — name, phone (masked on read), district, village, locale. No Aadhaar, no bank details (D-6/D-7). The full phone is never returned by any endpoint.

---

## 4. Step 6 — quantity foundation

`server/src/domain/quantity.ts` is the single definition:

```
canonical unit : kilograms, integer
rule           : 2500 <= quantityKg <= 5000     (25–50 quintal at 100 kg/quintal)
```

Two things make this hard to get wrong later:

1. **`GET /reference/booking-constraints`** returns the range, so no component hardcodes it.
2. **`assertDomainMatchesDatabase()` runs at startup.** It reads the actual `pg_get_constraintdef` for `bookings_quantity_within_business_rule` and refuses to boot if the code's bounds are not in it. Application validation and the database CHECK cannot silently drift apart.

Tested: 2 499 rejected, 2 500 accepted, 5 000 accepted, 5 001 rejected — **and separately at the database level**, by attempting real `bookings` inserts and asserting PostgreSQL raises `bookings_quantity_within_business_rule`. The frontend's unit representation cannot change the invariant.

**Slot duration is NOT implemented.** It derives from quantity, but belongs to the Phase 7 scheduling engine.

---

## 5. Step 7 — crop / season / marketing year

`GET /reference/crops` resolves the chain from the **existing OFFICIAL MSP import** — no crop list is duplicated or hardcoded in a controller:

```
crop -> season (RMS/KMS) -> marketing year -> eligible centre count
```

Wheat resolves to RMS 2026-27 with no grades; Paddy to **KMS** 2026-27 with `["Common", "Grade A"]`. Tests assert the seasons are not mixed and that `RICE` and `OTHER` do not exist.

`GET /reference/centres?cropId=` filters by `centre_crop_configurations`, so the booking engine can already answer "which centres accept this crop". Verified: all 5 demo centres accept Wheat; **0** accept Barley, because no centre is configured for it.

**No MSP payment calculation was implemented.**

---

## 6. Honest reporting in the API surface

Two endpoints return a reason code where a lesser design would return a plausible number:

- **Villages:** `available: false`, `reasonCode: "NO_VILLAGE_DATA_FOR_DISTRICT"`. LGD village data was not retrievable, and the prototype's 17 hardcoded names are unverified and absent from the database. An empty list is the correct answer.
- **Centre storage:** `status: "NOT_AVAILABLE"`, `reasonCode: "NO_CAPACITY_DATA_FOR_CENTRE"` (D-10).

Every reference row also carries its `dataType`, so provenance survives all the way to the client: districts and centres are `CONFIGURED`, crops are `OFFICIAL`, and the UP state LGD code `"9"` is the one genuinely official geographic value.

---

## 7. Tests

**25 new tests** (66 Node tests in total with Phase 5).

| Suite | Tests | Covers |
|---|---:|---|
| quantity foundation | 6 | boundaries; non-integer/non-numeric; quintal conversion; **database-level enforcement**; startup drift assertion; constraints endpoint |
| farmer profile | 4 | canonical shape + masked phone; update + audited before/after; server-side validation; no Aadhaar/IFSC in any response |
| ownership security | 5 | the five cases in §3 |
| reference data | 7 | districts with provenance; honest empty villages; districtId validation; crop→season→year; centre filtering by crop; storage reason code; CONFIGURED labelling |
| reference authorization | 1 | officers may read reference data but still not admin data |
| registration regression | 2 | end-to-end registration using **only ids from the API**; a stale client sending Aadhaar/IFSC is safely ignored |

The registration regression test matters: it proves the contract is self-consistent — a client with no hardcoded data can complete registration using only what the API gave it.

---

## 8. Verification

| | Run 1 | Run 2 |
|---|---|---|
| Migrations 0001–0013, clean DB | 13/13 | 13/13 |
| Imports (MSP, geography) | PASS | PASS |
| `verify-schema.sql` | 23/23 | 23/23 |
| `verify-phase4.sql` | 15/15 | 15/15 |
| `verify-d9.sql` | 12/12 | 12/12 |
| Phase 5 auth tests | 41/41 | 41/41 |
| Phase 6 farmer tests | 25/25 | 25/25 |
| **Total** | **116/116** | **116/116** |

`tsc --noEmit` clean. PostgreSQL `17.11` (`server_version_num` 170011).

---

## 9. Known limitations

1. **Villages are empty** and will stay so until LGD village data is obtained or you authorise a `CONFIGURED` village list. `villageId` is optional throughout.
2. **District LGD codes are `null`** — same cause. `states.lgd_code = '9'` is genuinely official.
3. **No booking-related endpoints exist**, so `MyBooking`, `QueueStatus`, `Procurement` and `Payment` still have nothing to integrate against.
4. **Officer and admin domains remain minimal** — only what Phase 5 needed for RBAC proof.
5. **Registration still returns `409` on a duplicate phone** (a disclosed enumeration trade-off; login is fully resistant). Unchanged from Phase 5, still open to reversal on request.
6. **No pagination** on reference endpoints — with 5 districts, 20 crops and 5 centres it is unnecessary, but `GET /admin/farmers` is capped at 100 and will need cursors.
7. **Frontend untouched**, so nothing is integrated yet; the divergences in the audit are all still live in the UI.

---

## 10. Risks

| # | Risk |
|---|---|
| **R-Q (new)** | The frontend's `"Rice"` maps to official `PADDY`, and `"Mustard"` to `"Rapeseed & Mustard"`. If someone maps these by display string rather than id during integration, bookings will attach to the wrong crop and therefore the wrong MSP. **Integrate by `cropId` only.** |
| **R-R (new)** | Three unit conventions are live across the two prototypes. Until the frontends are updated, a number moving between them is ambiguous. The backend is unambiguous; the UIs are not. |
| **R-J** (unchanged, high) | MSP values still single-sourced with `verified_at` NULL — cross-check required before Phase 11 computes money |
| **R-N** (unchanged) | Demonstration centres must never be presented as real government facilities |
| **R-L** (unchanged) | `origin/faramqueue-feature` still unmerged and structurally conflicting with `main` |
| **R-P** (unchanged) | Session lookup does a 4-subquery join per authenticated request; correct and always fresh, but unmeasured under load |

---

## 11. Phase Completion Report

**PHASE:** 6 — Farmer account domain + frontend API contract
**STATUS:** COMPLETE — VERIFIED

**WHAT I INSPECTED:** all eleven farmer pages on `main`, both locale bundles, and the `origin/faramqueue-feature` officer branch (read-only, for reference).

**WHAT I IMPLEMENTED:** the quantity domain with a startup drift assertion; five reference-data endpoints; hardening and full test coverage of the farmer profile; the ownership-security guarantees; three documents.

**FILES CREATED:** `server/src/domain/quantity.ts`, `server/src/modules/reference/reference.routes.ts`, `server/tests/farmer.test.ts`, `docs/phase-6-frontend-contract-audit.md`, `docs/api/farmer.md`, `docs/phase-6-farmer-domain.md`.

**FILES MODIFIED:** `server/src/app.ts` (mount the reference router), `server/src/index.ts` (startup domain assertion). Nothing else. **The frontend, its CSS, routing and i18n are untouched.**

**DATABASE CHANGES:** **NONE.** No migration needed; 0001–0013 untouched; no constraint weakened.

**API CHANGES:** 5 new endpoints (20 routes total, each declaring a permission).

**BUSINESS RULES:** quantity 2 500–5 000 kg canonical in kg, cross-checked against the database at startup; 1 quintal = 100 kg for presentation only; crop→season→marketing year resolved from the OFFICIAL MSP import; centre eligibility from `centre_crop_configurations`.

**SECURITY CHANGES:** ownership proven by test — no by-id farmer endpoint, session-resolved identity only, client-supplied ids inert, role/status escalation impossible via profile update. Phase 5 primitives unchanged and unweakened.

**TESTS CREATED:** 25.

**TEST RESULTS:** **116/116 twice.** `tsc --noEmit` clean.

**REAL GOVERNMENT SOURCES USED:** none new. **DATA IMPORTED:** none.

**DATA CLASSIFICATION:** unchanged — 23 OFFICIAL MSP rates, 20 OFFICIAL crops, 1 OFFICIAL state; CONFIGURED demonstration districts and centres; 0 TEST rows persisted. Provenance is now surfaced to the client on every reference row.

**KNOWN LIMITATIONS:** §9. **RISKS:** §10.

**NEXT PHASE:** Phase 7 — the scheduling engine (processing time from quantity, working hours, holidays, lane-aware time windows, next available date). All of its inputs now exist and are verified.

**STOP.** Awaiting approval.
