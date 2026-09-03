/**
 * Queue reads — SQL.
 *
 * ONE query loads one (centre, service_date). Everything else — position, ETA,
 * lane cursors — is pure computation in engines/queue.ts. That split is what
 * makes the algorithm testable without a database and keeps a polling endpoint
 * down to a single round trip.
 *
 * Nothing in this file writes. A poll must never mutate state (architecture
 * §14.5), and the simplest way to guarantee that is for the read path to have
 * no write in it at all.
 */
import type { PoolClient } from 'pg';
import { query } from '../../core/db.ts';
import type { QueueMember } from '../../engines/queue.ts';

/** A queue row plus the identifying detail an officer needs to call a farmer. */
export type QueueRow = QueueMember & {
  farmerId: string;
  farmerName: string;
  farmerPhone: string;
};

/**
 * Every booking at one centre on one day, with its recorded service timestamps.
 *
 * The status filter is deliberately WIDE — terminal bookings are returned too.
 * Membership is decided in one place, `engines/queue.ts::queueStateOf()`, from
 * the timestamps. Filtering here as well would put the rule in two places and
 * let them drift.
 *
 * Uses bookings_centre_date_start_idx (centre_id, service_date,
 * scheduled_start_at). `service_date` is compared UNCAST — casting the indexed
 * column loses the index, which is the defect Phase 8 §2.2 found and fixed.
 */
export async function loadCentreDay(
  centreId: string,
  serviceDate: string,
  db: PoolClient | null = null,
): Promise<QueueRow[]> {
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `SELECT b.booking_code, b.token_number, b.lane_no, b.status,
            b.scheduled_start_at, b.estimated_processing_minutes,
            b.farmer_id,
            pr.service_started_at, pr.service_ended_at,
            u.full_name AS farmer_name, u.phone_e164 AS farmer_phone
       FROM bookings b
       LEFT JOIN procurements pr ON pr.booking_id = b.id
       JOIN farmers f ON f.id = b.farmer_id
       JOIN users u ON u.id = f.user_id
      WHERE b.centre_id = $1 AND b.service_date = $2::date
      ORDER BY b.scheduled_start_at, b.lane_no, b.token_number`,
    [centreId, serviceDate],
  );

  return (
    res.rows as Array<{
      booking_code: string;
      token_number: number;
      lane_no: number;
      status: string;
      scheduled_start_at: Date;
      estimated_processing_minutes: number;
      farmer_id: string;
      service_started_at: Date | null;
      service_ended_at: Date | null;
      farmer_name: string;
      farmer_phone: string;
    }>
  ).map((r) => ({
    bookingCode: r.booking_code,
    tokenNumber: Number(r.token_number),
    laneNo: Number(r.lane_no),
    status: r.status,
    scheduledStartAt: r.scheduled_start_at,
    processingMinutes: Number(r.estimated_processing_minutes),
    serviceStartedAt: r.service_started_at,
    serviceEndedAt: r.service_ended_at,
    farmerId: r.farmer_id,
    farmerName: r.farmer_name,
    farmerPhone: r.farmer_phone,
  }));
}

/**
 * Locates one of the farmer's OWN bookings.
 *
 * Ownership is part of the query, exactly as Phase 7 and 8 do it: a booking
 * belonging to someone else simply does not match, so the caller cannot tell
 * "not yours" from "does not exist" (architecture §5.2).
 */
export async function findOwnBookingForQueue(
  farmerUserId: string,
  bookingCode: string,
): Promise<{ centreId: string; serviceDate: string; farmerId: string } | null> {
  const res = await query(
    `SELECT b.centre_id, b.service_date::text AS service_date, b.farmer_id
       FROM bookings b
       JOIN farmers f ON f.id = b.farmer_id
      WHERE b.booking_code = $1 AND f.user_id = $2`,
    [bookingCode, farmerUserId],
  );
  const r = res.rows[0] as
    | { centre_id: string; service_date: string; farmer_id: string }
    | undefined;
  return r ? { centreId: r.centre_id, serviceDate: r.service_date, farmerId: r.farmer_id } : null;
}
