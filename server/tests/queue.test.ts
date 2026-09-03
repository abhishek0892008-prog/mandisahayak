/**
 * Phase 9: queue and ETA.
 *
 * Split as Phases 7 and 8 split:
 *   - the projection is PURE, with an injected clock, so "a farmer is
 *     overrunning right now" and "this lane went idle four minutes ago" are
 *     reachable without waiting four minutes
 *   - integration tests cover ownership, centre scope, terminal removal,
 *     concurrency and the no-mutation invariant, which only exist end to end
 *
 * Centre: ALIGARH, deliberately. It has THREE lanes — the only demonstration
 * centre where multi-lane behaviour is genuinely observable — and no other
 * suite books there, so its capacity is intact when this file runs.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStaffUser,
  newClient,
  query,
  registerFarmer,
  resetRateLimits,
  staffLogin,
  startTestServer,
  stopTestServer,
  uniquePhone,
} from './helpers.ts';
import {
  etaBasisFor,
  etaUnavailableReason,
  isInQueue,
  laneViews,
  projectQueue,
  queueStateOf,
  servingTokenOnLane,
} from '../src/engines/queue.ts';
import type { QueueConfig, QueueMember } from '../src/engines/queue.ts';
import { RateLimits } from '../src/core/rateLimit.ts';

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

// ===========================================================================
// PURE
// ===========================================================================

/** Aligarh's actual configuration: 75 min / 2 500 kg, min 30, buffer 15. */
const CFG: QueueConfig = { minimumProcessingMinutes: 30, transitionBufferMinutes: 15 };

const T0 = new Date('2026-03-12T02:30:00Z'); // 08:00 IST
const at = (minutesAfterT0: number) => new Date(T0.getTime() + minutesAfterT0 * 60_000);

function member(over: Partial<QueueMember> & { tokenNumber: number }): QueueMember {
  return {
    bookingCode: `FQ-2026-${String(over.tokenNumber).padStart(7, '0')}`,
    laneNo: 1,
    status: 'CONFIRMED',
    scheduledStartAt: T0,
    processingMinutes: 75,
    serviceStartedAt: null,
    serviceEndedAt: null,
    ...over,
  };
}

describe('queue membership (pure)', () => {
  it('maps every lifecycle status to the right membership', () => {
    const cases: Array<[string, Date | null, Date | null, string]> = [
      ['CONFIRMED', null, null, 'WAITING'],
      ['ARRIVED', null, null, 'WAITING'],
      ['WEIGHING', at(0), null, 'IN_SERVICE'],
      ['QUALITY_CHECK', at(0), null, 'IN_SERVICE'],
      ['PROCUREMENT_RECORDED', at(0), null, 'IN_SERVICE'],
      ['PAYMENT_PENDING', at(0), at(70), 'NOT_IN_QUEUE'],
      ['COMPLETED', at(0), at(70), 'NOT_IN_QUEUE'],
      ['CANCELLED', null, null, 'NOT_IN_QUEUE'],
      ['NO_SHOW', null, null, 'NOT_IN_QUEUE'],
    ];
    for (const [status, started, ended, expected] of cases) {
      const m = member({ tokenNumber: 1, status, serviceStartedAt: started, serviceEndedAt: ended });
      assert.equal(queueStateOf(m), expected, status);
      assert.equal(isInQueue(m), expected !== 'NOT_IN_QUEUE', status);
    }
  });

  it('excludes PAYMENT_PENDING even though it is an ACTIVE booking', () => {
    // It still holds a lane reservation for the exclusion constraint and still
    // counts against daily capacity — but its produce has been handled, so it
    // must not inflate anyone's wait.
    const done = member({
      tokenNumber: 1,
      status: 'PAYMENT_PENDING',
      serviceStartedAt: at(0),
      serviceEndedAt: at(70),
    });
    const waiting = member({ tokenNumber: 2, scheduledStartAt: at(90) });
    const out = projectQueue([done, waiting], at(80), CFG);

    assert.equal(out.length, 1, 'only the waiting booking is in the queue');
    assert.equal(out[0].tokenNumber, 2);
    assert.equal(out[0].aheadAtCentre, 0, 'a finished farmer is not "ahead of me"');
  });

  it('excludes a terminal booking whatever its timestamps say', () => {
    const cancelledMidService = member({
      tokenNumber: 1,
      status: 'CANCELLED',
      serviceStartedAt: at(0),
      serviceEndedAt: null,
    });
    assert.equal(queueStateOf(cancelledMidService), 'NOT_IN_QUEUE');
    assert.equal(projectQueue([cancelledMidService], at(10), CFG).length, 0);
  });
});

