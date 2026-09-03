/**
 * Queue and ETA engine — PURE.
 *
 * No database, no clock, no configuration lookup. `now` is a parameter, which
 * is what makes "a farmer is overrunning right now" and "this lane went idle
 * four minutes ago" reachable in a test without waiting four minutes.
 *
 * Implements architecture §14.2. Three refinements are documented in
 * docs/phase-9-queue-eta.md §14.2 and repeated at the point of code below:
 *
 *   1. A booking whose service has ENDED (service_ended_at set) leaves the
 *      queue, even though it is still an "active" booking for capacity.
 *   2. The stored lane is authoritative; the projection never reassigns lanes.
 *   3. A member's projected end is when THEIR handling finishes; the lane frees
 *      a further transition buffer later. §14.2 conflates the two.
 *
 * PRINCIPLE P-1: nothing here is stored. Position and ETA are projections. If
 * this module were deleted, no fact would be lost.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One booking, as the queue cares about it. All fields are committed facts. */
export type QueueMember = {
  bookingCode: string;
  tokenNumber: number;
  laneNo: number;
  status: string;
  scheduledStartAt: Date;
  /** From bookings.estimated_processing_minutes — derived at booking time from
   *  THIS booking's quantity and the centre's configured reference rate. */
  processingMinutes: number;
  /** Officer-recorded, database `now()`. Never client-supplied. */
  serviceStartedAt: Date | null;
  serviceEndedAt: Date | null;
};

export type QueueConfig = {
  /** centre_slot_configurations.minimum_processing_minutes — §14.2's
   *  "configured_minimum": the floor on remaining time for an overrunning
   *  service, so it never projects zero or negative. */
  minimumProcessingMinutes: number;
  /** Vehicle clearance before the next farmer may be called onto the lane. */
  transitionBufferMinutes: number;
};

/** Where a booking sits relative to physical service. */
export type QueueState = 'WAITING' | 'IN_SERVICE' | 'NOT_IN_QUEUE';

/**
 * How much the ETA is worth.
 *
 * These are not decorations. A caller that treats SCHEDULED as if it were
 * OBSERVED is claiming live evidence that has not been recorded.
 */
export type EtaConfidence = 'OBSERVED' | 'PROJECTED' | 'SCHEDULED' | 'UNAVAILABLE';

export type EtaUnavailableReason =
  | 'BOOKING_NOT_ACTIVE'
  | 'SERVICE_COMPLETE'
  | 'SERVICE_DATE_PAST'
  /** No centre slot configuration is in force on the service date, so the
   *  processing floor and transition buffer the projection needs do not exist.
   *  Reported rather than silently substituting another date's configuration —
   *  a projection computed from the wrong configuration is worse than none. */
  | 'CENTRE_CONFIGURATION_UNAVAILABLE';

export type ProjectedMember = {
  bookingCode: string;
  tokenNumber: number;
  laneNo: number;
  status: string;
  queueState: QueueState;
  scheduledStartAt: Date;
  processingMinutes: number;
  /** 1-based, centre-wide, ordered by projected start. */
  position: number;
  aheadAtCentre: number;
  aheadOnLane: number;
  projectedStartAt: Date;
  /** When THIS member's handling finishes — not when the lane frees (§5.2). */
  projectedEndAt: Date;
  waitMinutes: number;
  etaConfidence: Exclude<EtaConfidence, 'UNAVAILABLE'>;
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Statuses that can never be in the queue, whatever the timestamps say. */
const TERMINAL = new Set(['CANCELLED', 'NO_SHOW', 'COMPLETED']);

/**
 * Membership is decided by TIMESTAMPS, not by the status label.
 *
 * Status and timestamps agree in every path Phase 8 can produce, and a test
 * asserts they never diverge — but the timestamps are the physical facts, so
 * they are what this function reads.
 *
 * REFINEMENT 1 (docs §3.2): a booking with `serviceEndedAt` set has finished
 * being handled. It is still an ACTIVE booking — `PAYMENT_PENDING` holds a
 * lane reservation for the exclusion constraint and counts against daily
 * capacity — but it occupies no lane in a projection whose purpose is
 * predicting lane availability, and counting it would inflate every downstream
 * farmer's wait with work that is already done.
 */
export function queueStateOf(m: QueueMember): QueueState {
  if (TERMINAL.has(m.status)) return 'NOT_IN_QUEUE';
  if (m.serviceEndedAt !== null) return 'NOT_IN_QUEUE';
  if (m.serviceStartedAt !== null) return 'IN_SERVICE';
  return 'WAITING';
}

export function isInQueue(m: QueueMember): boolean {
  return queueStateOf(m) !== 'NOT_IN_QUEUE';
}

// ---------------------------------------------------------------------------
// Time helpers — integer minutes, no floating point in any projection
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MS_PER_MINUTE);
}

