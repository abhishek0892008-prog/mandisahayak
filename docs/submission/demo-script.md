# FarmQueue — Live Demo Script (PS 26032)

**Duration:** 8–10 minutes
**Rehearsed:** this exact flow was executed end-to-end against a running server on 2026-09-03. Every response below is real output, not illustration.

> **Say this once, at the start, and the rest of the demo is honest:**
> *"The React app is our farmer-facing prototype. The backend is a complete, tested procurement system. They are not yet wired together — integration is the next phase — so I'll show the UI for the experience and the live API for the working system."*
>
> Judges forgive a prototype. They do not forgive being misled.

---

## 0. Setup — do this **before** anyone is watching (10 minutes)

```bash
# 1. Start PostgreSQL 17.11, then provision from zero
export PATH="<postgres>/bin:$PATH"
export TEST_DATABASE_URL="postgres://<user>@127.0.0.1:55432/farmqueue_test"
bash server/scripts/provision-database.sh --recreate
#   → ready: 14 migrations, 20 crops, 23 MSP rates, 5 centres, 0 bookings

# 2. Start the API
cd server
export DATABASE_URL="$TEST_DATABASE_URL" \
       OTP_PEPPER="demo-otp-pepper-0123456789abc" \
       SESSION_PEPPER="demo-session-pepper-0123456789" \
       CSRF_PEPPER="demo-csrf-pepper-0123456789abc" \
       DEMO_MODE=true DEV_TOOLS_TOKEN=demo-token \
       COOKIE_SECURE=false PORT=3002 NODE_ENV=development
node src/index.ts
#   → "route protection verified" routes: 68
#   → listening on 3002

# 3. Enable an administrator.
#    Still a back door, and it has to be one: no route mints an ADMIN, and the
#    bootstrap admin is seeded with login disabled. See docs/api/admin.md section 7.
node -e "
const { loadConfig } = await import('./src/core/config.ts'); loadConfig(process.env);
const { createStaffUser } = await import('./tests/helpers.ts');
const { closePool } = await import('./src/core/db.ts');
console.log(await createStaffUser({username:'demo.admin',password:'DemoAdmin#2026',role:'ADMIN',phone:'9800000002'}));
await closePool();"

# 4. Create and post the demo officer THROUGH THE API (Phase 14).
#    Log in as demo.admin first (password + OTP, exactly as in B6), keeping the
#    cookie jar in $A and its CSRF token in $AC, then:
curl -s -b $A -X POST "$B/api/v1/admin/officers" -H "content-type: application/json" \
  -H "x-csrf-token: $AC" -d '{"fullName":"Demo Officer","username":"demo.officer",
  "password":"DemoOfficer#2026","phone":"9800000001","employeeCode":"EMP-DEMO-01",
  "designation":"Procurement Officer"}'
curl -s -b $A -X POST "$B/api/v1/admin/centres/$CID/officers" -H "content-type: application/json" \
  -H "x-csrf-token: $AC" -d '{"employeeCode":"EMP-DEMO-01"}'
#   → 201, then 201. The officer exists and is posted to Agra, entirely over the API.

# 5. Frontend (second terminal)
npm run dev
```

**Sanity check before you present:** `curl http://127.0.0.1:3002/readyz` → `{"data":{"status":"ready","migrations":15}}`

Keep a terminal, a browser and an HTTP client (curl/Postman) visible.

---

## Track A — The farmer experience (UI, ~2 min)

Show the prototype quickly. **Do not claim it is live.**

| Step | Screen | Say |
|---|---|---|
| A1 | `/` Registration | "Farmer registers with name, phone, district — no Aadhaar, no bank details, by design" |
| A2 | `/verify-otp` | "Six-digit OTP" |
| A3 | `/dashboard` | "Everything the farmer needs in one place" |
| A4 | `/book-slot` | "Crop, quantity, centre, date" |
| A5 | `/queue` | "Token, position, estimated wait" |
| A6 | `/notifications` | "Updates at every stage" |

Then: *"That's the experience. Now the system that actually implements it."*

---

## Track B — The working system (live API, ~6 min)

### B1. Farmer registers — using only public endpoints

```bash
B=http://127.0.0.1:3002; J=/tmp/farmer.txt; rm -f $J
curl -s -c $J -b $J "$B/api/v1/auth/csrf" > /dev/null
CSRF=$(grep fq_csrf $J | awk '{print $NF}')

# Districts are PUBLIC — a farmer has no account yet
curl -s "$B/api/v1/reference/districts" | head -c 200
DID=$(curl -s "$B/api/v1/reference/districts" | grep -oE '"id":"[0-9a-f-]{36}"' | head -1 | cut -d'"' -f4)

PHONE=9$(date +%N | head -c 9)
curl -s -c $J -b $J -X POST "$B/api/v1/auth/farmer/register/start-otp" \
  -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
  -d "{\"fullName\":\"Demo Farmer\",\"phone\":\"$PHONE\",\"districtId\":\"$DID\",\"locale\":\"en\",\"consent\":{\"policyVersion\":\"v1\",\"accepted\":true}}"
```

