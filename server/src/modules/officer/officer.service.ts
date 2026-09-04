/**
 * Officer operations — orchestration.
 *
 * Every mutating function in this file has the same shape, and the order is not
 * negotiable:
 *
 *   withTransaction
 *     -> LOCK the booking row (also applies centre scope; null means 404)
 *     -> check the CURRENT status, to produce a good error code
 *     -> mutate
 *     -> booking_status_history
 *     -> audit, in the SAME transaction (P-9)
 *
 * The status check is a courtesy, not the guarantee. `bookings_status_transition_guard`
 * refuses any pair absent from `booking_status_transitions` no matter what this
 * file does, which is why a test can bypass the service entirely and still find
 * the transition refused.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../../core/db.ts';
import { ErrorCodes, badRequest, conflict, notFound } from '../../core/errors.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import type { AuditAction } from '../../core/audit.ts';
import { bumpDailyCapacity, recordStatusChange } from '../bookings/bookings.repository.ts';
import { displayStatusFor } from '../bookings/bookings.service.ts';
import {
  computePayment,
  deriveQualityStatus,
  paiseToRupeeString,
  resolveMspRate,
} from '../../engines/procurement.ts';
import * as repo from './officer.repository.ts';
import {
  notifyBookingArrived,
  notifyPaymentBlocked,
  notifyPaymentUpdated,
  notifyProcurementCompleted,
} from '../notifications/notifications.service.ts';
import type { CentreScope, OfficerBookingView, PaymentRow, ProcurementRow } from './officer.repository.ts';

export type OfficerCtx = {
  userId: string;
  ip: string | null;
  requestId: string | null;
  scope: CentreScope;
  role: 'OFFICER' | 'ADMIN';
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function toOfficerView(row: OfficerBookingView) {
  return {
    bookingCode: row.booking_code,
    tokenNumber: row.token_number,
    status: row.status,
    displayStatus: displayStatusFor(row.status),
    farmer: {
      name: row.farmer_name,
      phone: row.farmer_phone,
      village: row.village_name,
      district: row.district_name,
    },
    crop: {
      name: row.crop_name,
      season: row.season_code,
      marketingYear: row.marketing_year,
    },
    centre: { code: row.centre_code, name: row.centre_name, timezone: row.centre_timezone },
    requestedQuantityKg: Number(row.requested_quantity_kg),
    serviceDate: row.service_date,
    laneNo: row.lane_no,
    scheduledStartAt: new Date(row.scheduled_start_at).toISOString(),
    windowEndAt: new Date(row.scheduled_end_at).toISOString(),
    processingMinutes: Number(row.estimated_processing_minutes),
  };
}

function num(v: string | null): number | null {
  return v === null ? null : Number(v);
}

export function toProcurementView(p: ProcurementRow) {
  return {
    status: p.status,
    qualityStatus: p.quality_status,
    arrivedAt: p.arrived_at?.toISOString() ?? null,
    serviceStartedAt: p.service_started_at?.toISOString() ?? null,
    serviceEndedAt: p.service_ended_at?.toISOString() ?? null,
    completedAt: p.completed_at?.toISOString() ?? null,
    grossQuantityKg: num(p.gross_quantity_kg),
    acceptedQuantityKg: num(p.accepted_quantity_kg),
    rejectedQuantityKg: num(p.rejected_quantity_kg),
    grade: p.grade,
    moisturePercent: num(p.moisture_percent),
    rejectionReason: p.rejection_reason,
  };
}

/**
 * `blockedReason` is shown, not hidden. "We cannot price this until a grade is
 * recorded" is something the farmer is entitled to know, and P-8 requires it as
 * a code the UI can translate rather than as English prose.
 */