describe('queue ordering (pure)', () => {
  it('orders by scheduled start, not by token or creation', () => {
    const later = member({ tokenNumber: 1, scheduledStartAt: at(180) });
    const earlier = member({ tokenNumber: 9, scheduledStartAt: at(0), laneNo: 2 });
    const out = projectQueue([later, earlier], T0, CFG);
    assert.deepEqual(
      out.map((m) => m.tokenNumber),
      [9, 1],
      'the earlier window wins even with a much later token',
    );
  });

  it('breaks ties deterministically by lane then token', () => {
    const a = member({ tokenNumber: 7, laneNo: 2 });
    const b = member({ tokenNumber: 3, laneNo: 1 });
    const c = member({ tokenNumber: 5, laneNo: 2 });
    // All three share a scheduled start; only the tie-breakers separate them.
    const out = projectQueue([a, b, c], T0, CFG);
    assert.deepEqual(
      out.map((m) => `${m.laneNo}/${m.tokenNumber}`),
      ['1/3', '2/5', '2/7'],
    );
  });

  it('is deterministic: the same input produces byte-identical output', () => {
    const input = [
      member({ tokenNumber: 3, laneNo: 2, scheduledStartAt: at(30) }),
      member({ tokenNumber: 1, laneNo: 1 }),
      member({ tokenNumber: 2, laneNo: 3, scheduledStartAt: at(30) }),
    ];
    const first = projectQueue(input, T0, CFG);
    const second = projectQueue([...input].reverse(), T0, CFG);
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'input order must not matter');
  });

  it('positions by PROJECTED start, which can differ from scheduled start', () => {
    // Lane 1 is running late; lane 2 is free. The lane-2 booking scheduled
    // later is genuinely served first, and the position reflects that.
    const late = member({
      tokenNumber: 1,
      laneNo: 1,
      serviceStartedAt: at(-200),
      status: 'WEIGHING',
      processingMinutes: 300,
    });
    const behindLate = member({ tokenNumber: 2, laneNo: 1, scheduledStartAt: at(0) });
    const otherLane = member({ tokenNumber: 3, laneNo: 2, scheduledStartAt: at(30) });

    const out = projectQueue([late, behindLate, otherLane], T0, CFG);
    assert.deepEqual(out.map((m) => m.tokenNumber), [1, 3, 2]);
    assert.equal(out[1].tokenNumber, 3, 'the free lane is served before the backed-up one');
  });
});

describe('multi-lane behaviour (pure)', () => {
  it('advances each lane on its own cursor', () => {
    const ms = [1, 2, 3].map((lane) => member({ tokenNumber: lane, laneNo: lane }));
    const out = projectQueue(ms, T0, CFG);
    // Three lanes free at 08:00 — all three start at once, none waits.
    for (const m of out) {
      assert.equal(m.projectedStartAt.toISOString(), T0.toISOString());
      assert.equal(m.waitMinutes, 0);
      assert.equal(m.aheadOnLane, 0, 'nobody is ahead of them on their own lane');
    }
    assert.deepEqual(out.map((m) => m.aheadAtCentre), [0, 1, 2], 'but they are ordered centre-wide');
  });

  it('gives the same centre position very different waits on different lanes', () => {
    const busy1 = member({ tokenNumber: 1, laneNo: 1 });
    const busy2 = member({ tokenNumber: 2, laneNo: 1, scheduledStartAt: T0 });
    const alone = member({ tokenNumber: 3, laneNo: 2, scheduledStartAt: T0 });
    const out = projectQueue([busy1, busy2, alone], T0, CFG);

    const second = out.find((m) => m.tokenNumber === 2)!;
    const third = out.find((m) => m.tokenNumber === 3)!;
    assert.equal(second.aheadOnLane, 1, 'one ahead on lane 1');
    assert.equal(third.aheadOnLane, 0, 'nobody ahead on lane 2');
    assert.ok(
      second.waitMinutes > third.waitMinutes,
      'this is exactly why aheadOnLane exists as its own field',
    );
    // 75 processing + 15 buffer before the lane frees.
    assert.equal(second.waitMinutes, 90);
  });

  it('does not reassign lanes: the stored lane is authoritative', () => {
    const onBusyLane = member({ tokenNumber: 2, laneNo: 1, scheduledStartAt: T0 });
    const blocker = member({ tokenNumber: 1, laneNo: 1 });
    const out = projectQueue([blocker, onBusyLane], T0, CFG);
    const m = out.find((x) => x.tokenNumber === 2)!;
    assert.equal(m.laneNo, 1, 'never silently moved to an idle lane');
    assert.ok(m.waitMinutes > 0, 'and therefore genuinely waits');
  });

  it('reports an idle lane as idle rather than omitting it', () => {
    const out = projectQueue([member({ tokenNumber: 1, laneNo: 1 })], T0, CFG);
    const views = laneViews(out, [1, 2, 3]);
    assert.equal(views.length, 3, 'all configured lanes appear');
    assert.equal(views[1].nowServing, null);
    assert.equal(views[1].next, null);
    assert.equal(views[1].waitingCount, 0);
    assert.equal(views[0].next!.tokenNumber, 1);
  });
});

