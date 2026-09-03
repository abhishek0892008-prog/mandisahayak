/**
 * OTP issue / verify / resend.
 *
 * The prototype let a user press "Verify & Continue" without entering anything.
 * Here the backend is authoritative: a session is created only after a challenge
 * is verified against a stored peppered HMAC, within its expiry, within its
 * attempt budget, and exactly once.
 */
import type { PoolClient } from 'pg';
import { getConfig } from '../../core/config.ts';
import { generateOtp, hashOtp, verifyOtp } from '../../core/crypto.ts';
import { AppError, ErrorCodes, unprocessable } from '../../core/errors.ts';
import { log, maskPhone } from '../../core/logging.ts';
import { recordDemoOtp } from './demoOtpStore.ts';

export type OtpPurpose = 'FARMER_REGISTER' | 'FARMER_LOGIN' | 'STAFF_2FA';

export type ChallengeView = {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
  attemptsRemaining: number;
  otpLength: number;
};

export type ChallengeRow = {
  id: string;
  purpose: OtpPurpose;
  phone_e164: string;
  user_id: string | null;
  pending_registration_id: string | null;
  otp_hash: Buffer;
  expires_at: Date;
  attempts: number;
  max_attempts: number;
  resend_count: number;
  max_resends: number;
  last_sent_at: Date;
  consumed_at: Date | null;
  status: string;
};

/**
 * "Delivery". Phase 12 replaces this with the notification outbox and a real
 * SmsProvider. Until then the OTP is logged ONLY when DEMO_MODE is on, and it is
 * never placed in an API response in any mode.
 */
function deliverOtp(phone: string, otp: string, purpose: OtpPurpose): void {
  const cfg = getConfig();
  if (cfg.DEMO_MODE) {
    recordDemoOtp(phone, otp);
    // The redactor blanks any key matching /otp/i, so the value is written via a
    // neutral key. This is the ONLY place an OTP is ever emitted, and only in
    // DEMO_MODE, which refuses to coexist with NODE_ENV=production.
    log.warn(`DEMO_MODE OTP for ${maskPhone(phone)} (${purpose}): ${otp}`);
  } else {
    log.info('OTP issued', { purpose, phoneMasked: maskPhone(phone) });
  }
}

export function toView(row: {
  id: string;
  expires_at: Date;
  last_sent_at: Date;
  attempts: number;
  max_attempts: number;
}): ChallengeView {
  const cfg = getConfig();
  return {
    challengeId: row.id,
    expiresAt: row.expires_at.toISOString(),
    resendAvailableAt: new Date(
      row.last_sent_at.getTime() + cfg.OTP_RESEND_COOLDOWN_SECONDS * 1000,
    ).toISOString(),
    attemptsRemaining: Math.max(0, row.max_attempts - row.attempts),
    otpLength: cfg.OTP_LENGTH,
  };
}

export async function issueChallenge(
  client: PoolClient,
  opts: {
    purpose: OtpPurpose;
    phone: string;
    userId?: string | null;
    pendingRegistrationId?: string | null;
    ip?: string | null;
    /** A decoy is stored and rate-limited like any other, but never delivered. */
    decoy?: boolean;
  },
): Promise<{ view: ChallengeView; otp: string | null }> {
  const cfg = getConfig();
  const otp = generateOtp(cfg.OTP_LENGTH);
  const expiresAt = new Date(Date.now() + cfg.OTP_TTL_SECONDS * 1000);

  const res = await client.query<{
    id: string;
    expires_at: Date;
    last_sent_at: Date;
    attempts: number;
    max_attempts: number;
  }>(
    `INSERT INTO otp_challenges
       (purpose, phone_e164, user_id, pending_registration_id, otp_hash,
        expires_at, max_attempts, max_resends, created_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, expires_at, last_sent_at, attempts, max_attempts`,
    [
      opts.purpose,
      opts.phone,
      opts.userId ?? null,
      opts.pendingRegistrationId ?? null,
      hashOtp(otp, cfg.OTP_PEPPER),
      expiresAt,
      cfg.OTP_MAX_ATTEMPTS,
      cfg.OTP_MAX_RESENDS,
      opts.ip ?? null,
    ],
  );

  if (!opts.decoy) deliverOtp(opts.phone, otp, opts.purpose);

  return { view: toView(res.rows[0]), otp: opts.decoy ? null : otp };
}

