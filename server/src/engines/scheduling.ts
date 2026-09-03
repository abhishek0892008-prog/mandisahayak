/**
 * Scheduling engine — PURE.
 *
 * No database, no clock, no configuration lookup. Everything arrives as an
 * argument and everything is returned as a value. That is deliberate: every
 * rule in docs/phase-7-booking-engine.md can then be tested exhaustively
 * without a database, including the timezone and working-hour edges that are
 * awkward to reproduce against live data.
 *
 * The one formula, defined once (architecture P-3):
 *
 *   processing = clamp(round(ref_minutes * qty / ref_qty), min, max)
 *   occupancy  = processing + buffer
 *
 * `processing` is how long the produce is handled.
 * `occupancy`  is how long the LANE is held — processing plus vehicle clearance.
 * The next farmer's start is never earlier than the previous occupancy end.
 */

export type SlotConfig = {
  referenceQuantityKg: number;
  referenceProcessingMinutes: number;
  minimumProcessingMinutes: number;
  maximumProcessingMinutes: number;
  transitionBufferMinutes: number;
  slotGranularityMinutes: number;
  bookingHorizonDays: number;
  cancellationCutoffHours: number;
  maxDailyProcessingKg: number | null;
};

export type WorkingHours = {
  /** 0 = Sunday … 6 = Saturday, matching PostgreSQL EXTRACT(DOW). */
  dayOfWeek: number;
  /** 'HH:MM' or 'HH:MM:SS' local time. */
  opensAt: string;
  closesAt: string;
};

export type Interval = { startAt: Date; endAt: Date };
export type LaneInterval = Interval & { laneNo: number };

export type Candidate = {
  laneNo: number;
  serviceDate: string;
  startAt: Date;
  /** Occupancy end — what the lane is held until, and what is stored. */
  endAt: Date;
  processingMinutes: number;
  bufferMinutes: number;
  occupancyMinutes: number;
  /** Processing end — what the farmer is told. */
  processingEndAt: Date;
};

export type NoAvailabilityReason =
  | 'CENTRE_CLOSED_ON_DATE'
  | 'ALL_DAYS_FULL'
  | 'HORIZON_EXCEEDED';

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/** Round half away from zero, matching the documented formula. */
function roundHalfAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export function processingMinutes(quantityKg: number, cfg: SlotConfig): number {
  if (cfg.referenceQuantityKg <= 0) {
    throw new Error('referenceQuantityKg must be positive');
  }
  const raw = roundHalfAwayFromZero(
    cfg.referenceProcessingMinutes * (quantityKg / cfg.referenceQuantityKg),
  );
  return Math.min(Math.max(raw, cfg.minimumProcessingMinutes), cfg.maximumProcessingMinutes);
}

export function occupancyMinutes(quantityKg: number, cfg: SlotConfig): number {
  return processingMinutes(quantityKg, cfg) + cfg.transitionBufferMinutes;
}

export function durationBreakdown(quantityKg: number, cfg: SlotConfig) {
  const processing = processingMinutes(quantityKg, cfg);
  return {
    processingMinutes: processing,
    bufferMinutes: cfg.transitionBufferMinutes,
    occupancyMinutes: processing + cfg.transitionBufferMinutes,
  };
}

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

/** Offset (ms) that `timeZone` had at `date`: local wall clock minus UTC. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // Intl renders midnight as hour 24 in some engines; normalise.
  const hour = get('hour') % 24;
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - date.getTime();
}

/**
 * Converts a local wall-clock date and time in `timeZone` to a UTC instant.
 * The second pass corrects the offset around a DST transition. Asia/Kolkata has
 * none, but the engine must not be silently wrong for a zone that does.
 */