describe('ETA projection (pure)', () => {
  it('treats an in-service booking as OBSERVED, from a recorded fact', () => {
    const serving = member({
      tokenNumber: 1,
      status: 'WEIGHING',
      serviceStartedAt: at(0),
      processingMinutes: 75,
    });
    const out = projectQueue([serving], at(30), CFG);
    assert.equal(out[0].etaConfidence, 'OBSERVED');
    assert.equal(out[0].projectedStartAt.toISOString(), at(0).toISOString(), 'the real start');
    // 75 configured − 30 elapsed = 45 remaining, from now.
    assert.equal(out[0].projectedEndAt.toISOString(), at(75).toISOString());
  });

  it('floors remaining time at the configured minimum when a service overruns', () => {
    const overrunning = member({
      tokenNumber: 1,
      status: 'WEIGHING',
      serviceStartedAt: at(0),
      processingMinutes: 75,
    });
    // 200 minutes elapsed on a 75-minute job: 75 − 200 is negative.
    const out = projectQueue([overrunning], at(200), CFG);
    assert.equal(
      out[0].projectedEndAt.toISOString(),
      at(230).toISOString(),
      'floored at the configured 30-minute minimum, never a past or zero end',
    );
  });

  it('pushes downstream farmers out when someone overruns', () => {
    const overrunning = member({
      tokenNumber: 1,
      laneNo: 1,
      status: 'WEIGHING',
      serviceStartedAt: at(0),
      processingMinutes: 75,
    });
    const next = member({ tokenNumber: 2, laneNo: 1, scheduledStartAt: at(90) });

    const onTime = projectQueue([member({ ...overrunning, serviceStartedAt: at(0) }), next], at(10), CFG);
    const late = projectQueue([overrunning, next], at(200), CFG);

    const nextOnTime = onTime.find((m) => m.tokenNumber === 2)!;
    const nextLate = late.find((m) => m.tokenNumber === 2)!;
    assert.ok(
      nextLate.projectedStartAt.getTime() > nextOnTime.projectedStartAt.getTime(),
      'the overrun moves the next farmer later',
    );
  });

  it('pulls downstream farmers in when someone finishes early and leaves', () => {
    const blocker = member({ tokenNumber: 1, laneNo: 1, scheduledStartAt: T0 });
    const behind = member({ tokenNumber: 2, laneNo: 1, scheduledStartAt: at(90) });

    const withBlocker = projectQueue([blocker, behind], T0, CFG);
    // The blocker completes: service_ended_at set, so it leaves the queue.
    const finished = { ...blocker, status: 'PAYMENT_PENDING', serviceStartedAt: T0, serviceEndedAt: at(20) };
    const without = projectQueue([finished, behind], T0, CFG);

    const before = withBlocker.find((m) => m.tokenNumber === 2)!;
    const afterEarly = without.find((m) => m.tokenNumber === 2)!;
    assert.equal(before.aheadOnLane, 1);
    assert.equal(afterEarly.aheadOnLane, 0, 'everyone behind moves up');
    assert.ok(afterEarly.projectedStartAt.getTime() <= before.projectedStartAt.getTime());
  });

  it('derives duration from the booking, not from a fixed per-farmer constant', () => {
    const small = member({ tokenNumber: 1, laneNo: 1, processingMinutes: 75 });
    const large = member({ tokenNumber: 2, laneNo: 2, processingMinutes: 150 });
    const out = projectQueue([small, large], T0, CFG);
    const a = out.find((m) => m.tokenNumber === 1)!;
    const b = out.find((m) => m.tokenNumber === 2)!;
    assert.equal((a.projectedEndAt.getTime() - a.projectedStartAt.getTime()) / 60000, 75);
    assert.equal((b.projectedEndAt.getTime() - b.projectedStartAt.getTime()) / 60000, 150);
  });

  it('separates the farmer’s service end from when the lane frees', () => {
    const first = member({ tokenNumber: 1, laneNo: 1, processingMinutes: 75 });
    const second = member({ tokenNumber: 2, laneNo: 1, scheduledStartAt: T0 });
    const out = projectQueue([first, second], T0, CFG);

    const f = out.find((m) => m.tokenNumber === 1)!;
    const s = out.find((m) => m.tokenNumber === 2)!;
    assert.equal(f.projectedEndAt.toISOString(), at(75).toISOString(), 'handling ends at 75');
    assert.equal(
      s.projectedStartAt.toISOString(),
      at(90).toISOString(),
      'but the lane only frees 15 minutes later, after vehicle clearance',
    );
  });

  it('labels a future service date SCHEDULED, never PROJECTED', () => {
    const out = projectQueue([member({ tokenNumber: 1 })], T0, CFG, true);
    assert.equal(out[0].etaConfidence, 'SCHEDULED');
    assert.match(etaBasisFor('SCHEDULED'), /not a live estimate/);
    const live = projectQueue([member({ tokenNumber: 1 })], T0, CFG, false);
    assert.equal(live[0].etaConfidence, 'PROJECTED');
  });

  it('never projects a negative wait', () => {
    const past = member({ tokenNumber: 1, scheduledStartAt: at(-500) });
    const out = projectQueue([past], T0, CFG);
    assert.equal(out[0].waitMinutes, 0);
  });
});

describe('ETA availability (pure)', () => {
  const today = '2026-03-12';
  it('gives a reason, never a number, when no estimate is defensible', () => {
    const cases: Array<[Partial<QueueMember>, string, string | null]> = [
      [{ status: 'CANCELLED' }, today, 'BOOKING_NOT_ACTIVE'],
      [{ status: 'NO_SHOW' }, today, 'BOOKING_NOT_ACTIVE'],
      [{ status: 'COMPLETED', serviceEndedAt: at(70) }, today, 'BOOKING_NOT_ACTIVE'],
      [{ status: 'PAYMENT_PENDING', serviceEndedAt: at(70) }, today, 'SERVICE_COMPLETE'],
      [{ status: 'CONFIRMED' }, today, null],
      [{ status: 'ARRIVED' }, today, null],
    ];
    for (const [over, t, expected] of cases) {
      const m = member({ tokenNumber: 1, ...over });
      assert.equal(etaUnavailableReason(m, t, today), expected, JSON.stringify(over));
    }
  });

  it('refuses to estimate for a booking whose service date has passed', () => {
    // Reachable because no no-show sweep exists (Phase 8, R-8b).
    const stale = member({ tokenNumber: 1, status: 'CONFIRMED' });
    assert.equal(etaUnavailableReason(stale, '2026-03-01', today), 'SERVICE_DATE_PAST');
  });

  it('reports the serving token per lane, and null for an idle lane', () => {
    const serving = member({
      tokenNumber: 7,
      laneNo: 2,
      status: 'WEIGHING',
      serviceStartedAt: at(0),
    });
    const out = projectQueue([serving, member({ tokenNumber: 8, laneNo: 1 })], at(5), CFG);
    assert.equal(servingTokenOnLane(out, 2), 7);
    assert.equal(servingTokenOnLane(out, 1), null, 'lane 1 has a waiter, not a servee');
    assert.equal(servingTokenOnLane(out, 3), null);
  });
});

// ===========================================================================
// INVARIANTS over generated states (brief §16)
// ===========================================================================

