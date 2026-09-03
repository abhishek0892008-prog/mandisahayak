/**
 * Test harness: boots the real app against a real PostgreSQL database and
 * drives it over real HTTP with a cookie jar.
 *
 * Nothing is mocked. These are integration tests because the properties under
 * test — session revocation, CSRF, rate limiting, audit immutability, RBAC —
 * only exist end to end.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/core/config.ts';
import { buildApp, verifyRouteProtection } from '../src/app.ts';
import { closePool, query, withTransaction } from '../src/core/db.ts';
import { hashPassword } from '../src/core/crypto.ts';
import { readDemoOtp } from '../src/modules/auth/demoOtpStore.ts';

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgres://fqverify@127.0.0.1:55432/farmqueue_test',
  OTP_PEPPER: 'test-otp-pepper-value-0123456789',
  SESSION_PEPPER: 'test-session-pepper-value-0123456789',
  CSRF_PEPPER: 'test-csrf-pepper-value-0123456789',
  DEMO_MODE: 'true',
  DEV_TOOLS_TOKEN: 'test-dev-token',
  COOKIE_SECURE: 'false',
  OTP_RESEND_COOLDOWN_SECONDS: '60',
  // The harness calls listen(0) itself; this value is never bound.
  PORT: '3999',
};

let server: Server | null = null;
let baseUrl = '';

export async function startTestServer(): Promise<string> {
  if (server) return baseUrl;
  Object.assign(process.env, TEST_ENV);
  loadConfig(process.env);

  const app = buildApp();
  await verifyRouteProtection();

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await closePool();
}

// ---------------------------------------------------------------------------
// HTTP client with a cookie jar
// ---------------------------------------------------------------------------

export type ApiResponse<T = unknown> = {
  status: number;
  body: { data?: T; error?: { code: string; message: string; fields?: Record<string, string>; details?: Record<string, unknown> } };
  headers: Headers;
};

export class Client {
  private jar = new Map<string, string>();
  private readonly base: string;

  // Explicit field assignment: TypeScript "parameter properties" are not
  // supported by Node's strip-only type stripping.
  constructor(base: string) {
    this.base = base;
  }

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  setCookie(name: string, value: string) {
    this.jar.set(name, value);
  }

  private absorb(res: Response) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      if (v === '') this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    const cookies = this.cookieHeader();
    if (cookies) headers['cookie'] = cookies;

    // Attach CSRF by default on mutating requests, unless explicitly disabled.
    const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
    if (mutating && opts.csrf !== false) {
      const token = this.jar.get('fq_csrf');
      if (token) headers['x-csrf-token'] = token;
    }

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    this.absorb(res);

    let body: ApiResponse<T>['body'] = {};
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { code: 'NON_JSON', message: text.slice(0, 200) } };
      }
    }
    return { status: res.status, body, headers: res.headers };
  }

  get<T = unknown>(path: string, headers?: Record<string, string>) {
    return this.request<T>('GET', path, { headers });
  }
  post<T = unknown>(path: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
    return this.request<T>('POST', path, { body, ...opts });
  }
  patch<T = unknown>(path: string, body?: unknown, opts: { csrf?: boolean } = {}) {
    return this.request<T>('PATCH', path, { body, ...opts });
  }

  /** Fetches a CSRF token so subsequent writes succeed. */
  async primeCsrf() {
    await this.get('/api/v1/auth/csrf');
    return this.jar.get('fq_csrf');
  }
}

