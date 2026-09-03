# FarmQueue — Phase 6: Frontend Expectation vs Backend Authoritative Model

**Date:** 2026-09-02
**Method:** re-read of `main`'s eleven farmer pages and the locale bundles, plus a
read-only inspection of the unmerged `origin/faramqueue-feature` officer branch.
**Neither frontend was modified.**

> This document exists to make every divergence explicit *before* integration, so
> the frontend team changes what it must and nothing it needn't. Where the two
> disagree, the backend is authoritative — but every divergence below is a
> deliberate decision with a reason, not an accident.

---

## 1. Summary of divergences

| # | Area | Severity | Frontend must change? |
|---|---|---|---|
| D1 | Aadhaar last-4 and bank IFSC collected | **High** | Yes — remove both fields |
| D2 | Quantity unit and range | **High** | Yes — range and unit |
| D3 | Crops are display strings, and "Rice" ≠ official "Paddy" | **High** | Yes — use ids from the API |
| D4 | `"Other"` crop option | **High** | Yes — remove |
| D5 | District/village are free-text names | **High** | Yes — use ids from the API |
| D6 | Profile field names are inconsistent | Medium | Yes — one canonical shape |
| D7 | Booking/queue/token shapes invented client-side | Medium | Deferred to Phase 8/9 |
| D8 | Officer branch uses a third unit convention and its own statuses | Medium | Reference only |
| D9 | Language preference not persisted | Low | Optional |
| D10 | Registration/login/OTP screens not translated | Low | Frontend-only |

---

## 2. Registration

### FRONTEND EXPECTATION — `src/pages/farmer/Registration.jsx`

Seven form fields, written to `localStorage.farmerData`:

```
fullName · phone · aadhaarLast4 · district · village · ifscCode · consent
```

`district` and `village` are **hardcoded display strings** (`Aligarh`,
`Jamalpur`, …) chosen from in-component arrays.

### BACKEND AUTHORITATIVE MODEL

```jsonc
POST /api/v1/auth/farmer/register/start-otp
{
  "fullName": "Ramesh Kumar",
  "phone": "9876543210",
  "districtId": "<uuid>",
  "villageId": "<uuid>",          // optional; must belong to districtId
  "locale": "en",
  "consent": { "policyVersion": "v1", "accepted": true }
}
```

**D1 — Aadhaar and IFSC are gone.** Decisions D-6/D-7. Four Aadhaar digits verify
nothing (10⁴ space, nothing to check them against) and an IFSC without an account
number cannot receive a payment. There is **no column** for either; a Phase 5 test
asserts none exists anywhere in the schema. Sending them is ignored.

**D5 — geography is by id, not name.** Free-text names cannot be joined,
deduplicated, or mapped to a procurement centre. The frontend must populate its
dropdowns from `GET /reference/districts` and `GET /reference/villages`.

**Note on the current village lists:** the 17 village names hardcoded in the
prototype are unverified and are **not** in the database. `villages` is empty —
LGD village data was not retrievable (Phase 4). So the village dropdown will be
empty until that is resolved, and `villageId` is optional precisely for that
reason. **Do not fall back to the hardcoded list.**

**Consent** becomes a real record: two `consents` rows with the policy version and
a hash of the exact text shown, not a transient checkbox.

---

## 3. OTP

### FRONTEND EXPECTATION — `src/pages/farmer/OTPVerification.jsx`

Six input boxes. "Verify & Continue" calls `navigate("/dashboard")` **without
reading the entered digits**. "Resend OTP" has no handler. The masked number is
the literal string `+91 XXXXX XXXXX`.

### BACKEND AUTHORITATIVE MODEL

Six digits is correct and is retained — `otpLength: 6` is returned by the
challenge response so the UI need not hardcode it.

