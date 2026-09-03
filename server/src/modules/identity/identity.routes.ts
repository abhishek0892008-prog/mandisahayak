/**
 * Profile, officer and admin routes.
 *
 * Phase 5 scope: these exist to exercise and prove RBAC across the three roles.
 * They read identity and audit data only — no booking, scheduling, queue,
 * procurement or payment behaviour is implemented here.
 */
import { Router } from 'express';
import { withTransaction, query } from '../../core/db.ts';
import { asyncHandler, sendData } from '../../core/http.ts';
import { badRequest, ErrorCodes, notFound } from '../../core/errors.ts';
import { declareRoute, requirePermission } from '../../core/rbac.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import { maskPhone } from '../../core/logging.ts';
import { UpdateMeSchema, zodFields } from '../auth/auth.schemas.ts';

const BASE = '/api/v1';

export function buildIdentityRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/me`,
    auth: { kind: 'permission', permission: 'profile.read.own' },
    csrf: false,
    summary: 'Return the authenticated actor’s own profile.',
  });
  router.get(
    '/me',
    requirePermission('profile.read.own'),
    asyncHandler(async (req, res) => {
      const actor = req.actor!;
      const result = await query<{
        full_name: string;
        phone_e164: string | null;
        locale: string;
        status: string;
        district_id: string | null;
        district_name: string | null;
        village_id: string | null;
        village_name: string | null;
      }>(
        `SELECT u.full_name, u.phone_e164, u.locale, u.status,
                f.district_id, d.name AS district_name,
                f.village_id,  v.name AS village_name
           FROM users u
           LEFT JOIN farmers f  ON f.user_id = u.id
           LEFT JOIN districts d ON d.id = f.district_id
           LEFT JOIN villages  v ON v.id = f.village_id
          WHERE u.id = $1`,
        [actor.userId],
      );

      const row = result.rows[0];
      if (!row) throw notFound();

      sendData(res, 200, {
        userId: actor.userId,
        fullName: row.full_name,
        // The full number is never returned; the client already knows it.
        phoneMasked: maskPhone(row.phone_e164),
        locale: row.locale,
        status: row.status,
        roles: actor.roles,
        permissions: [...actor.permissions].sort(),
        district: row.district_id ? { id: row.district_id, name: row.district_name } : null,
        village: row.village_id ? { id: row.village_id, name: row.village_name } : null,
        centreIds: actor.centreIds,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /me
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'PATCH',
    path: `${BASE}/me`,
    auth: { kind: 'permission', permission: 'profile.update.own' },
    csrf: true,
    summary: 'Update permitted fields of the authenticated actor’s own profile.',
  });
  router.patch(
    '/me',
    requirePermission('profile.update.own'),
    asyncHandler(async (req, res) => {
      const actor = req.actor!;
      const parsed = UpdateMeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'Validation failed', zodFields(parsed.error));
      }
      const input = parsed.data;

      await withTransaction(async (client) => {
        const before = await client.query(
          `SELECT u.full_name, u.locale, f.district_id, f.village_id
             FROM users u LEFT JOIN farmers f ON f.user_id = u.id
            WHERE u.id = $1 FOR UPDATE OF u`,
          [actor.userId],
        );
        if (before.rowCount === 0) throw notFound();

        if (input.districtId) {
          const d = await client.query('SELECT id FROM districts WHERE id = $1', [input.districtId]);
          if (d.rowCount === 0) {
            throw badRequest(ErrorCodes.DISTRICT_NOT_FOUND, 'District not found');
          }
        }
        if (input.villageId) {
          const districtId =
            input.districtId ?? (before.rows[0] as { district_id: string | null }).district_id;
          const v = await client.query(
            'SELECT id FROM villages WHERE id = $1 AND district_id = $2',
            [input.villageId, districtId],
          );
          if (v.rowCount === 0) {
            throw badRequest(ErrorCodes.VILLAGE_NOT_IN_DISTRICT, 'Village is not in that district');
          }
        }

        if (input.fullName !== undefined || input.locale !== undefined) {
          await client.query(
            `UPDATE users
                SET full_name = COALESCE($2, full_name),
                    locale    = COALESCE($3, locale)
              WHERE id = $1`,
            [actor.userId, input.fullName ?? null, input.locale ?? null],
          );
        }

        if (input.districtId !== undefined || input.villageId !== undefined) {
          await client.query(
            `UPDATE farmers
                SET district_id = COALESCE($2, district_id),
                    village_id  = CASE WHEN $4 THEN $3 ELSE village_id END
              WHERE user_id = $1`,
            [
              actor.userId,
              input.districtId ?? null,
              input.villageId ?? null,
              input.villageId !== undefined,
            ],
          );
        }

        const after = await client.query(
          `SELECT u.full_name, u.locale, f.district_id, f.village_id
             FROM users u LEFT JOIN farmers f ON f.user_id = u.id
            WHERE u.id = $1`,
          [actor.userId],
        );

        await writeAudit(client, {
          action: AuditActions.PROFILE_UPDATED,
          entityType: 'user',
          entityId: actor.userId,
          actorUserId: actor.userId,
          actorRole: (actor.roles[0] as 'FARMER') ?? null,
          actorIp: req.clientIp ?? null,
          requestId: req.requestId ?? null,
          before: before.rows[0],
          after: after.rows[0],
        });
      });

      sendData(res, 200, { updated: true });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /officer/centres — OFFICER (and ADMIN) only
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/officer/centres`,
    auth: { kind: 'permission', permission: 'booking.read.centre' },
    csrf: false,
    summary: 'List the centres the authenticated officer is assigned to.',
  });
  router.get(
    '/officer/centres',
    requirePermission('booking.read.centre'),
    asyncHandler(async (req, res) => {
      const actor = req.actor!;
      const result = await query<{ id: string; code: string; name: string; data_type: string }>(
        `SELECT pc.id, pc.code, pc.name, pc.data_type
           FROM procurement_centres pc
          WHERE pc.id = ANY($1::uuid[])
          ORDER BY pc.code`,
        [actor.centreIds],
      );
      sendData(res, 200, result.rows);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /admin/farmers — ADMIN only
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/admin/farmers`,
    auth: { kind: 'permission', permission: 'farmer.read' },
    csrf: false,
    summary: 'List farmers for administration. Phone numbers are masked.',
  });
  router.get(
    '/admin/farmers',
    requirePermission('farmer.read'),
    asyncHandler(async (_req, res) => {
      const result = await query<{
        id: string;
        full_name: string;
        phone_e164: string | null;
        status: string;
        district_name: string | null;
      }>(
        `SELECT f.id, u.full_name, u.phone_e164, f.status, d.name AS district_name
           FROM farmers f
           JOIN users u ON u.id = f.user_id
           LEFT JOIN districts d ON d.id = f.district_id
          ORDER BY u.created_at DESC
          LIMIT 100`,
      );
      sendData(
        res,
        200,
        result.rows.map((r) => ({
          farmerId: r.id,
          fullName: r.full_name,
          phoneMasked: maskPhone(r.phone_e164),
          status: r.status,
          district: r.district_name,
        })),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // GET /admin/audit-logs — ADMIN only. Officers deliberately cannot read these.
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/admin/audit-logs`,
    auth: { kind: 'permission', permission: 'audit.read' },
    csrf: false,
    summary: 'Read recent audit log entries.',
  });
  router.get(
    '/admin/audit-logs',
    requirePermission('audit.read'),
    asyncHandler(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const result = await query(
        `SELECT id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id, metadata
           FROM audit_logs
          ORDER BY occurred_at DESC, id DESC
          LIMIT $1`,
        [limit],
      );
      sendData(res, 200, result.rows);
    }),
  );

  return router;
}
