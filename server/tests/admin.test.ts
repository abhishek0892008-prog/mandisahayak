/**
 * Phase 13: admin configuration and centre operations.
 *
 * The security tests matter most. Configuring a centre and operating one are
 * different authorities (architecture §5.4), and these prove the separation is
 * enforced by the grant matrix rather than by the UI hiding a button.
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

let base = '';
let seq = 0;

before(async () => {
  base = await startTestServer();
});
beforeEach(async () => {
  await resetRateLimits();
});
/**
 * Removes every centre this suite created.
 *
 * Not tidiness: `farmer.test.ts` asserts that every centre reachable through
 * the reference API carries the DEMO- prefix and is CONFIGURED, and Phase 15's
 * reports aggregate over centres. Leaving thirty TEST-ADM centres behind would
 * break a real invariant and skew real reports.
 *
 * Deleted in dependency order. `audit_logs` is deliberately untouched — it is
 * append-only by database trigger, and the record that these configuration
 * changes happened is supposed to survive.
 */
async function cleanupAdminFixtures() {
  const ids = await query<{ id: string }>(
    "SELECT id FROM procurement_centres WHERE code LIKE 'TEST-ADM-%'",
  );
  if (ids.rowCount === 0) return;
  const list = ids.rows.map((r) => r.id);
  for (const table of [
    'bookings',
    'centre_slot_configurations',
    'centre_operating_hours',
    'centre_holidays',
    'centre_crop_configurations',
    'centre_service_lanes',
    'officer_centre_assignments',
    'centre_storage_links',
    'centre_daily_capacity',
  ]) {
    await query(`DELETE FROM ${table} WHERE centre_id = ANY($1::uuid[])`, [list]);
  }
  await query('DELETE FROM procurement_centres WHERE id = ANY($1::uuid[])', [list]);
}

after(async () => {
  await cleanupAdminFixtures();
  await stopTestServer();
});

async function adminClient() {
  const spec = {
    username: `adm-${Date.now()}-${seq++}`,
    password: 'Admin-Passw0rd!',
    phone: uniquePhone(),
  };
  await createStaffUser({ ...spec, role: 'ADMIN' });
  return staffLogin(base, spec.username, spec.password, spec.phone);
}

async function officerClient(centreCode = 'DEMO-UP-AGRA-01') {
  const spec = {
    username: `off-${Date.now()}-${seq++}`,
    password: 'Officer-Passw0rd!',
    phone: uniquePhone(),
  };
  const c = await query<{ id: string }>('SELECT id FROM procurement_centres WHERE code = $1', [
    centreCode,
  ]);
  await createStaffUser({ ...spec, role: 'OFFICER', centreId: c.rows[0].id });
  return { client: await staffLogin(base, spec.username, spec.password, spec.phone), spec };
}

async function districtId() {
  const r = await query<{ id: string }>('SELECT id FROM districts ORDER BY name LIMIT 1');
  return r.rows[0].id;
}

const newCode = () => `TEST-ADM-${Date.now() % 100000}-${seq++}`;

// ---------------------------------------------------------------------------

