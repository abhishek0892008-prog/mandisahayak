/**
 * Phase 7: booking and scheduling engine.
 *
 * Split deliberately:
 *   - engine tests are PURE (no database) so every timing edge is reachable
 *   - integration tests exercise the real transaction, locks and constraints
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  demoOtpFor,
  newClient,
  query,
  registerFarmer,
  resetRateLimits,
  startTestServer,
  stopTestServer,
  uniquePhone,
} from './helpers.ts';
import {
  addDays,
  dayOfWeekFor,
  durationBreakdown,
  earliestOnDay,
  earliestOnLane,
  freeIntervals,
  localDateOf,
  occupancyMinutes,
  processingMinutes,
  snapUp,
  zonedToUtc,
} from '../src/engines/scheduling.ts';
import type { SlotConfig, WorkingHours } from '../src/engines/scheduling.ts';

let base = '';

before(async () => {
  base = await startTestServer();
});
beforeEach(async () => {
  await resetRateLimits();
});
after(async () => {
  await stopTestServer();
});

// The configuration actually seeded for Agra (Phase 4).
const AGRA: SlotConfig = {
  referenceQuantityKg: 2500,
  referenceProcessingMinutes: 60,
  minimumProcessingMinutes: 30,
  maximumProcessingMinutes: 180,
  transitionBufferMinutes: 15,
  slotGranularityMinutes: 15,
  bookingHorizonDays: 7,
  cancellationCutoffHours: 24,
  maxDailyProcessingKg: null,
};
const ALIGARH: SlotConfig = { ...AGRA, referenceProcessingMinutes: 75 };
const TZ = 'Asia/Kolkata';
const MON_TO_SAT: WorkingHours[] = [1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d,
  opensAt: '08:00:00',
  closesAt: '18:00:00',
}));

// ===========================================================================
describe('processing time (pure)', () => {
  it('derives duration from quantity using the configured reference', () => {
    assert.equal(processingMinutes(2500, AGRA), 60, '25 quintal at Agra');
    assert.equal(processingMinutes(5000, AGRA), 120, '50 quintal at Agra');
    assert.equal(processingMinutes(3750, AGRA), 90, '37.5 quintal at Agra');
  });

  it('produces a different duration at a centre configured differently', () => {
    // Not hardcoded: Aligarh's 75 min/2500 kg yields 150, not 120.
    assert.equal(processingMinutes(5000, ALIGARH), 150);
    assert.equal(processingMinutes(2500, ALIGARH), 75);
  });

  it('separates processing from buffer', () => {
    const d = durationBreakdown(5000, AGRA);
    assert.equal(d.processingMinutes, 120);
    assert.equal(d.bufferMinutes, 15);
    assert.equal(d.occupancyMinutes, 135, 'the lane is held for processing + clearance');
    assert.equal(occupancyMinutes(2500, AGRA), 75);
  });

  it('applies the configured clamps', () => {
    const slow: SlotConfig = { ...AGRA, referenceProcessingMinutes: 400 };
    assert.equal(processingMinutes(5000, slow), 180, 'clamped to the configured maximum');
    const fast: SlotConfig = { ...AGRA, referenceProcessingMinutes: 5 };
    assert.equal(processingMinutes(2500, fast), 30, 'clamped to the configured minimum');
  });
});

// ===========================================================================
describe('time and timezone (pure)', () => {
  it('converts centre-local wall clock to the right UTC instant', () => {
    // 08:00 IST = 02:30 UTC
    assert.equal(zonedToUtc('2026-09-07', '08:00', TZ).toISOString(), '2026-09-07T02:30:00.000Z');
    assert.equal(zonedToUtc('2026-09-07', '18:00', TZ).toISOString(), '2026-09-07T12:30:00.000Z');
  });

  it('computes the centre-local weekday and date', () => {
    assert.equal(dayOfWeekFor('2026-09-06', TZ), 0, '2026-09-06 is a Sunday');
    assert.equal(dayOfWeekFor('2026-09-07', TZ), 1, 'and 2026-09-07 a Monday');
    // 21:00 UTC is already the next day in IST.
    assert.equal(localDateOf(new Date('2026-09-07T21:00:00Z'), TZ), '2026-09-08');
  });

  it('adds days without timezone drift, including across a month end', () => {
    assert.equal(addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it('snaps start times up to the configured granularity', () => {
    const origin = new Date('2026-09-07T02:30:00Z');
    assert.equal(snapUp(new Date('2026-09-07T02:31:00Z'), origin, 15).toISOString(),
      '2026-09-07T02:45:00.000Z');
    assert.equal(snapUp(new Date('2026-09-07T02:30:00Z'), origin, 15).toISOString(),
      '2026-09-07T02:30:00.000Z', 'an exact boundary is not pushed forward');
  });
});

// ===========================================================================
describe('interval maths (pure)', () => {
  const working = {
    startAt: new Date('2026-09-07T02:30:00Z'),
    endAt: new Date('2026-09-07T12:30:00Z'),
  };

  it('computes free gaps around bookings', () => {
    const free = freeIntervals(working, [
      { startAt: new Date('2026-09-07T02:30:00Z'), endAt: new Date('2026-09-07T03:45:00Z') },
      { startAt: new Date('2026-09-07T05:00:00Z'), endAt: new Date('2026-09-07T06:15:00Z') },
    ]);
    assert.equal(free.length, 2);
    assert.equal(free[0].startAt.toISOString(), '2026-09-07T03:45:00.000Z');
    assert.equal(free[1].startAt.toISOString(), '2026-09-07T06:15:00.000Z');
  });

  it('merges overlapping occupancy before computing gaps', () => {
    const free = freeIntervals(working, [
      { startAt: new Date('2026-09-07T02:30:00Z'), endAt: new Date('2026-09-07T04:00:00Z') },
      { startAt: new Date('2026-09-07T03:00:00Z'), endAt: new Date('2026-09-07T05:00:00Z') },
    ]);
    assert.equal(free.length, 1);
    assert.equal(free[0].startAt.toISOString(), '2026-09-07T05:00:00.000Z');
  });

  it('never offers a window that would run past closing time', () => {
    // 09:00 remaining before an 18:00 close cannot hold a 135-minute occupancy.
    const start = earliestOnLane(
      working,
      [{ startAt: new Date('2026-09-07T02:30:00Z'), endAt: new Date('2026-09-07T10:45:00Z') }],
      135, new Date('2026-09-07T00:00:00Z'), 15,
    );
    assert.equal(start, null, 'must not overrun working hours');
  });

  it('never schedules in the past', () => {
    const start = earliestOnLane(working, [], 75, new Date('2026-09-07T06:00:00Z'), 15);
    assert.ok(start! >= new Date('2026-09-07T06:00:00Z'));
    assert.equal(start!.toISOString(), '2026-09-07T06:00:00.000Z');
  });
});

// ===========================================================================
describe('lane selection (pure)', () => {
  const day = (existing: Array<{ laneNo: number; s: string; e: string }>, lanes = [1, 2, 3]) => ({
    serviceDate: '2026-09-07',
    timeZone: TZ,
    hours: MON_TO_SAT,
    holidays: new Set<string>(),
    lanes,
    existing: existing.map((x) => ({
      laneNo: x.laneNo,
      startAt: new Date(x.s),
      endAt: new Date(x.e),
    })),
  });

  const notBefore = new Date('2026-09-01T00:00:00Z');

  it('picks the earliest start across lanes, not the first lane that fits', () => {
    // Lane 1 is busy until 06:00; lanes 2 and 3 are free from opening.
    const c = earliestOnDay(
      day([{ laneNo: 1, s: '2026-09-07T02:30:00Z', e: '2026-09-07T06:00:00Z' }]),
      2500, AGRA, notBefore,
    );
    assert.ok(c);
    assert.equal(c!.startAt.toISOString(), '2026-09-07T02:30:00.000Z');
    assert.equal(c!.laneNo, 2, 'the earliest opening wins, and ties break to the lowest lane');
  });

  it('does not choose a later lane opening when an earlier one exists', () => {
    const c = earliestOnDay(
      day([
        { laneNo: 1, s: '2026-09-07T02:30:00Z', e: '2026-09-07T03:45:00Z' },
        { laneNo: 2, s: '2026-09-07T02:30:00Z', e: '2026-09-07T08:00:00Z' },
      ]),
      2500, AGRA, notBefore,
    );
    // Lane 3 is free from 02:30, earlier than lane 1's 03:45.
    assert.equal(c!.laneNo, 3);
    assert.equal(c!.startAt.toISOString(), '2026-09-07T02:30:00.000Z');
  });

  it('allows back-to-back bookings on the same lane', () => {
    const c = earliestOnDay(
      day([{ laneNo: 1, s: '2026-09-07T02:30:00Z', e: '2026-09-07T03:45:00Z' }], [1]),
      2500, AGRA, notBefore,
    );
    assert.equal(c!.startAt.toISOString(), '2026-09-07T03:45:00.000Z',
      'the next booking starts exactly when the previous occupancy ends');
  });

  it('returns nothing when a single-lane day is full', () => {
    const c = earliestOnDay(
      day([{ laneNo: 1, s: '2026-09-07T02:30:00Z', e: '2026-09-07T12:30:00Z' }], [1]),
      2500, AGRA, notBefore,
    );
    assert.equal(c, null);
  });

  it('treats a closed weekday and a holiday as unavailable', () => {
    const sunday = { ...day([], [1]), serviceDate: '2026-09-06' };
    assert.equal(earliestOnDay(sunday, 2500, AGRA, notBefore), null, 'Sunday has no hours row');

    const holiday = { ...day([], [1]), holidays: new Set(['2026-09-07']) };
    assert.equal(earliestOnDay(holiday, 2500, AGRA, notBefore), null);
  });

  it('reflects a centre with different working hours', () => {
    const hathras = {
      ...day([], [1]),
      hours: [1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensAt: '09:00:00', closesAt: '17:00:00' })),
    };
    const c = earliestOnDay(hathras, 2500, AGRA, notBefore);
    assert.equal(c!.startAt.toISOString(), '2026-09-07T03:30:00.000Z', '09:00 IST');
  });
});

// ===========================================================================
// Integration
// ===========================================================================

async function ids() {
  const r = await query<{ centre_id: string; crop_id: string; code: string }>(
    `SELECT pc.id AS centre_id, cr.id AS crop_id, pc.code
       FROM procurement_centres pc, crops cr
      WHERE cr.code = 'WHEAT' AND pc.code = $1`,
    ['DEMO-UP-AGRA-01'],
  );
  return r.rows[0];
}

/** Next Monday, so tests never fall on a Sunday or in the past. */
function nextMonday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