/** Seeded PRNG, so a failing case is reproducible rather than a ghost. */
function mulberry32(seed: number) {
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_STATUSES = [
  'CONFIRMED',
  'ARRIVED',
  'WEIGHING',
  'QUALITY_CHECK',
  'PROCUREMENT_RECORDED',
  'PAYMENT_PENDING',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

function generateDay(rand: () => number, n: number): QueueMember[] {
  const out: QueueMember[] = [];
  for (let i = 0; i < n; i += 1) {
    const status = ALL_STATUSES[Math.floor(rand() * ALL_STATUSES.length)];
    const started =
      ['WEIGHING', 'QUALITY_CHECK', 'PROCUREMENT_RECORDED', 'PAYMENT_PENDING', 'COMPLETED'].includes(
        status,
      )
        ? at(Math.floor(rand() * 200) - 100)
        : null;
    const ended = ['PAYMENT_PENDING', 'COMPLETED'].includes(status)
      ? at(Math.floor(rand() * 100) + 100)
      : null;
    out.push({
      bookingCode: `FQ-2026-${String(1000000 + i).padStart(7, '0')}`,
      tokenNumber: i + 1,
      laneNo: 1 + Math.floor(rand() * 3),
      status,
      scheduledStartAt: at(Math.floor(rand() * 480)),
      processingMinutes: 30 + Math.floor(rand() * 150),
      serviceStartedAt: started,
      serviceEndedAt: ended,
    });
  }
  return out;
}

describe('queue invariants over generated states', () => {
  it('holds every invariant across 300 randomly generated centre-days', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = mulberry32(seed);
      const day = generateDay(rand, 1 + Math.floor(rand() * 14));
      const now = at(Math.floor(rand() * 300));
      const out = projectQueue(day, now, CFG);
      const ctx = `seed=${seed}`;

      // Positions are exactly 1..n: no duplicate, no gap, none below 1.
      assert.deepEqual(
        out.map((m) => m.position),
        out.map((_, i) => i + 1),
        `positions must be a dense 1-based sequence (${ctx})`,
      );
      assert.equal(new Set(out.map((m) => m.bookingCode)).size, out.length, `no duplicates ${ctx}`);

      // No terminal or finished booking is ever a queue member.
      for (const m of out) {
        assert.ok(!['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(m.status), `terminal in queue ${ctx}`);
        assert.notEqual(m.status, 'PAYMENT_PENDING', `finished booking in queue ${ctx}`);
        assert.ok(m.position >= 1, `position >= 1 ${ctx}`);
        assert.ok(m.waitMinutes >= 0, `wait must never be negative ${ctx}`);
        assert.ok(m.aheadOnLane <= m.aheadAtCentre, `lane subset of centre ${ctx}`);
        assert.ok(
          m.projectedEndAt.getTime() >= m.projectedStartAt.getTime(),
          `end must not precede start ${ctx}`,
        );
        assert.equal(m.aheadAtCentre, m.position - 1, `ahead is position-1 ${ctx}`);
      }

      // Position order agrees with the defined projected-start ordering.
      for (let i = 1; i < out.length; i += 1) {
        const prev = out[i - 1];
        const cur = out[i];
        const ok =
          prev.projectedStartAt.getTime() < cur.projectedStartAt.getTime() ||
          (prev.projectedStartAt.getTime() === cur.projectedStartAt.getTime() &&
            (prev.laneNo < cur.laneNo ||
              (prev.laneNo === cur.laneNo && prev.tokenNumber < cur.tokenNumber)));
        assert.ok(ok, `ordering must match the defined rule at ${i} (${ctx})`);
      }

      // Two bookings can never occupy the same lane at the same instant.
      for (const lane of [1, 2, 3]) {
        const onLane = out.filter((m) => m.laneNo === lane);
        for (let i = 1; i < onLane.length; i += 1) {
          assert.ok(
            onLane[i].projectedStartAt.getTime() >= onLane[i - 1].projectedStartAt.getTime(),
            `lane ${lane} projections must not go backwards (${ctx})`,
          );
        }
      }

      // Determinism, on the same generated state.
      assert.equal(JSON.stringify(projectQueue(day, now, CFG)), JSON.stringify(out), `stable ${ctx}`);
    }
  });
});

// ===========================================================================
// Integration
// ===========================================================================

const ALIGARH = 'DEMO-UP-ALIGARH-01';
const OTHER_CENTRE = 'DEMO-UP-AGRA-01';

async function centreAndCrop(centreCode: string, cropCode: string) {
  const r = await query<{ centre_id: string; crop_id: string }>(
    `SELECT pc.id AS centre_id, cr.id AS crop_id
       FROM procurement_centres pc, crops cr
      WHERE pc.code = $1 AND cr.code = $2`,
    [centreCode, cropCode],
  );
  return r.rows[0];
}

/** Next Wednesday: not the day Phase 7 (Monday) or Phase 8 (Tuesday) fill. */
function nextWednesday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 3);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

let seq = 0;
const idemKey = () => `queue-test-${Date.now()}-${seq++}`;

async function bookAt(centreCode: string, cropCode: string, quantityKg = 2500) {
  const reg = await registerFarmer(base);
  const { centre_id, crop_id } = await centreAndCrop(centreCode, cropCode);
  const res = await reg.client.request<{
    bookingCode: string;
    tokenNumber: number;
    serviceDate: string;
    laneNo: number;
  }>('POST', '/api/v1/bookings', {
    body: { centreId: centre_id, cropId: crop_id, quantityKg, preferredDate: nextWednesday() },
    headers: { 'idempotency-key': idemKey() },
  });
  if (res.status !== 201) throw new Error(`booking failed: ${JSON.stringify(res.body)}`);
  const d = res.body.data!;
  return {
    client: reg.client,
    phone: reg.phone,
    code: d.bookingCode,
    token: d.tokenNumber,
    serviceDate: d.serviceDate,
    laneNo: d.laneNo,
    centreId: centre_id,
  };
}

async function officerAt(centreCode: string) {
  const spec = {
    username: `q-off-${Date.now()}-${seq++}`,
    password: 'Officer-Passw0rd!',
    phone: uniquePhone(),
  };
  const c = await query<{ id: string }>('SELECT id FROM procurement_centres WHERE code = $1', [
    centreCode,
  ]);
  await createStaffUser({ ...spec, role: 'OFFICER', centreId: c.rows[0].id });
  return staffLogin(base, spec.username, spec.password, spec.phone);
}

async function adminClient() {
  const spec = {
    username: `q-adm-${Date.now()}-${seq++}`,
    password: 'Admin-Passw0rd!',
    phone: uniquePhone(),
  };
  await createStaffUser({ ...spec, role: 'ADMIN' });
  return staffLogin(base, spec.username, spec.password, spec.phone);
}

type C = ReturnType<typeof newClient>;
const myQueue = (c: C, code: string) => c.get(`/api/v1/bookings/${code}/queue`);
const centreQueue = (c: C, centreId: string, date?: string) =>
  c.get(`/api/v1/officer/centres/${centreId}/queue${date ? `?date=${date}` : ''}`);
const step = (c: C, code: string, s: string, body?: unknown) =>
  c.post(`/api/v1/officer/bookings/${code}/${s}`, body ?? {});

// ---------------------------------------------------------------------------

describe('farmer queue view', () => {
  it('reports position, lane and a SCHEDULED ETA for a future booking', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const r = await myQueue(b.client, b.code);

    assert.equal(r.status, 200);
    const d = r.body.data as Record<string, any>;

    assert.equal(d.bookingCode, b.code);
    assert.equal(d.tokenNumber, b.token);
    assert.equal(d.status, 'CONFIRMED');
    assert.equal(d.displayStatus, 'BOOKED');
    assert.equal(d.queueState, 'WAITING');
    assert.equal(d.inQueue, true);

    assert.ok(d.queuePosition >= 1, 'a real 1-based position');
    assert.equal(d.aheadAtCentre, d.queuePosition - 1);
    assert.ok(d.aheadOnLane <= d.aheadAtCentre);
    assert.equal(d.laneCount, 3, 'Aligarh has three configured lanes');
    assert.equal(d.laneNo, b.laneNo);

    assert.equal(d.etaConfidence, 'SCHEDULED', 'future date: no live evidence exists yet');
    assert.equal(d.etaUnavailableReason, null);
    assert.ok(d.estimatedStartAt, 'an estimate is present');
    assert.ok(d.estimatedWaitMinutes >= 0);
    assert.match(d.etaBasis, /not a live estimate/);

    assert.equal(d.pollAfterSeconds, 5, 'cadence is server-set');
    assert.ok(d.observedAt && d.serverTime, 'freshness is stated');
    assert.equal(d.centreTimezone, 'Asia/Kolkata');
  });

  it('keeps position and ETA as separate, separately-nullable concepts', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const d = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    // Both present here, but they are distinct fields with distinct meaning —
    // the contract never encodes one as the other.
    assert.notEqual(d.queuePosition, undefined);
    assert.notEqual(d.estimatedStartAt, undefined);
    assert.notEqual(d.etaConfidence, undefined);
  });

  it('never returns a UUID', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const r = await myQueue(b.client, b.code);
    assert.doesNotMatch(
      JSON.stringify(r.body),
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});

describe('queue ownership', () => {
  it('refuses another farmer’s booking with 404, identical to a nonexistent one', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const stranger = await registerFarmer(base);

    const foreign = await myQueue(stranger.client, b.code);
    const missing = await myQueue(stranger.client, 'FQ-2026-0000001');

    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(
      JSON.stringify(foreign.body.error!.code),
      JSON.stringify(missing.body.error!.code),
      'the two must be indistinguishable',
    );
  });

  it('cannot be redirected to another farmer by any request field', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const stranger = await registerFarmer(base);
    // There is no farmerId parameter to supply — identity comes from the
    // session — so the only lever is the code, and it is ownership-checked.
    const r = await stranger.client.get(
      `/api/v1/bookings/${b.code}/queue?farmerId=whatever&userId=whatever`,
    );
    assert.equal(r.status, 404);
  });

  it('rejects a malformed booking code before touching the database', async () => {
    const { client } = await registerFarmer(base);
    for (const bad of ['not-a-code', 'FQ-26-1', 'FQ-2026-12345678']) {
      const r = await client.get(`/api/v1/bookings/${bad}/queue`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error!.code, 'VALIDATION_FAILED');
    }
  });
});

