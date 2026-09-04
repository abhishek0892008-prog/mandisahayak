/**
 * The public district reference endpoint, and the registration flow that
 * depends on it.
 *
 * WHY THIS FILE EXISTS: `POST /auth/farmer/register/start-otp` is public and
 * requires a `districtId` UUID. If the only way to learn a district id were an
 * authenticated endpoint, a farmer would need an account before they could
 * create one and registration would be unreachable for every real client. So
 * `GET /reference/districts` is deliberately public — and that fact is load
 * bearing, not incidental. Nothing here may regress it back behind a session.
 *
 * The mirror obligation is just as important: districts are the ONLY reference
 * endpoint opened to anonymous callers (alongside the equally narrow
 * `/reference/registration-centres` used by the officer application form).
 * These tests pin both halves — what is open, and everything that must stay
 * shut — so "make it work" can never quietly become "make it all public".
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

type District = {
  id: string;
  name: string;
  lgdCode: string | null;
  dataType: string;
  state: { name: string; lgdCode: string };
};

/** A client that has never authenticated and holds no session cookie. */
function anonymous() {
  return newClient(base);
}

// ===========================================================================
describe('GET /reference/districts is publicly readable', () => {
  // (A) The registration form's very first call, made exactly as a browser
  // makes it on a cold load: no session, no CSRF, no cookies of any kind.
  it('answers 200 to a caller with no session and no cookies at all', async () => {
    const res = await anonymous().get<District[]>('/api/v1/reference/districts');

    assert.equal(res.status, 200, 'an anonymous district read must not be rejected');
    assert.ok(Array.isArray(res.body.data), 'the payload is a plain array of districts');
  });

  // (C) "Unauthenticated" must mean genuinely unauthenticated. A route that
  // only works because the harness happened to prime a cookie first would pass
  // (A) and still be broken in a real browser, so assert the absence directly.
  it('requires no session: the request carries no session cookie and none is demanded', async () => {
    const client = anonymous();
    assert.equal(client.cookie('fq_session'), undefined, 'precondition: no session to send');

    const res = await client.get<District[]>('/api/v1/reference/districts');

    assert.equal(res.status, 200);
    assert.notEqual(res.status, 401, 'must never answer UNAUTHENTICATED');
    assert.notEqual(res.status, 403, 'must never answer FORBIDDEN');
    assert.equal(
      client.cookie('fq_session'),
      undefined,
      'a reference read must not mint a session as a side effect',
    );
  });

  // (B) The list has to be the real one. An endpoint that returns 200 and an
  // empty array is exactly as unusable to a farmer as one that returns 500 —
  // the dropdown is still empty and Continue is still blocked.
  it('returns the districts actually present in the database, not a placeholder list', async () => {
    const expected = await query<{ id: string; name: string }>(
      `SELECT d.id, d.name FROM districts d JOIN states s ON s.id = d.state_id ORDER BY d.name`,
    );
    assert.ok(expected.rows.length > 0, 'precondition: the database has imported districts');

    const res = await anonymous().get<District[]>('/api/v1/reference/districts');
    assert.equal(res.status, 200);

    assert.deepEqual(
      res.body.data!.map((d) => ({ id: d.id, name: d.name })),
      expected.rows.map((r) => ({ id: r.id, name: r.name })),
      'the response mirrors the imported districts, in name order',
    );

    for (const district of res.body.data!) {
      assert.match(
        district.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'each district carries the UUID registration will submit',
      );
      assert.ok(district.name.trim().length > 0, 'each district is labelled');
      // Provenance survives to the client, so the UI can say honestly whether
      // this is OFFICIAL government geography or CONFIGURED demonstration data.
      assert.ok(
        ['OFFICIAL', 'CONFIGURED'].includes(district.dataType),
        `dataType must be stated, got ${district.dataType}`,
      );
      assert.ok(district.state?.name, 'each district names its state');
    }
  });

  // The security boundary on the thing we just opened. Districts are public
  // geography; the response must carry that and nothing else.
  it('exposes district reference data only — no farmer, session or admin data', async () => {
    const res = await anonymous().get<District[]>('/api/v1/reference/districts');
    assert.equal(res.status, 200);

    for (const district of res.body.data!) {
      assert.deepEqual(
        Object.keys(district).sort(),
        ['dataType', 'id', 'lgdCode', 'name', 'state'],
        'the projection is fixed; a new key here is a deliberate disclosure decision',
      );
      assert.deepEqual(Object.keys(district.state).sort(), ['lgdCode', 'name']);
    }

    // Belt and braces: no personal or credential-shaped field anywhere in the
    // serialised body, however the projection is later restructured.
    const raw = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of [
      'phone',
      'password',
      'token',
      'session',
      'otp',
      'farmer',
      'user_id',
      'userid',
      'employee',
      'audit',
    ]) {
      assert.equal(raw.includes(forbidden), false, `district payload must not mention "${forbidden}"`);
    }
  });

  // Read-only. Opening a GET must not have opened a write surface with it.
  it('is read-only: no mutation route exists on the district reference path', async () => {
    const client = anonymous();
    // Prime CSRF first, so a rejection is a genuine "no such route" and not
    // the CSRF gate answering before routing ever happens.
    await client.primeCsrf();

    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const res = await client.request(method, '/api/v1/reference/districts', { body: {} });
      assert.equal(res.status, 404, `${method} /reference/districts must not be routable`);
      assert.equal(res.body.error?.code, 'NOT_FOUND');
    }
  });

  // (D) Opening the endpoint to anonymous callers must not have closed it to
  // anyone. The same screen is reachable signed in (Profile shows a district).
  it('remains readable by an authenticated farmer', async () => {
    const { client } = await registerFarmer(base);

    const res = await client.get<District[]>('/api/v1/reference/districts');
    assert.equal(res.status, 200);
    assert.ok(res.body.data!.length > 0);
  });

  it('returns the identical list signed in and signed out', async () => {
    const { client } = await registerFarmer(base);

    const signedOut = await anonymous().get<District[]>('/api/v1/reference/districts');
    const signedIn = await client.get<District[]>('/api/v1/reference/districts');

    assert.deepEqual(
      signedIn.body.data,
      signedOut.body.data,
      'reference data is identical for every caller; a session changes nothing',
    );
  });
});

