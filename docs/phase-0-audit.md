# Mandi Sahayak — Phase 0: Full Repository Audit

**Phase:** 0 (Audit only — no code, no dependencies, no data)
**Date:** 2026-09-02
**Repository:** `mandi-sahayak` (branch `main`, commit `0889e3f`)
**Status:** Awaiting approval to proceed to Phase 1

---

## 1. Scope and method

**What was done:** every tracked file in the repository was read in full (30 tracked files),
`BACKEND_READINESS_AUDIT.txt` was read completely, `npm run lint` was executed to verify the
defects it reports, and translation-key parity was checked programmatically.

**What was NOT done (per instruction):** no file was created except this document, no existing
file was modified or deleted, no dependency was installed, no code was written, no government
website was accessed, no data was imported or invented.

---

## 2. Repository inventory (verified facts)

| Item | Value |
|---|---|
| Tracked files | 30 |
| Application source files | 14 (`src/`) |
| Backend directory | **Does not exist** |
| Test directory / test files | **Do not exist** |
| `docs/` directory | Did not exist before this document |
| Network layer (fetch / axios / react-query) | **None** — `grep` over `src/` returns zero matches |
| Environment variables (`import.meta.env`, `VITE_*`) | **None used anywhere** |
| `.env` / `.env.example` | Do not exist |
| CI configuration | Does not exist |
| Node / npm on this machine | v24.15.0 / 11.12.1 |

**Git history (2 commits):**

- `19944bb` — Initial Mandi Sahayak frontend (30 files, 7217 insertions)
- `0889e3f` — "todo backend" (adds `BACKEND_READINESS_AUDIT.txt`)

**Dependencies (`package.json`):** React 19, react-dom 19, react-router-dom 7, Tailwind CSS 4
(via `@tailwindcss/vite`), i18next 26 + react-i18next 17, Vite 8, ESLint 10.
There is **no** backend, database, validation, HTTP-client, testing or scheduling dependency.

**Scripts available:** `dev`, `build`, `lint`, `preview`. There is **no** `test` script.

**Unused assets:** `src/assets/hero.png`, `src/assets/react.svg`, `src/assets/vite.svg` and
`public/icons.svg` are referenced by no source file and not by `index.html`. Not a backend
concern; recorded for completeness.

---

## 3. Frontend functional inventory

The frontend is a **farmer-only prototype**. All 11 pages live in `src/pages/farmer/`.

### 3.1 Routes defined (`src/App.jsx`)

| Path | Component | Protected today | Notes |
|---|---|---|---|
| `/` | `Registration` | no | App entry point is the registration form |
| `/verify-otp` | `OTPVerification` | no | |
| `/login` | `Login` | no | |
| `/dashboard` | `Dashboard` | **no — unprotected** | |
| `/book-slot` | `BookSlot` | **no — unprotected** | |
| `/my-booking` | `MyBooking` | **no — unprotected** | |
| `/queue` | `QueueStatus` | **no — unprotected** | |
| `/procurement` | `Procurement` | **no — unprotected** | |
| `/payment` | `Payment` | **no — unprotected** | |
| `/notifications` | `Notifications` | **no — unprotected** | |
| `/profile` | `Profile` | **no — unprotected** | |

**Missing routes:** `/booking-confirmation` (navigated to from `BookSlot.jsx:73` but never
defined — the app dead-ends immediately after its primary conversion action) and a catch-all 404.
There is **no** `ProtectedRoute`, no auth context, and no session concept of any kind.

### 3.2 Page-by-page behaviour

**`Registration.jsx`** — Collects full name, 10-digit phone, **Aadhaar last 4 digits**, district,
village, **bank IFSC code**, and a consent checkbox. On submit it writes the whole object to
`localStorage.farmerData` and navigates to `/verify-otp`. No API call, no server validation, no
duplicate-phone check, no consent record. District and village lists are hardcoded in the component.

**`Login.jsx`** — The phone input is **uncontrolled and never read**. The button is
`type="button"` with `onClick={() => navigate("/verify-otp")}`. It performs no validation and
carries no state to the OTP screen, so that screen cannot know which number it is verifying.

**`OTPVerification.jsx`** — A 6-box OTP input with paste and backspace handling. "Verify &
Continue" is a plain `navigate("/dashboard")` — **it never reads the entered digits**; an empty
form navigates successfully. "Resend OTP" has **no `onClick` handler**. The masked number is the
literal string `+91 XXXXX XXXXX`. There is no timer, attempt counter, cooldown or error state.

