import { vi } from "vitest";

/**
 * Marks a handler result as a raw HTTP response rather than a 200 payload.
 *
 * A symbol, not a `status` property: real payloads legitimately carry `status`
 * ("ACTIVE" on a profile, "CONFIRMED" on a booking), so sniffing for that key
 * silently mangles them.
 */
const RESPONSE = Symbol("http-response");

/**
 * A fake API, routed the way the real one is.
 *
 * Tests declare handlers as "METHOD /path" and get back a recorder so they can
 * assert on what was actually sent — method, body, and headers such as
 * `x-csrf-token` and `idempotency-key`. Anything the routes do not cover
 * returns 404 in the real envelope rather than undefined, so a screen calling
 * an endpoint nobody stubbed fails visibly.
 */
export function mockApi(routes = {}) {
  const calls = [];

  const normalise = (value) =>
    typeof value === "function" ? value : () => value;

  const handlers = new Map(
    Object.entries(routes).map(([key, value]) => [key, normalise(value)]),
  );

  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();

    // The client builds absolute-ish paths from a "/api/v1" base.
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const [pathname, search = ""] = path.split("?");
    const route = pathname.replace(/^\/api\/v1/, "");

    const record = {
      method,
      route,
      search,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
      credentials: init.credentials,
    };

    calls.push(record);

    // Exact match first, then a pattern with :params.
    let handler = handlers.get(`${method} ${route}`);
    let params = {};

    if (!handler) {
      for (const [key, candidate] of handlers) {
        const [candidateMethod, pattern] = key.split(" ");
        if (candidateMethod !== method) continue;

        const names = [];
        const regex = new RegExp(
          `^${pattern.replace(/:[^/]+/g, (match) => {
            names.push(match.slice(1));
            return "([^/]+)";
          })}$`,
        );

        const match = route.match(regex);
        if (match) {
          handler = candidate;
          names.forEach((name, index) => {
            params[name] = match[index + 1];
          });
          break;
        }
      }
    }

    if (!handler) {
      return response(404, { error: { code: "NOT_FOUND", message: "No such endpoint" } });
    }

    const result = await handler(record, params);

    // A bare object is a 200 payload; only a tagged result sets the status.
    if (result && typeof result === "object" && result[RESPONSE]) {
      return response(result.status, result.body ?? errorFor(result.status, result.code));
    }

    return response(200, { data: result });
  });

  return {
    calls,
    /** The last call to a route, for asserting on what was sent. */
    lastCall: (method, route) =>
      [...calls].reverse().find((call) => call.method === method && call.route === route) ?? null,
    countOf: (method, route) =>
      calls.filter((call) => call.method === method && call.route === route).length,
  };
}

function errorFor(status, code) {
  const fallback =
    { 400: "VALIDATION_FAILED", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND" }[
      status
    ] ?? "INTERNAL_ERROR";

  return { error: { code: code ?? fallback, message: "test error" } };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "test-request-id" },
    json: async () => body,
  };
}

/** An error result a route handler can return. */
export const fail = (status, code, extra = {}) => ({
  [RESPONSE]: true,
  status,
  body: { error: { code, message: "test error", ...extra } },
});

/** A success with a non-200 status, e.g. 201 from POST /bookings. */
export const created = (data) => ({
  [RESPONSE]: true,
  status: 201,
  body: { data },
});

/** The routes almost every authenticated screen needs. */
export function authenticatedRoutes(fixtures) {
  return {
    "GET /auth/csrf": { csrfToken: "test-csrf-token" },
    "GET /me": fixtures.me,
  };
}
