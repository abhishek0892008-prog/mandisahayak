/**
 * Authentication flows.
 *
 * Every state change here runs inside one transaction together with its audit
 * row (P-9). Roles are assigned by the server from the flow that created the
 * account — a farmer registration can only ever produce the FARMER role, so no
 * request payload can escalate privilege.
 */
import type { PoolClient } from 'pg';
import { getConfig } from '../../core/config.ts';
import { sha256, verifyPassword } from '../../core/crypto.ts';
import {
  AppError,
  ErrorCodes,
  conflict,
  unprocessable,
  unauthenticated,
} from '../../core/errors.ts';
import { withTransaction } from '../../core/db.ts';
import { writeAudit, AuditActions } from '../../core/audit.ts';
import { createSession, revokeSession } from '../../core/session.ts';
import type { CreatedSession } from '../../core/session.ts';
import { issueChallenge, verifyChallenge } from './otp.service.ts';
import type { ChallengeRow, ChallengeView } from './otp.service.ts';
import type { RegisterStartInput } from './auth.schemas.ts';

export type RequestCtx = { ip: string | null; userAgent: string | null; requestId: string | null };

// ---------------------------------------------------------------------------
// Farmer registration
// ---------------------------------------------------------------------------

export async function startRegistration(
  client: PoolClient,
  input: RegisterStartInput,
  ctx: RequestCtx,
): Promise<ChallengeView> {
  const cfg = getConfig();

  const existing = await client.query('SELECT id FROM users WHERE phone_e164 = $1', [input.phone]);
  if (existing.rowCount && existing.rowCount > 0) {
    /*
     * DISCLOSED TRADE-OFF.
     * This reveals that a phone is registered, which is an enumeration oracle.
     * It is accepted here because registration needs a usable "you already have
     * an account" path, and the endpoint is rate-limited to 3 per phone per 15
     * minutes and 10 per IP per hour. LOGIN, which is the more sensitive
     * surface, is fully enumeration-resistant (see startFarmerLogin).
     */
    await writeAudit(client, {
      action: AuditActions.REGISTRATION_STARTED,
      entityType: 'registration',
      actorRole: 'SYSTEM',
      actorIp: ctx.ip,
      requestId: ctx.requestId,
      metadata: { outcome: 'DUPLICATE_PHONE', phone: input.phone },
    });
    throw conflict(ErrorCodes.PHONE_ALREADY_REGISTERED, 'Phone already registered');
  }

  const district = await client.query('SELECT id, state_id FROM districts WHERE id = $1', [
    input.districtId,
  ]);
  if (district.rowCount === 0) {
    throw unprocessable(ErrorCodes.DISTRICT_NOT_FOUND, 'District not found');
  }

  if (input.villageId) {
    const village = await client.query(
      'SELECT id FROM villages WHERE id = $1 AND district_id = $2',
      [input.villageId, input.districtId],
    );
    if (village.rowCount === 0) {
      throw unprocessable(ErrorCodes.VILLAGE_NOT_IN_DISTRICT, 'Village is not in that district');
    }
  }

  // No users/farmers row exists until the phone is verified: an unverified
  // person creates no identity.
  const pending = await client.query<{ id: string }>(
    `INSERT INTO pending_registrations
       (phone_e164, full_name, district_id, village_id, locale,
        consent_policy_version, consent_text_hash, expires_at, created_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.phone,
      input.fullName,
      input.districtId,
      input.villageId ?? null,
      input.locale,
      input.consent.policyVersion,
      sha256(`${input.consent.policyVersion}:accepted`),
      new Date(Date.now() + cfg.PENDING_REGISTRATION_TTL_SECONDS * 1000),
      ctx.ip,
    ],
  );

  const { view } = await issueChallenge(client, {
    purpose: 'FARMER_REGISTER',
    phone: input.phone,
    pendingRegistrationId: pending.rows[0].id,
    ip: ctx.ip,
  });

  await writeAudit(client, {
    action: AuditActions.REGISTRATION_STARTED,
    entityType: 'pending_registration',
    entityId: pending.rows[0].id,
    actorRole: 'SYSTEM',
    actorIp: ctx.ip,
    requestId: ctx.requestId,
    metadata: { outcome: 'OTP_ISSUED', districtId: input.districtId },
  });

  return view;
}

// ---------------------------------------------------------------------------
// Farmer login
// ---------------------------------------------------------------------------

/**
 * ENUMERATION-RESISTANT.
 *
 * An unknown phone still gets a challenge row and an identical response; the
 * difference is only that no OTP is delivered, and verification can therefore
 * never succeed. Response shape, status and timing are the same either way.
 */
export async function startFarmerLogin(
  client: PoolClient,
  phone: string,
  ctx: RequestCtx,
): Promise<ChallengeView> {
  const user = await client.query<{ id: string; status: string }>(
    `SELECT u.id, u.status FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id AND r.code = 'FARMER'
     WHERE u.phone_e164 = $1`,
    [phone],
  );

  const row = user.rows[0];
  const deliverable = Boolean(row) && row.status === 'ACTIVE';

  const { view } = await issueChallenge(client, {
    purpose: 'FARMER_LOGIN',
    phone,
    userId: row?.id ?? null,
    ip: ctx.ip,
    decoy: !deliverable,
  });

  await writeAudit(client, {
    action: AuditActions.LOGIN_OTP_REQUESTED,
    entityType: 'user',
    entityId: row?.id ?? null,
    actorRole: 'SYSTEM',
    actorIp: ctx.ip,
    requestId: ctx.requestId,
    metadata: { delivered: deliverable, phone },
  });

  return view;
}

// ---------------------------------------------------------------------------
// Staff login: password, then OTP second factor
// ---------------------------------------------------------------------------

export async function startStaffLogin(
  client: PoolClient,
  username: string,
  password: string,
  ctx: RequestCtx,
): Promise<ChallengeView> {
  const res = await client.query<{
    id: string;
    password_hash: string | null;
    phone_e164: string | null;
    status: string;
    roles: string[] | null;
  }>(
    `SELECT u.id, u.password_hash, u.phone_e164, u.status,
            (SELECT array_agg(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id) AS roles
       FROM users u WHERE u.username = $1`,
    [username],
  );

  const user = res.rows[0];

  // verifyPassword burns equivalent scrypt work when the user does not exist,
  // so "no such account" is not detectably faster than "wrong password".
  const passwordOk = verifyPassword(password, user?.password_hash ?? null);
  const roles = user?.roles ?? [];
  const isStaff = roles.includes('OFFICER') || roles.includes('ADMIN');

  if (!user || !passwordOk || !isStaff || user.status !== 'ACTIVE' || !user.phone_e164) {
    await writeAudit(client, {
      action: AuditActions.STAFF_PASSWORD_FAILED,
      entityType: 'user',
      entityId: user?.id ?? null,
      actorRole: 'SYSTEM',
      actorIp: ctx.ip,
      requestId: ctx.requestId,
      metadata: {
        username,
        reason: !user
          ? 'NO_SUCH_USER'
          : !passwordOk
            ? 'BAD_PASSWORD'
            : !isStaff
              ? 'NOT_STAFF'
              : user.status !== 'ACTIVE'
                ? 'INACTIVE'
                : 'NO_PHONE_FOR_2FA',
      },
    });
    throw unauthenticated(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials');
  }

  await writeAudit(client, {
    action: AuditActions.STAFF_PASSWORD_VERIFIED,
    entityType: 'user',
    entityId: user.id,
    actorUserId: user.id,
    actorRole: roles.includes('ADMIN') ? 'ADMIN' : 'OFFICER',
    actorIp: ctx.ip,
    requestId: ctx.requestId,
    metadata: { username, secondFactor: 'OTP' },
  });

  const { view } = await issueChallenge(client, {
    purpose: 'STAFF_2FA',
    phone: user.phone_e164,
    userId: user.id,
    ip: ctx.ip,
  });

  return view;
}

// ---------------------------------------------------------------------------
// OTP verification -> session
// ---------------------------------------------------------------------------

export type VerifyResult = { session: CreatedSession; userId: string; roles: string[] };

/**
 * TWO TRANSACTIONS, DELIBERATELY.
 *
 * The first commits the verification bookkeeping — the attempt increment, the
 * EXPIRED/FAILED status transition, the consumption of a valid challenge, and
 * the audit row. The second creates the identity and the session.
 *
 * They cannot share a transaction. A failed OTP must THROW, and a throw rolls
 * the transaction back — which would undo the very attempt counter that the
 * five-attempt limit depends on. With one transaction an attacker gets
 * unlimited OTP guesses, because every wrong guess erases its own evidence.
 * (The same reasoning is why rate limiting runs on its own connection.)
 *
 * The trade-off is that a challenge can be consumed without a session being
 * created, if the second transaction fails. That direction is fail-closed: the
 * farmer requests a new OTP. The reverse — a session without a consumed
 * challenge — would be a replay hole.
 */
export async function verifyOtpAndCreateSession(
  challengeId: string,
  otp: string,
  ctx: RequestCtx,
): Promise<VerifyResult> {
  const outcome = await withTransaction(async (client) => {
    const result = await verifyChallenge(client, challengeId, otp);
    if (!result.ok) {
      await writeAudit(client, {
        action:
          result.reason === 'EXHAUSTED'
            ? AuditActions.OTP_ATTEMPTS_EXHAUSTED
            : AuditActions.OTP_FAILED,
        entityType: 'otp_challenge',
        entityId: challengeId,
        actorRole: 'SYSTEM',
        actorIp: ctx.ip,
        requestId: ctx.requestId,
        metadata: { reason: result.reason },
      });
    }
    return result;
  });

  if (!outcome.ok) {
    // One opaque code for every failure mode.
    throw new AppError(400, ErrorCodes.OTP_INVALID, 'OTP invalid, expired or already used');
  }

  return withTransaction((client) => completeLogin(client, outcome.row, ctx));
}

async function completeLogin(
  client: PoolClient,
  row: ChallengeRow,
  ctx: RequestCtx,
): Promise<VerifyResult> {
  let userId: string;

  if (row.purpose === 'FARMER_REGISTER') {
    userId = await completeRegistration(client, row.pending_registration_id, ctx);
  } else {
    if (!row.user_id) {
      // A decoy login challenge that somehow verified. Cannot happen — a decoy's
      // OTP is never delivered — but failing closed is the only safe response.
      throw new AppError(400, ErrorCodes.OTP_INVALID, 'OTP invalid');
    }
    userId = row.user_id;
  }

  const roleRes = await client.query<{ code: string }>(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId],
  );
  const roles = roleRes.rows.map((r) => r.code);
  const isStaff = roles.includes('OFFICER') || roles.includes('ADMIN');

  const session = await createSession(client, userId, isStaff, ctx.ip, ctx.userAgent);

  await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);

  await writeAudit(client, {
    action: AuditActions.LOGIN_SUCCEEDED,
    entityType: 'session',
    entityId: session.sessionId,
    actorUserId: userId,
    actorRole: roles.includes('ADMIN') ? 'ADMIN' : roles.includes('OFFICER') ? 'OFFICER' : 'FARMER',
    actorIp: ctx.ip,
    requestId: ctx.requestId,
    metadata: { purpose: row.purpose, roles },
  });

  return { session, userId, roles };
}

/**
 * Creates the identity. Runs inside the verification transaction, so a farmer,
 * their FARMER role, their consent record and their session all commit together
 * or not at all.
 */
async function completeRegistration(
  client: PoolClient,
  pendingId: string | null,
  ctx: RequestCtx,
): Promise<string> {
  if (!pendingId) throw new AppError(400, ErrorCodes.OTP_INVALID, 'OTP invalid');

  const res = await client.query<{
    id: string;
    phone_e164: string;
    full_name: string;
    district_id: string | null;
    village_id: string | null;
    locale: string;
    consent_policy_version: string;
    consent_text_hash: Buffer;
    expires_at: Date;
    created_ip: string | null;
  }>('SELECT * FROM pending_registrations WHERE id = $1 FOR UPDATE', [pendingId]);

  const pending = res.rows[0];
  if (!pending || pending.expires_at <= new Date()) {
    throw new AppError(400, ErrorCodes.OTP_INVALID, 'Registration expired');
  }

  // Re-check uniqueness inside the transaction: someone may have registered the
  // same number between start and verify.
  const dup = await client.query('SELECT id FROM users WHERE phone_e164 = $1', [pending.phone_e164]);
  if (dup.rowCount && dup.rowCount > 0) {
    throw conflict(ErrorCodes.PHONE_ALREADY_REGISTERED, 'Phone already registered');
  }

  const user = await client.query<{ id: string }>(
    `INSERT INTO users (full_name, phone_e164, locale, phone_verified_at)
     VALUES ($1,$2,$3, now()) RETURNING id`,
    [pending.full_name, pending.phone_e164, pending.locale],
  );
  const userId = user.rows[0].id;

  // Role is assigned by the SERVER from the flow, never from the request.
  await client.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'FARMER'`,
    [userId],
  );

  await client.query(
    `INSERT INTO farmers (user_id, district_id, village_id) VALUES ($1,$2,$3)`,
    [userId, pending.district_id, pending.village_id],
  );

  await client.query(
    `INSERT INTO consents (user_id, purpose, policy_version, policy_text_hash, granted_ip)
     VALUES ($1,'SERVICE_USE',$2,$3,$4), ($1,'SMS_NOTIFICATIONS',$2,$3,$4)`,
    [userId, pending.consent_policy_version, pending.consent_text_hash, pending.created_ip],
  );

  await client.query('DELETE FROM pending_registrations WHERE id = $1', [pendingId]);

  await writeAudit(client, {
    action: AuditActions.REGISTRATION_COMPLETED,
    entityType: 'user',
    entityId: userId,
    actorUserId: userId,
    actorRole: 'FARMER',
    actorIp: ctx.ip,
    requestId: ctx.requestId,
    metadata: { consentVersion: pending.consent_policy_version },
  });

  return userId;
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function logout(
  client: PoolClient,
  sessionId: string,
  userId: string,
  roles: string[],
  ctx: RequestCtx,
): Promise<void> {
  await revokeSession(client, sessionId, 'LOGOUT');
  await writeAudit(client, {
    action: AuditActions.LOGOUT,
    entityType: 'session',
    entityId: sessionId,
    actorUserId: userId,
    actorRole: roles.includes('ADMIN') ? 'ADMIN' : roles.includes('OFFICER') ? 'OFFICER' : 'FARMER',
    actorIp: ctx.ip,
    requestId: ctx.requestId,
  });
}