**`Dashboard.jsx`** — Reads `farmerData` and `bookingData` from localStorage in a `useEffect`.
Renders a six-tile service grid (book slot, my booking, queue, procurement, payment,
notifications), a language toggle, a bottom nav, and a conditional "current booking" strip.

**`BookSlot.jsx`** — Four inputs: centre (hardcoded list), crop (hardcoded `<option>` elements),
quantity (number, `min="1"`, unit label **kg**), date (`min=today`, no upper bound), and a slot
list (hardcoded array of four fixed one-hour windows each with an `available` count). It shows a
review screen, then on confirm **generates the booking ID in the browser**
(`FQ-${Math.floor(1000 + Math.random() * 9000)}`), writes it to `localStorage.bookingData`, and
navigates to the non-existent `/booking-confirmation`.

**`MyBooking.jsx`** — Reads `bookingData` and `bookingHistory` from localStorage. Displays
`booking.bookingId` under the label **"Token Number"**. "Cancel Booking" runs entirely in the
browser: it pushes `{...booking, status: "Cancelled"}` into `bookingHistory` and deletes
`bookingData`. No deadline check, no reason captured, no audit. "Change Booking" navigates to
`/book-slot`, which will overwrite the existing booking on confirm.

**`QueueStatus.jsx`** — Queue values are a **hardcoded literal**:
`{ token: "FQ-0284", position: 18, farmersAhead: 17, estimatedWait: 35, status: "waiting" }`.
This token is unrelated to the booking ID shown on `MyBooking`. The four-step progress timeline is
static markup, not data-driven. "Refresh Status" calls `window.location.reload()`.

**`Procurement.jsx`** — Renders booking fields from localStorage against a **hardcoded three-step
stepper permanently frozen at step 1**. Arrival, weighing, grade, accepted/rejected quantity and
rate appear nowhere in the UI yet.

**`Payment.jsx`** — Always renders "Payment pending" / "Not available" with a static amber
"Pending" chip. Notably, the page's own copy states that the amount will come from the procurement
system. **No amount is fabricated here** — this is correct behaviour.

**`Notifications.jsx`** — Builds a **client-side derived array**: if `bookingData` exists it
synthesises exactly two notification cards. No persistence, no read/unread state, no timestamps,
no server events. It registers listeners for `storage` (cross-tab only) and for a custom
`bookingUpdated` event that **nothing in the codebase ever dispatches** — dead code.

**`Profile.jsx`** — Renders name, phone, district and village from localStorage. "Logout" is
`localStorage.removeItem(...)` on four keys (including `isLoggedIn`, a key **nothing ever writes**)
plus `navigate("/")`. There is no session to invalidate.

### 3.3 Internationalisation

`src/i18n.js` initialises i18next with `lng: "en"` hardcoded, no language detector and no
persistence — the language resets on every reload. The `en` and `hi` bundles contain **132 keys
with exact parity** (verified programmatically; no missing keys in either direction).
`Registration`, `Login` and `OTPVerification` contain **hardcoded English strings** and do not call
`useTranslation()` at all.

---

## 4. Authoritative-state inventory (what must move to the backend)

### 4.1 localStorage keys in use

| Key | Written by | Read by | Contents | Verdict |
|---|---|---|---|---|
| `farmerData` | `Registration.jsx:40` | Dashboard, Profile | name, phone, district, village, **aadhaarLast4**, **ifscCode** | **PII in browser storage — must move to DB** |
| `bookingData` | `BookSlot.jsx:68` | Dashboard, MyBooking, QueueStatus, Procurement, Payment, Notifications | bookingId, centre, crop, quantity, date, timeSlot, status | **Authoritative business state — must move to DB** |
| `bookingHistory` | `MyBooking.jsx:39` | MyBooking | array of cancelled bookings | **Must move to DB** |
| `notificationData` | *(never written)* | — | — | removed on logout only; dead key |
| `isLoggedIn` | *(never written)* | — | — | removed on logout only; dead key |

Every one of these is trivially editable from browser devtools. A farmer can today change their own
booking ID, quantity, status and history. **Nothing in this application is currently secure or
authoritative.**

