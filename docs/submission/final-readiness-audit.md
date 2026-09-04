# Mandi Sahayak — Final Submission Readiness Audit

**Date:** 2026-09-03
**Problem statement:** PS 26032
**Audit type:** full repository audit + live end-to-end rehearsal
**Outcome:** **READY, with one P0 fixed and two P0-class scope gaps that must be managed in the demo, not hidden.**

---

## 1. Baseline before the audit

```
npm test .............. 265 / 265 pass, 65 suites, 0 fail, 0 skipped
tsc --noEmit .......... clean
static-check.mjs ...... PASSED — 0 failures, 0 warnings
SQL probes ............ 50 / 50   (schema 23, phase4 15, d9 12)
Migrations ............ 0001..0014
Routes ................ 44, deny-by-default assertion passing
```

## 2. Baseline after the audit

```
npm test .............. 269 / 269 pass, 66 suites, 0 fail, 0 skipped   (+4)
tsc --noEmit .......... clean
static-check.mjs ...... PASSED — 0 failures, 0 warnings
SQL probes ............ 50 / 50
Frontend build ........ PASSES (vite build, 405 kB)
Backend boot .......... PASSES (44 routes verified, /healthz + /readyz OK)
```

Verified twice from a database provisioned from zero. Identical both times.

---

## 3. Findings

### P0-1 — Registration was unreachable for any real client **[FIXED]**

**The defect.** `POST /api/v1/auth/farmer/register/start-otp` is public and requires `districtId` as a **UUID**. The only endpoint listing districts, `GET /api/v1/reference/districts`, required `reference.read` — i.e. a session. **A farmer needed an account before they could create one.** The frontend registration form carries a hardcoded list of district *names*, not ids, so even a wired client could not have supplied one.

**Why every test missed it.** `tests/helpers.ts::getSeedDistrictId()` reads the district id **directly from the database**, bypassing the API. Every one of the 265 tests registered farmers through that back door, so no test ever exercised the path a real client must take. This is the most valuable finding in the audit: a blind spot created by test convenience.

**Found by:** attempting the demo flow over HTTP as an unauthenticated client, which is exactly what the demo will be.

**Fix (minimal).** `GET /api/v1/reference/districts` is now declared `{ kind: 'public', reason: … }` and rate limited per IP (`PUBLIC_REFERENCE_PER_IP`, 120 / 15 min).

**Why this is not a weakened security control.** Districts are public government geography (LGD) containing no personal data, and the registration endpoint that consumes them is *already* public. **Exactly one** reference endpoint was opened — villages, crops, centres and booking-constraints all still require a session, asserted by a new test. The endpoint is bounded by a rate limit because it is unauthenticated, matching the project's convention for every other public surface.

**Files:** `server/src/modules/reference/reference.routes.ts`, `server/src/core/rateLimit.ts`, `server/tests/farmer.test.ts`.

**Regression cover — 4 new tests:**
1. districts reachable with no session
2. a **complete registration performed using only public endpoints**, never touching the database
3. every other reference endpoint still returns `401`
4. the public endpoint is rate limited

An existing test listed `/reference/districts` among "farmer-private data". That categorisation was wrong — districts are not farmer-private — so it was corrected and simultaneously **strengthened**, adding `/bookings/me` and `/notifications` to the private list.

### P0-2 — The frontend is not connected to the backend **[NOT FIXABLE NOW — manage in the demo]**

`grep -rnE "fetch\(|axios|/api/v1" src/` returns **nothing**. All 12 farmer screens read and write `localStorage`. The React prototype and the API are two disconnected systems.

This is **intentionally deferred** — `architecture.md:124` says *"EXISTING FRONTEND — untouched until Phase 15"* — so by the taxonomy it is P3 *scope*, but it is P0 for *demo planning*, because the single-UI walkthrough in the task brief cannot be performed.

**Not fixed.** Wiring 12 screens to the API is Phase 15, is far larger than one night, and would put untested code in front of judges. **Managed instead** by a two-track demo script (§`demo-script.md`) that is explicit about which track is live.

### P0-3 — There is no officer UI at all **[NOT FIXABLE NOW — manage in the demo]**

`src/pages/` contains only `farmer/`. Officer operations exist solely as API routes. Known and recorded since Phase 0 as **R-2**. The officer half of the demo is therefore an API demonstration.

