/**
 * Farmer notification routes (Phase 10).
 *
 * Identity always comes from the session. There is no farmerId or userId in any
 * request shape below — not ignored, absent. Ownership is resolved inside the
 * SQL, so another farmer's notification id matches no row and yields 404,
 * indistinguishable from one that does not exist.
 *
 * Permissions `notification.read.own` and `notification.update.own` already
 * exist and are already granted to FARMER. Phase 10 adds no permission and
 * changes no grant, so officers and admins receive 403 here.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler, sendData } from '../../core/http.ts';
import { badRequest, notFound, ErrorCodes } from '../../core/errors.ts';
import { declareRoute, requirePermission } from '../../core/rbac.ts';
import { consumeAll, RateLimits, toError } from '../../core/rateLimit.ts';
import { withTransaction } from '../../core/db.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import {
  getPreferences,
  listMine,
  markAllRead,
  markRead,
  unreadCount,
  updatePreference,
} from './notifications.service.ts';

const BASE = '/api/v1';

const IdSchema = z.string().uuid('NOTIFICATION_ID_INVALID');
const LimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const PreferenceSchema = z.object({
  channel: z.enum(['SMS', 'IN_APP']),
  /** Omitted or null = a channel-wide preference. */
  event: z
    .enum([
      'BOOKING_CONFIRMED',
      'BOOKING_ARRIVED',
      'BOOKING_CANCELLED',
      'ONE_DAY_REMINDER',
      'QUEUE_APPROACHING',
      'TURN_APPROACHING',
      'PROCUREMENT_COMPLETED',
      'PAYMENT_UPDATED',
      'PAYMENT_BLOCKED',
      'NO_SHOW_RECORDED',
    ])
    .nullable()
    .optional(),
  enabled: z.boolean(),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Request validation failed', fields);
  }
  return r.data;
}

/** Rate-limit rejections stay audited; successful reads do not (Phase 9 rule). */
async function limit(req: Request) {
  const outcome = await consumeAll([
    { rule: RateLimits.NOTIFICATION_READ_PER_SESSION, subject: req.actor!.sessionId },
  ]);
  if (!outcome) return;
  await withTransaction((client) =>
    writeAudit(client, {
      action: AuditActions.RATE_LIMIT_EXCEEDED,
      entityType: 'request',
      actorUserId: req.actor!.userId,
      actorRole: 'FARMER',
      actorIp: req.clientIp ?? null,
      requestId: req.requestId ?? null,
      metadata: { rule: outcome.rule.name, hits: outcome.hits, path: req.path },
    }),
  ).catch(() => {});
  throw toError(outcome);
}

export function buildNotificationsRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /notifications
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/notifications`,
    auth: { kind: 'permission', permission: 'notification.read.own' },
    csrf: false,
    summary: 'List the authenticated farmer’s own notifications.',
  });
  router.get(
    '/notifications',
    requirePermission('notification.read.own'),
    asyncHandler(async (req, res) => {
      await limit(req);
      const unreadOnly = String(req.query.unread ?? '') === 'true';
      const lim = parse(LimitSchema, req.query.limit ?? 50);
      sendData(res, 200, await listMine(req.actor!.userId, { unreadOnly, limit: lim }));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /notifications/unread-count
  //
  // Declared before any parameterised GET so "unread-count" is never read as an
  // id. (The mark-read route is POST, so there is no method collision either.)
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/notifications/unread-count`,
    auth: { kind: 'permission', permission: 'notification.read.own' },
    csrf: false,
    summary: 'Count the authenticated farmer’s unread notifications.',
  });
  router.get(
    '/notifications/unread-count',
    requirePermission('notification.read.own'),
    asyncHandler(async (req, res) => {
      await limit(req);
      sendData(res, 200, await unreadCount(req.actor!.userId));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /notifications/preferences
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/notifications/preferences`,
    auth: { kind: 'permission', permission: 'notification.read.own' },
    csrf: false,
    summary: 'Read the authenticated farmer’s own notification preferences.',
  });
  router.get(
    '/notifications/preferences',
    requirePermission('notification.read.own'),
    asyncHandler(async (req, res) => {
      sendData(res, 200, await getPreferences(req.actor!.userId));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /notifications/preferences
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'PUT',
    path: `${BASE}/notifications/preferences`,
    auth: { kind: 'permission', permission: 'notification.update.own' },
    csrf: true,
    summary: 'Set one of the authenticated farmer’s own notification preferences.',
  });
  router.put(
    '/notifications/preferences',
    requirePermission('notification.update.own'),
    asyncHandler(async (req, res) => {
      const body = parse(PreferenceSchema, req.body);
      // The user id comes from the session. There is no field to override it.
      sendData(
        res,
        200,
        await updatePreference(req.actor!.userId, body.channel, body.event ?? null, body.enabled),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // POST /notifications/read-all
  //
  // Two segments; the per-id route is three. No collision.
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'POST',
    path: `${BASE}/notifications/read-all`,
    auth: { kind: 'permission', permission: 'notification.update.own' },
    csrf: true,
    summary: 'Mark all of the authenticated farmer’s notifications read.',
  });
  router.post(
    '/notifications/read-all',
    requirePermission('notification.update.own'),
    asyncHandler(async (req, res) => {
      sendData(res, 200, await markAllRead(req.actor!.userId));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /notifications/:id/read
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'POST',
    path: `${BASE}/notifications/:id/read`,
    auth: { kind: 'permission', permission: 'notification.update.own' },
    csrf: true,
    summary: 'Mark one of the authenticated farmer’s notifications read.',
  });
  router.post(
    '/notifications/:id/read',
    requirePermission('notification.update.own'),
    asyncHandler(async (req, res) => {
      const id = parse(IdSchema, req.params.id);
      // Ownership is in the UPDATE predicate: another farmer's id modifies
      // nothing and is reported as 404, never 403.
      const result = await markRead(req.actor!.userId, id);
      if (!result) throw notFound('Notification not found');
      sendData(res, 200, result);
    }),
  );

  return router;
}
