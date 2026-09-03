# FarmQueue — Phase 5: Authentication & Authorization

**Status:** **COMPLETE — VERIFIED** against PostgreSQL 17.11
**Date:** 2026-09-02
**Result:** **91 checks pass, twice, from clean databases** (50 SQL probes + 41 auth tests)
**Scope:** authentication and authorization only. No booking, scheduling, queue, SMS, procurement, payment or frontend work.

---

## 1. Runtime decisions taken before writing code

| Decision | Choice | Why |
|---|---|---|
| TypeScript execution | **Node 24 native type stripping** — no build step, no `tsx`, no `ts-node` | Fewer dependencies and no compile artefact. `npm run typecheck` still runs `tsc --noEmit`, which passes clean |
| Dependencies | **3 runtime: `express`, `pg`, `zod`** | The approved stack, nothing more |
| Password KDF | **scrypt (`node:crypto`)**, not Argon2id | **Disclosed deviation from architecture §4.1.** Argon2 needs a native module (node-gyp or prebuilt binaries) — avoidable supply-chain and build fragility. scrypt is RFC 7914, memory-hard, in Node core. The stored hash is self-describing and versioned (`scrypt$N$r$p$salt$hash`), so swapping to Argon2id later is a verifier change plus rehash-on-login, with **no schema change** |
| OTP length | **6 digits** | The approved architecture and the existing frontend (six input boxes). Your brief said "4-digit if that is the approved product requirement" — it is not; 6 is. Configurable via `OTP_LENGTH` |
| Migrations | **None needed** | Phase 2's schema already had every table. CSRF is stateless (HMAC), so it required no column. Migrations 0001–0013 are untouched |

---

## 2. What was built

3 777 lines of TypeScript across 20 files.

```
server/src/
  core/    config, crypto, db, errors, http, logging, audit, rateLimit, session, rbac
  modules/auth/      schemas, otp.service, auth.service, auth.routes, demoOtpStore
  modules/identity/  identity.routes
  app.ts, index.ts
server/tests/  helpers.ts, auth.test.ts   (41 integration tests)
```

### 2.1 Registration contract — backend-defined, not copied from the UI

Phase 0 recorded what the prototype collects. The backend contract deliberately differs:

| Prototype field | Backend contract |
|---|---|
| `fullName` | kept — 2–120 chars, Unicode-letter validation |
| `phone` | kept — accepts `9876543210`, `+91…`, `91…`, `0…`; **normalised once** to `+91XXXXXXXXXX` |
| `district` (free-text name) | `districtId` — a UUID, validated against the table |
| `village` (free-text name) | `villageId` — optional UUID, **must belong to that district** |
| `aadhaarLast4` | **REMOVED** (D-6) |
| `ifscCode` | **REMOVED** (D-6/D-7) |
| consent checkbox | `consent { policyVersion, accepted }` → two `consents` rows with a policy-text hash |

A test asserts no column matching `%aadhaar%`, `%ifsc%` or `%account_number%` exists anywhere in the schema.

### 2.2 The prototype's OTP behaviour is not reproduced

`OTPVerification.jsx` navigated to `/dashboard` on a plain button press without reading the entered digits. The backend now refuses to issue a session unless a challenge verifies against a stored peppered HMAC, unexpired, within budget, exactly once. Tests assert no session cookie is set on every failure path.

### 2.3 Security properties implemented

| Property | How |
|---|---|
| OTP secrecy | `HMAC-SHA256(otp, OTP_PEPPER)`; pepper in env, not the DB. **No plaintext OTP column exists** |
| OTP generation | `crypto.randomInt`, never `Math.random`; leading zeros preserved |
| OTP limits | 5 min expiry · 5 attempts · 60 s resend cooldown · max 3 resends · one-time use |
| Opaque failures | Wrong / expired / consumed / exhausted / unknown all return `400 OTP_INVALID` |
| Login enumeration | Unknown phone gets a real **decoy challenge**; identical status, fields and shape. No OTP delivered, so it can never verify |
| Staff auth | Password (scrypt) **+** OTP second factor. Password alone creates no session |
| Timing | `verifyPassword` burns equivalent scrypt work when the user doesn't exist |
| Sessions | Opaque 256-bit token; **only SHA-256 stored**; `HttpOnly` + `SameSite=Lax` + `Path=/`; `__Host-` prefix in production |
| Revocation | Immediate — roles, permissions and centre scope are re-read from the DB on every request |
| Privilege | Roles assigned by the **server from the flow**. Farmer registration can only produce `FARMER` |
| CSRF | Stateless double-submit with a server HMAC — a matching cookie/header pair is still rejected without a valid MAC |
| Rate limiting | DB-backed fixed windows on its **own connection** |
| Audit | 19 event types, written in the same transaction, through the redactor |

---

## 3. Deny-by-default RBAC, enforced at startup