export function toPaymentView(p: PaymentRow | null) {
  if (!p) return null;
  const amount = num(p.amount_paise);
  return {
    status: p.status,
    blockedReason: p.blocked_reason,
    currency: p.currency,
    ratePerQuintalPaise: num(p.rate_per_quintal_paise_snapshot),
    baseAmountPaise: num(p.base_amount_paise),
    deductionsPaise: Number(p.deductions_paise),
    deductionBreakdown: p.deduction_breakdown,
    amountPaise: amount,
    amountRupees: amount === null ? null : paiseToRupeeString(amount),
    paymentReference: p.payment_reference,
    paidAt: p.paid_at?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Locks the booking and asserts its current status.
 *
 * A booking outside the caller's centre scope is indistinguishable from one
 * that does not exist — the scope is part of the locking query, so there is no
 * moment at which this function holds a row it must then refuse to admit to.
 */
async function lockInState(
  client: PoolClient,
  bookingCode: string,
  ctx: OfficerCtx,
  allowedFrom: readonly string[],
) {
  const booking = await repo.lockBooking(client, bookingCode, ctx.scope);
  if (!booking) throw notFound('Booking not found');

  if (!allowedFrom.includes(booking.status)) {
    throw conflict(
      ErrorCodes.INVALID_STATE_TRANSITION,
      `A booking in state ${booking.status} does not accept this operation`,
      { currentStatus: booking.status, expected: allowedFrom },
    );
  }
  return booking;
}

async function audit(
  client: PoolClient,
  ctx: OfficerCtx,
  action: AuditAction,
  bookingId: string,
  before: unknown,
  after: unknown,
  metadata: Record<string, unknown> = {},
) {
  await writeAudit(client, {
    action,
    entityType: 'booking',
    entityId: bookingId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    actorIp: ctx.ip,
    requestId: ctx.requestId,
    before,
    after,
    metadata,
  });
}

/** Re-reads the booking after a transition so the caller returns the new truth. */
async function viewAfter(client: PoolClient, bookingCode: string, ctx: OfficerCtx) {
  const row = await repo.findByCodeInCentres(bookingCode, ctx.scope, client);
  return toOfficerView(row!);
}

async function requireProcurement(
  bookingId: string,
  client: PoolClient | null = null,
): Promise<ProcurementRow> {
  const p = await repo.findProcurement(bookingId, client);
  if (!p) {
    // Reachable only if a booking left CONFIRMED without `arrive` creating the
    // row — which the state machine prevents. Refusing loudly beats writing a
    // weight onto a procurement that does not exist.
    throw notFound('No procurement record for this booking');
  }
  return p;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getBooking(bookingCode: string, ctx: OfficerCtx) {
  const row = await repo.findByCodeInCentres(bookingCode, ctx.scope);
  if (!row) throw notFound('Booking not found');
  const procurement = await repo.findProcurement(row.id);
  return {
    booking: toOfficerView(row),
    procurement: procurement ? toProcurementView(procurement) : null,
    payment: procurement ? toPaymentView(await repo.findPayment(procurement.id)) : null,
  };
}

export async function listDay(
  centreId: string,
  serviceDate: string,
  statuses: readonly string[] | null,
) {
  const rows = await repo.listCentreDay(centreId, serviceDate, statuses);
  return {
    centreId,
    serviceDate,
    count: rows.length,
    bookings: rows.map(toOfficerView),
  };
}

export async function search(q: string, ctx: OfficerCtx) {
  const trimmed = q.trim();
  const by: { bookingCode?: string; tokenNumber?: number; phoneE164?: string } = {};

  if (/^FQ-\d{4}-\d{7}$/.test(trimmed)) by.bookingCode = trimmed;
  else if (/^\d{1,6}$/.test(trimmed)) by.tokenNumber = Number(trimmed);
  else if (/^\d{10}$/.test(trimmed)) by.phoneE164 = `+91${trimmed}`;
  else return { query: trimmed, count: 0, bookings: [] };

  const rows = await repo.searchInCentres(ctx.scope, by);
  return { query: trimmed, count: rows.length, bookings: rows.map(toOfficerView) };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export async function recordArrival(bookingCode: string, ctx: OfficerCtx) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['CONFIRMED']);

    await repo.setBookingStatus(client, booking.id, 'ARRIVED');
    const procurement = await repo.createProcurement(
      client,
      booking.id,
      booking.centre_id,
      ctx.userId,
    );

    await recordStatusChange(client, booking.id, 'CONFIRMED', 'ARRIVED', ctx.userId, null);
    await audit(client, ctx, AuditActions.BOOKING_ARRIVED, booking.id, { status: 'CONFIRMED' }, {
      status: 'ARRIVED',
    });
    // Outbox, same transaction. No provider call here.
    await notifyBookingArrived(client, booking.id);

    return {
      booking: await viewAfter(client, bookingCode, ctx),
      procurement: toProcurementView(procurement),
    };
  });
}

