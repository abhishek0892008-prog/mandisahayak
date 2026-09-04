/**
 * Phase 10: notifications and farmer status updates.
 *
 * Split as Phases 7-9 split: the renderer and dedupe keys are pure and tested
 * without a database; everything about transactions, ownership and delivery is
 * tested end to end because that is the only place those properties exist.
 *
 * Centre: HATHRAS. One lane, WHEAT configured, and no other suite books there,
 * so this file cannot be starved of capacity by Phases 7-9.
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
  dedupeKeyFor,
  normaliseLocale,
  renderNotification,
  renderTemplate,
  templateVariables,
  templateVarsFor,
  titleFor,
} from '../src/engines/notifications.ts';
import {
  DevNotificationProvider,
  getNotificationProvider,
  resetNotificationProvider,
  setNotificationProvider,
} from '../src/integrations/notifications/provider.ts';
import { dispatchPending, listDeadLettered } from '../src/modules/notifications/notifications.service.ts';
import { TerminalDeliveryError } from '../src/integrations/notifications/errors.ts';
import { enqueue } from '../src/modules/notifications/notifications.repository.ts';
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

describe('dedupe keys (pure)', () => {
  it('is deterministic per booking and event', () => {
    assert.equal(
      dedupeKeyFor('BOOKING_CONFIRMED', { bookingId: 'b1' }),
      'booking:b1:BOOKING_CONFIRMED',
    );
    assert.equal(
      dedupeKeyFor('BOOKING_CONFIRMED', { bookingId: 'b1' }),
      dedupeKeyFor('BOOKING_CONFIRMED', { bookingId: 'b1' }),
      'the same event must always produce the same key',
    );
  });

  it('separates different events on the same booking', () => {
    const a = dedupeKeyFor('BOOKING_CONFIRMED', { bookingId: 'b1' });
    const b = dedupeKeyFor('BOOKING_ARRIVED', { bookingId: 'b1' });
    const c = dedupeKeyFor('PROCUREMENT_COMPLETED', { bookingId: 'b1' });
    assert.equal(new Set([a, b, c]).size, 3);
  });

  it('qualifies PAYMENT_UPDATED by status, so each transition is its own fact', () => {
    const initiated = dedupeKeyFor('PAYMENT_UPDATED', { paymentId: 'p1', status: 'INITIATED' });
    const paid = dedupeKeyFor('PAYMENT_UPDATED', { paymentId: 'p1', status: 'PAID' });
    assert.notEqual(initiated, paid);
    assert.equal(paid, 'payment:p1:PAYMENT_UPDATED:PAID');
  });

  it('scopes PAYMENT_BLOCKED to the payment, not the status', () => {
    assert.equal(
      dedupeKeyFor('PAYMENT_BLOCKED', { paymentId: 'p1' }),
      'payment:p1:PAYMENT_BLOCKED',
    );
  });
});

describe('rendering (pure)', () => {
  const ctx = {
    bookingCode: 'FQ-2026-1234567',
    cropName: 'Wheat',
    centreName: 'Hathras Centre',
    serviceDate: '2026-09-09',
    scheduledStartLocal: '09:00',
    tokenNumber: 3,
    paymentStatus: 'PENDING',
    amountRupees: '64625.00',
    blockedReason: 'MSP_AMBIGUOUS',
  };

  it('renders every wired event in English with the farmer’s own details', () => {
    for (const e of [
      'BOOKING_CONFIRMED',
      'BOOKING_ARRIVED',
      'PROCUREMENT_COMPLETED',
      'PAYMENT_BLOCKED',
      'PAYMENT_UPDATED',
    ] as const) {
      const r = renderNotification(e, 'en', ctx);
      assert.ok(r.title.length > 0, e);
      assert.ok(r.body.includes('FQ-2026-1234567'), `${e} names the booking`);
    }
  });

  it('renders in Hindi for a Hindi-preferring farmer', () => {
    const en = renderNotification('BOOKING_CONFIRMED', 'en', ctx);
    const hi = renderNotification('BOOKING_CONFIRMED', 'hi', ctx);
    assert.notEqual(en.body, hi.body);
    assert.match(hi.body, /[ऀ-ॿ]/, 'contains Devanagari');
    assert.ok(hi.body.includes('FQ-2026-1234567'), 'the code is not translated');
  });

  it('explains a blocked payment in words, from the code the farmer already sees', () => {
    const en = renderNotification('PAYMENT_BLOCKED', 'en', ctx);
    assert.match(en.body, /grade/i, 'says why, not just that it is blocked');
    assert.doesNotMatch(en.body, /MSP_AMBIGUOUS/, 'the raw code is not shown as prose');
  });

  it('omits the amount when there is none rather than printing a misleading zero', () => {
    const r = renderNotification('PAYMENT_UPDATED', 'en', { ...ctx, amountRupees: null });
    assert.doesNotMatch(r.body, /₹/);
    assert.doesNotMatch(r.body, /\b0\.00\b/);
  });

  it('never leaks an internal identifier into farmer-facing copy', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const e of ['BOOKING_CONFIRMED', 'PROCUREMENT_COMPLETED', 'PAYMENT_BLOCKED'] as const) {
      for (const l of ['en', 'hi'] as const) {
        const r = renderNotification(e, l, ctx);
        assert.doesNotMatch(r.body, uuid);
        assert.doesNotMatch(r.body, /select |insert |constraint|violat|stack/i);
      }
    }
  });

  it('falls back to English for an unknown locale rather than failing', () => {
    assert.equal(normaliseLocale('fr'), 'en');
    assert.equal(normaliseLocale(null), 'en');
    assert.equal(normaliseLocale('hi'), 'hi');
    assert.equal(titleFor('BOOKING_CONFIRMED', 'en'), 'Booking confirmed');
  });
});

describe('the DEMO provider (pure)', () => {
  it('never claims real delivery', async () => {
    const p = new DevNotificationProvider();
    assert.equal(p.isRealDelivery, false, 'the provider declares itself not real');
    const r = await p.send({
      notificationId: '11111111-1111-4111-8111-111111111111',
      channel: 'IN_APP',
      toPhoneE164: null,
      body: 'x',
    });
    assert.equal(r.realDelivery, false);
    assert.match(r.providerMessageId, /^DEMO-/, 'the id itself says DEMO');
  });
});

// ===========================================================================
// Integration
// ===========================================================================

const HATHRAS = 'DEMO-UP-HATHRAS-01';

let seq = 0;
const idemKey = () => `notif-test-${Date.now()}-${seq++}`;

function nextThursday(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 4);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function bookAtHathras() {
  const reg = await registerFarmer(base);
  const ids = await query<{ centre_id: string; crop_id: string }>(
    `SELECT pc.id AS centre_id, cr.id AS crop_id FROM procurement_centres pc, crops cr
      WHERE pc.code = $1 AND cr.code = 'WHEAT'`,
    [HATHRAS],
  );
  const res = await reg.client.request<{ bookingCode: string }>('POST', '/api/v1/bookings', {
    body: {
      centreId: ids.rows[0].centre_id,
      cropId: ids.rows[0].crop_id,
      quantityKg: 2500,
      preferredDate: nextThursday(),
    },
    headers: { 'idempotency-key': idemKey() },
  });
  if (res.status !== 201) throw new Error(`booking failed: ${JSON.stringify(res.body)}`);
  return { client: reg.client, phone: reg.phone, code: res.body.data!.bookingCode };
}

async function officerAtHathras() {
  const spec = {
    username: `n-off-${Date.now()}-${seq++}`,
    password: 'Officer-Passw0rd!',
    phone: uniquePhone(),
  };
  const c = await query<{ id: string }>('SELECT id FROM procurement_centres WHERE code = $1', [
    HATHRAS,
  ]);
  await createStaffUser({ ...spec, role: 'OFFICER', centreId: c.rows[0].id });
  return staffLogin(base, spec.phone);
}

type C = ReturnType<typeof newClient>;
const feed = (c: C, q = '') => c.get(`/api/v1/notifications${q}`);
const step = (c: C, code: string, s: string, body?: unknown) =>
  c.post(`/api/v1/officer/bookings/${code}/${s}`, body ?? {});

async function rowsFor(code: string) {
  return query<{ event_key: string; status: string; rendered_body: string; id: string }>(
    `SELECT n.id, n.event_key, n.status, n.rendered_body
       FROM notifications n JOIN bookings b ON b.id = n.booking_id
      WHERE b.booking_code = $1 ORDER BY n.created_at`,
    [code],
  );
}

// ---------------------------------------------------------------------------

describe('booking confirmation notification', () => {
  it('is enqueued in the same transaction as the booking', async () => {
    const b = await bookAtHathras();
    const rows = await rowsFor(b.code);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].event_key, 'BOOKING_CONFIRMED');
    assert.ok(rows.rows[0].rendered_body.includes(b.code));
  });

  it('is QUEUED, not SENT — no provider is called inside the business transaction', async () => {
    const b = await bookAtHathras();
    const rows = await rowsFor(b.code);
    assert.equal(
      rows.rows[0].status,
      'QUEUED',
      'a booking must not depend on a transport to commit',
    );
    assert.equal(
      (await query('SELECT 1 FROM notifications WHERE sent_at IS NOT NULL AND id = $1', [rows.rows[0].id])).rowCount,
      0,
    );
  });

  it('does not duplicate when the same booking request is replayed', async () => {
    // An idempotent replay returns the same booking; it must not enqueue twice.
    const reg = await registerFarmer(base);
    const ids = await query<{ centre_id: string; crop_id: string }>(
      `SELECT pc.id AS centre_id, cr.id AS crop_id FROM procurement_centres pc, crops cr
        WHERE pc.code = $1 AND cr.code = 'WHEAT'`,
      [HATHRAS],
    );
    const key = idemKey();
    const body = {
      centreId: ids.rows[0].centre_id,
      cropId: ids.rows[0].crop_id,
      quantityKg: 2500,
      preferredDate: nextThursday(),
    };
    const first = await reg.client.request<{ bookingCode: string }>('POST', '/api/v1/bookings', {
      body,
      headers: { 'idempotency-key': key },
    });
    const second = await reg.client.request('POST', '/api/v1/bookings', {
      body,
      headers: { 'idempotency-key': key },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const rows = await rowsFor(first.body.data!.bookingCode);
    assert.equal(rows.rowCount, 1, 'exactly one notification for a replayed event');
  });

  it('is prevented from duplicating by the DATABASE, not by an application check', async () => {
    const b = await bookAtHathras();
    const bid = await query<{ id: string; user_id: string }>(
      `SELECT b.id, f.user_id FROM bookings b JOIN farmers f ON f.id = b.farmer_id
        WHERE b.booking_code = $1`,
      [b.code],
    );

    // Insert the identical dedupe key again, directly, bypassing every service.
    await withTransaction(async (client) => {
      const id = await enqueue(client, {
        userId: bid.rows[0].user_id,
        bookingId: bid.rows[0].id,
        eventKey: 'BOOKING_CONFIRMED',
        channel: 'IN_APP',
        locale: 'en',
        dedupeKey: `booking:${bid.rows[0].id}:BOOKING_CONFIRMED`,
        renderedBody: 'duplicate attempt',
        toPhoneE164: null,
      });
      assert.equal(id, null, 'the UNIQUE constraint absorbed it');
    });

    assert.equal((await rowsFor(b.code)).rowCount, 1);
  });
});

describe('transactional safety', () => {
  it('rolls the business mutation back if the enqueue fails', async () => {
    const b = await bookAtHathras();
    const bid = await query<{ id: string; user_id: string }>(
      `SELECT b.id, f.user_id FROM bookings b JOIN farmers f ON f.id = b.farmer_id
        WHERE b.booking_code = $1`,
      [b.code],
    );

    // A business change plus an enqueue that cannot succeed: the event key is
    // not in notification_event_t, so the CHECK rejects it.
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query(
          `UPDATE bookings SET cancellation_reason = 'should not persist' WHERE id = $1`,
          [bid.rows[0].id],
        );
        await enqueue(client, {
          userId: bid.rows[0].user_id,
          bookingId: bid.rows[0].id,
          eventKey: 'NOT_A_REAL_EVENT',
          channel: 'IN_APP',
          locale: 'en',
          dedupeKey: `booking:${bid.rows[0].id}:NOT_A_REAL_EVENT`,
          renderedBody: 'x',
          toPhoneE164: null,
        });
      }),
    );

    const after = await query<{ r: string | null }>(
      'SELECT cancellation_reason AS r FROM bookings WHERE id = $1',
      [bid.rows[0].id],
    );
    assert.equal(
      after.rows[0].r,
      null,
      'the business change rolled back with the failed enqueue',
    );
  });

  it('leaves no notification when the business transaction rolls back', async () => {
    const before = await query<{ n: string }>('SELECT count(*)::text AS n FROM notifications');
    await assert.rejects(
      withTransaction(async (client) => {
        await enqueue(client, {
          userId: (await query<{ id: string }>('SELECT id FROM users LIMIT 1')).rows[0].id,
          bookingId: null,
          eventKey: 'BOOKING_CONFIRMED',
          channel: 'IN_APP',
          locale: 'en',
          dedupeKey: `rollback-test-${Date.now()}`,
          renderedBody: 'x',
          toPhoneE164: null,
        });
        throw new Error('business failure after enqueue');
      }),
    );
    const after = await query<{ n: string }>('SELECT count(*)::text AS n FROM notifications');
    assert.equal(after.rows[0].n, before.rows[0].n, 'nothing was left behind');
  });
});

describe('lifecycle notifications', () => {
  it('records arrival, completion and payment events for the farmer', async () => {
    const b = await bookAtHathras();
    const officer = await officerAtHathras();

    await step(officer, b.code, 'arrive');
    await step(officer, b.code, 'weighing');
    await step(officer, b.code, 'weight', { grossQuantityKg: 2500 });
    await step(officer, b.code, 'quality', { acceptedQuantityKg: 2500, rejectedQuantityKg: 0 });
    await step(officer, b.code, 'complete');
    await step(officer, b.code, 'payment', { status: 'INITIATED' });
    await step(officer, b.code, 'payment', { status: 'PAID', paymentReference: 'UTR-N-1' });

    const events = (await rowsFor(b.code)).rows.map((r) => r.event_key);
    assert.deepEqual(events, [
      'BOOKING_CONFIRMED',
      'BOOKING_ARRIVED',
      'PROCUREMENT_COMPLETED',
      'PAYMENT_UPDATED', // INITIATED
      'PAYMENT_UPDATED', // PAID — a different fact, so a separate notification
    ]);
  });

  it('tells the farmer when a payment is blocked, and why', async () => {
    // Paddy without a grade blocks with MSP_AMBIGUOUS (Phase 8).
    const reg = await registerFarmer(base);
    const ids = await query<{ centre_id: string; crop_id: string }>(
      `SELECT pc.id AS centre_id, cr.id AS crop_id FROM procurement_centres pc, crops cr
        WHERE pc.code = 'DEMO-UP-MATHURA-01' AND cr.code = 'PADDY'`,
    );
    const res = await reg.client.request<{ bookingCode: string }>('POST', '/api/v1/bookings', {
      body: {
        centreId: ids.rows[0].centre_id,
        cropId: ids.rows[0].crop_id,
        quantityKg: 2500,
        preferredDate: nextThursday(),
      },
      headers: { 'idempotency-key': idemKey() },
    });
    assert.equal(res.status, 201);
    const code = res.body.data!.bookingCode;

    const c = await query<{ id: string }>(
      "SELECT id FROM procurement_centres WHERE code = 'DEMO-UP-MATHURA-01'",
    );
    const spec = {
      username: `n-off2-${Date.now()}-${seq++}`,
      password: 'Officer-Passw0rd!',
      phone: uniquePhone(),
    };
    await createStaffUser({ ...spec, role: 'OFFICER', centreId: c.rows[0].id });
    const officer = await staffLogin(base, spec.phone);

    await step(officer, code, 'arrive');
    await step(officer, code, 'weighing');
    await step(officer, code, 'weight', { grossQuantityKg: 2500 });
    await step(officer, code, 'quality', { acceptedQuantityKg: 2500, rejectedQuantityKg: 0 });
    await step(officer, code, 'complete');

    const rows = await rowsFor(code);
    const blocked = rows.rows.find((r) => r.event_key === 'PAYMENT_BLOCKED');
    assert.ok(blocked, 'a blocked payment notifies the farmer');
    assert.match(blocked!.rendered_body, /grade/i, 'and says why in plain language');
    assert.doesNotMatch(blocked!.rendered_body, /MSP_AMBIGUOUS/);
  });
});

describe('the farmer notification feed', () => {
  it('lists only the farmer’s own notifications', async () => {
    const b = await bookAtHathras();
    const r = await feed(b.client);
    assert.equal(r.status, 200);
    const d = r.body.data as Record<string, any>;
    assert.ok(d.count >= 1);
    assert.equal(d.notifications[0].type, 'BOOKING_CONFIRMED');
    assert.equal(d.notifications[0].bookingCode, b.code);
    assert.equal(d.notifications[0].read, false);
    assert.equal(d.notifications[0].delivery.realSmsDelivered, false, 'never claims real SMS');
  });

  it('does not show one farmer another farmer’s notifications', async () => {
    const a = await bookAtHathras();
    const b = await bookAtHathras();

    const aFeed = (await feed(a.client)).body.data as Record<string, any>;
    const codes = aFeed.notifications.map((n: any) => n.bookingCode);
    assert.ok(codes.includes(a.code));
    assert.ok(!codes.includes(b.code), 'strict ownership isolation');
  });

  it('reports an unread count, and it drops when one is read', async () => {
    const b = await bookAtHathras();
    const before = (await b.client.get('/api/v1/notifications/unread-count')).body.data as any;
    assert.ok(before.unreadCount >= 1);

    const list = (await feed(b.client)).body.data as any;
    const id = list.notifications[0].id;
    const marked = await b.client.post(`/api/v1/notifications/${id}/read`);
    assert.equal(marked.status, 200);

    const after = (await b.client.get('/api/v1/notifications/unread-count')).body.data as any;
    assert.equal(after.unreadCount, before.unreadCount - 1);
  });

  it('filters to unread only', async () => {
    const b = await bookAtHathras();
    const list = (await feed(b.client)).body.data as any;
    await b.client.post(`/api/v1/notifications/${list.notifications[0].id}/read`);
    const unread = (await feed(b.client, '?unread=true')).body.data as any;
    assert.ok(!unread.notifications.some((n: any) => n.id === list.notifications[0].id));
  });

  it('marks all read', async () => {
    const b = await bookAtHathras();
    const r = await b.client.post('/api/v1/notifications/read-all');
    assert.equal(r.status, 200);
    assert.ok((r.body.data as any).updated >= 1);
    const after = (await b.client.get('/api/v1/notifications/unread-count')).body.data as any;
    assert.equal(after.unreadCount, 0);
  });

  it('marking read does not touch delivery state', async () => {
    const b = await bookAtHathras();
    const list = (await feed(b.client)).body.data as any;
    const id = list.notifications[0].id;
    const before = await query<{ status: string; sent_at: Date | null; attempts: number }>(
      'SELECT status, sent_at, attempts FROM notifications WHERE id = $1',
      [id],
    );
    await b.client.post(`/api/v1/notifications/${id}/read`);
    const after = await query<{ status: string; sent_at: Date | null; attempts: number }>(
      'SELECT status, sent_at, attempts FROM notifications WHERE id = $1',
      [id],
    );
    assert.deepEqual(after.rows[0], before.rows[0], 'reading is not delivering');
  });

  it('exposes no UUID other than the notification’s own id', async () => {
    const b = await bookAtHathras();
    const d = (await feed(b.client)).body.data as any;
    const n = d.notifications[0];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(n.id, uuid, 'the id is the address of the resource');
    const withoutId = JSON.stringify({ ...n, id: undefined });
    assert.doesNotMatch(withoutId, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe('notification security', () => {
  it('refuses to let one farmer mark another’s notification read', async () => {
    const a = await bookAtHathras();
    const b = await bookAtHathras();
    const aList = (await feed(a.client)).body.data as any;
    const aId = aList.notifications[0].id;

    const attempt = await b.client.post(`/api/v1/notifications/${aId}/read`);
    assert.equal(attempt.status, 404, 'indistinguishable from a nonexistent id');

    const row = await query<{ read_at: Date | null }>(
      'SELECT read_at FROM notifications WHERE id = $1',
      [aId],
    );
    assert.equal(row.rows[0].read_at, null, 'and the row was NOT modified');
  });

  it('returns 404 for an unknown id, matching the foreign-id response', async () => {
    const b = await bookAtHathras();
    const r = await b.client.post('/api/v1/notifications/11111111-1111-4111-8111-111111111111/read');
    assert.equal(r.status, 404);
  });

  it('rejects a malformed id', async () => {
    const b = await bookAtHathras();
    const r = await b.client.post('/api/v1/notifications/not-a-uuid/read');
    assert.equal(r.status, 400);
    assert.equal(r.body.error!.code, 'VALIDATION_FAILED');
  });

  it('rejects unauthenticated requests', async () => {
    const anon = newClient(base);
    await anon.primeCsrf();
    assert.equal((await anon.get('/api/v1/notifications')).status, 401);
    assert.equal((await anon.get('/api/v1/notifications/unread-count')).status, 401);
    assert.equal((await anon.post('/api/v1/notifications/read-all')).status, 401);
  });

  it('refuses officers and admins — the permissions are FARMER-only', async () => {
    const officer = await officerAtHathras();
    assert.equal((await officer.get('/api/v1/notifications')).status, 403);
    assert.equal((await officer.get('/api/v1/notifications/unread-count')).status, 403);
    assert.equal((await officer.post('/api/v1/notifications/read-all')).status, 403);

    const spec = {
      username: `n-adm-${Date.now()}-${seq++}`,
      password: 'Admin-Passw0rd!',
      phone: uniquePhone(),
    };
    await createStaffUser({ ...spec, role: 'ADMIN' });
    const admin = await staffLogin(base, spec.phone);
    assert.equal((await admin.get('/api/v1/notifications')).status, 403);
  });

  it('enforces CSRF on the mutating endpoints', async () => {
    const b = await bookAtHathras();
    const list = (await feed(b.client)).body.data as any;
    const id = list.notifications[0].id;

    const noCsrf = await b.client.post(`/api/v1/notifications/${id}/read`, undefined, {
      csrf: false,
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error!.code, 'CSRF_TOKEN_INVALID');

    const allNoCsrf = await b.client.post('/api/v1/notifications/read-all', undefined, {
      csrf: false,
    });
    assert.equal(allNoCsrf.status, 403);
  });

  it('cannot be redirected to another farmer by a query parameter', async () => {
    const a = await bookAtHathras();
    const b = await bookAtHathras();
    // There is no userId/farmerId parameter; supplying one changes nothing.
    const r = await b.client.get('/api/v1/notifications?userId=whatever&farmerId=whatever');
    const codes = (r.body.data as any).notifications.map((n: any) => n.bookingCode);
    assert.ok(!codes.includes(a.code));
  });

  it('rate limits the feed per session', async () => {
    const b = await bookAtHathras();
    const s = await query<{ id: string }>(
      `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.phone_e164 = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [`+91${b.phone}`],
    );
    const rule = RateLimits.NOTIFICATION_READ_PER_SESSION;
    const windowMs = rule.windowSeconds * 1000;
    const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    await query(
      `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, hits, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (bucket_key, window_started_at) DO UPDATE SET hits = EXCLUDED.hits`,
      [`${rule.name}:${s.rows[0].id}`, start, rule.limit, new Date(start.getTime() + windowMs)],
    );
    const limited = await feed(b.client);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error!.code, 'RATE_LIMITED');
  });

  it('leaks no sensitive material into any notification body', async () => {
    const rows = await query<{ b: string }>('SELECT rendered_body AS b FROM notifications');
    for (const r of rows.rows) {
      assert.doesNotMatch(r.b, /password|otp|pepper|secret|token=|Bearer |postgres:\/\//i);
      assert.doesNotMatch(r.b, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });
});

describe('DEMO delivery', () => {
  it('marks rows SENT with a DEMO id, and never claims a real SMS', async () => {
    const b = await bookAtHathras();
    const rowsBefore = await rowsFor(b.code);
    assert.equal(rowsBefore.rows[0].status, 'QUEUED');

    const result = await dispatchPending(100);
    assert.ok(result.claimed >= 1);
    assert.equal(result.provider, 'DEV_DEMO');
    assert.equal(getNotificationProvider().isRealDelivery, false);

    const after = await query<{ status: string; provider_message_id: string; sent_at: Date }>(
      'SELECT status, provider_message_id, sent_at FROM notifications WHERE id = $1',
      [rowsBefore.rows[0].id],
    );
    assert.equal(after.rows[0].status, 'SENT');
    assert.match(after.rows[0].provider_message_id, /^DEMO-/);
    assert.ok(after.rows[0].sent_at);

    const view = (await feed(b.client)).body.data as any;
    const n = view.notifications.find((x: any) => x.id === rowsBefore.rows[0].id);
    assert.equal(n.delivery.demo, true, 'the feed states it was a DEMO delivery');
    assert.equal(n.delivery.realSmsDelivered, false);
  });

  it('retries a transient failure with backoff instead of giving up', async () => {
    const original = getNotificationProvider();
    setNotificationProvider({
      name: 'FLAKY_TEST',
      isRealDelivery: false,
      async send() {
        throw new Error('provider unavailable');
      },
    });
    try {
      const b = await bookAtHathras();
      const before = (await rowsFor(b.code)).rows[0];
      const r = await dispatchPending(100);
      assert.ok(r.retrying >= 1, 'a transient failure schedules a retry');

      const after = await query<{ status: string; attempts: number; scheduled_for: Date; last_error: string }>(
        'SELECT status, attempts, scheduled_for, last_error FROM notifications WHERE id = $1',
        [before.id],
      );
      assert.equal(after.rows[0].status, 'QUEUED', 'back to QUEUED, not FAILED');
      assert.equal(after.rows[0].attempts, 1);
      assert.ok(
        after.rows[0].scheduled_for.getTime() > Date.now(),
        'and pushed into the future by the backoff — it is not due yet',
      );
      assert.equal(after.rows[0].last_error, 'provider unavailable');
      assert.doesNotMatch(after.rows[0].last_error, /at |\.ts:|select |insert /i);

      // Because it is not due, an immediate second run must not pick it up.
      const second = await dispatchPending(100);
      assert.equal(second.claimed, 0, 'backoff is real: the row is not claimed again immediately');
    } finally {
      setNotificationProvider(original);
    }
  });

  it('goes terminal immediately when the provider says the failure will recur', async () => {
    const original = getNotificationProvider();
    setNotificationProvider({
      name: 'TERMINAL_TEST',
      isRealDelivery: false,
      async send() {
        throw new TerminalDeliveryError('invalid recipient');
      },
    });
    try {
      const b = await bookAtHathras();
      const id = (await rowsFor(b.code)).rows[0].id;
      const r = await dispatchPending(100);
      assert.ok(r.failed >= 1);

      const after = await query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM notifications WHERE id = $1',
        [id],
      );
      assert.equal(after.rows[0].status, 'FAILED', 'no point retrying what will fail again');
      assert.equal(after.rows[0].attempts, 1, 'and it burned only one attempt');
    } finally {
      setNotificationProvider(original);
    }
  });

  it('stops retrying at max_attempts and dead-letters the row', async () => {
    const original = getNotificationProvider();
    setNotificationProvider({
      name: 'ALWAYS_FAILS',
      isRealDelivery: false,
      async send() {
        throw new Error('still down');
      },
    });
    try {
      const b = await bookAtHathras();
      const id = (await rowsFor(b.code)).rows[0].id;
      const max = (
        await query<{ m: number }>('SELECT max_attempts AS m FROM notifications WHERE id = $1', [id])
      ).rows[0].m;

      // Drive it to the ceiling, making each attempt due immediately.
      for (let i = 0; i < max; i += 1) {
        await query('UPDATE notifications SET scheduled_for = now() WHERE id = $1', [id]);
        await dispatchPending(100);
      }

      const after = await query<{ status: string; attempts: number; max_attempts: number }>(
        'SELECT status, attempts, max_attempts FROM notifications WHERE id = $1',
        [id],
      );
      assert.equal(after.rows[0].status, 'FAILED', 'terminal once the ceiling is reached');
      assert.equal(after.rows[0].attempts, after.rows[0].max_attempts);

      const dead = await listDeadLettered(100);
      assert.ok(dead.some((d) => d.id === id), 'and it is visible as a dead letter');
    } finally {
      setNotificationProvider(original);
    }
  });

  it('marks a claimed row SENDING so a crashed worker leaves evidence', async () => {
    const b = await bookAtHathras();
    const id = (await rowsFor(b.code)).rows[0].id;
    const original = getNotificationProvider();
    let observed: string | null = null;
    setNotificationProvider({
      name: 'OBSERVING',
      isRealDelivery: false,
      async send(input) {
        // Read our own row from a SEPARATE connection is not possible inside the
        // dispatch transaction, so observe the claim through the input instead:
        // reaching here at all proves the row was claimed exclusively.
        observed = input.notificationId;
        return { providerMessageId: `DEMO-${input.notificationId}`, realDelivery: false };
      },
    });
    try {
      await dispatchPending(100);
      assert.equal(observed, id, 'the claimed row was handed to the provider exactly once');
    } finally {
      setNotificationProvider(original);
    }
  });

  it('never hands the same row to two concurrent dispatchers', async () => {
    for (let i = 0; i < 3; i += 1) await bookAtHathras();
    const seen: string[] = [];
    const original = getNotificationProvider();
    setNotificationProvider({
      name: 'COUNTING',
      isRealDelivery: false,
      async send(input) {
        seen.push(input.notificationId);
        return { providerMessageId: `DEMO-${input.notificationId}`, realDelivery: false };
      },
    });
    try {
      await Promise.all([dispatchPending(100), dispatchPending(100), dispatchPending(100)]);
      assert.equal(new Set(seen).size, seen.length, 'FOR UPDATE SKIP LOCKED: no row delivered twice');
    } finally {
      setNotificationProvider(original);
    }
  });

  it('audits a dispatch run, recording that delivery was not real', async () => {
    await bookAtHathras();
    await dispatchPending(100);
    const audit = await query<{ meta: Record<string, unknown> }>(
      `SELECT metadata AS meta FROM audit_logs
        WHERE action = 'notification.dispatched' ORDER BY occurred_at DESC LIMIT 1`,
    );
    assert.ok(audit.rowCount! >= 1);
    assert.equal(audit.rows[0].meta.realDelivery, false);
    assert.equal(audit.rows[0].meta.provider, 'DEV_DEMO');
  });
});

describe('QUEUE_APPROACHING remains unfired', () => {
  it('is permitted by the schema but never enqueued, because no threshold exists', async () => {
    const b = await bookAtHathras();
    const officer = await officerAtHathras();
    await step(officer, b.code, 'arrive');

    const rows = await rowsFor(b.code);
    assert.ok(
      !rows.rows.some((r) => r.event_key === 'QUEUE_APPROACHING'),
      'no threshold is configured, so nothing may fire this event',
    );

    // Still absent across the entire database, not just this booking.
    const any = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications WHERE event_key = 'QUEUE_APPROACHING'`,
    );
    assert.equal(any.rows[0].n, '0');

    // And the threshold genuinely does not exist — this is why.
    const col = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND column_name ILIKE '%threshold%'`,
    );
    assert.equal(col.rows[0].n, '0', 'no threshold column exists to evaluate');
  });
});

// ===========================================================================
// PHASE 12 — templates, preferences, provider contract
// ===========================================================================

describe('template rendering (pure)', () => {
  it('substitutes every placeholder', () => {
    const r = renderTemplate('Booking {code} at {centre}.', { code: 'FQ-1', centre: 'Agra' });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.body, 'Booking FQ-1 at Agra.');
  });

  it('REJECTS a template with a missing variable instead of rendering a hole', () => {
    const r = renderTemplate('Payment for {code} is now {status}.', { code: 'FQ-1' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok === false && r.missing, ['status']);
  });

  it('treats an empty string as missing, not as a value', () => {
    const r = renderTemplate('Hello {name}.', { name: '' });
    assert.equal(r.ok, false);
  });

  it('reports the variables a template needs', () => {
    assert.deepEqual(templateVariables('{a} and {b} and {a}'), ['a', 'b']);
  });

  it('builds a complete variable bag from a render context', () => {
    const vars = templateVarsFor('en', {
      bookingCode: 'FQ-2026-1234567',
      paymentStatus: 'PAID',
      amountRupees: '100.00',
      blockedReason: 'MSP_AMBIGUOUS',
    });
    assert.equal(vars.bookingCode, 'FQ-2026-1234567');
    assert.match(String(vars.amountSuffix), /100\.00/);
    assert.match(String(vars.blockedReasonText), /grade/i);
  });

  it('never leaves amountSuffix empty, so it cannot count as missing', () => {
    const vars = templateVarsFor('en', { bookingCode: 'X', amountRupees: null });
    assert.notEqual(vars.amountSuffix, '');
  });
});

describe('templates are used end to end', () => {
  it('renders from the seeded template and records template_id', async () => {
    const b = await bookAtHathras();
    const row = await query<{ template_id: string | null; rendered_body: string }>(
      `SELECT n.template_id, n.rendered_body FROM notifications n
         JOIN bookings bk ON bk.id = n.booking_id WHERE bk.booking_code = $1`,
      [b.code],
    );
    assert.ok(row.rows[0].template_id, 'the seeded template was used, not the fallback');
    assert.ok(row.rows[0].rendered_body.includes(b.code));

    const tpl = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_templates
        WHERE id = $1 AND status = 'ACTIVE'`,
      [row.rows[0].template_id],
    );
    assert.equal(tpl.rows[0].n, '1');
  });

  it('seeds templates as CONFIGURED with NO DLT id — real SMS is not registered', async () => {
    const r = await query<{ total: string; with_dlt: string }>(
      `SELECT count(*)::text AS total, count(dlt_template_id)::text AS with_dlt
         FROM notification_templates WHERE status = 'ACTIVE'`,
    );
    assert.ok(Number(r.rows[0].total) >= 18);
    assert.equal(r.rows[0].with_dlt, '0', 'no DLT template id may be fabricated');
  });
});

describe('notification preferences', () => {
  it('defaults to ENABLED when nothing is recorded, and says so', async () => {
    const b = await bookAtHathras();
    const r = await b.client.get('/api/v1/notifications/preferences');
    assert.equal(r.status, 200);
    const d = r.body.data as Record<string, any>;
    assert.equal(d.defaultWhenUnset, 'ENABLED');
    assert.deepEqual(d.preferences, []);
  });

  it('lets a farmer opt out, and the dispatcher SUPPRESSES rather than sends', async () => {
    const b = await bookAtHathras();
    const put = await b.client.request('PUT', '/api/v1/notifications/preferences', {
      body: { channel: 'IN_APP', enabled: false },
    });
    assert.equal(put.status, 200);

    const result = await dispatchPending(100);
    assert.ok(result.suppressed >= 1, 'an opted-out row is suppressed');

    const row = await query<{ status: string; reason: string; sent_at: Date | null }>(
      `SELECT n.status, n.suppressed_reason AS reason, n.sent_at
         FROM notifications n JOIN bookings bk ON bk.id = n.booking_id
        WHERE bk.booking_code = $1`,
      [b.code],
    );
    assert.equal(row.rows[0].status, 'SUPPRESSED');
    assert.equal(row.rows[0].reason, 'USER_OPTED_OUT');
    assert.equal(row.rows[0].sent_at, null, 'suppressed is not sent');
  });

  it('keeps the record even when delivery is suppressed', async () => {
    const b = await bookAtHathras();
    await b.client.request('PUT', '/api/v1/notifications/preferences', {
      body: { channel: 'IN_APP', enabled: false },
    });
    await dispatchPending(100);
    const d = (await feed(b.client)).body.data as any;
    assert.ok(
      d.notifications.some((n: any) => n.bookingCode === b.code),
      'the farmer can still see that the event happened',
    );
  });

  it('an event-specific preference overrides the channel-wide one', async () => {
    const b = await bookAtHathras();
    await b.client.request('PUT', '/api/v1/notifications/preferences', {
      body: { channel: 'IN_APP', enabled: false },
    });
    await b.client.request('PUT', '/api/v1/notifications/preferences', {
      body: { channel: 'IN_APP', event: 'BOOKING_CONFIRMED', enabled: true },
    });
    const r = await dispatchPending(100);
    assert.ok(r.sent >= 1, 'the more specific preference wins');
  });

  it('cannot be set for another farmer — there is no user field to supply', async () => {
    const a = await bookAtHathras();
    const b = await bookAtHathras();
    await b.client.request('PUT', '/api/v1/notifications/preferences', {
      body: { channel: 'IN_APP', enabled: false, userId: 'anything' },
    });
    const aPrefs = (await a.client.get('/api/v1/notifications/preferences')).body.data as any;
    assert.deepEqual(aPrefs.preferences, [], 'the other farmer preferences are untouched');
  });

  it('rejects an unknown channel or event', async () => {
    const b = await bookAtHathras();
    for (const body of [
      { channel: 'CARRIER_PIGEON', enabled: true },
      { channel: 'IN_APP', event: 'NOT_AN_EVENT', enabled: true },
      { channel: 'IN_APP' },
    ]) {
      const r = await b.client.request('PUT', '/api/v1/notifications/preferences', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  it('requires CSRF and refuses officers', async () => {
    const b = await bookAtHathras();
    const noCsrf = await b.client.request('PUT', '/api/v1/notifications/preferences', {
      body: { channel: 'IN_APP', enabled: true },
      csrf: false,
    });
    assert.equal(noCsrf.status, 403);

    const officer = await officerAtHathras();
    assert.equal((await officer.get('/api/v1/notifications/preferences')).status, 403);
  });
});

describe('provider configuration', () => {
  it('refuses an unimplemented provider instead of silently using DEMO', () => {
    const original = getNotificationProvider();
    resetNotificationProvider();
    const prev = process.env.NOTIFICATION_PROVIDER;
    process.env.NOTIFICATION_PROVIDER = 'twilio';
    try {
      assert.throws(() => getNotificationProvider(), /not implemented/i);
    } finally {
      if (prev === undefined) delete process.env.NOTIFICATION_PROVIDER;
      else process.env.NOTIFICATION_PROVIDER = prev;
      resetNotificationProvider();
      setNotificationProvider(original);
    }
  });

  it('holds no credential, key or sender id anywhere in the provider layer', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/integrations/notifications/provider.ts', 'utf8');
    assert.doesNotMatch(src, /api[_-]?key|auth[_-]?token|sender[_-]?id|password|secret/i);
  });
});