### P1-1 — Officer accounts cannot be created through any API **[DOCUMENTED, NOT FIXED]**

There is no officer provisioning endpoint (`officer.create`, `officer.assign_centre`, `officer.deactivate` are all unclaimed — original Phase 14). A demo officer must be created with a documented one-liner reusing existing tooling. **This is a new product decision, so it was not implemented.** The exact command is in the demo script and was rehearsed successfully.

### P1-2 — Frontend crop vocabulary does not match the backend **[DOCUMENTED, NOT FIXED]**

`src/data/crops.js` uses `rice` and `mustard`; the backend canonical codes are `PADDY` and `RAPESEED_MUSTARD`. Latent only — the frontend never calls the API. Fixing it is Phase 15 integration work, not a submission fix. Recorded so it is not discovered mid-integration.

### P1-3 — `QUEUE_APPROACHING` and `displayStatus: "APPROACHING"` never fire **[BY DESIGN]**

No threshold exists in the schema and none is approved (R-9d). Carried forward unchanged; the system says nothing rather than inventing a number.

### P2-1 — Root `README.md` is the stock Vite template **[FIXED]**

Embarrassing for a submission. Replaced with a real project README.

### P2-2 — Frontend lint reports 16 problems (14 errors) **[NOT FIXED]**

All `react-hooks/set-state-in-effect` in prototype screens. **`npm run build` passes**, so this is not a demo blocker. Touching 12 screens the night before submission is a worse risk than the lint output.

### P3 — Intentionally out of scope

Real SMS delivery, payment disbursal, offline sync, admin UI, reports/analytics, notification dispatch worker, `notification_templates` rows, quiet hours / daily caps / retention.

---

## 4. Things checked and found sound

| Area | Result |
|---|---|
| Frontend production build | Passes |
| Backend boot | Clean; 44 routes verified; `/healthz`, `/readyz` OK |
| Fabricated government data | **None found.** No MSP values in the frontend; centres are generically named "Procurement Centre 1–3" placeholders, not fake government centres |
| False SMS claims in UI | **None found** — no "SMS sent" string anywhere in `src/` |
| False disbursal claims | **None found** — the UI shows a payment *status*; there is no "credited"/"transferred"/"disbursed" wording |
| Fabricated queue/ETA in UI | **None** — `QueueStatus.jsx` renders `—` when position is absent rather than inventing one |
| Secrets committed | None. `.gitignore` excludes `.env`; only `.env.example` is tracked |
| `/booking-confirmation` route | Present (the Phase 0 defect was fixed by the frontend teammate) |
| Ownership isolation, RBAC, CSRF, rate limiting, audit, concurrency | All green; see §Security below |

---

## 5. Live end-to-end rehearsal

The full PS 26032 story was executed against a running server before writing any documentation:

```
FARMER   register (OTP) → book → queue position 1, ETA, PROJECTED → BOOKING_CONFIRMED notification
OFFICER  login (password + OTP 2FA) → today's bookings → search by code
         → arrive → weighing → weight 2480.5 kg → quality ACCEPTED → complete
         → MSP resolved 258500 paise/quintal → payment PENDING
         → payment INITIATED → PAID (UTR-DEMO-0001) → booking COMPLETED
FARMER   procurement ACCEPTED 2480.5 kg → payment PAID ₹64,120.93
         → 5 notifications, every one realSmsDelivered: false
```

Every step returned correct, coherent data. The amount ₹64,120.93 is 24.805 quintal × ₹2 585.00, computed in PostgreSQL `numeric`.

---

## 6. Files created

- `docs/submission/final-readiness-audit.md` (this)
- `docs/submission/PS-26032-mapping.md`
- `docs/submission/demo-script.md`
- `docs/submission/architecture.md`
- `docs/submission/limitations.md`

## 7. Files modified

| File | Change | Risk |
|---|---|---|
| `server/src/modules/reference/reference.routes.ts` | Districts route → public + per-IP rate limit | **Low** — one endpoint, public data, 4 tests |
| `server/src/core/rateLimit.ts` | +`PUBLIC_REFERENCE_PER_IP` | None (additive) |
| `server/tests/farmer.test.ts` | +4 tests; private-data test corrected and strengthened | None |
| `README.md` (root) | Stock Vite template → real project README | None |

