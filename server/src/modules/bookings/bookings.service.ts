/**
 * Booking orchestration.
 *
 * Availability, creation (with bounded retry) and cancellation. The scheduling
 * maths lives in engines/scheduling.ts; the locks live in the repository; this
 * file is the business rules and the transaction boundaries.
 */
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { withTransaction } from '../../core/db.ts';
import { AppError, ErrorCodes, conflict, notFound, unprocessable } from '../../core/errors.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import {
  addDays,
  findEarliest,
  localDateOf,
  durationBreakdown,
} from '../../engines/scheduling.ts';
import type { Candidate, DayInput } from '../../engines/scheduling.ts';
import * as repo from './bookings.repository.ts';
import { notifyBookingConfirmed } from '../notifications/notifications.service.ts';
import type { BookingView, CentreContext } from './bookings.repository.ts';

/** Never retry indefinitely (design §7). */
const MAX_BOOKING_ATTEMPTS = 3;

export type Ctx = { ip: string | null; requestId: string | null; userId: string };

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

async function requireCentre(centreId: string, onDate: string, db: PoolClient | null = null) {
  const centre = await repo.loadCentreContext(centreId, onDate, db);
  if (!centre || centre.status !== 'ACTIVE') {
    throw unprocessable(ErrorCodes.CENTRE_NOT_AVAILABLE, 'Centre is not available');
  }
  if (centre.lanes.length === 0) {
    throw unprocessable(ErrorCodes.CENTRE_NOT_AVAILABLE, 'Centre has no active service lane');
  }
  return centre;
}

async function requireCropAtCentre(
  centreId: string,
  cropId: string,
  onDate: string,
  db: PoolClient | null = null,
) {
  const crop = await repo.resolveCropAtCentre(centreId, cropId, onDate, db);
  if (!crop) {
    throw unprocessable(
      ErrorCodes.CROP_NOT_CONFIGURED_AT_CENTRE,
      'This centre does not accept that crop for the current season',
    );
  }
  return crop;
}

/** Today in the centre's local calendar — never the server's local date. */
function centreToday(centre: CentreContext, now: Date): string {
  return localDateOf(now, centre.timezone);
}

/**
 * Resolves the centre for a requested date, in the right ORDER.
 *
 * Centre configuration is temporal, so loading it for an out-of-range date
 * finds nothing and would misreport a past date as "centre not available".
 * The centre is therefore first resolved as of TODAY — which is what defines
 * the horizon — the requested date is validated against it, and only then is
 * the configuration in force on the service date loaded.
 */
async function resolveCentreForDate(
  centreId: string,
  requestedDate: string | undefined,
  now: Date,
  db: PoolClient | null,
): Promise<{ centre: CentreContext; fromDate: string }> {
  const todayUtc = localDateOf(now, 'UTC');
  const asOfToday = await requireCentre(centreId, todayUtc, db);

  const fromDate = requestedDate ?? centreToday(asOfToday, now);
  assertWithinHorizon(asOfToday, fromDate, now);

  // Now that the date is known valid, use the configuration in force on it.
  const centre = fromDate === todayUtc ? asOfToday : await requireCentre(centreId, fromDate, db);
  return { centre, fromDate };
}

function assertWithinHorizon(centre: CentreContext, fromDate: string, now: Date) {
  const today = centreToday(centre, now);
  if (fromDate < today) {
    throw unprocessable(ErrorCodes.OUTSIDE_BOOKING_HORIZON, 'Date is in the past');
  }
  const last = addDays(today, centre.config.bookingHorizonDays);
  if (fromDate > last) {
    throw unprocessable(ErrorCodes.OUTSIDE_BOOKING_HORIZON, 'Date is beyond the booking horizon', {
      horizonDays: centre.config.bookingHorizonDays,
      latestDate: last,
    });
  }
}