### 4.2 Hardcoded / mock data

| Data | Location | Real? |
|---|---|---|
| Districts: Aligarh, Agra, Hathras, Mathura, Bulandshahr | `Registration.jsx:10-16` | Real UP district **names**, but unsourced and uncoded — replace with LGD-sourced master data |
| Villages (17 names across 5 districts) | `Registration.jsx:18-24` | **Unverified.** Must not be treated as authoritative; source from LGD |
| Centres: "Procurement Centre 1/2/3" | `BookSlot.jsx:18-22` | Placeholders. **No fake government centre names exist in the repo — good** |
| Crops: Wheat, Rice, Mustard, Maize, **Other** | `BookSlot.jsx:394-398` | Placeholder list; `"Other"` is not a procurable crop and can have no MSP |
| Slots: four fixed one-hour windows, `available` = 6/0/3/8 | `BookSlot.jsx:24-41` | Fully invented; conflicts with the required scheduling model (§6.2) |
| Booking ID `FQ-nnnn` | `BookSlot.jsx:59` | Client-generated random |
| Queue token `FQ-0284`, position 18, ahead 17, wait 35 min | `QueueStatus.jsx:11-17` | Fully invented |
| Procurement stepper state | `Procurement.jsx:206-236` | Static markup |
| Payment amount | `Payment.jsx` | **Not fabricated** — correctly shown as unavailable |
| MSP rate | — | **Appears nowhere in the frontend.** No fabricated MSP exists to remove |
| Storage capacity | — | **Appears nowhere in the frontend** |

**Important positive finding:** the prototype contains **no fabricated government data** — no MSP
values, no real centre names, no storage capacities, no government identifiers. There is nothing
false to retract. The backend starts from a clean provenance position.

---

## 5. Verification of `BACKEND_READINESS_AUDIT.txt`

The existing audit is broadly accurate. Verified against the code:

| Claim | Result |
|---|---|
| Lint fails with 6 errors from synchronous `setState` in effects | **CONFIRMED.** Exactly 6 `react-hooks/set-state-in-effect` errors — Dashboard, MyBooking, Payment, Procurement, Profile, QueueStatus |
| No network/API layer exists | **CONFIRMED** (zero fetch/axios matches) |
| `/booking-confirmation` route missing | **CONFIRMED** (`BookSlot.jsx:73` → route absent from `App.jsx`) |
| Login does not retain the mobile number | **CONFIRMED** (input is uncontrolled and unread) |
| OTP verification accepts any six digits | **UNDERSTATED.** It accepts **zero** digits — the verify button ignores the OTP state entirely |
| Resend OTP has no action | **CONFIRMED** (no handler) |
| `en` / `hi` have 132 matching keys each | **CONFIRMED** |
| Queue values fixed at FQ-0284 / 18 / 17 / 35 min | **CONFIRMED** |

**One correction to that document.** It states *"src/index.css and src/App.css — Both files are
empty"* and suggests removing them. This is **incorrect**: each file contains
`@import "tailwindcss";` (22 bytes), which is exactly what makes Tailwind 4 work.
**Deleting `src/index.css` would remove all styling from the application.**
(`src/App.css` *is* genuinely dead — it is imported by nothing — but it is not empty.)

The existing audit's entity list and minimum API contract are a reasonable farmer-scope starting
point, but they omit everything this project additionally requires: officers, admin, RBAC, MSP with
provenance, storage capacity/inventory, centre operating configuration, holiday calendars,
notification templates and delivery state, and data classification.

---

## 6. Conflicts between the current prototype and the required backend

These are the items where the frontend as written **cannot** be backed by a correct backend without
a decision. They are the most important output of this phase.

### 6.1 Quantity unit conflict — HIGH

- Required rule: **min 2500 kg, max 5000 kg** (25–50 quintal), enforced server-side.
- Current UI: `<input type="number" min="1">` labelled **kg**, helper text "Enter the approximate
  quantity".
- Consequence: the UI today invites values the backend must reject. A farmer typing `50` intending
  50 quintal is rejected for being below 2500 kg.
- Backend position: **kg is the canonical stored unit**; the API accepts and returns `quantityKg`
  only. Whether the input widget collects quintal and converts, or collects kg with a 2500–5000
  range, is a frontend decision that must be coordinated. See Q4.

