# Mandi Sahayak — Phase 10 Roadmap Recovery Audit

# STATUS: BLOCKED — NO AUTHORITATIVE PHASE 10 DEFINITION

**Date:** 2026-09-03
**Type:** read-only investigation. No source, migration, test, schema, configuration or frontend file was created or modified. Nothing was committed. No destructive git command was run.
**Only file created:** this one.

---

## 0. Verdict in one paragraph

A complete, internally consistent roadmap **can be reconstructed** from the pre-drift documents, and it says **Phase 10 = officer operations — work that is already built**. But the reconstruction requires triangulating roughly twenty-five scattered references across ten files; **no single document states it**, and `docs/architecture.md` — the only artifact that describes itself as a design contract — never mentions Phase 10, 11 or 12 at all. Every Phase 10 reference is a phase report or a source comment, and two mutually exclusive definitions are live in the working tree simultaneously. Reconstructing the roadmap is reconciliation, which this audit was explicitly forbidden to perform. The evidence is therefore presented, with its strength stated plainly, for your decision.

---

## 1. Every relevant Phase 10 reference found

Eight references exist in the working tree. `docs/phase-10-design.md` and `docs/phase-10-report.md` are excluded throughout — they are this investigation's own output, not evidence.

| # | File : line | Ref | Section | What it says Phase 10 is | Authoritative? | Conflicts? | Currency |
|---|---|---|---|---|---|---|---|
| **1** | `docs/phase-4-report.md:156` | working tree only | Brief-requirement coverage table | **"Officer operations are Phase 10."** | **No — Class C** (phase report). But pre-drift and independently written | Yes, with #3–#7 | Historical, uncontradicted by any pre-drift source |
| **2** | `server/src/core/rbac.ts:140` | working tree only | Doc comment on `actorMayActOnCentre` | *"Not used by Phase 5 routes, but defined here so **Phase 10** does not invent a second authorization mechanism."* Refers to **officer centre scope** | **No — Class D** (implementation note). But it is in **shipped source**, not narrative | Yes, with #3–#7 | Current in code; written at Phase 5 |
| **3** | `docs/api/queue.md:314` | working tree only | "What this API deliberately does not do" | *"No notifications, no SMS, no queue-recompute worker. **Phase 10**."* | **No — Class C**, authored in the Phase 9 session | Yes, with #1–#2 | Current but derivative |
| **4** | `docs/phase-9-queue-eta.md:469` | working tree only | §14.1 deferrals table | Notifications = Phase 10 | **No — Class C**, same session | Yes | Derivative |
| **5** | `docs/phase-9-report.md:671` | working tree only | §29 Known limitations | Notifications = Phase 10 | **No — Class C**, same session | Yes | Derivative |
| **6** | `docs/phase-9-report.md:714` | working tree only | §31 Deferred work | Notifications = Phase 10 | **No — Class C**, same session | Yes | Derivative |
| **7** | `docs/phase-9-report.md:766` | working tree only | Completion report | *"**NEXT PHASE:** Phase 10 — notifications"* | **No — Class C**, same session | Yes | Derivative |
| **8** | `docs/phase-9-report.md:742` | working tree only | §32 | *"No Phase 10 work begun"* — states nothing about scope | n/a | n/a | Derivative |

### 1.1 The two candidate definitions

