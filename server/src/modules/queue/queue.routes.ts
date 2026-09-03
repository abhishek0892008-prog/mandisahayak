/**
 * Queue routes (Phase 9).
 *
 * Both are GET, both are reads, and neither writes anything — architecture
 * §14.5 requires "a poll never sends an SMS and never mutates state" as an
 * explicit, tested invariant. There is no mutating queue endpoint because
 * queue order is derived and immutable from source records: nothing can
 * reorder it, so nothing needs an endpoint to try.
 *
 * Permissions `queue.read.own` and `queue.read.centre` already exist and are
 * already granted. Phase 9 adds no permission and changes no grant.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler, sendData } from '../../core/http.ts';
import { badRequest, notFound, ErrorCodes } from '../../core/errors.ts';
import { declareRoute, requirePermission, actorMayActOnCentre } from '../../core/rbac.ts';
import { consumeAll, RateLimits, toError } from '../../core/rateLimit.ts';
import { withTransaction } from '../../core/db.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import { getCentreQueue, getOwnQueue, todayAtCentre } from './queue.service.ts';

const BASE = '/api/v1';

const BookingCodeSchema = z.string().regex(/^FQ-\d{4}-\d{7}$/, 'BOOKING_CODE_INVALID');
const CentreIdSchema = z.string().uuid('CENTRE_ID_INVALID');
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID');

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Request validation failed', fields);
  }
  return r.data;
}

/**
 * Rate-limit rejections stay audited (existing behaviour). Successful polls are
 * NOT audited: they are reads, and a five-second poll per waiting farmer would
 * flood an append-only log retained for seven years with no decision in it.
 */
async function limit(
  req: Request,
  rule: (typeof RateLimits)[keyof typeof RateLimits],
  role: 'FARMER' | 'OFFICER',
) {
  const outcome = await consumeAll([{ rule, subject: req.actor!.sessionId }]);
  if (!outcome) return;
  await withTransaction((client) =>
    writeAudit(client, {
      action: AuditActions.RATE_LIMIT_EXCEEDED,
      entityType: 'request',
      actorUserId: req.actor!.userId,
      actorRole: role,
      actorIp: req.clientIp ?? null,
      requestId: req.requestId ?? null,
      metadata: { rule: outcome.rule.name, hits: outcome.hits, path: req.path },
    }),
  ).catch(() => {
    /* auditing a 429 must never turn it into a 500 */
  });
  throw toError(outcome);
}

export function buildQueueRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /bookings/:bookingCode/queue
  //
  // Three path segments, so it cannot collide with /bookings/me (two) or
  // /bookings/:bookingCode (two). Asserted by test.
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/bookings/:bookingCode/queue`,
    auth: { kind: 'permission', permission: 'queue.read.own' },
    csrf: false,
    summary: 'Live queue position and ETA for one of the farmer’s own bookings.',
  });
  router.get(
    '/bookings/:bookingCode/queue',
    requirePermission('queue.read.own'),
    asyncHandler(async (req, res) => {
      const code = parse(BookingCodeSchema, req.params.bookingCode);
      await limit(req, RateLimits.QUEUE_READ_PER_SESSION, 'FARMER');
      // Ownership is enforced inside the query; a foreign code yields 404.
      sendData(res, 200, await getOwnQueue(req.actor!.userId, code));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /officer/centres/:centreId/queue
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/officer/centres/:centreId/queue`,
    auth: { kind: 'permission', permission: 'queue.read.centre' },
    csrf: false,
    summary: 'Live per-lane queue for an assigned centre.',
  });
  router.get(
    '/officer/centres/:centreId/queue',
    requirePermission('queue.read.centre'),
    asyncHandler(async (req, res) => {
      const centreId = parse(CentreIdSchema, req.params.centreId);

      // An unassigned centre is NOT FOUND, never FORBIDDEN — the same rule
      // Phase 8 applies, so a refusal cannot confirm a centre exists.
      if (!actorMayActOnCentre(req.actor!, centreId)) throw notFound('Centre not found');

      await limit(req, RateLimits.OFFICER_QUEUE_PER_SESSION, 'OFFICER');

      // Defaults to TODAY IN THE CENTRE'S TIMEZONE, never the server's.
      const today = await todayAtCentre(centreId);
      if (!today) throw notFound('Centre not found');
      const date = req.query.date ? parse(DateSchema, req.query.date) : today;

      sendData(res, 200, await getCentreQueue(centreId, date));
    }),
  );

  return router;
}