### 6.2 Slot model conflict — HIGH (architectural)

- Current UI: a fixed list of **one-hour windows**, each with an integer `available` count
  ("6 slots available") — i.e. *N farmers share one fixed hour*.
- Required model: processing time is **proportional to quantity** (reference ≈ 25 Q → 1 h,
  50 Q → 2 h), bounded by configured min/max, plus a transition buffer, constrained by centre
  working hours, holidays, daily processing capacity and storage headroom.
- The two models are incompatible. A 50-quintal booking needs about two hours and cannot fit a
  one-hour bucket; and a per-slot "available count" has no meaning when each booking consumes a
  different amount of time.
- **Recommendation:** the backend exposes *time-based candidate windows* computed by the scheduling
  engine — `GET /slots?centreId&cropId&date&quantityKg` returning
  `[{ startTime, endTime, durationMinutes, available }]` — where each offered window is already
  sized for the requested quantity. This keeps the existing UI shape (a vertical list of selectable
  time windows) almost unchanged while making the backend correct; the `available: N` counter
  becomes a boolean or a label. Needs your confirmation — see Q3.

### 6.3 Booking ID vs token conflict — MEDIUM

`MyBooking.jsx` labels `booking.bookingId` as **"Token Number"**, while `QueueStatus.jsx` shows a
*different* value (`FQ-0284`) as the token. The backend will treat these as **two distinct
server-generated identifiers**: a `booking_id` (stable, unique for life) and a `token_number`
(per-centre, per-service-date, used for the physical queue). The UI must be aligned to that.

### 6.4 "Change Booking" semantics undefined — MEDIUM

The UI offers "Change Booking" → `/book-slot`, which would create a second booking and silently
overwrite the first. The backend must define this explicitly. Recommendation: **no in-place
amendment in v1**; "change" = cancel + create, each independently validated against policy and each
audited. Confirm at Q5.

### 6.5 Crop `"Other"` — LOW

`"Other"` cannot map to a crop master record, cannot have an MSP, and cannot have a centre
eligibility rule. The backend will reject it; the option should be removed or replaced by the real
list served from `GET /crops`.

### 6.6 Bank details are incomplete for payment — MEDIUM (policy)

Registration collects **IFSC only** — no account number, no account holder name. An IFSC alone
cannot receive a payment. Combined with `aadhaarLast4` (also insufficient on its own), the current
fields let the system *display* a payment status but never *execute* a transfer. This is a policy
decision, not a coding one — see Q6.

### 6.7 Booking horizon unbounded — LOW

The date input has `min={today}` and no maximum. The backend must enforce a configured booking
horizon per centre.

---

## 7. Role coverage

| Role | Frontend today | Backend requirement |
|---|---|---|
| **FARMER** | 11 pages, complete happy-path prototype | Full: auth, profile, reference data, booking, queue, procurement view, payment view, notifications |
| **OFFICER** | **CORRECTED 2026-09-02 — see note below.** No UI on `main`, but an unmerged branch has one. | Full backend required: search (token / booking / farmer / phone), arrival, weighing, quality and grade, accepted and rejected quantity, state progression, payment status update, centre queue, daily list — all audited |
| **ADMIN** | **No UI on either branch.** | Full backend and API required so a teammate can build the Admin UI later: user and officer management, centres, storage, MSP import, crops, slot configuration, notification templates, reports, audit logs |
| **SUPER_ADMIN** | n/a | **Not to be implemented** (per instruction), but the RBAC design must not make it hard to add later |

> **CORRECTION (2026-09-02, during Phase 4).** This audit examined only the
> `main` branch. The repository also contains an unmerged branch,
> `origin/faramqueue-feature` (commits `4e8ef4d`, `f1a0403`), holding an
> operator-side prototype of roughly 700 lines: `queue.jsx`, `ReportsPage.jsx`,
> `StoragePage.jsx`, `PaymentsPage.jsx`, `WeighmentPage.jsx`, plus a `Navbar`,
> a `Slot` component and a `useFaramqueueState` hook, on routes `/queue`,
> `/storage`, `/payments`, `/reports`. So an **officer** UI reference does exist;
> an admin one still does not. That branch shares the defects of `main`
> (localStorage as source of truth, no API layer, no authentication) and
> conflicts structurally with it. See `docs/phase-4-report.md` §3.