let bookingSeq = 0;
const key = () => `test-idem-${Date.now()}-${bookingSeq++}`;

async function book(client: ReturnType<typeof newClient>, over: Record<string, unknown> = {}) {
  const { centre_id, crop_id } = await ids();
  return client.request('POST', '/api/v1/bookings', {
    body: { centreId: centre_id, cropId: crop_id, quantityKg: 2500, preferredDate: nextMonday(), ...over },
    headers: { 'idempotency-key': key() },
  });
}

describe('booking creation', () => {
  it('creates a booking with a derived window and a random code', async () => {
    const { client } = await registerFarmer(base);
    const res = await book(client, { quantityKg: 5000 });

    assert.equal(res.status, 201);
    const b = res.body.data as Record<string, unknown>;

    assert.match(String(b.bookingCode), /^FQ-\d{4}-\d{7}$/);
    assert.equal(b.processingMinutes, 120, '5000 kg at Agra = 120 min');
    assert.equal(b.bufferMinutes, 15);
    assert.equal(b.occupancyMinutes, 135);
    assert.equal(b.status, 'CONFIRMED');
    assert.equal(b.displayStatus, 'BOOKED');
    assert.equal(b.quantityKg, 5000);
    assert.ok(Number(b.tokenNumber) >= 1);

    // processing end and window end differ by exactly the buffer
    const gap =
      (new Date(String(b.windowEndAt)).getTime() - new Date(String(b.processingEndAt)).getTime()) / 60000;
    assert.equal(gap, 15, 'the lane is held 15 minutes past processing');

    // approach time is the start; no lead time is invented
    assert.equal(b.estimatedApproachAt, b.scheduledStartAt);
  });

  it('rejects quantities outside the business rule', async () => {
    const { client } = await registerFarmer(base);
    for (const [qty, code] of [[2499, 'QUANTITY_BELOW_MINIMUM'], [5001, 'QUANTITY_ABOVE_MAXIMUM']] as const) {
      const r = await book(client, { quantityKg: qty });
      assert.equal(r.status, 400, `${qty} must be rejected`);
      assert.equal(r.body.error!.fields!.quantityKg, code);
    }
    // and the boundaries are accepted
    const a = await registerFarmer(base);
    assert.equal((await book(a.client, { quantityKg: 2500 })).status, 201);
    const b = await registerFarmer(base);
    assert.equal((await book(b.client, { quantityKg: 5000 })).status, 201);
  });

  it('refuses a crop the centre does not accept', async () => {
    const { client } = await registerFarmer(base);
    const barley = await query<{ id: string }>(`SELECT id FROM crops WHERE code='BARLEY'`);
    const r = await book(client, { cropId: barley.rows[0].id });
    assert.equal(r.status, 422);
    assert.equal(r.body.error!.code, 'CROP_NOT_CONFIGURED_AT_CENTRE');
  });

  it('refuses dates beyond the booking horizon and in the past', async () => {
    const { client } = await registerFarmer(base);
    assert.equal((await book(client, { preferredDate: addDays(nextMonday(), 60) })).body.error!.code,
      'OUTSIDE_BOOKING_HORIZON');
    assert.equal((await book(client, { preferredDate: '2020-01-06' })).body.error!.code,
      'OUTSIDE_BOOKING_HORIZON');
  });

  it('requires an Idempotency-Key', async () => {
    const { client } = await registerFarmer(base);
    const { centre_id, crop_id } = await ids();
    const r = await client.post('/api/v1/bookings', {
      centreId: centre_id, cropId: crop_id, quantityKg: 2500,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error!.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('allocates sequential tokens but non-sequential booking codes', async () => {
    const codes: string[] = [];
    const tokens: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { client } = await registerFarmer(base);
      const r = await book(client);
      assert.equal(r.status, 201);
      const b = r.body.data as Record<string, unknown>;
      codes.push(String(b.bookingCode));
      tokens.push(Number(b.tokenNumber));
    }
    assert.equal(new Set(codes).size, 3, 'codes are unique');
    const digits = codes.map((c) => Number(c.split('-')[2]));
    assert.ok(!(digits[1] === digits[0] + 1 && digits[2] === digits[1] + 1),
      'codes must not be a simple sequence');
    assert.equal(new Set(tokens).size, 3, 'queue tokens are unique per centre-day');
  });

  it('never exposes an internal UUID as the public reference', async () => {
    const { client } = await registerFarmer(base);
    const r = await book(client);
    const blob = JSON.stringify(r.body);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(blob),
      'no UUID may appear in a booking response');
  });

  it('reports storage as advisory rather than inventing headroom', async () => {
    const { client } = await registerFarmer(base);
    const r = await book(client);
    const s = (r.body.data as Record<string, Record<string, unknown>>).storageCheck;
    assert.equal(s.checkMode, 'ADVISORY');
    assert.equal(s.status, 'NOT_AVAILABLE');
    assert.equal(s.reasonCode, 'NO_CAPACITY_DATA_FOR_CENTRE');
    assert.ok(!('availableKg' in s), 'no capacity figure may be present');
  });
});

// ===========================================================================
describe('idempotency', () => {
  it('replays the same response for a repeated request', async () => {
    const { client } = await registerFarmer(base);
    const { centre_id, crop_id } = await ids();
    const k = key();
    const body = { centreId: centre_id, cropId: crop_id, quantityKg: 2500, preferredDate: nextMonday() };

    const first = await client.request('POST', '/api/v1/bookings', { body, headers: { 'idempotency-key': k } });
    const second = await client.request('POST', '/api/v1/bookings', { body, headers: { 'idempotency-key': k } });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(
      (first.body.data as Record<string, unknown>).bookingCode,
      (second.body.data as Record<string, unknown>).bookingCode,
      'the same booking is returned, not a new one',
    );

    const count = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bookings WHERE booking_code = $1`,
      [(first.body.data as Record<string, string>).bookingCode]);
    assert.equal(count.rows[0].n, '1', 'exactly one booking exists');
  });

  it('rejects the same key used with a different body', async () => {
    const { client } = await registerFarmer(base);
    const { centre_id, crop_id } = await ids();
    const k = key();
    await client.request('POST', '/api/v1/bookings', {
      body: { centreId: centre_id, cropId: crop_id, quantityKg: 2500, preferredDate: nextMonday() },
      headers: { 'idempotency-key': k },
    });
    const second = await client.request('POST', '/api/v1/bookings', {
      body: { centreId: centre_id, cropId: crop_id, quantityKg: 5000, preferredDate: nextMonday() },
      headers: { 'idempotency-key': k },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error!.code, 'IDEMPOTENCY_KEY_REUSED');
  });
});

// ===========================================================================
describe('concurrency', () => {
  it('parallel bookings never overlap on the same lane', async () => {
    const { centre_id, crop_id } = await ids();
    const date = nextMonday();

    const farmers = [];
    for (let i = 0; i < 6; i += 1) farmers.push(await registerFarmer(base));

    const results = await Promise.all(
      farmers.map((f) =>
        f.client.request('POST', '/api/v1/bookings', {
          body: { centreId: centre_id, cropId: crop_id, quantityKg: 5000, preferredDate: date },
          headers: { 'idempotency-key': key() },
        }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    assert.ok(created.length > 0, 'at least one booking must succeed');
    for (const r of results.filter((r) => r.status !== 201)) {
      assert.ok([409, 422].includes(r.status), `unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
    }

    // The database is the arbiter: assert no overlap actually exists.
    const overlaps = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM bookings a JOIN bookings b
           ON a.id < b.id AND a.centre_id = b.centre_id AND a.lane_no = b.lane_no
          AND a.service_window && b.service_window
        WHERE a.status = 'CONFIRMED' AND b.status = 'CONFIRMED'`);
    assert.equal(overlaps.rows[0].n, '0', 'no two active bookings may share a lane interval');
  });

  it('the exclusion constraint catches an overlap that bypasses the application', async () => {
    const { client } = await registerFarmer(base);
    const r = await book(client);
    assert.equal(r.status, 201);
    const b = r.body.data as Record<string, string>;

    const row = await query<{
      farmer_id: string; centre_id: string; crop_id: string; season_id: string;
      lane_no: number; service_date: string; scheduled_start_at: Date; scheduled_end_at: Date;
    }>(`SELECT farmer_id, centre_id, crop_id, season_id, lane_no, service_date::text AS service_date,
               scheduled_start_at, scheduled_end_at
          FROM bookings WHERE booking_code = $1`, [b.bookingCode]);
    const x = row.rows[0];

    const other = await registerFarmer(base);
    const otherFarmer = await query<{ id: string }>(
      `SELECT f.id FROM farmers f JOIN users u ON u.id=f.user_id
        WHERE u.phone_e164 = $1`, [`+91${other.phone}`]);

    await assert.rejects(
      () => query(
        `INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id,
            marketing_year, lane_no, requested_quantity_kg, service_date,
            scheduled_start_at, scheduled_end_at, estimated_processing_minutes,
            occupancy_minutes, token_number)
         VALUES ('FQ-2099-9999999',$1,$2,$3,$4,'2026-27',$5,2500,$6::date,$7,$8,60,75,9999)`,
        [otherFarmer.rows[0].id, x.centre_id, x.crop_id, x.season_id, x.lane_no,
         x.service_date, x.scheduled_start_at, x.scheduled_end_at]),
      /bookings_no_lane_overlap/,
      'PostgreSQL must refuse the overlap regardless of application logic',
    );
  });

  it('a farmer cannot hold two overlapping bookings', async () => {
    const { client } = await registerFarmer(base);
    const { crop_id } = await ids();
    const date = nextMonday();

    const first = await book(client, { quantityKg: 2500, preferredDate: date });
    assert.equal(first.status, 201);

    // A different centre, same time — the farmer cannot be in two places at once.
    const mathura = await query<{ id: string }>(
      `SELECT id FROM procurement_centres WHERE code='DEMO-UP-MATHURA-01'`);
    const second = await client.request('POST', '/api/v1/bookings', {
      body: { centreId: mathura.rows[0].id, cropId: crop_id, quantityKg: 2500, preferredDate: date },
      headers: { 'idempotency-key': key() },
    });

    if (second.status === 201) {
      const a = first.body.data as Record<string, string>;
      const b = second.body.data as Record<string, string>;
      const overlap =
        new Date(a.scheduledStartAt) < new Date(b.windowEndAt) &&
        new Date(b.scheduledStartAt) < new Date(a.windowEndAt);
      assert.equal(overlap, false, 'the engine must have scheduled them apart');
    } else {
      assert.equal(second.body.error!.code, 'FARMER_TIME_CONFLICT');
    }
  });

  it('refuses a duplicate active booking for the same centre, crop and date', async () => {
    const { client } = await registerFarmer(base);
    const date = nextMonday();
    assert.equal((await book(client, { preferredDate: date })).status, 201);
    const second = await book(client, { preferredDate: date });
    assert.equal(second.status, 409);
    assert.ok(['DUPLICATE_ACTIVE_BOOKING', 'FARMER_TIME_CONFLICT'].includes(second.body.error!.code));
  });
});

// ===========================================================================
describe('availability and scheduling', () => {
  it('returns the derived duration and the earliest window', async () => {
    const { client } = await registerFarmer(base);
    const { centre_id, crop_id } = await ids();
    const r = await client.post('/api/v1/bookings/availability', {
      centreId: centre_id, cropId: crop_id, quantityKg: 5000, fromDate: nextMonday(),
    });
    assert.equal(r.status, 200);
    const d = r.body.data as Record<string, Record<string, unknown>>;
    assert.equal(d.duration.processingMinutes, 120);
    assert.equal(d.duration.occupancyMinutes, 135);
    assert.equal((d as unknown as { available: boolean }).available, true);
    assert.ok(d.window.scheduledStartAt);
  });

  it('rolls to the next working day when a single-lane day fills up', async () => {
    // Bulandshahr: 1 lane, 08:00-18:00 = 600 min. 5000 kg = 135 min occupancy.
    const centre = await query<{ id: string }>(
      `SELECT id FROM procurement_centres WHERE code='DEMO-UP-BULANDSHAHR-01'`);
    const { crop_id } = await ids();
    const date = nextMonday();

    const dates: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { client } = await registerFarmer(base);
      const r = await client.request('POST', '/api/v1/bookings', {
        body: { centreId: centre.rows[0].id, cropId: crop_id, quantityKg: 5000, preferredDate: date },
        headers: { 'idempotency-key': key() },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      dates.push(String((r.body.data as Record<string, unknown>).serviceDate));
    }

    // 600 / 135 = 4 bookings fit; the fifth must move to the next working day.
    assert.equal(dates.filter((d) => d === date).length, 4, 'four fit on the requested day');
    assert.notEqual(dates[4], date, 'the fifth rolls forward');
    assert.ok(dates[4] > date);

    const dow = dayOfWeekFor(dates[4], TZ);
    assert.notEqual(dow, 0, 'and never onto a Sunday');
  });

  it('frees capacity when a booking is cancelled', async () => {
    const centre = await query<{ id: string }>(
      `SELECT id FROM procurement_centres WHERE code='DEMO-UP-HATHRAS-01'`);
    const { crop_id } = await ids();
    const date = nextMonday();

    const a = await registerFarmer(base);
    const first = await a.client.request('POST', '/api/v1/bookings', {
      body: { centreId: centre.rows[0].id, cropId: crop_id, quantityKg: 2500, preferredDate: date },
      headers: { 'idempotency-key': key() },
    });
    assert.equal(first.status, 201);
    const firstStart = (first.body.data as Record<string, string>).scheduledStartAt;

    // Cancel it; the interval must become available again.
    const cancel = await a.client.post(
      `/api/v1/bookings/${(first.body.data as Record<string, string>).bookingCode}/cancel`,
      { reason: 'test' });
    assert.equal(cancel.status, 200);

    const b = await registerFarmer(base);
    const second = await b.client.request('POST', '/api/v1/bookings', {
      body: { centreId: centre.rows[0].id, cropId: crop_id, quantityKg: 2500, preferredDate: date },
      headers: { 'idempotency-key': key() },
    });
    assert.equal(second.status, 201);
    assert.equal((second.body.data as Record<string, string>).scheduledStartAt, firstStart,
      'the cancelled slot is reused');
  });
});

// ===========================================================================
describe('booking ownership', () => {
  it('a farmer cannot read another farmer’s booking', async () => {
    const a = await registerFarmer(base);
    const b = await registerFarmer(base);
    const created = await book(a.client);
    const code = (created.body.data as Record<string, string>).bookingCode;

    const res = await b.client.get(`/api/v1/bookings/${code}`);
    assert.equal(res.status, 404, 'must be indistinguishable from "does not exist"');
  });

  it('a farmer cannot cancel another farmer’s booking', async () => {
    const a = await registerFarmer(base);
    const b = await registerFarmer(base);
    const created = await book(a.client);
    const code = (created.body.data as Record<string, string>).bookingCode;

    const res = await b.client.post(`/api/v1/bookings/${code}/cancel`, { reason: 'not mine' });
    assert.equal(res.status, 404);

    const still = await query<{ status: string }>(
      `SELECT status FROM bookings WHERE booking_code = $1`, [code]);
    assert.equal(still.rows[0].status, 'CONFIRMED', 'the booking must be untouched');
  });

  it('only the owner’s bookings appear in the list', async () => {
    const a = await registerFarmer(base);
    const b = await registerFarmer(base);
    await book(a.client);
    const list = await b.client.get<unknown[]>('/api/v1/bookings/me');
    assert.equal(list.status, 200);
    assert.equal(list.body.data!.length, 0);
  });

  it('unauthenticated requests are refused', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    assert.equal((await c.get('/api/v1/bookings/me')).status, 401);
    assert.equal((await c.post('/api/v1/bookings/availability', {})).status, 401);
  });
});

// ===========================================================================
describe('cancellation and state machine', () => {
  it('cancels within the window and frees the interval', async () => {
    const { client } = await registerFarmer(base);
    const created = await book(client);
    const code = (created.body.data as Record<string, string>).bookingCode;

    const res = await client.post(`/api/v1/bookings/${code}/cancel`, { reason: 'changed plans' });
    assert.equal(res.status, 200);
    assert.equal((res.body.data as Record<string, string>).status, 'CANCELLED');

    const row = await query<{ status: string; cancelled_at: Date | null }>(
      `SELECT status, cancelled_at FROM bookings WHERE booking_code = $1`, [code]);
    assert.equal(row.rows[0].status, 'CANCELLED');
    assert.ok(row.rows[0].cancelled_at);

    const history = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM booking_status_history bh
         JOIN bookings b ON b.id = bh.booking_id
        WHERE b.booking_code = $1 AND bh.to_status = 'CANCELLED'`, [code]);
    assert.equal(history.rows[0].n, '1');
  });

  it('refuses to cancel twice', async () => {
    const { client } = await registerFarmer(base);
    const created = await book(client);
    const code = (created.body.data as Record<string, string>).bookingCode;
    assert.equal((await client.post(`/api/v1/bookings/${code}/cancel`, {})).status, 200);
    const second = await client.post(`/api/v1/bookings/${code}/cancel`, {});
    assert.equal(second.status, 409);
    assert.equal(second.body.error!.code, 'INVALID_STATE_TRANSITION');
  });

  it('refuses cancellation after the configured cutoff', async () => {
    const { client } = await registerFarmer(base);
    const created = await book(client);
    const code = (created.body.data as Record<string, string>).bookingCode;

    // Move the booking to within the 24-hour cutoff.
    await query(
      `UPDATE bookings
          SET scheduled_start_at = now() + interval '2 hours',
              scheduled_end_at   = now() + interval '3 hours'
        WHERE booking_code = $1`, [code]);

    const res = await client.post(`/api/v1/bookings/${code}/cancel`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error!.code, 'CANCELLATION_WINDOW_CLOSED');
  });

  it('the database refuses an illegal state transition', async () => {
    const { client } = await registerFarmer(base);
    const created = await book(client);
    const code = (created.body.data as Record<string, string>).bookingCode;
    await query(`UPDATE bookings SET status='ARRIVED' WHERE booking_code=$1`, [code]);
    await assert.rejects(
      () => query(`UPDATE bookings SET status='COMPLETED' WHERE booking_code=$1`, [code]),
      /invalid booking status transition/i,
    );
  });

  it('cancelled bookings do not appear in the active list', async () => {
    const { client } = await registerFarmer(base);
    const created = await book(client);
    const code = (created.body.data as Record<string, string>).bookingCode;
    await client.post(`/api/v1/bookings/${code}/cancel`, {});

    const active = await client.get<unknown[]>('/api/v1/bookings/me');
    assert.equal(active.body.data!.length, 0);
    const all = await client.get<unknown[]>('/api/v1/bookings/me?includeInactive=true');
    assert.equal(all.body.data!.length, 1);
  });
});

