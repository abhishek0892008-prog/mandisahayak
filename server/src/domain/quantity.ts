/**
 * Quantity domain.
 *
 * ONE definition of the rule, used by validation, by future slot sizing, and by
 * the reference endpoint that tells the frontend what the range is. Nothing
 * elsewhere may restate these numbers.
 *
 * CANONICAL UNIT: kilograms, integer.
 *   2500 kg <= quantityKg <= 5000 kg      (25 to 50 quintal)
 *
 * The database enforces the same range independently, via
 * `bookings_quantity_within_business_rule`. Application validation exists to
 * give a good error; the CHECK constraint exists so the rule cannot be bypassed
 * by any code path at all. If these two ever disagree, the database wins — and
 * `assertDomainMatchesDatabase()` below fails loudly rather than letting the
 * drift go unnoticed.
 *
 * Phase 6 deliberately stops here. Slot duration derives from quantity, but that
 * calculation belongs to the scheduling engine (Phase 7) and is NOT implemented.
 */
import { z } from 'zod';
import { query } from '../core/db.ts';

export const KG_PER_QUINTAL = 100;

export const MIN_QUANTITY_KG = 2500;
export const MAX_QUANTITY_KG = 5000;

export const MIN_QUANTITY_QUINTAL = MIN_QUANTITY_KG / KG_PER_QUINTAL; // 25
export const MAX_QUANTITY_QUINTAL = MAX_QUANTITY_KG / KG_PER_QUINTAL; // 50

/** Presentation helpers. The wire format is always kilograms. */
export function quintalToKg(quintal: number): number {
  return Math.round(quintal * KG_PER_QUINTAL);
}

export function kgToQuintal(kg: number): number {
  return kg / KG_PER_QUINTAL;
}

export type QuantityCheck =
  | { ok: true; quantityKg: number }
  | { ok: false; code: 'QUANTITY_NOT_INTEGER' | 'QUANTITY_BELOW_MINIMUM' | 'QUANTITY_ABOVE_MAXIMUM' };

export function checkQuantityKg(value: unknown): QuantityCheck {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, code: 'QUANTITY_NOT_INTEGER' };
  }
  if (value < MIN_QUANTITY_KG) return { ok: false, code: 'QUANTITY_BELOW_MINIMUM' };
  if (value > MAX_QUANTITY_KG) return { ok: false, code: 'QUANTITY_ABOVE_MAXIMUM' };
  return { ok: true, quantityKg: value };
}

/** Reusable schema for any future endpoint that accepts a quantity. */
export const QuantityKgSchema = z
  .number({ invalid_type_error: 'QUANTITY_NOT_INTEGER' })
  .int('QUANTITY_NOT_INTEGER')
  .min(MIN_QUANTITY_KG, 'QUANTITY_BELOW_MINIMUM')
  .max(MAX_QUANTITY_KG, 'QUANTITY_ABOVE_MAXIMUM');

/**
 * A MEASURED quantity, which is a different thing from a requested one.
 *
 * `QuantityKgSchema` above is what a farmer may ASK for: 2 500-5 000 kg, whole
 * kilograms. It must never be reused for what actually arrives on the
 * weighbridge. Real deliveries differ from the booking, and a weighbridge reads
 * to the gram.
 *
 * NO BUSINESS CEILING IS APPLIED, because none is specified anywhere in the
 * brief or the configuration. The bound below is `numeric(12,3)`'s own
 * headroom — a column limit, not a policy. Inventing "gross must be within 10 %
 * of booked" would be fabricating a rule nobody stated.
 *
 * The database independently enforces `> 0` via `procurements_gross_positive`
 * and `>= 0` for accepted and rejected.
 */
export const MAX_MEASURED_KG = 9_999_999.999;

const threeDecimals = (v: number) => Number.isInteger(Math.round(v * 1000)) && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;

/** Strictly positive: a gross weight of zero is a farmer who did not arrive. */
export const WeighedKgSchema = z
  .number({ invalid_type_error: 'QUANTITY_NOT_A_NUMBER' })
  .finite('QUANTITY_NOT_FINITE')
  .positive('QUANTITY_NOT_POSITIVE')
  .max(MAX_MEASURED_KG, 'QUANTITY_ABOVE_MAXIMUM')
  .refine(threeDecimals, 'QUANTITY_TOO_PRECISE');

/** Accepted and rejected quantities may legitimately be zero. */
export const MeasuredKgSchema = z
  .number({ invalid_type_error: 'QUANTITY_NOT_A_NUMBER' })
  .finite('QUANTITY_NOT_FINITE')
  .min(0, 'QUANTITY_NEGATIVE')
  .max(MAX_MEASURED_KG, 'QUANTITY_ABOVE_MAXIMUM')
  .refine(threeDecimals, 'QUANTITY_TOO_PRECISE');

/** What the frontend needs so it never hardcodes the range in a component. */
export function bookingConstraints() {
  return {
    quantity: {
      unit: 'kg',
      minKg: MIN_QUANTITY_KG,
      maxKg: MAX_QUANTITY_KG,
      // Provided for display only. The wire field is always quantityKg.
      minQuintal: MIN_QUANTITY_QUINTAL,
      maxQuintal: MAX_QUANTITY_QUINTAL,
      kgPerQuintal: KG_PER_QUINTAL,
      integerOnly: true,
    },
  };
}

/**
 * Guards against the application and the database drifting apart.
 *
 * Reads the actual CHECK constraint definition from PostgreSQL and asserts it
 * still contains this module's bounds. Called at startup, so a schema change
 * that moved the range without updating the domain would stop the server rather
 * than quietly produce two different rules.
 */
export async function assertDomainMatchesDatabase(): Promise<void> {
  const res = await query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'bookings_quantity_within_business_rule'`,
  );

  const def = res.rows[0]?.def;
  if (!def) {
    throw new Error(
      'bookings_quantity_within_business_rule is missing from the database; ' +
        'the quantity rule would exist only in application code.',
    );
  }

  if (!def.includes(String(MIN_QUANTITY_KG)) || !def.includes(String(MAX_QUANTITY_KG))) {
    throw new Error(
      `Quantity rule drift: domain says ${MIN_QUANTITY_KG}-${MAX_QUANTITY_KG} kg, ` +
        `database CHECK is "${def}".`,
    );
  }
}
