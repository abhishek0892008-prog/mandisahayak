/**
 * Reference data.
 *
 * Everything the farmer UI needs to stop hardcoding lists: districts, villages,
 * crops (with their official season and marketing year), centres, and the
 * booking constraints.
 *
 * Every row carries its `dataType` so the UI can honestly label what is OFFICIAL
 * government data and what is CONFIGURED demonstration data. That labelling is
 * the whole point of the provenance model — it must survive out to the client.
 *
 * PHASE 6 BOUNDARY: this exposes the crop -> season -> marketing year -> eligible
 * centre relationship so the booking engine can resolve it later. It does NOT
 * compute slots, durations, availability or prices.
 */
import { Router } from 'express';
import { query } from '../../core/db.ts';
import { asyncHandler, sendData } from '../../core/http.ts';
import { badRequest, ErrorCodes } from '../../core/errors.ts';
import { declareRoute, requirePermission } from '../../core/rbac.ts';
import { consumeAll, RateLimits, toError } from '../../core/rateLimit.ts';
import { bookingConstraints } from '../../domain/quantity.ts';

const BASE = '/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildReferenceRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /reference/districts
  // -------------------------------------------------------------------------
  //
  // PUBLIC, and it has to be. `POST /auth/farmer/register/start-otp` is public
  // and requires a districtId UUID. If the only way to learn a district id were
  // an authenticated endpoint, a farmer would need an account before they could
  // create one — registration would be unreachable for every real client.
  //
  // Safe to expose: districts are public government geography (LGD) with no
  // personal data, and this is the ONLY reference endpoint opened. Villages,
  // crops, centres and booking constraints all still require a session.
  // Rate limited per IP because it is unauthenticated.
  declareRoute({
    method: 'GET',
    path: `${BASE}/reference/districts`,
    auth: {
      kind: 'public',
      reason:
        'Registration is public and requires a districtId; districts are public government geography with no personal data.',
    },
    csrf: false,
    summary: 'Districts available for registration and centre selection.',
  });
  router.get(
    '/reference/districts',
    asyncHandler(async (req, res) => {
      const limited = await consumeAll([
        { rule: RateLimits.PUBLIC_REFERENCE_PER_IP, subject: req.clientIp ?? 'unknown' },
      ]);
      if (limited) throw toError(limited);
      const result = await query<{
        id: string; name: string; lgd_code: string | null; data_type: string;
        state_name: string; state_lgd_code: string;
      }>(
        `SELECT d.id, d.name, d.lgd_code, d.data_type,
                s.name AS state_name, s.lgd_code AS state_lgd_code
           FROM districts d JOIN states s ON s.id = d.state_id
          ORDER BY d.name`,
      );
      sendData(
        res,
        200,
        result.rows.map((r) => ({
          id: r.id,
          name: r.name,
          lgdCode: r.lgd_code,
          dataType: r.data_type,
          state: { name: r.state_name, lgdCode: r.state_lgd_code },
        })),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // GET /reference/villages?districtId=
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/reference/villages`,
    auth: { kind: 'permission', permission: 'reference.read' },
    csrf: false,
    summary: 'Villages within a district. Currently empty — see the note below.',
  });
  router.get(
    '/reference/villages',
    requirePermission('reference.read'),
    asyncHandler(async (req, res) => {
      const districtId = String(req.query.districtId ?? '');
      if (!UUID.test(districtId)) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'districtId is required', {
          districtId: 'DISTRICT_ID_INVALID',
        });
      }

      const result = await query<{ id: string; name: string; lgd_code: string | null; data_type: string }>(
        `SELECT id, name, lgd_code, data_type FROM villages WHERE district_id = $1 ORDER BY name`,
        [districtId],
      );

      /*
       * An empty list is the CORRECT answer today, not a bug: LGD village data
       * was not retrievable in Phase 4 (CAPTCHA / API key), and inventing
       * village records is forbidden. villageId is optional on registration for
       * exactly this reason. `available: false` tells the UI to hide the field
       * rather than render an empty dropdown.
       */
      sendData(res, 200, {
        districtId,
        available: result.rowCount! > 0,
        reasonCode: result.rowCount! > 0 ? null : 'NO_VILLAGE_DATA_FOR_DISTRICT',
        villages: result.rows.map((r) => ({
          id: r.id, name: r.name, lgdCode: r.lgd_code, dataType: r.data_type,
        })),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /reference/crops
  //
  // The crop -> season -> marketing year chain, from the OFFICIAL MSP import.
  // Crop definitions are never duplicated or hardcoded in a controller.
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/reference/crops`,
    auth: { kind: 'permission', permission: 'reference.read' },
    csrf: false,
    summary: 'Crops with their official season and marketing year.',
  });
  router.get(
    '/reference/crops',
    requirePermission('reference.read'),
    asyncHandler(async (_req, res) => {
      const result = await query<{
        id: string; code: string; canonical_name: string; data_type: string;
        season_code: string | null; season_name: string | null;
        marketing_year: string | null; grades: string[] | null; centre_count: number;
      }>(
        `SELECT c.id, c.code, c.canonical_name, c.data_type,
                s.code AS season_code, s.name AS season_name,
                m.marketing_year,
                array_remove(array_agg(DISTINCT m.variety_or_grade), NULL) AS grades,
                (SELECT count(*)::int
                   FROM centre_crop_configurations ccc
                  WHERE ccc.crop_id = c.id AND ccc.is_active) AS centre_count
           FROM crops c
           LEFT JOIN msp_rates m ON m.crop_id = c.id AND m.status = 'ACTIVE'
           LEFT JOIN seasons  s ON s.id = m.season_id
          WHERE c.is_active
          GROUP BY c.id, c.code, c.canonical_name, c.data_type,
                   s.code, s.name, m.marketing_year
          ORDER BY c.canonical_name`,
      );

      sendData(
        res,
        200,
        result.rows.map((r) => ({
          id: r.id,
          code: r.code,
          // The government's own wording. Do NOT translate this in the frontend
          // bundle: renaming an official crop misrepresents the source.
          canonicalName: r.canonical_name,
          dataType: r.data_type,
          season: r.season_code ? { code: r.season_code, name: r.season_name } : null,
          marketingYear: r.marketing_year,
          // Present when the source publishes per-variety rates (e.g. Paddy
          // Common / Grade A). A grade-less lookup for such a crop is ambiguous
          // by design — see D-9.
          grades: (r.grades ?? []).sort(),
          eligibleCentreCount: r.centre_count,
        })),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // GET /reference/centres?districtId=&cropId=
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/reference/centres`,
    auth: { kind: 'permission', permission: 'reference.read' },
    csrf: false,
    summary: 'Active procurement centres, optionally filtered by district and crop.',
  });
  router.get(
    '/reference/centres',
    requirePermission('reference.read'),
    asyncHandler(async (req, res) => {
      const districtId = req.query.districtId ? String(req.query.districtId) : null;
      const cropId = req.query.cropId ? String(req.query.cropId) : null;

      if (districtId && !UUID.test(districtId)) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'districtId invalid', {
          districtId: 'DISTRICT_ID_INVALID',
        });
      }
      if (cropId && !UUID.test(cropId)) {
        throw badRequest(ErrorCodes.VALIDATION_FAILED, 'cropId invalid', { cropId: 'CROP_ID_INVALID' });
      }

      const result = await query<{
        id: string; code: string; name: string; data_type: string; timezone: string;
        storage_check_mode: string; district_name: string; district_id: string;
        lane_count: number; crops: string[] | null;
      }>(
        `SELECT pc.id, pc.code, pc.name, pc.data_type, pc.timezone, pc.storage_check_mode,
                d.name AS district_name, d.id AS district_id,
                (SELECT count(*)::int FROM centre_service_lanes l
                  WHERE l.centre_id = pc.id AND l.is_active) AS lane_count,
                (SELECT array_agg(DISTINCT cr.canonical_name)
                   FROM centre_crop_configurations ccc
                   JOIN crops cr ON cr.id = ccc.crop_id
                  WHERE ccc.centre_id = pc.id AND ccc.is_active) AS crops
           FROM procurement_centres pc
           JOIN districts d ON d.id = pc.district_id
          WHERE pc.status = 'ACTIVE'
            AND ($1::uuid IS NULL OR pc.district_id = $1::uuid)
            AND ($2::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM centre_crop_configurations ccc
                   WHERE ccc.centre_id = pc.id AND ccc.crop_id = $2::uuid AND ccc.is_active))
          ORDER BY pc.name`,
        [districtId, cropId],
      );

      sendData(
        res,
        200,
        result.rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          dataType: r.data_type,
          district: { id: r.district_id, name: r.district_name },
          timezone: r.timezone,
          laneCount: r.lane_count,
          acceptedCrops: (r.crops ?? []).sort(),
          /*
           * D-10: no official centre-level storage capacity exists. The centre is
           * in ADVISORY mode, so the honest answer is a reason code rather than
           * an invented headroom figure.
           */
          storage: {
            checkMode: r.storage_check_mode,
            status: 'NOT_AVAILABLE',
            reasonCode: 'NO_CAPACITY_DATA_FOR_CENTRE',
          },
        })),
      );
    }),
  );

  // -------------------------------------------------------------------------
  // GET /reference/booking-constraints
  // -------------------------------------------------------------------------
  declareRoute({
    method: 'GET',
    path: `${BASE}/reference/booking-constraints`,
    auth: { kind: 'permission', permission: 'reference.read' },
    csrf: false,
    summary: 'Quantity rules, so the UI never hardcodes the range.',
  });
  router.get(
    '/reference/booking-constraints',
    requirePermission('reference.read'),
    asyncHandler(async (_req, res) => {
      sendData(res, 200, bookingConstraints());
    }),
  );

  return router;
}
