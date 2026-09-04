# Mandi Sahayak — Farmer API (v1)

**Status:** Implemented and verified against PostgreSQL 17.11 (Phase 6)
**Base path:** `/api/v1`
**Companion:** [`authentication.md`](./authentication.md) — conventions, cookies, CSRF, error envelope

> Authentication endpoints are **defined in `authentication.md` and are not
> repeated here**. This document covers the farmer domain that sits on top of
> them: profile and reference data.
>
> The frontend has not been modified. Divergences between the current UI and this
> contract are catalogued in
> [`../phase-6-frontend-contract-audit.md`](../phase-6-frontend-contract-audit.md).

---

## 1. Endpoint index

| Method | Path | Permission | CSRF | Defined in |
|---|---|---|:--:|---|
| POST | `/auth/farmer/register/start-otp` | public | ✔ | authentication.md §2.1 |
| POST | `/auth/farmer/login/start-otp` | public | ✔ | authentication.md §2.2 |
| POST | `/auth/otp/verify` | public | ✔ | authentication.md §2.4 |
| POST | `/auth/otp/resend` | public | ✔ | authentication.md §2.5 |
| POST | `/auth/logout` | authenticated | ✔ | authentication.md §2.6 |
| GET | `/me` | `profile.read.own` | — | §3 below |
| PATCH | `/me` | `profile.update.own` | ✔ | §4 below |
| GET | `/reference/districts` | `reference.read` | — | §5 |
| GET | `/reference/villages` | `reference.read` | — | §6 |
| GET | `/reference/crops` | `reference.read` | — | §7 |
| GET | `/reference/centres` | `reference.read` | — | §8 |
| GET | `/reference/booking-constraints` | `reference.read` | — | §9 |

---

## 2. Identity comes from the session — never from the request

**There is no `/farmers/:id` endpoint, and there will not be one for farmer
self-service.** The authenticated session already identifies the farmer, so a
farmer id in a path, query or body is not merely ignored — it has nowhere to go.

```
authenticated session  ->  server-resolved user id  ->  farmer row
```

Verified by test: farmer A sending `{ userId, farmerId, id }` belonging to
farmer B in a `PATCH /me` body updates **only A**, and B is untouched. Likewise
`GET /me?userId=<B>` returns A.

Do not build a client that sends a farmer id. Nothing needs it.

---

## 3. `GET /me`

| | |
|---|---|
| Authentication | Required |
| Permission | `profile.read.own` |
| CSRF | Not required (safe method) |
| Success | `200` |
| Rate limit | Standard authenticated limits |
| Audit | None (reads are not audited) |

**Response `200`**

```jsonc
{ "data": {
  "userId": "b6f1…",
  "fullName": "Ramesh Kumar",
  "phoneMasked": "***10",
  "locale": "en",
  "status": "ACTIVE",
  "roles": ["FARMER"],
  "permissions": ["booking.create.own", "profile.read.own", "…"],
  "district": { "id": "44444444-…-000000000011", "name": "Aligarh" },
  "village": null,
  "centreIds": []
} }
```

- **`phoneMasked` only.** The full number is never returned; the user knows it,
  and not echoing it keeps it out of logs and screenshots.
- `permissions` lets the UI hide what the user cannot do. Hiding is cosmetic —
  the server enforces regardless.
- `village` is `null` while village data is unavailable (§6).
- `centreIds` is empty for farmers; it is populated for officers.

**Errors:** `401 UNAUTHENTICATED` · `404 NOT_FOUND` (profile row missing)

---

## 4. `PATCH /me`

| | |
|---|---|
| Authentication | Required |
| Permission | `profile.update.own` |
| CSRF | **Required** |
| Success | `200` |
| Audit | `profile.updated`, with redacted before/after state |

**Request** — any non-empty subset:

```jsonc
{ "fullName": "Ramesh Verma", "locale": "hi",
  "districtId": "<uuid>", "villageId": "<uuid>|null" }
```

**Updatable:** `fullName`, `locale`, `districtId`, `villageId`.
**Not updatable here, by design:** phone, roles, permissions, status, user id.
Sending them is ignored — a test asserts a farmer sending `roles: ["ADMIN"]`
remains `FARMER` with `status: ACTIVE`.

**Response** `{ "data": { "updated": true } }`

**Errors:** `400 VALIDATION_FAILED` (`NAME_TOO_SHORT`, `NAME_INVALID_CHARACTERS`,
`NO_FIELDS_TO_UPDATE`, locale not `en`/`hi`) · `400 DISTRICT_NOT_FOUND` ·
`400 VILLAGE_NOT_IN_DISTRICT` · `401` · `403 CSRF_TOKEN_INVALID`

---

## 5. `GET /reference/districts`

Permission `reference.read`. Replaces the hardcoded district array in
`Registration.jsx`.

```jsonc
{ "data": [
  { "id": "…", "name": "Aligarh", "lgdCode": null, "dataType": "CONFIGURED",
    "state": { "name": "Uttar Pradesh", "lgdCode": "9" } }
] }
```

`dataType` is `CONFIGURED` for the five demonstration districts and must be
labelled as such in any UI that shows provenance. `state.lgdCode` is `"9"` —
that value **is** OFFICIAL, read from the Local Government Directory.
`lgdCode` is `null` on districts because LGD district codes were not
retrievable (CAPTCHA / API key); inventing one is forbidden.

---

## 6. `GET /reference/villages?districtId=<uuid>`

```jsonc
{ "data": {
  "districtId": "…",
  "available": false,
  "reasonCode": "NO_VILLAGE_DATA_FOR_DISTRICT",
  "villages": []
} }
```