**Implication:** roughly two thirds of the required backend surface (officer + admin) has **no
frontend reference whatsoever**. That work must be driven by the business rules in the brief and by
explicit contract documents, not by reading UI components. This is a schedule risk (R-2) and also
confirms the instruction that the backend must not be shaped by the UI.

---

## 8. Government data requirements and known gaps

**No government source was accessed during Phase 0.** Nothing below is a verified fact about any
dataset's contents; it is a list of what must be verified, and where.

### 8.1 What the system needs, and at what granularity

| Need | Required granularity | Expected availability | Phase |
|---|---|---|---|
| MSP rate per crop | crop × season (RMS/KMS) × marketing year × grade/variety | Published nationally by the Government of India; expected to be obtainable | 3 |
| Crop master + season classification | crop level | Derivable from the official MSP publication itself | 3 |
| District / village master | district and village, with official codes | LGD (Local Government Directory) is the standard authority | 4 |
| Procurement centre list | centre level, with district / mandi linkage | **Uncertain.** State-run; availability varies by state | 4 |
| Mandi / market master | mandi level | Agmarknet / eNAM are candidate authorities | 4 |
| Storage facility + capacity | **facility level** (warehouse) | FCI / CWC / State Warehousing Corporations publish capacity, but **very likely at state or depot level, not per procurement centre** | 4 |
| Live storage occupancy | facility level, current | **Expected to be unavailable publicly.** Almost certainly an operational value | 4 |
| Centre working hours / holidays / processing rate | centre level | **Expected to be unavailable publicly.** Operational configuration | 4 |

### 8.2 Candidate sources to verify in Phases 3–4 — NOT YET VERIFIED

- Central Foodgrains Procurement Portal — `https://cfpp.nic.in/` (provided in the brief)
- Department of Agriculture & Farmers Welfare; CACP (MSP recommendations); official Cabinet / PIB
  MSP announcements
- Department of Food & Public Distribution; Food Corporation of India; Central Warehousing
  Corporation; State Warehousing Corporations (storage)
- Agmarknet / eNAM (market and mandi reference)
- Local Government Directory (district and village codes)
- `data.gov.in` (machine-readable mirrors of the above, where they exist)

For each, Phase 3/4 must record the exact source URL, dataset or document name, publication scope
(national / state / district / facility), season and marketing year, retrieval date, verification
date, and version — into the `data_sources` table, **before** any row is imported.

### 8.3 The gap I expect to have to report

Based on the granularity table above, I expect to find that **per-procurement-centre storage
capacity, live occupancy, working hours and processing rates are not published by any government
source**. If that proves true, the honest handling is:

- import what *is* published at its true scope (for example state- or depot-level capacity) and
  store it **at that scope**, never re-labelled as centre-level;
- expose the operational values as `CONFIGURED` records entered by an authorised admin, with the
  admin user and timestamp recorded;
- surface `dataType` (`OFFICIAL` / `CONFIGURED` / `TEST`) and source metadata on every API response
  that carries such a value, so the UI can label it and no judge is ever told that a configured
  operational number is government policy.

The actual finding, with evidence, will be reported in Phases 3 and 4 — not assumed now.

### 8.4 SMS constraint

Sending transactional SMS to Indian mobile numbers commercially requires DLT registration of the
sender and of every template under TRAI's commercial-communication regulations. That is a
procurement and paperwork lead-time item, not an engineering one. Phase 12 will ship a
`MockSmsProvider` (logging to the database and console) behind a provider interface, so the entire
notification pipeline is demonstrable and testable without it; a real provider can be dropped in via
environment configuration. Templates should be authored to be DLT-registerable from the start.

---