export async function markNoShow(bookingCode: string, reason: string | null, ctx: OfficerCtx) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['CONFIRMED']);
    const view = await repo.findByCodeInCentres(bookingCode, ctx.scope, client);

    await repo.markNoShow(client, booking.id, ctx.userId);

    // The lane interval is released by the status change itself: the exclusion
    // constraints are partial on the active statuses and NO_SHOW is not one.
    // The daily counter is not automatic, so it is corrected here.
    await bumpDailyCapacity(
      client,
      booking.centre_id,
      view!.service_date,
      Number(view!.requested_quantity_kg),
      Number(view!.occupancy_minutes),
      -1,
    );

    await recordStatusChange(client, booking.id, 'CONFIRMED', 'NO_SHOW', ctx.userId, reason);
    await audit(
      client,
      ctx,
      AuditActions.BOOKING_NO_SHOW,
      booking.id,
      { status: 'CONFIRMED' },
      { status: 'NO_SHOW', reason },
    );

    return { booking: await viewAfter(client, bookingCode, ctx) };
  });
}

export async function cancelAtCentre(bookingCode: string, reason: string | null, ctx: OfficerCtx) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, [
      'ARRIVED',
      'WEIGHING',
      'QUALITY_CHECK',
    ]);
    const view = await repo.findByCodeInCentres(bookingCode, ctx.scope, client);
    const from = booking.status;

    await repo.cancelAtCentre(client, booking.id, ctx.userId, reason);
    await bumpDailyCapacity(
      client,
      booking.centre_id,
      view!.service_date,
      Number(view!.requested_quantity_kg),
      Number(view!.occupancy_minutes),
      -1,
    );

    await recordStatusChange(client, booking.id, from, 'CANCELLED', ctx.userId, reason);
    await audit(
      client,
      ctx,
      AuditActions.BOOKING_CANCELLED_AT_CENTRE,
      booking.id,
      { status: from },
      { status: 'CANCELLED', reason },
    );

    return { booking: await viewAfter(client, bookingCode, ctx) };
  });
}

export async function startWeighing(bookingCode: string, ctx: OfficerCtx) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['ARRIVED']);
    await requireProcurement(booking.id, client);

    await repo.setBookingStatus(client, booking.id, 'WEIGHING');
    await repo.startWeighing(client, booking.id);

    await recordStatusChange(client, booking.id, 'ARRIVED', 'WEIGHING', ctx.userId, null);
    await audit(client, ctx, AuditActions.WEIGHING_STARTED, booking.id, { status: 'ARRIVED' }, {
      status: 'WEIGHING',
    });

    return {
      booking: await viewAfter(client, bookingCode, ctx),
      procurement: toProcurementView(await requireProcurement(booking.id, client)),
    };
  });
}

export async function recordWeight(bookingCode: string, grossKg: number, ctx: OfficerCtx) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['WEIGHING']);
    const procurement = await requireProcurement(booking.id, client);

    if (procurement.gross_quantity_kg !== null) {
      throw conflict(ErrorCodes.WEIGHT_ALREADY_RECORDED, 'Gross weight is already recorded');
    }

    await repo.recordGross(client, booking.id, grossKg);
    await repo.setBookingStatus(client, booking.id, 'QUALITY_CHECK');

    await recordStatusChange(client, booking.id, 'WEIGHING', 'QUALITY_CHECK', ctx.userId, null);
    await audit(
      client,
      ctx,
      AuditActions.WEIGHT_RECORDED,
      booking.id,
      { grossQuantityKg: null },
      { grossQuantityKg: grossKg },
    );

    return {
      booking: await viewAfter(client, bookingCode, ctx),
      procurement: toProcurementView(await requireProcurement(booking.id, client)),
    };
  });
}