export function zonedToUtc(serviceDate: string, localTime: string, timeZone: string): Date {
  const [y, m, d] = serviceDate.split('-').map(Number);
  const [hh, mm] = localTime.split(':').map(Number);

  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let ts = naive - zoneOffsetMs(new Date(naive), timeZone);
  ts = naive - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Local calendar weekday (0=Sunday) of a service date in a zone. */
export function dayOfWeekFor(serviceDate: string, timeZone: string): number {
  const noon = zonedToUtc(serviceDate, '12:00', timeZone);
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** Adds whole days to a 'YYYY-MM-DD' string without timezone drift. */
export function addDays(serviceDate: string, days: number): string {
  const [y, m, d] = serviceDate.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** The centre-local calendar date of an instant. */
export function localDateOf(instant: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(instant);
}

// ---------------------------------------------------------------------------
// Interval maths
// ---------------------------------------------------------------------------

const MIN_MS = 60_000;

/** Rounds an instant UP to the next multiple of `granularity` minutes past `origin`. */
export function snapUp(instant: Date, origin: Date, granularityMinutes: number): Date {
  if (granularityMinutes <= 0) return instant;
  const step = granularityMinutes * MIN_MS;
  const delta = instant.getTime() - origin.getTime();
  if (delta <= 0) return new Date(origin.getTime());
  return new Date(origin.getTime() + Math.ceil(delta / step) * step);
}

/** `working` minus `occupied`, as ascending non-overlapping free intervals. */
export function freeIntervals(working: Interval, occupied: readonly Interval[]): Interval[] {
  const busy = occupied
    .filter((o) => o.endAt > working.startAt && o.startAt < working.endAt)
    .map((o) => ({
      startAt: new Date(Math.max(o.startAt.getTime(), working.startAt.getTime())),
      endAt: new Date(Math.min(o.endAt.getTime(), working.endAt.getTime())),
    }))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  // Merge overlapping/adjacent busy blocks so gaps are computed correctly.
  const merged: Interval[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.startAt.getTime() <= last.endAt.getTime()) {
      if (b.endAt > last.endAt) last.endAt = b.endAt;
    } else {
      merged.push({ startAt: new Date(b.startAt), endAt: new Date(b.endAt) });
    }
  }

  const free: Interval[] = [];
  let cursor = working.startAt;
  for (const b of merged) {
    if (b.startAt > cursor) free.push({ startAt: cursor, endAt: b.startAt });
    if (b.endAt > cursor) cursor = b.endAt;
  }
  if (cursor < working.endAt) free.push({ startAt: cursor, endAt: working.endAt });
  return free;
}

/**
 * Earliest start on ONE lane at or after `notBefore`, fitting `duration`
 * entirely inside a free interval and inside working hours.
 */
export function earliestOnLane(
  working: Interval,
  occupied: readonly Interval[],
  durationMinutes: number,
  notBefore: Date,
  granularityMinutes: number,
): Date | null {
  const needed = durationMinutes * MIN_MS;

  for (const gap of freeIntervals(working, occupied)) {
    const lowerBound = new Date(Math.max(gap.startAt.getTime(), notBefore.getTime()));
    const start = snapUp(lowerBound, working.startAt, granularityMinutes);
    if (start.getTime() + needed <= gap.endAt.getTime()) return start;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Day-level search
// ---------------------------------------------------------------------------

export type DayInput = {
  serviceDate: string;
  timeZone: string;
  hours: readonly WorkingHours[];
  holidays: ReadonlySet<string>;
  lanes: readonly number[];
  existing: readonly LaneInterval[];
};

/**
 * Earliest candidate on a single day, across ALL lanes.
 *
 * Takes the minimum start across every lane rather than the first lane that
 * fits, so a later opening is never chosen when an earlier one exists. Ties
 * break to the lowest lane number, making allocation deterministic.
 */
export function earliestOnDay(
  day: DayInput,
  quantityKg: number,
  cfg: SlotConfig,
  notBefore: Date,
): Candidate | null {
  if (day.holidays.has(day.serviceDate)) return null;
  if (day.lanes.length === 0) return null;

  const dow = dayOfWeekFor(day.serviceDate, day.timeZone);
  const todaysHours = day.hours.filter((h) => h.dayOfWeek === dow);
  if (todaysHours.length === 0) return null; // closed: absence of a row means closed

  const { processingMinutes: proc, bufferMinutes, occupancyMinutes: occ } = durationBreakdown(
    quantityKg,
    cfg,
  );

  let best: Candidate | null = null;

  for (const h of todaysHours) {
    const working: Interval = {
      startAt: zonedToUtc(day.serviceDate, h.opensAt.slice(0, 5), day.timeZone),
      endAt: zonedToUtc(day.serviceDate, h.closesAt.slice(0, 5), day.timeZone),
    };
    if (working.endAt <= working.startAt) continue;

    for (const laneNo of [...day.lanes].sort((a, b) => a - b)) {
      const occupied = day.existing.filter((e) => e.laneNo === laneNo);
      const start = earliestOnLane(working, occupied, occ, notBefore, cfg.slotGranularityMinutes);
      if (!start) continue;

      if (!best || start < best.startAt || (start.getTime() === best.startAt.getTime() && laneNo < best.laneNo)) {
        best = {
          laneNo,
          serviceDate: day.serviceDate,
          startAt: start,
          endAt: new Date(start.getTime() + occ * MIN_MS),
          processingEndAt: new Date(start.getTime() + proc * MIN_MS),
          processingMinutes: proc,
          bufferMinutes,
          occupancyMinutes: occ,
        };
      }
    }
  }

  return best;
}

export type SearchResult =
  | { found: true; candidate: Candidate }
  | { found: false; reason: NoAvailabilityReason; daysSearched: number };

/**
 * Walks forward from `fromDate` to the booking horizon, returning the first
 * day that yields a candidate. `loadDay` supplies that day's configuration and
 * existing bookings — the engine itself performs no I/O.
 */
export async function findEarliest(
  fromDate: string,
  horizonDays: number,
  quantityKg: number,
  cfg: SlotConfig,
  notBefore: Date,
  loadDay: (serviceDate: string) => Promise<DayInput>,
): Promise<SearchResult> {
  let anyOpenDay = false;

  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const serviceDate = addDays(fromDate, offset);
    const day = await loadDay(serviceDate);

    const dow = dayOfWeekFor(serviceDate, day.timeZone);
    const open = !day.holidays.has(serviceDate) && day.hours.some((h) => h.dayOfWeek === dow);
    if (open) anyOpenDay = true;

    const candidate = earliestOnDay(day, quantityKg, cfg, notBefore);
    if (candidate) return { found: true, candidate };
  }

  return {
    found: false,
    reason: anyOpenDay ? 'ALL_DAYS_FULL' : 'CENTRE_CLOSED_ON_DATE',
    daysSearched: horizonDays + 1,
  };
}