describe('terminal states leave the queue', () => {
  it('removes a cancelled booking and moves everyone behind up', async () => {
    const a = await bookAt(ALIGARH, 'WHEAT');
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);

    const beforeB = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    await step(officer, a.code, 'arrive');
    await step(officer, a.code, 'cancel', { reason: 'Produce not as declared' });

    const afterA = (await myQueue(a.client, a.code)).body.data as Record<string, any>;
    assert.equal(afterA.inQueue, false);
    assert.equal(afterA.queueState, 'NOT_IN_QUEUE');
    assert.equal(afterA.queuePosition, null, 'no position');
    assert.equal(afterA.estimatedStartAt, null, 'no ETA');
    assert.equal(afterA.estimatedWaitMinutes, null, 'null, NOT zero');
    assert.equal(afterA.etaConfidence, 'UNAVAILABLE');
    assert.equal(afterA.etaUnavailableReason, 'BOOKING_NOT_ACTIVE');

    const afterB = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    assert.ok(
      afterB.queuePosition <= beforeB.queuePosition,
      'the farmer behind moved up, or held still',
    );
  });

  it('removes a no-show', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    await step(officer, b.code, 'no-show', { reason: 'Did not arrive' });

    const d = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    assert.equal(d.inQueue, false);
    assert.equal(d.queuePosition, null);
    assert.equal(d.etaUnavailableReason, 'BOOKING_NOT_ACTIVE');
    assert.equal(d.estimatedWaitMinutes, null);
  });

  it('removes a booking once its service is COMPLETE, before payment closes', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    await step(officer, b.code, 'arrive');
    await step(officer, b.code, 'weighing');
    await step(officer, b.code, 'weight', { grossQuantityKg: 2500 });
    await step(officer, b.code, 'quality', { acceptedQuantityKg: 2500, rejectedQuantityKg: 0 });
    await step(officer, b.code, 'complete');

    const d = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    assert.equal(d.status, 'PAYMENT_PENDING', 'still an ACTIVE booking');
    assert.equal(d.inQueue, false, 'but no longer in the physical queue');
    assert.equal(d.queuePosition, null);
    assert.equal(d.etaUnavailableReason, 'SERVICE_COMPLETE');
    assert.equal(d.estimatedWaitMinutes, null, 'null, not zero');
  });

  it('shows a booking as IN_SERVICE with an OBSERVED estimate while being served', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    await step(officer, b.code, 'arrive');
    await step(officer, b.code, 'weighing');

    const d = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    assert.equal(d.status, 'WEIGHING');
    assert.equal(d.queueState, 'IN_SERVICE');
    assert.equal(d.inQueue, true);
    assert.equal(d.etaConfidence, 'OBSERVED', 'the start is a recorded fact');
    assert.equal(d.aheadOnLane, 0, 'nobody is ahead of the farmer being served');
    assert.equal(d.currentlyServingToken, b.token, 'that farmer IS the one being served');
    assert.equal(d.estimatedWaitMinutes, 0);
    assert.match(d.etaBasis, /Service has started/);
  });
});

