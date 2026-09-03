/**
 * Phase 8: officer operations.
 *
 * Split the way Phase 7 split:
 *   - engine tests are PURE, so every MSP-resolution and money edge is
 *     reachable without a database
 *   - integration tests drive the real app over real HTTP, because centre
 *     scope, the state-machine trigger and the payment constraints only exist
 *     end to end
 *
 * Centre: MATHURA, deliberately. It configures BOTH Wheat (one ungraded MSP
 * rate) and Paddy (two graded rates), so the resolved and the blocked payment
 * paths are both reachable at one centre — and it is not the centre Phase 7's
 * suite loads up.
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
  withTransaction,
} from './helpers.ts';
import {
  computePayment,
  deriveQualityStatus,
  paiseToRupeeString,
  resolveMspRate,
} from '../src/engines/procurement.ts';
import type { MspCandidate } from '../src/engines/procurement.ts';

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

describe('quality classification (pure)', () => {
  it('is REJECTED when nothing was accepted', () => {
    assert.equal(deriveQualityStatus(1000, 0, 1000), 'REJECTED');
    assert.equal(deriveQualityStatus(1000, 0, 0), 'REJECTED', 'even with nothing formally rejected');
  });

  it('is ACCEPTED only when the whole gross was accepted', () => {
    assert.equal(deriveQualityStatus(1000, 1000, 0), 'ACCEPTED');
  });

  it('is PARTIALLY_ACCEPTED when any quantity was rejected', () => {
    assert.equal(deriveQualityStatus(1000, 900, 100), 'PARTIALLY_ACCEPTED');
  });

  it('treats an unexplained shortfall as partial, not as full acceptance', () => {
    // 950 accepted, nothing rejected, 50 kg unaccounted for. The shortfall must
    // stay visible rather than being rounded up into ACCEPTED.
    assert.equal(deriveQualityStatus(1000, 950, 0), 'PARTIALLY_ACCEPTED');
  });
});

const COMMON: MspCandidate = { id: 'r1', ratePerQuintalPaise: 244100, varietyOrGrade: 'Common' };
const GRADE_A: MspCandidate = { id: 'r2', ratePerQuintalPaise: 246100, varietyOrGrade: 'Grade A' };
const WHEAT_RATE: MspCandidate = { id: 'r3', ratePerQuintalPaise: 258500, varietyOrGrade: null };

describe('MSP resolution (pure)', () => {
  it('blocks with NO_ACTIVE_MSP when there is no rate at all', () => {
    const r = resolveMspRate([], 'Grade A');
    assert.equal(r.resolved, false);
    assert.equal(r.resolved === false && r.reason, 'NO_ACTIVE_MSP');
  });

  it('resolves a single ungraded rate with or without a recorded grade', () => {
    for (const grade of [null, '', 'Anything']) {
      const r = resolveMspRate([WHEAT_RATE], grade);
      assert.equal(r.resolved, true, `grade=${JSON.stringify(grade)}`);
      assert.equal(r.resolved === true && r.rate.id, 'r3');
    }
  });

  it('BLOCKS an ungraded paddy: two rates and nothing to choose between them', () => {
    const r = resolveMspRate([COMMON, GRADE_A], null);
    assert.equal(r.resolved, false);
    assert.equal(r.resolved === false && r.reason, 'MSP_AMBIGUOUS');
    assert.deepEqual(r.resolved === false && r.candidateGrades, ['Common', 'Grade A']);
  });

  it('resolves paddy once a grade is recorded', () => {
    const r = resolveMspRate([COMMON, GRADE_A], 'Grade A');
    assert.equal(r.resolved, true);
    assert.equal(r.resolved === true && r.rate.ratePerQuintalPaise, 246100);
  });

  it('matches a grade case-insensitively and ignores surrounding whitespace', () => {
    for (const g of ['grade a', '  GRADE A  ', 'Grade A']) {
      const r = resolveMspRate([COMMON, GRADE_A], g);
      assert.equal(r.resolved, true, g);
      assert.equal(r.resolved === true && r.rate.id, 'r2');
    }
  });

  it('does not match a grade that no rate carries', () => {
    const r = resolveMspRate([COMMON, GRADE_A], 'Premium');
    assert.equal(r.resolved, false);
    assert.equal(r.resolved === false && r.reason, 'NO_ACTIVE_MSP',
      'a grade with no rate is not the same as "we cannot tell which"');
  });

  it('never silently picks the cheaper rate', () => {
    const r = resolveMspRate([COMMON, GRADE_A], '   ');
    assert.equal(r.resolved, false, 'whitespace is not a grade');
  });
});

describe('payment arithmetic (pure)', () => {
  it('prices accepted quantity against the configured rate', () => {
    // 2 500 kg = 25 quintal at 2585.00/quintal = 64 625.00
    assert.equal(computePayment(2500, 258500).amountPaise, 6462500);
    assert.equal(paiseToRupeeString(6462500), '64625.00');
  });

  it('produces a different amount for the same quantity at a different rate', () => {
    assert.equal(computePayment(2500, 244100).amountPaise, 6102500, 'paddy Common');
    assert.equal(computePayment(2500, 246100).amountPaise, 6152500, 'paddy Grade A');
  });

  it('is zero when nothing was accepted, and that is not the same as blocked', () => {
    const p = computePayment(0, 258500);
    assert.equal(p.baseAmountPaise, 0);
    assert.equal(p.amountPaise, 0);
  });

  it('rounds to the paisa, half away from zero', () => {
    // 1 kg = 0.01 quintal; a rate of 250 paise/quintal gives 2.5 paise.
    assert.equal(computePayment(1, 250).baseAmountPaise, 3);
    assert.equal(computePayment(1, 150).baseAmountPaise, 2, '1.5 -> 2');
  });

  it('never returns a negative amount', () => {
    const p = computePayment(100, 100000, 999999999);
    assert.equal(p.amountPaise, 0);
    assert.ok(p.baseAmountPaise > 0, 'the base is still recorded');
  });

  it('formats paise without floating point drift', () => {
    assert.equal(paiseToRupeeString(1), '0.01');
    assert.equal(paiseToRupeeString(100), '1.00');
    assert.equal(paiseToRupeeString(6102500), '61025.00');
  });
});

// ===========================================================================
// Integration
// ===========================================================================

const MATHURA = 'DEMO-UP-MATHURA-01';
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

/** Next Tuesday: never a Sunday, never in the past, and not the day Phase 7 fills. */
function nextTuesday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 2);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