export async function loadChallengeForUpdate(
  client: PoolClient,
  challengeId: string,
): Promise<ChallengeRow | null> {
  const res = await client.query<ChallengeRow>(
    `SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE`,
    [challengeId],
  );
  return res.rows[0] ?? null;
}

export type VerifyOutcome =
  | { ok: true; row: ChallengeRow }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'CONSUMED' | 'EXHAUSTED' | 'WRONG' };

/**
 * Verifies and consumes a challenge.
 *
 * Every failure mode returns the same OTP_INVALID error to the caller so the
 * endpoint is not an oracle for "does this challenge exist / has it expired /
 * how many attempts are left". The distinction is kept internally for auditing.
 */
export async function verifyChallenge(
  client: PoolClient,
  challengeId: string,
  otp: string,
): Promise<VerifyOutcome> {
  const cfg = getConfig();
  const row = await loadChallengeForUpdate(client, challengeId);

  if (!row) return { ok: false, reason: 'NOT_FOUND' };

  if (row.consumed_at || row.status === 'CONSUMED') return { ok: false, reason: 'CONSUMED' };

  if (row.status === 'FAILED' || row.attempts >= row.max_attempts) {
    return { ok: false, reason: 'EXHAUSTED' };
  }

  if (row.expires_at <= new Date() || row.status === 'EXPIRED') {
    await client.query(`UPDATE otp_challenges SET status = 'EXPIRED' WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'EXPIRED' };
  }

  if (!verifyOtp(otp, cfg.OTP_PEPPER, row.otp_hash)) {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= row.max_attempts;
    await client.query(
      `UPDATE otp_challenges SET attempts = $2, status = CASE WHEN $3 THEN 'FAILED' ELSE status END
        WHERE id = $1`,
      [row.id, attempts, exhausted],
    );
    return { ok: false, reason: exhausted ? 'EXHAUSTED' : 'WRONG' };
  }

  // One-time use: consumed in the same transaction that will create the session.
  await client.query(
    `UPDATE otp_challenges SET status = 'CONSUMED', consumed_at = now() WHERE id = $1`,
    [row.id],
  );

  return { ok: true, row };
}

export async function resendChallenge(
  client: PoolClient,
  challengeId: string,
): Promise<ChallengeView> {
  const cfg = getConfig();
  const row = await loadChallengeForUpdate(client, challengeId);

  // Same opaque error as a bad OTP: a caller cannot probe challenge existence.
  if (!row || row.consumed_at || row.status !== 'PENDING') {
    throw new AppError(400, ErrorCodes.OTP_CHALLENGE_NOT_FOUND, 'Challenge not resendable');
  }

  const cooldownEnds = new Date(row.last_sent_at.getTime() + cfg.OTP_RESEND_COOLDOWN_SECONDS * 1000);
  if (cooldownEnds > new Date()) {
    throw unprocessable(ErrorCodes.OTP_RESEND_COOLDOWN, 'Resend cooldown active', {
      retryAfterSeconds: Math.ceil((cooldownEnds.getTime() - Date.now()) / 1000),
    });
  }

  if (row.resend_count >= row.max_resends) {
    throw unprocessable(ErrorCodes.OTP_RESEND_LIMIT_REACHED, 'Resend limit reached');
  }

  // A resend issues a NEW code and invalidates the old one; it does not extend
  // the attempt budget.
  const otp = generateOtp(cfg.OTP_LENGTH);
  const res = await client.query<{
    id: string;
    expires_at: Date;
    last_sent_at: Date;
    attempts: number;
    max_attempts: number;
  }>(
    `UPDATE otp_challenges
        SET otp_hash = $2,
            expires_at = $3,
            resend_count = resend_count + 1,
            last_sent_at = now()
      WHERE id = $1
      RETURNING id, expires_at, last_sent_at, attempts, max_attempts`,
    [row.id, hashOtp(otp, cfg.OTP_PEPPER), new Date(Date.now() + cfg.OTP_TTL_SECONDS * 1000)],
  );

  deliverOtp(row.phone_e164, otp, row.purpose);
  return toView(res.rows[0]);
}