**No migration. No schema change. No business rule changed. No MSP policy touched. No geography invented. No frontend source modified.**

---

## 8. Final verification

Run twice, each from a database dropped and rebuilt from zero:

```
ready: 14 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings
tsc --noEmit .......... CLEAN
static-check.mjs ...... PASSED — 0 failures, 0 warnings
npm test .............. tests 269 | suites 66 | pass 269 | fail 0 | skipped 0
verify-schema.sql ..... PASSED: 23 checks
verify-phase4.sql ..... PASSED: 15 checks
verify-d9.sql ......... PASSED: 12 checks
```

Identical across both runs. 269 − 265 = 4, exactly the regression tests added for P0-1; no existing test was weakened.

---

## 9. Readiness score

**8.5 / 10 for submission.**

- **Backend: 9.5/10.** Complete, verified, honest about its limits, and every PS capability is demonstrable live.
- **Frontend: 4/10 as a product, 8/10 as a prototype.** Builds and looks credible, but is not connected to the backend and has no officer screens.
- **Documentation and traceability: 9/10.**
- **Honesty of claims: 10/10.** Nothing fabricated: no invented government data, no false SMS delivery, no claimed disbursal, no invented thresholds.

The single largest risk is presenting the prototype and the API as one integrated system. The demo script exists to prevent exactly that.


---

## 10. Addendum — status of the findings since this audit (2026-09-03, later the same day)

**This section is appended, not merged.** Everything above is the record of what was true when the audit ran and has not been edited; this says what has changed since.

| Finding | Status above | Status now |
|---|---|---|
| **P1-1** — officer accounts cannot be created through any API | DOCUMENTED, NOT FIXED | **CLOSED.** Phase 14 adds `POST /admin/officers`, `GET /admin/officers`, `GET /admin/officers/:employeeCode`, and deactivate/reactivate. `officer.create` and `officer.deactivate` — seeded in the permission vocabulary since Phase 2 and claimed by no route — are now claimed. Documented in [`../api/admin.md`](../api/admin.md); 13 new tests. The demo script no longer creates the officer through a test helper. |
| **P0-2** — frontend not connected to the backend | NOT FIXABLE NOW | Unchanged. Still Phase 15. |
| **P0-3** — no officer UI | NOT FIXABLE NOW | Unchanged. |
| **P1-2** — frontend crop vocabulary mismatch | DOCUMENTED, NOT FIXED | Unchanged. |
| **P1-3** — `QUEUE_APPROACHING` never fires | BY DESIGN | Unchanged. |
| **P2-2** — 16 frontend lint problems | NOT FIXED | Unchanged. |

**What P1-1 did not fix.** There is still **no password change or reset for staff, by anyone**, and still **no admin provisioning** — the bootstrap administrator is seeded by SQL with login disabled, and no route mints a second admin. Both are recorded in [`limitations.md`](./limitations.md) §5.

### Verification at the time of this addendum

Run from a database dropped and rebuilt from zero:

```
provision .............. ready: 15 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings
tsc --noEmit ........... CLEAN
static-check.mjs ....... PASSED — 0 failures, 0 warnings
npm test ............... tests 323 | suites 76 | pass 323 | fail 0 | skipped 0
verify-schema.sql ...... PASSED: 23 checks
verify-phase4.sql ...... PASSED: 15 checks
verify-d9.sql .......... PASSED: 12 checks
route protection ....... PASSED, 68 declared routes
```

323 − 310 = 13, exactly the Phase 14 regression tests; no existing test was weakened or removed.

**A note on the baseline.** The audit above recorded 269 tests and 14 migrations. The intervening work — Phase 12 (notification templates, preferences, delivery provider abstraction, retry backoff) and Phase 13 (admin centre configuration) — carried it to 310 tests and 15 migrations before Phase 14 began. **Phases 12 and 13 have no phase report**, which is the largest remaining documentation gap; their API surface is documented in [`../api/admin.md`](../api/admin.md) and [`../api/notifications.md`](../api/notifications.md).

**One operational fact worth restating**, because it looks like a defect and is not: the integration suite books real windows against real lanes, so a **second `npm test` against the same database reports `NO_AVAILABILITY`, not a scheduling regression.** Run `provision-database.sh --recreate` before every run. This is stated in the script's own header and in `limitations.md` §5.
