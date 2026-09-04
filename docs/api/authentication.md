# Mandi Sahayak — Authentication & Authorization API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phase 5)
**Base path:** `/api/v1`
**Audience:** the frontend team, and whoever builds the Admin UI

> The frontend has **not** been modified. This document is the contract to build
> against when you are ready.

---

## 1. Conventions

### 1.1 Envelopes

```jsonc
// success
{ "data": { ... } }

// error
{ "error": {
    "code": "OTP_INVALID",          // stable, machine-readable — SWITCH ON THIS
    "message": "…",                 // English, for developers/logs. NEVER show a user.
    "fields":  { "phone": "PHONE_INVALID_INDIAN_MOBILE" },  // optional
    "details": { "retryAfterSeconds": 42 },                 // optional
    "requestId": "…"
} }
```

**`message` is not the contract.** The UI is bilingual (en/hi); render
`error.code` (and `fields.*` values) through your i18n bundle. A backend that
returned display sentences could not be translated.

### 1.2 Cookies

| Cookie | Flags | Purpose |
|---|---|---|
| `__Host-fq_session` (prod) / `fq_session` (local HTTP) | `HttpOnly`, `Secure`*, `SameSite=Lax`, `Path=/` | The session. **Not readable by JavaScript, by design.** |
| `fq_csrf` | `Secure`*, `SameSite=Lax`, `Path=/`, **not** HttpOnly | CSRF token; you must read it and echo it |

\* `Secure` is on whenever `COOKIE_SECURE=true` (always in production). The
`__Host-` prefix is applied only with `Secure`, because browsers reject that
prefix over plain HTTP.

**There is no token in any response body.** Do not attempt to store a session in
`localStorage` — nothing is given to you to store. Send requests with
`credentials: 'include'`.

### 1.3 CSRF — required on every write

Every `POST`/`PATCH`/`PUT`/`DELETE` must send header `X-CSRF-Token` equal to the
`fq_csrf` cookie. Call `GET /api/v1/auth/csrf` once at app start.

```js
await fetch('/api/v1/auth/csrf', { credentials: 'include' });
const csrf = document.cookie.split('; ').find(c => c.startsWith('fq_csrf='))?.split('=')[1];

await fetch('/api/v1/auth/otp/verify', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
  body: JSON.stringify({ challengeId, otp }),
});
```

Missing or mismatched → `403 CSRF_TOKEN_INVALID`.

### 1.4 Rate limits

`429 RATE_LIMITED` with `details.retryAfterSeconds`.

| Scope | Limit |
|---|---|
| OTP send per phone | 3 / 15 min, 10 / day |
| OTP send per IP | 20 / hour |
| OTP verify per IP | 30 / 15 min |
| Registration per IP | 10 / hour |
| Staff login per username | 5 / 15 min |
| Staff login per IP | 30 / hour |

---

## 2. Endpoints

### 2.1 `POST /auth/farmer/register/start-otp`

Begin farmer registration. **Creates no user** — an unverified person creates no
identity.

| | |
|---|---|
| Auth | Public |
| Permission | — |
| CSRF | Required |
| Success | `201` |
| Audit | `auth.registration_started` |

**Request**

```jsonc
{
  "fullName": "Ramesh Kumar",          // 2–120 chars, letters/marks/space/.'-
  "phone": "9876543210",               // 10-digit, or +91…/91…/0… — normalised
  "districtId": "<uuid>",              // from reference data
  "villageId": "<uuid>",               // optional, must belong to districtId
  "locale": "en",                      // "en" | "hi", default "en"
  "consent": { "policyVersion": "v1", "accepted": true }
}
```

> **Aadhaar and IFSC are NOT accepted.** The prototype collected
> `aadhaarLast4` and `ifscCode`; both were removed under decisions D-6/D-7 and
> no column exists for them. Sending them is ignored.

**Response `201`**

```jsonc
{ "data": {
  "challengeId": "<uuid>",
  "expiresAt": "2026-09-02T08:05:00.000Z",
  "resendAvailableAt": "2026-09-02T08:01:00.000Z",
  "attemptsRemaining": 5,
  "otpLength": 6
} }
```

**Errors** — `400 VALIDATION_FAILED` (with `fields`) · `409 PHONE_ALREADY_REGISTERED` ·
`422 DISTRICT_NOT_FOUND` · `422 VILLAGE_NOT_IN_DISTRICT` · `429 RATE_LIMITED` ·
`403 CSRF_TOKEN_INVALID`