## 9. Risks

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | Government data unavailable at centre-level granularity | Storage and scheduling logic lose their factual base | Scope-preserving schema, `OFFICIAL`/`CONFIGURED`/`TEST` classification, provenance on every record; report the gap honestly (§8.3) |
| R-2 | Officer and admin surfaces have no UI reference at all | The largest part of the backend is spec-driven; risk of building the wrong contract | Write `/docs/api-contract.md` and `/docs/admin-api.md` **before** implementing Phases 10 and 14; review them with the teammate who will build the Admin UI |
| R-3 | Slot-model conflict (§6.2) left unresolved | Booking and queue engines get built twice | **Blocking for Phase 7.** Resolve at Q3 before Phase 7 starts; does not block Phases 1–6 |
| R-4 | Teammates editing the frontend concurrently | Merge conflicts, broken integration | Backend added in a separate top-level `server/` directory; frontend untouched until Phase 15; API versioned at `/api/v1` |
| R-5 | Concurrent bookings overbooking a centre | Core correctness failure, and a demo-visible one | PostgreSQL transactions with row-level locking on the capacity record; explicit concurrency test in Phase 8 |
| R-6 | PII (Aadhaar reference, bank details) handled without a defined policy | Legal and compliance exposure in a government-facing project | Q6 must be answered before Phase 2 finalises the `farmers` table; store the minimum, encrypt at rest, record consent, restrict staff read access |
| R-7 | Demo/test data mistaken for government data | Credibility failure in front of judges | `data_type` mandatory and non-null on every externally-sourced entity; always returned by the API; seeds are `TEST`-labelled and live in a separate, clearly named path |
| R-8 | SMS provider unavailable at demo time (§8.4) | Notification story undemonstrable | Provider abstraction plus `MockSmsProvider` from day one; notification records persisted and viewable regardless of delivery |
| R-9 | Scheduler double-run sends duplicate SMS | Farmer-visible defect | Idempotency key per (booking, event) enforced by a unique constraint in the database, not by application-level checking |
| R-10 | Frontend keeps 6 lint errors and has no tests | `npm run lint` gate fails; no regression safety | The backend gets its own test suite from Phase 2; the 6 frontend lint errors resolve naturally in Phase 15 when the localStorage effects are replaced by API calls |

---

## 10. Proposed backend architecture (outline — full design is the Phase 1 deliverable)

### 10.1 Repository layout — additive only

```
mandi-sahayak/
  src/              # existing frontend — UNTOUCHED until Phase 15
  server/           # NEW — the entire backend
    src/
      modules/      # auth, farmers, officers, admin, centres, crops, msp,
                    # storage, scheduling, bookings, queue, procurement,
                    # payments, notifications, audit, reference
      core/         # config, db, errors, logging, rbac, validation, http
      engines/      # scheduling-engine, queue-engine (single home for the formulas)
      jobs/         # reminder scheduler, queue recalculation, no-show sweep
      integrations/ # sms provider abstraction, msp importer, data importers
    migrations/
    seeds/          # TEST-labelled fixtures only, never mixed with OFFICIAL
    tests/
  docs/
```

Rationale: the frontend stays exactly where it is, so teammates editing the UI never conflict with
backend work, and no existing file has to move.

### 10.2 Stack recommendation

| Layer | Recommendation | Why |
|---|---|---|
| Runtime | **Node.js 20+ LTS with TypeScript** | Same language as the frontend team; static types matter for money, weights and state machines |
| Framework | **Express** (or Fastify) | Minimal, well understood, adequate at this scale |
| Database | **PostgreSQL 16** | Effectively non-negotiable here: real transactions, `SELECT … FOR UPDATE` / advisory locks to prevent overbooking, `CHECK` constraints for business invariants, partial unique indexes for notification idempotency |
| Migrations | **Plain SQL migrations** (Knex or node-pg-migrate) | The schema is the contract; explicit SQL keeps constraints visible and reviewable |
| Validation | **Zod** at every API boundary | One schema per endpoint; nothing enters the domain unvalidated |
| AuthN | OTP → **server session in an HttpOnly / Secure / SameSite cookie** | Simpler and safer than JWT for a browser client; revocable on logout |
| AuthZ | Role and permission tables, enforced by middleware **on every route** | Never inferred from anything the client sends |
| Scheduling | **DB-backed job table plus a single scheduler process** | No Redis dependency for the demo; idempotent by construction; Redis/BullMQ can be added later without changing call sites |
| SMS | `SmsProvider` interface; `MockSmsProvider` in development | Provider-specific code never enters business logic |
| Testing | **Vitest** + Supertest + a disposable test database | Same test-runner family as the Vite frontend |

**Alternatives considered:** Python + FastAPI + SQLAlchemy (equally capable; rejected only because
it adds a second language to a team already working in JS), and NestJS (good structure, but the
decorator and DI learning curve is a poor trade under SIH time pressure). If your team is stronger
in Python, say so at Q1 and I will re-cut the design — the schema and the business rules are
unchanged either way.

