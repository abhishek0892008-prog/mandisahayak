/**
 * Audit logging.
 *
 * PRINCIPLE P-9: the audit row is written by the SAME transaction that makes the
 * change. If the audit insert fails, the change rolls back with it. That is why
 * `writeAudit` takes a client rather than reaching for the pool.
 *
 * `audit_logs` is append-only at the database level (three statement-level
 * triggers from migration 0010), so nothing here can amend history.
 */
import type { PoolClient } from 'pg';
import { redact } from './logging.ts';

/** Security and authentication events. Values are stable; they appear in reports. */
export const AuditActions = {
  REGISTRATION_STARTED: 'auth.registration_started',
  REGISTRATION_COMPLETED: 'auth.registration_completed',
  LOGIN_OTP_REQUESTED: 'auth.login_otp_requested',
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGIN_FAILED: 'auth.login_failed',
  OTP_REQUESTED: 'auth.otp_requested',
  OTP_VERIFIED: 'auth.otp_verified',
  OTP_FAILED: 'auth.otp_failed',
  OTP_RESENT: 'auth.otp_resent',
  OTP_ATTEMPTS_EXHAUSTED: 'auth.otp_attempts_exhausted',
  STAFF_PASSWORD_VERIFIED: 'auth.staff_password_verified',
  STAFF_PASSWORD_FAILED: 'auth.staff_password_failed',
  LOGOUT: 'auth.logout',
  SESSION_REVOKED: 'auth.session_revoked',
  AUTHORIZATION_DENIED: 'auth.authorization_denied',
  CSRF_REJECTED: 'auth.csrf_rejected',
  RATE_LIMIT_EXCEEDED: 'auth.rate_limit_exceeded',
  DEMO_OTP_REVEALED: 'auth.demo_otp_revealed',
  PROFILE_UPDATED: 'profile.updated',
  BOOKING_CREATED: 'booking.created',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_ARRIVED: 'booking.arrived',
  BOOKING_NO_SHOW: 'booking.no_show',
  BOOKING_CANCELLED_AT_CENTRE: 'booking.cancelled_at_centre',
  WEIGHING_STARTED: 'procurement.weighing_started',
  WEIGHT_RECORDED: 'procurement.weight_recorded',
  QUALITY_RECORDED: 'procurement.quality_recorded',
  PROCUREMENT_COMPLETED: 'procurement.completed',
  PAYMENT_COMPUTED: 'payment.computed',
  PAYMENT_BLOCKED: 'payment.blocked',
  PAYMENT_STATUS_UPDATED: 'payment.status_updated',
  NOTIFICATION_DISPATCHED: 'notification.dispatched',
  CENTRE_CREATED: 'centre.created',
  CENTRE_UPDATED: 'centre.updated',
  CENTRE_LANE_CONFIGURED: 'centre.lane_configured',
  CENTRE_HOURS_CONFIGURED: 'centre.hours_configured',
  CENTRE_HOLIDAY_SET: 'centre.holiday_set',
  CENTRE_CROP_CONFIGURED: 'centre.crop_configured',
  CENTRE_SLOT_CONFIGURED: 'centre.slot_configured',
  OFFICER_ASSIGNED: 'officer.assigned',
  OFFICER_ASSIGNMENT_REVOKED: 'officer.assignment_revoked',
  OFFICER_CREATED: 'officer.created',
  OFFICER_DEACTIVATED: 'officer.deactivated',
  OFFICER_REACTIVATED: 'officer.reactivated',
  OFFICER_REGISTRATION_REQUESTED: 'officer.registration_requested',
  OFFICER_REGISTRATION_APPROVED: 'officer.registration_approved',
  OFFICER_REGISTRATION_REJECTED: 'officer.registration_rejected',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export type AuditEntry = {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorRole?: 'FARMER' | 'OFFICER' | 'ADMIN' | 'SYSTEM' | null;
  actorIp?: string | null;
  requestId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

export async function writeAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (actor_user_id, actor_role, actor_ip, request_id,
        action, entity_type, entity_id, before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actorUserId ?? null,
      entry.actorRole ?? null,
      entry.actorIp ?? null,
      entry.requestId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(redact(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redact(entry.after)),
      JSON.stringify(redact(entry.metadata ?? {})),
    ],
  );
}
