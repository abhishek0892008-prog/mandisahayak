/**
 * Officer operations — SQL.
 *
 * Two rules shape every query in this file.
 *
 * 1. CENTRE SCOPE IS IN THE QUERY, never applied afterwards. A query that can
 *    return a row belonging to another centre and then hide it in JavaScript is
 *    a query that will eventually leak one. Every read below takes the
 *    officer's assigned centre ids and joins on them.
 *
 * 2. MONEY IS COMPUTED IN `numeric`, in SQL. `engines/procurement.ts` holds the
 *    same arithmetic in TypeScript so it can be tested without a database, but
 *    the value that is STORED is produced by PostgreSQL and never passes
 *    through a float64.
 */
import type { PoolClient } from 'pg';
import { query } from '../../core/db.ts';
import { BOOKING_SELECT } from '../bookings/bookings.repository.ts';
import type { BookingView } from '../bookings/bookings.repository.ts';
import type { MspCandidate } from '../../engines/procurement.ts';

/** A booking as an officer sees it: the farmer's view plus who the farmer is. */
export type OfficerBookingView = BookingView & {
  farmer_name: string;
  farmer_phone: string;
  village_name: string | null;
};

/**
 * Composed from BOOKING_SELECT rather than restating its joins, so there is
 * exactly one definition of what a booking row contains.
 */
const OFFICER_SELECT = `
  SELECT v.*, u.full_name AS farmer_name, u.phone_e164 AS farmer_phone,
         vl.name AS village_name
    FROM ( ${BOOKING_SELECT} ) v
    JOIN farmers f ON f.id = v.farmer_id
    JOIN users u ON u.id = f.user_id
    LEFT JOIN villages vl ON vl.id = f.village_id`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Centre scope. `null` means UNRESTRICTED and is used only for an ADMIN, whose
 * authority is not derived from an assignment. An officer always carries a
 * concrete list, and an empty list matches nothing — an officer assigned to no
 * centre can act on no booking, which is the correct reading of "unassigned".
 */
export type CentreScope = readonly string[] | null;

/** One booking, scoped to the officer's centres. Out of scope yields null. */
export async function findByCodeInCentres(
  bookingCode: string,
  scope: CentreScope,
  db: PoolClient | null = null,
): Promise<OfficerBookingView | null> {
  if (scope !== null && scope.length === 0) return null;
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `${OFFICER_SELECT}
      WHERE v.booking_code = $1
        AND ($2::uuid[] IS NULL OR v.centre_id = ANY($2::uuid[]))`,
    [bookingCode, scope as string[] | null],
  );
  return (res.rows[0] as OfficerBookingView) ?? null;
}

/**
 * The day's bookings at one centre, in service order.
 *
 * Ordered by scheduled_start_at, which is what bookings_centre_date_start_idx
 * exists for. This is NOT the live queue: position and dynamic ETA are Phase 9
 * and derive from what the transitions below actually record.
 */
export async function listCentreDay(
  centreId: string,
  /**
   * 'YYYY-MM-DD'. Compared against `service_date_on`, the UNCAST date column.
   * Comparing against `service_date` (which BOOKING_SELECT renders with ::text)
   * puts a cast on the indexed column and loses
   * bookings_centre_date_start_idx — verified with EXPLAIN, not assumed.
   */
  serviceDate: string,
  statuses: readonly string[] | null,
): Promise<OfficerBookingView[]> {
  const res = await query(
    `${OFFICER_SELECT}
      WHERE v.centre_id = $1 AND v.service_date_on = $2::date
        AND ($3::text[] IS NULL OR v.status = ANY($3::text[]))
      ORDER BY v.scheduled_start_at, v.token_number
      LIMIT 500`,
    [centreId, serviceDate, statuses as string[] | null],
  );
  return res.rows as OfficerBookingView[];
}