let seq = 0;
const idemKey = () => `officer-test-${Date.now()}-${seq++}`;

/** Registers a farmer and books at the given centre, returning the code. */
async function bookAt(centreCode: string, cropCode: string, quantityKg = 2500) {
  const { client } = await registerFarmer(base);
  const { centre_id, crop_id } = await centreAndCrop(centreCode, cropCode);
  const res = await client.request<{
    bookingCode: string;
    tokenNumber: number;
    serviceDate: string;
  }>('POST', '/api/v1/bookings', {
    body: { centreId: centre_id, cropId: crop_id, quantityKg, preferredDate: nextTuesday() },
    headers: { 'idempotency-key': idemKey() },
  });
  if (res.status !== 201) throw new Error(`booking failed: ${JSON.stringify(res.body)}`);
  // The engine returns the day it ACTUALLY scheduled, which rolls forward once
  // Tuesday's lanes fill. Tests must follow the booking, not the preference.
  return {
    client,
    code: res.body.data!.bookingCode,
    token: res.body.data!.tokenNumber,
    serviceDate: res.body.data!.serviceDate,
    centre_id,
  };
}

type Staff = { username: string; password: string; phone: string };

function staffSpec(): Staff {
  return { username: `off-${Date.now()}-${seq++}`, password: 'Officer-Passw0rd!', phone: uniquePhone() };
}

/** An officer assigned to `centreCode`, logged in through both factors. */
async function officerAt(centreCode: string) {
  const spec = staffSpec();
  const c = await query<{ id: string }>('SELECT id FROM procurement_centres WHERE code = $1', [
    centreCode,
  ]);
  await createStaffUser({ ...spec, role: 'OFFICER', centreId: c.rows[0].id });
  return staffLogin(base, spec.username, spec.password, spec.phone);
}