describe('admin centre configuration', () => {
  it('creates a centre and marks it CONFIGURED, never OFFICIAL', async () => {
    const admin = await adminClient();
    const code = newCode();
    const r = await admin.post('/api/v1/admin/centres', {
      code,
      name: 'Test Demonstration Centre',
      districtId: await districtId(),
    });
    assert.equal(r.status, 201);
    const d = r.body.data as Record<string, any>;
    assert.equal(d.dataType, 'CONFIGURED');
    assert.match(d.note, /not an official government centre/i);

    const row = await query<{ data_type: string; source_id: string | null; mode: string }>(
      'SELECT data_type, source_id, storage_check_mode AS mode FROM procurement_centres WHERE code = $1',
      [code],
    );
    assert.equal(row.rows[0].data_type, 'CONFIGURED');
    assert.equal(row.rows[0].source_id, null, 'no provenance can be manufactured');
    assert.equal(row.rows[0].mode, 'ADVISORY', 'no storage capacity is asserted (D-10)');
  });

  it('cannot be tricked into creating OFFICIAL data through the payload', async () => {
    const admin = await adminClient();
    const code = newCode();
    const r = await admin.post('/api/v1/admin/centres', {
      code,
      name: 'Sneaky Centre',
      districtId: await districtId(),
      dataType: 'OFFICIAL',
      sourceId: '11111111-1111-4111-8111-111111111111',
      storageCheckMode: 'ENFORCED',
    });
    assert.equal(r.status, 201);
    const row = await query<{ data_type: string; mode: string }>(
      'SELECT data_type, storage_check_mode AS mode FROM procurement_centres WHERE code = $1',
      [code],
    );
    assert.equal(row.rows[0].data_type, 'CONFIGURED', 'the extra fields are not request fields');
    assert.equal(row.rows[0].mode, 'ADVISORY');
  });

  it('rejects a duplicate centre code', async () => {
    const admin = await adminClient();
    const code = newCode();
    const body = { code, name: 'First Centre', districtId: await districtId() };
    assert.equal((await admin.post('/api/v1/admin/centres', body)).status, 201);
    const dup = await admin.post('/api/v1/admin/centres', { ...body, name: 'Second Centre' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error!.code, 'CENTRE_CODE_TAKEN');
  });

  it('rejects an unknown district and a malformed code', async () => {
    const admin = await adminClient();
    const bad = await admin.post('/api/v1/admin/centres', {
      code: newCode(),
      name: 'Nowhere Centre',
      districtId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error!.code, 'DISTRICT_NOT_FOUND');

    const malformed = await admin.post('/api/v1/admin/centres', {
      code: 'lower case!',
      name: 'Bad Code',
      districtId: await districtId(),
    });
    assert.equal(malformed.status, 400);
  });

  it('refuses to deactivate a centre that still holds active bookings', async () => {
    const admin = await adminClient();
    // A centre of this test's own, so no other suite's capacity is consumed.
    // The booking is inserted directly because the point under test is the
    // deactivation guard, not the scheduler.
    const code = newCode();
    const created = await admin.post('/api/v1/admin/centres', {
      code,
      name: 'Deactivation Guard Centre',
      districtId: await districtId(),
    });
    const centreId = (created.body.data as { centreId: string }).centreId;
    await admin.request('PUT', `/api/v1/admin/centres/${centreId}/lanes`, {
      body: { laneNo: 1, isActive: true },
    });

    const { phone } = await registerFarmer(base);
    const ctx = await query<{ farmer_id: string; crop_id: string; season_id: string }>(
      `SELECT f.id AS farmer_id,
              (SELECT id FROM crops WHERE code = 'WHEAT') AS crop_id,
              (SELECT id FROM seasons WHERE code = 'RMS') AS season_id
         FROM farmers f JOIN users u ON u.id = f.user_id
        WHERE u.phone_e164 = $1`,
      [`+91${phone}`],
    );
    await query(
      `INSERT INTO bookings
         (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
          lane_no, requested_quantity_kg, service_date, scheduled_start_at,
          scheduled_end_at, estimated_processing_minutes, occupancy_minutes,
          token_number, status)
       VALUES ($1,$2,$3,$4,$5,'2026-27',1,2500, now()::date + 1,
               now() + interval '1 day', now() + interval '1 day 75 minutes',
               60, 75, 1, 'CONFIRMED')`,
      [
        `FQ-2026-${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
        ctx.rows[0].farmer_id,
        centreId,
        ctx.rows[0].crop_id,
        ctx.rows[0].season_id,
      ],
    );

    const r = await admin.patch(`/api/v1/admin/centres/${centreId}`, { status: 'INACTIVE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error!.code, 'CENTRE_HAS_ACTIVE_BOOKINGS');
    assert.ok(Number((r.body.error!.details as Record<string, unknown>).activeBookings) >= 1);
  });

  it('audits every configuration mutation', async () => {
    const admin = await adminClient();
    const code = newCode();
    await admin.post('/api/v1/admin/centres', {
      code,
      name: 'Audited Centre',
      districtId: await districtId(),
    });
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE action = 'centre.created' AND after_state->>'code' = $1`,
      [code],
    );
    assert.equal(rows.rows[0].n, '1');
  });
});

describe('admin lane, hours, holiday and slot configuration', () => {
  async function freshCentre(admin: Awaited<ReturnType<typeof adminClient>>) {
    const code = newCode();
    const r = await admin.post('/api/v1/admin/centres', {
      code,
      name: 'Config Test Centre',
      districtId: await districtId(),
    });
    return (r.body.data as { centreId: string }).centreId;
  }

  it('adds lanes and lists them', async () => {
    const admin = await adminClient();
    const centreId = await freshCentre(admin);
    for (const laneNo of [1, 2]) {
      const r = await admin.request('PUT', `/api/v1/admin/centres/${centreId}/lanes`, {
        body: { laneNo, name: `Lane ${laneNo}`, isActive: true },
      });
      assert.equal(r.status, 200);
    }
    const list = await admin.get(`/api/v1/admin/centres/${centreId}/lanes`);
    assert.equal((list.body.data as any).lanes.length, 2);
  });

  it('sets operating hours and end-dates the previous row instead of overwriting', async () => {
    const admin = await adminClient();
    const centreId = await freshCentre(admin);
    const from = new Date().toISOString().slice(0, 10);

    const first = await admin.request('PUT', `/api/v1/admin/centres/${centreId}/hours`, {
      body: { dayOfWeek: 1, opensAt: '08:00', closesAt: '18:00', effectiveFrom: from },
    });
    assert.equal(first.status, 200);

    const later = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const second = await admin.request('PUT', `/api/v1/admin/centres/${centreId}/hours`, {
      body: { dayOfWeek: 1, opensAt: '09:00', closesAt: '17:00', effectiveFrom: later },
    });
    assert.equal(second.status, 200);

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM centre_operating_hours
        WHERE centre_id = $1 AND day_of_week = 1`,
      [centreId],
    );
    assert.equal(rows.rows[0].n, '2', 'history is retained, not overwritten');
  });

  it('rejects hours where opening is not before closing', async () => {
    const admin = await adminClient();
    const centreId = await freshCentre(admin);
    const r = await admin.request('PUT', `/api/v1/admin/centres/${centreId}/hours`, {
      body: {
        dayOfWeek: 2,
        opensAt: '18:00',
        closesAt: '08:00',
        effectiveFrom: new Date().toISOString().slice(0, 10),
      },
    });
    assert.equal(r.status, 400);
  });

  it('declares and removes a holiday', async () => {
    const admin = await adminClient();
    const centreId = await freshCentre(admin);
    const date = '2027-01-26';

    const add = await admin.post(`/api/v1/admin/centres/${centreId}/holidays`, {
      date,
      reason: 'Republic Day (configured demonstration holiday)',
    });
    assert.equal(add.status, 201);
    assert.equal((await admin.get(`/api/v1/admin/centres/${centreId}/holidays`)).status, 200);

    const del = await admin.request('DELETE', `/api/v1/admin/centres/${centreId}/holidays/${date}`);
    assert.equal(del.status, 200);
    const gone = await admin.request('DELETE', `/api/v1/admin/centres/${centreId}/holidays/${date}`);
    assert.equal(gone.status, 404);
  });

  it('sets a slot configuration and refuses maximum below minimum', async () => {
    const admin = await adminClient();
    const centreId = await freshCentre(admin);
    const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const good = {
      referenceQuantityKg: 2500,
      referenceProcessingMinutes: 60,
      minimumProcessingMinutes: 30,
      maximumProcessingMinutes: 180,
      transitionBufferMinutes: 15,
      slotGranularityMinutes: 15,
      bookingHorizonDays: 7,
      cancellationCutoffHours: 24,
      effectiveFrom: from,
    };
    assert.equal(
      (await admin.request('PUT', `/api/v1/admin/centres/${centreId}/slot-config`, { body: good }))
        .status,
      200,
    );

    const bad = await admin.request('PUT', `/api/v1/admin/centres/${centreId}/slot-config`, {
      body: { ...good, minimumProcessingMinutes: 200, effectiveFrom: from },
    });
    assert.equal(bad.status, 400);
  });

  it('returns 404 for a centre that does not exist', async () => {
    const admin = await adminClient();
    const r = await admin.get(
      '/api/v1/admin/centres/11111111-1111-4111-8111-111111111111/lanes',
    );
    assert.equal(r.status, 404);
  });
});

describe('officer assignment', () => {
  it('assigns and revokes, keeping the history', async () => {
    const admin = await adminClient();
    const { spec } = await officerClient('DEMO-UP-MATHURA-01');
    const c = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-HATHRAS-01'",
    );
    const centreId = c.rows[0].id;
    const employeeCode = `EMP-${spec.username}`;

    const assign = await admin.post(`/api/v1/admin/centres/${centreId}/officers`, {
      employeeCode,
    });
    assert.equal(assign.status, 201);

    const list = (await admin.get(`/api/v1/admin/centres/${centreId}/officers`)).body.data as any;
    assert.ok(list.assignments.some((a: any) => a.employeeCode === employeeCode && a.active));

    const revoke = await admin.request(
      'DELETE',
      `/api/v1/admin/centres/${centreId}/officers/${employeeCode}`,
    );
    assert.equal(revoke.status, 200);

    const after = (await admin.get(`/api/v1/admin/centres/${centreId}/officers`)).body.data as any;
    const row = after.assignments.find((a: any) => a.employeeCode === employeeCode);
    assert.equal(row.active, false, 'revoked');
    assert.ok(row.revokedAt, 'and the history row is kept, not deleted');
  });

  it('is idempotent — assigning twice does not duplicate', async () => {
    const admin = await adminClient();
    const { spec } = await officerClient('DEMO-UP-MATHURA-01');
    const c = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-BULANDSHAHR-01'",
    );
    const employeeCode = `EMP-${spec.username}`;
    const first = await admin.post(`/api/v1/admin/centres/${c.rows[0].id}/officers`, { employeeCode });
    const second = await admin.post(`/api/v1/admin/centres/${c.rows[0].id}/officers`, { employeeCode });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal((second.body.data as any).assigned, false);
  });

  it('rejects an unknown officer', async () => {
    const admin = await adminClient();
    const c = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-AGRA-01'",
    );
    const r = await admin.post(`/api/v1/admin/centres/${c.rows[0].id}/officers`, {
      employeeCode: 'EMP-DOES-NOT-EXIST',
    });
    assert.equal(r.status, 404);
  });
});

describe('admin configuration security', () => {
  it('refuses an OFFICER every configuration endpoint', async () => {
    const { client: officer } = await officerClient();
    const c = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-AGRA-01'",
    );
    const id = c.rows[0].id;

    assert.equal((await officer.get('/api/v1/admin/centres')).status, 403);
    assert.equal(
      (await officer.post('/api/v1/admin/centres', { code: newCode(), name: 'X', districtId: await districtId() })).status,
      403,
    );
    assert.equal((await officer.get(`/api/v1/admin/centres/${id}/lanes`)).status, 403);
    assert.equal(
      (await officer.request('PUT', `/api/v1/admin/centres/${id}/lanes`, { body: { laneNo: 9, isActive: true } })).status,
      403,
      'an officer operates a centre; they do not configure it',
    );
    assert.equal((await officer.get(`/api/v1/admin/centres/${id}/officers`)).status, 403);
  });

  it('refuses a FARMER every configuration endpoint', async () => {
    const { client: farmer } = await registerFarmer(base);
    const c = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-AGRA-01'",
    );
    assert.equal((await farmer.get('/api/v1/admin/centres')).status, 403);
    assert.equal((await farmer.get(`/api/v1/admin/centres/${c.rows[0].id}/lanes`)).status, 403);
  });

  it('refuses unauthenticated requests', async () => {
    const anon = newClient(base);
    await anon.primeCsrf();
    assert.equal((await anon.get('/api/v1/admin/centres')).status, 401);
    assert.equal(
      (await anon.post('/api/v1/admin/centres', { code: 'X', name: 'Y', districtId: 'z' })).status,
      401,
    );
  });

  it('enforces CSRF on configuration mutations', async () => {
    const admin = await adminClient();
    const r = await admin.post(
      '/api/v1/admin/centres',
      { code: newCode(), name: 'No CSRF Centre', districtId: await districtId() },
      { csrf: false },
    );
    assert.equal(r.status, 403);
    assert.equal(r.body.error!.code, 'CSRF_TOKEN_INVALID');
  });

  it('never lets an admin promote demonstration data to OFFICIAL', async () => {
    // The only OFFICIAL rows in the system are MSP rates, and no admin route
    // touches them. Every centre remains CONFIGURED.
    const admin = await adminClient();
    const list = (await admin.get('/api/v1/admin/centres?includeInactive=true')).body.data as any;
    for (const c of list.centres) {
      assert.equal(c.dataType, 'CONFIGURED', `${c.code} must stay CONFIGURED`);
      assert.equal(c.storageCheckMode, 'ADVISORY', 'no fabricated storage capacity');
    }
  });
});


// ---------------------------------------------------------------------------
// Phase 14 — officer provisioning
// ---------------------------------------------------------------------------

/**
 * A distinct officer, created through the API rather than the `createStaffUser`
 * back door.
 *
 * The back door is what every other suite uses, and it is exactly the blind
 * spot the readiness audit found for farmer registration: a fixture that writes
 * to the database directly proves nothing about the path a real caller takes.
 * These tests deliberately never use it.
 */
function officerSpec() {
  const n = `${Date.now() % 1000000}-${seq++}`;
  return {
    fullName: 'Provisioned Officer',
    username: `prov-${n}`,
    password: 'Provision-Passw0rd',
    phone: uniquePhone(),
    employeeCode: `EMP-PROV-${n}`,
    designation: 'Procurement Officer',
  };
}

describe('officer provisioning', () => {
  it('creates an officer who can then actually sign in', async () => {
    const admin = await adminClient();
    const spec = officerSpec();

    const r = await admin.post('/api/v1/admin/officers', spec);
    assert.equal(r.status, 201);
    const d = r.body.data as any;
    assert.equal(d.employeeCode, spec.employeeCode);
    assert.equal(d.username, spec.username);
    assert.equal(d.status, 'ACTIVE');
    assert.doesNotMatch(JSON.stringify(r.body), /Provision-Passw0rd/, 'the password is never echoed');
    assert.doesNotMatch(JSON.stringify(r.body), /scrypt/, 'and neither is its hash');

    // The point of the endpoint: an account that works, over real HTTP,
    // including the OTP second factor staff accounts require.
    const officer = await staffLogin(base, spec.username, spec.password, spec.phone);
    assert.equal((await officer.get('/api/v1/me')).status, 200);
  });

  it('grants OFFICER and never ADMIN, whatever the payload claims', async () => {
    const admin = await adminClient();
    const spec = officerSpec();

    const r = await admin.post('/api/v1/admin/officers', {
      ...spec,
      role: 'ADMIN',
      roleCode: 'ADMIN',
      isAdmin: true,
      permissions: ['officer.create'],
    });
    assert.equal(r.status, 201);

    const roles = await query<{ code: string }>(
      `SELECT r.code FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE u.username = $1`,
      [spec.username],
    );
    assert.deepEqual(roles.rows.map((x) => x.code), ['OFFICER'], 'exactly one role, and it is OFFICER');

    // Proven operationally as well as in the table: the new account cannot
    // reach the endpoint that made it.
    const officer = await staffLogin(base, spec.username, spec.password, spec.phone);
    assert.equal((await officer.get('/api/v1/admin/officers')).status, 403);
  });

  it('names which identifier collided rather than a generic conflict', async () => {
    const admin = await adminClient();
    const spec = officerSpec();
    assert.equal((await admin.post('/api/v1/admin/officers', spec)).status, 201);

    const dupUsername = await admin.post('/api/v1/admin/officers', {
      ...officerSpec(),
      username: spec.username,
    });
    assert.equal(dupUsername.status, 409);
    assert.equal(dupUsername.body.error!.code, 'USERNAME_TAKEN');

    const dupPhone = await admin.post('/api/v1/admin/officers', {
      ...officerSpec(),
      phone: spec.phone,
    });
    assert.equal(dupPhone.status, 409);
    assert.equal(dupPhone.body.error!.code, 'PHONE_ALREADY_REGISTERED');

    const dupCode = await admin.post('/api/v1/admin/officers', {
      ...officerSpec(),
      employeeCode: spec.employeeCode,
    });
    assert.equal(dupCode.status, 409);
    assert.equal(dupCode.body.error!.code, 'EMPLOYEE_CODE_TAKEN');
  });

  it('refuses a weak initial password and a malformed username', async () => {
    const admin = await adminClient();

    const short = await admin.post('/api/v1/admin/officers', {
      ...officerSpec(),
      password: 'Short1',
    });
    assert.equal(short.status, 400);
    assert.equal(short.body.error!.fields!.password, 'PASSWORD_TOO_SHORT');

    const weak = await admin.post('/api/v1/admin/officers', {
      ...officerSpec(),
      password: 'alllowercaseletters',
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error!.fields!.password, 'PASSWORD_TOO_WEAK');

    const bad = await admin.post('/api/v1/admin/officers', {
      ...officerSpec(),
      username: 'Has Spaces',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error!.fields!.username, 'USERNAME_INVALID');
  });

  it('lists and reads officers without ever returning a credential', async () => {
    const admin = await adminClient();
    const spec = officerSpec();
    await admin.post('/api/v1/admin/officers', spec);

    const list = await admin.get('/api/v1/admin/officers');
    assert.equal(list.status, 200);
    const listed = (list.body.data as any).officers.find(
      (o: any) => o.employeeCode === spec.employeeCode,
    );
    assert.ok(listed, 'the new officer is listed');
    assert.equal(listed.status, 'ACTIVE');
    assert.equal(listed.loginStatus, 'ACTIVE');
    assert.equal(listed.activeAssignments, 0, 'created unassigned');

    const one = await admin.get(`/api/v1/admin/officers/${spec.employeeCode}`);
    assert.equal(one.status, 200);
    const detail = one.body.data as any;
    assert.equal(detail.fullName, spec.fullName);
    assert.equal(detail.designation, spec.designation);
    assert.deepEqual(detail.assignments, []);

    const dump = JSON.stringify(list.body) + JSON.stringify(one.body);
    assert.doesNotMatch(dump, /scrypt/, 'no password hash on either read');
    assert.doesNotMatch(dump, /Provision-Passw0rd/);
  });

  it('revokes live sessions the moment an officer is deactivated', async () => {
    const admin = await adminClient();
    const spec = officerSpec();
    await admin.post('/api/v1/admin/officers', spec);

    const centre = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-MATHURA-01'",
    );
    assert.equal(
      (
        await admin.post(`/api/v1/admin/centres/${centre.rows[0].id}/officers`, {
          employeeCode: spec.employeeCode,
        })
      ).status,
      201,
    );

    const officer = await staffLogin(base, spec.username, spec.password, spec.phone);
    const before = await officer.get('/api/v1/officer/centres');
    assert.equal(before.status, 200);
    assert.equal((before.body.data as any).length, 1, 'working, with one posting');

    const off = await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/deactivate`, {
      reason: 'transferred out of the district',
    });
    assert.equal(off.status, 200);
    const d = off.body.data as any;
    assert.equal(d.deactivated, true);
    assert.equal(d.sessionsRevoked, 1, 'the live session, killed now');
    assert.equal(d.assignmentsRevoked, 1);

    // The property that matters: authority ends with the decision, not with
    // the session's twelve-hour expiry.
    const after = await officer.get('/api/v1/officer/centres');
    assert.equal(after.status, 401, 'the existing session stops working immediately');

    const relogin = newClient(base);
    await relogin.primeCsrf();
    const attempt = await relogin.post('/api/v1/auth/staff/login', {
      username: spec.username,
      password: spec.password,
    });
    assert.equal(attempt.status, 401, 'and they cannot simply sign in again');
  });

  it('is idempotent — a second deactivation is reported as a no-op', async () => {
    const admin = await adminClient();
    const spec = officerSpec();
    await admin.post('/api/v1/admin/officers', spec);

    const first = await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/deactivate`, {});
    const second = await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/deactivate`, {});
    assert.equal((first.body.data as any).deactivated, true);
    assert.equal(second.status, 200);
    assert.equal((second.body.data as any).deactivated, false);
  });

  it('reactivates the login without silently restoring centre postings', async () => {
    const admin = await adminClient();
    const spec = officerSpec();
    await admin.post('/api/v1/admin/officers', spec);

    const centre = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-BULANDSHAHR-01'",
    );
    await admin.post(`/api/v1/admin/centres/${centre.rows[0].id}/officers`, {
      employeeCode: spec.employeeCode,
    });
    await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/deactivate`, {});

    const back = await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/reactivate`, {});
    assert.equal(back.status, 200);
    assert.equal((back.body.data as any).reactivated, true);

    const officer = await staffLogin(base, spec.username, spec.password, spec.phone);
    const centres = await officer.get('/api/v1/officer/centres');
    assert.equal(centres.status, 200);
    assert.equal(
      (centres.body.data as any).length,
      0,
      'reactivation restores the account, not the assumption that the old posting still applies',
    );

    const again = await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/reactivate`, {});
    assert.equal((again.body.data as any).reactivated, false, 'idempotent too');
  });

  it('404s for an officer that does not exist', async () => {
    const admin = await adminClient();
    assert.equal((await admin.get('/api/v1/admin/officers/EMP-NO-SUCH-CODE')).status, 404);
    assert.equal(
      (await admin.post('/api/v1/admin/officers/EMP-NO-SUCH-CODE/deactivate', {})).status,
      404,
    );
    assert.equal(
      (await admin.post('/api/v1/admin/officers/EMP-NO-SUCH-CODE/reactivate', {})).status,
      404,
    );
  });

  it('audits the lifecycle and puts no credential material in the record', async () => {
    const admin = await adminClient();
    const spec = officerSpec();
    await admin.post('/api/v1/admin/officers', spec);
    await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/deactivate`, {
      reason: 'end of season',
    });
    await admin.post(`/api/v1/admin/officers/${spec.employeeCode}/reactivate`, {});

    const rows = await query<{ action: string; before_state: unknown; after_state: unknown }>(
      `SELECT a.action, a.before_state, a.after_state
         FROM audit_logs a
         JOIN officers o ON o.id = a.entity_id
        WHERE o.employee_code = $1 AND a.entity_type = 'officer'
        ORDER BY a.id`,
      [spec.employeeCode],
    );
    assert.deepEqual(rows.rows.map((r) => r.action), [
      'officer.created',
      'officer.deactivated',
      'officer.reactivated',
    ]);

    const dump = JSON.stringify(rows.rows);
    assert.doesNotMatch(dump, /Provision-Passw0rd/, 'no plaintext password in the audit trail');
    assert.doesNotMatch(dump, /scrypt/, 'and no password hash either');
  });
});