/**
 * Search by booking code, token number, or phone — always within the officer's
 * assigned centres.
 *
 * The caller classifies the query string; this function applies exactly one of
 * the three predicates. A phone that belongs to nobody and a phone whose farmer
 * has no booking here both return an empty list, so the endpoint cannot be used
 * to test whether a number is registered.
 */
export async function searchInCentres(
  scope: CentreScope,
  by: { bookingCode?: string; tokenNumber?: number; phoneE164?: string },
): Promise<OfficerBookingView[]> {
  if (scope !== null && scope.length === 0) return [];
  const res = await query(
    `${OFFICER_SELECT}
      WHERE ($1::uuid[] IS NULL OR v.centre_id = ANY($1::uuid[]))
        AND ( ($2::text IS NOT NULL AND v.booking_code = $2::text)
           OR ($3::int  IS NOT NULL AND v.token_number = $3::int)
           OR ($4::text IS NOT NULL AND u.phone_e164   = $4::text) )
      ORDER BY v.scheduled_start_at DESC
      LIMIT 50`,
    [
      scope as string[] | null,
      by.bookingCode ?? null,
      by.tokenNumber ?? null,
      by.phoneE164 ?? null,
    ],
  );
  return res.rows as OfficerBookingView[];
}

/**
 * LOCK. Serialises two officers acting on the same booking.
 *
 * Taken before any status check, so the second transaction waits, then reads
 * the status the first one wrote and is refused by the state check.
 */
export async function lockBooking(
  client: PoolClient,
  bookingCode: string,
  scope: CentreScope,
): Promise<{ id: string; centre_id: string; status: string } | null> {
  if (scope !== null && scope.length === 0) return null;
  const res = await client.query(
    `SELECT id, centre_id, status
       FROM bookings
      WHERE booking_code = $1
        AND ($2::uuid[] IS NULL OR centre_id = ANY($2::uuid[]))
      FOR UPDATE`,
    [bookingCode, scope as string[] | null],
  );
  return (res.rows[0] as { id: string; centre_id: string; status: string }) ?? null;
}

/** Moves the booking. The BEFORE UPDATE trigger refuses any illegal pair. */
export async function setBookingStatus(
  client: PoolClient,
  bookingId: string,
  to: string,
): Promise<void> {
  await client.query('UPDATE bookings SET status = $2 WHERE id = $1', [bookingId, to]);
}