async function adminClient() {
  const spec = staffSpec();
  await createStaffUser({ ...spec, role: 'ADMIN' });
  return staffLogin(base, spec.username, spec.password, spec.phone);
}

type C = ReturnType<typeof newClient>;
const post = (c: C, code: string, step: string, body?: unknown) =>
  c.post(`/api/v1/officer/bookings/${code}/${step}`, body ?? {});

/** Drives a booking from CONFIRMED to PROCUREMENT_RECORDED. */
async function runToQualityRecorded(
  officer: C,
  code: string,
  opts: { grossKg?: number; acceptedKg?: number; rejectedKg?: number; grade?: string | null } = {},
) {
  const gross = opts.grossKg ?? 2500;
  const accepted = opts.acceptedKg ?? gross;
  const rejected = opts.rejectedKg ?? 0;

  assert.equal((await post(officer, code, 'arrive')).status, 200, 'arrive');
  assert.equal((await post(officer, code, 'weighing')).status, 200, 'weighing');
  assert.equal(
    (await post(officer, code, 'weight', { grossQuantityKg: gross })).status,
    200,
    'weight',
  );

  const quality: Record<string, unknown> = {
    acceptedQuantityKg: accepted,
    rejectedQuantityKg: rejected,
  };
  if (opts.grade !== undefined && opts.grade !== null) quality.grade = opts.grade;
  if (rejected > 0) quality.rejectionReason = 'Moisture above the permitted limit';

  const q = await post(officer, code, 'quality', quality);
  assert.equal(q.status, 200, `quality: ${JSON.stringify(q.body)}`);
  return q;
}

// ---------------------------------------------------------------------------

describe('the officer lifecycle', () => {
  it('runs CONFIRMED to COMPLETED and prices wheat at the seeded MSP rate', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);

    const arrived = await post(officer, code, 'arrive');
    assert.equal(arrived.status, 200);
    let d = arrived.body.data as Record<string, any>;
    assert.equal(d.booking.status, 'ARRIVED');
    assert.equal(d.booking.displayStatus, 'WAITING');
    assert.ok(d.procurement.arrivedAt, 'arrival is timestamped by the database');

    assert.equal((await post(officer, code, 'weighing')).status, 200);

    const weighed = await post(officer, code, 'weight', { grossQuantityKg: 2480.5 });
    assert.equal(weighed.status, 200);
    d = weighed.body.data as Record<string, any>;
    assert.equal(d.booking.status, 'QUALITY_CHECK');
    assert.equal(d.procurement.grossQuantityKg, 2480.5, 'the weighbridge reads to the gram');

    const quality = await post(officer, code, 'quality', {
      acceptedQuantityKg: 2480.5,
      rejectedQuantityKg: 0,
      moisturePercent: 11.5,
    });
    assert.equal(quality.status, 200);
    d = quality.body.data as Record<string, any>;
    assert.equal(d.booking.status, 'PROCUREMENT_RECORDED');
    assert.equal(d.procurement.qualityStatus, 'ACCEPTED');

    const completed = await post(officer, code, 'complete');
    assert.equal(completed.status, 200);
    d = completed.body.data as Record<string, any>;
    assert.equal(d.booking.status, 'PAYMENT_PENDING');
    assert.equal(d.procurement.status, 'COMPLETED');

    // 2480.5 kg = 24.805 quintal at 2585.00 = 64 120.93 (rounded from 64120.925)
    assert.equal(d.payment.status, 'PENDING');
    assert.equal(d.payment.blockedReason, null);
    assert.equal(d.payment.ratePerQuintalPaise, 258500);
    assert.equal(d.payment.amountPaise, 6412093);
    assert.equal(d.payment.amountRupees, '64120.93');
    assert.equal(d.payment.deductionsPaise, 0);

    // The SQL and the pure engine must agree.
    assert.equal(computePayment(2480.5, 258500).amountPaise, d.payment.amountPaise);

    const paid = await post(officer, code, 'payment', {
      status: 'INITIATED',
    });
    assert.equal(paid.status, 200);

    const done = await post(officer, code, 'payment', {
      status: 'PAID',
      paymentReference: 'UTR-TEST-0001',
    });
    assert.equal(done.status, 200);
    d = done.body.data as Record<string, any>;
    assert.equal(d.booking.status, 'COMPLETED', 'PAID is what closes the booking');
    assert.equal(d.payment.paymentReference, 'UTR-TEST-0001');
    assert.ok(d.payment.paidAt);
  });

  it('records a partial acceptance and prices only what was accepted', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);

    const q = await runToQualityRecorded(officer, code, {
      grossKg: 2500,
      acceptedKg: 2000,
      rejectedKg: 500,
    });
    assert.equal((q.body.data as any).procurement.qualityStatus, 'PARTIALLY_ACCEPTED');

    const completed = await post(officer, code, 'complete');
    const pay = (completed.body.data as any).payment;
    // 20 quintal at 2585.00 = 51 700.00 — the rejected 500 kg is not paid for.
    assert.equal(pay.amountPaise, 5170000);
  });

  it('writes every transition to booking_status_history', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const rows = await query<{ from_status: string; to_status: string }>(
      `SELECT h.from_status, h.to_status
         FROM booking_status_history h JOIN bookings b ON b.id = h.booking_id
        WHERE b.booking_code = $1 ORDER BY h.changed_at, h.to_status`,
      [code],
    );
    const path = rows.rows.map((r) => r.to_status);
    assert.deepEqual(path, [
      'CONFIRMED', // written by creation in Phase 7
      'ARRIVED',
      'WEIGHING',
      'QUALITY_CHECK',
      'PROCUREMENT_RECORDED',
      'PAYMENT_PENDING',
    ]);
    assert.equal(rows.rows[0].from_status, null, 'a new booking has no previous status');
    assert.equal(rows.rows[1].from_status, 'CONFIRMED');
  });
});

