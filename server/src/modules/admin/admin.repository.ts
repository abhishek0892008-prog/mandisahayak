/**
 * Admin configuration — SQL.
 *
 * TWO RULES THIS FILE ENFORCES STRUCTURALLY:
 *
 * 1. **Nothing here can create OFFICIAL data.** Every insert hardcodes
 *    `data_type = 'CONFIGURED'`. There is no parameter a caller could set to
 *    promote a row to OFFICIAL, because OFFICIAL requires a verified
 *    `source_id` and no administrative API can manufacture provenance.
 *
 * 2. **Deactivate, never delete.** A centre, lane or configuration referenced
 *    by a booking is history. Status changes and temporal end-dating are the
 *    only ways anything leaves service.
 */
import type { PoolClient } from 'pg';
import { query } from '../../core/db.ts';

const CONFIGURED = 'CONFIGURED';

// ---------------------------------------------------------------------------
// Centres
// ---------------------------------------------------------------------------

export type CentreRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  timezone: string;
  data_type: string;
  storage_check_mode: string;
  district_name: string;
  lane_count: number;
};

const CENTRE_SELECT = `
  SELECT pc.id, pc.code, pc.name, pc.status, pc.timezone, pc.data_type,
         pc.storage_check_mode, d.name AS district_name,
         (SELECT count(*) FROM centre_service_lanes l
           WHERE l.centre_id = pc.id AND l.is_active)::int AS lane_count
    FROM procurement_centres pc
    JOIN districts d ON d.id = pc.district_id`;

export async function listCentres(includeInactive: boolean): Promise<CentreRow[]> {
  const res = await query(
    `${CENTRE_SELECT}
      WHERE ($1::boolean OR pc.status = 'ACTIVE')
      ORDER BY pc.code`,
    [includeInactive],
  );
  return res.rows as CentreRow[];
}

export async function findCentre(
  centreId: string,
  db: PoolClient | null = null,
): Promise<CentreRow | null> {
  const run = db ? db.query.bind(db) : query;
  const res = await run(`${CENTRE_SELECT} WHERE pc.id = $1`, [centreId]);
  return (res.rows[0] as CentreRow) ?? null;
}

export async function centreCodeExists(client: PoolClient, code: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM procurement_centres WHERE code = $1', [code]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Creates a CONFIGURED centre.
 *
 * `data_type` is hardcoded and `source_id` is NULL, so
 * `procurement_centres_official_requires_source` makes an OFFICIAL centre
 * impossible through this path. `storage_check_mode` stays ADVISORY: no
 * administrative call may assert physical storage capacity (decision D-10).
 */
export async function createCentre(
  client: PoolClient,
  input: {
    code: string;
    name: string;
    districtId: string;
    timezone: string;
    address: string | null;
  },
): Promise<string> {
  const res = await client.query(
    `INSERT INTO procurement_centres
       (code, name, state_id, district_id, address, timezone, status,
        storage_check_mode, data_type, source_id)
     SELECT $1, $2, d.state_id, d.id, $5, $4, 'ACTIVE', 'ADVISORY', $6, NULL
       FROM districts d WHERE d.id = $3
     RETURNING id`,
    [input.code, input.name, input.districtId, input.timezone, input.address, CONFIGURED],
  );
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) throw new Error('DISTRICT_NOT_FOUND');
  return row.id;
}

/** Only the fields an administrator may change. `data_type` is not among them. */
export async function updateCentre(
  client: PoolClient,
  centreId: string,
  patch: { name?: string; address?: string | null; status?: string; timezone?: string },
): Promise<void> {
  await client.query(
    `UPDATE procurement_centres
        SET name     = COALESCE($2, name),
            address  = COALESCE($3, address),
            status   = COALESCE($4, status),
            timezone = COALESCE($5, timezone)
      WHERE id = $1`,
    [centreId, patch.name ?? null, patch.address ?? null, patch.status ?? null, patch.timezone ?? null],
  );
}

