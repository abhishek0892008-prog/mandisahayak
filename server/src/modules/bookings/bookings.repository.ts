/**
 * Booking persistence: every query, every lock, one file.
 *
 * Transaction shape and lock order are documented in
 * docs/phase-7-booking-engine.md §7 and are followed exactly:
 *
 *     centre_daily_capacity  ->  storage_inventory  ->  bookings
 *
 * Nothing outside this file takes a lock on booking-related rows.
 */
import type { PoolClient } from 'pg';
import { randomInt } from 'node:crypto';
import { query } from '../../core/db.ts';
import type { LaneInterval, SlotConfig, WorkingHours } from '../../engines/scheduling.ts';

export type CentreContext = {
  centreId: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
  storageCheckMode: string;
  dataType: string;
  districtName: string;
  lanes: number[];
  config: SlotConfig;
  slotConfigId: string;
  hours: WorkingHours[];
  holidays: Set<string>;
};

/** Everything the engine needs about one centre, resolved for a given date. */
export async function loadCentreContext(
  centreId: string,
  onDate: string,
  db: PoolClient | null = null,
): Promise<CentreContext | null> {
  const run = db ? db.query.bind(db) : query;

  const centre = await run(
    `SELECT pc.id, pc.code, pc.name, pc.timezone, pc.status, pc.storage_check_mode,
            pc.data_type, d.name AS district_name
       FROM procurement_centres pc JOIN districts d ON d.id = pc.district_id
      WHERE pc.id = $1`,
    [centreId],
  );
  if (centre.rowCount === 0) return null;
  const c = centre.rows[0] as Record<string, string>;

  // The configuration in force ON THE SERVICE DATE, not "the latest".
  const cfg = await run(
    `SELECT id, reference_quantity_kg, reference_processing_minutes,
            minimum_processing_minutes, maximum_processing_minutes,
            transition_buffer_minutes, slot_granularity_minutes,
            booking_horizon_days, cancellation_cutoff_hours, max_daily_processing_kg
       FROM centre_slot_configurations
      WHERE centre_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)`,
    [centreId, onDate],
  );
  if (cfg.rowCount === 0) return null;
  const s = cfg.rows[0] as Record<string, unknown>;

  const hours = await run(
    `SELECT day_of_week, opens_at::text AS opens_at, closes_at::text AS closes_at
       FROM centre_operating_hours
      WHERE centre_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)`,
    [centreId, onDate],
  );

  const holidays = await run(
    `SELECT holiday_date::text AS d FROM centre_holidays WHERE centre_id = $1`,
    [centreId],
  );

  const lanes = await run(
    `SELECT lane_no FROM centre_service_lanes WHERE centre_id = $1 AND is_active ORDER BY lane_no`,
    [centreId],
  );

  return {
    centreId: c.id,
    code: c.code,
    name: c.name,
    timezone: c.timezone,
    status: c.status,
    storageCheckMode: c.storage_check_mode,
    dataType: c.data_type,
    districtName: c.district_name,
    lanes: (lanes.rows as Array<{ lane_no: number }>).map((r) => Number(r.lane_no)),
    slotConfigId: String(s.id),
    config: {
      referenceQuantityKg: Number(s.reference_quantity_kg),
      referenceProcessingMinutes: Number(s.reference_processing_minutes),
      minimumProcessingMinutes: Number(s.minimum_processing_minutes),
      maximumProcessingMinutes: Number(s.maximum_processing_minutes),
      transitionBufferMinutes: Number(s.transition_buffer_minutes),
      slotGranularityMinutes: Number(s.slot_granularity_minutes),
      bookingHorizonDays: Number(s.booking_horizon_days),
      cancellationCutoffHours: Number(s.cancellation_cutoff_hours),
      maxDailyProcessingKg:
        s.max_daily_processing_kg === null ? null : Number(s.max_daily_processing_kg),
    },
    hours: (hours.rows as Array<{ day_of_week: number; opens_at: string; closes_at: string }>).map(
      (r) => ({ dayOfWeek: Number(r.day_of_week), opensAt: r.opens_at, closesAt: r.closes_at }),
    ),
    holidays: new Set((holidays.rows as Array<{ d: string }>).map((r) => r.d)),
  };
}