describe('MSP resolution end to end', () => {
  it('BLOCKS paddy when no grade was recorded, and says why', async () => {
    const { code } = await bookAt(MATHURA, 'PADDY');
    const officer = await officerAt(MATHURA);

    await runToQualityRecorded(officer, code);
    const completed = await post(officer, code, 'complete');
    assert.equal(completed.status, 200, 'the procurement still completes');

    const d = completed.body.data as Record<string, any>;
    assert.equal(d.booking.status, 'PAYMENT_PENDING');
    assert.equal(d.payment.status, 'BLOCKED');
    assert.equal(d.payment.blockedReason, 'MSP_AMBIGUOUS');
    assert.equal(d.payment.amountPaise, null, 'no amount is invented');
    assert.equal(d.payment.ratePerQuintalPaise, null);
  });

  it('prices paddy at Grade A once the officer records the grade', async () => {
    const { code } = await bookAt(MATHURA, 'PADDY');
    const officer = await officerAt(MATHURA);

    await runToQualityRecorded(officer, code, { grade: 'Grade A' });
    const completed = await post(officer, code, 'complete');
    const pay = (completed.body.data as any).payment;

    assert.equal(pay.status, 'PENDING');
    assert.equal(pay.ratePerQuintalPaise, 246100, 'Grade A, not Common');
    assert.equal(pay.amountPaise, 6152500, '25 quintal at 2461.00');
  });

  it('prices the same paddy differently at Common — configuration, not code', async () => {
    const { code } = await bookAt(MATHURA, 'PADDY');
    const officer = await officerAt(MATHURA);

    await runToQualityRecorded(officer, code, { grade: 'common' });
    const pay = ((await post(officer, code, 'complete')).body.data as any).payment;
    assert.equal(pay.ratePerQuintalPaise, 244100, 'matched case-insensitively');
    assert.equal(pay.amountPaise, 6102500);
  });

  it('blocks a grade that no MSP rate carries', async () => {
    const { code } = await bookAt(MATHURA, 'PADDY');
    const officer = await officerAt(MATHURA);

    await runToQualityRecorded(officer, code, { grade: 'Premium Export' });
    const pay = ((await post(officer, code, 'complete')).body.data as any).payment;
    assert.equal(pay.status, 'BLOCKED');
    assert.equal(pay.blockedReason, 'NO_ACTIVE_MSP');
  });

  it('refuses to advance a blocked payment', async () => {
    const { code } = await bookAt(MATHURA, 'PADDY');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const r = await post(officer, code, 'payment', { status: 'INITIATED' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error!.code, 'PAYMENT_BLOCKED');
    assert.equal(r.body.error!.details!.blockedReason, 'MSP_AMBIGUOUS');
  });

  it('snapshots the rate so a later MSP revision cannot rewrite it', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const row = await query<{ snap: string; live: string }>(
      `SELECT p.rate_per_quintal_paise_snapshot::text AS snap,
              r.rate_per_quintal_paise::text AS live
         FROM payments p
         JOIN procurements pr ON pr.id = p.procurement_id
         JOIN bookings b ON b.id = pr.booking_id
         JOIN msp_rates r ON r.id = p.msp_rate_id
        WHERE b.booking_code = $1`,
      [code],
    );
    assert.equal(row.rows[0].snap, row.rows[0].live);
    assert.equal(row.rows[0].snap, '258500', 'the snapshot is a value, not a join');
  });
});