---

### 2.2 `POST /auth/farmer/login/start-otp`

| | |
|---|---|
| Auth | Public · **Enumeration-resistant** |
| CSRF | Required |
| Success | `201` |
| Audit | `auth.login_otp_requested` |

**Request** `{ "phone": "9876543210" }`
**Response** identical shape to §2.1.

An unregistered number returns **the same status and the same fields**. No OTP is
delivered, so verification simply never succeeds. Do not build UI that infers
account existence from this response — it cannot.

**Errors** — `400 VALIDATION_FAILED` · `429 RATE_LIMITED` · `403 CSRF_TOKEN_INVALID`

---

### 2.3 `POST /auth/staff/login`

First factor for OFFICER/ADMIN. Password alone creates **no session**.

| | |
|---|---|
| Auth | Public |
| CSRF | Required |
| Success | `201` (an OTP challenge, not a session) |
| Audit | `auth.staff_password_verified` / `auth.staff_password_failed` |

**Request** `{ "username": "officer_a", "password": "…" }`
**Response** the same challenge object as §2.1 — then call §2.4.

**Errors** — `400 VALIDATION_FAILED` · `401 INVALID_CREDENTIALS` (also returned for
an unknown user, a non-staff account, or an inactive one) · `429 RATE_LIMITED`

---

### 2.4 `POST /auth/otp/verify`

Completes any of the three flows and **creates the session**.

| | |
|---|---|
| Auth | Public |
| CSRF | Required |
| Success | `201` + `Set-Cookie` session |
| Audit | `auth.login_succeeded`, `auth.registration_completed`, or `auth.otp_failed` / `auth.otp_attempts_exhausted` |

**Request** `{ "challengeId": "<uuid>", "otp": "123456" }`

**Response `201`**

```jsonc
{ "data": {
  "userId": "<uuid>",
  "roles": ["FARMER"],
  "expiresAt": "2026-09-02T20:00:00.000Z"
} }
```

**`400 OTP_INVALID`** is returned for *every* failure — wrong, expired, already
used, attempts exhausted, or unknown challenge. This is deliberate: the endpoint
must not be an oracle. Show one message and offer resend.

After **5** failed attempts the challenge is dead; the correct OTP will no longer
work. Attempt bookkeeping is committed independently of the failure, so retrying
cannot reset the counter.

---

### 2.5 `POST /auth/otp/resend`

| | |
|---|---|
| Auth | Public · CSRF required · Success `200` |
| Audit | `auth.otp_resent` |

**Request** `{ "challengeId": "<uuid>" }` → the challenge object.

A resend issues a **new** code (invalidating the previous one) and does **not**
reset the attempt budget.

**Errors** — `422 OTP_RESEND_COOLDOWN` (with `details.retryAfterSeconds`, 60 s) ·
`422 OTP_RESEND_LIMIT_REACHED` (max 3) · `400 OTP_CHALLENGE_NOT_FOUND`

---

### 2.6 `POST /auth/logout`

| | |
|---|---|
| Auth | Authenticated · CSRF required · Success `200` |
| Audit | `auth.logout` |

Revokes the session **server-side** and clears the cookie. The old cookie is
useless immediately. Clearing browser storage is not logout.

---

### 2.7 `GET /auth/csrf`

Public, no CSRF. Returns `{ "data": { "csrfToken": "…" } }` and sets `fq_csrf`.

---

### 2.8 `GET /me`

| | |
|---|---|
| Auth | Required · Permission `profile.read.own` · Success `200` |

```jsonc
{ "data": {
  "userId": "<uuid>",
  "fullName": "Ramesh Kumar",
  "phoneMasked": "***10",
  "locale": "en",
  "status": "ACTIVE",
  "roles": ["FARMER"],
  "permissions": ["booking.create.own", "…"],
  "district": { "id": "<uuid>", "name": "Aligarh" },
  "village": null,
  "centreIds": []
} }
```

The **full phone is never returned**. `permissions` is provided so the UI can
hide what the user cannot do — but hiding is cosmetic; the server enforces.

**Errors** — `401 UNAUTHENTICATED`

---

### 2.9 `PATCH /me`

| | |
|---|---|
| Auth | Required · Permission `profile.update.own` · CSRF required · Success `200` |
| Audit | `profile.updated` (with before/after) |

