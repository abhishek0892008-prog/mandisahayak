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
  /**
   * DEMO ONLY. The OTP that was just issued, echoed so a demo can be completed
   * without an SMS provider. Absent unless DEMO_MODE is on — see attachDemoOtp.
   */
  devOtp?: string | null;
};

/**
 * Echoes the issued OTP back to the caller, but ONLY in demo mode.
 *
 * This deliberately relaxes the rule that an OTP never appears in an
 * authentication response body. No SMS provider is configured, so a demo
 * otherwise cannot be completed at all; the alternative in place before this
 * (a token-protected `/dev/last-otp` lookup) depended on four separate
 * switches lining up and failed silently whenever any of them did not.
 *
 * TWO THINGS THIS COSTS, both confined to demo mode:
 *
 *   1. Anyone who can reach the endpoint learns the OTP, so the OTP stops
 *      being a second factor at all. Demo mode already writes OTPs to the
 *      server log, so this is a wider audience, not a new kind of exposure.
 *   2. It must NOT become an enumeration oracle. An unknown phone gets a DECOY
 *      challenge, so the KEY is always present in demo mode and carries `null`
 *      when nothing was sent. The response shape is therefore identical for a
 *      registered and an unregistered number.
 *
 * THE INVARIANT THIS FUNCTION EXISTS TO HOLD: `devOtp` is the code that will
 * actually verify, or it is null. It is never a code that cannot work. A decoy
 * OTP is generated and hashed like any other but has no account behind it, so
 * `verifyChallenge` fails it closed — echoing it would put a code on screen
 * that is guaranteed to be rejected, which is precisely the bug this replaced.
 *
 * The first cost is not acceptable in production, which is why `loadConfig`
 * refuses to start with DEMO_MODE and NODE_ENV=production together. Kept as a
 * pure function of its arguments so both branches are directly testable
 * without standing up a second server.
 */
export function attachDemoOtp(
  view: ChallengeView,
  deliveredOtp: string | null,
  demoMode: boolean,
): ChallengeView {
  if (!demoMode) return view;
  return { ...view, devOtp: deliveredOtp };
}

/**
 * Whether a challenge is a DECOY — issued so an unregistered number is
 * indistinguishable from a registered one, but with no account behind it.
 *
 * Derived from the row rather than stored, and deliberately the SAME condition
 * `verifyChallenge` fails closed on (a non-registration challenge with no
 * user). Keeping one definition is the point: if "do not deliver" and "cannot
 * verify" were decided by different rules they would drift, and a code would
 * again be delivered that verification refuses.
 *
 * A FARMER_REGISTER challenge always has a null `user_id` — the account does
 * not exist yet — and is never a decoy, which is why purpose is checked first.
 */
export function isDecoyChallenge(row: {
  purpose: OtpPurpose;
  user_id: string | null;
}): boolean {
  return row.purpose !== 'FARMER_REGISTER' && row.user_id === null;
}

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

  const delivered = opts.decoy ? null : otp;
  return {
    view: attachDemoOtp(toView(res.rows[0]), delivered, cfg.DEMO_MODE),
    otp: delivered,
  };
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

  /*
   * THE BUG THIS FIXES: delivery used to be unconditional here, while
   * `issueChallenge` withholds a decoy's code. So a login for an unregistered
   * number sent nothing on the first request and then DELIVERED on resend —
   * putting a code on screen (and, in production, an SMS on a stranger's
   * phone) for a challenge that `verifyChallenge` refuses by design. The user
   * saw "that OTP is not correct" for a code the server had just handed them.
   */
  const decoy = isDecoyChallenge(row);
  if (!decoy) deliverOtp(row.phone_e164, otp, row.purpose);

  // A resend replaces the code, so the demo must be shown the NEW one — and
  // nothing at all when nothing was sent.
  return attachDemoOtp(toView(res.rows[0]), decoy ? null : otp, cfg.DEMO_MODE);
}