/** Whole minutes, rounded up: a farmer 30 seconds into service has used 1. */
function minutesBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// The projection (§14.2)
// ---------------------------------------------------------------------------

/**
 * Total, deterministic ordering.
 *
 * `tokenNumber` is unique per centre-day (allocated as MAX+1 under the
 * daily-capacity lock), so no two members can tie on all three keys. That is
 * what makes "the same committed state produces the same output" testable
 * rather than aspirational.
 */
function byScheduleThenLaneThenToken(a: QueueMember, b: QueueMember): number {
  const t = a.scheduledStartAt.getTime() - b.scheduledStartAt.getTime();
  if (t !== 0) return t;
  if (a.laneNo !== b.laneNo) return a.laneNo - b.laneNo;
  return a.tokenNumber - b.tokenNumber;
}

/**
 * Projects one centre-day.
 *
 * `members` may contain anything; non-members are filtered here rather than by
 * the caller, so there is exactly one definition of who is in the queue.
 *
 * `isFutureDate` distinguishes PROJECTED from SCHEDULED: on a future service
 * date no arrival has been recorded, so the projection IS the schedule and must
 * not claim to be a live estimate (docs §6.1).
 */
export function projectQueue(
  members: readonly QueueMember[],
  now: Date,
  config: QueueConfig,
  isFutureDate = false,
): ProjectedMember[] {
  const active = members.filter(isInQueue).sort(byScheduleThenLaneThenToken);

  /** When each lane next becomes available. Absent = free now. */
  const laneFreeAt = new Map<number, Date>();
  const projected: Array<Omit<ProjectedMember, 'position' | 'aheadAtCentre' | 'aheadOnLane'>> = [];

  for (const m of active) {
    const state = queueStateOf(m);
    let projectedStartAt: Date;
    let projectedEndAt: Date;
    let etaConfidence: Exclude<EtaConfidence, 'UNAVAILABLE'>;

    if (state === 'IN_SERVICE') {
      // Being served now. The start is an OBSERVED fact, not a projection.
      // Remaining time floors at the configured minimum so an overrunning
      // service keeps sliding forward instead of projecting into the past.
      const elapsed = minutesBetween(m.serviceStartedAt!, now);
      const remaining = Math.max(config.minimumProcessingMinutes, m.processingMinutes - elapsed);
      projectedStartAt = m.serviceStartedAt!;
      projectedEndAt = addMinutes(now, remaining);
      etaConfidence = 'OBSERVED';
    } else {
      // REFINEMENT 2: the stored lane is authoritative. An absent cursor means
      // the lane is free now; a booking still cannot start before the window it
      // actually reserved.
      const laneFree = laneFreeAt.get(m.laneNo) ?? now;
      projectedStartAt = laterOf(m.scheduledStartAt, laneFree);
      projectedEndAt = addMinutes(projectedStartAt, m.processingMinutes);
      etaConfidence = isFutureDate ? 'SCHEDULED' : 'PROJECTED';
    }

    // REFINEMENT 3: the member's end is when THEIR handling finishes; the lane
    // frees a transition buffer later. The next farmer is therefore still
    // pushed by processing + buffer in total, exactly as §14.2 intends, but
    // this farmer is not told their handling ends when the bay is cleared.
    laneFreeAt.set(m.laneNo, addMinutes(projectedEndAt, config.transitionBufferMinutes));

    projected.push({
      bookingCode: m.bookingCode,
      tokenNumber: m.tokenNumber,
      laneNo: m.laneNo,
      status: m.status,
      queueState: state,
      scheduledStartAt: m.scheduledStartAt,
      processingMinutes: m.processingMinutes,
      projectedStartAt,
      projectedEndAt,
      waitMinutes: Math.max(0, minutesBetween(now, projectedStartAt)),
      etaConfidence,
    });
  }

  // Position is by PROJECTED start, which is not the same as scheduled start
  // once a lane is running late. Same tie-breakers, so the order stays total.
  projected.sort((a, b) => {
    const t = a.projectedStartAt.getTime() - b.projectedStartAt.getTime();
    if (t !== 0) return t;
    if (a.laneNo !== b.laneNo) return a.laneNo - b.laneNo;
    return a.tokenNumber - b.tokenNumber;
  });

  const seenOnLane = new Map<number, number>();
  return projected.map((p, i) => {
    const aheadOnLane = seenOnLane.get(p.laneNo) ?? 0;
    seenOnLane.set(p.laneNo, aheadOnLane + 1);
    return { ...p, position: i + 1, aheadAtCentre: i, aheadOnLane };
  });
}

