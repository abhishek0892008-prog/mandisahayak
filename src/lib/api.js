/**
 * FarmQueue API client.
 *
 * Contract: docs/api/authentication.md §1.
 *
 *  - The session is an HttpOnly cookie. Nothing is stored client-side, so every
 *    request carries `credentials: "include"` and there is no token to keep.
 *  - Every write echoes the `fq_csrf` cookie in the `x-csrf-token` header.
 *  - Errors surface as `ApiError` carrying `code`/`fields`, never `message`:
 *    the UI is bilingual and translates the code, per §1.1.
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

const CSRF_COOKIE = "fq_csrf";
const CSRF_HEADER = "x-csrf-token";

/**
 * Demo-mode OTP reveal.
 *
 * No SMS provider is configured, so during a demo the code has to come from
 * somewhere. The backend already provides the sanctioned route: an in-memory,
 * token-protected, fully audited `GET /dev/last-otp` that only answers when the
 * server runs with `DEMO_MODE=true` — and the server refuses to boot with
 * `DEMO_MODE` and `NODE_ENV=production` together.
 *
 * This is a convenience, never a bypass: the OTP still has to be submitted to
 * `POST /auth/otp/verify`, which is the only thing that mints a session.
 */
export const DEMO_OTP_ENABLED = import.meta.env.VITE_DEMO_OTP === "true";

const DEV_TOOLS_TOKEN = import.meta.env.VITE_DEV_OTP_TOKEN ?? "";

/**
 * A failed request. `code` is the stable contract; switch on it.
 * `message` is for developers and is never rendered.
 */
