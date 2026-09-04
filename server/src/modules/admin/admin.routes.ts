/**
 * Admin configuration routes (Phase 13) and officer provisioning (Phase 14).
 *
 * EVERY route here is ADMIN-only by permission, and the permissions used
 * (`centre.create`, `centre.update`, `centre.configure`, `officer.assign_centre`)
 * are granted to ADMIN and to nobody else. An officer holds none of them, so an
 * officer cannot configure the centre they work at — which is the point:
 * operating a centre and defining how it operates are different authorities
 * (architecture §5.4).
 *
 * Every mutation is audited in the same transaction that makes it (P-9).
 *
 * NOTHING HERE CAN CREATE OFFICIAL DATA. `data_type` is hardcoded to CONFIGURED
 * in the repository and is not a request field.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler, sendData } from '../../core/http.ts';
import { badRequest, conflict, notFound, ErrorCodes } from '../../core/errors.ts';
import { declareRoute, requirePermission } from '../../core/rbac.ts';
import { withTransaction } from '../../core/db.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import { query } from '../../core/db.ts';
import { hashPassword } from '../../core/crypto.ts';
import { FullNameSchema, PhoneSchema } from '../auth/auth.schemas.ts';
import * as repo from './admin.repository.ts';

const BASE = '/api/v1';

const Uuid = z.string().uuid('ID_INVALID');
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID');
const TimeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'TIME_INVALID');

const CreateCentreSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9-]{4,40}$/, 'CODE_INVALID'),
  name: z.string().trim().min(3).max(200),
  districtId: Uuid,
  timezone: z.string().trim().min(3).max(64).default('Asia/Kolkata'),
  address: z.string().trim().max(300).nullable().optional(),
});

const UpdateCentreSchema = z.object({
  name: z.string().trim().min(3).max(200).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
});

const LaneSchema = z.object({
  laneNo: z.number().int().min(1).max(50),
  name: z.string().trim().max(80).nullable().optional(),
  isActive: z.boolean(),
});

const HoursSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  opensAt: TimeStr.nullable(),
  closesAt: TimeStr.nullable(),
  effectiveFrom: DateStr,
});

const HolidaySchema = z.object({
  date: DateStr,
  reason: z.string().trim().max(200).nullable().optional(),
});

const CropSchema = z.object({
  cropId: Uuid,
  seasonId: Uuid,
  marketingYear: z.string().trim().regex(/^\d{4}-\d{2}$/, 'MARKETING_YEAR_INVALID'),
  isActive: z.boolean(),
  effectiveFrom: DateStr,
});

const SlotConfigSchema = z.object({
  referenceQuantityKg: z.number().int().positive(),
  referenceProcessingMinutes: z.number().int().positive(),
  minimumProcessingMinutes: z.number().int().positive(),
  maximumProcessingMinutes: z.number().int().positive(),
  transitionBufferMinutes: z.number().int().min(0),
  slotGranularityMinutes: z.number().int().positive(),
  bookingHorizonDays: z.number().int().positive(),
  cancellationCutoffHours: z.number().int().min(0),
  effectiveFrom: DateStr,
});

const AssignSchema = z.object({
  employeeCode: z.string().trim().min(1).max(64),
});

/** Mirrors the `users_username_format` CHECK exactly, so the database is never
 *  the thing that rejects a username the API accepted. */
const UsernameSchema = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .refine((v) => /^[a-z0-9._-]{3,64}$/.test(v), 'USERNAME_INVALID');

const EmployeeCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,64}$/, 'EMPLOYEE_CODE_INVALID');

/**
 * The INITIAL staff password.
 *
 * Deliberately stricter than `StaffLoginSchema.password`, which must accept
 * whatever an existing account already has. Account creation is the one moment
 * the system can insist on a floor, so it does. Staff also carry an OTP second
 * factor (D-3), so this is a length rule with a character-class floor rather
 * than a composition maze that pushes officers towards writing it down.
 */
const InitialPasswordSchema = z
  .string()
  .min(12, 'PASSWORD_TOO_SHORT')
  .max(512, 'PASSWORD_TOO_LONG')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), 'PASSWORD_TOO_WEAK');

