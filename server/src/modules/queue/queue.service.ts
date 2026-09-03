/**
 * Queue assembly.
 *
 * Loads one centre-day, runs the pure projection, and shapes the two views.
 * There is no transaction and no write: a poll is a read of committed state
 * (architecture §14.5), and `observedAt` names the instant that state was read.
 *
 * Position and ETA are kept as SEPARATE fields with SEPARATE nullability
 * throughout. A booking may have a position and no ETA; neither is ever a
 * placeholder for the other, and an unavailable ETA is null with a reason
 * rather than a zero that looks like data.
 */
import { ErrorCodes, notFound, unprocessable } from '../../core/errors.ts';
import { getConfig } from '../../core/config.ts';
import { loadCentreContext } from '../bookings/bookings.repository.ts';
import { displayStatusFor } from '../bookings/bookings.service.ts';
import { localDateOf } from '../../engines/scheduling.ts';
import {
  etaBasisFor,
  etaUnavailableReason,
  isInQueue,
  laneViews,
  projectQueue,
  queueStateOf,
  servingTokenOnLane,
} from '../../engines/queue.ts';
import type { EtaConfidence, ProjectedMember, QueueConfig } from '../../engines/queue.ts';
import * as repo from './queue.repository.ts';
import type { QueueRow } from './queue.repository.ts';

/**
 * Everything the projection needs about a centre-day, read once.
 *
 * The centre is resolved TWICE, in this order, and the order matters — it is
 * the same trap Phase 7's `resolveCentreForDate` documents.
 *
 *   1. As of TODAY, for identity, timezone and lanes. A configuration is always
 *      in force today for an active centre, so this always succeeds.
 *   2. As of the SERVICE DATE, for the processing floor and transition buffer
 *      the projection consumes. This may legitimately be absent — a booking can
 *      outlive its configuration window, and one dated before the earliest
 *      configuration has none at all.
 *
 * Resolving only by service date would 404 a farmer out of their own booking,
 * which is what an earlier revision of this file did. When the service-date
 * configuration is missing the projection is NOT computed from another date's
 * configuration: a projection built on the wrong numbers is worse than none.
 */
