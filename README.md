# FarmQueue

**Smart India Hackathon — PS 26032**

> *"Farmers often face long waiting times, lack of information regarding procurement schedules and uncertainty about procurement status."*

FarmQueue is a slot-booking and queue-management system for agricultural procurement centres. A farmer books a time window sized to the quantity they are actually bringing, sees where they are in the queue, and can follow their produce from arrival through weighing, quality assessment, MSP-based pricing and payment status — without standing in a line to find out.

---

## What exists today

| Capability | Status |
|---|---|
| Farmer registration (OTP), sessions, RBAC | Complete, API |
| Slot booking — quantity-sized windows on lanes | Complete, API |
| Real-time queue position and ETA | Complete, API |
| Officer procurement lifecycle (arrive → weigh → quality → complete) | Complete, API |
| MSP resolution and payment calculation | Complete, API |
| Payment status tracking | Complete, API |
| Notification outbox + farmer feed (en/hi) | Complete, API |
| Farmer web prototype (12 screens, en/hi) | Builds — **not yet connected to the API** |
| Officer UI | **Not built** |
| Real SMS delivery | **Not configured** — DEMO adapter only |
| Payment disbursal | **Out of scope by design** — status tracking only |

**269 tests · 66 suites · 0 failures · 50 SQL verification probes · 44 permission-declared routes · PostgreSQL 17.11**

---

## Quick start

```bash
# Backend
export DATABASE_URL="postgres://<user>@<host>:<port>/farmqueue"
bash server/scripts/provision-database.sh --recreate   # 14 migrations from zero
cd server && npm install && npm start

# Tests
npm test              # 269 tests over real HTTP against real PostgreSQL — nothing mocked
npm run typecheck
npm run static-check

# Frontend prototype
npm install && npm run dev
```

Requires Node ≥ 22.18 and PostgreSQL 17.

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/submission/PS-26032-mapping.md`](docs/submission/PS-26032-mapping.md) | Requirement → implementation → API → schema → test |
| [`docs/submission/demo-script.md`](docs/submission/demo-script.md) | Rehearsed 8–10 minute live demonstration |
| [`docs/submission/architecture.md`](docs/submission/architecture.md) | System diagram and the five ideas that matter |
| [`docs/submission/limitations.md`](docs/submission/limitations.md) | **Data provenance and every honest caveat** |
| [`docs/submission/final-readiness-audit.md`](docs/submission/final-readiness-audit.md) | Final audit and findings |
| [`docs/architecture.md`](docs/architecture.md) | Full design contract (§1–§25) |
| `docs/api/*.md` | Endpoint contracts |
| `docs/phase-*-report.md` | Phase-by-phase build record |

---

## Design principles

1. **Capacity is time on a lane, not a bucket.** 5 000 kg takes twice as long as 2 500 kg, and the schedule reflects that. A GiST exclusion constraint makes overlapping bookings on a lane structurally impossible.
2. **Queue position and ETA are derived, never stored.** Nothing can go stale because nothing is cached.
3. **The system refuses to invent numbers.** An ETA carries its confidence; an unpriceable payment returns a reason instead of an amount; an unconfigured threshold means a feature stays off.
4. **Money is computed in PostgreSQL `numeric`**, stored as integer paise, with the MSP rate snapshotted at the moment of computation.
5. **The database enforces the business.** The booking lifecycle is table-driven and trigger-enforced; the audit log is append-only; duplicate notifications are prevented by a constraint.

---

## Honest claims

- The five procurement centres are **CONFIGURED demonstration data**, not real government facilities.
- The 23 MSP rates are **OFFICIAL** (PIB Cabinet releases, 2026-27) with full provenance, and are **single-sourced and not independently cross-checked** (`last_verified_at IS NULL`).
- **No real SMS is sent.** The outbox and provider interface are real; delivery is a DEMO adapter.
- **No money moves.** FarmQueue records payment status and references; it does not disburse, and collects no bank details.
- No Aadhaar and no bank details are collected anywhere.

Details in [`docs/submission/limitations.md`](docs/submission/limitations.md).
