/**
 * Booking routes.
 *
 * Farmer identity always comes from the session. There is no farmerId in any
 * request shape below — not ignored, absent.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler, sendData } from '../../core/http.ts';
import { badRequest, ErrorCodes } from '../../core/errors.ts';
import { declareRoute, requirePermission } from '../../core/rbac.ts';
import { consumeAll, RateLimits, toError } from '../../core/rateLimit.ts';
import { withTransaction } from '../../core/db.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import { QuantityKgSchema } from '../../domain/quantity.ts';
import {
  cancelBooking,
  candidateToView,
  createBooking,
  findAvailability,
  getMyBooking,
  hashRequest,
  listMyBookings,
} from './bookings.service.ts';

const BASE = '/api/v1';

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID')
  .optional();

const AvailabilitySchema = z.object({
  centreId: z.string().uuid('CENTRE_ID_INVALID'),
  cropId: z.string().uuid('CROP_ID_INVALID'),
  quantityKg: QuantityKgSchema,
  fromDate: DateSchema,
});

const CreateSchema = z.object({
  centreId: z.string().uuid('CENTRE_ID_INVALID'),
  cropId: z.string().uuid('CROP_ID_INVALID'),
  quantityKg: QuantityKgSchema,
  preferredDate: DateSchema,
});

const CancelSchema = z.object({
  reason: z.string().trim().max(280).optional(),
});

const BookingCodeSchema = z.string().regex(/^FQ-\d{4}-\d{7}$/, 'BOOKING_CODE_INVALID');

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Request validation failed', fields);
  }
  return r.data;
}

function ctxOf(req: Request) {
  return {
    ip: req.clientIp ?? null,
    requestId: req.requestId ?? null,
    userId: req.actor!.userId,
  };
}

async function rejectRateLimited(
  req: Request,
  outcome: NonNullable<Awaited<ReturnType<typeof consumeAll>>>,
) {
  await withTransaction((client) =>
    writeAudit(client, {
      action: AuditActions.RATE_LIMIT_EXCEEDED,
      entityType: 'request',
      actorUserId: req.actor?.userId ?? null,
      actorRole: 'FARMER',
      actorIp: req.clientIp ?? null,
      requestId: req.requestId ?? null,
      metadata: { rule: outcome.rule.name, hits: outcome.hits, path: req.path },
    }),
  ).catch(() => {});
  return toError(outcome);
}

export function buildBookingsRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /bookings/availability
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'POST',
    path: `${BASE}/bookings/availability`,
    auth: { kind: 'permission', permission: 'slot.query' },
    csrf: true,
    summary: 'Find the earliest bookable window for a crop and quantity.',
  });
  router.post(
    '/bookings/availability',
    requirePermission('slot.query'),
    asyncHandler(async (req, res) => {
      const input = parse(AvailabilitySchema, req.body);

      const limited = await consumeAll([
        { rule: RateLimits.AVAILABILITY_PER_SESSION, subject: req.actor!.sessionId },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const { centre, crop, result, duration, storageCheck } = await findAvailability({
        centreId: input.centreId,
        cropId: input.cropId,
        quantityKg: input.quantityKg,
        fromDate: input.fromDate,
      });

      sendData(res, 200, {
        centre: {
          code: centre.code,
          name: centre.name,
          district: centre.districtName,
          timezone: centre.timezone,
          laneCount: centre.lanes.length,
          dataType: centre.dataType,
        },
        crop: { name: crop.cropName, season: crop.seasonCode, marketingYear: crop.marketingYear },
        quantityKg: input.quantityKg,
        duration,
        available: result.found,
        window: result.found ? candidateToView(result.candidate, centre) : null,
        reasonCode: result.found ? null : result.reason,
        horizonDays: centre.config.bookingHorizonDays,
        storageCheck,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /bookings   (Idempotency-Key required)
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'POST',
    path: `${BASE}/bookings`,
    auth: { kind: 'permission', permission: 'booking.create.own' },
    csrf: true,
    summary: 'Reserve the earliest available window. Idempotent.',
  });
  router.post(
    '/bookings',
    requirePermission('booking.create.own'),
    asyncHandler(async (req, res) => {
      const input = parse(CreateSchema, req.body);

      const key = req.header('idempotency-key');
      if (!key || key.trim().length < 8 || key.length > 200) {
        throw badRequest(
          ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
          'An Idempotency-Key header of 8-200 characters is required',
        );
      }

      const limited = await consumeAll([
        { rule: RateLimits.BOOKING_CREATE_PER_FARMER, subject: req.actor!.userId },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const result = await createBooking(
        {
          centreId: input.centreId,
          cropId: input.cropId,
          quantityKg: input.quantityKg,
          preferredDate: input.preferredDate,
          idempotencyKey: key.trim(),
          requestHash: hashRequest(input),
        },
        ctxOf(req),
      );

      res.status(result.status).json(result.body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /bookings/me
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/bookings/me`,
    auth: { kind: 'permission', permission: 'booking.read.own' },
    csrf: false,
    summary: 'List the authenticated farmer’s own bookings.',
  });
  router.get(
    '/bookings/me',
    requirePermission('booking.read.own'),
    asyncHandler(async (req, res) => {
      const includeInactive = String(req.query.includeInactive ?? '') === 'true';
      sendData(res, 200, await listMyBookings(req.actor!.userId, includeInactive));
    }),
  );

  // -------------------------------------------------------------------------
  // GET /bookings/:bookingCode
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/bookings/:bookingCode`,
    auth: { kind: 'permission', permission: 'booking.read.own' },
    csrf: false,
    summary: 'Fetch one of the authenticated farmer’s own bookings by code.',
  });
  router.get(
    '/bookings/:bookingCode',
    requirePermission('booking.read.own'),
    asyncHandler(async (req, res) => {
      const code = parse(BookingCodeSchema, req.params.bookingCode);
      // Ownership is part of the query; another farmer's code yields 404.
      sendData(res, 200, await getMyBooking(req.actor!.userId, code));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /bookings/:bookingCode/cancel
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'POST',
    path: `${BASE}/bookings/:bookingCode/cancel`,
    auth: { kind: 'permission', permission: 'booking.cancel.own' },
    csrf: true,
    summary: 'Cancel one of the authenticated farmer’s own bookings.',
  });
  router.post(
    '/bookings/:bookingCode/cancel',
    requirePermission('booking.cancel.own'),
    asyncHandler(async (req, res) => {
      const code = parse(BookingCodeSchema, req.params.bookingCode);
      const body = parse(CancelSchema, req.body ?? {});
      sendData(
        res,
        200,
        await cancelBooking(req.actor!.userId, code, body.reason ?? null, ctxOf(req)),
      );
    }),
  );

  return router;
}
