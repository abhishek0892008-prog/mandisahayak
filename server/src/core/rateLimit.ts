/**
 * Database-backed fixed-window rate limiting.
 *
 * In the database rather than in process memory so limits survive a restart and
 * hold across multiple API instances (architecture §4.7).
 *
 * CRITICAL DETAIL: the counter is incremented on its OWN connection, outside any
 * request transaction. If it shared the request's transaction, a failed login
 * would roll the increment back along with the failure — and an attacker would
 * get unlimited attempts precisely because they keep failing.
 */
import { query } from './db.ts';
import { rateLimited } from './errors.ts';

export type RateLimitRule = {
  /** Stable name, used to build the bucket key and to report which limit fired. */
  name: string;
  limit: number;
  windowSeconds: number;
};

/** The limits protecting authentication. Tunable without code changes elsewhere. */
export const RateLimits = {
  OTP_SEND_PER_PHONE: { name: 'otp_send_phone', limit: 3, windowSeconds: 15 * 60 },
  OTP_SEND_PER_PHONE_DAILY: { name: 'otp_send_phone_daily', limit: 10, windowSeconds: 24 * 60 * 60 },
  OTP_SEND_PER_IP: { name: 'otp_send_ip', limit: 20, windowSeconds: 60 * 60 },
  OTP_VERIFY_PER_IP: { name: 'otp_verify_ip', limit: 30, windowSeconds: 15 * 60 },
  REGISTER_PER_IP: { name: 'register_ip', limit: 10, windowSeconds: 60 * 60 },
  STAFF_LOGIN_PER_USERNAME: { name: 'staff_login_user', limit: 5, windowSeconds: 15 * 60 },
  STAFF_LOGIN_PER_IP: { name: 'staff_login_ip', limit: 30, windowSeconds: 60 * 60 },
  SESSION_PER_IP: { name: 'session_ip', limit: 60, windowSeconds: 15 * 60 },
  BOOKING_CREATE_PER_FARMER: { name: 'booking_create_farmer', limit: 10, windowSeconds: 60 * 60 },
  AVAILABILITY_PER_SESSION: { name: 'availability_session', limit: 120, windowSeconds: 15 * 60 },
  // Officer search accepts a phone number, which makes it an enumeration
  // surface even in authenticated staff hands. The limit is deliberately far
  // above what a busy centre needs, so it bounds scripted probing without ever
  // interrupting real work.
  OFFICER_SEARCH_PER_SESSION: { name: 'officer_search_session', limit: 240, windowSeconds: 15 * 60 },

  /**
   * Queue polling (Phase 9).
   *
   * THREAT MODEL: these endpoints are authenticated, ownership-scoped and
   * centre-scoped, and an unknown or foreign booking code returns 404
   * identically — so they are not enumeration oracles. The risk is resource
   * exhaustion: the SERVER advertises a 5-second poll cadence, so a compliant
   * client is a high-frequency client and a looping one looks identical until
   * it is counted.
   *
   * The limits are DERIVED, not picked. A 15-minute window is 900 seconds; at
   * the advertised pollAfterSeconds = 5 one compliant client issues 180
   * requests per window. 400 gives a farmer 2.2x headroom (a refresh, a second
   * tab, clock jitter); 900 gives an officer 5x, because a dashboard
   * legitimately watches a whole centre from more than one screen and blocking
   * it would stop the centre working.
   *
   * Neither limit can be reached by a client obeying pollAfterSeconds. That is
   * the design requirement: bound abuse without ever making the system
   * unusable.
   */
  QUEUE_READ_PER_SESSION: { name: 'queue_read_session', limit: 400, windowSeconds: 15 * 60 },
  OFFICER_QUEUE_PER_SESSION: { name: 'officer_queue_session', limit: 900, windowSeconds: 15 * 60 },

  /**
   * Notification feed (Phase 10). Ownership-scoped and authenticated, so not an
   * enumeration oracle; the risk is a client polling the feed in a loop. Sized
   * like the queue buckets: comfortably above any realistic UI refresh rate, so
   * it bounds abuse without ever interrupting a farmer checking their updates.
   */
  NOTIFICATION_READ_PER_SESSION: { name: 'notification_read_session', limit: 400, windowSeconds: 15 * 60 },

  /**
   * Public reference reads (districts only).
   *
   * The registration form must be able to list districts BEFORE a session
   * exists, so that one endpoint is unauthenticated. It returns public
   * government geography and no personal data, but an unauthenticated endpoint
   * still deserves a bound: a registration form loads it once, so 120 per 15
   * minutes per IP is far above legitimate use and well below abuse.
   */
  PUBLIC_REFERENCE_PER_IP: { name: 'public_reference_ip', limit: 120, windowSeconds: 15 * 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitOutcome = {
  allowed: boolean;
  rule: RateLimitRule;
  hits: number;
  retryAfterSeconds: number;
};

function windowStart(windowSeconds: number, now: Date): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Increments and evaluates one bucket. Returns the outcome rather than throwing,
 * so a caller can audit the rejection before surfacing it.
 */
export async function consume(
  rule: RateLimitRule,
  subject: string,
  now: Date = new Date(),
): Promise<RateLimitOutcome> {
  const start = windowStart(rule.windowSeconds, now);
  const expires = new Date(start.getTime() + rule.windowSeconds * 1000);
  const key = `${rule.name}:${subject}`;

  const res = await query<{ hits: number }>(
    `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, hits, expires_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (bucket_key, window_started_at)
     DO UPDATE SET hits = rate_limit_buckets.hits + 1
     RETURNING hits`,
    [key, start, expires],
  );

  const hits = res.rows[0]?.hits ?? 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000));

  return { allowed: hits <= rule.limit, rule, hits, retryAfterSeconds };
}

/** Evaluates several buckets; the first breach wins. */
export async function consumeAll(
  entries: ReadonlyArray<{ rule: RateLimitRule; subject: string }>,
): Promise<RateLimitOutcome | null> {
  for (const { rule, subject } of entries) {
    const outcome = await consume(rule, subject);
    if (!outcome.allowed) return outcome;
  }
  return null;
}

export function toError(outcome: RateLimitOutcome) {
  return rateLimited(outcome.retryAfterSeconds);
}

/** Housekeeping; a worker would call this. Exposed for tests. */
export async function purgeExpired(): Promise<number> {
  const res = await query('DELETE FROM rate_limit_buckets WHERE expires_at < now()');
  return res.rowCount ?? 0;
}
