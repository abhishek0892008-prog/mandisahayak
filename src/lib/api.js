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
  constructor(status, payload, requestId, envelopeParsed = true) {
    const error = payload?.error ?? {};
    super(error.message || `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    /*
     * Every FarmQueue failure is a JSON envelope: `errorHandler` in
     * server/src/core/http.ts has no other exit. So a failing response whose
     * body would not parse as JSON did not come from the API at all — it is
     * the dev-server proxy, a gateway or a static host answering because the
     * API could not be reached (Vite returns `502 Bad Gateway` as text/plain
     * when nothing is listening on the proxy target).
     *
     * Defaulting that to INTERNAL_ERROR reports "something went wrong at our
     * end", which blames the backend for failing when it was never reached —
     * and sends whoever debugs it looking for a server fault that does not
     * exist. NETWORK_UNAVAILABLE is the honest answer, and is already
     * translated.
     */
    this.code = error.code || (envelopeParsed ? "INTERNAL_ERROR" : "NETWORK_UNAVAILABLE");
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
  const hit = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));

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
    csrfPriming = request("GET", "/auth/csrf", { csrf: false }).catch(
      (error) => {
        csrfPriming = null;
        throw error;
      },
    );
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
  // Whether the body was the API's JSON envelope at all. A failing response
  // that is not JSON came from something in front of the API, not the API.
  let envelopeParsed = true;

  try {
    payload = await response.json();
  } catch {
    payload = null;
    envelopeParsed = false;
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload,
      response.headers.get("x-request-id"),
      envelopeParsed,
    );
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

/** One admin read under a centre. */
function adminCentreRead(centreId, resource, query, signal) {
  return request(
    "GET",
    `/admin/centres/${encodeURIComponent(centreId)}/${resource}`,
    {
      query,
      signal,
    },
  );
}

/** One officer lifecycle transition. All share a shape, so they share a helper. */
function officerAction(bookingCode, action, body, signal) {
  return write(
    "POST",
    `/officer/bookings/${encodeURIComponent(bookingCode)}/${action}`,
    {
      body: body ?? {},
      signal,
    },
  );
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

  /**
   * Active centres, name and district only, for the public officer
   * registration form. Deliberately narrower than `centres` below, which needs
   * a session because it exposes how a centre operates.
   */
  registrationCentres: (districtId, signal) =>
    request("GET", "/reference/registration-centres", {
      query: { districtId },
      signal,
    }),

  crops: (signal) => request("GET", "/reference/crops", { signal }),

  centres: (filters = {}, signal) =>
    request("GET", "/reference/centres", { query: filters, signal }),

  bookingConstraints: (signal) =>
    request("GET", "/reference/booking-constraints", { signal }),

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
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}/queue`, {
      signal,
    }),

  procurement: (bookingCode, signal) =>
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}/procurement`, {
      signal,
    }),

  payment: (bookingCode, signal) =>
    request("GET", `/bookings/${encodeURIComponent(bookingCode)}/payment`, {
      signal,
    }),

  // -- notifications -------------------------------------------------------
  notifications: (options = {}, signal) =>
    request("GET", "/notifications", { query: options, signal }),

  unreadCount: (signal) =>
    request("GET", "/notifications/unread-count", { signal }),

  markNotificationRead: (id, signal) =>
    write("POST", `/notifications/${encodeURIComponent(id)}/read`, { signal }),

  markAllNotificationsRead: (signal) =>
    write("POST", "/notifications/read-all", { signal }),

  // -- staff (officer / admin) ---------------------------------------------
  //
  // Officer login uses the same mobile OTP flow as farmer login.
  staffLogin: (phone, signal) =>
    write("POST", "/auth/staff/login", {
      body: { phone: `+91${phone}` },
      signal,
    }),

  /**
   * Applies for an officer account. This creates a REVIEW REQUEST, not an
   * account and not a session — the response is `{ status: "PENDING" }` and
   * the applicant cannot sign in until an administrator approves it.
   */
  staffRegister: (payload, signal) =>
    write("POST", "/auth/staff/register", { body: payload, signal }),

  officerCentres: (signal) => request("GET", "/officer/centres", { signal }),

  /** `date` defaults to today in the CENTRE's timezone, never the browser's. */
  centreBookings: (centreId, { date, status } = {}, signal) =>
    request(
      "GET",
      `/officer/centres/${encodeURIComponent(centreId)}/bookings`,
      {
        query: { date, status },
        signal,
      },
    ),

  centreQueue: (centreId, { date } = {}, signal) =>
    request("GET", `/officer/centres/${encodeURIComponent(centreId)}/queue`, {
      query: { date },
      signal,
    }),

  officerSearch: (query, signal) =>
    request("GET", "/officer/bookings/search", { query: { q: query }, signal }),

  officerBooking: (bookingCode, signal) =>
    request("GET", `/officer/bookings/${encodeURIComponent(bookingCode)}`, {
      signal,
    }),

  /**
   * Lifecycle transitions.
   *
   * None takes an Idempotency-Key and none needs one: a replayed `arrive`
   * finds the booking already ARRIVED and returns 409, which is the correct
   * answer to a double tap rather than a failure to handle one
   * (officer.md §1).
   */
  officerArrive: (bookingCode, signal) =>
    officerAction(bookingCode, "arrive", undefined, signal),

  officerNoShow: (bookingCode, signal) =>
    officerAction(bookingCode, "no-show", undefined, signal),

  officerStartWeighing: (bookingCode, signal) =>
    officerAction(bookingCode, "weighing", undefined, signal),

  officerRecordWeight: (bookingCode, grossQuantityKg, signal) =>
    officerAction(bookingCode, "weight", { grossQuantityKg }, signal),

  /** `qualityStatus` is derived server-side and is not in the request schema. */
  officerRecordQuality: (bookingCode, quality, signal) =>
    officerAction(bookingCode, "quality", quality, signal),

  officerComplete: (bookingCode, signal) =>
    officerAction(bookingCode, "complete", undefined, signal),

  officerCancel: (bookingCode, reason, signal) =>
    officerAction(bookingCode, "cancel", reason ? { reason } : {}, signal),

  officerSetPaymentStatus: (bookingCode, status, paymentReference, signal) =>
    officerAction(
      bookingCode,
      "payment",
      paymentReference ? { status, paymentReference } : { status },
      signal,
    ),

  // -- admin ---------------------------------------------------------------
  //
  // Every route here is ADMIN-only; an officer receives 403 on all of them,
  // reads included (admin.md §2). Nothing here can create OFFICIAL data —
  // every insert hardcodes CONFIGURED, and no request field could change that.
  adminCentres: (includeInactive = false, signal) =>
    request("GET", "/admin/centres", {
      query: includeInactive ? { includeInactive: "true" } : undefined,
      signal,
    }),

  adminCreateCentre: (centre, signal) =>
    write("POST", "/admin/centres", { body: centre, signal }),

  adminUpdateCentre: (centreId, patch, signal) =>
    write("PATCH", `/admin/centres/${encodeURIComponent(centreId)}`, {
      body: patch,
      signal,
    }),

  adminCentreLanes: (centreId, signal) =>
    adminCentreRead(centreId, "lanes", undefined, signal),

  adminSetLane: (centreId, lane, signal) =>
    write("PUT", `/admin/centres/${encodeURIComponent(centreId)}/lanes`, {
      body: lane,
      signal,
    }),

  adminCentreHours: (centreId, date, signal) =>
    adminCentreRead(centreId, "hours", date ? { date } : undefined, signal),

  adminSetHours: (centreId, hours, signal) =>
    write("PUT", `/admin/centres/${encodeURIComponent(centreId)}/hours`, {
      body: hours,
      signal,
    }),

  adminCentreHolidays: (centreId, signal) =>
    adminCentreRead(centreId, "holidays", undefined, signal),

  adminAddHoliday: (centreId, holiday, signal) =>
    write("POST", `/admin/centres/${encodeURIComponent(centreId)}/holidays`, {
      body: holiday,
      signal,
    }),

  adminRemoveHoliday: (centreId, date, signal) =>
    write(
      "DELETE",
      `/admin/centres/${encodeURIComponent(centreId)}/holidays/${encodeURIComponent(date)}`,
      { signal },
    ),

  adminCentreCrops: (centreId, signal) =>
    adminCentreRead(centreId, "crops", undefined, signal),

  adminSetCentreCrop: (centreId, crop, signal) =>
    write("PUT", `/admin/centres/${encodeURIComponent(centreId)}/crops`, {
      body: crop,
      signal,
    }),

  adminSlotConfig: (centreId, date, signal) =>
    adminCentreRead(
      centreId,
      "slot-config",
      date ? { date } : undefined,
      signal,
    ),

  adminSetSlotConfig: (centreId, config, signal) =>
    write("PUT", `/admin/centres/${encodeURIComponent(centreId)}/slot-config`, {
      body: config,
      signal,
    }),

  adminCentreOfficers: (centreId, signal) =>
    adminCentreRead(centreId, "officers", undefined, signal),

  adminAssignOfficer: (centreId, employeeCode, signal) =>
    write("POST", `/admin/centres/${encodeURIComponent(centreId)}/officers`, {
      body: { employeeCode },
      signal,
    }),

  adminRevokeOfficer: (centreId, employeeCode, signal) =>
    write(
      "DELETE",
      `/admin/centres/${encodeURIComponent(centreId)}/officers/${encodeURIComponent(employeeCode)}`,
      { signal },
    ),

  adminOfficers: (includeInactive = false, signal) =>
    request("GET", "/admin/officers", {
      query: includeInactive ? { includeInactive: "true" } : undefined,
      signal,
    }),

  adminOfficer: (employeeCode, signal) =>
    request("GET", `/admin/officers/${encodeURIComponent(employeeCode)}`, {
      signal,
    }),

  adminCreateOfficer: (officer, signal) =>
    write("POST", "/admin/officers", { body: officer, signal }),

  adminDeactivateOfficer: (employeeCode, reason, signal) =>
    write(
      "POST",
      `/admin/officers/${encodeURIComponent(employeeCode)}/deactivate`,
      {
        body: reason ? { reason } : {},
        signal,
      },
    ),

  adminReactivateOfficer: (employeeCode, signal) =>
    write(
      "POST",
      `/admin/officers/${encodeURIComponent(employeeCode)}/reactivate`,
      { signal },
    ),

  /** Phone numbers are masked to the last two digits by the server. */
  adminFarmers: (signal) => request("GET", "/admin/farmers", { signal }),

  /** `before_state`/`after_state` are deliberately not returned. */
  adminAuditLogs: (limit = 50, signal) =>
    request("GET", "/admin/audit-logs", { query: { limit }, signal }),

  // -- notifications -------------------------------------------------------
  notificationPreferences: (signal) =>
    request("GET", "/notifications/preferences", { signal }),

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