describe('the state machine refuses out-of-order work', () => {
  it('refuses to weigh a booking that has not arrived', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);

    const r = await post(officer, code, 'weight', { grossQuantityKg: 2500 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error!.code, 'INVALID_STATE_TRANSITION');
    assert.equal(r.body.error!.details!.currentStatus, 'CONFIRMED');
  });

  it('refuses a second arrival', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);

    assert.equal((await post(officer, code, 'arrive')).status, 200);
    const again = await post(officer, code, 'arrive');
    assert.equal(again.status, 409, 'a double tap is refused, not replayed');
    assert.equal(again.body.error!.code, 'INVALID_STATE_TRANSITION');
  });

  it('refuses to record a weight twice', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');
    await post(officer, code, 'weighing');
    assert.equal((await post(officer, code, 'weight', { grossQuantityKg: 2500 })).status, 200);

    // The booking has left WEIGHING, so the state check catches it first.
    const r = await post(officer, code, 'weight', { grossQuantityKg: 2400 });
    assert.equal(r.status, 409);
  });

  it('refuses to complete before quality has been recorded', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');

    const r = await post(officer, code, 'complete');
    assert.equal(r.status, 409);
  });

  it('is enforced by the DATABASE, not only by the service layer', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');

    // Bypass every line of application code and move the booking illegally.
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query(`UPDATE bookings SET status = 'COMPLETED' WHERE booking_code = $1`, [
          code,
        ]);
      }),
      /invalid booking status transition: CONFIRMED -> COMPLETED/,
    );
  });

  it('cannot reopen a completed booking', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');
    await post(officer, code, 'payment', { status: 'INITIATED' });
    await post(officer, code, 'payment', { status: 'PAID', paymentReference: 'UTR-X' });

    await assert.rejects(
      withTransaction(async (client) => {
        await client.query(`UPDATE bookings SET status = 'ARRIVED' WHERE booking_code = $1`, [code]);
      }),
      /invalid booking status transition: COMPLETED -> ARRIVED/,
    );
  });

  it('serialises two officers arriving the same booking', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const a = await officerAt(MATHURA);
    const b = await officerAt(MATHURA);

    const [r1, r2] = await Promise.all([post(a, code, 'arrive'), post(b, code, 'arrive')]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one wins');

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM procurements pr
         JOIN bookings b ON b.id = pr.booking_id WHERE b.booking_code = $1`,
      [code],
    );
    assert.equal(rows.rows[0].n, '1', 'only one procurement row exists');
  });
});

describe('measurement validation', () => {
  it('refuses accepted + rejected greater than the gross weight', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');
    await post(officer, code, 'weighing');
    await post(officer, code, 'weight', { grossQuantityKg: 2500 });

    const r = await post(officer, code, 'quality', {
      acceptedQuantityKg: 2000,
      rejectedQuantityKg: 600,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error!.code, 'QUANTITY_EXCEEDS_GROSS');
  });

  it('permits a shortfall, because moisture loss is real', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    const q = await runToQualityRecorded(officer, code, {
      grossKg: 2500,
      acceptedKg: 2450,
      rejectedKg: 0,
    });
    assert.equal((q.body.data as any).procurement.qualityStatus, 'PARTIALLY_ACCEPTED');
  });

  it('requires a reason when anything is rejected, and refuses one when nothing is', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');
    await post(officer, code, 'weighing');
    await post(officer, code, 'weight', { grossQuantityKg: 2500 });

    const missing = await post(officer, code, 'quality', {
      acceptedQuantityKg: 2000,
      rejectedQuantityKg: 500,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error!.code, 'REJECTION_REASON_REQUIRED');

    const spurious = await post(officer, code, 'quality', {
      acceptedQuantityKg: 2500,
      rejectedQuantityKg: 0,
      rejectionReason: 'none really',
    });
    assert.equal(spurious.status, 400);
    assert.equal(spurious.body.error!.code, 'REJECTION_REASON_NOT_APPLICABLE');
  });

  it('refuses a zero or negative gross weight', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');
    await post(officer, code, 'weighing');

    for (const grossQuantityKg of [0, -5]) {
      const r = await post(officer, code, 'weight', { grossQuantityKg });
      assert.equal(r.status, 400, `gross=${grossQuantityKg}`);
      assert.equal(r.body.error!.code, 'VALIDATION_FAILED');
    }
  });

  it('does not reuse the BOOKING quantity rule for a measured weight', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');
    await post(officer, code, 'weighing');

    // 1 200 kg is below the 2 500 kg booking minimum, and is a perfectly valid
    // thing for a weighbridge to read.
    const r = await post(officer, code, 'weight', { grossQuantityKg: 1200 });
    assert.equal(r.status, 200);
  });

  it('rejects a moisture reading outside 0-100', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');
    await post(officer, code, 'weighing');
    await post(officer, code, 'weight', { grossQuantityKg: 2500 });

    const r = await post(officer, code, 'quality', {
      acceptedQuantityKg: 2500,
      rejectedQuantityKg: 0,
      moisturePercent: 140,
    });
    assert.equal(r.status, 400);
  });
});

describe('centre scope', () => {
  it('hides a booking at another centre behind 404, never 403', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const outsider = await officerAt(OTHER_CENTRE);

    const read = await outsider.get(`/api/v1/officer/bookings/${code}`);
    assert.equal(read.status, 404);
    assert.equal(read.body.error!.code, 'NOT_FOUND');

    for (const step of ['arrive', 'weighing', 'no-show', 'complete', 'cancel']) {
      const r = await post(outsider, code, step);
      assert.equal(r.status, 404, `${step} must be indistinguishable from "no such booking"`);
    }
    const w = await post(outsider, code, 'weight', { grossQuantityKg: 2500 });
    assert.equal(w.status, 404);
  });

  it('refuses a day list for an unassigned centre with 404', async () => {
    const outsider = await officerAt(OTHER_CENTRE);
    const c = await query<{ id: string }>('SELECT id FROM procurement_centres WHERE code = $1', [
      MATHURA,
    ]);
    const r = await outsider.get(`/api/v1/officer/centres/${c.rows[0].id}/bookings`);
    assert.equal(r.status, 404);
  });

  it('lists the assigned centre day in service order', async () => {
    const { code, centre_id, serviceDate } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);

    const r = await officer.get(
      `/api/v1/officer/centres/${centre_id}/bookings?date=${serviceDate}`,
    );
    assert.equal(r.status, 200);
    const d = r.body.data as any;
    assert.ok(d.bookings.some((b: any) => b.bookingCode === code));

    const starts = d.bookings.map((b: any) => b.scheduledStartAt);
    assert.deepEqual(starts, [...starts].sort(), 'ordered by scheduled start');
  });

  it('finds a booking by code, token and phone within scope only', async () => {
    const { code, token } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    const outsider = await officerAt(OTHER_CENTRE);

    const byCode = await officer.get(`/api/v1/officer/bookings/search?q=${code}`);
    assert.equal(byCode.status, 200);
    assert.equal((byCode.body.data as any).count >= 1, true);

    const byToken = await officer.get(`/api/v1/officer/bookings/search?q=${token}`);
    assert.equal(byToken.status, 200);
    assert.ok(
      (byToken.body.data as any).bookings.some((b: any) => b.bookingCode === code),
      'token search finds it',
    );

    const outside = await outsider.get(`/api/v1/officer/bookings/search?q=${code}`);
    assert.equal(outside.status, 200);
    assert.equal((outside.body.data as any).count, 0, 'scope is applied in the query');
  });

  it('does not reveal whether an unknown phone is registered', async () => {
    const officer = await officerAt(MATHURA);
    const r = await officer.get('/api/v1/officer/bookings/search?q=9999999999');
    assert.equal(r.status, 200);
    assert.equal((r.body.data as any).count, 0);
  });
});

describe('permissions', () => {
  it('refuses a FARMER every officer endpoint', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const { client: farmer } = await registerFarmer(base);

    assert.equal((await farmer.get(`/api/v1/officer/bookings/${code}`)).status, 403);
    assert.equal((await post(farmer, code, 'arrive')).status, 403);
    assert.equal((await post(farmer, code, 'no-show')).status, 403);
    assert.equal(
      (await post(farmer, code, 'weight', { grossQuantityKg: 2500 })).status,
      403,
    );
    assert.equal((await farmer.get('/api/v1/officer/bookings/search?q=123')).status, 403);
  });

  it('refuses an ADMIN the operational permissions they were never granted', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const admin = await adminClient();

    // Admins configure the system; they do not stand at the weighbridge.
    assert.equal((await post(admin, code, 'arrive')).status, 403, 'booking.advance_state');
    assert.equal(
      (await post(admin, code, 'weight', { grossQuantityKg: 2500 })).status,
      403,
      'procurement.record_weight',
    );
    assert.equal((await post(admin, code, 'complete')).status, 403, 'procurement.complete');
    assert.equal((await post(admin, code, 'no-show')).status, 403, 'booking.mark_no_show');

    // But they DO hold the read permissions, and their scope is not an assignment.
    assert.equal((await admin.get(`/api/v1/officer/bookings/${code}`)).status, 200);
  });

  it('audits a denial rather than silently refusing', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const { client: farmer } = await registerFarmer(base);
    await post(farmer, code, 'arrive');

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE action = 'auth.authorization_denied'
          AND metadata->>'requiredPermission' = 'booking.advance_state'`,
    );
    assert.ok(Number(rows.rows[0].n) >= 1, 'the probe is recorded');
  });
});

