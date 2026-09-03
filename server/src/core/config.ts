/**
 * Environment configuration.
 *
 * Parsed and validated once at startup. A missing or malformed variable stops
 * the process immediately rather than failing at 3 a.m. (architecture §21).
 */
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .refine((n) => Number.isInteger(n) && n > 0, 'must be a positive integer');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Secrets. These are REQUIRED — there is deliberately no default, because a
   * default pepper is the same as no pepper.
   */
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 characters'),
  SESSION_PEPPER: z.string().min(16, 'SESSION_PEPPER must be at least 16 characters'),
  CSRF_PEPPER: z.string().min(16, 'CSRF_PEPPER must be at least 16 characters'),

  /** OTP policy. Six digits is the approved product requirement (frontend shows six boxes). */
  OTP_LENGTH: int(6),
  OTP_TTL_SECONDS: int(300),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_RESEND_COOLDOWN_SECONDS: int(60),
  OTP_MAX_RESENDS: int(3),

  /** Session lifetimes, in seconds. Staff sessions are deliberately shorter. */
  FARMER_SESSION_IDLE_SECONDS: int(12 * 60 * 60),
  FARMER_SESSION_ABSOLUTE_SECONDS: int(7 * 24 * 60 * 60),
  STAFF_SESSION_IDLE_SECONDS: int(30 * 60),
  STAFF_SESSION_ABSOLUTE_SECONDS: int(12 * 60 * 60),

  PENDING_REGISTRATION_TTL_SECONDS: int(15 * 60),

  /**
   * How soon the server tells a queue client to poll again (architecture §14.5:
   * "pollAfterSeconds is set by the server, so cadence is an operational
   * decision and is not hardcoded in the UI").
   *
   * CONFIGURED, not OFFICIAL. It is an operational tuning knob and changes no
   * computed value — only the hint returned to the client. The default of 5 is
   * architecture §14.4's stated default for QUEUE_CACHE_TTL_SECONDS, which the
   * same section ties the polling cadence to. The queue rate limits in
   * core/rateLimit.ts are derived from this number.
   */
  QUEUE_POLL_AFTER_SECONDS: int(5),

  /**
   * DEMO_MODE surfaces OTPs to the server log and a token-protected dev
   * endpoint. It NEVER puts an OTP in an authentication response body.
   */
  DEMO_MODE: bool,
  ALLOW_DEMO_IN_PRODUCTION: bool,
  DEV_TOOLS_TOKEN: z.string().optional(),

  /** Cookies must be Secure in production; over plain HTTP in dev they cannot be. */
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type Config = z.infer<typeof ConfigSchema> & {
  cookieSecure: boolean;
  isProduction: boolean;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';

  // A demo build must never be mistaken for production.
  if (c.DEMO_MODE && isProduction && !c.ALLOW_DEMO_IN_PRODUCTION) {
    throw new Error(
      'DEMO_MODE is enabled with NODE_ENV=production. Refusing to start. ' +
        'Set ALLOW_DEMO_IN_PRODUCTION=true only if this is genuinely intended.',
    );
  }
  if (c.DEMO_MODE && !c.DEV_TOOLS_TOKEN) {
    throw new Error('DEMO_MODE requires DEV_TOOLS_TOKEN to protect the dev OTP endpoint.');
  }

  const config: Config = {
    ...c,
    isProduction,
    // __Host- cookies REQUIRE Secure, so in production this is forced on.
    cookieSecure: c.COOKIE_SECURE ?? isProduction,
  };

  cached = config;
  return config;
}

export function getConfig(): Config {
  if (!cached) throw new Error('Configuration has not been loaded yet.');
  return cached;
}