/** Active bookings that would be orphaned by taking a centre out of service. */
export async function activeBookingCount(client: PoolClient, centreId: string): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::text AS n FROM bookings
      WHERE centre_id = $1
        AND status IN ('CONFIRMED','ARRIVED','WEIGHING','QUALITY_CHECK',
                       'PROCUREMENT_RECORDED','PAYMENT_PENDING')`,
    [centreId],
  );
  return Number((res.rows[0] as { n: string }).n);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export async function listLanes(centreId: string) {
  const res = await query(
    `SELECT lane_no, name, is_active FROM centre_service_lanes
      WHERE centre_id = $1 ORDER BY lane_no`,
    [centreId],
  );
  return res.rows as Array<{ lane_no: number; name: string | null; is_active: boolean }>;
}

export async function upsertLane(
  client: PoolClient,
  centreId: string,
  laneNo: number,
  name: string | null,
  isActive: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO centre_service_lanes (centre_id, lane_no, name, is_active)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (centre_id, lane_no)
     DO UPDATE SET name = EXCLUDED.name, is_active = EXCLUDED.is_active`,
    [centreId, laneNo, name, isActive],
  );
}

/** A lane holding active bookings must not be deactivated out from under them. */
export async function activeBookingsOnLane(
  client: PoolClient,
  centreId: string,
  laneNo: number,
): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::text AS n FROM bookings
      WHERE centre_id = $1 AND lane_no = $2
        AND status IN ('CONFIRMED','ARRIVED','WEIGHING','QUALITY_CHECK',
                       'PROCUREMENT_RECORDED','PAYMENT_PENDING')`,
    [centreId, laneNo],
  );
  return Number((res.rows[0] as { n: string }).n);
}

// ---------------------------------------------------------------------------
// Operating hours (temporal — end-date, never overwrite)
// ---------------------------------------------------------------------------

export async function listHours(centreId: string, onDate: string) {
  const res = await query(
    `SELECT day_of_week, opens_at::text AS opens_at, closes_at::text AS closes_at,
            effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM centre_operating_hours
      WHERE centre_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)
      ORDER BY day_of_week`,
    [centreId, onDate],
  );
  return res.rows as Array<Record<string, string | number | null>>;
}

/**
 * Replaces the hours for one weekday from `effectiveFrom`.
 *
 * The existing open-ended row is END-DATED rather than updated, so what the
 * centre's hours were on a past service date remains answerable. That is the
 * same temporal discipline `centre_slot_configurations` already uses (P-10).
 */
export async function setHours(
  client: PoolClient,
  centreId: string,
  dayOfWeek: number,
  opensAt: string,
  closesAt: string,
  effectiveFrom: string,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE centre_operating_hours
        SET effective_to = $3::date
      WHERE centre_id = $1 AND day_of_week = $2 AND effective_to IS NULL`,
    [centreId, dayOfWeek, effectiveFrom],
  );
  await client.query(
    `INSERT INTO centre_operating_hours
       (centre_id, day_of_week, opens_at, closes_at, effective_from,
        data_type, configured_by_user_id)
     VALUES ($1,$2,$3::time,$4::time,$5::date,$6,$7)`,
    [centreId, dayOfWeek, opensAt, closesAt, effectiveFrom, CONFIGURED, userId],
  );
}