Fifteen routes, each with an explicit declaration. `verifyRouteProtection()` runs **before** `listen()` and refuses to boot if a route has no auth declaration, names a permission absent from the `permissions` table, is declared public without a reason, or mutates state without CSRF.

| Route | Auth |
|---|---|
| `GET /healthz`, `GET /readyz`, `GET /auth/csrf` | public |
| `POST /auth/farmer/register/start-otp`, `…/login/start-otp`, `/auth/staff/login`, `/auth/otp/verify`, `/auth/otp/resend` | public + CSRF |
| `GET /dev/last-otp` | public, DEMO_MODE + dev token |
| `POST /auth/logout` | authenticated + CSRF |
| `GET /me` | `profile.read.own` |
| `PATCH /me` | `profile.update.own` + CSRF |
| `GET /officer/centres` | `booking.read.centre` |
| `GET /admin/farmers` | `farmer.read` |
| `GET /admin/audit-logs` | `audit.read` |

A test registers a route naming `does.not.exist` and asserts the assertion throws.

---

## 4. A real security bug the tests caught

Two tests failed with what looked like assertion noise: attempts stayed at `0`, and an expired challenge stayed `PENDING`.

**The cause was a genuine vulnerability.** OTP verification ran inside one transaction. On failure the service wrote the audit row and **threw** — and the throw rolled the transaction back, undoing the attempt increment, the status transition *and* the audit row.

**Every wrong guess erased its own evidence.** The 5-attempt limit never accumulated, so an attacker had unlimited OTP guesses against a 10⁶ space — with no audit trail. That defeats the single most important control on the OTP design.

**Fix:** verification now runs in **two transactions**. The first commits the bookkeeping (attempt increment, status transition, consumption, audit). The second creates the identity and session. They cannot share a transaction, because the failure path must both throw *and* persist.

The residual trade-off is documented in the code: a challenge can be consumed without a session if the second transaction fails. That direction is fail-closed — the farmer requests a new OTP. The reverse would be a replay hole.

This is the same root cause as the rate limiter needing its own connection, and it is now called out in both places.

---

## 5. Tests

**41 integration tests.** Nothing mocked — real Express app, real PostgreSQL, real HTTP, real cookie jar. The properties under test only exist end to end.

| Suite | Covers |
|---|---|
| farmer registration (4) | valid; **no user exists before verification**; duplicate → 409; invalid phone/consent/district; no Aadhaar/IFSC columns |
| OTP security (8) | wrong OTP; **5-attempt limit then correct OTP refused**; expiry; one-time use / replay; resend cooldown then success; OTP never in a response body; enumeration resistance; login by OTP |
| sessions (6) | logout; revoked session; expired session; forged token; HttpOnly/SameSite/Path flags; **raw token never equals a stored value** |
| staff authentication (5) | password+OTP required; bad password; bad OTP; farmer cannot use the staff endpoint; logout |
| RBAC (7) | unauthenticated → 401; farmer → officer 403; farmer → admin 403; **officer → admin 403**; officer OK; admin OK; denials audited; roles unchangeable via request |
| CSRF (4) | missing; mismatched; **forged pair without a valid HMAC**; safe methods exempt |
| rate limiting (2) | limit fires; breach audited |
| audit log (3) | events recorded; no OTP/password values anywhere; **UPDATE/DELETE/TRUNCATE all refused** |
| route registry (1) | startup assertion rejects an unknown permission |

### 5.1 Two test defects I found and fixed

- Back-dating `sessions.expires_at` and `otp_challenges.expires_at` violated `expires_at > created_at`. The constraint was right; the tests had to move `created_at` too.
- A staff-login test expected `400` for a numeric username. A digit string *is* a valid username, so `401 INVALID_CREDENTIALS` is correct — and is the property actually worth asserting.

### 5.2 Rate limits in tests

All tests originate from `127.0.0.1`, so the per-IP limits correctly fired mid-suite. Rather than weaken the limits — which would stop them being the limits that ship — buckets are cleared between tests, and the dedicated rate-limit test exercises enforcement within one test body.

---

## 6. Verification runs

| | Run 1 | Run 2 |
|---|---|---|
| Migrations 0001–0013, clean DB | 13/13 | 13/13 |
| Import 0001 (OFFICIAL MSP) | PASS | PASS |
| Import 0002 (CONFIGURED geography) | PASS | PASS |
| `verify-schema.sql` | **23/23** | **23/23** |
| `verify-phase4.sql` | **15/15** | **15/15** |
| `verify-d9.sql` | **12/12** | **12/12** |
| Phase 5 suite | **41/41** | **41/41** |
| **Total** | **91/91** | **91/91** |

`tsc --noEmit`: clean. Migration static checker: 0 failures, 0 warnings.
PostgreSQL `17.11 on x86_64-windows` (`server_version_num` 170011).

---

## 7. Known limitations