export async function recordQuality(
  bookingCode: string,
  input: {
    acceptedKg: number;
    rejectedKg: number;
    grade: string | null;
    moisturePercent: number | null;
    rejectionReason: string | null;
  },
  ctx: OfficerCtx,
) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['QUALITY_CHECK']);
    const procurement = await requireProcurement(booking.id, client);

    const gross = Number(procurement.gross_quantity_kg);

    // procurements_quantity_balance permits a shortfall but not an overflow.
    // Checked here so the officer gets a code rather than a constraint violation.
    if (input.acceptedKg + input.rejectedKg > gross) {
      throw badRequest(
        ErrorCodes.QUANTITY_EXCEEDS_GROSS,
        'Accepted plus rejected exceeds the recorded gross weight',
      );
    }

    if (input.rejectedKg > 0 && !input.rejectionReason) {
      throw badRequest(
        ErrorCodes.REJECTION_REASON_REQUIRED,
        'A rejection reason is required when any quantity is rejected',
      );
    }
    if (input.rejectedKg === 0 && input.rejectionReason) {
      throw badRequest(
        ErrorCodes.REJECTION_REASON_NOT_APPLICABLE,
        'A rejection reason is not applicable when nothing is rejected',
      );
    }

    const qualityStatus = deriveQualityStatus(gross, input.acceptedKg, input.rejectedKg);

    await repo.recordQuality(client, booking.id, { ...input, qualityStatus });
    await repo.setBookingStatus(client, booking.id, 'PROCUREMENT_RECORDED');

    await recordStatusChange(
      client,
      booking.id,
      'QUALITY_CHECK',
      'PROCUREMENT_RECORDED',
      ctx.userId,
      null,
    );
    await audit(
      client,
      ctx,
      AuditActions.QUALITY_RECORDED,
      booking.id,
      { qualityStatus: procurement.quality_status },
      {
        qualityStatus,
        acceptedQuantityKg: input.acceptedKg,
        rejectedQuantityKg: input.rejectedKg,
        grade: input.grade,
      },
    );

    return {
      booking: await viewAfter(client, bookingCode, ctx),
      procurement: toProcurementView(await requireProcurement(booking.id, client)),
    };
  });
}

/**
 * Closes the procurement and prices it.
 *
 * The MSP decision is made by the pure engine from the candidates the
 * repository supplies; this function only records the outcome. When the rate
 * cannot be resolved the payment is written BLOCKED with the reason — the
 * booking still advances to PAYMENT_PENDING, because the procurement did
 * happen and the transition's own description says "computed or blocked".
 */
export async function completeProcurement(bookingCode: string, ctx: OfficerCtx) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['PROCUREMENT_RECORDED']);
    const view = await repo.findByCodeInCentres(bookingCode, ctx.scope, client);
    const procurement = await requireProcurement(booking.id, client);

    const completed = await repo.completeProcurement(client, booking.id);

    const candidates = await repo.activeMspCandidates(
      view!.crop_id,
      view!.season_id,
      view!.marketing_year,
      client,
    );
    const resolution = resolveMspRate(candidates, procurement.grade);

    let payment: PaymentRow;
    if (resolution.resolved) {
      payment = await repo.insertResolvedPayment(client, completed.id, resolution.rate.id);
      await audit(
        client,
        ctx,
        AuditActions.PAYMENT_COMPUTED,
        booking.id,
        null,
        {
          mspRateId: resolution.rate.id,
          ratePerQuintalPaise: resolution.rate.ratePerQuintalPaise,
          amountPaise: Number(payment.amount_paise),
        },
        { grade: procurement.grade },
      );
    } else {
      payment = await repo.insertBlockedPayment(client, completed.id, resolution.reason);
      await audit(client, ctx, AuditActions.PAYMENT_BLOCKED, booking.id, null, {
        blockedReason: resolution.reason,
      }, { grade: procurement.grade, candidateGrades: resolution.candidateGrades });
    }

    await repo.setBookingStatus(client, booking.id, 'PAYMENT_PENDING');
    await recordStatusChange(
      client,
      booking.id,
      'PROCUREMENT_RECORDED',
      'PAYMENT_PENDING',
      ctx.userId,
      null,
    );
    await audit(
      client,
      ctx,
      AuditActions.PROCUREMENT_COMPLETED,
      booking.id,
      { status: 'PROCUREMENT_RECORDED' },
      { status: 'PAYMENT_PENDING' },
    );

    // Outbox, same transaction. The farmer is told the procurement is recorded,
    // and separately why the payment could not be priced when that is the case.
    await notifyProcurementCompleted(client, booking.id, payment.status);
    if (payment.status === 'BLOCKED') {
      await notifyPaymentBlocked(client, booking.id, payment.id, payment.blocked_reason);
    }

    return {
      booking: await viewAfter(client, bookingCode, ctx),
      procurement: toProcurementView(completed),
      payment: toPaymentView(payment),
    };
  });
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * Payment status machine. Kept in code rather than a table because — unlike the
 * booking lifecycle — the schema models it as a CHECK constraint on a text
 * column, with no transition table to read. It is written out in full so the
 * permitted moves are visible in one place.
 *
 * PAID is terminal. BLOCKED has no outgoing edge here: unblocking requires the
 * MSP situation to change, which is an administrative act outside this phase
 * (design §7.6, risk R-8a).
 */