export const ACTIVE_STATUSES = [
  'CONFIRMED',
  'ARRIVED',
  'WEIGHING',
  'QUALITY_CHECK',
  'PROCUREMENT_RECORDED',
  'PAYMENT_PENDING',
] as const;

/**
 * Occupied lane intervals for one centre-day.
 *
 * Uses bookings_centre_date_start_idx (centre_id, service_date,
 * scheduled_start_at) — an index range scan over one day, not a table scan.
 */
export async function loadDayOccupancy(
  centreId: string,
  serviceDate: string,
  db: PoolClient | null = null,
): Promise<LaneInterval[]> {
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `SELECT lane_no, scheduled_start_at, scheduled_end_at
       FROM bookings
      WHERE centre_id = $1 AND service_date = $2::date
        AND status = ANY($3::text[])
      ORDER BY scheduled_start_at`,
    [centreId, serviceDate, ACTIVE_STATUSES as unknown as string[]],
  );
  return (
    res.rows as Array<{ lane_no: number; scheduled_start_at: Date; scheduled_end_at: Date }>
  ).map((r) => ({
    laneNo: Number(r.lane_no),
    startAt: r.scheduled_start_at,
    endAt: r.scheduled_end_at,
  }));
}

/** LOCK 1. Serialises concurrent bookings for the same centre and day. */
export async function lockDailyCapacity(
  client: PoolClient,
  centreId: string,
  serviceDate: string,
): Promise<{ bookedQuantityKg: number; bookedMinutes: number; bookingCount: number }> {
  await client.query(
    `INSERT INTO centre_daily_capacity (centre_id, service_date)
     VALUES ($1, $2::date) ON CONFLICT (centre_id, service_date) DO NOTHING`,
    [centreId, serviceDate],
  );
  const res = await client.query(
    `SELECT booked_quantity_kg, booked_minutes, booking_count
       FROM centre_daily_capacity
      WHERE centre_id = $1 AND service_date = $2::date
      FOR UPDATE`,
    [centreId, serviceDate],
  );
  const r = res.rows[0] as Record<string, string>;
  return {
    bookedQuantityKg: Number(r.booked_quantity_kg),
    bookedMinutes: Number(r.booked_minutes),
    bookingCount: Number(r.booking_count),
  };
}