// ===========================================================================
// (E) and (H). The district endpoint is the ONE exception. Everything else a
// farmer can reach must still demand a session, or opening districts has cost
// us the authorization model.
// ===========================================================================
describe('opening districts does not weaken any other endpoint', () => {
  it('still refuses every other reference endpoint without a session', async () => {
    const client = anonymous();
    const districts = await client.get<District[]>('/api/v1/reference/districts');
    const districtId = districts.body.data![0].id;

    const stillPrivate = [
      `/api/v1/reference/villages?districtId=${districtId}`,
      '/api/v1/reference/crops',
      '/api/v1/reference/centres',
      '/api/v1/reference/booking-constraints',
    ];

    for (const path of stillPrivate) {
      const res = await anonymous().get(path);
      assert.equal(res.status, 401, `${path} must still require a session`);
      assert.equal(res.body.error?.code, 'UNAUTHENTICATED');
    }
  });

  it('still refuses private farmer data without a session', async () => {
    for (const path of ['/api/v1/me', '/api/v1/bookings/me', '/api/v1/notifications']) {
      const res = await anonymous().get(path);
      assert.equal(res.status, 401, `${path} must still require a session`);
    }
  });

  it('still refuses administrative data without a session', async () => {
    for (const path of ['/api/v1/admin/farmers', '/api/v1/admin/audit-logs', '/api/v1/admin/centres']) {
      const res = await anonymous().get(path);
      assert.equal(res.status, 401, `${path} must still require a session`);
    }
  });

  it('still refuses officer operations without a session', async () => {
    const res = await anonymous().get('/api/v1/officer/centres');
    assert.equal(res.status, 401);
  });

  it('still refuses anonymous writes without CSRF', async () => {
    const res = await anonymous().post(
      '/api/v1/auth/farmer/register/start-otp',
      { fullName: 'No Csrf', phone: uniquePhone() },
      { csrf: false },
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code, 'CSRF_TOKEN_INVALID');
  });
});