const PAYMENT_TRANSITIONS: Record<string, readonly string[]> = {
  BLOCKED: [],
  PENDING: ['INITIATED', 'ON_HOLD', 'FAILED'],
  INITIATED: ['PAID', 'FAILED', 'ON_HOLD'],
  ON_HOLD: ['PENDING', 'INITIATED', 'FAILED'],
  FAILED: ['PENDING', 'INITIATED'],
  PAID: [],
};

export async function updatePaymentStatus(
  bookingCode: string,
  to: string,
  reference: string | null,
  ctx: OfficerCtx,
) {
  return withTransaction(async (client) => {
    const booking = await lockInState(client, bookingCode, ctx, ['PAYMENT_PENDING']);
    const procurement = await requireProcurement(booking.id, client);

    const payment = await repo.lockPayment(client, procurement.id);
    if (!payment) throw conflict(ErrorCodes.PAYMENT_NOT_READY, 'No payment record for this booking');

    if (payment.status === 'BLOCKED') {
      throw conflict(ErrorCodes.PAYMENT_BLOCKED, 'This payment is blocked and cannot be advanced', {
        blockedReason: payment.blocked_reason,
      });
    }

    if (!(PAYMENT_TRANSITIONS[payment.status] ?? []).includes(to)) {
      throw conflict(
        ErrorCodes.INVALID_PAYMENT_TRANSITION,
        `A payment in state ${payment.status} cannot move to ${to}`,
        { currentStatus: payment.status },
      );
    }

    // payments_paid_requires_reference enforces this too; the check here turns a
    // constraint violation into a field-level 400.
    if (to === 'PAID' && !reference && !payment.payment_reference) {
      throw badRequest(
        ErrorCodes.PAYMENT_REFERENCE_REQUIRED,
        'A payment reference is required to mark a payment PAID',
      );
    }

    const updated = await repo.updatePaymentStatus(client, payment.id, to, reference, ctx.userId);

    await writeAudit(client, {
      action: AuditActions.PAYMENT_STATUS_UPDATED,
      entityType: 'payment',
      entityId: payment.id,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      actorIp: ctx.ip,
      requestId: ctx.requestId,
      before: { status: payment.status },
      after: { status: to, paymentReference: updated.payment_reference },
    });

    // Only PAID closes the booking. FAILED and ON_HOLD leave it open, because
    // the work genuinely is not finished.
    if (to === 'PAID') {
      await repo.setBookingStatus(client, booking.id, 'COMPLETED');
      await recordStatusChange(
        client,
        booking.id,
        'PAYMENT_PENDING',
        'COMPLETED',
        ctx.userId,
        null,
      );
      await audit(
        client,
        ctx,
        AuditActions.PROCUREMENT_COMPLETED,
        booking.id,
        { status: 'PAYMENT_PENDING' },
        { status: 'COMPLETED' },
      );
    }

    const view = toPaymentView(updated);
    await notifyPaymentUpdated(client, booking.id, payment.id, to, view!.amountRupees);

    return {
      booking: await viewAfter(client, bookingCode, ctx),
      payment: view,
    };
  });
}

// ---------------------------------------------------------------------------
// Centre overview
// ---------------------------------------------------------------------------