1. **OTP delivery is a log line.** No SMS is sent — that is Phase 12 (outbox + `SmsProvider`). `DEMO_MODE` records the OTP in memory for the dev endpoint; there is still no plaintext OTP column.
2. **scrypt, not Argon2id** (§1) — disclosed, swappable without a migration.
3. **Registration reveals whether a phone is registered** (`409`). A disclosed trade-off: registration needs a usable duplicate path, and it is rate-limited to 3/phone/15 min and 10/IP/hour. **Login is fully enumeration-resistant**, which is the more sensitive surface. Say the word and I will make registration opaque too.
4. **No officer/admin provisioning API.** Staff are created directly in the database (the test helper does this). Admin-managed officer creation is Phase 14.
5. **No password rotation, reset or lockout beyond rate limiting.**
6. `audit_logs` privilege `REVOKE` still skipped — the `farmqueue_app` role does not exist in the verification cluster. The three immutability triggers are active and verified regardless.
7. **The verification database is ephemeral.**
8. **CORS is not configured** — the design assumes the frontend is served same-origin behind one reverse proxy, with a Vite dev proxy locally.

---

## 8. Risks

| # | Risk |
|---|---|
| **R-O (new)** | The two-transaction OTP split means a consumed challenge can exist without a session if the second transaction fails. Fail-closed and documented, but it is a real (rare) UX edge: the farmer must request a new OTP |
| **R-P (new)** | Session lookup runs a 4-subquery join per authenticated request. Correct and always fresh, but unmeasured under load. Revisit with caching only if measurement demands it — never by trusting the cookie |
| **R-J** (unchanged, high) | MSP values still single-sourced, `verified_at` NULL. Must be cross-checked before Phase 11 computes money |
| **R-N** (unchanged) | Demonstration centres must never be presented as real government facilities |
| **R-L** (unchanged) | `origin/faramqueue-feature` still unmerged and conflicting with `main` |

---

## 9. Running it

```bash
cd server && npm install

export DATABASE_URL="postgres://user@host:5432/farmqueue"
export OTP_PEPPER="…" SESSION_PEPPER="…" CSRF_PEPPER="…"   # each ≥16 chars, required
export DEMO_MODE=true DEV_TOOLS_TOKEN="…"                   # optional, dev only

npm start          # refuses to boot if any route lacks a permission
npm run typecheck
TEST_DATABASE_URL="postgres://user@host:5432/farmqueue_test" npm test
```

Contract for the frontend team: **`docs/api/authentication.md`**.

---

## 10. Phase Completion Report

**PHASE:** 5 — Authentication and authorization
**STATUS:** COMPLETE — VERIFIED

**WHAT I INSPECTED:** the prototype's registration/login/OTP screens (to define the contract deliberately against them, not copy them), the approved architecture §4/§5, and the Phase 2 schema.

**WHAT I IMPLEMENTED:** farmer registration, farmer OTP login, staff password+OTP 2FA, opaque revocable sessions, deny-by-default RBAC with a startup assertion, stateless CSRF, DB-backed rate limiting, redacted append-only audit logging, and 15 routes.

**FILES CREATED:** `server/package.json`, `tsconfig.json`, 12 `src/**` modules, `tests/helpers.ts`, `tests/auth.test.ts`, `docs/api/authentication.md`, `docs/phase-5-authentication.md`.

**FILES MODIFIED:** none outside `server/` and `docs/`. Among tracked files only `.gitignore` remains modified (from Phase 3). **The frontend and `src/index.css` are untouched.**

**DATABASE CHANGES:** **NONE.** No migration was required; 0001–0013 untouched; no constraint weakened.

**API CHANGES:** 15 new endpoints under `/api/v1` (§3), documented in `docs/api/authentication.md`.

**BUSINESS RULES:** phone normalised to E.164; district/village referential validity; consent recorded with policy version and text hash; OTP 6 digits / 5 min / 5 attempts / 60 s cooldown / 3 resends / one-time; staff require two factors; roles server-assigned.

**SECURITY CHANGES:** see §2.3 — plus the vulnerability found and fixed in §4.

**TESTS CREATED:** 41 integration tests.

**TEST RESULTS:** **91/91 twice** (23 schema + 15 phase-4 + 12 D-9 + 41 auth). `tsc --noEmit` clean.

**REAL GOVERNMENT SOURCES USED:** none this phase. **DATA IMPORTED:** none.

**DATA CLASSIFICATION:** unchanged — 23 OFFICIAL MSP rates, 20 OFFICIAL crops, 1 OFFICIAL state, CONFIGURED demonstration geography, 0 TEST rows persisted.

**KNOWN LIMITATIONS:** §7. **RISKS:** §8.

**NEXT PHASE:** Phase 6 — reference-data APIs (districts, villages, centres, crops, working hours), the natural next step now that authentication gates them.

**STOP.** Awaiting approval.