describe('officer centre queue', () => {
  it('returns per-lane current and next work for an assigned centre', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);

    const r = await centreQueue(officer, b.centreId, b.serviceDate);
    assert.equal(r.status, 200);
    const d = r.body.data as Record<string, any>;

    assert.equal(d.centreCode, ALIGARH);
    assert.equal(d.serviceDate, b.serviceDate);
    assert.equal(d.lanes.length, 3, 'all three configured lanes, idle ones included');
    assert.ok(d.activeQueueSize >= 1);
    assert.ok(d.queue.some((m: any) => m.bookingCode === b.code));

    const mine = d.queue.find((m: any) => m.bookingCode === b.code);
    assert.ok(mine.farmer.name, 'an officer must be able to identify who to call');
    assert.ok(mine.farmer.phone);
    assert.equal(mine.position, d.queue.indexOf(mine) + 1, 'position matches order');

    assert.doesNotMatch(
      JSON.stringify(r.body),
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      'no UUID even in the officer view',
    );
  });

  it('moves a booking from next to nowServing when weighing starts', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);

    const before = (await centreQueue(officer, b.centreId, b.serviceDate)).body.data as any;
    const laneBefore = before.lanes.find((l: any) => l.laneNo === b.laneNo);
    assert.equal(laneBefore.nowServing, null, 'nothing being served yet');

    await step(officer, b.code, 'arrive');
    await step(officer, b.code, 'weighing');

    const after = (await centreQueue(officer, b.centreId, b.serviceDate)).body.data as any;
    const laneAfter = after.lanes.find((l: any) => l.laneNo === b.laneNo);
    assert.equal(laneAfter.nowServing.bookingCode, b.code);
  });

  it('defaults the date to today at the centre', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    const r = await centreQueue(officer, b.centreId);
    assert.equal(r.status, 200);
    // Today is not the booking's future date, so the queue is a different day.
    assert.notEqual((r.body.data as any).serviceDate, b.serviceDate);
  });

  it('rejects an invalid centre id and an invalid date', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    assert.equal((await officer.get('/api/v1/officer/centres/not-a-uuid/queue')).status, 400);
    assert.equal((await centreQueue(officer, b.centreId, '12-03-2026')).status, 400);
  });
});