/**
 * Everything the centre dashboard shows that is NOT a booking: the shift hours
 * for one service date, where capacity comes from, the crops this centre
 * procures with their ACTIVE support price, and the storage position.
 *
 * Composition only — it computes no availability and books nothing. The caller
 * has already resolved the centre's timezone and checked that this actor may
 * act on the centre, so an unknown centre reaching here is a caller bug, not a
 * 404 to invent.
 *
 * Rates are OFFICIAL government data, returned in paise exactly as stored, with
 * a rupee string alongside for display. A crop the centre procures but for
 * which no ACTIVE rate is published is still listed, with a null rate and a
 * reason — dropping it would hide a real configuration gap from the officer.
 */
export async function centreOverview(centreId: string, serviceDate: string, timezone: string) {
  const [setup, rates] = await Promise.all([
    repo.centreDaySetup(centreId, serviceDate),
    repo.centreCropRates(centreId),
  ]);

  if (!setup) throw notFound('Centre not found');

  const open = setup.opens_at !== null && setup.closes_at !== null;

  return {
    centre: {
      id: centreId,
      name: setup.name,
      code: setup.code,
      dataType: setup.data_type,
      timezone,
    },
    serviceDate,
    /*
     * No operating-hours row for this weekday means the centre is closed that
     * day, not that its hours are unknown. `reasonCode` says which, so the
     * dashboard never renders an empty shift as "00:00 - 00:00".
     */
    hours: {
      open,
      opensAt: setup.opens_at,
      closesAt: setup.closes_at,
      reasonCode: open ? null : 'NO_OPERATING_HOURS_FOR_DATE',
    },
    /*
     * Where capacity comes from. Null values mean no slot configuration is
     * effective on this date — the scheduler has nothing to divide the shift
     * by, so the dashboard must say so rather than imply unlimited capacity.
     */
    capacity: {
      laneCount: setup.lane_count,
      referenceQuantityKg: num(setup.reference_quantity_kg),
      referenceProcessingMinutes: setup.reference_processing_minutes,
      maxDailyProcessingKg: num(setup.max_daily_processing_kg),
      configured: setup.reference_processing_minutes !== null,
      reasonCode:
        setup.reference_processing_minutes !== null ? null : 'NO_SLOT_CONFIGURATION_FOR_DATE',
    },
    crops: rates.map((r) => {
      const paise = num(r.rate_per_quintal_paise);
      return {
        cropId: r.crop_id,
        // The government's own wording; never translated or re-cased.
        canonicalName: r.canonical_name,
        varietyOrGrade: r.variety_or_grade,
        ratePerQuintalPaise: paise,
        ratePerQuintalRupees: paise === null ? null : paiseToRupeeString(paise),
        marketingYear: r.marketing_year,
        dataType: r.data_type,
        reasonCode: paise === null ? 'NO_ACTIVE_MSP_RATE_FOR_CROP' : null,
      };
    }),
    /*
     * D-10: no official centre-level capacity figure exists, and
     * 0006_storage.sql seeds none. A dashboard printing 0 kg, or inventing a
     * ceiling, would state a fact nobody published — so this reports a reason
     * instead of a number, exactly as availability does.
     */
    storage:
      setup.storage_check_mode === 'DISABLED'
        ? { checkMode: 'DISABLED', status: 'NOT_EVALUATED', reasonCode: null }
        : {
            checkMode: setup.storage_check_mode,
            status: 'NOT_AVAILABLE',
            reasonCode: 'NO_CAPACITY_DATA_FOR_CENTRE',
          },
  };
}

// ---------------------------------------------------------------------------
// Farmer reads
// ---------------------------------------------------------------------------

export async function getOwnProcurement(farmerUserId: string, bookingCode: string) {
  const row = await repo.findOwnProcurement(farmerUserId, bookingCode);
  if (!row) throw notFound('No procurement record for this booking');
  return {
    bookingCode: row.booking_code,
    procurement: toProcurementView(row),
    payment: toPaymentView(row.payment),
  };
}

export async function getOwnPayment(farmerUserId: string, bookingCode: string) {
  const row = await repo.findOwnProcurement(farmerUserId, bookingCode);
  if (!row || !row.payment) throw notFound('No payment record for this booking');
  return { bookingCode: row.booking_code, payment: toPaymentView(row.payment) };
}

/** Exposed for the pure-engine cross-check in the test suite. */
export { computePayment };