const CreateOfficerSchema = z.object({
  fullName: FullNameSchema,
  username: UsernameSchema,
  password: InitialPasswordSchema,
  phone: PhoneSchema,
  employeeCode: EmployeeCodeSchema,
  designation: z.string().trim().min(1).max(120).nullable().optional(),
});

const DeactivateSchema = z.object({
  reason: z.string().trim().min(1).max(280).optional(),
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

function ctx(req: Request) {
  return {
    userId: req.actor!.userId,
    ip: req.clientIp ?? null,
    requestId: req.requestId ?? null,
  };
}

async function auditConfig(
  client: Parameters<typeof writeAudit>[0],
  req: Request,
  action: (typeof AuditActions)[keyof typeof AuditActions],
  entityId: string | null,
  before: unknown,
  after: unknown,
) {
  const c = ctx(req);
  await writeAudit(client, {
    action,
    entityType: 'centre_configuration',
    entityId,
    actorUserId: c.userId,
    actorRole: 'ADMIN',
    actorIp: c.ip,
    requestId: c.requestId,
    before,
    after,
  });
}

async function auditOfficer(
  client: Parameters<typeof writeAudit>[0],
  req: Request,
  action: (typeof AuditActions)[keyof typeof AuditActions],
  officerId: string,
  before: unknown,
  after: unknown,
) {
  const c = ctx(req);
  await writeAudit(client, {
    action,
    entityType: 'officer',
    entityId: officerId,
    actorUserId: c.userId,
    actorRole: 'ADMIN',
    actorIp: c.ip,
    requestId: c.requestId,
    before,
    after,
  });
}

/** Resolves a centre or 404s. Admin scope is global, so no assignment check. */
async function requireCentre(centreId: string) {
  const centre = await repo.findCentre(centreId);
  if (!centre) throw notFound('Centre not found');
  return centre;
}

export function buildAdminRouter(): Router {
  const router = Router();

  const declare = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    permission: string,
    summary: string,
  ) => {
    declareRoute({
      method,
      path: `${BASE}${path}`,
      auth: { kind: 'permission', permission },
      csrf: method !== 'GET',
      summary,
    });
  };

  // ---- Centres -------------------------------------------------------------
  declare('GET', '/admin/centres', 'centre.update', 'List all procurement centres.');
  router.get(
    '/admin/centres',
    requirePermission('centre.update'),
    asyncHandler(async (req, res) => {
      const includeInactive = String(req.query.includeInactive ?? '') === 'true';
      const rows = await repo.listCentres(includeInactive);
      sendData(res, 200, {
        count: rows.length,
        centres: rows.map((c) => ({
          centreId: c.id,
          code: c.code,
          name: c.name,
          district: c.district_name,
          status: c.status,
          timezone: c.timezone,
          laneCount: c.lane_count,
          // Surfaced deliberately: an operator must be able to see that a
          // centre is demonstration data, not an official government facility.
          dataType: c.data_type,
          storageCheckMode: c.storage_check_mode,
        })),
      });
    }),
  );

  declare('POST', '/admin/centres', 'centre.create', 'Create a CONFIGURED procurement centre.');
  router.post(
    '/admin/centres',
    requirePermission('centre.create'),
    asyncHandler(async (req, res) => {
      const input = parse(CreateCentreSchema, req.body);
      const result = await withTransaction(async (client) => {
        if (await repo.centreCodeExists(client, input.code)) {
          throw conflict(ErrorCodes.CENTRE_CODE_TAKEN, 'A centre with that code already exists');
        }
        let id: string;
        try {
          id = await repo.createCentre(client, {
            code: input.code,
            name: input.name,
            districtId: input.districtId,
            timezone: input.timezone,
            address: input.address ?? null,
          });
        } catch (e) {
          if (e instanceof Error && e.message === 'DISTRICT_NOT_FOUND') {
            throw badRequest(ErrorCodes.DISTRICT_NOT_FOUND, 'District not found');
          }
          throw e;
        }
        await auditConfig(client, req, AuditActions.CENTRE_CREATED, id, null, {
          code: input.code,
          name: input.name,
          dataType: 'CONFIGURED',
        });
        return id;
      });
      sendData(res, 201, {
        centreId: result,
        code: input.code,
        dataType: 'CONFIGURED',
        note: 'Created as CONFIGURED demonstration data. It is not an official government centre.',
      });
    }),
  );

  declare('PATCH', '/admin/centres/:centreId', 'centre.update', 'Update a centre.');
  router.patch(
    '/admin/centres/:centreId',
    requirePermission('centre.update'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const patch = parse(UpdateCentreSchema, req.body);
      const before = await requireCentre(centreId);

      await withTransaction(async (client) => {
        // Taking a centre out of service while farmers hold bookings there
        // would strand them. Refuse rather than orphan.
        if (patch.status === 'INACTIVE') {
          const active = await repo.activeBookingCount(client, centreId);
          if (active > 0) {
            throw conflict(
              ErrorCodes.CENTRE_HAS_ACTIVE_BOOKINGS,
              'The centre still has active bookings and cannot be deactivated',
              { activeBookings: active },
            );
          }
        }
        await repo.updateCentre(client, centreId, patch);
        await auditConfig(
          client,
          req,
          AuditActions.CENTRE_UPDATED,
          centreId,
          { name: before.name, status: before.status },
          patch,
        );
      });
      sendData(res, 200, { centreId, updated: true });
    }),
  );

  // ---- Lanes ---------------------------------------------------------------
  declare('GET', '/admin/centres/:centreId/lanes', 'centre.configure', 'List service lanes.');
  router.get(
    '/admin/centres/:centreId/lanes',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      await requireCentre(centreId);
      const lanes = await repo.listLanes(centreId);
      sendData(res, 200, { centreId, lanes });
    }),
  );

  declare('PUT', '/admin/centres/:centreId/lanes', 'centre.configure', 'Add or update a lane.');
  router.put(
    '/admin/centres/:centreId/lanes',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const input = parse(LaneSchema, req.body);
      await requireCentre(centreId);

      await withTransaction(async (client) => {
        if (!input.isActive) {
          const held = await repo.activeBookingsOnLane(client, centreId, input.laneNo);
          if (held > 0) {
            throw conflict(
              ErrorCodes.LANE_HAS_ACTIVE_BOOKINGS,
              'The lane still holds active bookings and cannot be deactivated',
              { activeBookings: held },
            );
          }
        }
        await repo.upsertLane(client, centreId, input.laneNo, input.name ?? null, input.isActive);
        await auditConfig(client, req, AuditActions.CENTRE_LANE_CONFIGURED, centreId, null, input);
      });
      sendData(res, 200, { centreId, lane: input.laneNo, isActive: input.isActive });
    }),
  );

  // ---- Operating hours -----------------------------------------------------
  declare('GET', '/admin/centres/:centreId/hours', 'centre.configure', 'Read operating hours.');
  router.get(
    '/admin/centres/:centreId/hours',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      await requireCentre(centreId);
      const onDate = req.query.date ? parse(DateStr, req.query.date) : new Date().toISOString().slice(0, 10);
      sendData(res, 200, { centreId, onDate, hours: await repo.listHours(centreId, onDate) });
    }),
  );

  declare('PUT', '/admin/centres/:centreId/hours', 'centre.configure', 'Set hours for a weekday.');
  router.put(
    '/admin/centres/:centreId/hours',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const input = parse(HoursSchema, req.body);
      await requireCentre(centreId);

      const closing = input.opensAt === null || input.closesAt === null;
      if (!closing && input.opensAt! >= input.closesAt!) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Opening time must precede closing time', {
          opensAt: 'MUST_PRECEDE_CLOSES_AT',
        });
      }

      await withTransaction(async (client) => {
        if (closing) {
          // A weekday with no row IS the closed state — that is how Sunday is
          // already expressed. Closing means end-dating, not a magic value.
          await repo.closeWeekday(client, centreId, input.dayOfWeek, input.effectiveFrom);
        } else {
          await repo.setHours(
            client,
            centreId,
            input.dayOfWeek,
            input.opensAt!,
            input.closesAt!,
            input.effectiveFrom,
            req.actor!.userId,
          );
        }
        await auditConfig(client, req, AuditActions.CENTRE_HOURS_CONFIGURED, centreId, null, input);
      });
      sendData(res, 200, { centreId, dayOfWeek: input.dayOfWeek, closed: closing });
    }),
  );

  // ---- Holidays ------------------------------------------------------------
  declare('GET', '/admin/centres/:centreId/holidays', 'centre.configure', 'List holidays.');
  router.get(
    '/admin/centres/:centreId/holidays',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      await requireCentre(centreId);
      sendData(res, 200, { centreId, holidays: await repo.listHolidays(centreId) });
    }),
  );

  declare('POST', '/admin/centres/:centreId/holidays', 'centre.configure', 'Declare a holiday.');
  router.post(
    '/admin/centres/:centreId/holidays',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const input = parse(HolidaySchema, req.body);
      await requireCentre(centreId);

      const added = await withTransaction(async (client) => {
        const booked = await repo.bookingsOnDate(client, centreId, input.date);
        if (booked > 0) {
          throw conflict(
            ErrorCodes.DATE_HAS_ACTIVE_BOOKINGS,
            'Bookings already exist on that date; cancel them before declaring a holiday',
            { activeBookings: booked },
          );
        }
        const ok = await repo.addHoliday(
          client,
          centreId,
          input.date,
          input.reason ?? null,
          req.actor!.userId,
        );
        if (ok) {
          await auditConfig(client, req, AuditActions.CENTRE_HOLIDAY_SET, centreId, null, input);
        }
        return ok;
      });
      sendData(res, added ? 201 : 200, { centreId, date: input.date, added });
    }),
  );

  declare('DELETE', '/admin/centres/:centreId/holidays/:date', 'centre.configure', 'Remove a holiday.');
  router.delete(
    '/admin/centres/:centreId/holidays/:date',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const date = parse(DateStr, req.params.date);
      await requireCentre(centreId);
      const removed = await withTransaction(async (client) => {
        const ok = await repo.removeHoliday(client, centreId, date);
        if (ok) {
          await auditConfig(client, req, AuditActions.CENTRE_HOLIDAY_SET, centreId, { date }, null);
        }
        return ok;
      });
      if (!removed) throw notFound('Holiday not found');
      sendData(res, 200, { centreId, date, removed: true });
    }),
  );

  // ---- Crop eligibility ----------------------------------------------------
  declare('GET', '/admin/centres/:centreId/crops', 'centre.configure', 'List crop eligibility.');
  router.get(
    '/admin/centres/:centreId/crops',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      await requireCentre(centreId);
      sendData(res, 200, { centreId, crops: await repo.listCropConfig(centreId) });
    }),
  );

  declare('PUT', '/admin/centres/:centreId/crops', 'centre.configure', 'Set crop eligibility.');
  router.put(
    '/admin/centres/:centreId/crops',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const input = parse(CropSchema, req.body);
      await requireCentre(centreId);

      await withTransaction(async (client) => {
        await repo.setCropEligibility(
          client,
          centreId,
          input.cropId,
          input.seasonId,
          input.marketingYear,
          input.isActive,
          input.effectiveFrom,
          req.actor!.userId,
        );
        await auditConfig(client, req, AuditActions.CENTRE_CROP_CONFIGURED, centreId, null, input);
      });
      sendData(res, 200, { centreId, configured: true });
    }),
  );

  // ---- Slot configuration --------------------------------------------------
  declare('GET', '/admin/centres/:centreId/slot-config', 'centre.configure', 'Read slot configuration.');
  router.get(
    '/admin/centres/:centreId/slot-config',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      await requireCentre(centreId);
      const onDate = req.query.date ? parse(DateStr, req.query.date) : new Date().toISOString().slice(0, 10);
      sendData(res, 200, { centreId, onDate, slotConfig: await repo.currentSlotConfig(centreId, onDate) });
    }),
  );

  declare('PUT', '/admin/centres/:centreId/slot-config', 'centre.configure', 'Set slot configuration.');
  router.put(
    '/admin/centres/:centreId/slot-config',
    requirePermission('centre.configure'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const input = parse(SlotConfigSchema, req.body);
      await requireCentre(centreId);

      if (input.maximumProcessingMinutes < input.minimumProcessingMinutes) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Maximum must not be below minimum', {
          maximumProcessingMinutes: 'BELOW_MINIMUM',
        });
      }

      await withTransaction(async (client) => {
        await repo.setSlotConfig(client, centreId, input, input.effectiveFrom, req.actor!.userId);
        await auditConfig(client, req, AuditActions.CENTRE_SLOT_CONFIGURED, centreId, null, input);
      });
      sendData(res, 200, { centreId, effectiveFrom: input.effectiveFrom });
    }),
  );

  // ---- Officer assignments -------------------------------------------------
  declare('GET', '/admin/centres/:centreId/officers', 'officer.assign_centre', 'List assignments.');
  router.get(
    '/admin/centres/:centreId/officers',
    requirePermission('officer.assign_centre'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      await requireCentre(centreId);
      const rows = await repo.listAssignments(centreId);
      sendData(res, 200, {
        centreId,
        assignments: rows.map((r) => ({
          name: r.full_name,
          employeeCode: r.employee_code,
          officerStatus: r.officer_status,
          assignedAt: (r.assigned_at as Date).toISOString(),
          revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
          active: r.revoked_at === null,
        })),
      });
    }),
  );

  declare('POST', '/admin/centres/:centreId/officers', 'officer.assign_centre', 'Assign an officer.');
  router.post(
    '/admin/centres/:centreId/officers',
    requirePermission('officer.assign_centre'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const input = parse(AssignSchema, req.body);
      await requireCentre(centreId);

      const assigned = await withTransaction(async (client) => {
        const officer = await repo.officerByEmployeeCode(client, input.employeeCode);
        if (!officer) throw notFound('Officer not found');
        if (officer.status !== 'ACTIVE') {
          throw conflict(ErrorCodes.OFFICER_INACTIVE, 'That officer is not active');
        }
        const ok = await repo.assignOfficer(client, officer.id, centreId, req.actor!.userId);
        if (ok) {
          await auditConfig(client, req, AuditActions.OFFICER_ASSIGNED, centreId, null, {
            employeeCode: input.employeeCode,
          });
        }
        return ok;
      });
      sendData(res, assigned ? 201 : 200, {
        centreId,
        employeeCode: input.employeeCode,
        assigned,
      });
    }),
  );

  declare(
    'DELETE',
    '/admin/centres/:centreId/officers/:employeeCode',
    'officer.assign_centre',
    'Revoke an assignment.',
  );
  router.delete(
    '/admin/centres/:centreId/officers/:employeeCode',
    requirePermission('officer.assign_centre'),
    asyncHandler(async (req, res) => {
      const centreId = parse(Uuid, req.params.centreId);
      const employeeCode = parse(z.string().trim().min(1).max(64), req.params.employeeCode);
      await requireCentre(centreId);

      const revoked = await withTransaction(async (client) => {
        const officer = await repo.officerByEmployeeCode(client, employeeCode);
        if (!officer) throw notFound('Officer not found');
        const ok = await repo.revokeAssignment(client, officer.id, centreId, req.actor!.userId);
        if (ok) {
          await auditConfig(
            client,
            req,
            AuditActions.OFFICER_ASSIGNMENT_REVOKED,
            centreId,
            { employeeCode },
            null,
          );
        }
        return ok;
      });
      if (!revoked) throw notFound('Active assignment not found');
      sendData(res, 200, { centreId, employeeCode, revoked: true });
    }),
  );

  // ---- Officer provisioning (Phase 14) -------------------------------------
  //
  // Officers are created by an administrator; there is no staff self-service
  // registration (assumption A-4). Until now the only way to obtain an officer
  // account was to write to the database by hand, which meant the one role that
  // operates the system could not be provisioned by the system.
  //
  // The reads below are gated on `officer.create` rather than a read-only
  // permission because no `officer.read` exists in the vocabulary, and inventing
  // one would widen the grant matrix that architecture 5.3 fixes. `GET
  // /admin/centres` already sets the precedent of gating an administrative read
  // on the matching mutation permission. Both are ADMIN-only either way.

  declare('GET', '/admin/officers', 'officer.create', 'List officer accounts.');
  router.get(
    '/admin/officers',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const includeInactive = String(req.query.includeInactive ?? '') === 'true';
      const rows = await repo.listOfficers(includeInactive);
      sendData(res, 200, {
        count: rows.length,
        officers: rows.map((o) => ({
          employeeCode: o.employee_code,
          fullName: o.full_name,
          username: o.username,
          designation: o.designation,
          status: o.status,
          // The officer row and the login it hangs off are separate records.
          // Showing both makes a half-applied deactivation visible instead of
          // leaving an officer who reads as INACTIVE but can still sign in.
          loginStatus: o.user_status,
          activeAssignments: o.active_assignments,
          deactivatedAt: o.deactivated_at ? (o.deactivated_at as Date).toISOString() : null,
        })),
      });
    }),
  );

  declare('POST', '/admin/officers', 'officer.create', 'Create an officer account.');
  router.post(
    '/admin/officers',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const input = parse(CreateOfficerSchema, req.body);

      await withTransaction(async (client) => {
        // Checked separately so the caller is told WHICH identifier collided.
        // A unique violation caught from the insert could not distinguish them.
        if (await repo.usernameTaken(client, input.username)) {
          throw conflict(ErrorCodes.USERNAME_TAKEN, 'That username is already in use');
        }
        if (await repo.phoneTaken(client, input.phone)) {
          throw conflict(
            ErrorCodes.PHONE_ALREADY_REGISTERED,
            'That phone number already belongs to an account',
          );
        }
        if (await repo.employeeCodeTaken(client, input.employeeCode)) {
          throw conflict(ErrorCodes.EMPLOYEE_CODE_TAKEN, 'That employee code is already in use');
        }

        // Hashed HERE, at the boundary. The repository is typed to take a hash,
        // so there is no overload through which plaintext could reach SQL.
        const ids = await repo.createOfficer(client, {
          fullName: input.fullName,
          username: input.username,
          passwordHash: hashPassword(input.password),
          phoneE164: input.phone,
          employeeCode: input.employeeCode,
          designation: input.designation ?? null,
          createdByUserId: req.actor!.userId,
        });

        // No password field, not even a redacted placeholder: the audit record
        // says an officer was created, never anything about their credential.
        await auditOfficer(client, req, AuditActions.OFFICER_CREATED, ids.officerId, null, {
          employeeCode: input.employeeCode,
          username: input.username,
          fullName: input.fullName,
          designation: input.designation ?? null,
        });
      });

      sendData(res, 201, {
        employeeCode: input.employeeCode,
        username: input.username,
        fullName: input.fullName,
        status: 'ACTIVE',
        // Said plainly because a new officer who can see no bookings otherwise
        // looks like a defect rather than an unfinished provisioning step.
        note: 'The officer can sign in, but holds no centre assignment yet and can act on nothing until assigned.',
      });
    }),
  );

  declare('GET', '/admin/officers/:employeeCode', 'officer.create', 'Read one officer.');
  router.get(
    '/admin/officers/:employeeCode',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const employeeCode = parse(EmployeeCodeSchema, req.params.employeeCode);
      const officer = await repo.officerDetail(employeeCode);
      if (!officer) throw notFound('Officer not found');
      const assignments = await repo.assignmentsForOfficer(employeeCode);
      sendData(res, 200, {
        employeeCode,
        fullName: officer.full_name,
        username: officer.username,
        designation: officer.designation,
        status: officer.status,
        loginStatus: officer.user_status,
        deactivatedAt: officer.deactivated_at ? officer.deactivated_at.toISOString() : null,
        assignments: assignments.map((a) => ({
          centreCode: a.centre_code,
          centreName: a.centre_name,
          assignedAt: (a.assigned_at as Date).toISOString(),
          revokedAt: a.revoked_at ? (a.revoked_at as Date).toISOString() : null,
          active: a.revoked_at === null,
        })),
      });
    }),
  );

  declare(
    'POST',
    '/admin/officers/:employeeCode/deactivate',
    'officer.deactivate',
    'Deactivate an officer, revoking their sessions and centre assignments.',
  );
  router.post(
    '/admin/officers/:employeeCode/deactivate',
    requirePermission('officer.deactivate'),
    asyncHandler(async (req, res) => {
      const employeeCode = parse(EmployeeCodeSchema, req.params.employeeCode);
      const input = parse(DeactivateSchema, req.body ?? {});

      // An admin cannot lock themselves out through this route: the lookup is
      // against `officers`, and an ADMIN has no row there. That is a property of
      // the schema, not a check that a later edit could forget.
      const result = await withTransaction(async (client) => {
        const officer = await repo.officerDetail(employeeCode, client);
        if (!officer) throw notFound('Officer not found');
        if (officer.status !== 'ACTIVE') {
          return { deactivated: false, sessionsRevoked: 0, assignmentsRevoked: 0 };
        }

        await repo.setOfficerStatus(client, officer.id, false);
        // BOTH rows, always. Leaving the login ACTIVE would let a deactivated
        // officer sign in again; leaving the officer row ACTIVE would let them
        // be assigned to a centre they can never work.
        await repo.setUserStatus(client, officer.user_id, 'INACTIVE');
        const sessionsRevoked = await repo.revokeSessions(
          client,
          officer.user_id,
          'officer_deactivated',
        );
        const assignmentsRevoked = await repo.revokeAllAssignments(
          client,
          officer.id,
          req.actor!.userId,
        );

        await auditOfficer(
          client,
          req,
          AuditActions.OFFICER_DEACTIVATED,
          officer.id,
          { status: 'ACTIVE' },
          {
            status: 'INACTIVE',
            reason: input.reason ?? null,
            sessionsRevoked,
            assignmentsRevoked,
          },
        );
        return { deactivated: true, sessionsRevoked, assignmentsRevoked };
      });

      sendData(res, 200, { employeeCode, ...result });
    }),
  );

  // Gated on `officer.create`, not `officer.deactivate`. Restoring an account's
  // authority is the same authority as granting it: an admin who can create an
  // officer can already reach this end state from scratch, so this grants no new
  // power. Gating it on `officer.deactivate` would instead hand the power to
  // RESTORE access to a role meant only to be able to REMOVE it.
  declare(
    'POST',
    '/admin/officers/:employeeCode/reactivate',
    'officer.create',
    'Reactivate a deactivated officer. Centre assignments are NOT restored.',
  );
  router.post(
    '/admin/officers/:employeeCode/reactivate',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const employeeCode = parse(EmployeeCodeSchema, req.params.employeeCode);

      const reactivated = await withTransaction(async (client) => {
        const officer = await repo.officerDetail(employeeCode, client);
        if (!officer) throw notFound('Officer not found');
        if (officer.status === 'ACTIVE') return false;

        await repo.setOfficerStatus(client, officer.id, true);
        await repo.setUserStatus(client, officer.user_id, 'ACTIVE');
        await auditOfficer(
          client,
          req,
          AuditActions.OFFICER_REACTIVATED,
          officer.id,
          { status: 'INACTIVE' },
          { status: 'ACTIVE' },
        );
        return true;
      });

      sendData(res, 200, {
        employeeCode,
        reactivated,
        // Deliberate: deactivation revoked the assignments, and reactivation
        // does not guess that the same postings are still the right ones.
        note: 'Centre assignments are not restored. Assign the officer to a centre explicitly.',
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // Officer registration requests
  //
  // The review queue for `POST /auth/staff/register`. Approval is the ONLY
  // path by which a public application becomes an officer, and it reuses
  // `repo.createOfficer` so a self-registered officer is indistinguishable
  // from an administrator-created one once it exists.
  // ---------------------------------------------------------------------------

  declare(
    'GET',
    '/admin/officer-registrations',
    'officer.create',
    'List officer account applications awaiting review.',
  );
  router.get(
    '/admin/officer-registrations',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const status = req.query.status ? String(req.query.status).toUpperCase() : 'PENDING';

      if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(status)) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'status invalid', {
          status: 'STATUS_INVALID',
        });
      }

      const rows = await withTransaction((client) =>
        repo.listRegistrationRequests(client, status === 'ALL' ? null : status),
      );

      sendData(res, 200, {
        requests: rows.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          phone: r.phone_e164,
          username: r.username,
          employeeCode: r.employee_code,
          designation: r.designation,
          requestedCentre: { id: r.requested_centre_id, name: r.centre_name },
          district: r.district_name,
          status: r.status,
          submittedAt: r.created_at.toISOString(),
          decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
          decisionNote: r.decision_note,
        })),
      });
    }),
  );

  declare(
    'POST',
    '/admin/officer-registrations/:id/approve',
    'officer.create',
    'Approve an application: creates the officer and assigns the requested centre.',
  );
  router.post(
    '/admin/officer-registrations/:id/approve',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const id = parse(Uuid, req.params.id);
      const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;

      const result = await withTransaction(async (client) => {
        const request = await repo.registrationRequestById(client, id);
        if (!request) throw notFound('Registration request not found');

        if (request.status !== 'PENDING') {
          throw conflict(
            ErrorCodes.REGISTRATION_REQUEST_DECIDED,
            'That application has already been decided',
          );
        }

        // Re-checked at approval, not just at submission: an identifier that
        // was free when the application was filed may have been taken since.
        if (await repo.usernameTaken(client, request.username)) {
          throw conflict(ErrorCodes.USERNAME_TAKEN, 'That username is already in use');
        }
        if (await repo.phoneTaken(client, request.phone_e164)) {
          throw conflict(
            ErrorCodes.PHONE_ALREADY_REGISTERED,
            'That phone number already belongs to an account',
          );
        }
        if (await repo.employeeCodeTaken(client, request.employee_code)) {
          throw conflict(ErrorCodes.EMPLOYEE_CODE_TAKEN, 'That employee code is already in use');
        }

        // The hash the applicant's own password produced at submission is
        // carried across unchanged, so their chosen password keeps working and
        // no plaintext was ever stored to get here.
        const ids = await repo.createOfficer(client, {
          fullName: request.full_name,
          username: request.username,
          passwordHash: request.password_hash,
          phoneE164: request.phone_e164,
          employeeCode: request.employee_code,
          designation: request.designation,
          createdByUserId: req.actor!.userId,
        });

        const assigned = await repo.assignOfficer(
          client,
          ids.officerId,
          request.requested_centre_id,
          req.actor!.userId,
        );

        await repo.settleRegistrationRequest(
          client,
          id,
          'APPROVED',
          req.actor!.userId,
          note,
          ids.officerId,
        );

        await auditOfficer(client, req, AuditActions.OFFICER_REGISTRATION_APPROVED, ids.officerId, null, {
          requestId: id,
          employeeCode: request.employee_code,
          username: request.username,
          centreId: request.requested_centre_id,
          assigned,
        });

        return { employeeCode: request.employee_code, username: request.username, assigned };
      });

      sendData(res, 201, {
        ...result,
        status: 'ACTIVE',
        note: 'The officer can now sign in and is assigned to the centre they applied for.',
      });
    }),
  );

  declare(
    'POST',
    '/admin/officer-registrations/:id/reject',
    'officer.create',
    'Reject an application. No account is created.',
  );
  router.post(
    '/admin/officer-registrations/:id/reject',
    requirePermission('officer.create'),
    asyncHandler(async (req, res) => {
      const id = parse(Uuid, req.params.id);
      const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;

      await withTransaction(async (client) => {
        const request = await repo.registrationRequestById(client, id);
        if (!request) throw notFound('Registration request not found');

        if (request.status !== 'PENDING') {
          throw conflict(
            ErrorCodes.REGISTRATION_REQUEST_DECIDED,
            'That application has already been decided',
          );
        }

        await repo.settleRegistrationRequest(client, id, 'REJECTED', req.actor!.userId, note, null);

        // Entity is the request, not an officer: rejecting creates no officer
        // to point at.
        await writeAudit(client, {
          action: AuditActions.OFFICER_REGISTRATION_REJECTED,
          entityType: 'officer_registration_request',
          entityId: id,
          actorUserId: req.actor!.userId,
          actorRole: 'ADMIN',
          actorIp: ctx(req).ip,
          requestId: ctx(req).requestId,
          metadata: { employeeCode: request.employee_code, username: request.username },
        });
      });

      sendData(res, 200, { id, status: 'REJECTED' });
    }),
  );

  return router;
}

/** Exposed for the reference/report modules that need the same lookup. */
export { query };
