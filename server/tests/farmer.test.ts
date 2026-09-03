/**
 * Phase 6: farmer domain, ownership security, quantity foundation, reference data.
 *
 * The ownership tests matter most. Phase 5 established authentication; these
 * establish that authentication actually constrains what a farmer can reach.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStaffUser,
  demoOtpFor,
  firstCentreId,
  getSeedDistrictId,
  newClient,
  query,
  registerFarmer,
  resetRateLimits,
  startTestServer,
  stopTestServer,
  uniquePhone,
} from './helpers.ts';
import { RateLimits } from '../src/core/rateLimit.ts';
import {
  MIN_QUANTITY_KG,
  MAX_QUANTITY_KG,
  checkQuantityKg,
  kgToQuintal,
  quintalToKg,
  assertDomainMatchesDatabase,
} from '../src/domain/quantity.ts';

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
describe('quantity foundation', () => {
  it('accepts the two boundary values and rejects just outside them', () => {
    assert.equal(checkQuantityKg(2500).ok, true, '2500 kg (25 quintal) must be accepted');
    assert.equal(checkQuantityKg(5000).ok, true, '5000 kg (50 quintal) must be accepted');

    const low = checkQuantityKg(2499);
    assert.equal(low.ok, false);
    assert.equal(low.ok === false && low.code, 'QUANTITY_BELOW_MINIMUM');

    const high = checkQuantityKg(5001);
    assert.equal(high.ok, false);
    assert.equal(high.ok === false && high.code, 'QUANTITY_ABOVE_MAXIMUM');
  });

  it('rejects non-integer and non-numeric quantities', () => {
    for (const bad of [2500.5, NaN, Infinity, '2500', null, undefined, {}]) {
      const r = checkQuantityKg(bad);
      assert.equal(r.ok, false, `${String(bad)} must be rejected`);
    }
  });

  it('converts quintal to kg at exactly 100 kg per quintal', () => {
    assert.equal(quintalToKg(25), MIN_QUANTITY_KG);
    assert.equal(quintalToKg(50), MAX_QUANTITY_KG);
    assert.equal(kgToQuintal(2500), 25);
    assert.equal(kgToQuintal(5000), 50);
  });

  it('the database enforces the same range independently of application code', async () => {
    // The application rule is not the only rule: prove PostgreSQL refuses too.
    const centre = await firstCentreId();
    const setup = await query<{ crop_id: string; season_id: string; farmer_id: string }>(
      `SELECT (SELECT id FROM crops WHERE code='WHEAT') AS crop_id,
              (SELECT id FROM seasons WHERE code='RMS') AS season_id,
              (SELECT id FROM farmers LIMIT 1)          AS farmer_id`,
    );
    const { crop_id, season_id, farmer_id } = setup.rows[0];
    if (!farmer_id || !centre) return; // nothing to bind a booking to

    const insert = (kg: number) =>
      query(
        `INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id,
             marketing_year, lane_no, requested_quantity_kg, service_date,
             scheduled_start_at, scheduled_end_at, estimated_processing_minutes,
             occupancy_minutes, token_number)
         VALUES ($1,$2,$3,$4,$5,'2026-27',1,$6, DATE '2027-01-04',
                 TIMESTAMPTZ '2027-01-04 08:00:00+05:30', TIMESTAMPTZ '2027-01-04 09:00:00+05:30',
                 60, 60, $7)`,
        [`FQ-2027-${String(kg).padStart(7, '0')}`, farmer_id, centre, crop_id, season_id, kg, kg],
      );

    await assert.rejects(() => insert(2499), /bookings_quantity_within_business_rule/);
    await assert.rejects(() => insert(5001), /bookings_quantity_within_business_rule/);

    // Clean up the two valid probes so the table stays empty for later phases.
    await query(`DELETE FROM bookings WHERE booking_code LIKE 'FQ-2027-%'`);
  });

  it('startup assertion catches domain/database drift', async () => {
    await assert.doesNotReject(() => assertDomainMatchesDatabase());
  });

  it('exposes the constraints so the UI need not hardcode them', async () => {
    const { client } = await registerFarmer(base);
    const res = await client.get<{ quantity: Record<string, unknown> }>(
      '/api/v1/reference/booking-constraints',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data!.quantity, {
      unit: 'kg',
      minKg: 2500,
      maxKg: 5000,
      minQuintal: 25,
      maxQuintal: 50,
      kgPerQuintal: 100,
      integerOnly: true,
    });
  });
});

// ===========================================================================
describe('farmer profile', () => {
  it('returns a canonical shape with a masked phone', async () => {
    const { client, phone, districtId } = await registerFarmer(base);
    const res = await client.get<{
      userId: string; fullName: string; phoneMasked: string; locale: string;
      roles: string[]; district: { id: string } | null; village: unknown;
    }>('/api/v1/me');

    assert.equal(res.status, 200);
    const me = res.body.data!;
    assert.equal(me.fullName, 'Test Farmer');
    assert.equal(me.locale, 'en');
    assert.deepEqual(me.roles, ['FARMER']);
    assert.equal(me.district!.id, districtId);

    // The full number must never come back.
    assert.ok(!JSON.stringify(me).includes(phone), 'full phone must not be returned');
    assert.match(me.phoneMasked, /^\*\*\*\d{2}$/);
  });

  it('updates permitted fields and audits before/after', async () => {
    const { client } = await registerFarmer(base);
    const upd = await client.patch('/api/v1/me', { fullName: 'Ramesh Verma', locale: 'hi' });
    assert.equal(upd.status, 200);

    const me = await client.get<{ fullName: string; locale: string }>('/api/v1/me');
    assert.equal(me.body.data!.fullName, 'Ramesh Verma');
    assert.equal(me.body.data!.locale, 'hi');

    const audit = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE action = 'profile.updated' AND before_state IS NOT NULL AND after_state IS NOT NULL`);
    assert.ok(Number(audit.rows[0].n) > 0, 'profile update must be audited with before/after');
  });

  it('rejects invalid profile updates server-side', async () => {
    const { client } = await registerFarmer(base);

    assert.equal((await client.patch('/api/v1/me', { fullName: 'A' })).status, 400);
    assert.equal((await client.patch('/api/v1/me', { locale: 'fr' })).status, 400);
    assert.equal((await client.patch('/api/v1/me', {})).status, 400);

    const badDistrict = await client.patch('/api/v1/me', {
      districtId: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(badDistrict.status, 400);
    assert.equal(badDistrict.body.error!.code, 'DISTRICT_NOT_FOUND');
  });

  it('does not expose Aadhaar or bank fields in any farmer response', async () => {
    const { client } = await registerFarmer(base);
    const me = await client.get('/api/v1/me');
    const blob = JSON.stringify(me.body).toLowerCase();
    for (const forbidden of ['aadhaar', 'ifsc', 'account_number', 'accountnumber']) {
      assert.ok(!blob.includes(forbidden), `${forbidden} must not appear`);
    }
  });
});

// ===========================================================================
describe('ownership security', () => {
  it('farmer A cannot read farmer B by supplying an id', async () => {
    const a = await registerFarmer(base);
    const b = await registerFarmer(base);

    const bMe = await b.client.get<{ userId: string }>('/api/v1/me');
    const bUserId = bMe.body.data!.userId;

    // There is deliberately no /farmers/:id route to attack.
    const direct = await a.client.get(`/api/v1/farmers/${bUserId}`);
    assert.equal(direct.status, 404, 'no by-id farmer endpoint may exist');

    // Supplying another user's id as a query parameter must change nothing:
    // identity comes from the session, never from the request.
    const spoofed = await a.client.get<{ userId: string }>(`/api/v1/me?userId=${bUserId}`);
    assert.equal(spoofed.status, 200);
    assert.notEqual(spoofed.body.data!.userId, bUserId);
    const aMe = await a.client.get<{ userId: string }>('/api/v1/me');
    assert.equal(spoofed.body.data!.userId, aMe.body.data!.userId);
  });

  it('farmer A cannot update farmer B by putting an id in the body', async () => {
    const a = await registerFarmer(base);
    const b = await registerFarmer(base);

    const bMe = await b.client.get<{ userId: string; fullName: string }>('/api/v1/me');
    const bUserId = bMe.body.data!.userId;
    const bNameBefore = bMe.body.data!.fullName;

    // Every shape an attacker might try. All must affect only A.
    const res = await a.client.patch('/api/v1/me', {
      userId: bUserId,
      farmerId: bUserId,
      id: bUserId,
      fullName: 'Hijacked Name',
    });
    assert.equal(res.status, 200);

    const bAfter = await b.client.get<{ fullName: string }>('/api/v1/me');
    assert.equal(bAfter.body.data!.fullName, bNameBefore, "farmer B's name must be unchanged");

    const aAfter = await a.client.get<{ fullName: string; userId: string }>('/api/v1/me');
    assert.equal(aAfter.body.data!.fullName, 'Hijacked Name', 'only the caller is affected');
    assert.notEqual(aAfter.body.data!.userId, bUserId);
  });

  it('a farmer cannot escalate role or status through the profile endpoint', async () => {
    const { client } = await registerFarmer(base);
    await client.patch('/api/v1/me', {
      roles: ['ADMIN'], role: 'ADMIN', status: 'SUSPENDED', permissions: ['audit.read'],
    });
    const me = await client.get<{ roles: string[]; status: string; permissions: string[] }>('/api/v1/me');
    assert.deepEqual(me.body.data!.roles, ['FARMER']);
    assert.equal(me.body.data!.status, 'ACTIVE');
    assert.ok(!me.body.data!.permissions.includes('audit.read'));
  });

  it('unauthenticated users cannot reach farmer-private data', async () => {
    const c = newClient(base);
    // `/reference/districts` is DELIBERATELY absent from this list: it is public
    // government geography, and registration — itself public — cannot work
    // without it. Everything genuinely private stays here.
    for (const path of [
      '/api/v1/me',
      '/api/v1/reference/crops',
      '/api/v1/reference/centres',
      '/api/v1/reference/booking-constraints',
      '/api/v1/bookings/me',
      '/api/v1/notifications',
    ]) {
      assert.equal((await c.get(path)).status, 401, `${path} must require authentication`);
    }
  });

  it('a revoked farmer session immediately loses profile access', async () => {
    const { client } = await registerFarmer(base);
    const me = await client.get<{ userId: string }>('/api/v1/me');
    await query(`UPDATE sessions SET revoked_at = now(), revoked_reason='TEST' WHERE user_id=$1`,
      [me.body.data!.userId]);
    assert.equal((await client.get('/api/v1/me')).status, 401);
  });
});

// ===========================================================================
describe('reference data', () => {
  it('returns districts with provenance', async () => {
    const { client } = await registerFarmer(base);
    const res = await client.get<Array<{ id: string; name: string; dataType: string; state: { lgdCode: string } }>>(
      '/api/v1/reference/districts');
    assert.equal(res.status, 200);
    assert.equal(res.body.data!.length, 5);
    for (const d of res.body.data!) {
      assert.equal(d.dataType, 'CONFIGURED', 'demonstration districts must not claim OFFICIAL');
      assert.equal(d.state.lgdCode, '9', 'state carries the verified LGD code');
    }
  });

  it('reports honestly that no village data exists', async () => {
    const { client, districtId } = await registerFarmer(base);
    const res = await client.get<{ available: boolean; reasonCode: string | null; villages: unknown[] }>(
      `/api/v1/reference/villages?districtId=${districtId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data!.available, false);
    assert.equal(res.body.data!.reasonCode, 'NO_VILLAGE_DATA_FOR_DISTRICT');
    assert.deepEqual(res.body.data!.villages, []);
  });

  it('validates districtId on the villages endpoint', async () => {
    const { client } = await registerFarmer(base);
    assert.equal((await client.get('/api/v1/reference/villages')).status, 400);
    assert.equal((await client.get('/api/v1/reference/villages?districtId=nope')).status, 400);
  });

  it('resolves crop to season and marketing year from the OFFICIAL MSP import', async () => {
    const { client } = await registerFarmer(base);
    const res = await client.get<Array<{
      code: string; canonicalName: string; dataType: string;
      season: { code: string } | null; marketingYear: string | null; grades: string[];
      eligibleCentreCount: number;
    }>>('/api/v1/reference/crops');
    assert.equal(res.status, 200);

    const byCode = new Map(res.body.data!.map((c) => [c.code, c]));

    const wheat = byCode.get('WHEAT')!;
    assert.equal(wheat.dataType, 'OFFICIAL');
    assert.equal(wheat.season!.code, 'RMS');
    assert.equal(wheat.marketingYear, '2026-27');
    assert.deepEqual(wheat.grades, [], 'wheat is published as a single rate');
    assert.ok(wheat.eligibleCentreCount > 0);

    const paddy = byCode.get('PADDY')!;
    assert.equal(paddy.season!.code, 'KMS', 'paddy is Kharif, not Rabi — seasons are never mixed');
    assert.deepEqual(paddy.grades, ['Common', 'Grade A'], 'per-variety rates are surfaced');

    // The prototype's "Rice" and "Other" have no backend equivalent.
    assert.equal(byCode.has('RICE'), false);
    assert.equal(byCode.has('OTHER'), false);
  });

  it('filters centres by crop eligibility', async () => {
    const { client } = await registerFarmer(base);
    const crops = await client.get<Array<{ id: string; code: string }>>('/api/v1/reference/crops');
    const wheatId = crops.body.data!.find((c) => c.code === 'WHEAT')!.id;
    const barleyId = crops.body.data!.find((c) => c.code === 'BARLEY')!.id;

    const forWheat = await client.get<unknown[]>(`/api/v1/reference/centres?cropId=${wheatId}`);
    assert.equal(forWheat.status, 200);
    assert.equal(forWheat.body.data!.length, 5, 'all five demo centres accept wheat');

    const forBarley = await client.get<unknown[]>(`/api/v1/reference/centres?cropId=${barleyId}`);
    assert.equal(forBarley.body.data!.length, 0, 'no centre is configured for barley');
  });

  it('reports NO_CAPACITY_DATA_FOR_CENTRE rather than inventing storage', async () => {
    const { client } = await registerFarmer(base);
    const res = await client.get<Array<{ storage: { checkMode: string; status: string; reasonCode: string } }>>(
      '/api/v1/reference/centres');
    assert.ok(res.body.data!.length > 0);
    for (const c of res.body.data!) {
      assert.equal(c.storage.checkMode, 'ADVISORY');
      assert.equal(c.storage.status, 'NOT_AVAILABLE');
      assert.equal(c.storage.reasonCode, 'NO_CAPACITY_DATA_FOR_CENTRE');
    }
  });

  it('labels demonstration centres as CONFIGURED, never OFFICIAL', async () => {
    const { client } = await registerFarmer(base);
    const res = await client.get<Array<{ code: string; dataType: string }>>('/api/v1/reference/centres');
    for (const c of res.body.data!) {
      assert.equal(c.dataType, 'CONFIGURED');
      assert.match(c.code, /^DEMO-/, 'demo centres carry the DEMO- prefix');
    }
  });
});

// ===========================================================================
describe('reference data authorization', () => {
  it('officers and admins may also read reference data', async () => {
    const centreId = await firstCentreId();
    const officer = { username: `p6off_${Date.now()}`, password: 'Officer#Pass123', phone: uniquePhone() };
    await createStaffUser({ ...officer, role: 'OFFICER', centreId });

    const c = newClient(base);
    await c.primeCsrf();
    const step1 = await c.post<{ challengeId: string }>('/api/v1/auth/staff/login', {
      username: officer.username, password: officer.password });
    await c.post('/api/v1/auth/otp/verify', {
      challengeId: step1.body.data!.challengeId, otp: demoOtpFor(officer.phone) });

    assert.equal((await c.get('/api/v1/reference/crops')).status, 200);
    assert.equal((await c.get('/api/v1/reference/districts')).status, 200);
    // But still not admin-only data.
    assert.equal((await c.get('/api/v1/admin/audit-logs')).status, 403);
  });
});

// ===========================================================================
describe('registration end to end (Phase 6 regression)', () => {
  it('registers using ids obtained from the reference API', async () => {
    // Proves the contract is self-consistent: a client with no hardcoded data
    // can complete registration using only what the API gave it.
    const seed = await registerFarmer(base);
    const districts = await seed.client.get<Array<{ id: string; name: string }>>(
      '/api/v1/reference/districts');
    const aligarh = districts.body.data!.find((d) => d.name === 'Aligarh')!;

    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();

    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Sunita Devi',
      phone,
      districtId: aligarh.id,
      locale: 'hi',
      consent: { policyVersion: 'v1', accepted: true },
    });
    assert.equal(start.status, 201);

    const verify = await c.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId, otp: demoOtpFor(phone) });
    assert.equal(verify.status, 201);

    const me = await c.get<{ locale: string; district: { name: string } }>('/api/v1/me');
    assert.equal(me.body.data!.locale, 'hi');
    assert.equal(me.body.data!.district.name, 'Aligarh');
  });

  it('still rejects Aadhaar and IFSC if a stale client sends them', async () => {
    const phone = uniquePhone();
    const districtId = await getSeedDistrictId();
    const c = newClient(base);
    await c.primeCsrf();

    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Legacy Client',
      phone,
      districtId,
      aadhaarLast4: '1234',
      ifscCode: 'SBIN0001234',
      consent: { policyVersion: 'v1', accepted: true },
    });
    assert.equal(start.status, 201, 'unknown fields are ignored, not fatal');

    await c.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId, otp: demoOtpFor(phone) });

    const stored = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pending_registrations WHERE phone_e164 = $1`, [`+91${phone}`]);
    assert.equal(stored.rows[0].n, '0', 'pending row consumed');

    const cols = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND (column_name ILIKE '%aadhaar%' OR column_name ILIKE '%ifsc%')`);
    assert.equal(cols.rows[0].n, '0', 'and there is nowhere for them to have been stored');
  });
});

// ===========================================================================
// Submission hardening: the public registration bootstrap
//
// The suite's own registerFarmer() helper reads a district id straight from the
// database, which is why nothing caught that a REAL client could not obtain one.
// These tests use ONLY what an unauthenticated client can actually reach.
// ===========================================================================

describe('registration is reachable using only public endpoints', () => {
  it('lists districts without a session, because registration needs a districtId', async () => {
    const anon = newClient(base);
    const r = await anon.get('/api/v1/reference/districts');
    assert.equal(r.status, 200, 'a farmer with no account must be able to load districts');
    const list = r.body.data as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(list) && list.length > 0);
    assert.ok(list[0].id, 'and the id registration requires is present');
  });

  it('completes a whole registration without ever reading the database', async () => {
    const anon = newClient(base);
    await anon.primeCsrf();

    // Step 1: discover a district the way a real client must.
    const districts = (await anon.get('/api/v1/reference/districts')).body.data as Array<{
      id: string;
    }>;
    const districtId = districts[0].id;

    // Step 2: register with it.
    const phone = uniquePhone();
    const start = await anon.post<{ challengeId: string }>(
      '/api/v1/auth/farmer/register/start-otp',
      {
        fullName: 'Bootstrap Farmer',
        phone,
        districtId,
        locale: 'en',
        consent: { policyVersion: 'v1', accepted: true },
      },
    );
    assert.equal(start.status, 201, JSON.stringify(start.body));

    const verify = await anon.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId,
      otp: demoOtpFor(phone),
    });
    assert.equal(verify.status, 201, 'a real client can register end to end');
  });

  it('keeps every OTHER reference endpoint behind a session', async () => {
    const anon = newClient(base);
    for (const path of [
      '/api/v1/reference/villages?districtId=00000000-0000-4000-8000-000000000000',
      '/api/v1/reference/crops',
      '/api/v1/reference/centres',
      '/api/v1/reference/booking-constraints',
    ]) {
      const r = await anon.get(path);
      assert.equal(r.status, 401, `${path} must NOT have become public`);
    }
  });

  it('rate limits the public districts endpoint per IP', async () => {
    const rule = RateLimits.PUBLIC_REFERENCE_PER_IP;
    // One real request first, so the bucket key is whatever the server actually
    // derives from the connection rather than an assumed IP format.
    assert.equal((await newClient(base).get('/api/v1/reference/districts')).status, 200);

    const bucket = await query<{ bucket_key: string; window_started_at: Date }>(
      `SELECT bucket_key, window_started_at FROM rate_limit_buckets
        WHERE bucket_key LIKE $1 ORDER BY window_started_at DESC LIMIT 1`,
      [`${rule.name}:%`],
    );
    assert.equal(bucket.rowCount, 1, 'the public endpoint must consume a bucket at all');

    await query('UPDATE rate_limit_buckets SET hits = $2 WHERE bucket_key = $1', [
      bucket.rows[0].bucket_key,
      rule.limit,
    ]);

    const r = await newClient(base).get('/api/v1/reference/districts');
    assert.equal(r.status, 429, 'an unauthenticated endpoint is still bounded');
  });
});
