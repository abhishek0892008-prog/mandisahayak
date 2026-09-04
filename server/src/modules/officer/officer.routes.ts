/**
 * Officer operation routes, plus the two farmer-facing reads of what officers
 * recorded (kept here so the whole procurement surface is in one module).
 *
 * TWO CHECKS, ALWAYS BOTH:
 *   requirePermission(...)  — may this role do this kind of thing at all?
 *   centre scope            — may this actor do it to THIS booking?
 *
 * The scope is not a middleware, because it is not a property of the route: it
 * is a property of the row, and it is applied inside the SQL. What the route
 * layer does is decide the scope an actor carries.
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
import { localDateOf } from '../../engines/scheduling.ts';
import { MeasuredKgSchema, WeighedKgSchema } from '../../domain/quantity.ts';
import * as repo from './officer.repository.ts';
import type { OfficerCtx } from './officer.service.ts';
import {
  cancelAtCentre,
  centreOverview,
  completeProcurement,
  getBooking,
  getOwnPayment,
  getOwnProcurement,
  listDay,
  markNoShow,
  recordArrival,
  recordQuality,
  recordWeight,
  search,
  startWeighing,
  updatePaymentStatus,
} from './officer.service.ts';

const BASE = '/api/v1';

const BookingCodeSchema = z.string().regex(/^FQ-\d{4}-\d{7}$/, 'BOOKING_CODE_INVALID');
const ReasonSchema = z.object({ reason: z.string().trim().max(280).optional() });

const WeightSchema = z.object({ grossQuantityKg: WeighedKgSchema });

const QualitySchema = z.object({
  acceptedQuantityKg: MeasuredKgSchema,
  rejectedQuantityKg: MeasuredKgSchema,
  grade: z.string().trim().min(1).max(64).optional(),
  moisturePercent: z.number().min(0, 'MOISTURE_OUT_OF_RANGE').max(100, 'MOISTURE_OUT_OF_RANGE').optional(),
  rejectionReason: z.string().trim().min(1).max(280).optional(),
});

const PaymentSchema = z.object({
  status: z.enum(['PENDING', 'INITIATED', 'PAID', 'FAILED', 'ON_HOLD']),
  paymentReference: z.string().trim().min(1).max(120).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Request validation failed', fields);
  }
  return r.data;
}

/**
 * An ADMIN's authority does not come from an assignment, so their scope is
 * unrestricted (`null`). An officer carries exactly their assigned centres —
 * and an officer assigned to nowhere carries an empty list, which matches
 * nothing. That is the correct reading of "unassigned", not a special case.
 */
function ctxOf(req: Request): OfficerCtx {
  const actor = req.actor!;
  const isAdmin = actor.roles.includes('ADMIN');
  return {
    userId: actor.userId,
    ip: req.clientIp ?? null,
    requestId: req.requestId ?? null,
    scope: isAdmin ? null : actor.centreIds,
    role: isAdmin ? 'ADMIN' : 'OFFICER',
  };
}