/** Closes a weekday entirely by end-dating its row and adding no replacement. */
export async function closeWeekday(
  client: PoolClient,
  centreId: string,
  dayOfWeek: number,
  effectiveFrom: string,
): Promise<void> {
  await client.query(
    `UPDATE centre_operating_hours
        SET effective_to = $3::date
      WHERE centre_id = $1 AND day_of_week = $2 AND effective_to IS NULL`,
    [centreId, dayOfWeek, effectiveFrom],
  );
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function listHolidays(centreId: string) {
  const res = await query(
    `SELECT holiday_date::text AS holiday_date, reason FROM centre_holidays
      WHERE centre_id = $1 ORDER BY holiday_date`,
    [centreId],
  );
  return res.rows as Array<{ holiday_date: string; reason: string | null }>;
}

export async function addHoliday(
  client: PoolClient,
  centreId: string,
  date: string,
  reason: string | null,
  userId: string,
): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO centre_holidays (centre_id, holiday_date, reason, data_type, configured_by_user_id)
     VALUES ($1,$2::date,$3,$4,$5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [centreId, date, reason, CONFIGURED, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function removeHoliday(
  client: PoolClient,
  centreId: string,
  date: string,
): Promise<boolean> {
  const res = await client.query(
    'DELETE FROM centre_holidays WHERE centre_id = $1 AND holiday_date = $2::date',
    [centreId, date],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Active bookings already scheduled on a date about to become a holiday. */
export async function bookingsOnDate(
  client: PoolClient,
  centreId: string,
  date: string,
): Promise<number> {
  const res = await client.query(
    `SELECT count(*)::text AS n FROM bookings
      WHERE centre_id = $1 AND service_date = $2::date
        AND status IN ('CONFIRMED','ARRIVED','WEIGHING','QUALITY_CHECK',
                       'PROCUREMENT_RECORDED','PAYMENT_PENDING')`,
    [centreId, date],
  );
  return Number((res.rows[0] as { n: string }).n);
}

// ---------------------------------------------------------------------------
// Crop eligibility
// ---------------------------------------------------------------------------

export async function listCropConfig(centreId: string) {
  const res = await query(
    `SELECT cr.code AS crop_code, cr.canonical_name AS crop_name, s.code AS season_code,
            ccc.marketing_year, ccc.is_active,
            ccc.effective_from::text AS effective_from, ccc.effective_to::text AS effective_to
       FROM centre_crop_configurations ccc
       JOIN crops cr ON cr.id = ccc.crop_id
       JOIN seasons s ON s.id = ccc.season_id
      WHERE ccc.centre_id = $1
      ORDER BY cr.code`,
    [centreId],
  );
  return res.rows as Array<Record<string, unknown>>;
}

export async function setCropEligibility(
  client: PoolClient,
  centreId: string,
  cropId: string,
  seasonId: string,
  marketingYear: string,
  isActive: boolean,
  effectiveFrom: string,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE centre_crop_configurations
        SET effective_to = $4::date
      WHERE centre_id = $1 AND crop_id = $2 AND season_id = $3 AND effective_to IS NULL`,
    [centreId, cropId, seasonId, effectiveFrom],
  );
  await client.query(
    `INSERT INTO centre_crop_configurations
       (centre_id, crop_id, season_id, marketing_year, is_active, effective_from,
        data_type, configured_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8)`,
    [centreId, cropId, seasonId, marketingYear, isActive, effectiveFrom, CONFIGURED, userId],
  );
}

// ---------------------------------------------------------------------------
// Slot configuration
// ---------------------------------------------------------------------------

export async function currentSlotConfig(centreId: string, onDate: string) {
  const res = await query(
    `SELECT reference_quantity_kg, reference_processing_minutes,
            minimum_processing_minutes, maximum_processing_minutes,
            transition_buffer_minutes, slot_granularity_minutes,
            booking_horizon_days, cancellation_cutoff_hours,
            effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM centre_slot_configurations
      WHERE centre_id = $1 AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to > $2::date)`,
    [centreId, onDate],
  );
  return (res.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Adds a new slot configuration from `effectiveFrom`, end-dating the current
 * one. `centre_slot_configurations_no_overlap` (a GiST exclusion constraint)
 * refuses an overlap independently, so a wrong date is rejected by the database
 * rather than silently producing two configurations in force at once.
 */
export async function setSlotConfig(
  client: PoolClient,
  centreId: string,
  cfg: {
    referenceQuantityKg: number;
    referenceProcessingMinutes: number;
    minimumProcessingMinutes: number;
    maximumProcessingMinutes: number;
    transitionBufferMinutes: number;
    slotGranularityMinutes: number;
    bookingHorizonDays: number;
    cancellationCutoffHours: number;
  },
  effectiveFrom: string,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE centre_slot_configurations
        SET effective_to = $2::date
      WHERE centre_id = $1 AND effective_to IS NULL`,
    [centreId, effectiveFrom],
  );
  await client.query(
    `INSERT INTO centre_slot_configurations
       (centre_id, reference_quantity_kg, reference_processing_minutes,
        minimum_processing_minutes, maximum_processing_minutes,
        transition_buffer_minutes, slot_granularity_minutes,
        booking_horizon_days, cancellation_cutoff_hours,
        effective_from, data_type, configured_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12)`,
    [
      centreId,
      cfg.referenceQuantityKg,
      cfg.referenceProcessingMinutes,
      cfg.minimumProcessingMinutes,
      cfg.maximumProcessingMinutes,
      cfg.transitionBufferMinutes,
      cfg.slotGranularityMinutes,
      cfg.bookingHorizonDays,
      cfg.cancellationCutoffHours,
      effectiveFrom,
      CONFIGURED,
      userId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Officer assignments
// ---------------------------------------------------------------------------

export async function listAssignments(centreId: string) {
  const res = await query(
    `SELECT u.full_name, o.employee_code, o.status AS officer_status,
            a.assigned_at, a.revoked_at
       FROM officer_centre_assignments a
       JOIN officers o ON o.id = a.officer_id
       JOIN users u ON u.id = o.user_id
      WHERE a.centre_id = $1
      ORDER BY a.assigned_at DESC`,
    [centreId],
  );
  return res.rows as Array<Record<string, unknown>>;
}

export async function officerByEmployeeCode(
  client: PoolClient,
  employeeCode: string,
): Promise<{ id: string; status: string } | null> {
  const res = await client.query(
    'SELECT id, status FROM officers WHERE employee_code = $1',
    [employeeCode],
  );
  return (res.rows[0] as { id: string; status: string }) ?? null;
}

export async function assignOfficer(
  client: PoolClient,
  officerId: string,
  centreId: string,
  byUserId: string,
): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO officer_centre_assignments (officer_id, centre_id, assigned_by_user_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (officer_id, centre_id) WHERE revoked_at IS NULL
     DO NOTHING
     RETURNING id`,
    [officerId, centreId, byUserId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Revocation keeps the row — assignment history is an audit trail. */
export async function revokeAssignment(
  client: PoolClient,
  officerId: string,
  centreId: string,
  byUserId: string,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE officer_centre_assignments
        SET revoked_at = now(), revoked_by_user_id = $3
      WHERE officer_id = $1 AND centre_id = $2 AND revoked_at IS NULL`,
    [officerId, centreId, byUserId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Officer provisioning (Phase 14)
// ---------------------------------------------------------------------------

/**
 * Creates an officer.
 *
 * THE ROLE IS HARDCODED. There is no parameter, anywhere in this call chain,
 * that could grant ADMIN. An administrator provisioning staff can create
 * officers and nothing else — which is what stops this endpoint being a
 * privilege-escalation path.
 *
 * The password arrives already hashed. This function never sees, stores or
 * returns plaintext, and `password_hash` is never selected by any read below.
 */
export async function createOfficer(
  client: PoolClient,
  input: {
    fullName: string;
    username: string;
    passwordHash: string;
    phoneE164: string;
    employeeCode: string;
    designation: string | null;
    createdByUserId: string;
  },
): Promise<{ userId: string; officerId: string }> {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (full_name, username, password_hash, phone_e164, phone_verified_at, status)
     VALUES ($1,$2,$3,$4, now(), 'ACTIVE')
     RETURNING id`,
    [input.fullName, input.username, input.passwordHash, input.phoneE164],
  );
  const userId = user.rows[0].id;

  await client.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'OFFICER'`,
    [userId],
  );

  const officer = await client.query<{ id: string }>(
    `INSERT INTO officers (user_id, employee_code, designation, created_by_user_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, input.employeeCode, input.designation, input.createdByUserId],
  );

  return { userId, officerId: officer.rows[0].id };
}

export async function usernameTaken(client: PoolClient, username: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM users WHERE username = $1', [username]);
  return (r.rowCount ?? 0) > 0;
}

export async function phoneTaken(client: PoolClient, phoneE164: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM users WHERE phone_e164 = $1', [phoneE164]);
  return (r.rowCount ?? 0) > 0;
}

export async function employeeCodeTaken(client: PoolClient, code: string): Promise<boolean> {
  const r = await client.query('SELECT 1 FROM officers WHERE employee_code = $1', [code]);
  return (r.rowCount ?? 0) > 0;
}

/** `password_hash` is deliberately absent from this projection. */
export async function listOfficers(includeInactive: boolean) {
  const res = await query(
    `SELECT o.employee_code, o.designation, o.status, o.deactivated_at,
            u.full_name, u.username, u.status AS user_status,
            (SELECT count(*) FROM officer_centre_assignments a
              WHERE a.officer_id = o.id AND a.revoked_at IS NULL)::int AS active_assignments
       FROM officers o JOIN users u ON u.id = o.user_id
      WHERE ($1::boolean OR o.status = 'ACTIVE')
      ORDER BY o.employee_code`,
    [includeInactive],
  );
  return res.rows as Array<Record<string, unknown>>;
}

/**
 * Resolves an officer by their employee code.
 *
 * Takes an optional client so a read can run on the pool while a lifecycle
 * mutation reads inside its own transaction — the same shape `findCentre`
 * uses. `password_hash` is not selected.
 */
export async function officerDetail(employeeCode: string, db: PoolClient | null = null) {
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `SELECT o.id, o.user_id, o.status, o.designation, o.deactivated_at,
            u.full_name, u.username, u.status AS user_status
       FROM officers o JOIN users u ON u.id = o.user_id
      WHERE o.employee_code = $1`,
    [employeeCode],
  );
  return (
    (res.rows[0] as {
      id: string;
      user_id: string;
      status: string;
      designation: string | null;
      deactivated_at: Date | null;
      full_name: string;
      username: string | null;
      user_status: string;
    }) ?? null
  );
}

export async function setOfficerStatus(
  client: PoolClient,
  officerId: string,
  active: boolean,
): Promise<void> {
  await client.query(
    `UPDATE officers
        SET status = $2, deactivated_at = CASE WHEN $2 = 'INACTIVE' THEN now() ELSE NULL END
      WHERE id = $1`,
    [officerId, active ? 'ACTIVE' : 'INACTIVE'],
  );
}

export async function setUserStatus(
  client: PoolClient,
  userId: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<void> {
  await client.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
}

/**
 * Revokes every live session for a user.
 *
 * Deactivating an officer without this would leave them able to keep working
 * until their session happened to expire — up to twelve hours of authority
 * after the decision to remove it.
 */
export async function revokeSessions(
  client: PoolClient,
  userId: string,
  reason: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return res.rowCount ?? 0;
}

/** Revokes all live centre assignments when an officer is deactivated. */
export async function revokeAllAssignments(
  client: PoolClient,
  officerId: string,
  byUserId: string,
): Promise<number> {
  const res = await client.query(
    `UPDATE officer_centre_assignments
        SET revoked_at = now(), revoked_by_user_id = $2
      WHERE officer_id = $1 AND revoked_at IS NULL`,
    [officerId, byUserId],
  );
  return res.rowCount ?? 0;
}

export async function assignmentsForOfficer(employeeCode: string) {
  const res = await query(
    `SELECT pc.code AS centre_code, pc.name AS centre_name,
            a.assigned_at, a.revoked_at
       FROM officer_centre_assignments a
       JOIN officers o ON o.id = a.officer_id
       JOIN procurement_centres pc ON pc.id = a.centre_id
      WHERE o.employee_code = $1
      ORDER BY a.assigned_at DESC`,
    [employeeCode],
  );
  return res.rows as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Officer registration requests
//
// A request is an application, never an account. Nothing here grants anything;
// `approveRegistrationRequest` is the single point where one becomes an
// officer, and it goes through the same `createOfficer` path an administrator
// uses directly.
// ---------------------------------------------------------------------------

export type RegistrationRequestRow = {
  id: string;
  full_name: string;
  phone_e164: string;
  username: string;
  employee_code: string;
  designation: string | null;
  requested_centre_id: string;
  centre_name: string;
  district_name: string;
  status: string;
  created_at: Date;
  decided_at: Date | null;
  decision_note: string | null;
};

export async function listRegistrationRequests(
  client: PoolClient,
  status: string | null,
): Promise<RegistrationRequestRow[]> {
  const res = await client.query<RegistrationRequestRow>(
    `SELECT r.id, r.full_name, r.phone_e164, r.username, r.employee_code, r.designation,
            r.requested_centre_id, pc.name AS centre_name, d.name AS district_name,
            r.status, r.created_at, r.decided_at, r.decision_note
       FROM officer_registration_requests r
       JOIN procurement_centres pc ON pc.id = r.requested_centre_id
       JOIN districts d ON d.id = pc.district_id
      WHERE ($1::text IS NULL OR r.status = $1::text)
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [status],
  );
  return res.rows;
}

/** The full row including the stored hash. Never widen this into an API view. */
export async function registrationRequestById(
  client: PoolClient,
  id: string,
): Promise<(RegistrationRequestRow & { password_hash: string }) | null> {
  const res = await client.query<RegistrationRequestRow & { password_hash: string }>(
    `SELECT r.id, r.full_name, r.phone_e164, r.username, r.employee_code, r.designation,
            r.requested_centre_id, pc.name AS centre_name, d.name AS district_name,
            r.status, r.created_at, r.decided_at, r.decision_note, r.password_hash
       FROM officer_registration_requests r
       JOIN procurement_centres pc ON pc.id = r.requested_centre_id
       JOIN districts d ON d.id = pc.district_id
      WHERE r.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function settleRegistrationRequest(
  client: PoolClient,
  id: string,
  status: 'APPROVED' | 'REJECTED',
  byUserId: string,
  note: string | null,
  createdOfficerId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE officer_registration_requests
        SET status = $2, decided_at = now(), decided_by_user_id = $3,
            decision_note = $4, created_officer_id = $5
      WHERE id = $1`,
    [id, status, byUserId, note, createdOfficerId],
  );
}
