# FarmQueue — Admin API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phases 13 and 14)
**Base path:** `/api/v1`
**Companion:** [`authentication.md`](./authentication.md) — cookies, CSRF, error envelope

> **Every endpoint on this page is ADMIN-only.** An OFFICER holds none of these permissions and receives `403` on all of them, including the reads. That is the point of §2.

---

## 1. Endpoints

### 1.1 Centre configuration (Phase 13)

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/admin/centres?includeInactive=true` | `centre.update` | — |
| POST | `/admin/centres` | `centre.create` | yes |
| PATCH | `/admin/centres/:centreId` | `centre.update` | yes |
| GET | `/admin/centres/:centreId/lanes` | `centre.configure` | — |
| PUT | `/admin/centres/:centreId/lanes` | `centre.configure` | yes |
| GET | `/admin/centres/:centreId/hours?date=YYYY-MM-DD` | `centre.configure` | — |
| PUT | `/admin/centres/:centreId/hours` | `centre.configure` | yes |
| GET | `/admin/centres/:centreId/holidays` | `centre.configure` | — |
| POST | `/admin/centres/:centreId/holidays` | `centre.configure` | yes |
| DELETE | `/admin/centres/:centreId/holidays/:date` | `centre.configure` | yes |
| GET | `/admin/centres/:centreId/crops` | `centre.configure` | — |
| PUT | `/admin/centres/:centreId/crops` | `centre.configure` | yes |
| GET | `/admin/centres/:centreId/slot-config?date=YYYY-MM-DD` | `centre.configure` | — |
| PUT | `/admin/centres/:centreId/slot-config` | `centre.configure` | yes |
| GET | `/admin/centres/:centreId/officers` | `officer.assign_centre` | — |
| POST | `/admin/centres/:centreId/officers` | `officer.assign_centre` | yes |
| DELETE | `/admin/centres/:centreId/officers/:employeeCode` | `officer.assign_centre` | yes |

### 1.2 Officer provisioning (Phase 14)

| Method | Path | Permission | CSRF |
|---|---|---|:--:|
| GET | `/admin/officers?includeInactive=true` | `officer.create` | — |
| POST | `/admin/officers` | `officer.create` | yes |
| GET | `/admin/officers/:employeeCode` | `officer.create` | — |
| POST | `/admin/officers/:employeeCode/deactivate` | `officer.deactivate` | yes |
| POST | `/admin/officers/:employeeCode/reactivate` | `officer.create` | yes |

### 1.3 Administrative reads defined elsewhere

| Method | Path | Permission | Module |
|---|---|---|---|
| GET | `/admin/farmers` | `farmer.read` | `identity.routes.ts` — phone numbers masked to the last two digits |
| GET | `/admin/audit-logs?limit=50` | `audit.read` | `identity.routes.ts` — `before_state`/`after_state` are **not** returned |

---

## 2. Operating a centre and configuring one are different authorities

An officer works at a centre. An administrator decides how that centre works. These are separated on purpose (architecture §5.4), and the separation is enforced by the grant matrix, not by a UI hiding a button:

| | OFFICER | ADMIN |
|---|:--:|:--:|
| Advance a booking, record weight, record quality | ✔ | — |
| Change the centre's hours, lanes, holidays, crops, slot configuration | — | ✔ |
| Create or deactivate an officer | — | ✔ |
| Assign an officer to a centre | — | ✔ |

**An officer cannot configure the centre they work at.** Asserted by test, for every endpoint on this page.

An administrator's scope is global — there is no admin-to-centre assignment table — so no centre-scope check runs on these routes. Officer routes carry one; admin routes do not, and that difference is deliberate rather than an omission.

---

## 3. Two rules the configuration surface enforces structurally

### 3.1 Nothing here can create OFFICIAL data

Every insert in `admin.repository.ts` hardcodes `data_type = 'CONFIGURED'`. There is no request field, on any endpoint, that could promote a row to `OFFICIAL` — `OFFICIAL` requires a verified `source_id`, and no administrative API can manufacture provenance. `POST /admin/centres` says so in its own response:

```jsonc
{
  "centreId": "…",
  "code": "DEMO-UP-AGRA-02",
  "dataType": "CONFIGURED",
  "note": "Created as CONFIGURED demonstration data. It is not an official government centre."
}
```

`storage_check_mode` stays `ADVISORY` for the same reason: no administrative call may assert physical storage capacity (decision D-10). A test walks every centre in the system and fails if any is not `CONFIGURED`/`ADVISORY`.

### 3.2 Deactivate, never delete

A centre, lane or configuration referenced by a booking is history. Status changes and temporal end-dating are the only ways anything leaves service.

- `PATCH /admin/centres/:id` with `status: "INACTIVE"` → **`409 CENTRE_HAS_ACTIVE_BOOKINGS`** if farmers still hold bookings there. Refusing beats orphaning.
- `PUT …/lanes` with `isActive: false` → **`409 LANE_HAS_ACTIVE_BOOKINGS`** on the same principle.
- `POST …/holidays` on a date that already has bookings → **`409 DATE_HAS_ACTIVE_BOOKINGS`**. Cancel them first, deliberately, rather than having a configuration change silently strand them.
- Hours, crop eligibility and slot configuration are **end-dated, never overwritten**, so "what were this centre's hours on that service date?" stays answerable. `centre_slot_configurations_no_overlap` (a GiST exclusion constraint) rejects an overlapping period in the database, independently of the application.

---

## 4. Officer provisioning

### 4.1 Why it exists

Officers are created by an administrator; there is no staff self-registration (assumption A-4). Before Phase 14 the only way to obtain an officer account was to write to the database by hand — the one role that operates the system could not be provisioned by the system. `officer.create` and `officer.deactivate` had been seeded in the permission vocabulary since Phase 2 and were claimed by no route.

### 4.2 Create

```http
POST /api/v1/admin/officers
```

```jsonc
{
  "fullName": "Ramesh Chandra",
  "username": "r.chandra",           // ^[a-z0-9._-]{3,64}$, lowercased for you
  "password": "Initial-Passw0rd",    // >= 12 chars, with a lower, an upper and a digit
  "phone": "9876543210",             // normalised to +91XXXXXXXXXX
  "employeeCode": "EMP-UP-0431",     // ^[A-Za-z0-9._-]{3,64}$, unique
  "designation": "Procurement Officer"   // optional
}
```

**`201`**

```jsonc
{
  "employeeCode": "EMP-UP-0431",
  "username": "r.chandra",
  "fullName": "Ramesh Chandra",
  "status": "ACTIVE",
  "note": "The officer can sign in, but holds no centre assignment yet and can act on nothing until assigned."
}
```

The note is not decoration. A new officer has no posting, so every officer endpoint returns an empty result for them until an administrator calls `POST /admin/centres/:centreId/officers`. Without the note that reads as a defect rather than an unfinished provisioning step.

**The role is hardcoded.** `createOfficer` inserts `WHERE code = 'OFFICER'` and takes no role parameter, so there is no field — recognised or ignored — through which this endpoint could grant ADMIN. A test posts `role`, `roleCode`, `isAdmin` and `permissions` alongside a valid body and asserts the created account holds exactly one role, `OFFICER`, and then proves it operationally: the new officer receives `403` from the very endpoint that created them.

**The password is hashed at the route boundary** and the repository is typed to accept a hash, so there is no overload through which plaintext could reach SQL. It is never echoed, never selected by any read on this page, and never written to the audit trail — not even as a redacted placeholder.

**Password policy.** `InitialPasswordSchema` is deliberately stricter than the login schema, which must keep accepting whatever an existing account already has. Account creation is the one moment the system can insist on a floor. Staff also carry an OTP second factor (D-3), so the rule is a length floor with a character-class check rather than a composition maze that pushes officers towards writing the password down.

**Conflicts are named, not generic**, because an administrator needs to know which identifier collided:

| Code | Status | Cause |
|---|:--:|---|
| `USERNAME_TAKEN` | 409 | `users.username` already exists |
| `PHONE_ALREADY_REGISTERED` | 409 | `users.phone_e164` already exists (possibly a farmer) |
| `EMPLOYEE_CODE_TAKEN` | 409 | `officers.employee_code` already exists |

A unique violation caught from the insert could not distinguish these, so each is checked explicitly inside the same transaction as the insert.

### 4.3 Deactivate

```http
POST /api/v1/admin/officers/:employeeCode/deactivate
{ "reason": "transferred out of the district" }   // optional
```

```jsonc
{
  "employeeCode": "EMP-UP-0431",
  "deactivated": true,
  "sessionsRevoked": 1,
  "assignmentsRevoked": 1
}
```

Four things happen in **one transaction**:

1. `officers.status → INACTIVE` (with `deactivated_at`, which a CHECK constraint keeps consistent).
2. `users.status → INACTIVE`, so the login stops working. **Both rows, always** — leaving the login ACTIVE would let a deactivated officer sign in again; leaving the officer row ACTIVE would let them be assigned to a centre they can never work.
3. Every live session for that user is revoked with reason `officer_deactivated`.
4. Every live centre assignment is revoked (`revoked_at` set; the row is kept, because assignment history is an audit trail).

**Step 3 is the one that matters.** Without it a removed officer keeps their authority until their session happens to expire — up to twelve hours after the decision to remove it. A test logs an officer in, confirms they can read their centre, deactivates them, and asserts the *existing* session returns `401` on the very next request, and that a fresh login attempt returns `401` too.

**Idempotent.** Deactivating an already-inactive officer returns `200` with `deactivated: false` and both counts zero.

**An administrator cannot lock themselves out through this route.** The lookup is against `officers`, and an ADMIN has no row there. That is a property of the schema, not a check a later edit could forget.

### 4.4 Reactivate

```http
POST /api/v1/admin/officers/:employeeCode/reactivate
```

Restores `officers.status` and `users.status` to `ACTIVE`. **Centre assignments are not restored** — deactivation revoked them, and reactivation does not guess that the same postings are still the right ones. The response says so, and a test asserts a reactivated officer sees zero centres until assigned again. Idempotent: reactivating an active officer returns `reactivated: false`.

**Why this route is gated on `officer.create` and not `officer.deactivate`.** Restoring an account's authority is the same authority as granting it: an administrator who can create an officer can already reach this end state from scratch, so the gate grants no new power. Gating it on `officer.deactivate` would instead hand the power to *restore* access to a role meant only to be able to *remove* it.

### 4.5 Reads

`GET /admin/officers` returns every officer with both status fields:

```jsonc
{
  "count": 2,
  "officers": [
    {
      "employeeCode": "EMP-UP-0431",
      "fullName": "Ramesh Chandra",
      "username": "r.chandra",
      "designation": "Procurement Officer",
      "status": "ACTIVE",          // the officers row
      "loginStatus": "ACTIVE",     // the users row
      "activeAssignments": 1,
      "deactivatedAt": null
    }
  ]
}
```

`status` and `loginStatus` are shown separately so a half-applied deactivation is visible, rather than leaving an officer who reads as INACTIVE but can still sign in. `password_hash` is absent from the projection in SQL, not filtered afterwards.

`GET /admin/officers/:employeeCode` adds the officer's full assignment history, each entry with `assignedAt`, `revokedAt` and `active`.

**Why the reads are gated on a mutation permission.** No `officer.read` exists in the permission vocabulary, and inventing one would widen the grant matrix that architecture §5.3 fixes. `GET /admin/centres` already sets the precedent of gating an administrative read on the matching mutation permission. Both are ADMIN-only either way.

---

## 5. Audit

Every mutation on this page is audited **in the same transaction that makes it** (principle P-9). If the audit write fails, the change rolls back; there is no path where a configuration changes and the record does not.

| Action | Entity type | Emitted by |
|---|---|---|
| `centre.created`, `centre.updated` | `centre_configuration` | centre create/patch |
| `centre.lane_configured`, `centre.hours_configured`, `centre.holiday_set`, `centre.crop_configured`, `centre.slot_configured` | `centre_configuration` | the matching configuration route |
| `officer.assigned`, `officer.assignment_revoked` | `centre_configuration` | centre officer assignment |
| `officer.created`, `officer.deactivated`, `officer.reactivated` | `officer` | provisioning |

`before_state` and `after_state` pass through the same redactor as the logs, which blanks any key matching `password|secret|token|hash|…` and masks anything phone-shaped. The provisioning routes go further and **never put a credential field in the payload at all**, redacted or otherwise: the record says an officer was created, never anything about their credential. A test dumps every audit row for a provisioned officer and fails if either the plaintext password or the string `scrypt` appears.

`GET /admin/audit-logs` deliberately does not return `before_state`/`after_state`.

---

## 6. Error codes

| Code | Status | Meaning |
|---|:--:|---|
| `VALIDATION_FAILED` | 400 | Field errors in `error.fields`, e.g. `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_WEAK`, `USERNAME_INVALID`, `EMPLOYEE_CODE_INVALID`, `CODE_INVALID`, `DATE_INVALID`, `TIME_INVALID`, `MARKETING_YEAR_INVALID` |
| `DISTRICT_NOT_FOUND` | 400 | `districtId` matches no district |
| `UNAUTHENTICATED` | 401 | No session |
| `FORBIDDEN` | 403 | Authenticated, but the role lacks the permission |
| `CSRF_TOKEN_INVALID` | 403 | Mutating request without a valid CSRF token |
| `NOT_FOUND` | 404 | Unknown centre, officer, holiday or active assignment |
| `CENTRE_CODE_TAKEN` | 409 | Duplicate centre code |
| `CENTRE_HAS_ACTIVE_BOOKINGS` | 409 | Deactivating a centre that still holds bookings |
| `LANE_HAS_ACTIVE_BOOKINGS` | 409 | Deactivating a lane that still holds bookings |
| `DATE_HAS_ACTIVE_BOOKINGS` | 409 | Declaring a holiday on a date with bookings |
| `OFFICER_INACTIVE` | 409 | Assigning a centre to a deactivated officer |
| `USERNAME_TAKEN` | 409 | Duplicate username |
| `PHONE_ALREADY_REGISTERED` | 409 | Duplicate phone number |
| `EMPLOYEE_CODE_TAKEN` | 409 | Duplicate employee code |

Conflicts carry a `details` object where a count helps — `CENTRE_HAS_ACTIVE_BOOKINGS` reports `activeBookings`.

---

## 7. What this API deliberately does not do

- **No password change or reset, by anyone.** An officer's password is whatever the administrator set at creation. There is no self-service change endpoint and no admin reset endpoint; adding either is a product decision that has not been taken. This is the most significant limitation of the provisioning surface and is recorded in `docs/submission/limitations.md` rather than papered over.
- **No admin provisioning.** `POST /admin/officers` creates officers only. The bootstrap administrator is seeded by `scripts/seed-bootstrap-admin.sql` with login disabled; there is no route that creates a second admin, because a route that can mint its own privilege level is a different security question than this phase settled.
- **No officer deletion.** Officers are deactivated. `audit_logs.actor_user_id` is `ON DELETE RESTRICT`, so a user who has acted can never be hard-deleted — the correct outcome for an audit trail.
- **No storage, crop-master, MSP or notification-template administration.** `storage.configure`, `crop.manage`, `msp.import`, `msp.activate`, `data_source.manage` and `notification_template.manage` remain seeded but unclaimed by any route.
- **No admin UI.** This is an API surface. Officer and admin screens do not exist in the React prototype (recorded as R-2 since Phase 0).