### 10.3 Layering rule

```
HTTP route → validation (Zod) → RBAC guard → service (business rules)
                                                  ↓
                                        engine (scheduling / queue)
                                                  ↓
                                      repository (SQL, transactions)
```

Controllers contain no business logic. **The processing-time formula, the slot-generation
algorithm, the queue and ETA computation, the MSP lookup and the payment calculation each exist in
exactly one place** and are called from everywhere else. No MSP value and no capacity value is ever
written as a literal in application code.

### 10.4 Cross-cutting invariants (design commitments)

1. Every externally-sourced record carries `data_type` (`OFFICIAL` | `CONFIGURED` | `TEST`) and,
   when `OFFICIAL`, a non-null `source_id` referencing `data_sources`.
2. Data scope is preserved: a state-level figure is stored as a state-level figure, permanently.
3. Storage capacity, daily processing capacity and time-slot capacity are **three separate
   concepts** with three separate models. None is derived from another by division.
4. All quantities are stored in **kilograms** (integer). Quintal is a presentation unit only.
5. All money is stored in **paise** (integer). No floating-point value ever holds a rupee amount.
6. All timestamps are stored in UTC; centre operating hours are stored as local wall-clock times
   plus the centre's IANA timezone.
7. Every state-changing officer or admin action writes an `audit_logs` row **in the same
   transaction** as the change itself.
8. Queue position and ETA are **derived** from authoritative booking and status data on read; they
   are never stored as the farmer's source of truth.
9. `/api/v1` prefix from the very first endpoint.

---

## 11. Proposed implementation order

The 18-phase order in the brief is sound and I propose following it as written, with three notes:

- **Phase 2 (schema)** must wait on the answer to **Q6** (PII / bank policy) — that answer changes
  the `farmers` table.
- **Phase 7 (scheduling)** must wait on the answer to **Q3** (slot model) — that answer changes the
  engine's public contract. Phases 1–6 are unblocked and can start immediately after approval.
- I propose adding a **written API-contract review at the end of Phase 6 and again before
  Phase 14**, so the teammate building the Admin UI has a stable contract to build against rather
  than discovering it late (mitigates R-2).

Everything else proceeds exactly as specified: one phase at a time, with a full report and a stop
after each.

---

## 12. Open questions

| # | Question | Needed by | My recommendation if you have no preference |
|---|---|---|---|
| **Q1** | **Stack:** Node + TypeScript + PostgreSQL, or Python + FastAPI + PostgreSQL? | **Phase 1** | Node + TypeScript — one language across the team |
| **Q2** | **Geographic scope:** which state and districts is this modelling? The prototype implies western Uttar Pradesh (Aligarh, Agra, Hathras, Mathura, Bulandshahr). Confirming this determines which state procurement and storage authority is the correct source. | Phase 3/4 | Confirm UP; keep the schema state-agnostic regardless |
| **Q3** | **Slot model:** adopt quantity-sized time windows generated by the engine (§6.2), or keep fixed hourly buckets with a per-bucket farmer count? | **Phase 7** | Quantity-sized windows — fixed buckets cannot represent a two-hour 50 Q booking |
| **Q4** | **Quantity input unit:** does the farmer type quintal (UI converts) or kilograms? The backend stores kg either way. | Phase 15 (affects API docs now) | API accepts `quantityKg`; the UI collects quintal and converts, since 25–50 quintal is how the rule is stated to farmers |
| **Q5** | **Change-booking policy:** cancel + rebook, or true in-place amendment? Also: what is the cancellation deadline, and is there a no-show or repeat-cancellation penalty? | Phase 8 | Cancel + rebook; cancellation allowed until a configured cutoff before the service window |
| **Q6** | **PII policy:** do we store Aadhaar last-4 at all? Do we need a full bank account number and holder name (IFSC alone cannot pay), or is disbursement out of scope so we track only payment *status*? What consent text and retention period apply? | **Phase 2** | Store the minimum: no Aadhaar digits unless a stated legal basis exists; track payment status only in v1, and hold any bank reference as an opaque encrypted field |
| **Q7** | **Booking rules:** one active booking per farmer at a time? Per crop? Per season? Any per-farmer seasonal quantity cap? | Phase 8 | One active booking per farmer per crop; no seasonal cap in v1 |
| **Q8** | **Officer accounts:** admin-created, or self-registered then approved? And do officers authenticate by OTP like farmers, or by username + password + 2FA? | Phase 5 | Admin-created, with a credential flow separate from farmers |
| **Q9** | **Demo mode:** you will need a working OTP flow on stage without live SMS. Confirm a `DEMO_MODE` flag, off by default, that surfaces the OTP **only in server logs or a protected dev endpoint** — never in an API response. | Phase 5 | As stated; never return an OTP in a response body, even in demo mode |