Everything else changes: a session is issued **only** on a `201` from
`POST /auth/otp/verify`. Five attempts, five-minute expiry, 60-second resend
cooldown, three resends, one-time use. Every failure returns the same
`400 OTP_INVALID` — the screen should show one message and offer resend, and must
not branch on the reason (there deliberately isn't one).

The real masked number comes from the backend; the frontend should display what
the user typed rather than a placeholder.

---

## 4. Quantity — three conventions, none agreeing

### FRONTEND EXPECTATION

| Source | What it says |
|---|---|
| `BookSlot.jsx` | `<input type="number" min="1">`, labelled **kg**, helper text "Enter the approximate quantity" |
| `en/translation.json` | only a `"kg"` key exists — there is **no** quintal key |
| Officer branch `useFaramqueueState.js` | bare numbers `210`, `180`, `95` with **no unit label at all** |

Those officer figures cannot be kg (95 kg is implausible for procurement) and
cannot be quintal within our rule (95 quintal = 9 500 kg, above the maximum). The
officer prototype is using a third, undocumented convention.

### BACKEND AUTHORITATIVE MODEL

```
canonical unit  : kilograms, integer
business rule   : 2500 ≤ quantityKg ≤ 5000
equivalently    : 25 to 50 quintal, at 1 quintal = 100 kg
```

Enforced by `bookings_quantity_within_business_rule` — a database `CHECK`, not
merely application validation. Phase 2 probe B2 proves 2 499 and 5 001 are
rejected by PostgreSQL itself.

**The frontend's unit representation cannot change the database invariant.** If
the UI collects quintal it must convert before sending, and the wire field is
always `quantityKg`. `GET /reference/booking-constraints` returns the range so
the numbers are never hardcoded in a component.

**Frontend work required:** change `min="1"` to the real range, decide kg or
quintal, and if quintal, add the i18n key (there isn't one).

---

## 5. Crops

### FRONTEND EXPECTATION — `BookSlot.jsx`

```jsx
<option value="Wheat">   <option value="Rice">    <option value="Mustard">
<option value="Maize">   <option value="Other">
```

Values are **English display strings**, submitted as-is.

### BACKEND AUTHORITATIVE MODEL

Crops are rows imported from the official MSP publications (Phase 3), addressed
by `id`:

| Frontend value | Backend | Note |
|---|---|---|
| `Wheat` | `WHEAT` — Wheat, **RMS** 2026-27 | matches |
| `Rice` | **`PADDY`** — Paddy, **KMS** 2026-27 | **naming mismatch.** The Government of India publishes MSP for *Paddy*, and does so per variety (Common / Grade A). "Rice" is the milled product |
| `Mustard` | `RAPESEED_MUSTARD` — "Rapeseed & Mustard", RMS | official name differs |
| `Maize` | `MAIZE` — Maize, KMS | matches |
| `Other` | **no equivalent, and never will be** | D4 |

**D4 — `"Other"` must be removed.** It cannot map to a crop record, cannot carry
an MSP, and cannot have a centre eligibility rule. A booking for "Other" could
never be priced.

**D3 — send `cropId`, render `canonicalName`.** `GET /reference/crops` returns
id, code, canonical name, season and marketing year. Do not translate crop names
in the frontend bundle: the canonical name is the government's own wording and
changing it would misrepresent the source.

---

## 6. Profile

### FRONTEND EXPECTATION — `Profile.jsx`, `Dashboard.jsx`

Reads, with fallbacks, whichever of these happens to exist:

```
farmer?.fullName ?? farmer?.name
farmer?.mobile ?? farmer?.phone ?? farmer?.mobileNumber
farmer?.district      farmer?.village
```

Three different names for the phone and two for the name — a symptom of
localStorage having no schema.

### BACKEND AUTHORITATIVE MODEL — `GET /api/v1/me`

One canonical shape. `fullName`, `phoneMasked`, `locale`, `status`, `roles`,
`permissions`, `district {id,name}`, `village {id,name} | null`, `centreIds`.

**The full phone is never returned** — only `phoneMasked` (`***10`). The user
already knows their own number; the API does not need to echo it, and not
returning it removes a whole class of accidental leakage into logs and screenshots.

**D6:** the frontend should read exactly these names and drop the fallbacks.

---

## 7. Dashboard and booking display

### FRONTEND EXPECTATION

`Dashboard.jsx` reads `booking.crop`, `booking.quantity`, `booking.date`,
`booking.timeSlot`. `MyBooking.jsx` shows `booking.bookingId` under the label
**"Token Number"**. `QueueStatus.jsx` hardcodes `FQ-0284`, position 18, 17 ahead,
35 minutes.

### BACKEND AUTHORITATIVE MODEL

**Not implemented in Phase 6** — booking is Phase 8, queue is Phase 9. Recorded
here so the frontend team is not surprised:

- `bookingCode` and `tokenNumber` are **two different server-generated values**.
  The prototype conflates them.
- Queue position, farmers-ahead and ETA are **derived on read**, never stored,
  and will arrive from `GET /bookings/:id/queue` with a server-supplied
  `pollAfterSeconds`.
- The client-side `FQ-${random}` generator must go.

---

## 8. Officer branch — reference only

`origin/faramqueue-feature` (unmerged) models a farmer as
`{ id, name, phone, slot, crop, quantity, token, status }` with statuses
`"Queued"` / `"Verified"`, plus `actualWeight`, `paidAmount`, `paymentStatus`.

**D8 — divergences to reconcile in Phases 9–11:**

- Its statuses (`Queued`, `Verified`) are not the canonical nine
  (`CONFIRMED`, `ARRIVED`, `WEIGHING`, `QUALITY_CHECK`, `PROCUREMENT_RECORDED`,
  `PAYMENT_PENDING`, `COMPLETED`, `CANCELLED`, `NO_SHOW`).
- It exposes a farmer's full phone in an operator list; the backend returns a
  **minimised officer projection** with a masked phone.
- `quantity` uses the third unit convention noted in §4.
- `paidAmount` is a client-held number; payment is backend-authoritative and may
  legitimately be `BLOCKED` with `NO_ACTIVE_MSP`.

**This branch is still unmerged and conflicts structurally with `main`** (its own
`App.jsx`, `index.css`, `package.json`). That should be resolved before Phase 15.

---

## 9. i18n

**D9:** `src/i18n.js` hardcodes `lng: "en"` with no detector and no persistence —
language resets on reload. The backend stores `users.locale` and returns it from
`GET /me`, and `PATCH /me` accepts `locale`, so the preference can now survive
properly. Language is also the one legitimate use of `localStorage`.

**D10:** `Registration`, `Login` and `OTPVerification` contain hardcoded English
and never call `useTranslation()`. Frontend-only work.

**Error text:** the API returns `error.code` and per-field codes such as
`PHONE_INVALID_INDIAN_MOBILE`. The frontend translates them. Never render
`error.message` — it is English, for developers.

---

## 10. What the frontend keeps unchanged

Layout, navigation, the six-tile dashboard, the OTP box UX, the review-before-confirm
step, the language toggle, all styling. The backend was shaped to serve this UI, not
to replace it. The required changes are field names, identifiers, units and the
removal of client-side authority — not a redesign.