export async function markNoShow(
  client: PoolClient,
  bookingId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE bookings
        SET status = 'NO_SHOW', no_show_at = now(), no_show_by_user_id = $2
      WHERE id = $1`,
    [bookingId, userId],
  );
}

export async function cancelAtCentre(
  client: PoolClient,
  bookingId: string,
  userId: string,
  reason: string | null,
): Promise<void> {
  await client.query(
    `UPDATE bookings
        SET status = 'CANCELLED', cancelled_at = now(),
            cancellation_reason = $3, cancelled_by_user_id = $2
      WHERE id = $1`,
    [bookingId, userId, reason],
  );
}

/**
 * The centre's IANA timezone, so "today" on the day list is the centre's local
 * calendar date and never the server's.
 */
export async function centreTimezone(centreId: string): Promise<string | null> {
  const res = await query<{ timezone: string }>(
    'SELECT timezone FROM procurement_centres WHERE id = $1',
    [centreId],
  );
  return res.rows[0]?.timezone ?? null;
}

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------

export type ProcurementRow = {
  id: string;
  booking_id: string;
  centre_id: string;
  officer_user_id: string | null;
  arrived_at: Date | null;
  service_started_at: Date | null;
  service_ended_at: Date | null;
  gross_quantity_kg: string | null;
  accepted_quantity_kg: string | null;
  rejected_quantity_kg: string | null;
  grade: string | null;
  moisture_percent: string | null;
  quality_status: string;
  rejection_reason: string | null;
  status: string;
  completed_at: Date | null;
};

export async function createProcurement(
  client: PoolClient,
  bookingId: string,
  centreId: string,
  officerUserId: string,
): Promise<ProcurementRow> {
  const res = await client.query(
    `INSERT INTO procurements (booking_id, centre_id, officer_user_id, arrived_at)
     VALUES ($1,$2,$3, now())
     RETURNING *`,
    [bookingId, centreId, officerUserId],
  );
  return res.rows[0] as ProcurementRow;
}

export async function findProcurement(
  bookingId: string,
  db: PoolClient | null = null,
): Promise<ProcurementRow | null> {
  const run = db ? db.query.bind(db) : query;
  const res = await run('SELECT * FROM procurements WHERE booking_id = $1', [bookingId]);
  return (res.rows[0] as ProcurementRow) ?? null;
}

export async function startWeighing(client: PoolClient, bookingId: string): Promise<void> {
  await client.query(
    `UPDATE procurements SET service_started_at = now() WHERE booking_id = $1`,
    [bookingId],
  );
}

export async function recordGross(
  client: PoolClient,
  bookingId: string,
  grossKg: number,
): Promise<void> {
  await client.query(
    `UPDATE procurements SET gross_quantity_kg = $2::numeric WHERE booking_id = $1`,
    [bookingId, grossKg],
  );
}

export async function recordQuality(
  client: PoolClient,
  bookingId: string,
  input: {
    acceptedKg: number;
    rejectedKg: number;
    grade: string | null;
    moisturePercent: number | null;
    qualityStatus: string;
    rejectionReason: string | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE procurements
        SET accepted_quantity_kg = $2::numeric,
            rejected_quantity_kg = $3::numeric,
            grade                = $4,
            moisture_percent     = $5::numeric,
            quality_status       = $6,
            rejection_reason     = $7
      WHERE booking_id = $1`,
    [
      bookingId,
      input.acceptedKg,
      input.rejectedKg,
      input.grade,
      input.moisturePercent,
      input.qualityStatus,
      input.rejectionReason,
    ],
  );
}

export async function completeProcurement(
  client: PoolClient,
  bookingId: string,
): Promise<ProcurementRow> {
  const res = await client.query(
    `UPDATE procurements
        SET status = 'COMPLETED', completed_at = now(), service_ended_at = now()
      WHERE booking_id = $1
      RETURNING *`,
    [bookingId],
  );
  return res.rows[0] as ProcurementRow;
}

// ---------------------------------------------------------------------------
// MSP and payment
// ---------------------------------------------------------------------------

/**
 * The ACTIVE rates for one crop, season and marketing year.
 *
 * Grade is deliberately NOT filtered here. Narrowing by grade is a DECISION,
 * and it is made in the pure engine where it can be tested exhaustively; this
 * function only supplies the candidates.
 */
export async function activeMspCandidates(
  cropId: string,
  seasonId: string,
  marketingYear: string,
  db: PoolClient | null = null,
): Promise<MspCandidate[]> {
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `SELECT id, rate_per_quintal_paise::text AS rate, variety_or_grade
       FROM msp_rates
      WHERE crop_id = $1 AND season_id = $2 AND marketing_year = $3
        AND status = 'ACTIVE'
      ORDER BY variety_or_grade NULLS FIRST`,
    [cropId, seasonId, marketingYear],
  );
  return (res.rows as Array<{ id: string; rate: string; variety_or_grade: string | null }>).map(
    (r) => ({
      id: r.id,
      ratePerQuintalPaise: Number(r.rate),
      varietyOrGrade: r.variety_or_grade,
    }),
  );
}

export type PaymentRow = {
  id: string;
  procurement_id: string;
  msp_rate_id: string | null;
  rate_per_quintal_paise_snapshot: string | null;
  base_amount_paise: string | null;
  deductions_paise: string;
  deduction_breakdown: unknown;
  amount_paise: string | null;
  currency: string;
  status: string;
  blocked_reason: string | null;
  payment_reference: string | null;
  paid_at: Date | null;
};

