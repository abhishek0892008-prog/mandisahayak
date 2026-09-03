/**
 * Opaque, revocable, server-side sessions.
 *
 * Not JWTs. Deactivating an officer or logging out must take effect IMMEDIATELY;
 * a stateless token cannot do that without a denylist, which is a session table
 * with extra steps (architecture D-2).
 *
 * Only SHA-256(token) is stored, so a database leak yields no usable session.
 */
import type { PoolClient } from 'pg';
import { getConfig } from './config.ts';
import { query } from './db.ts';
import { generateSessionToken, hashSessionToken } from './crypto.ts';

/**
 * Cookie naming.
 *
 * The `__Host-` prefix is the strongest available binding: browsers accept it
 * ONLY with Secure, Path=/ and no Domain, so it cannot be set or overwritten by
 * a subdomain. But that also means a browser REJECTS it over plain HTTP, which
 * is how development and the integration tests run.
 *
 * So the prefix is applied exactly when Secure is on. Production always gets
 * `__Host-fq_session`; local HTTP gets `fq_session` and is never mistaken for a
 * hardened deployment.
 */
export function sessionCookieName(): string {
  return getConfig().cookieSecure ? '__Host-fq_session' : 'fq_session';
}

export const CSRF_COOKIE = 'fq_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export type Actor = {
  userId: string;
  sessionId: string;
  fullName: string;
  locale: string;
  status: string;
  roles: string[];
  permissions: Set<string>;
  centreIds: string[];
  isStaff: boolean;
};

export type CreatedSession = { token: string; sessionId: string; expiresAt: Date };

export async function createSession(
  client: PoolClient,
  userId: string,
  isStaff: boolean,
  ip: string | null,
  userAgent: string | null,
): Promise<CreatedSession> {
  const cfg = getConfig();
  const idle = isStaff ? cfg.STAFF_SESSION_IDLE_SECONDS : cfg.FARMER_SESSION_IDLE_SECONDS;
  const absolute = isStaff ? cfg.STAFF_SESSION_ABSOLUTE_SECONDS : cfg.FARMER_SESSION_ABSOLUTE_SECONDS;

  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + idle * 1000);
  const absoluteExpiresAt = new Date(now.getTime() + absolute * 1000);

  const res = await client.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, hashSessionToken(token), expiresAt, absoluteExpiresAt, ip, userAgent],
  );

  return { token, sessionId: res.rows[0].id, expiresAt };
}

type SessionRow = {
  session_id: string;
  user_id: string;
  full_name: string;
  locale: string;
  status: string;
  expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  roles: string[] | null;
  permissions: string[] | null;
  centre_ids: string[] | null;
};

/**
 * Resolves a bearer token to an actor, or null.
 *
 * Roles, permissions and centre scope are read from the DATABASE on every
 * request — never from the token, never from the client (P-2). That is what
 * makes officer deactivation and permission changes take effect immediately.
 */
export async function resolveSession(token: string): Promise<Actor | null> {
  const res = await query<SessionRow>(
    `SELECT s.id                AS session_id,
            u.id                AS user_id,
            u.full_name,
            u.locale,
            u.status,
            s.expires_at,
            s.absolute_expires_at,
            s.revoked_at,
            (SELECT array_agg(r.code)
               FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id)                                   AS roles,
            (SELECT array_agg(DISTINCT p.code)
               FROM user_roles ur
               JOIN role_permissions rp ON rp.role_id = ur.role_id
               JOIN permissions p ON p.id = rp.permission_id
              WHERE ur.user_id = u.id)                                   AS permissions,
            (SELECT array_agg(oca.centre_id)
               FROM officers o
               JOIN officer_centre_assignments oca ON oca.officer_id = o.id
              WHERE o.user_id = u.id AND oca.revoked_at IS NULL AND o.status = 'ACTIVE')
                                                                          AS centre_ids
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hashSessionToken(token)],
  );

  const row = res.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;

  const now = new Date();
  if (row.expires_at <= now || row.absolute_expires_at <= now) return null;
  if (row.status !== 'ACTIVE') return null;

  const roles = row.roles ?? [];
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    fullName: row.full_name,
    locale: row.locale,
    status: row.status,
    roles,
    permissions: new Set(row.permissions ?? []),
    centreIds: row.centre_ids ?? [],
    isStaff: roles.includes('OFFICER') || roles.includes('ADMIN'),
  };
}

/** Sliding idle expiry, capped by the absolute deadline. */
export async function touchSession(sessionId: string, isStaff: boolean): Promise<void> {
  const cfg = getConfig();
  const idle = isStaff ? cfg.STAFF_SESSION_IDLE_SECONDS : cfg.FARMER_SESSION_IDLE_SECONDS;
  await query(
    `UPDATE sessions
        SET last_seen_at = now(),
            expires_at   = LEAST(now() + ($2 || ' seconds')::interval, absolute_expires_at)
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, String(idle)],
  );
}

export async function revokeSession(
  client: PoolClient,
  sessionId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

/** Used when an account is deactivated: every session dies at once. */
export async function revokeAllUserSessions(
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

export function sessionCookieOptions(expiresAt: Date) {
  const cfg = getConfig();
  return {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export function clearedSessionCookieOptions() {
  const cfg = getConfig();
  return {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    expires: new Date(0),
  };
}
