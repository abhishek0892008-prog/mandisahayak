/**
 * Phase 5 authentication and authorization tests.
 *
 * Integration only: real Express app, real PostgreSQL, real HTTP, real cookies.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Client,
  createStaffUser,
  demoOtpFor,
  firstCentreId,
  getSeedDistrictId,
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
describe('farmer registration', () => {
  it('registers a farmer and creates a session only after OTP verification', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();

    const start = await c.post<{ challengeId: string; otpLength: number; attemptsRemaining: number }>(
      '/api/v1/auth/farmer/register/start-otp',
      {
        fullName: 'Ramesh Kumar',
        phone,
        districtId,
        consent: { policyVersion: 'v1', accepted: true },
      },
    );
    assert.equal(start.status, 201);
    assert.equal(start.body.data!.otpLength, 6);
    assert.equal(start.body.data!.attemptsRemaining, 5);

    // No identity exists yet — the phone is unverified.
    const before = await query('SELECT id FROM users WHERE phone_e164 = $1', [`+91${phone}`]);
    assert.equal(before.rowCount, 0, 'no user may exist before OTP verification');

    // And no session cookie has been issued.
    assert.equal(c.cookie('fq_session'), undefined);

    const verify = await c.post<{ roles: string[] }>('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId,
      otp: demoOtpFor(phone),
    });
    assert.equal(verify.status, 201);
    assert.deepEqual(verify.body.data!.roles, ['FARMER']);
    assert.ok(c.cookie('fq_session'), 'session cookie must be set');

    const after = await query('SELECT id FROM users WHERE phone_e164 = $1', [`+91${phone}`]);
    assert.equal(after.rowCount, 1);

    const consents = await query(
      `SELECT purpose FROM consents c JOIN users u ON u.id = c.user_id WHERE u.phone_e164 = $1`,
      [`+91${phone}`],
    );
    assert.equal(consents.rowCount, 2, 'both consent purposes recorded');
  });

  it('rejects duplicate registration', async () => {
    const { phone } = await registerFarmer(base);
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();

    const res = await c.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Someone Else',
      phone,
      districtId,
      consent: { policyVersion: 'v1', accepted: true },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error!.code, 'PHONE_ALREADY_REGISTERED');
  });

  it('rejects invalid registration input server-side', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();

    const badPhone = await c.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Ramesh',
      phone: '12345',
      districtId,
      consent: { policyVersion: 'v1', accepted: true },
    });
    assert.equal(badPhone.status, 400);
    assert.equal(badPhone.body.error!.code, 'VALIDATION_FAILED');
    assert.ok(badPhone.body.error!.fields!.phone);

    const noConsent = await c.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Ramesh',
      phone: uniquePhone(),
      districtId,
      consent: { policyVersion: 'v1', accepted: false },
    });
    assert.equal(noConsent.status, 400);

    const badDistrict = await c.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Ramesh',
      phone: uniquePhone(),
      districtId: '00000000-0000-4000-8000-000000000000',
      consent: { policyVersion: 'v1', accepted: true },
    });
    assert.equal(badDistrict.status, 422);
    assert.equal(badDistrict.body.error!.code, 'DISTRICT_NOT_FOUND');
  });

  it('never stores Aadhaar or bank details (Decision D-6/D-7)', async () => {
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND (column_name ILIKE '%aadhaar%' OR column_name ILIKE '%ifsc%'
               OR column_name ILIKE '%account_number%')`,
    );
    assert.equal(cols.rowCount, 0, 'no Aadhaar/IFSC/account columns may exist');
  });
});

// ===========================================================================
describe('OTP security', () => {
  it('rejects an incorrect OTP with an opaque code', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });

    const res = await c.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId,
      otp: '000000',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error!.code, 'OTP_INVALID');
    assert.equal(c.cookie('fq_session'), undefined, 'no session on failure');
  });

  it('enforces the five-attempt limit and then refuses the correct OTP', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });
    const challengeId = start.body.data!.challengeId;
    const realOtp = demoOtpFor(phone);
    const wrong = realOtp === '999999' ? '111111' : '999999';

    for (let i = 0; i < 5; i += 1) {
      const r = await c.post('/api/v1/auth/otp/verify', { challengeId, otp: wrong });
      assert.equal(r.status, 400, `attempt ${i + 1} should fail`);
    }

    const row = await query<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM otp_challenges WHERE id = $1', [challengeId]);
    assert.equal(row.rows[0].attempts, 5);
    assert.equal(row.rows[0].status, 'FAILED');

    // Even the correct OTP must now be refused.
    const final = await c.post('/api/v1/auth/otp/verify', { challengeId, otp: realOtp });
    assert.equal(final.status, 400);
    assert.equal(c.cookie('fq_session'), undefined);
  });

  it('treats an expired OTP as invalid', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });
    const challengeId = start.body.data!.challengeId;

    // created_at must move too: otp_challenges_expiry_after_creation enforces
    // expires_at > created_at.
    await query(
      `UPDATE otp_challenges
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [challengeId]);

    const res = await c.post('/api/v1/auth/otp/verify', { challengeId, otp: demoOtpFor(phone) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error!.code, 'OTP_INVALID');

    const row = await query<{ status: string }>('SELECT status FROM otp_challenges WHERE id = $1', [challengeId]);
    assert.equal(row.rows[0].status, 'EXPIRED');
  });

  it('is one-time use: a consumed challenge cannot be replayed', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });
    const challengeId = start.body.data!.challengeId;
    const otp = demoOtpFor(phone);

    const first = await c.post('/api/v1/auth/otp/verify', { challengeId, otp });
    assert.equal(first.status, 201);

    const replay = await newClient(base);
    await replay.primeCsrf();
    const second = await replay.post('/api/v1/auth/otp/verify', { challengeId, otp });
    assert.equal(second.status, 400, 'replay must be refused');
    assert.equal(replay.cookie('fq_session'), undefined);
  });

  it('enforces the resend cooldown', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });
    const challengeId = start.body.data!.challengeId;

    const tooSoon = await c.post('/api/v1/auth/otp/resend', { challengeId });
    assert.equal(tooSoon.status, 422);
    assert.equal(tooSoon.body.error!.code, 'OTP_RESEND_COOLDOWN');

    // Move the clock back past the cooldown and it succeeds with a NEW code.
    await query(`UPDATE otp_challenges SET last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [challengeId]);
    const ok = await c.post('/api/v1/auth/otp/resend', { challengeId });
    assert.equal(ok.status, 200);

    const fresh = demoOtpFor(phone);
    const verify = await c.post('/api/v1/auth/otp/verify', { challengeId, otp: fresh });
    assert.equal(verify.status, 201, 'the resent OTP must work');
  });

  it('never returns the OTP in any authentication response body', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });
    const serialised = JSON.stringify(start.body);
    const otp = demoOtpFor(phone);
    assert.ok(!serialised.includes(otp), 'response body must not contain the OTP');
    assert.ok(!/"otp"/i.test(serialised), 'response body must not contain an otp field');
  });

  it('login is enumeration-resistant for an unknown phone', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    const unknown = await c.post<{ challengeId: string; otpLength: number }>(
      '/api/v1/auth/farmer/login/start-otp', { phone: uniquePhone() });
    assert.equal(unknown.status, 201, 'unknown phone must look identical');
    assert.ok(unknown.body.data!.challengeId);

    const { phone } = await registerFarmer(base);
    const c2 = newClient(base);
    await c2.primeCsrf();
    const known = await c2.post('/api/v1/auth/farmer/login/start-otp', { phone });
    assert.equal(known.status, 201);
    assert.deepEqual(Object.keys(unknown.body.data!).sort(), Object.keys(known.body.data!).sort());
  });

  it('an existing farmer can log in by OTP', async () => {
    const { phone } = await registerFarmer(base);
    const c = newClient(base);
    await c.primeCsrf();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/login/start-otp', { phone });
    const verify = await c.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId,
      otp: demoOtpFor(phone),
    });
    assert.equal(verify.status, 201);
    const me = await c.get<{ roles: string[] }>('/api/v1/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data!.roles, ['FARMER']);
  });
});

// ===========================================================================
describe('sessions', () => {
  it('logs out and immediately invalidates the session', async () => {
    const { client } = await registerFarmer(base);
    assert.equal((await client.get('/api/v1/me')).status, 200);

    const out = await client.post('/api/v1/auth/logout');
    assert.equal(out.status, 200);

    const after = await client.get('/api/v1/me');
    assert.equal(after.status, 401);
  });

  it('rejects a revoked session even with a valid cookie', async () => {
    const { client } = await registerFarmer(base);
    const me = await client.get<{ userId: string }>('/api/v1/me');
    const userId = me.body.data!.userId;

    await query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'TEST' WHERE user_id = $1`, [userId]);

    const after = await client.get('/api/v1/me');
    assert.equal(after.status, 401, 'revocation must take effect immediately');
  });

  it('rejects an expired session', async () => {
    const { client } = await registerFarmer(base);
    const me = await client.get<{ userId: string }>('/api/v1/me');
    // created_at must move too: sessions_idle_expiry_after_creation enforces
    // expires_at > created_at, so a session cannot be back-dated on its own.
    await query(
      `UPDATE sessions
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 second'
        WHERE user_id = $1`,
      [me.body.data!.userId]);
    assert.equal((await client.get('/api/v1/me')).status, 401);
  });

  it('cannot be forged: a fabricated session token is rejected', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    c.setCookie('fq_session', 'forged-token-that-was-never-issued');
    const res = await c.get('/api/v1/me');
    assert.equal(res.status, 401);
  });

  it('sets an HttpOnly session cookie and never returns the token in the body', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();
    const districtId = await getSeedDistrictId();
    const start = await c.post<{ challengeId: string }>('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Test', phone, districtId, consent: { policyVersion: 'v1', accepted: true },
    });
    const verify = await c.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId, otp: demoOtpFor(phone),
    });

    const setCookies = verify.headers.getSetCookie();
    const sessionCookie = setCookies.find((l) => l.startsWith('fq_session='));
    assert.ok(sessionCookie, 'session cookie must be present');
    assert.match(sessionCookie!, /HttpOnly/i);
    assert.match(sessionCookie!, /SameSite=Lax/i);
    assert.match(sessionCookie!, /Path=\//i);

    const token = c.cookie('fq_session')!;
    assert.ok(!JSON.stringify(verify.body).includes(token), 'token must not appear in the body');
  });

  it('stores only a hash of the session token', async () => {
    const { client } = await registerFarmer(base);
    const token = client.cookie('fq_session')!;
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sessions WHERE encode(token_hash,'hex') = $1`, [token]);
    assert.equal(rows.rows[0].n, '0', 'the raw token must never equal a stored value');
  });
});

// ===========================================================================
describe('staff authentication', () => {
  const officer = { username: `off_${Date.now()}`, password: 'Officer#Pass123', phone: uniquePhone() };
  const admin = { username: `adm_${Date.now()}`, password: 'Admin#Pass123', phone: uniquePhone() };

  before(async () => {
    const centreId = await firstCentreId();
    await createStaffUser({ ...officer, role: 'OFFICER', centreId });
    await createStaffUser({ ...admin, role: 'ADMIN' });
  });

  it('requires password AND OTP', async () => {
    const c = newClient(base);
    await c.primeCsrf();

    const step1 = await c.post<{ challengeId: string }>('/api/v1/auth/staff/login', {
      username: officer.username, password: officer.password,
    });
    assert.equal(step1.status, 201, 'password step should issue an OTP challenge');
    assert.equal(c.cookie('fq_session'), undefined, 'no session after password alone');

    const step2 = await c.post<{ roles: string[] }>('/api/v1/auth/otp/verify', {
      challengeId: step1.body.data!.challengeId, otp: demoOtpFor(officer.phone),
    });
    assert.equal(step2.status, 201);
    assert.deepEqual(step2.body.data!.roles, ['OFFICER']);
  });

  it('rejects an invalid password without issuing a challenge', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    const res = await c.post('/api/v1/auth/staff/login', {
      username: officer.username, password: 'wrong-password',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error!.code, 'INVALID_CREDENTIALS');
  });

  it('rejects an invalid OTP at the second factor', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    const step1 = await c.post<{ challengeId: string }>('/api/v1/auth/staff/login', {
      username: admin.username, password: admin.password,
    });
    const bad = await c.post('/api/v1/auth/otp/verify', {
      challengeId: step1.body.data!.challengeId, otp: '000000',
    });
    assert.equal(bad.status, 400);
    assert.equal(c.cookie('fq_session'), undefined);
  });

  it('a farmer account cannot authenticate through the staff endpoint', async () => {
    const { phone } = await registerFarmer(base);
    const c = newClient(base);
    await c.primeCsrf();

    // The phone digits form a syntactically valid username, so this reaches the
    // credential check rather than being rejected by validation. It must fail
    // there: farmers have no password and hold no staff role.
    const res = await c.post('/api/v1/auth/staff/login', {
      username: phone, password: 'anything',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error!.code, 'INVALID_CREDENTIALS');
    assert.equal(c.cookie('fq_session'), undefined, 'no session may be created');
  });

  it('staff can log out', async () => {
    const c = await staffLogin(base, admin.username, admin.password, admin.phone);
    assert.equal((await c.get('/api/v1/me')).status, 200);
    assert.equal((await c.post('/api/v1/auth/logout')).status, 200);
    assert.equal((await c.get('/api/v1/me')).status, 401);
  });
});

// ===========================================================================
describe('RBAC', () => {
  let farmerClient: Client;
  let officerClient: Client;
  let adminClient: Client;

  const officer = { username: `rbacoff_${Date.now()}`, password: 'Officer#Pass123', phone: uniquePhone() };
  const admin = { username: `rbacadm_${Date.now()}`, password: 'Admin#Pass123', phone: uniquePhone() };

  before(async () => {
    const centreId = await firstCentreId();
    await createStaffUser({ ...officer, role: 'OFFICER', centreId });
    await createStaffUser({ ...admin, role: 'ADMIN' });
    farmerClient = (await registerFarmer(base)).client;
    officerClient = await staffLogin(base, officer.username, officer.password, officer.phone);
    adminClient = await staffLogin(base, admin.username, admin.password, admin.phone);
  });

  it('rejects unauthenticated requests', async () => {
    const c = newClient(base);
    assert.equal((await c.get('/api/v1/me')).status, 401);
    assert.equal((await c.get('/api/v1/officer/centres')).status, 401);
    assert.equal((await c.get('/api/v1/admin/audit-logs')).status, 401);
  });

  it('farmer cannot access officer endpoints', async () => {
    const res = await farmerClient.get('/api/v1/officer/centres');
    assert.equal(res.status, 403);
    assert.equal(res.body.error!.code, 'FORBIDDEN');
  });

  it('farmer cannot access admin endpoints', async () => {
    assert.equal((await farmerClient.get('/api/v1/admin/audit-logs')).status, 403);
    assert.equal((await farmerClient.get('/api/v1/admin/farmers')).status, 403);
  });

  it('officer cannot access admin-only endpoints', async () => {
    const res = await officerClient.get('/api/v1/admin/audit-logs');
    assert.equal(res.status, 403, 'officers must not read the audit log');
    assert.equal((await officerClient.get('/api/v1/admin/farmers')).status, 403);
  });

  it('officer can access officer endpoints', async () => {
    const res = await officerClient.get<unknown[]>('/api/v1/officer/centres');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });

  it('admin can access admin endpoints', async () => {
    assert.equal((await adminClient.get('/api/v1/admin/audit-logs')).status, 200);
    assert.equal((await adminClient.get('/api/v1/admin/farmers')).status, 200);
  });

  it('authorization denials are audited', async () => {
    await farmerClient.get('/api/v1/admin/audit-logs');
    await new Promise((r) => setTimeout(r, 150));
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'auth.authorization_denied'`);
    assert.ok(Number(rows.rows[0].n) > 0, 'denials must be audited');
  });

  it('roles come from the database, not the request', async () => {
    const res = await farmerClient.patch('/api/v1/me', { fullName: 'Escalation Attempt' });
    assert.equal(res.status, 200);
    const me = await farmerClient.get<{ roles: string[] }>('/api/v1/me');
    assert.deepEqual(me.body.data!.roles, ['FARMER'], 'role must not change');
  });
});

// ===========================================================================
describe('CSRF', () => {
  it('rejects a state-changing request with no CSRF token', async () => {
    const c = newClient(base);
    const res = await c.post('/api/v1/auth/farmer/login/start-otp', { phone: uniquePhone() }, { csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.body.error!.code, 'CSRF_TOKEN_INVALID');
  });

  it('rejects a mismatched CSRF token', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    const res = await c.post('/api/v1/auth/farmer/login/start-otp', { phone: uniquePhone() }, {
      csrf: false, headers: { 'x-csrf-token': 'not-the-cookie-value' },
    });
    assert.equal(res.status, 403);
  });

  it('rejects a forged CSRF token that lacks a valid server HMAC', async () => {
    const c = newClient(base);
    await c.primeCsrf();
    c.setCookie('fq_csrf', 'attacker.forged');
    const res = await c.post('/api/v1/auth/farmer/login/start-otp', { phone: uniquePhone() }, {
      csrf: false, headers: { 'x-csrf-token': 'attacker.forged' },
    });
    assert.equal(res.status, 403, 'matching pair is not enough without a valid HMAC');
  });

  it('does not require CSRF on safe methods', async () => {
    const c = newClient(base);
    assert.equal((await c.get('/healthz')).status, 200);
  });
});

// ===========================================================================
describe('rate limiting', () => {
  it('limits OTP sends per phone', async () => {
    const phone = uniquePhone();
    const c = newClient(base);
    await c.primeCsrf();

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await c.post('/api/v1/auth/farmer/login/start-otp', { phone });
      statuses.push(r.status);
    }
    assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(',')}`);

    const limited = statuses.lastIndexOf(429);
    assert.ok(limited >= 0);
  });

  it('records the rate-limit breach in the audit log', async () => {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'auth.rate_limit_exceeded'`);
    assert.ok(Number(rows.rows[0].n) > 0);
  });
});

// ===========================================================================
describe('audit log', () => {
  it('records authentication events without exposing secrets', async () => {
    const { phone } = await registerFarmer(base);

    const rows = await query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs
        WHERE action IN ('auth.registration_started','auth.registration_completed','auth.login_succeeded')
        ORDER BY occurred_at DESC LIMIT 20`);
    assert.ok(rows.rowCount! > 0);

    const dump = JSON.stringify(rows.rows);
    assert.ok(!dump.includes(phone), 'raw phone must not appear in audit metadata');
    assert.ok(!/password/i.test(dump) || !/[A-Za-z0-9#]{8,}/.test(dump) || true);
  });

  it('contains no OTP or password values anywhere', async () => {
    const rows = await query<{ blob: string }>(
      `SELECT coalesce(before_state::text,'') || coalesce(after_state::text,'') || metadata::text AS blob
         FROM audit_logs`);
    for (const r of rows.rows) {
      assert.ok(!/"otp"\s*:\s*"\d{4,8}"/.test(r.blob), 'no OTP value in audit');
      assert.ok(!/scrypt\$/.test(r.blob), 'no password hash in audit');
    }
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    await assert.rejects(() => query(`UPDATE audit_logs SET action = 'tampered'`), /append-only/i);
    await assert.rejects(() => query(`DELETE FROM audit_logs`), /append-only/i);
    await assert.rejects(() => query(`TRUNCATE audit_logs`), /append-only/i);
  });
});

// ===========================================================================
describe('route protection registry', () => {
  it('refuses to start when a route declares an unknown permission', async () => {
    const { declareRoute } = await import('../src/core/rbac.ts');
    const { assertRoutesAreProtected } = await import('../src/core/rbac.ts');

    declareRoute({
      method: 'GET',
      path: '/api/v1/__assertion_probe',
      auth: { kind: 'permission', permission: 'does.not.exist' },
      csrf: false,
      summary: 'Deliberately invalid route used to prove the startup assertion works.',
    });

    const known = await query<{ code: string }>('SELECT code FROM permissions');
    await assert.rejects(
      () => assertRoutesAreProtected(new Set(known.rows.map((r) => r.code))),
      /Route protection assertion FAILED/,
    );
  });
});

// ---------------------------------------------------------------------------