export function buildOfficerRouter(): Router {
  const router = Router();

  const code = (req: Request) => parse(BookingCodeSchema, req.params.bookingCode);

  // -------------------------------------------------------------------------
  // GET /officer/centres/:centreId/bookings
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/officer/centres/:centreId/bookings`,
    auth: { kind: 'permission', permission: 'booking.read.centre' },
    csrf: false,
    summary: 'List one day of bookings at an assigned centre, in service order.',
  });
  router.get(
    '/officer/centres/:centreId/bookings',
    requirePermission('booking.read.centre'),
    asyncHandler(async (req, res) => {
      const centreId = parse(z.string().uuid('CENTRE_ID_INVALID'), req.params.centreId);

      // An unassigned centre is NOT FOUND, never FORBIDDEN: an officer at Agra
      // must not learn from the refusal that a centre exists at Mathura.
      if (!actorMayActOnCentre(req.actor!, centreId)) throw notFound('Centre not found');

      const timezone = await repo.centreTimezone(centreId);
      if (!timezone) throw notFound('Centre not found');

      const date = req.query.date
        ? parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID'), req.query.date)
        : localDateOf(new Date(), timezone);

      const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
      const statuses = statusParam
        ? statusParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        : null;

      sendData(res, 200, await listDay(centreId, date, statuses));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /officer/centres/:centreId/overview
  // -------------------------------------------------------------------------
  //
  // Everything the centre dashboard shows that is not a booking: the shift
  // hours for the day, the lane and slot configuration capacity comes from,
  // the crops this centre procures with their ACTIVE support price, and the
  // storage position.
  //
  // Storage is reported as NOT_AVAILABLE with a reason code rather than a
  // number. `storage_capacity` is empty by design (D-10 / 0006_storage.sql:
  // "No capacity figure is seeded by any migration"), and a dashboard that
  // printed 0 kg or invented a ceiling would be stating a fact nobody
  // published.
  declareRoute({
    method: 'GET',
    path: `${BASE}/officer/centres/:centreId/overview`,
    auth: { kind: 'permission', permission: 'booking.read.centre' },
    csrf: false,
    summary: 'Shift hours, lane/slot capacity, accepted crops with MSP, and storage position.',
  });
  router.get(
    '/officer/centres/:centreId/overview',
    requirePermission('booking.read.centre'),
    asyncHandler(async (req, res) => {
      const centreId = parse(z.string().uuid('CENTRE_ID_INVALID'), req.params.centreId);

      if (!actorMayActOnCentre(req.actor!, centreId)) throw notFound('Centre not found');

      const timezone = await repo.centreTimezone(centreId);
      if (!timezone) throw notFound('Centre not found');

      const date = req.query.date
        ? parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID'), req.query.date)
        : localDateOf(new Date(), timezone);

      sendData(res, 200, await centreOverview(centreId, date, timezone));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /officer/bookings/search
  //
  // Declared BEFORE /officer/bookings/:bookingCode so "search" is never parsed
  // as a booking code.
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/officer/bookings/search`,
    auth: { kind: 'permission', permission: 'booking.search.centre' },
    csrf: false,
    summary: 'Find bookings at assigned centres by code, token or phone.',
  });
  router.get(
    '/officer/bookings/search',
    requirePermission('booking.search.centre'),
    asyncHandler(async (req, res) => {
      const q = parse(z.string().trim().min(1).max(40), req.query.q);

      const limited = await consumeAll([
        { rule: RateLimits.OFFICER_SEARCH_PER_SESSION, subject: req.actor!.sessionId },
      ]);
      if (limited) {
        await withTransaction((client) =>
          writeAudit(client, {
            action: AuditActions.RATE_LIMIT_EXCEEDED,
            entityType: 'request',
            actorUserId: req.actor!.userId,
            actorRole: 'OFFICER',
            actorIp: req.clientIp ?? null,
            requestId: req.requestId ?? null,
            metadata: { rule: limited.rule.name, hits: limited.hits, path: req.path },
          }),
        ).catch(() => {});
        throw toError(limited);
      }

      sendData(res, 200, await search(q, ctxOf(req)));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /officer/bookings/:bookingCode
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/officer/bookings/:bookingCode`,
    auth: { kind: 'permission', permission: 'booking.read.centre' },
    csrf: false,
    summary: 'Read one booking with its procurement and payment record.',
  });
  router.get(
    '/officer/bookings/:bookingCode',
    requirePermission('booking.read.centre'),
    asyncHandler(async (req, res) => {
      sendData(res, 200, await getBooking(code(req), ctxOf(req)));
    }),
  );

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------
  const transition = (
    path: string,
    permission: string,
    summary: string,
    handler: (req: Request) => Promise<unknown>,
  ) => {
    declareRoute({
      method: 'POST',
      path: `${BASE}/officer/bookings/:bookingCode/${path}`,
      auth: { kind: 'permission', permission },
      csrf: true,
      summary,
    });
    router.post(
      `/officer/bookings/:bookingCode/${path}`,
      requirePermission(permission),
      asyncHandler(async (req, res) => {
        sendData(res, 200, await handler(req));
      }),
    );
  };

  transition('arrive', 'booking.advance_state', 'Record the farmer arriving at the centre.', (req) =>
    recordArrival(code(req), ctxOf(req)),
  );

  transition('no-show', 'booking.mark_no_show', 'Record that the farmer did not arrive.', (req) => {
    const body = parse(ReasonSchema, req.body ?? {});
    return markNoShow(code(req), body.reason ?? null, ctxOf(req));
  });

  transition('weighing', 'booking.advance_state', 'Begin weighing.', (req) =>
    startWeighing(code(req), ctxOf(req)),
  );

  transition('weight', 'procurement.record_weight', 'Record the gross weight.', (req) => {
    const body = parse(WeightSchema, req.body);
    return recordWeight(code(req), body.grossQuantityKg, ctxOf(req));
  });

  transition('quality', 'procurement.record_quality', 'Record the quality assessment.', (req) => {
    const body = parse(QualitySchema, req.body);
    return recordQuality(
      code(req),
      {
        acceptedKg: body.acceptedQuantityKg,
        rejectedKg: body.rejectedQuantityKg,
        grade: body.grade ?? null,
        moisturePercent: body.moisturePercent ?? null,
        rejectionReason: body.rejectionReason ?? null,
      },
      ctxOf(req),
    );
  });

  transition(
    'complete',
    'procurement.complete',
    'Close the procurement and compute the MSP entitlement.',
    (req) => completeProcurement(code(req), ctxOf(req)),
  );

  transition('cancel', 'booking.advance_state', 'Cancel a booking at the centre.', (req) => {
    const body = parse(ReasonSchema, req.body ?? {});
    return cancelAtCentre(code(req), body.reason ?? null, ctxOf(req));
  });

  transition('payment', 'payment.update_status', 'Update the payment status.', (req) => {
    const body = parse(PaymentSchema, req.body);
    return updatePaymentStatus(
      code(req),
      body.status,
      body.paymentReference ?? null,
      ctxOf(req),
    );
  });

  // -------------------------------------------------------------------------
  // Farmer reads. Ownership is resolved in the query, exactly as in Phase 7.
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/bookings/:bookingCode/procurement`,
    auth: { kind: 'permission', permission: 'procurement.read.own' },
    csrf: false,
    summary: 'Read the procurement record for one of the farmer’s own bookings.',
  });
  router.get(
    '/bookings/:bookingCode/procurement',
    requirePermission('procurement.read.own'),
    asyncHandler(async (req, res) => {
      sendData(res, 200, await getOwnProcurement(req.actor!.userId, code(req)));
    }),
  );

  declareRoute({
    method: 'GET',
    path: `${BASE}/bookings/:bookingCode/payment`,
    auth: { kind: 'permission', permission: 'payment.read.own' },
    csrf: false,
    summary: 'Read the payment record for one of the farmer’s own bookings.',
  });
  router.get(
    '/bookings/:bookingCode/payment',
    requirePermission('payment.read.own'),
    asyncHandler(async (req, res) => {
      sendData(res, 200, await getOwnPayment(req.actor!.userId, code(req)));
    }),
  );

  return router;
}
