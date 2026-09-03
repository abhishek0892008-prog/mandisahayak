/**
 * Procurement engine — PURE.
 *
 * No database, no clock, no HTTP. Three decisions live here, and they are the
 * three that must never be made twice or made differently:
 *
 *   1. What a set of measured quantities MEANS (quality_status).
 *   2. WHICH MSP rate applies to a completed procurement (Decision D-9).
 *   3. What the farmer is therefore OWED.
 *
 * (2) is the interesting one. D-9 fixed the identity of an MSP rate as
 * crop + season + marketing_year + grade. A booking carries the first three; a
 * booking cannot carry a grade, because grade is not knowable until the produce
 * is in front of an officer. So the grade recorded at quality check is the
 * fourth component of the identity, and resolution can only happen after it.
 *
 * When the identity does not resolve, this module says WHY. It never picks the
 * cheaper rate, the first rate, or the most common rate. See
 * docs/phase-8-officer-operations.md §7.
 */

// ---------------------------------------------------------------------------
// 1. Quality classification
// ---------------------------------------------------------------------------

export type QualityStatus = 'ACCEPTED' | 'PARTIALLY_ACCEPTED' | 'REJECTED';

/**
 * Derived from the numbers, never accepted from the client.
 *
 * A `quality_status` sent by the caller could disagree with the quantities it
 * claims to summarise. This function is the only definition.
 *
 * Note the asymmetry: ACCEPTED requires that nothing was rejected AND that the
 * accepted quantity is the whole gross. A consignment where 100 kg simply
 * vanished between the weighbridge and the store was not fully accepted, even
 * though nothing was formally rejected — it is PARTIALLY_ACCEPTED, and the
 * shortfall stays visible instead of being rounded away.
 */
export function deriveQualityStatus(
  grossKg: number,
  acceptedKg: number,
  rejectedKg: number,
): QualityStatus {
  if (acceptedKg === 0) return 'REJECTED';
  if (rejectedKg === 0 && acceptedKg === grossKg) return 'ACCEPTED';
  return 'PARTIALLY_ACCEPTED';
}

// ---------------------------------------------------------------------------
// 2. MSP rate resolution (Decision D-9)
// ---------------------------------------------------------------------------

export type MspCandidate = {
  id: string;
  ratePerQuintalPaise: number;
  /** NULL when the source publishes a single ungraded rate for the crop. */
  varietyOrGrade: string | null;
};

/** Only the two reasons the schema actually permits for an unresolved rate. */
export type MspBlockReason = 'NO_ACTIVE_MSP' | 'MSP_AMBIGUOUS';

export type MspResolution =
  | { resolved: true; rate: MspCandidate }
  | { resolved: false; reason: MspBlockReason; candidateGrades: string[] };

/** Case-insensitive, whitespace-trimmed. Deliberately not fuzzy. */
function gradesMatch(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v ?? '').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Chooses the one applicable rate, or explains why there isn't one.
 *
 * The caller has already narrowed `candidates` to the ACTIVE rates for the
 * booking's crop, season and marketing year. What remains is the grade.
 *
 *   0 candidates                  -> NO_ACTIVE_MSP
 *   1 candidate                   -> that one; a single rate is unambiguous
 *                                    whether or not a grade was recorded
 *   many, no grade recorded       -> MSP_AMBIGUOUS  (the officer must grade it)
 *   many, grade matches exactly 1 -> that one
 *   many, grade matches none      -> NO_ACTIVE_MSP  (that grade has no rate)
 *
 * The "many, no grade" case is the one that matters in the seeded data: Paddy
 * has Common and Grade A, twenty paise apart per kilogram, and nothing in this
 * system may guess which one a farmer brought.
 */
export function resolveMspRate(
  candidates: readonly MspCandidate[],
  recordedGrade: string | null,
): MspResolution {
  const grades = candidates.map((c) => c.varietyOrGrade).filter((g): g is string => g !== null);

  if (candidates.length === 0) {
    return { resolved: false, reason: 'NO_ACTIVE_MSP', candidateGrades: [] };
  }

  if (candidates.length === 1) {
    return { resolved: true, rate: candidates[0] };
  }

  const grade = recordedGrade?.trim() ?? '';
  if (grade === '') {
    return { resolved: false, reason: 'MSP_AMBIGUOUS', candidateGrades: grades };
  }

  const matches = candidates.filter((c) => gradesMatch(c.varietyOrGrade, grade));

  if (matches.length === 1) return { resolved: true, rate: matches[0] };

  // No rate carries the grade the officer recorded. There is genuinely no
  // active MSP for this identity — which is different from "we cannot tell
  // which of several applies", and is reported differently.
  if (matches.length === 0) {
    return { resolved: false, reason: 'NO_ACTIVE_MSP', candidateGrades: grades };
  }

  // Two ACTIVE rates sharing a grade would violate
  // msp_rates_one_active_per_identity. Unreachable while that index exists;
  // refusing to price is the only safe answer if it ever is reached.
  return { resolved: false, reason: 'MSP_AMBIGUOUS', candidateGrades: grades };
}

// ---------------------------------------------------------------------------
// 3. Entitlement
// ---------------------------------------------------------------------------

export const KG_PER_QUINTAL = 100;

export type PaymentComputation = {
  baseAmountPaise: number;
  deductionsPaise: number;
  amountPaise: number;
};

/**
 * base = accepted quintals * rate per quintal, in paise.
 *
 * THE PRODUCTION PATH DOES NOT USE THIS FUNCTION for the stored value: the
 * service computes the same expression in SQL, in `numeric`, so the money never
 * touches a float64. This exists so the arithmetic — including the rounding
 * boundary and the zero-accepted case — is testable without a database, and so
 * the two can be checked against each other.
 *
 * Rounding is half away from zero, matching PostgreSQL's ROUND(numeric) and the
 * scheduling engine's convention. Amounts here are non-negative, so this is the
 * same as rounding half up.
 *
 * `deductionsPaise` is a parameter rather than a constant because the column
 * exists and a policy may configure it later. Today every caller passes 0: no
 * deduction policy is configured, and an empty policy means no deductions.
 */
export function computePayment(
  acceptedKg: number,
  ratePerQuintalPaise: number,
  deductionsPaise = 0,
): PaymentComputation {
  const quintals = acceptedKg / KG_PER_QUINTAL;
  const base = Math.round(quintals * ratePerQuintalPaise);
  return {
    baseAmountPaise: base,
    deductionsPaise,
    amountPaise: Math.max(base - deductionsPaise, 0),
  };
}

/** Presentation only. The wire format for money is always integer paise. */
export function paiseToRupeeString(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
