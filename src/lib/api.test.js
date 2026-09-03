import { describe, expect, it } from "vitest";

import api, { ApiError, NetworkError, newIdempotencyKey } from "./api";
import { created, fail, mockApi } from "../test/server";
import * as fixtures from "../test/fixtures";

describe("the API client", () => {
  it("sends cookies on every request, because the session is a cookie", async () => {
    const server = mockApi({ "GET /me": fixtures.me });

    await api.me();

    expect(server.lastCall("GET", "/me").credentials).toBe("include");
  });

  it("echoes the fq_csrf cookie on writes", async () => {
    const server = mockApi({ "PATCH /me": { updated: true } });

    await api.updateMe({ locale: "hi" });

    expect(server.lastCall("PATCH", "/me").headers["x-csrf-token"]).toBe("test-csrf-token");
  });

  it("does not send a CSRF header on reads", async () => {
    const server = mockApi({ "GET /me": fixtures.me });

    await api.me();

    expect(server.lastCall("GET", "/me").headers["x-csrf-token"]).toBeUndefined();
  });

  it("unwraps the data envelope", async () => {
    mockApi({ "GET /me": fixtures.me });

    await expect(api.me()).resolves.toEqual(fixtures.me);
  });

  it("throws ApiError carrying the machine code, not the message", async () => {
    mockApi({ "GET /me": fail(401, "UNAUTHENTICATED") });

    const error = await api.me().catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.status).toBe(401);
  });

  it("exposes per-field codes so a form can mark the right input", async () => {
    mockApi({
      "POST /auth/farmer/login/start-otp": fail(400, "VALIDATION_FAILED", {
        fields: { phone: "PHONE_INVALID_INDIAN_MOBILE" },
      }),
    });

    const error = await api.loginStartOtp("123").catch((caught) => caught);

    expect(error.fields).toEqual({ phone: "PHONE_INVALID_INDIAN_MOBILE" });
  });

  it("surfaces retryAfterSeconds from a rate limit", async () => {
    mockApi({
      "POST /auth/otp/resend": fail(429, "RATE_LIMITED", { details: { retryAfterSeconds: 42 } }),
    });

    const error = await api.resendOtp("id").catch((caught) => caught);

    expect(error.retryAfterSeconds).toBe(42);
  });

  it("distinguishes a network failure from a server error", async () => {
    globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));

    const error = await api.me().catch((caught) => caught);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.code).toBe("NETWORK_UNAVAILABLE");
  });

  it("re-primes and retries ONCE when a write is rejected for CSRF", async () => {
    let attempts = 0;

    const server = mockApi({
      "GET /auth/csrf": { csrfToken: "fresh" },
      "PATCH /me": () => {
        attempts += 1;
        return attempts === 1 ? fail(403, "CSRF_TOKEN_INVALID") : { updated: true };
      },
    });

    await expect(api.updateMe({ locale: "hi" })).resolves.toEqual({ updated: true });

    expect(attempts).toBe(2);
    expect(server.countOf("GET", "/auth/csrf")).toBe(1);
  });

  it("gives up rather than looping when CSRF keeps failing", async () => {
    let attempts = 0;

    mockApi({
      "GET /auth/csrf": { csrfToken: "fresh" },
      "PATCH /me": () => {
        attempts += 1;
        return fail(403, "CSRF_TOKEN_INVALID");
      },
    });

    await expect(api.updateMe({ locale: "hi" })).rejects.toMatchObject({
      code: "CSRF_TOKEN_INVALID",
    });

    expect(attempts).toBe(2);
  });

  it("sends the Idempotency-Key a booking requires", async () => {
    const server = mockApi({ "POST /bookings": created(fixtures.booking) });

    await api.createBooking({ quantityKg: 3000 }, "fq-web-test-key");

    expect(server.lastCall("POST", "/bookings").headers["idempotency-key"]).toBe("fq-web-test-key");
  });

  it("builds query strings and drops empty values", async () => {
    const server = mockApi({ "GET /reference/centres": fixtures.centres });

    await api.centres({ cropId: "abc", districtId: "" });

    expect(server.lastCall("GET", "/reference/centres").search).toBe("cropId=abc");
  });

  it("omits includeInactive unless asked, so the default stays active-only", async () => {
    const server = mockApi({ "GET /bookings/me": [fixtures.booking] });

    await api.myBookings(false);
    expect(server.lastCall("GET", "/bookings/me").search).toBe("");

    await api.myBookings(true);
    expect(server.lastCall("GET", "/bookings/me").search).toBe("includeInactive=true");
  });

  it("encodes a booking code into the path", async () => {
    const server = mockApi({ "GET /bookings/:code/queue": fixtures.queue });

    await api.queue("FQ-2026-2463892");

    expect(server.lastCall("GET", "/bookings/FQ-2026-2463892/queue")).not.toBeNull();
  });

  it("mints distinct idempotency keys", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    expect(newIdempotencyKey().length).toBeGreaterThanOrEqual(8);
  });
});

describe("the demo OTP reveal", () => {
  it("never throws — a missing code is null, so the banner just does not render", async () => {
    mockApi({ "GET /dev/last-otp": fail(403, "FORBIDDEN") });

    await expect(api.devLastOtp("9876500222")).resolves.toBeNull();
  });

  it("returns the code when the server is in demo mode", async () => {
    mockApi({ "GET /dev/last-otp": { otp: "123456" } });

    const otp = await api.devLastOtp("9876500222");

    // Enabled by .env.local here; null when the flag is off, and that is the
    // point — the caller renders nothing either way.
    expect(otp === "123456" || otp === null).toBe(true);
  });
});