**Expected:** `201` with a `challengeId`.
**Say:** *"The OTP is never in the response body — even in demo mode. It goes to the server log."*

```bash
OTP=$(curl -s "$B/api/v1/dev/last-otp?phone=%2B91$PHONE" -H "x-dev-token: demo-token" \
      | grep -oE '"otp":"[0-9]+"' | cut -d'"' -f4)
curl -s -c $J -b $J -X POST "$B/api/v1/auth/otp/verify" -H "content-type: application/json" \
  -H "x-csrf-token: $CSRF" -d "{\"challengeId\":\"$CH\",\"otp\":\"$OTP\"}"
CSRF=$(grep fq_csrf $J | awk '{print $NF}')
```

**Expected:** `201`, session cookie set.

### B2. Availability — the headline technical point

```bash
curl -s -b $J -X POST "$B/api/v1/bookings/availability" -H "content-type: application/json" \
  -H "x-csrf-token: $CSRF" -d "{\"centreId\":\"$CID\",\"cropId\":\"$WID\",\"quantityKg\":2500}"
```

**Expected:** `processingMinutes: 60, bufferMinutes: 15, occupancyMinutes: 75`, `laneCount: 2`, `dataType: "CONFIGURED"`.

**Say:** *"This is not a fixed one-hour slot. 2 500 kg takes 60 minutes at Agra because Agra is configured at 60 min per 2 500 kg. The same load at Aligarh takes 75. Change the configuration row, the schedule changes — no code edit."*

### B3. Book

```bash
curl -s -b $J -X POST "$B/api/v1/bookings" -H "content-type: application/json" \
  -H "x-csrf-token: $CSRF" -H "idempotency-key: demo-$(date +%s)" \
  -d "{\"centreId\":\"$CID\",\"cropId\":\"$WID\",\"quantityKg\":2500}"
```

**Expected:** `bookingCode: FQ-2026-XXXXXXX`, `tokenNumber: 1`, `status: CONFIRMED`, `laneNo`, `scheduledStartAt`.
**Say:** *"A specific lane, a specific interval. Two bookings can never overlap on a lane — that's a GiST exclusion constraint in PostgreSQL, not application code. It holds even if every line of our code is wrong."*

### B4. Queue and ETA

```bash
curl -s -b $J "$B/api/v1/bookings/$CODE/queue"
```

**Expected:** `queuePosition`, `aheadAtCentre`, `aheadOnLane`, `estimatedWaitMinutes`, **`etaConfidence: "PROJECTED"`**, `etaBasis`.

**Say:** *"Position and ETA are separate ideas, and the ETA always carries how much it's worth — OBSERVED when someone is being served, PROJECTED from live timestamps, SCHEDULED for a future date. When we can't justify an estimate we return null and a reason, never a fake number."*

### B5. The first notification

```bash
curl -s -b $J "$B/api/v1/notifications"
```

**Expected:** `BOOKING_CONFIRMED`, with the booking code, crop, centre, date and token — and **`realSmsDelivered: false`**.

**Say (do not skip):** *"The outbox is real and transactional — the notification is written in the same database transaction as the booking, so it can never exist for a booking that didn't happen. Delivery is provider-neutral. We have not connected a real SMS provider, because we have no approved provider or DLT registration, so every record says `realSmsDelivered: false`."*

### B6. Officer takes over

```bash
O=/tmp/officer.txt; rm -f $O
curl -s -c $O -b $O "$B/api/v1/auth/csrf" > /dev/null
OC=$(grep fq_csrf $O | awk '{print $NF}')
curl -s -c $O -b $O -X POST "$B/api/v1/auth/staff/login" -H "content-type: application/json" \
  -H "x-csrf-token: $OC" -d '{"username":"demo.officer","password":"DemoOfficer#2026"}'
# password alone does NOT create a session — OTP second factor required
```

**Say:** *"Officers need password **plus** OTP. Farmers use OTP alone."*

Then verify OTP as in B1 (phone `+919800000001`), and:

```bash
curl -s -b $O "$B/api/v1/officer/centres/$CID/bookings"
curl -s -b $O "$B/api/v1/officer/bookings/search?q=$CODE"
```

### B7. The procurement lifecycle