---

## 13. What was deliberately not done

- No code written, no dependency installed, no `package.json` change.
- No existing file modified or deleted — including the two frontend files I found to be
  mis-described in the existing audit (§5); I only reported the discrepancy.
- No government website accessed, no dataset downloaded, no MSP or storage value recorded anywhere.
- No fake, placeholder or illustrative government data created.
- No database, migration, seed or fixture created.

---

## 14. Phase 0 report

**PHASE:** 0 — Full repository audit

**STATUS:** COMPLETE — awaiting approval

**WHAT I INSPECTED:** all 30 tracked files, including all 11 frontend pages, `App.jsx`,
`main.jsx`, `i18n.js`, both locale bundles, `package.json`, `vite.config.js`, `eslint.config.js`,
`index.html`, `.gitignore`, `README.md`, both CSS files, the git history, and
`BACKEND_READINESS_AUDIT.txt` in full. Executed `npm run lint` and a translation-key parity check
to verify claims rather than repeat them.

**WHAT I IMPLEMENTED:** nothing. Audit only, as instructed.

**FILES CREATED:** `docs/phase-0-audit.md` (this file).

**FILES MODIFIED:** NONE.

**FILES DELETED:** NONE.

**DATABASE CHANGES:** NONE.

**API CHANGES:** NONE.

**BUSINESS RULES:** none implemented. Recorded for design: quantity 2500–5000 kg, canonical unit kg;
processing time proportional to quantity with configured min/max and a transition buffer; storage
capacity, daily processing capacity and slot capacity are three distinct concepts; MSP resolved by
crop × season × marketing year × grade × effective period; payment derived from accepted quantity
and applicable MSP subject to policy, never from client input.

**SECURITY CHANGES:** none implemented. Findings: no authentication exists; no route is protected;
all 11 routes are directly reachable; the OTP screen navigates to the dashboard without reading the
OTP at all; PII (name, phone, district, village, Aadhaar last 4, IFSC) is stored in browser
localStorage; all business state is user-editable from devtools.

**TESTS CREATED:** NONE (no test infrastructure exists in the repository).

**TEST RESULTS:** `npm run lint` → **6 errors, 0 warnings** (`react-hooks/set-state-in-effect` in
Dashboard, MyBooking, Payment, Procurement, Profile, QueueStatus), confirming the existing audit.
No test suite exists to run.

**REAL GOVERNMENT SOURCES USED:** NONE. No government source was accessed in this phase.

**SOURCE URLS:** none used. Candidate sources for Phases 3–4 are listed in §8.2 and are explicitly
marked as unverified.

**DATA IMPORTED:** NONE.

**DATA CLASSIFICATION:** not applicable — no data of any kind was created or imported. Confirmed
finding: the existing prototype contains **no fabricated government data** (no MSP values, no real
centre names, no storage capacities), so there is nothing false to retract.

**KNOWN LIMITATIONS:** two thirds of the required backend (officer and admin) has no frontend
reference and must be built from the written specification. The prototype's slot model (§6.2) and
quantity unit (§6.1) conflict with the required business rules and need decisions before Phases 7
and 15. Government data availability at centre-level granularity is unknown and unverified.

**UNRESOLVED QUESTIONS:** Q1–Q9 in §12. Only **Q1 (stack)** blocks Phase 1. Q6 blocks Phase 2.
Q3 blocks Phase 7.

**RISKS:** R-1 to R-10 in §9. Highest: R-1 (government data granularity), R-3 (slot-model
conflict), R-5 (concurrent overbooking), R-6 (PII policy undefined).

**NEXT PHASE:** Phase 1 — Backend architecture (`/docs/architecture.md`): stack, module boundaries,
API structure, authentication, RBAC model, full data model, external-data integration design,
scheduling engine, queue engine, notification architecture.

**STOP.** Awaiting `APPROVE PHASE 0`.