// ===========================================================================
describe('crop and MSP integrity', () => {
  it('a booking records the canonical crop id, season and marketing year', async () => {
    const { client } = await registerFarmer(base);
    const created = await book(client);
    const b = created.body.data as Record<string, Record<string, unknown>>;
    assert.equal(b.crop.name, 'Wheat');
    assert.equal(b.crop.season, 'RMS', 'season comes from the official import, not the crop name');
    assert.equal(b.crop.marketingYear, '2026-27');
  });

  it('a display string cannot be used in place of a crop id', async () => {
    const { client } = await registerFarmer(base);
    const r = await book(client, { cropId: 'Wheat' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error!.fields!.cropId, 'CROP_ID_INVALID');
  });

  it('"Other" cannot enter the booking flow', async () => {
    const exists = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM crops WHERE code IN ('OTHER','RICE')`);
    assert.equal(exists.rows[0].n, '0', 'no such crop exists to book against');
  });

  it('Paddy grade ambiguity remains explicit and unresolved', async () => {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM msp_rates m JOIN crops c ON c.id=m.crop_id
        WHERE c.code='PADDY' AND m.status='ACTIVE' AND m.variety_or_grade IS NULL`);
    assert.equal(rows.rows[0].n, '0',
      'no ungraded fallback exists, so a grade-less MSP lookup must stay ambiguous');
  });
});