**Candidate A — Phase 10 = officer operations** (references #1, #2)
Two independent sources, written at Phase 4 and Phase 5 respectively, before Phases 7–9 existed. One is a phase report; the other is a comment in shipped production source. They agree with each other and with a coherent surrounding scheme (§3).

**Candidate B — Phase 10 = notifications** (references #3–#7)
Five references, **all authored in a single session** (the Phase 9 session), all in documents produced by that session. They cite one another rather than any independent source. Reference #7 is the origin: it reasoned forward from "Phase 9 is done, so Phase 10 is next," which is precisely the inference this audit was instructed not to make.

---

## 2. Every conflicting phase-number reference

The full recovered picture. **Pre-drift** = written before the Phase 7–9 sessions.

| Phase | Pre-drift sources say | Refs | Actually delivered as |
|---|---|---|---|
| 5 | Authentication & RBAC | `phase-4-report.md:152,288` | Phase 5 ✓ |
| 6 | Reference-data APIs / farmer domain | `phase-5-authentication.md:230` | Phase 6 ✓ |
| **7** | **Scheduling engine** | `phase-0-audit.md:369,466,483,562`; `phase-6-farmer-domain.md:202`; `phase-4-report.md:153` | merged into delivered Phase 7 |
| **8** | **Booking** | `phase-6-frontend-contract-audit.md:213`; `phase-0-audit.md:371,485,487`; `database-schema.md:279` | merged into delivered Phase 7 |
| **9** | **Queue** | `phase-4-report.md:154`; `phase-6-frontend-contract-audit.md:213` | delivered Phase 9 ✓ (number coincides) |
| **10** | **Officer operations** | `phase-4-report.md:156`; `rbac.ts:140` | **delivered inside Phase 8** |
| **11** | **Payment calculation** | `phase-4-report.md:157,284`; `phase-3-report.md:336`; `msp-data.md:188`; `phase-5-authentication.md:175`; `phase-6-farmer-domain.md:164` | **delivered inside Phase 8** |
| **12** | **SMS / notifications** | `phase-4-report.md:155`; `phase-5-authentication.md:158`; `phase-0-audit.md:356`; `api/bookings.md:293`; **`server/.env.example:44`**; **`server/migrations/0009_messaging.sql:13`**; **`server/src/modules/auth/otp.service.ts:44`** | **not built** |
| 13 | Offline strategy (`docs/offline-strategy.md`) | **`architecture.md:1459`** | not built |
| 14 | Admin / officer provisioning API | `phase-0-audit.md:469`; `phase-5-authentication.md:161` | not built |
| 15 | Frontend integration | `architecture.md:124,1346,1360` | not built |
| 17 | Backups | `architecture.md:1475` | not built |

### 2.1 Where the drift came from

Delivered **Phase 7** = pre-drift Phases 7 + 8 (scheduling **and** booking, merged).
Delivered **Phase 8** = pre-drift Phases 10 + 11 (officer operations **and** payment, merged).
Delivered **Phase 9** = pre-drift Phase 9 (queue) — delivered *after* pre-drift Phase 10, so the number matching is coincidence, not alignment.

Two merges of two phases each consumed four pre-drift numbers across three delivered phases. Nothing was skipped; the labels stopped tracking.

### 2.2 The strongest single indicator

**Notifications = Phase 12 is asserted in three non-narrative artifacts** — a migration, an environment template, and a service source comment:

- `server/migrations/0009_messaging.sql:13` — *"No template text is seeded here. Templates are authored in **Phase 12**…"*
- `server/.env.example:44` — `# Phase 12 (notifications)`
- `server/src/modules/auth/otp.service.ts:44` — *"**Phase 12** replaces this with the notification outbox and a real…"*

These are Class D, not Class A or B, so they are not authoritative. But they are part of the implementation rather than commentary about it, they were written independently across three phases, and **no artifact of any kind places notifications at Phase 10 except the five Phase 9 documents.**

---

## 3. Branch / ref where each was found

**Every reference above exists only in the working tree.** Not one is present in any git ref.

| Ref | Head | Phase/roadmap content |
|---|---|---|
| `refs/heads/main` | `e8b2b16` | **none** |
| `refs/remotes/origin/main` | `e8b2b16` | **none** |
| `refs/remotes/origin/HEAD` | → `origin/main` | **none** |
| `refs/remotes/origin/faramqueue-feature` | `f1a0403` (2026-08-31) | **none** |

`git grep -inE "phase [0-9]|roadmap|next phase|future phase"` returned **zero matches on all three refs.**

**Tags:** none exist.

---

## 4. Why none can safely be treated as authoritative

Applying the required classification:

| Class | Present? | Detail |
|---|---|---|
| **A — Explicit authoritative requirement** | **NO** | No requirements document, statement of work, or numbered plan exists anywhere in the repository or its history |
| **B — Architecture / design decision** | **NO for Phase 10** | `docs/architecture.md` calls itself *"the design contract for the Mandi Sahayak backend"* and contains §1–§25 plus decision registers D-1…D-11 and A-1…A-10. **It never mentions Phase 10, Phase 11 or Phase 12.** It names only Phase 13, 15 and 17, and then only in passing |
| **C — Phase report** | **YES — all seven scope-bearing references** | Both candidates rest entirely on phase reports |
| **D — Historical implementation note** | **YES** | `rbac.ts:140`, `0009_messaging.sql:13`, `.env.example:44`, `otp.service.ts:44` |
| **E — Experimental / branch-specific** | none | `faramqueue-feature` contains frontend files only |
| **F — Informal commentary** | — | — |
| **G — Ambiguous / conflicting** | **YES** | Two mutually exclusive definitions are live simultaneously |

Four reasons no source can be promoted to authoritative:

1. **The design contract is silent.** The only Class B artifact does not define Phase 10. Its silence cannot be read as endorsement of either candidate.
2. **Both candidates are Class C.** Neither outranks the other by document type.
3. **The pre-drift roadmap must be reconstructed, not read.** No document lists the phases. Recovering it means triangulating ~25 references across ten files and inferring a scheme none of them states. **That is reconciliation, which this audit was instructed not to perform.**
4. **Candidate B is self-referential.** Its five references were authored in one session and derive from the inference "Phase 9 is finished, so Phase 10 is next" — the specific reasoning the brief for this audit ruled out.

**This is not a finding of equal weight.** The pre-drift evidence is unanimous, spans three phases and three independent authors' artifacts, and is internally coherent across twelve phase numbers. Candidate B has one origin and no independent corroboration. The audit declines to *rule*, not to *assess*.

---

## 5. Evidence from git history

- **`docs/` and `server/` have never been committed.** `git log --all --pretty=format: --name-only` contains no path under either. All backend code and all phase documentation are untracked.
- **Nothing has ever been deleted.** `--diff-filter=D` across all refs returns empty. **No deleted roadmap document exists to recover.**
- **Six commits exist in total**, all frontend-only:
  - `main`: `19944bb` Initial Mandi Sahayak frontend → `0889e3f` todo backend → `158166a` Improve farmer portal and booking flow → `e8b2b16` Improve procurement capacity information
  - `origin/faramqueue-feature`: `4e8ef4d` Initial commit for Faramqueue app → `f1a0403` Fix empty queue state and sample slots
- **Reflog** shows one clone and one `pull --tags origin main` fast-forward, `0889e3f → e8b2b16`. No rewritten or lost history.
- **Tracked non-frontend files** are `README.md` (stock Vite template, no roadmap) and `BACKEND_READINESS_AUDIT.txt` (frontend gap analysis, no phase numbering).

**Conclusion: git history contains no roadmap and never did.**

### 5.1 Incidental observation

Commits `158166a` (2026-09-02 15:19) and `e8b2b16` (2026-09-02 16:34) by Jannat Afroz modified 18 frontend files, including new `src/pages/farmer/BookingConfirmation.jsx` and `src/data/crops.js`. These arrived by pull during the Phase 9 session. **Not modified by this audit or by any backend phase**; noted only because the working tree moved outside the backend work.

---

## 6. Evidence from current docs

Enumerated exhaustively — all 25 markdown/text documents were searched:

- `docs/architecture.md` — Class B, **silent on Phase 10/11/12**
- `docs/phase-0-audit.md` — earliest planning artifact; contains a question→phase table (Q3→7, Q5→8, Q7→8, Q8→5, Q9→5) and mentions Phases 12 and 14, **but never Phase 10 or 11**
- `docs/phase-3-report.md`, `phase-4-report.md`, `phase-5-authentication.md`, `phase-6-*.md`, `msp-data.md`, `database-schema.md`, `d9-correction-report.md` — pre-drift; collectively support Candidate A
- `docs/phase-7-*`, `phase-8-*`, `phase-9-*`, `api/queue.md` — post-drift; `phase-9-*` and `api/queue.md` support Candidate B
- `README.md` (root) — stock Vite template
- `BACKEND_READINESS_AUDIT.txt` — no phase numbering
- `server/README.md` — no roadmap

No `.gitignore`d file contains project documentation (`git status --ignored` shows nothing relevant outside `node_modules`).

---

## 7. Evidence from later phase references

The later-phase references are the strongest evidence, because they are unanimous and were written across several independent phases:

- **Phase 11 = payment calculation** — six references, four of them explicitly gating: *"MSP cross-check outstanding before Phase 11"*, *"must be cross-checked before Phase 11 computes money"* (twice), *"Phase 11 must not present a national MSP as the final payable amount"*.
- **Phase 12 = SMS/notifications** — seven references, three in non-narrative artifacts (§2.2).
- **Phase 13 = offline strategy** — one reference, but **inside `architecture.md`**, the Class B document.
- **Phase 14 = admin/officer provisioning API** — two references.

**These are mutually consistent and leave no room for notifications at Phase 10.** For Candidate B to hold, Phases 11–14 would all have to be renumbered too, and nothing in the repository does that.

### 7.1 A governance finding surfaced by this audit

Recorded because it is material, factual, and was found by the same evidence trail. **No action taken.**

Four pre-drift documents state a **precondition on pre-drift Phase 11 (payment calculation)**:

| Source | Requirement |
|---|---|
| `phase-3-report.md:333` (R-J) | *"the cross-check in B.5 must be performed and `verified_at` set **before any payment is computed** from these rates"* |
| `phase-4-report.md:284` | *"MSP cross-check outstanding before Phase 11"* |
| `phase-5-authentication.md:175` | *"Must be cross-checked before Phase 11 computes money"* |
| `phase-6-farmer-domain.md:164` | *"cross-check required before Phase 11 computes money"* |

**Payment calculation shipped in delivered Phase 8. The cross-check was never performed; `last_verified_at` is still NULL on all 23 rates.** The precondition four documents placed on this work was not satisfied before it shipped. This is the same open item tracked as R-J / R-8g.

A second, separate pre-drift requirement — **R-K** (`phase-3-report.md:336`, `msp-data.md:188`) — states: *"Phase 11 must not present a national MSP as the final payable amount without confirming state-level policy"*, because state bonuses are **NOT RESEARCHED**. The shipped payment API returns `amountPaise` / `amountRupees` with no state-policy caveat. **R-K appears unsatisfied.** It is not currently tracked in any Phase 7–9 risk register, and is surfaced here so it is not lost.

---

## 8. What information is missing

1. **Any Class A or Class B artifact that assigns a number to Phase 10.** None exists in the working tree, in any git ref, or in deleted history.
2. **A decision on whether the pre-drift numbering or the delivered numbering governs from here.**
3. **If pre-drift governs:** confirmation that Phase 10 (officer operations) and Phase 11 (payment calculation) are considered *delivered* despite having shipped under the label "Phase 8" — and, if so, whether R-J and R-K (§7.1) must be closed retrospectively.
4. **The name of the next phase to build**, under whichever numbering is adopted.

---

## 9. Minimum product-owner decision required

**One decision, in one of three forms.** No engineering work is blocked by anything else.

**Form 1 — Adopt the pre-drift roadmap.**
Then Phase 10 (officer operations) and Phase 11 (payment calculation) are **already complete**, and the next unbuilt phase is **Phase 12 — SMS and notifications** (architecture §16). Everything in `docs/phase-10-design.md` applies unchanged to it, including blocker B-2 below.

**Form 2 — Adopt the delivered roadmap.**
Then Phase 10 = notifications, as the Phase 9 documents assert, and pre-drift Phases 11–14 are renumbered accordingly. Blocker B-2 applies immediately.

**Form 3 — Declare a fresh number and scope explicitly**, disregarding both.

Under **all three forms**, the substantive next body of work is the same — notifications — and it carries the same second blocker.

---

# SECOND BLOCKER — B-2 (read-only analysis)

Carried forward from `docs/phase-10-design.md` §19.2. Re-verified during this audit. **Not fixed. No solution invented.**

### B-2 exact blocker

Architecture §16 requires eleven policy values that do not exist anywhere in the repository or database.

| # | Value | Exact source | Category | Why it blocks |
|---|---|---|---|---|
| 1 | `approaching_position_threshold` | `architecture.md` §16.4, §13.5 (D-4) | **Missing configuration** (no schema object) | `QUEUE_APPROACHING` cannot fire; `displayStatus: "APPROACHING"` cannot be derived |
| 2 | `turn_threshold_minutes` | §16.4, §13.5 | **Missing configuration** (no schema object) | `TURN_APPROACHING` cannot fire |
| 3 | `REMINDER_SEND_HOUR_LOCAL` | §16.4, §19; `.env.example:46` | **Missing configuration** (key named, no value) | `ONE_DAY_REMINDER` has no send time |
| 4 | Notifiable payment statuses | §16.4 (`PAYMENT_UPDATED` — *"transition to a notifiable state"*) | **Requirement ambiguity** | Which money events warrant a message is undefined |
| 5 | Quiet-hours window | §16.5 | **Requirement ambiguity** (also legal — TRAI) | Dispatcher cannot decide `SUPPRESSED` |
| 6 | Per-farmer daily cap | §16.5 | **Requirement ambiguity** | Same |
| 7 | Global kill-switch default | §16.5 | **Requirement ambiguity** | Same |
| 8 | Retry backoff schedule | §16.1 (*"exponential backoff up to max_attempts"*) | **Requirement ambiguity** (`max_attempts`=5 exists; the schedule does not) | Dispatcher retry timing undefined |
| 9 | Notification retention | §21 / A-5, marked *"needs confirmation"* | **Requirement ambiguity** (statutory) | Purge policy undefined |
| 10 | Template bodies, en + hi, 8 events × 2 channels | §16.3; `notification_templates` has **0 rows** | **Missing data** (product content, PII-reviewable) | Nothing can be rendered or sent |
| 11 | `dlt_template_id` per SMS template | §16.3 (TRAI DLT) | **Implementation dependency, external** | Issued by a telecom registrar; cannot be fabricated |

### B-2 category summary

- **Missing configuration (no schema object):** #1, #2 — require migration `0014` **and** a value decision
- **Missing configuration (no value):** #3
- **Requirement ambiguity:** #4, #5, #6, #7, #8, #9
- **Missing data:** #10
- **External implementation dependency:** #11
- **Architecture conflict:** none. §16 is internally consistent; it simply depends on values nobody has supplied

### B-2 minimum decision required

For **#1 and #2** — recommended form, requiring no invented number: *"operator-set per centre, default NULL = disabled."* The exact forward-only migration is written out in `docs/phase-10-design.md` §20.1 point 6 and is **not** applied.

For **#3–#9** — seven values, or an explicit "defaults off / not applicable for the demonstration build".

For **#10** — authored copy in `en` and `hi`, PII-reviewed.

For **#11** — accept that SMS cannot be sent to real numbers until DLT registration exists; `MockSmsProvider` and the `IN_APP` channel are unaffected.

**A threshold-free slice remains implementable** the moment the roadmap decision is made and template copy exists (`docs/phase-10-design.md` §20.2): outbox writes for the four transaction-triggered events, dedupe by UNIQUE constraint, `IN_APP` only, the three farmer feed endpoints, `MockSmsProvider` behind the `SmsProvider` interface, and closing the architecture §13.1 step-9 gap.

---

## 10. Decision request

> **Please provide the authoritative Phase 10 scope, or explicitly approve one of the discovered candidate definitions:**
>
> - **Candidate A** — Phase 10 = **officer operations** (pre-drift; already delivered as "Phase 8"). If approved, the next unbuilt phase is **Phase 12 — SMS and notifications**.
> - **Candidate B** — Phase 10 = **notifications** (asserted by the Phase 9 documents).
> - **Or** state a different scope.
>
> **Please also decide blocker B-2**, at minimum items #1 and #2, for which the recommended form is *"operator-set per centre, default NULL = disabled."*
>
> Separately, please confirm whether **R-J** and **R-K** (§7.1) require retrospective closure, given that payment calculation shipped without the MSP cross-check that four documents made a precondition.

---

**No implementation has begun. Phase 10 remains blocked. Phase 11 has not been started.**