describe('queue security', () => {
  it('hides another centre’s queue behind 404, never 403', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const outsider = await officerAt(OTHER_CENTRE);
    const r = await centreQueue(outsider, b.centreId, b.serviceDate);
    assert.equal(r.status, 404);
    assert.equal(r.body.error!.code, 'NOT_FOUND');
  });

  it('refuses a farmer the officer queue and an officer the farmer route', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);

    assert.equal((await centreQueue(b.client, b.centreId, b.serviceDate)).status, 403);
    assert.equal((await myQueue(officer, b.code)).status, 403, 'officers lack queue.read.own');
  });

  it('lets an ADMIN read a centre queue without gaining any operational permission', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const admin = await adminClient();

    assert.equal((await centreQueue(admin, b.centreId, b.serviceDate)).status, 200);
    // Phase 8's non-grants are untouched by Phase 9.
    assert.equal((await step(admin, b.code, 'arrive')).status, 403);
    assert.equal((await myQueue(admin, b.code)).status, 403);
  });

  it('audits an authorization denial on a queue route', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    await centreQueue(b.client, b.centreId, b.serviceDate);

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE action = 'auth.authorization_denied'
          AND metadata->>'requiredPermission' = 'queue.read.centre'`,
    );
    assert.ok(Number(rows.rows[0].n) >= 1);
  });
});

describe('a poll is a read: no mutation, no audit', () => {
  it('changes nothing in the database (architecture §14.5 invariant)', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);

    const snapshot = async () =>
      (
        await query<{ s: string }>(
          `SELECT (SELECT count(*) FROM bookings)::text || '/' ||
                  (SELECT count(*) FROM procurements)::text || '/' ||
                  (SELECT count(*) FROM booking_status_history)::text || '/' ||
                  (SELECT count(*) FROM audit_logs)::text || '/' ||
                  (SELECT count(*) FROM notifications)::text AS s`,
        )
      ).rows[0].s;

    const before = await snapshot();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await myQueue(b.client, b.code)).status, 200);
      assert.equal((await centreQueue(officer, b.centreId, b.serviceDate)).status, 200);
    }
    assert.equal(await snapshot(), before, 'ten polls wrote nothing at all');
  });

  it('returns identical results for repeated reads of unchanged state', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const first = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    const second = (await myQueue(b.client, b.code)).body.data as Record<string, any>;

    // Everything except the freshness stamps must be byte-identical.
    for (const k of ['observedAt', 'serverTime', 'estimatedWaitMinutes']) {
      delete first[k];
      delete second[k];
    }
    assert.deepEqual(first, second);
  });
});

describe('queue concurrency', () => {
  it('never shows a half-applied transition while a booking is progressing', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    await step(officer, b.code, 'arrive');

    // Hammer the queue while weighing starts underneath it.
    const reads = Array.from({ length: 12 }, () => myQueue(b.client, b.code));
    const [, ...results] = await Promise.all([step(officer, b.code, 'weighing'), ...reads]);

    for (const r of results) {
      assert.equal(r.status, 200);
      const d = r.body.data as Record<string, any>;
      // Only committed states are ever observable, and each is self-consistent.
      assert.ok(['ARRIVED', 'WEIGHING'].includes(d.status), `unexpected ${d.status}`);
      if (d.status === 'ARRIVED') {
        assert.equal(d.queueState, 'WAITING');
      } else {
        assert.equal(d.queueState, 'IN_SERVICE');
        assert.equal(d.etaConfidence, 'OBSERVED');
      }
    }
  });

  it('survives a completion racing a queue read', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    await step(officer, b.code, 'arrive');
    await step(officer, b.code, 'weighing');
    await step(officer, b.code, 'weight', { grossQuantityKg: 2500 });
    await step(officer, b.code, 'quality', { acceptedQuantityKg: 2500, rejectedQuantityKg: 0 });

    const reads = Array.from({ length: 10 }, () => myQueue(b.client, b.code));
    const [, ...results] = await Promise.all([step(officer, b.code, 'complete'), ...reads]);

    for (const r of results) {
      const d = r.body.data as Record<string, any>;
      assert.equal(r.status, 200);
      // Either still in service, or finished — never both, never neither.
      if (d.inQueue) {
        assert.equal(d.queueState, 'IN_SERVICE');
        assert.notEqual(d.queuePosition, null);
      } else {
        assert.equal(d.queuePosition, null);
        assert.equal(d.estimatedWaitMinutes, null);
      }
    }
  });

  it('survives a cancellation and a no-show racing the centre queue', async () => {
    const a = await bookAt(ALIGARH, 'WHEAT');
    const b = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);
    await step(officer, a.code, 'arrive');

    const reads = Array.from({ length: 8 }, () => centreQueue(officer, a.centreId, a.serviceDate));
    const results = await Promise.all([
      step(officer, a.code, 'cancel', { reason: 'withdrawn' }),
      step(officer, b.code, 'no-show'),
      ...reads,
    ]);

    for (const r of results.slice(2)) {
      assert.equal(r.status, 200);
      const d = r.body.data as any;
      const codes = d.queue.map((m: any) => m.bookingCode);
      assert.equal(new Set(codes).size, codes.length, 'no duplicate members');
      for (const m of d.queue) {
        assert.ok(!['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(m.status));
        assert.ok(m.position >= 1);
      }
      const positions = d.queue.map((m: any) => m.position);
      assert.deepEqual(positions, positions.map((_: number, i: number) => i + 1));
    }
  });

  it('keeps multiple lanes progressing independently', async () => {
    const a = await bookAt(ALIGARH, 'WHEAT');
    const b = await bookAt(ALIGARH, 'WHEAT');
    const c = await bookAt(ALIGARH, 'WHEAT');
    const officer = await officerAt(ALIGARH);

    // Three fresh bookings at a three-lane centre take one lane each.
    const lanes = new Set([a.laneNo, b.laneNo, c.laneNo]);
    assert.equal(lanes.size, 3, 'the scheduler spread them across the lanes');

    await Promise.all([
      step(officer, a.code, 'arrive'),
      step(officer, b.code, 'arrive'),
      step(officer, c.code, 'arrive'),
    ]);
    await Promise.all([
      step(officer, a.code, 'weighing'),
      step(officer, b.code, 'weighing'),
      step(officer, c.code, 'weighing'),
    ]);

    const d = (await centreQueue(officer, a.centreId, a.serviceDate)).body.data as any;
    const serving = d.lanes.filter((l: any) => l.nowServing !== null);
    assert.equal(serving.length, 3, 'all three lanes serving at once');
    const servingCodes = serving.map((l: any) => l.nowServing.bookingCode);
    assert.equal(new Set(servingCodes).size, 3, 'and each lane serves a different booking');
  });
});

describe('queue rate limiting', () => {
  it('permits far more polls than the advertised cadence requires', () => {
    // The limit is derived, not picked: a client obeying pollAfterSeconds = 5
    // issues 900/5 = 180 requests per 15-minute window.
    const compliant = RateLimits.QUEUE_READ_PER_SESSION.windowSeconds / 5;
    assert.equal(compliant, 180);
    assert.ok(
      RateLimits.QUEUE_READ_PER_SESSION.limit > compliant * 2,
      'a compliant farmer client can never trip the limit',
    );
    assert.ok(
      RateLimits.OFFICER_QUEUE_PER_SESSION.limit > RateLimits.QUEUE_READ_PER_SESSION.limit,
      'an officer dashboard watches a whole centre and gets more headroom',
    );
  });

  it('rejects a session that exceeds its own bucket, without affecting others', async () => {
    const b = await bookAt(ALIGARH, 'WHEAT');
    const other = await bookAt(ALIGARH, 'WHEAT');

    // Drive the bucket to its limit directly rather than issuing 400 requests.
    const s = await query<{ id: string }>(
      `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.phone_e164 = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [`+91${b.phone}`],
    );
    const rule = RateLimits.QUEUE_READ_PER_SESSION;
    const windowMs = rule.windowSeconds * 1000;
    const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    await query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, hits, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bucket_key, window_started_at) DO UPDATE SET hits = EXCLUDED.hits`,
      [
        `${rule.name}:${s.rows[0].id}`,
        start,
        rule.limit,
        new Date(start.getTime() + windowMs),
      ],
    );

    const limited = await myQueue(b.client, b.code);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error!.code, 'RATE_LIMITED');
    assert.ok(limited.body.error!.details!.retryAfterSeconds, 'tells the client when to return');

    const unaffected = await myQueue(other.client, other.code);
    assert.equal(unaffected.status, 200, 'the limit is per session, not global');
  });
});

describe('stale bookings whose day has passed', () => {
  it('refuses to estimate, and says why', async () => {
    // No no-show sweep exists (Phase 8, R-8b), so a booking can outlive its
    // day. No API can create this, so it is constructed directly — which is
    // exactly the condition R-8b describes.
    const b = await bookAt(ALIGARH, 'WHEAT');
    await query(
      `UPDATE bookings
          SET service_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 3,
              scheduled_start_at = scheduled_start_at - interval '10 days',
              scheduled_end_at   = scheduled_end_at   - interval '10 days'
        WHERE booking_code = $1`,
      [b.code],
    );

    const d = (await myQueue(b.client, b.code)).body.data as Record<string, any>;
    assert.equal(d.status, 'CONFIRMED', 'still confirmed — nothing swept it');
    assert.equal(d.etaConfidence, 'UNAVAILABLE');
    assert.equal(d.etaUnavailableReason, 'SERVICE_DATE_PAST');
    assert.equal(d.estimatedStartAt, null);
    assert.equal(d.estimatedWaitMinutes, null, 'a reason, never a misleading number');
    assert.equal(d.queuePosition, null, 'and no ordinal in a queue that is not running');
  });
});

describe('a service date with no configuration in force', () => {
  it('reports a reason to the farmer and refuses to project for the officer', async () => {
    // A configuration can legitimately be end-dated. When that happens the
    // projection has no processing floor and no transition buffer, and the
    // honest answer is to say so — not to quietly borrow another date's
    // numbers. Reachable only by end-dating, so it is constructed here.
    const b = await bookAt('DEMO-UP-BULANDSHAHR-01', 'WHEAT');
    const officer = await officerAt('DEMO-UP-BULANDSHAHR-01');

    // In force today, but ending before the booking's service date.
    await query(
      `UPDATE centre_slot_configurations
          SET effective_to = (now() AT TIME ZONE 'Asia/Kolkata')::date + 1
        WHERE centre_id = $1`,
      [b.centreId],
    );
    try {
      const r = await myQueue(b.client, b.code);
      assert.equal(r.status, 200, 'the farmer can still read their own booking');
      const d = r.body.data as Record<string, any>;
      assert.equal(d.etaConfidence, 'UNAVAILABLE');
      assert.equal(d.etaUnavailableReason, 'CENTRE_CONFIGURATION_UNAVAILABLE');
      assert.equal(d.estimatedStartAt, null);
      assert.equal(d.estimatedWaitMinutes, null);
      assert.equal(d.queuePosition, null);
      assert.equal(d.activeQueueSize, null, 'not a misleading zero');

      const o = await centreQueue(officer, b.centreId, b.serviceDate);
      assert.equal(o.status, 422);
      assert.equal(o.body.error!.code, 'CENTRE_NOT_AVAILABLE');
    } finally {
      await query(
        `UPDATE centre_slot_configurations SET effective_to = NULL WHERE centre_id = $1`,
        [b.centreId],
      );
    }
  });
});

describe('status and service timestamps never disagree', () => {
  it('holds across every booking the whole suite has created', async () => {
    // engines/queue.ts decides membership from TIMESTAMPS. That is only safe
    // while the timestamps and the status label agree, so the agreement is
    // asserted rather than assumed.
    const bad = await query<{ booking_code: string; status: string; s: string; e: string }>(
      `SELECT b.booking_code, b.status,
              (pr.service_started_at IS NOT NULL)::text AS s,
              (pr.service_ended_at   IS NOT NULL)::text AS e
         FROM bookings b
         LEFT JOIN procurements pr ON pr.booking_id = b.id
        WHERE
          -- weighing onward must have a start
          (b.status IN ('WEIGHING','QUALITY_CHECK','PROCUREMENT_RECORDED')
             AND (pr.service_started_at IS NULL OR pr.service_ended_at IS NOT NULL))
          -- a settled booking must have an end
       OR (b.status IN ('PAYMENT_PENDING','COMPLETED')
             AND (pr.service_started_at IS NULL OR pr.service_ended_at IS NULL))
          -- nothing before arrival may have started service
       OR (b.status IN ('CONFIRMED','NO_SHOW') AND pr.service_started_at IS NOT NULL)`,
    );
    assert.equal(
      bad.rowCount,
      0,
      `status and timestamps disagree for: ${JSON.stringify(bad.rows.slice(0, 5))}`,
    );
  });
});