/** Storage is ADVISORY everywhere; the honest answer is a reason, not a number. */
function storageCheckFor(centre: CentreContext) {
  if (centre.storageCheckMode === 'DISABLED') {
    return { checkMode: 'DISABLED', status: 'NOT_EVALUATED', reasonCode: null as string | null };
  }
  return {
    checkMode: centre.storageCheckMode,
    status: 'NOT_AVAILABLE',
    reasonCode: 'NO_CAPACITY_DATA_FOR_CENTRE',
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export async function findAvailability(input: {
  centreId: string;
  cropId: string;
  quantityKg: number;
  fromDate?: string;
  now?: Date;
  db?: PoolClient | null;
}) {
  const now = input.now ?? new Date();
  const db = input.db ?? null;

  const { centre, fromDate } = await resolveCentreForDate(input.centreId, input.fromDate, now, db);
  const crop = await requireCropAtCentre(input.centreId, input.cropId, fromDate, db);

  const loadDay = async (serviceDate: string): Promise<DayInput> => ({
    serviceDate,
    timeZone: centre.timezone,
    hours: centre.hours,
    holidays: centre.holidays,
    lanes: centre.lanes,
    existing: await repo.loadDayOccupancy(centre.centreId, serviceDate, db),
  });

  const result = await findEarliest(
    fromDate,
    centre.config.bookingHorizonDays,
    input.quantityKg,
    centre.config,
    now,
    loadDay,
  );

  const duration = durationBreakdown(input.quantityKg, centre.config);

  return { centre, crop, result, duration, storageCheck: storageCheckFor(centre), now };
}

export function candidateToView(candidate: Candidate, centre: CentreContext) {
  return {
    serviceDate: candidate.serviceDate,
    laneNo: candidate.laneNo,
    scheduledStartAt: candidate.startAt.toISOString(),
    // Deliberately equal to the start: no arrival lead time is configured, so
    // none is invented (design §11).
    estimatedApproachAt: candidate.startAt.toISOString(),
    processingEndAt: candidate.processingEndAt.toISOString(),
    windowEndAt: candidate.endAt.toISOString(),
    processingMinutes: candidate.processingMinutes,
    bufferMinutes: candidate.bufferMinutes,
    occupancyMinutes: candidate.occupancyMinutes,
    centreTimezone: centre.timezone,
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function hashRequest(body: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest();
}

export type CreateInput = {
  centreId: string;
  cropId: string;
  quantityKg: number;
  preferredDate?: string;
  idempotencyKey: string;
  requestHash: Buffer;
};

export type CreateResult = { status: number; body: unknown };

export async function createBooking(input: CreateInput, ctx: Ctx): Promise<CreateResult> {
  let lastConflict: AppError | null = null;

  for (let attempt = 1; attempt <= MAX_BOOKING_ATTEMPTS; attempt += 1) {
    try {
      return await attemptCreate(input, ctx, attempt);
    } catch (err) {
      // Only an overlap race is worth recomputing for. Everything else is final.
      if (err instanceof AppError && err.code === ErrorCodes.SLOT_NO_LONGER_AVAILABLE) {
        lastConflict = err;
        continue;
      }
      throw err;
    }
  }

  throw (
    lastConflict ??
    conflict(ErrorCodes.SLOT_NO_LONGER_AVAILABLE, 'Could not secure a window after several attempts')
  );
}

async function attemptCreate(input: CreateInput, ctx: Ctx, attempt: number): Promise<CreateResult> {
  return withTransaction(async (client) => {
    // 0. Idempotency, before anything else can have an effect.
    const claim = await repo.claimIdempotencyKey(
      client,
      input.idempotencyKey,
      ctx.userId,
      'POST /api/v1/bookings',
      input.requestHash,
    );
    if (claim.kind === 'replay') return { status: claim.status, body: claim.body };
    if (claim.kind === 'conflict') {
      throw conflict(
        ErrorCodes.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used with a different request',
      );
    }

    const farmerId = await repo.farmerIdForUser(ctx.userId, client);
    if (!farmerId) throw notFound('No farmer profile for this account');

    const now = new Date();

    // 1. Re-derive availability INSIDE the transaction. The client's preference
    //    is an input to the search, never a value we trust.
    const { centre, fromDate } = await resolveCentreForDate(
      input.centreId,
      input.preferredDate,
      now,
      client,
    );
    const crop = await requireCropAtCentre(input.centreId, input.cropId, fromDate, client);

    // 2. LOCK 1 — serialises this centre-day against every other booker.
    await repo.lockDailyCapacity(client, centre.centreId, fromDate);

    // 3. Storage: ADVISORY, so nothing is enforced and nothing is invented.
    const storageCheck = storageCheckFor(centre);

    // 4. Search, now under the lock.
    const search = await findEarliest(
      fromDate,
      centre.config.bookingHorizonDays,
      input.quantityKg,
      centre.config,
      now,
      async (serviceDate) => ({
        serviceDate,
        timeZone: centre.timezone,
        hours: centre.hours,
        holidays: centre.holidays,
        lanes: centre.lanes,
        existing: await repo.loadDayOccupancy(centre.centreId, serviceDate, client),
      }),
    );

    if (!search.found) {
      throw unprocessable(ErrorCodes.NO_AVAILABILITY, 'No available window within the horizon', {
        reasonCode: search.reason,
        horizonDays: centre.config.bookingHorizonDays,
      });
    }

    const candidate = search.candidate;

    // The chosen day may differ from the requested one; lock that day too.
    if (candidate.serviceDate !== fromDate) {
      await repo.lockDailyCapacity(client, centre.centreId, candidate.serviceDate);
    }

    const tokenNumber = await repo.nextTokenNumber(client, centre.centreId, candidate.serviceDate);

    // 5. Insert. The EXCLUDE constraint is the final arbiter.
    let row;
    try {
      row = await repo.insertBooking(client, {
        bookingCode: repo.generateBookingCode(candidate.serviceDate),
        farmerId,
        centreId: centre.centreId,
        cropId: input.cropId,
        seasonId: crop.seasonId,
        marketingYear: crop.marketingYear,
        laneNo: candidate.laneNo,
        quantityKg: input.quantityKg,
        serviceDate: candidate.serviceDate,
        startAt: candidate.startAt,
        endAt: candidate.endAt,
        processingMinutes: candidate.processingMinutes,
        occupancyMinutes: candidate.occupancyMinutes,
        tokenNumber,
        slotConfigId: centre.slotConfigId,
      });
    } catch (err) {
      throw translateInsertError(err, attempt);
    }

    // 6. Counters.
    await repo.bumpDailyCapacity(
      client,
      centre.centreId,
      candidate.serviceDate,
      input.quantityKg,
      candidate.occupancyMinutes,
      1,
    );

    // 7. History and audit, same transaction.
    await repo.recordStatusChange(client, row.id, null, 'CONFIRMED', ctx.userId, 'Booking created');
    await writeAudit(client, {
      action: AuditActions.BOOKING_CREATED,
      entityType: 'booking',
      entityId: row.id,
      actorUserId: ctx.userId,
      actorRole: 'FARMER',
      actorIp: ctx.ip,
      requestId: ctx.requestId,
      after: {
        bookingCode: row.booking_code,
        centre: centre.code,
        serviceDate: candidate.serviceDate,
        laneNo: candidate.laneNo,
        quantityKg: input.quantityKg,
        processingMinutes: candidate.processingMinutes,
        occupancyMinutes: candidate.occupancyMinutes,
      },
      metadata: { attempt },
    });

    // 7b. Outbox, SAME transaction (architecture §13.1 step 9, §16.1). No
    // network call happens here; a row is written. If this throws for anything
    // other than a duplicate, the booking rolls back with it.
    await notifyBookingConfirmed(client, row.id);

    const body = {
      data: bookingResponse(row, centre, crop.cropName, crop.seasonCode, storageCheck),
    };

    // 8. Remember the response so a retry replays rather than re-books.
    await repo.storeIdempotentResponse(client, input.idempotencyKey, 201, body);

    return { status: 201, body };
  });
}

/** Maps PostgreSQL integrity errors onto the documented failure modes. */
function translateInsertError(err: unknown, attempt: number): AppError {
  const e = err as { code?: string; constraint?: string };

  if (e.code === '23P01') {
    // Exclusion violation: either the lane or the farmer's own time.
    if (e.constraint === 'bookings_no_farmer_overlap') {
      return conflict(
        ErrorCodes.FARMER_TIME_CONFLICT,
        'This overlaps another of your active bookings',
      );
    }
    return conflict(
      ErrorCodes.SLOT_NO_LONGER_AVAILABLE,
      `Window was taken during booking (attempt ${attempt})`,
    );
  }

  if (e.code === '23505') {
    if (e.constraint === 'bookings_no_duplicate_active_per_farmer_centre_crop_date') {
      return conflict(
        ErrorCodes.DUPLICATE_ACTIVE_BOOKING,
        'You already have an active booking for this crop at this centre on that date',
      );
    }
    // A booking_code or token collision is transient; recompute and retry.
    return conflict(ErrorCodes.SLOT_NO_LONGER_AVAILABLE, 'Identifier collision; retrying');
  }

  if (e.code === '23514') {
    return new AppError(400, ErrorCodes.VALIDATION_FAILED, 'Booking violates a database constraint');
  }

  throw err;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function bookingResponse(
  row: {
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
  },
  centre: { code: string; name: string; timezone: string; districtName?: string; dataType?: string },
  cropName: string,
  seasonCode: string,
  storageCheck: ReturnType<typeof storageCheckFor>,
) {
  const start = new Date(row.scheduled_start_at);
  const processingEnd = new Date(
    start.getTime() + Number(row.estimated_processing_minutes) * 60_000,
  );

  return {
    bookingCode: row.booking_code,
    tokenNumber: row.token_number,
    status: row.status,
    displayStatus: displayStatusFor(row.status),
    centre: {
      code: centre.code,
      name: centre.name,
      district: centre.districtName ?? null,
      timezone: centre.timezone,
      dataType: centre.dataType ?? null,
    },
    crop: { name: cropName, season: seasonCode, marketingYear: row.marketing_year },
    quantityKg: Number(row.requested_quantity_kg),
    serviceDate: row.service_date,
    laneNo: row.lane_no,
    scheduledStartAt: start.toISOString(),
    estimatedApproachAt: start.toISOString(),
    processingEndAt: processingEnd.toISOString(),
    windowEndAt: new Date(row.scheduled_end_at).toISOString(),
    processingMinutes: Number(row.estimated_processing_minutes),
    bufferMinutes: Number(row.occupancy_minutes) - Number(row.estimated_processing_minutes),
    occupancyMinutes: Number(row.occupancy_minutes),
    storageCheck,
  };
}

/**
 * displayStatus is DERIVED, never stored (D-4). Phase 7 maps only what it can
 * know; APPROACHING and WAITING become meaningful in Phase 9.
 */
export function displayStatusFor(status: string): string {
  switch (status) {
    case 'CONFIRMED':
      return 'BOOKED';
    case 'ARRIVED':
      return 'WAITING';
    default:
      return status;
  }
}

function viewToResponse(v: BookingView) {
  return bookingResponse(
    v,
    {
      code: v.centre_code,
      name: v.centre_name,
      timezone: v.centre_timezone,
      districtName: v.district_name,
      dataType: v.centre_data_type,
    },
    v.crop_name,
    v.season_code,
    v.centre_storage_check_mode === 'DISABLED'
      ? { checkMode: 'DISABLED', status: 'NOT_EVALUATED', reasonCode: null }
      : {
          checkMode: v.centre_storage_check_mode,
          status: 'NOT_AVAILABLE',
          reasonCode: 'NO_CAPACITY_DATA_FOR_CENTRE',
        },
  );
}

export async function listMyBookings(userId: string, includeInactive: boolean) {
  const farmerId = await repo.farmerIdForUser(userId);
  if (!farmerId) throw notFound('No farmer profile for this account');
  const rows = await repo.listForFarmer(farmerId, includeInactive);
  return rows.map(viewToResponse);
}

export async function getMyBooking(userId: string, bookingCode: string) {
  const farmerId = await repo.farmerIdForUser(userId);
  if (!farmerId) throw notFound('No farmer profile for this account');
  const row = await repo.findOwnedByCode(bookingCode, farmerId);
  // Someone else's booking is indistinguishable from one that does not exist.
  if (!row) throw notFound('Booking not found');
  return viewToResponse(row);
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export async function cancelBooking(
  userId: string,
  bookingCode: string,
  reason: string | null,
  ctx: Ctx,
) {
  return withTransaction(async (client) => {
    const farmerId = await repo.farmerIdForUser(userId, client);
    if (!farmerId) throw notFound('No farmer profile for this account');

    const booking = await repo.findOwnedByCodeForUpdate(client, bookingCode, farmerId);
    if (!booking) throw notFound('Booking not found');

    if (booking.status !== 'CONFIRMED') {
      throw conflict(
        ErrorCodes.INVALID_STATE_TRANSITION,
        `A booking in state ${booking.status} cannot be cancelled by the farmer`,
      );
    }

    const centre = await repo.loadCentreContext(
      (await client.query('SELECT centre_id FROM bookings WHERE booking_code = $1', [bookingCode]))
        .rows[0].centre_id as string,
      booking.service_date,
      client,
    );
    const cutoffHours = centre?.config.cancellationCutoffHours ?? 24;

    const deadline = new Date(
      new Date(booking.scheduled_start_at).getTime() - cutoffHours * 3_600_000,
    );
    if (new Date() >= deadline) {
      throw conflict(ErrorCodes.CANCELLATION_WINDOW_CLOSED, 'The cancellation window has closed', {
        cutoffHours,
        deadline: deadline.toISOString(),
      });
    }

    const updated = await client.query(
      `UPDATE bookings
          SET status = 'CANCELLED', cancelled_at = now(),
              cancellation_reason = $2, cancelled_by_user_id = $3
        WHERE booking_code = $1
        RETURNING id`,
      [bookingCode, reason, userId],
    );
    const bookingId = (updated.rows[0] as { id: string }).id;

    // Freeing capacity is a counter update; the exclusion constraints are
    // partial on active statuses, so the interval is released automatically.
    await repo.bumpDailyCapacity(
      client,
      centre!.centreId,
      booking.service_date,
      Number(booking.requested_quantity_kg),
      Number(booking.occupancy_minutes),
      -1,
    );

    await repo.recordStatusChange(client, bookingId, 'CONFIRMED', 'CANCELLED', userId, reason);
    await writeAudit(client, {
      action: AuditActions.BOOKING_CANCELLED,
      entityType: 'booking',
      entityId: bookingId,
      actorUserId: userId,
      actorRole: 'FARMER',
      actorIp: ctx.ip,
      requestId: ctx.requestId,
      before: { status: 'CONFIRMED' },
      after: { status: 'CANCELLED', reason },
    });

    return { bookingCode, status: 'CANCELLED', displayStatus: 'CANCELLED' };
  });
}