// ===========================================================================
// (F) and (G). The reason the endpoint is public at all: an id taken from it
// has to carry a brand-new farmer all the way to the OTP screen.
// ===========================================================================
describe('a district id from the public list carries registration to OTP', () => {
  it('completes registration end to end with nothing but the public district list', async () => {
    const client = newClient(base);
    await client.primeCsrf();

    // Step 1 — exactly what the registration form does on load, with no session.
    const districts = await client.get<District[]>('/api/v1/reference/districts');
    assert.equal(districts.status, 200);
    assert.ok(districts.body.data!.length > 0, 'the dropdown has something to render');

    // Step 2 — the farmer picks one. No id is hardcoded anywhere in this test.
    const chosen = districts.body.data![0];

    // Step 3 — submit. This is the call that was unreachable if districts were private.
    const phone = uniquePhone();
    const start = await client.post<{ challengeId: string; otpLength: number }>(
      '/api/v1/auth/farmer/register/start-otp',
      {
        fullName: 'Public District Farmer',
        phone,
        districtId: chosen.id,
        locale: 'en',
        consent: { policyVersion: 'v1', accepted: true },
      },
    );

    assert.equal(start.status, 201, `registration must be accepted: ${JSON.stringify(start.body)}`);
    assert.ok(start.body.data!.challengeId, 'an OTP challenge is issued — the farmer reaches the OTP step');

    // Step 4 — and the OTP step actually completes, so this is a real journey
    // and not just a well-formed 201.
    const verify = await client.post('/api/v1/auth/otp/verify', {
      challengeId: start.body.data!.challengeId,
      otp: demoOtpFor(phone),
    });
    assert.equal(verify.status, 201, 'the OTP verifies and a session is minted');

    // Step 5 — the district the farmer chose is the district that was stored.
    const me = await client.get<{ district: { id: string; name: string } | null }>('/api/v1/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.data!.district?.id, chosen.id, 'the chosen district was persisted');
  });

  it('rejects a malformed districtId rather than accepting anything', async () => {
    const client = newClient(base);
    await client.primeCsrf();

    const res = await client.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Malformed District',
      phone: uniquePhone(),
      districtId: 'not-a-uuid',
      locale: 'en',
      consent: { policyVersion: 'v1', accepted: true },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, 'VALIDATION_FAILED');
    assert.equal(res.body.error?.fields?.districtId, 'DISTRICT_ID_INVALID');
  });

  it('rejects a well-formed districtId that names no district', async () => {
    const client = newClient(base);
    await client.primeCsrf();

    const res = await client.post('/api/v1/auth/farmer/register/start-otp', {
      fullName: 'Unknown District',
      phone: uniquePhone(),
      // Valid UUID, deliberately not in the list the public endpoint returned.
      districtId: '00000000-0000-4000-a000-000000000000',
      locale: 'en',
      consent: { policyVersion: 'v1', accepted: true },
    });

    assert.equal(res.status, 422, 'a syntactically valid but unknown district is still refused');
    assert.equal(res.body.error?.code, 'DISTRICT_NOT_FOUND');
  });

  it('does not let the public endpoint become an unbounded anonymous read', async () => {
    // The endpoint is unauthenticated, so the per-IP bucket is the only thing
    // bounding it. Prove the limit is wired, not merely declared.
    const { RateLimits } = await import('../src/core/rateLimit.ts');
    const limit = RateLimits.PUBLIC_REFERENCE_PER_IP.limit;

    const client = anonymous();
    for (let i = 0; i < limit; i += 1) {
      const res = await client.get('/api/v1/reference/districts');
      assert.equal(res.status, 200, `request ${i + 1} of ${limit} should still be allowed`);
    }

    const overflow = await client.get('/api/v1/reference/districts');
    assert.equal(overflow.status, 429, 'the request past the limit is refused');
    assert.equal(overflow.body.error?.code, 'RATE_LIMITED');

    // Hand the bucket back. Tests and a local dev server share 127.0.0.1, so a
    // suite that exits with this bucket full locks the developer's own browser
    // out of the district list — and out of registration — for the rest of the
    // window. `beforeEach` cannot help: nothing runs after the last test.
    await resetRateLimits();
  });
});