export function newClient(base: string) {
  return new Client(base);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let phoneCounter = 0;
/**
 * Unique, valid Indian mobile numbers.
 *
 * The process-start component matters: users are never deleted (audit_logs has
 * ON DELETE RESTRICT on the actor), so a counter alone would collide with rows
 * left by a previous run against the same database.
 */
const PHONE_RUN_PREFIX = String(Date.now() % 100000).padStart(5, '0');
export function uniquePhone(): string {
  phoneCounter += 1;
  return `9${PHONE_RUN_PREFIX}${String(phoneCounter).padStart(4, '0')}`;
}

export async function getSeedDistrictId(): Promise<string> {
  const res = await query<{ id: string }>(`SELECT id FROM districts ORDER BY name LIMIT 1`);
  if (!res.rows[0]) throw new Error('No districts seeded; run import 0002 first.');
  return res.rows[0].id;
}

export async function createStaffUser(opts: {
  username: string;
  password: string;
  role: 'OFFICER' | 'ADMIN';
  phone: string;
  centreId?: string | null;
}): Promise<string> {
  return withTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, username, password_hash, phone_e164, phone_verified_at)
       VALUES ($1,$2,$3,$4, now()) RETURNING id`,
      [`${opts.role} ${opts.username}`, opts.username, hashPassword(opts.password), `+91${opts.phone}`],
    );
    const userId = user.rows[0].id;

    await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`,
      [userId, opts.role],
    );

    if (opts.role === 'OFFICER') {
      const officer = await client.query<{ id: string }>(
        `INSERT INTO officers (user_id, employee_code) VALUES ($1,$2) RETURNING id`,
        [userId, `EMP-${opts.username}`],
      );
      if (opts.centreId) {
        await client.query(
          `INSERT INTO officer_centre_assignments (officer_id, centre_id) VALUES ($1,$2)`,
          [officer.rows[0].id, opts.centreId],
        );
      }
    }

    return userId;
  });
}

export async function firstCentreId(): Promise<string | null> {
  const res = await query<{ id: string }>('SELECT id FROM procurement_centres ORDER BY code LIMIT 1');
  return res.rows[0]?.id ?? null;
}

/** Reads the OTP that DEMO_MODE captured in memory. Never touches the database. */
export function demoOtpFor(phoneDigits: string): string {
  const otp = readDemoOtp(`+91${phoneDigits}`);
  if (!otp) throw new Error(`No demo OTP recorded for +91${phoneDigits}`);
  return otp;
}

/** Registers and logs in a farmer, returning an authenticated client. */
export async function registerFarmer(base: string, phone = uniquePhone()) {
  const client = newClient(base);
  await client.primeCsrf();
  const districtId = await getSeedDistrictId();

  const start = await client.post<{ challengeId: string }>(
    '/api/v1/auth/farmer/register/start-otp',
    {
      fullName: 'Test Farmer',
      phone,
      districtId,
      locale: 'en',
      consent: { policyVersion: 'v1', accepted: true },
    },
  );
  if (start.status !== 201) {
    throw new Error(`registration failed: ${JSON.stringify(start.body)}`);
  }

  const verify = await client.post('/api/v1/auth/otp/verify', {
    challengeId: start.body.data!.challengeId,
    otp: demoOtpFor(phone),
  });
  if (verify.status !== 201) {
    throw new Error(`verification failed: ${JSON.stringify(verify.body)}`);
  }

  return { client, phone, districtId };
}

/**
 * Logs a staff user in through BOTH factors and returns the authenticated
 * client. Password alone never yields a session.
 */
export async function staffLogin(
  baseUrl: string,
  username: string,
  password: string,
  phone: string,
) {
  const c = newClient(baseUrl);
  await c.primeCsrf();
  const step1 = await c.post<{ challengeId: string }>('/api/v1/auth/staff/login', {
    username,
    password,
  });
  if (step1.status !== 201) throw new Error(`staff login failed: ${JSON.stringify(step1.body)}`);
  const step2 = await c.post('/api/v1/auth/otp/verify', {
    challengeId: step1.body.data!.challengeId,
    otp: demoOtpFor(phone),
  });
  if (step2.status !== 201) throw new Error(`staff 2FA failed: ${JSON.stringify(step2.body)}`);
  return c;
}

/**
 * Clears rate-limit buckets between tests.
 *
 * Every test drives the API from 127.0.0.1, so the per-IP limits (correctly)
 * fire after a handful of registrations. Rather than weakening the limits for
 * tests — which would stop them being the limits that actually ship — the
 * counters are reset between tests, and the dedicated rate-limit test exercises
 * enforcement within a single test body.
 */
export async function resetRateLimits(): Promise<void> {
  await query('DELETE FROM rate_limit_buckets');
}

export { query, withTransaction };