/** Next queue token for a centre-day. Safe under LOCK 1. */
export async function nextTokenNumber(
  client: PoolClient,
  centreId: string,
  serviceDate: string,
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(MAX(token_number), 0) + 1 AS next
       FROM bookings WHERE centre_id = $1 AND service_date = $2::date`,
    [centreId, serviceDate],
  );
  return Number((res.rows[0] as { next: string }).next);
}

/**
 * Public booking reference: FQ-YYYY-NNNNNNN with cryptographically random
 * digits. Never derived from a sequence, so it is not enumerable by increment.
 * The format is fixed by bookings_booking_code_format (migration 0008).
 */
export function generateBookingCode(serviceDate: string): string {
  const year = serviceDate.slice(0, 4);
  let digits = '';
  for (let i = 0; i < 7; i += 1) digits += String(randomInt(0, 10));
  return `FQ-${year}-${digits}`;
}

export type InsertBookingInput = {
  bookingCode: string;
  farmerId: string;
  centreId: string;
  cropId: string;
  seasonId: string;
  marketingYear: string;
  laneNo: number;
  quantityKg: number;
  serviceDate: string;
  startAt: Date;
  endAt: Date;
  processingMinutes: number;
  occupancyMinutes: number;
  tokenNumber: number;
  slotConfigId: string;
};

export type BookingRow = {
  id: string;
  booking_code: string;
  token_number: number;
  lane_no: number;
  service_date: string;
  /** The same date as a DATE, for index-usable predicates. Never serialised. */
  service_date_on: Date;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  estimated_processing_minutes: number;
  occupancy_minutes: number;
  status: string;
  requested_quantity_kg: number;
  marketing_year: string;
};

export async function insertBooking(
  client: PoolClient,
  input: InsertBookingInput,
): Promise<BookingRow> {
  const res = await client.query(
    `INSERT INTO bookings
       (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
        lane_no, requested_quantity_kg, service_date, scheduled_start_at,
        scheduled_end_at, estimated_processing_minutes, occupancy_minutes,
        token_number, slot_config_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,'CONFIRMED')
     RETURNING id, booking_code, token_number, lane_no, service_date::text AS service_date,
               scheduled_start_at, scheduled_end_at, estimated_processing_minutes,
               occupancy_minutes, status, requested_quantity_kg, marketing_year`,
    [
      input.bookingCode, input.farmerId, input.centreId, input.cropId, input.seasonId,
      input.marketingYear, input.laneNo, input.quantityKg, input.serviceDate,
      input.startAt, input.endAt, input.processingMinutes, input.occupancyMinutes,
      input.tokenNumber, input.slotConfigId,
    ],
  );
  return res.rows[0] as BookingRow;
}

export async function bumpDailyCapacity(
  client: PoolClient,
  centreId: string,
  serviceDate: string,
  quantityKg: number,
  occupancyMinutes: number,
  direction: 1 | -1,
): Promise<void> {
  // Every operand is cast explicitly: untyped parameters on both sides of a
  // multiplication leave PostgreSQL unable to resolve the operator.
  await client.query(
    `UPDATE centre_daily_capacity
        SET booked_quantity_kg = booked_quantity_kg + ($3::numeric * $4::int),
            booked_minutes     = booked_minutes     + ($5::int * $4::int),
            booking_count      = booking_count      + $4::int,
            updated_at = now()
      WHERE centre_id = $1 AND service_date = $2::date`,
    [centreId, serviceDate, quantityKg, direction, occupancyMinutes],
  );
}

export async function recordStatusChange(
  client: PoolClient,
  bookingId: string,
  from: string | null,
  to: string,
  changedByUserId: string | null,
  reason: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by_user_id, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [bookingId, from, to, changedByUserId, reason],
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type BookingView = {
  /**
   * Internal identifiers. Present on the ROW so one query serves both the
   * farmer view and the officer view; the response mappers build their output
   * field by field and never spread this object, so no UUID reaches the wire.
   */
  id: string;
  centre_id: string;
  crop_id: string;
  season_id: string;
  /** Rendered date, for the wire. */
  booking_code: string;
  token_number: number;
  lane_no: number;
  service_date: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  estimated_processing_minutes: number;
  occupancy_minutes: number;
  status: string;
  requested_quantity_kg: number;
  marketing_year: string;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  centre_code: string;
  centre_name: string;
  centre_timezone: string;
  centre_storage_check_mode: string;
  centre_data_type: string;
  district_name: string;
  crop_code: string;
  crop_name: string;
  season_code: string;
  farmer_id: string;
  buffer_minutes: number;
};

/**
 * The one definition of a booking row. Exported so the officer module composes
 * it in a subquery rather than restating the joins (Phase 8 design §13).
 */
export const BOOKING_SELECT = `
  SELECT b.id, b.centre_id, b.crop_id, b.season_id,
         b.booking_code, b.token_number, b.lane_no, b.service_date::text AS service_date,
         -- The SAME date, uncast. Filtering on service_date (text) puts a cast
         -- on the indexed column and makes bookings_centre_date_start_idx
         -- unusable for the date component; a predicate must use this one.
         b.service_date AS service_date_on,
         b.scheduled_start_at, b.scheduled_end_at, b.estimated_processing_minutes,
         b.occupancy_minutes, b.status, b.requested_quantity_kg, b.marketing_year,
         b.cancelled_at, b.cancellation_reason, b.farmer_id,
         (b.occupancy_minutes - b.estimated_processing_minutes) AS buffer_minutes,
         pc.code AS centre_code, pc.name AS centre_name, pc.timezone AS centre_timezone,
         pc.storage_check_mode AS centre_storage_check_mode, pc.data_type AS centre_data_type,
         d.name AS district_name,
         cr.code AS crop_code, cr.canonical_name AS crop_name, s.code AS season_code
    FROM bookings b
    JOIN procurement_centres pc ON pc.id = b.centre_id
    JOIN districts d ON d.id = pc.district_id
    JOIN crops cr ON cr.id = b.crop_id
    JOIN seasons s ON s.id = b.season_id`;

/**
 * Ownership is part of the QUERY, not a check afterwards.
 *
 * A booking belonging to someone else simply does not match, so the caller
 * cannot distinguish "does not exist" from "not yours" — which is what stops
 * booking codes being probed for existence.
 */
export async function findOwnedByCode(
  bookingCode: string,
  farmerId: string,
  db: PoolClient | null = null,
): Promise<BookingView | null> {
  const run = db ? db.query.bind(db) : query;
  const res = await run(`${BOOKING_SELECT} WHERE b.booking_code = $1 AND b.farmer_id = $2`, [
    bookingCode,
    farmerId,
  ]);
  return (res.rows[0] as BookingView) ?? null;
}

export async function findOwnedByCodeForUpdate(
  client: PoolClient,
  bookingCode: string,
  farmerId: string,
): Promise<BookingView | null> {
  const res = await client.query(
    `${BOOKING_SELECT} WHERE b.booking_code = $1 AND b.farmer_id = $2 FOR UPDATE OF b`,
    [bookingCode, farmerId],
  );
  return (res.rows[0] as BookingView) ?? null;
}

export async function listForFarmer(
  farmerId: string,
  includeInactive: boolean,
): Promise<BookingView[]> {
  const res = await query(
    `${BOOKING_SELECT}
      WHERE b.farmer_id = $1
        AND ($2::boolean OR b.status = ANY($3::text[]))
      ORDER BY b.scheduled_start_at DESC
      LIMIT 100`,
    [farmerId, includeInactive, ACTIVE_STATUSES as unknown as string[]],
  );
  return res.rows as BookingView[];
}

export async function farmerIdForUser(
  userId: string,
  db: PoolClient | null = null,
): Promise<string | null> {
  const run = db ? db.query.bind(db) : query;
  const res = await run('SELECT id FROM farmers WHERE user_id = $1', [userId]);
  return (res.rows[0] as { id: string })?.id ?? null;
}

/** Resolves the crop's eligibility at a centre and its official season/year. */
export async function resolveCropAtCentre(
  centreId: string,
  cropId: string,
  onDate: string,
  db: PoolClient | null = null,
): Promise<{ seasonId: string; seasonCode: string; marketingYear: string; cropName: string } | null> {
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `SELECT ccc.season_id, s.code AS season_code, ccc.marketing_year, cr.canonical_name
       FROM centre_crop_configurations ccc
       JOIN seasons s ON s.id = ccc.season_id
       JOIN crops cr ON cr.id = ccc.crop_id
      WHERE ccc.centre_id = $1 AND ccc.crop_id = $2 AND ccc.is_active
        AND ccc.effective_from <= $3::date
        AND (ccc.effective_to IS NULL OR ccc.effective_to > $3::date)
      LIMIT 1`,
    [centreId, cropId, onDate],
  );
  const r = res.rows[0] as
    | { season_id: string; season_code: string; marketing_year: string; canonical_name: string }
    | undefined;
  return r
    ? {
        seasonId: r.season_id,
        seasonCode: r.season_code,
        marketingYear: r.marketing_year,
        cropName: r.canonical_name,
      }
    : null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export type IdempotencyOutcome =
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' };

export async function claimIdempotencyKey(
  client: PoolClient,
  key: string,
  userId: string,
  endpoint: string,
  requestHash: Buffer,
): Promise<IdempotencyOutcome> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, expires_at)
     VALUES ($1,$2,$3,$4, now() + interval '24 hours')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, userId, endpoint, requestHash],
  );
  if (inserted.rowCount === 1) return { kind: 'fresh' };

  const existing = await client.query(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
    [key],
  );
  const row = existing.rows[0] as
    | { request_hash: Buffer; response_status: number | null; response_body: unknown }
    | undefined;
  if (!row) return { kind: 'fresh' };

  // Same key with a different body is a caller error, not a replay.
  if (!row.request_hash.equals(requestHash)) return { kind: 'conflict' };
  if (row.response_status === null) return { kind: 'conflict' };

  return { kind: 'replay', status: row.response_status, body: row.response_body };
}

export async function storeIdempotentResponse(
  client: PoolClient,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE key = $1`,
    [key, status, JSON.stringify(body)],
  );
}