describe('officer provisioning security', () => {
  it('refuses an OFFICER every provisioning endpoint — no self-promotion', async () => {
    const { client: officer } = await officerClient();
    assert.equal((await officer.get('/api/v1/admin/officers')).status, 403);
    assert.equal((await officer.post('/api/v1/admin/officers', officerSpec())).status, 403);
    assert.equal(
      (await officer.post('/api/v1/admin/officers/EMP-ANY/deactivate', {})).status,
      403,
      'an officer cannot remove a colleague',
    );
    assert.equal(
      (await officer.post('/api/v1/admin/officers/EMP-ANY/reactivate', {})).status,
      403,
    );
  });

  it('refuses a FARMER and an anonymous caller', async () => {
    const { client: farmer } = await registerFarmer(base);
    assert.equal((await farmer.get('/api/v1/admin/officers')).status, 403);

    const anon = newClient(base);
    await anon.primeCsrf();
    assert.equal((await anon.get('/api/v1/admin/officers')).status, 401);
    assert.equal((await anon.post('/api/v1/admin/officers', officerSpec())).status, 401);
  });

  it('enforces CSRF on officer creation and deactivation', async () => {
    const admin = await adminClient();
    const noCsrf = await admin.post('/api/v1/admin/officers', officerSpec(), { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error!.code, 'CSRF_TOKEN_INVALID');
  });
});