// ---------------------------------------------------------------------------
// Per-lane operational view (officer)
// ---------------------------------------------------------------------------

export type LaneView = {
  laneNo: number;
  nowServing: ProjectedMember | null;
  next: ProjectedMember | null;
  waitingCount: number;
};

/**
 * What each lane is doing and what it should call next.
 *
 * `lanes` is the CONFIGURED active lane list, so a lane with nothing on it
 * still appears — an idle lane is operational information, not an absence.
 */
export function laneViews(
  projectedMembers: readonly ProjectedMember[],
  lanes: readonly number[],
): LaneView[] {
  return [...lanes]
    .sort((a, b) => a - b)
    .map((laneNo) => {
      const onLane = projectedMembers.filter((m) => m.laneNo === laneNo);
      const waiting = onLane.filter((m) => m.queueState === 'WAITING');
      return {
        laneNo,
        nowServing: onLane.find((m) => m.queueState === 'IN_SERVICE') ?? null,
        next: waiting[0] ?? null,
        waitingCount: waiting.length,
      };
    });
}

/** The token being served on one lane, or null if that lane is idle. */
export function servingTokenOnLane(
  projectedMembers: readonly ProjectedMember[],
  laneNo: number,
): number | null {
  const serving = projectedMembers.find(
    (m) => m.laneNo === laneNo && m.queueState === 'IN_SERVICE',
  );
  return serving ? serving.tokenNumber : null;
}

// ---------------------------------------------------------------------------
// ETA availability
// ---------------------------------------------------------------------------

/**
 * Why no ETA can be given, or null if one can.
 *
 * Returning a reason instead of a number is the whole point: `estimatedWait: 0`
 * for a cancelled booking is a lie that looks like data.
 *
 * `SERVICE_DATE_PAST` is reachable because no no-show sweep job exists
 * (Phase 8, R-8b), so a booking whose day has passed can sit CONFIRMED
 * indefinitely. Projecting a position for it would be fabrication.
 */
export function etaUnavailableReason(
  m: QueueMember,
  serviceDate: string,
  todayAtCentre: string,
): EtaUnavailableReason | null {
  if (TERMINAL.has(m.status)) return 'BOOKING_NOT_ACTIVE';
  if (m.serviceEndedAt !== null) return 'SERVICE_COMPLETE';
  if (serviceDate < todayAtCentre) return 'SERVICE_DATE_PAST';
  return null;
}

/** A short statement of what the number was computed from. */
export function etaBasisFor(confidence: EtaConfidence): string {
  switch (confidence) {
    case 'OBSERVED':
      return 'Service has started; the remaining time is the configured processing time for this booking less elapsed time, floored at the configured minimum.';
    case 'PROJECTED':
      return "Configured processing time for this booking's quantity, advanced along this lane by observed service timestamps.";
    case 'SCHEDULED':
      return 'The reserved window. The service date is in the future, so no arrival or service has been recorded and this is not a live estimate.';
    // falls through to UNAVAILABLE
    default:
      return 'No estimate is available.';
  }
}