describe('no-show and centre cancellation', () => {
  it('marks a no-show and releases the lane for rebooking', async () => {
    const { code, centre_id, serviceDate } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);

    const before = await query<{ n: string }>(
      `SELECT booking_count::text AS n FROM centre_daily_capacity
        WHERE centre_id = $1 AND service_date = $2::date`,
      [centre_id, serviceDate],
    );

    const r = await post(officer, code, 'no-show', { reason: 'Did not arrive by closing' });
    assert.equal(r.status, 200);
    assert.equal((r.body.data as any).booking.status, 'NO_SHOW');

    const after = await query<{ n: string }>(
      `SELECT booking_count::text AS n FROM centre_daily_capacity
        WHERE centre_id = $1 AND service_date = $2::date`,
      [centre_id, serviceDate],
    );
    assert.equal(
      Number(after.rows[0].n),
      Number(before.rows[0].n) - 1,
      'the day no longer counts a booking that never happened',
    );

    const row = await query<{ at: Date | null; by: string | null }>(
      'SELECT no_show_at AS at, no_show_by_user_id AS by FROM bookings WHERE booking_code = $1',
      [code],
    );
    assert.ok(row.rows[0].at, 'timestamped');
    assert.ok(row.rows[0].by, 'attributed to the officer');
  });

  it('cannot mark a no-show once the farmer has arrived', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');

    const r = await post(officer, code, 'no-show');
    assert.equal(r.status, 409);
  });

  it('cancels at the centre after arrival and frees the interval', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await post(officer, code, 'arrive');

    const r = await post(officer, code, 'cancel', { reason: 'Produce not as declared' });
    assert.equal(r.status, 200);
    assert.equal((r.body.data as any).booking.status, 'CANCELLED');

    const row = await query<{ reason: string; by: string | null }>(
      'SELECT cancellation_reason AS reason, cancelled_by_user_id AS by FROM bookings WHERE booking_code = $1',
      [code],
    );
    assert.equal(row.rows[0].reason, 'Produce not as declared');
    assert.ok(row.rows[0].by, 'attributed to the officer, not the farmer');
  });

  it('refuses a centre cancellation of a booking that has not arrived', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    // CONFIRMED -> CANCELLED is the FARMER's transition, not the officer's.
    const r = await post(officer, code, 'cancel');
    assert.equal(r.status, 409);
  });
});