**Request** any subset of `fullName`, `locale`, `districtId`, `villageId`.
Role, status and phone are **not** updatable here.

---

### 2.10 `GET /officer/centres`

Permission `booking.read.centre`. Returns the centres the officer is assigned to.
A FARMER receives `403 FORBIDDEN`.

### 2.11 `GET /admin/farmers`

Permission `farmer.read`. ADMIN only. Phone numbers are masked.

### 2.12 `GET /admin/audit-logs?limit=50`

Permission `audit.read`. **ADMIN only — officers are deliberately excluded.**

### 2.13 `GET /dev/last-otp?phone=…`

`DEMO_MODE` only, requires header `X-Dev-Token`. Returns the last demo OTP so a
demo can run without live SMS. Audited on every call. **Refuses to exist in
production**: the process will not start with `DEMO_MODE` and
`NODE_ENV=production` together.

### 2.14 `GET /healthz`, `GET /readyz`

Public liveness/readiness. `readyz` reports the applied migration count.

---

## 3. Error code reference

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | See `fields` for per-field codes |
| `MALFORMED_JSON` | 400 | Body was not JSON |
| `OTP_INVALID` | 400 | Wrong / expired / used / exhausted / unknown |
| `OTP_CHALLENGE_NOT_FOUND` | 400 | Challenge not resendable |
| `UNAUTHENTICATED` | 401 | No valid session |
| `INVALID_CREDENTIALS` | 401 | Staff password step failed |
| `FORBIDDEN` | 403 | Authenticated but lacks the permission |
| `CSRF_TOKEN_INVALID` | 403 | Missing/mismatched/forged CSRF |
| `NOT_FOUND` | 404 | Absent, **or present but not visible to you** |
| `PHONE_ALREADY_REGISTERED` | 409 | Registration duplicate |
| `DISTRICT_NOT_FOUND` | 422 | Unknown district |
| `VILLAGE_NOT_IN_DISTRICT` | 422 | Village/district mismatch |
| `OTP_RESEND_COOLDOWN` | 422 | Too soon; see `details.retryAfterSeconds` |
| `OTP_RESEND_LIMIT_REACHED` | 422 | Resend budget spent |
| `RATE_LIMITED` | 429 | See `details.retryAfterSeconds` |
| `INTERNAL_ERROR` | 500 | Never leaks internals |

Field-level codes: `PHONE_INVALID_INDIAN_MOBILE`, `PHONE_NOT_NUMERIC`,
`NAME_TOO_SHORT`, `NAME_TOO_LONG`, `NAME_INVALID_CHARACTERS`,
`CONSENT_REQUIRED`, `CONSENT_VERSION_REQUIRED`, `DISTRICT_ID_INVALID`,
`VILLAGE_ID_INVALID`, `CHALLENGE_ID_INVALID`, `OTP_FORMAT_INVALID`,
`USERNAME_INVALID`, `PASSWORD_REQUIRED`, `NO_FIELDS_TO_UPDATE`.

---

## 4. Flows

**Farmer registration**

```
GET  /auth/csrf
POST /auth/farmer/register/start-otp   -> 201 { challengeId, otpLength: 6, … }
     (user enters 6 digits; resend allowed after 60 s, max 3)
POST /auth/otp/verify                  -> 201 + session cookie
GET  /me
```

**Farmer login** — as above but `/auth/farmer/login/start-otp`.

**Staff login**

```
POST /auth/staff/login   -> 201 { challengeId }      // password only, NO session
POST /auth/otp/verify    -> 201 + session cookie      // second factor
```

---

## 5. What the frontend must not do

- Do not store a session token — you are never given one.
- Do not use `localStorage` for authentication state. Call `GET /me`.
- Do not treat hidden UI as authorization; the server decides.
- Do not send `aadhaarLast4` or `ifscCode` — no column exists.
- Do not display `error.message`; translate `error.code`.
- Do not infer account existence from the login response.
- Do not let a user proceed past the OTP screen without a `201` from
  `/auth/otp/verify`. The prototype's "Verify & Continue" navigated without
  checking anything; the backend now refuses to issue a session that way.

## 6. Not implemented in Phase 5

Booking, slot scheduling, queue/ETA, SMS delivery, procurement, payment
calculation. Those endpoints do not exist yet.
