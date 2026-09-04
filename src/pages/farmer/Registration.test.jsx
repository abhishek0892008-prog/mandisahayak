/**
 * The farmer registration screen, driven the way a brand-new farmer drives it:
 * signed out, with no session cookie and nothing cached.
 *
 * The district dropdown is the load-bearing part. `POST /auth/farmer/register/
 * start-otp` needs a districtId UUID, so a farmer who cannot populate this
 * select cannot register at all — the form is a dead end. These tests pin the
 * whole path: anonymous load, list rendered, district chosen, id submitted,
 * OTP screen reached.
 *
 * `GET /me` answers 401 in every case here on purpose. That is what the server
 * tells a signed-out visitor, and the screen must work through it rather than
 * around it.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import Registration from "./Registration";
import { renderBare } from "../../test/render";
import { created, fail, mockApi } from "../../test/server";
import { districts, villagesUnavailable } from "../../test/fixtures";

/** The endpoints a signed-out registration screen actually touches. */
function anonymousRoutes(overrides = {}) {
  return {
    "GET /auth/csrf": { csrfToken: "test-csrf-token" },
    // A signed-out visitor. Not an error — the expected answer.
    "GET /me": fail(401, "UNAUTHENTICATED"),
    "GET /reference/districts": districts,
    ...overrides,
  };
}

const districtSelect = () => screen.getByLabelText("District");

describe("Registration — district dropdown for an unauthenticated farmer", () => {
  it("populates the district list with no session", async () => {
    const api = mockApi(anonymousRoutes());

    renderBare(<Registration />, { route: "/register" });

    // Every district the server returned is selectable.
    await waitFor(() => {
      expect(within(districtSelect()).getByRole("option", { name: "Agra" })).toBeInTheDocument();
    });
    expect(within(districtSelect()).getByRole("option", { name: "Aligarh" })).toBeInTheDocument();

    // The failure banner this screen used to show must be absent.
    expect(screen.queryByText(/District list is unavailable right now/i)).not.toBeInTheDocument();

    // And the control is usable, not stuck disabled behind a pending load.
    expect(districtSelect()).toBeEnabled();

    // The request went out as an ordinary cookie-bearing GET. There is no
    // token to attach and none is attached: the endpoint is public.
    const call = api.lastCall("GET", "/reference/districts");
    expect(call).not.toBeNull();
    expect(call.credentials).toBe("include");
    expect(call.headers.authorization).toBeUndefined();
  });

  it("renders the districts even though GET /me returned 401", async () => {
    mockApi(anonymousRoutes());

    renderBare(<Registration />, { route: "/register" });

    await waitFor(() => {
      expect(within(districtSelect()).getByRole("option", { name: "Agra" })).toBeInTheDocument();
    });
  });

  it("submits the chosen district id and reaches the OTP step", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      anonymousRoutes({
        "GET /reference/villages": villagesUnavailable,
        "POST /auth/farmer/register/start-otp": created({
          challengeId: "6a3f8f2e-1c44-4a0b-9f7d-2b0a1c9d4e55",
          expiresAt: "2026-01-01T00:05:00.000Z",
          resendAvailableAt: "2026-01-01T00:01:00.000Z",
          attemptsRemaining: 5,
          otpLength: 4,
        }),
      }),
    );

    renderBare(<Registration />, { route: "/register" });

    await waitFor(() => {
      expect(within(districtSelect()).getByRole("option", { name: "Aligarh" })).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Full name"), "Sunita Devi");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.selectOptions(districtSelect(), "44444444-0000-4000-a000-000000000011");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Continue to OTP/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/farmer/register/start-otp")).not.toBeNull();
    });

    const submitted = api.lastCall("POST", "/auth/farmer/register/start-otp");
    // The id came from the dropdown, not from anything hardcoded on the client.
    expect(submitted.body.districtId).toBe("44444444-0000-4000-a000-000000000011");
    expect(submitted.body.phone).toBe("9812345678");
    expect(submitted.body.consent).toEqual({ policyVersion: "v1", accepted: true });
    expect(submitted.headers["x-csrf-token"]).toBe("test-csrf-token");
  });

  it("blocks Continue when no district is chosen, and never sends the request", async () => {
    const user = userEvent.setup();
    const api = mockApi(anonymousRoutes());

    renderBare(<Registration />, { route: "/register" });

    await waitFor(() => {
      expect(within(districtSelect()).getByRole("option", { name: "Agra" })).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Full name"), "Sunita Devi");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /Continue to OTP/i }));

    // Client-side validation stops it; the district is genuinely required and
    // is never defaulted to some convenient id.
    expect(api.countOf("POST", "/auth/farmer/register/start-otp")).toBe(0);
  });

  it("shows the failure banner and recovers on retry", async () => {
    const user = userEvent.setup();
    let attempt = 0;

    mockApi(
      anonymousRoutes({
        "GET /reference/districts": () => {
          attempt += 1;
          return attempt === 1 ? fail(500, "INTERNAL_ERROR") : districts;
        },
      }),
    );

    renderBare(<Registration />, { route: "/register" });

    // The state the bug report showed.
    await waitFor(() => {
      expect(screen.getByText(/District list is unavailable right now/i)).toBeInTheDocument();
    });
    // The select stays operable so retry is reachable without a page reload.
    expect(districtSelect()).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Try again/i }));

    await waitFor(() => {
      expect(within(districtSelect()).getByRole("option", { name: "Agra" })).toBeInTheDocument();
    });
    expect(screen.queryByText(/District list is unavailable right now/i)).not.toBeInTheDocument();
  });

  /*
   * The exact failure from the bug report. With nothing listening on the proxy
   * target, Vite answers `502 Bad Gateway` as text/plain. The screen used to
   * render "Something went wrong at our end", which reads as a backend fault
   * and cost two rounds of investigation aimed at the wrong system. It must
   * say the API could not be reached.
   */
  it("names an unreachable API as such, instead of blaming the server", async () => {
    globalThis.fetch = (url) => {
      if (String(url).includes("/reference/districts")) {
        return Promise.resolve({
          ok: false,
          status: 502,
          headers: { get: () => null },
          json: () => Promise.reject(new SyntaxError("Unexpected token B")),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: () => Promise.resolve({ error: { code: "UNAUTHENTICATED", message: "x" } }),
      });
    };

    renderBare(<Registration />, { route: "/register" });

    await waitFor(() => {
      expect(screen.getByText(/District list is unavailable right now/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Could not reach the server/i)).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong at our end/i)).not.toBeInTheDocument();
  });

  it("does not request the session-protected villages endpoint while signed out", async () => {
    const user = userEvent.setup();
    const api = mockApi(anonymousRoutes());

    renderBare(<Registration />, { route: "/register" });

    await waitFor(() => {
      expect(within(districtSelect()).getByRole("option", { name: "Agra" })).toBeInTheDocument();
    });

    await user.selectOptions(districtSelect(), "44444444-0000-4000-a000-000000000012");

    // `GET /reference/villages` requires `reference.read`, which a farmer only
    // holds once signed in. Calling it here can only ever produce a 401, and
    // villageId is optional at registration precisely because no village data
    // exists yet. Asking is pure noise on a public screen.
    await waitFor(() => {
      expect(districtSelect()).toHaveValue("44444444-0000-4000-a000-000000000012");
    });
    expect(api.countOf("GET", "/reference/villages")).toBe(0);
  });
});