describe('payment status', () => {
  it('requires a reference to mark a payment PAID', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');
    await post(officer, code, 'payment', { status: 'INITIATED' });

    const r = await post(officer, code, 'payment', { status: 'PAID' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error!.code, 'PAYMENT_REFERENCE_REQUIRED');
  });

  it('refuses an illegal payment transition', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const r = await post(officer, code, 'payment', {
      status: 'PAID',
      paymentReference: 'UTR-SKIP',
    });
    assert.equal(r.status, 409, 'PENDING cannot jump straight to PAID');
    assert.equal(r.body.error!.code, 'INVALID_PAYMENT_TRANSITION');
  });

  it('leaves the booking open on a FAILED payment', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');
    await post(officer, code, 'payment', { status: 'INITIATED' });

    const r = await post(officer, code, 'payment', { status: 'FAILED' });
    assert.equal(r.status, 200);
    assert.equal(
      (r.body.data as any).booking.status,
      'PAYMENT_PENDING',
      'the work is not finished, so the booking is not closed',
    );
  });

  it('lets an ADMIN update a payment status they do hold the permission for', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    const admin = await adminClient();
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const r = await post(admin, code, 'payment', { status: 'INITIATED' });
    assert.equal(r.status, 200);
  });
});

describe('the farmer sees what the officer recorded', () => {
  it('returns 404 before the procurement has begun', async () => {
    const { client, code } = await bookAt(MATHURA, 'WHEAT');
    const r = await client.get(`/api/v1/bookings/${code}/procurement`);
    assert.equal(r.status, 404, 'a procurement that has not started is absent, not empty');
  });

  it('shows the measurements and the amount once complete', async () => {
    const { client, code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code, { grossKg: 2500, acceptedKg: 2400, rejectedKg: 100 });
    await post(officer, code, 'complete');

    const r = await client.get(`/api/v1/bookings/${code}/procurement`);
    assert.equal(r.status, 200);
    const d = r.body.data as any;
    assert.equal(d.procurement.grossQuantityKg, 2500);
    assert.equal(d.procurement.acceptedQuantityKg, 2400);
    assert.equal(d.procurement.qualityStatus, 'PARTIALLY_ACCEPTED');
    assert.equal(d.payment.amountPaise, 6204000, '24 quintal at 2585.00');

    const p = await client.get(`/api/v1/bookings/${code}/payment`);
    assert.equal(p.status, 200);
    assert.equal((p.body.data as any).payment.amountRupees, '62040.00');
  });

  it('tells the farmer WHY a payment is blocked', async () => {
    const { client, code } = await bookAt(MATHURA, 'PADDY');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const p = await client.get(`/api/v1/bookings/${code}/payment`);
    assert.equal(p.status, 200);
    const pay = (p.body.data as any).payment;
    assert.equal(pay.status, 'BLOCKED');
    assert.equal(pay.blockedReason, 'MSP_AMBIGUOUS', 'a code the UI can translate');
    assert.equal(pay.amountPaise, null);
  });

  it('does not let one farmer read another farmer’s procurement', async () => {
    const { code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const { client: stranger } = await registerFarmer(base);
    assert.equal((await stranger.get(`/api/v1/bookings/${code}/procurement`)).status, 404);
    assert.equal((await stranger.get(`/api/v1/bookings/${code}/payment`)).status, 404);
  });

  it('never exposes a UUID in an officer or farmer response', async () => {
    const { client, code } = await bookAt(MATHURA, 'WHEAT');
    const officer = await officerAt(MATHURA);
    await runToQualityRecorded(officer, code);
    await post(officer, code, 'complete');

    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const farmerView = await client.get(`/api/v1/bookings/${code}/procurement`);
    assert.doesNotMatch(JSON.stringify(farmerView.body), uuid);

    const officerView = await officer.get(`/api/v1/officer/bookings/${code}`);
    assert.doesNotMatch(JSON.stringify(officerView.body), uuid);
  });
});