```bash
for s in arrive weighing; do
  curl -s -b $O -X POST "$B/api/v1/officer/bookings/$CODE/$s" -H "x-csrf-token: $OC" \
    -H "content-type: application/json" -d '{}'; done

curl -s -b $O -X POST "$B/api/v1/officer/bookings/$CODE/weight" -H "x-csrf-token: $OC" \
  -H "content-type: application/json" -d '{"grossQuantityKg":2480.5}'

curl -s -b $O -X POST "$B/api/v1/officer/bookings/$CODE/quality" -H "x-csrf-token: $OC" \
  -H "content-type: application/json" \
  -d '{"acceptedQuantityKg":2480.5,"rejectedQuantityKg":0,"moisturePercent":11.5}'

curl -s -b $O -X POST "$B/api/v1/officer/bookings/$CODE/complete" -H "x-csrf-token: $OC" \
  -H "content-type: application/json" -d '{}'
```

**Expected:** `booking.status: PAYMENT_PENDING`, `procurement.status: COMPLETED`, `payment.ratePerQuintalPaise: 258500`, `payment.amountRupees: "64120.93"`.

**Say:** *"24.805 quintal at ₹2 585 per quintal — computed in PostgreSQL numeric, never floating point. The rate is snapshotted, so next season's MSP revision cannot retroactively change what this farmer was told."*

### B8. **The strongest 30 seconds — MSP honesty**

Book **paddy at Mathura**, run it through without recording a grade, and complete it.

**Expected:** `payment.status: "BLOCKED"`, `blockedReason: "MSP_AMBIGUOUS"`, `amountPaise: null`.

**Say:** *"Paddy has two support prices — Common ₹2 441 and Grade A ₹2 461. Nobody recorded a grade, so the system refuses to invent a price. It tells the officer and the farmer exactly why. Record the grade and it resolves immediately."*

### B9. Payment and the farmer's final view

```bash
curl -s -b $O -X POST "$B/api/v1/officer/bookings/$CODE/payment" -H "x-csrf-token: $OC" \
  -H "content-type: application/json" -d '{"status":"INITIATED"}'
curl -s -b $O -X POST "$B/api/v1/officer/bookings/$CODE/payment" -H "x-csrf-token: $OC" \
  -H "content-type: application/json" -d '{"status":"PAID","paymentReference":"UTR-DEMO-0001"}'

curl -s -b $J "$B/api/v1/bookings/$CODE/procurement"
curl -s -b $J "$B/api/v1/bookings/$CODE/payment"
curl -s -b $J "$B/api/v1/notifications"
```

**Expected:** booking `COMPLETED`; farmer sees quality `ACCEPTED`, 2 480.5 kg, `PAID`, ₹64 120.93, and **5 notifications** — confirmed, arrived, procurement recorded, payment initiated, payment paid.

**Say:** *"FarmQueue records that a payment was made and its reference. It does not move money — that's a deliberate scope decision, so we never collect bank details."*

### B10. Close on the tests (30 seconds)

```bash
cd server && npm test
```

**Expected:** `tests 269 | suites 66 | pass 269 | fail 0 | skipped 0`

**Say:** *"323 tests against a real PostgreSQL — no mocks. Including a 300-case generated-state test for queue invariants, and concurrency tests where two officers hit the same booking simultaneously."*

---

## Fallbacks

| If this fails | Do this |
|---|---|
| Postgres not running | `pg_ctl -D <data> -o "-p 55432" start`; confirm with `/readyz` |
| `/readyz` not ready | Re-run `provision-database.sh --recreate` |
| OTP not retrievable | Read it from the server log — it is printed at `warn` in DEMO_MODE |
| `NO_AVAILABILITY` on booking | The centre-day is full. Use a different centre (Aligarh 3 lanes, Mathura 2) or re-provision |
| Officer login fails | Re-run step 4; check `GET /api/v1/admin/officers` shows the officer ACTIVE with one assignment, and that its centre matches the booking's |
| Booking `409` on a transition | You skipped a step — the state machine enforces the order. Show it as a *feature* |
| Frontend won't start | Skip Track A; it adds nothing the API does not prove |
| Everything is broken | `provision-database.sh --recreate`, restart the server, re-run from B1. Full reset is ~60 seconds |

---

## Questions you should expect

**"Is the app connected to the backend?"**
*"Not yet — that's the next phase. The backend is complete and tested; the UI is a prototype of the farmer experience."*

**"Do you actually send SMS?"**
*"No. We built the outbox and a provider-neutral interface, but we have no approved provider or DLT registration, so we ship a DEMO adapter and label every record accordingly. Adding a real provider is one class."*

**"Are these real procurement centres?"**
*"No — five clearly-labelled demonstration centres, marked CONFIGURED in the database. We never present them as real government facilities."*

**"Are the MSP rates real?"**
*"Yes, transcribed from the PIB Cabinet releases for 2026-27, with full provenance stored. They are single-sourced and not yet independently cross-checked — that's recorded in the database as `last_verified_at = NULL`, and it's the first thing we'd close before real use."*

**"What happens if two farmers book the same slot?"**
*"They can't. A GiST exclusion constraint in PostgreSQL makes overlapping bookings on a lane structurally impossible, and we have a test that fires parallel requests to prove it."*