export class ApiError extends Error {
  constructor(status, payload, requestId) {
    const error = payload?.error ?? {};
    super(error.message || `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = error.code || "INTERNAL_ERROR";
    this.fields = error.fields || null;
    this.details = error.details || null;
    this.requestId = error.requestId || requestId || null;
  }

  /** Seconds to wait, when the server said so (429, resend cooldown). */
  get retryAfterSeconds() {
    const value = this.details?.retryAfterSeconds;
    return typeof value === "number" ? value : null;
  }
}

/** The network never reached the server. Distinct from an error the server sent. */
export class NetworkError extends Error {
  constructor(cause) {
    super("Network request failed");
    this.name = "NetworkError";
    this.code = "NETWORK_UNAVAILABLE";
    this.status = 0;
    this.fields = null;
    this.details = null;
    this.cause = cause;
  }
}

function readCookie(name) {
  const prefix = `${name}=`;
  const hit = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));

  return hit ? decodeURIComponent(hit.slice(prefix.length)) : null;
}

/**
 * `GET /auth/csrf` sets the cookie. It is primed once at app start, and again
 * only if a write is rejected, so a rotated cookie self-heals instead of
 * stranding the user on a screen that will not submit.
 */
let csrfPriming = null;

export function primeCsrf() {
  if (!csrfPriming) {
    csrfPriming = request("GET", "/auth/csrf", { csrf: false }).catch((error) => {
      csrfPriming = null;
      throw error;
    });
  }

  return csrfPriming;
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

async function request(method, path, options = {}) {
  const { body, headers = {}, signal, csrf = true, query } = options;

  let url = `${BASE}${path}`;

  if (query) {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }

    const serialised = params.toString();
    if (serialised) url += `?${serialised}`;
  }

  const requestHeaders = { ...headers };

  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
  }

  if (csrf && MUTATING.has(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) requestHeaders[CSRF_HEADER] = token;
  }

  let response;

  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new NetworkError(cause);
  }

  if (response.status === 204) return null;

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload, response.headers.get("x-request-id"));
  }

  return payload?.data ?? payload ?? null;
}

/**
 * A write that re-primes the CSRF token once if the server rejects it. Any
 * other failure propagates untouched — only a CSRF rejection is retryable, and
 * only once, so a genuinely forged request cannot loop.
 */
async function write(method, path, options = {}) {
  try {
    return await request(method, path, options);
  } catch (error) {
    if (error instanceof ApiError && error.code === "CSRF_TOKEN_INVALID") {
      csrfPriming = null;
      await primeCsrf();
      return request(method, path, options);
    }

    throw error;
  }
}

/** Idempotency-Key is required on POST /bookings (bookings.md §5). */
export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) {
    return `fq-web-${globalThis.crypto.randomUUID()}`;
  }

  return `fq-web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export const api = {
  // -- authentication ------------------------------------------------------
  primeCsrf,

  registerStartOtp: (payload, signal) =>
    write("POST", "/auth/farmer/register/start-otp", { body: payload, signal }),

  loginStartOtp: (phone, signal) =>
    write("POST", "/auth/farmer/login/start-otp", { body: { phone }, signal }),

  verifyOtp: (challengeId, otp, signal) =>
    write("POST", "/auth/otp/verify", { body: { challengeId, otp }, signal }),

  resendOtp: (challengeId, signal) =>
    write("POST", "/auth/otp/resend", { body: { challengeId }, signal }),

  logout: (signal) => write("POST", "/auth/logout", { signal }),

  // -- profile -------------------------------------------------------------
  me: (signal) => request("GET", "/me", { signal }),

  updateMe: (patch, signal) => write("PATCH", "/me", { body: patch, signal }),

  // -- reference data ------------------------------------------------------
  districts: (signal) => request("GET", "/reference/districts", { signal }),

  villages: (districtId, signal) =>
    request("GET", "/reference/villages", { query: { districtId }, signal }),

  crops: (signal) => request("GET", "/reference/crops", { signal }),

  centres: (filters = {}, signal) =>
    request("GET", "/reference/centres", { query: filters, signal }),

  bookingConstraints: (signal) => request("GET", "/reference/booking-constraints", { signal }),

  // -- bookings ------------------------------------------------------------
  availability: (payload, signal) =>
    write("POST", "/bookings/availability", { body: payload, signal }),

  createBooking: (payload, idempotencyKey, signal) =>
    write("POST", "/bookings", {
      body: payload,
      headers: { "idempotency-key": idempotencyKey },
      signal,
    }),

  myBookings: (includeInactive = false, signal) =>
    request("GET", "/bookings/me", {
      query: includeInactive ? { includeInactive: "true" } : undefined,
      signal,
    }),

  booking: (bookingCode, signal) =>
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}`, { signal }),

  cancelBooking: (bookingCode, reason, signal) =>
    write("POST", `/bookings/${encodeURIComponent(bookingCode)}/cancel`, {
      body: reason ? { reason } : {},
      signal,
    }),

  // -- queue, procurement, payment -----------------------------------------
  queue: (bookingCode, signal) =>
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}/queue`, { signal }),

  procurement: (bookingCode, signal) =>
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}/procurement`, { signal }),

  payment: (bookingCode, signal) =>
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}/payment`, { signal }),

  // -- notifications -------------------------------------------------------
  notifications: (options = {}, signal) =>
    request("GET", "/notifications", { query: options, signal }),

  unreadCount: (signal) => request("GET", "/notifications/unread-count", { signal }),

  markNotificationRead: (id, signal) =>
    write("POST", `/notifications/${encodeURIComponent(id)}/read`, { signal }),

  markAllNotificationsRead: (signal) => write("POST", "/notifications/read-all", { signal }),

  notificationPreferences: (signal) => request("GET", "/notifications/preferences", { signal }),

  /**
   * Sets ONE preference. `event: null` means the whole channel.
   *
   * The server returns the complete preference set afterwards, so the caller
   * replaces its state with the response rather than patching it locally.
   */
  setNotificationPreference: ({ channel, event = null, enabled }, signal) =>
    write("PUT", "/notifications/preferences", {
      body: { channel, event, enabled },
      signal,
    }),

  /**
   * The last demo OTP for a phone, or null. Returns null instead of throwing
   * when demo mode is off, so callers can render nothing without branching on
   * an error.
   */
  devLastOtp: async (phone, signal) => {
    if (!DEMO_OTP_ENABLED || !DEV_TOOLS_TOKEN) return null;

    try {
      const result = await request("GET", "/dev/last-otp", {
        query: { phone },
        headers: { "x-dev-token": DEV_TOOLS_TOKEN },
        signal,
      });

      return result?.otp ?? null;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Demo mode off, wrong token, or code expired — all mean "no code to show".
      return null;
    }
  },
};

export default api;
