/**
 * Retry backoff — PURE.
 *
 * Exponential with a cap, so a provider outage does not turn into a tight loop
 * and a long outage does not push a notification a week into the future.
 *
 *   delay(attempt) = min(BASE * 2^(attempt-1), CAP)
 *
 * With BASE = 1 minute and CAP = 60 minutes:
 *   attempt 1 -> 1 min, 2 -> 2, 3 -> 4, 4 -> 8, 5 -> 16 ... capped at 60.
 *
 * These two numbers are the only invented values in the retry path, and they
 * are operational tuning rather than policy: they change WHEN a retry happens,
 * never WHETHER a farmer is told something or what they are told. Both are
 * configurable; the defaults are documented in `.env.example`.
 */

export type BackoffConfig = {
  baseMinutes: number;
  capMinutes: number;
};

export const DEFAULT_BACKOFF: BackoffConfig = { baseMinutes: 1, capMinutes: 60 };

/** Delay in minutes before attempt number `attempt` (1-based) may be retried. */
export function backoffMinutes(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF): number {
  if (attempt < 1) return cfg.baseMinutes;
  const raw = cfg.baseMinutes * 2 ** (attempt - 1);
  return Math.min(raw, cfg.capMinutes);
}

/** When a row that has just failed its `attempt`-th try becomes eligible again. */
export function nextAttemptAt(
  now: Date,
  attempt: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
): Date {
  return new Date(now.getTime() + backoffMinutes(attempt, cfg) * 60_000);
}

/**
 * Whether another attempt is permitted.
 *
 * `attempts` is the count ALREADY made. The schema's
 * `notifications_attempts_within_limit` CHECK independently guarantees the
 * ceiling, so an infinite retry loop is impossible even if this is wrong.
 */
export function mayRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}