**An empty list is the correct answer today, not a bug.** LGD village data was
not retrievable, and the 17 village names hardcoded in the prototype are
unverified and deliberately absent from the database.

**Frontend guidance:** when `available` is `false`, hide the village field
rather than rendering an empty dropdown. `villageId` is optional on registration
for exactly this reason. **Do not fall back to the hardcoded list.**

**Errors:** `400 VALIDATION_FAILED` (`DISTRICT_ID_INVALID`) when `districtId` is
missing or malformed.

---

## 7. `GET /reference/crops`

Replaces the hardcoded `<option>` list in `BookSlot.jsx`, and exposes the
crop → season → marketing year chain the booking engine will need.

```jsonc
{ "data": [
  { "id": "…", "code": "WHEAT", "canonicalName": "Wheat", "dataType": "OFFICIAL",
    "season": { "code": "RMS", "name": "Rabi Marketing Season" },
    "marketingYear": "2026-27", "grades": [], "eligibleCentreCount": 5 },

  { "id": "…", "code": "PADDY", "canonicalName": "Paddy", "dataType": "OFFICIAL",
    "season": { "code": "KMS", "name": "Kharif Marketing Season" },
    "marketingYear": "2026-27", "grades": ["Common", "Grade A"],
    "eligibleCentreCount": 2 }
] }
```

**Three things the frontend must absorb:**

1. **Send `id`, not a display string.** `cropId` is a UUID.
2. **`canonicalName` is the government's own wording — do not translate it** in
   the i18n bundle. Renaming an official crop misrepresents the source. The
   prototype's `"Rice"` is `PADDY`; `"Mustard"` is `"Rapeseed & Mustard"`.
3. **`"Other"` does not exist and never will.** It cannot carry an MSP or a
   centre eligibility rule, so a booking for it could never be priced.

`grades` is non-empty when the source publishes per-variety rates. For such a
crop a grade-less MSP lookup is genuinely ambiguous (D-9), so the UI should
collect the grade at procurement time.

---

## 8. `GET /reference/centres?districtId=&cropId=`

Both filters optional; each must be a UUID if present.

```jsonc
{ "data": [
  { "id": "…", "code": "DEMO-UP-ALIGARH-01",
    "name": "Aligarh Demonstration Procurement Centre",
    "dataType": "CONFIGURED",
    "district": { "id": "…", "name": "Aligarh" },
    "timezone": "Asia/Kolkata",
    "laneCount": 3,
    "acceptedCrops": ["Paddy", "Wheat"],
    "storage": { "checkMode": "ADVISORY",
                 "status": "NOT_AVAILABLE",
                 "reasonCode": "NO_CAPACITY_DATA_FOR_CENTRE" } }
] }
```

- **`dataType: "CONFIGURED"` and the `DEMO-` prefix are load-bearing.** These
  centres correspond to no verified government facility. Never present them as
  official government centres.
- **`storage` returns a reason code, never an invented number.** Official storage
  capacity is published at national and state level only; converting that to a
  centre figure is forbidden (D-10).
- `laneCount` differs per centre (1–3) — the architecture supports heterogeneous
  centres, so do not assume one.

---

## 9. `GET /reference/booking-constraints`

```jsonc
{ "data": { "quantity": {
  "unit": "kg", "minKg": 2500, "maxKg": 5000,
  "minQuintal": 25, "maxQuintal": 50,
  "kgPerQuintal": 100, "integerOnly": true
} } }
```

**Do not hardcode these numbers in a component.** They are also enforced by a
PostgreSQL `CHECK` constraint, and the server refuses to start if the two ever
disagree.

**Unit contract:** the wire field is **always `quantityKg`**, an integer. If the
UI collects quintal, convert before sending. The prototype's
`<input min="1">` labelled kg is wrong on both range and, if you switch to
quintal, on unit — and the locale bundles currently have **no quintal key**.

---

## 10. Error codes added in Phase 6

| Code | Status | Meaning |
|---|---|---|
| `DISTRICT_ID_INVALID` | 400 (field) | Not a UUID, or missing |
| `CROP_ID_INVALID` | 400 (field) | Not a UUID |
| `QUANTITY_NOT_INTEGER` | 400 (field) | Not a whole number |
| `QUANTITY_BELOW_MINIMUM` | 400 (field) | Below 2 500 kg |
| `QUANTITY_ABOVE_MAXIMUM` | 400 (field) | Above 5 000 kg |
| `NO_VILLAGE_DATA_FOR_DISTRICT` | — (reason) | Not an error; a `reasonCode` in a `200` |
| `NO_CAPACITY_DATA_FOR_CENTRE` | — (reason) | Not an error; a `reasonCode` in a `200` |

The full list is in `authentication.md` §3. Switch on `error.code`; never render
`error.message`.

---

## 11. Suggested dashboard call sequence

```
GET  /auth/csrf                         once at app start
POST /auth/farmer/login/start-otp   ->  challengeId
POST /auth/otp/verify               ->  session cookie
GET  /me                                profile, roles, permissions, locale
GET  /reference/booking-constraints     quantity range
GET  /reference/crops                   crop dropdown
GET  /reference/centres?cropId=…        centre dropdown, filtered
```

`GET /me` replaces every `localStorage.farmerData` read. There is no client-side
source of truth left to consult.

---

## 12. Not implemented yet

Booking creation, slot availability, queue position, ETA, SMS, procurement and
payment. Those endpoints do not exist. `MyBooking`, `QueueStatus`, `Procurement`
and `Payment` have nothing to integrate against until Phases 8–11.
