# FarmQueue — Limitations, Data Provenance & Honest Claims

**Date:** 2026-09-03

This document exists so that nothing in the submission or the demo is over-claimed. Every item here is a deliberate, recorded decision — not an accident discovered late.

---

## 1. Data classification

FarmQueue enforces a three-way distinction in the database itself (`data_type` columns and `data_sources` provenance).

| Entity | Example | Classification | Safe to show? | Notes |
|---|---|---|---|---|
| MSP rates | Wheat RMS 2026-27 — ₹2 585.00/quintal | **OFFICIAL** | **Yes, with the caveat below** | 23 rates from two PIB Cabinet releases. Full provenance stored. **`last_verified_at IS NULL` — single-sourced, not independently cross-checked** |
| MSP grade variants | Paddy Common ₹2 441 / Grade A ₹2 461 | **OFFICIAL** | Yes | Drives the `MSP_AMBIGUOUS` demonstration |
| Procurement centres | `DEMO-UP-AGRA-01` "Agra Demonstration Procurement Centre" | **CONFIGURED** | **Yes — always call them demonstration centres** | 5 centres. `data_type = 'CONFIGURED'` in the database. **Not real government facilities** |
| Lanes / hours / holidays | Agra 2 lanes, 08:00–18:00; Hathras 1 lane, 09:00–17:00 | **CONFIGURED** | Yes | Demonstration operating configuration |
| Slot configuration | Agra 60 min per 2 500 kg; Aligarh 75 min | **CONFIGURED** | Yes | The point of the demo: behaviour follows configuration |
| Districts / villages | Agra, Mathura, Aligarh, Hathras, Bulandshahr | **CONFIGURED** | Yes | Western UP demonstration geography. Only the **state** LGD code (UP = 9) was obtainable |
| District LGD codes | — | **UNAVAILABLE** | n/a | Require CAPTCHA or a registered API key. **Not circumvented, not invented** |
| Storage capacity | — | **ADVISORY / none** | n/a | **No centre storage capacity exists.** Never derived from national or state figures (decision D-10) |
| Farmers, bookings, officers | "Demo Farmer", `demo.officer` | **TEST** | Yes | Created by the demo/test runs only |
| Payment amounts | ₹64 120.93 | **Computed** | Yes | Derived from OFFICIAL MSP × recorded quantity. **No money moves** |
| SMS delivery records | `DEMO-<id>` | **DEMO** | **Yes — say DEMO out loud** | No real message is ever sent |

**Rules we do not break:** no government data is invented; no demonstration centre is presented as a real government centre; no centre capacity is inferred from national/state statistics; no fabricated government IDs or statistics exist anywhere in the repository.

---

## 2. Notification status — the exact wording

> **FarmQueue implements a transactional, provider-neutral notification/outbox architecture with a DEMO delivery adapter. Real SMS provider integration is not configured.**

| | Reality |
|---|---|
| Outbox | **Real.** Written in the same transaction as the business change; a notification cannot exist for an event that did not happen |
| Deduplication | **Real.** A `UNIQUE` constraint on `dedupe_key`, not an application check |
| Per-locale rendering | **Real.** en / hi from `users.locale` |
| Provider interface | **Real.** `NotificationProvider` — a real provider drops in with no contract change |
| Delivery | **DEMO only.** No network call. Provider ids are prefixed `DEMO-`. Every API response carries `realSmsDelivered: false` |
| Why not real | No approved provider, no credentials, no sender ID, **no TRAI DLT template registration** — which cannot be fabricated |
| Channel | `IN_APP` only. No SMS row is created, because that would assert a delivery path that does not exist |

**The UI contains no "SMS sent" claim** — verified by search across `src/`.

---

## 3. Payment status — what is and is not claimed

FarmQueue **tracks payment status. It does not disburse money** (decision D-7).

- No bank details are collected — deliberately, so the project never holds them.
- `PAID` means an officer recorded a payment reference (e.g. a UTR) from an external system.
- No payment gateway, no banking integration, no disbursal.

**Say "the payment is recorded as paid", never "the farmer has been paid".**

---

## 4. Frontend limitations

| | Status |
|---|---|
| Farmer prototype (12 screens, en/hi) | Builds and runs |
| **Connected to the backend** | **NO.** Zero API calls; every screen uses `localStorage`. Integration is the next phase (`architecture.md:124`) |
| **Officer UI** | **Does not exist.** Officer operations are API-only (known since Phase 0 as R-2) |
| Route protection | Frontend has no `ProtectedRoute`; the backend enforces authorization regardless |
| Crop vocabulary | Frontend uses `rice`/`mustard`; backend canonical codes are `PADDY`/`RAPESEED_MUSTARD`. Latent until integration |
| Lint | 16 problems (14 errors), all `react-hooks/set-state-in-effect`. **`npm run build` passes** |

---

## 5. Functional limitations

1. **`APPROACHING` status and `QUEUE_APPROACHING` notifications never fire.** Architecture defines them against a configured threshold; no threshold exists in the schema and none has been approved. We do not invent one.
2. **No no-show sweep job.** A farmer who never arrives stays `CONFIRMED` until an officer marks it.
3. **No correction path** once quality is recorded — the state machine has no reverse edge. Correcting a closed record is an administrative act that was never specified.
4. **`deductions_paise` is always 0.** No deduction policy (mandi fee, commission, transport) is configured.
5. **State bonuses are not researched.** National MSP may not be the final payable rate; the system reports the recorded amount without claiming otherwise.
6. **A `BLOCKED` payment strands its booking** in `PAYMENT_PENDING` until the MSP situation is resolved.
7. **No password change or reset for staff, by anyone.** Officers are provisioned through the API (Phase 14), but an officer’s password is whatever the administrator set at creation: there is no self-service change endpoint and no admin reset endpoint. Adding either is a product decision that has not been taken.
8. **No admin provisioning.** `POST /admin/officers` creates officers only. The bootstrap administrator is seeded by SQL with login disabled, and no route mints a second admin — so enabling an administrator still means writing to the database.
9. **No notification dispatch worker.** `dispatchPending()` is called explicitly.
10. **No storage capacity checking.** All centres are `ADVISORY` with no linked facility.
11. **Performance is unmeasured under load.** Query plans were inspected; no load test was run.
12. **Integration tests require a freshly provisioned database.** They book real windows and are not self-cleaning — a second `npm test` against the same database reports `NO_AVAILABILITY`, not a scheduling defect. Run `provision-database.sh --recreate` first, every time.

---

## 6. The most important caveat

**The 23 MSP rates are single-sourced and independently unverified** (`last_verified_at IS NULL` on both PIB sources). They now drive computed payment amounts *and* are communicated to farmers through notifications.

**Recommendation, unchanged and unmet:** cross-check all 23 rates against a second official source (the DES MSP statement at `desagri.gov.in`) before any real deployment, and do not enable a real SMS channel for payment amounts until that is done — an SMS is pushed, quoted later and hard to retract.

We have not marked them verified to make the demo look better. The NULL is the honest state.

---

## 7. Future work, in the order we would do it

1. Cross-check MSP against a second official source; set `verified_at`.
2. Wire the frontend to the API (Phase 15) and add `ProtectedRoute`.
3. Build the officer UI.
4. Staff password change and reset; admin provisioning.
5. Decide and configure the `APPROACHING` thresholds.
6. Notification dispatch worker + quiet hours, daily caps, retention.
7. Real SMS provider + DLT template registration.
8. No-show sweep job; correction/adjustment path for closed records.
9. Load testing at realistic volume.
10. Offline behaviour, reports and analytics.