/**
 * The entitlement, computed by PostgreSQL in `numeric`.
 *
 * `accepted_quantity_kg` is read back from the procurement row rather than
 * passed in, so the amount is derived from what was actually STORED. The rate
 * is snapshotted here and never re-read: a later MSP revision must not change
 * what a farmer was already told.
 */
export async function insertResolvedPayment(
  client: PoolClient,
  procurementId: string,
  mspRateId: string,
  deductionsPaise = 0,
): Promise<PaymentRow> {
  const res = await client.query(
    `INSERT INTO payments (
         procurement_id, msp_rate_id, rate_per_quintal_paise_snapshot,
         base_amount_paise, deductions_paise, amount_paise, status)
     SELECT p.id,
            r.id,
            r.rate_per_quintal_paise,
            ROUND(p.accepted_quantity_kg / 100.0 * r.rate_per_quintal_paise)::bigint,
            $3::bigint,
            GREATEST(
              ROUND(p.accepted_quantity_kg / 100.0 * r.rate_per_quintal_paise)::bigint - $3::bigint,
              0),
            'PENDING'
       FROM procurements p
       JOIN msp_rates r ON r.id = $2
      WHERE p.id = $1
     RETURNING *`,
    [procurementId, mspRateId, deductionsPaise],
  );
  return res.rows[0] as PaymentRow;
}

/**
 * No rate could be resolved. The row still exists, because the FACT that the
 * procurement happened and could not be priced is itself worth recording, and
 * because the farmer is entitled to be told which of the two reasons applies.
 */
export async function insertBlockedPayment(
  client: PoolClient,
  procurementId: string,
  reason: 'NO_ACTIVE_MSP' | 'MSP_AMBIGUOUS',
): Promise<PaymentRow> {
  const res = await client.query(
    `INSERT INTO payments (procurement_id, status, blocked_reason)
     VALUES ($1, 'BLOCKED', $2)
     RETURNING *`,
    [procurementId, reason],
  );
  return res.rows[0] as PaymentRow;
}

export async function findPayment(
  procurementId: string,
  db: PoolClient | null = null,
): Promise<PaymentRow | null> {
  const run = db ? db.query.bind(db) : query;
  const res = await run('SELECT * FROM payments WHERE procurement_id = $1', [procurementId]);
  return (res.rows[0] as PaymentRow) ?? null;
}

export async function lockPayment(
  client: PoolClient,
  procurementId: string,
): Promise<PaymentRow | null> {
  const res = await client.query('SELECT * FROM payments WHERE procurement_id = $1 FOR UPDATE', [
    procurementId,
  ]);
  return (res.rows[0] as PaymentRow) ?? null;
}

export async function updatePaymentStatus(
  client: PoolClient,
  paymentId: string,
  status: string,
  reference: string | null,
  userId: string,
): Promise<PaymentRow> {
  const res = await client.query(
    `UPDATE payments
        SET status = $2,
            payment_reference = COALESCE($3, payment_reference),
            paid_at = CASE WHEN $2 = 'PAID' THEN now() ELSE paid_at END,
            updated_by_user_id = $4
      WHERE id = $1
      RETURNING *`,
    [paymentId, status, reference, userId],
  );
  return res.rows[0] as PaymentRow;
}

/** The farmer's own procurement and payment, ownership resolved in the query. */
export async function findOwnProcurement(
  farmerUserId: string,
  bookingCode: string,
): Promise<(ProcurementRow & { booking_code: string; payment: PaymentRow | null }) | null> {
  const res = await query(
    `SELECT pr.*, b.booking_code
       FROM procurements pr
       JOIN bookings b ON b.id = pr.booking_id
       JOIN farmers f ON f.id = b.farmer_id
      WHERE b.booking_code = $1 AND f.user_id = $2`,
    [bookingCode, farmerUserId],
  );
  const row = res.rows[0] as (ProcurementRow & { booking_code: string }) | undefined;
  if (!row) return null;
  return { ...row, payment: await findPayment(row.id) };
}