async function loadDay(centreId: string, serviceDate: string, now: Date) {
  const identity = await loadCentreContext(centreId, localDateOf(now, 'UTC'));
  if (!identity) return null;

  const todayAtCentreDate = localDateOf(now, identity.timezone);
  const onDate =
    serviceDate === localDateOf(now, 'UTC')
      ? identity
      : await loadCentreContext(centreId, serviceDate);

  const rows = await repo.loadCentreDay(centreId, serviceDate);
  const config: QueueConfig | null = onDate
    ? {
        minimumProcessingMinutes: onDate.config.minimumProcessingMinutes,
        transitionBufferMinutes: onDate.config.transitionBufferMinutes,
      }
    : null;
  const isFutureDate = serviceDate > todayAtCentreDate;

  return {
    centre: identity,
    rows,
    config,
    todayAtCentre: todayAtCentreDate,
    isFutureDate,
    projected: config ? projectQueue(rows, now, config, isFutureDate) : [],
  };
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Farmer view
// ---------------------------------------------------------------------------

export async function getOwnQueue(farmerUserId: string, bookingCode: string) {
  // Ownership is resolved in the query. Another farmer's code does not match,
  // so it is indistinguishable from a code that does not exist.
  const owned = await repo.findOwnBookingForQueue(farmerUserId, bookingCode);
  if (!owned) throw notFound('Booking not found');

  const now = new Date();
  const day = await loadDay(owned.centreId, owned.serviceDate, now);
  if (!day) throw notFound('Booking not found');

  const row = day.rows.find((r) => r.bookingCode === bookingCode);
  if (!row) throw notFound('Booking not found');

  const pollAfterSeconds = getConfig().QUEUE_POLL_AFTER_SECONDS;
  const state = queueStateOf(row);

  // A missing service-date configuration is its own reason, never a silent
  // substitution of another date's numbers.
  const unavailable =
    etaUnavailableReason(row, owned.serviceDate, day.todayAtCentre) ??
    (day.config === null ? ('CENTRE_CONFIGURATION_UNAVAILABLE' as const) : null);

  const me: ProjectedMember | undefined = day.projected.find(
    (p) => p.bookingCode === bookingCode,
  );

  // A member with no defensible ETA reports NO position either: an ordinal in a
  // queue that is not running would mislead exactly as much as a fabricated
  // time. Position and ETA remain separate fields — they just happen to be
  // unavailable together in these cases.
  const showQueue = unavailable === null && me !== undefined;
  const confidence: EtaConfidence = showQueue ? me!.etaConfidence : 'UNAVAILABLE';

  return {
    bookingCode: row.bookingCode,
    tokenNumber: row.tokenNumber,
    status: row.status,
    displayStatus: displayStatusFor(row.status),
    queueState: state,
    inQueue: isInQueue(row),

    queuePosition: showQueue ? me!.position : null,
    aheadAtCentre: showQueue ? me!.aheadAtCentre : null,
    aheadOnLane: showQueue ? me!.aheadOnLane : null,
    activeQueueSize: day.config === null ? null : day.projected.length,
    laneNo: row.laneNo,
    laneCount: day.centre.lanes.length,
    currentlyServingToken: servingTokenOnLane(day.projected, row.laneNo),

    estimatedStartAt: showQueue ? iso(me!.projectedStartAt) : null,
    estimatedEndAt: showQueue ? iso(me!.projectedEndAt) : null,
    estimatedWaitMinutes: showQueue ? me!.waitMinutes : null,
    etaConfidence: confidence,
    etaUnavailableReason: unavailable,
    etaBasis: etaBasisFor(confidence),

    scheduledStartAt: iso(row.scheduledStartAt),
    serviceDate: owned.serviceDate,
    centreTimezone: day.centre.timezone,
    observedAt: now.toISOString(),
    serverTime: now.toISOString(),
    pollAfterSeconds,
  };
}

// ---------------------------------------------------------------------------
// Officer view
// ---------------------------------------------------------------------------

function memberView(p: ProjectedMember, rows: readonly QueueRow[]) {
  const row = rows.find((r) => r.bookingCode === p.bookingCode)!;
  return {
    position: p.position,
    bookingCode: p.bookingCode,
    tokenNumber: p.tokenNumber,
    laneNo: p.laneNo,
    status: p.status,
    displayStatus: displayStatusFor(p.status),
    queueState: p.queueState,
    aheadOnLane: p.aheadOnLane,
    // An officer calling the next farmer has to be able to identify them.
    // Same disclosure as /officer/centres/:centreId/bookings, already shipped.
    farmer: { name: row.farmerName, phone: row.farmerPhone },
    scheduledStartAt: iso(p.scheduledStartAt),
    projectedStartAt: iso(p.projectedStartAt),
    projectedEndAt: iso(p.projectedEndAt),
    waitMinutes: p.waitMinutes,
    etaConfidence: p.etaConfidence,
  };
}

function brief(p: ProjectedMember | null) {
  if (!p) return null;
  return {
    bookingCode: p.bookingCode,
    tokenNumber: p.tokenNumber,
    projectedStartAt: iso(p.projectedStartAt),
    projectedEndAt: iso(p.projectedEndAt),
  };
}

export async function getCentreQueue(centreId: string, serviceDate: string) {
  const now = new Date();
  const day = await loadDay(centreId, serviceDate, now);
  if (!day) throw notFound('Centre not found');

  // No configuration in force on that date means the projection has no
  // processing floor and no transition buffer. Saying so is honest; projecting
  // from a different date's configuration would not be.
  if (day.config === null) {
    throw unprocessable(
      ErrorCodes.CENTRE_NOT_AVAILABLE,
      'No centre configuration is in force on that date',
      { serviceDate },
    );
  }

  const lanes = laneViews(day.projected, day.centre.lanes);

  return {
    centreCode: day.centre.code,
    centreName: day.centre.name,
    serviceDate,
    centreTimezone: day.centre.timezone,
    activeQueueSize: day.projected.length,
    lanes: lanes.map((l) => ({
      laneNo: l.laneNo,
      nowServing: brief(l.nowServing),
      next: brief(l.next),
      waitingCount: l.waitingCount,
    })),
    queue: day.projected.map((p) => memberView(p, day.rows)),
    observedAt: now.toISOString(),
    serverTime: now.toISOString(),
    pollAfterSeconds: getConfig().QUEUE_POLL_AFTER_SECONDS,
  };
}

/** The centre's local calendar date, for defaulting the officer's `date`. */
export async function todayAtCentre(centreId: string): Promise<string | null> {
  const now = new Date();
  const probe = localDateOf(now, 'UTC');
  const centre = await loadCentreContext(centreId, probe);
  if (!centre) return null;
  return localDateOf(now, centre.timezone);
}
