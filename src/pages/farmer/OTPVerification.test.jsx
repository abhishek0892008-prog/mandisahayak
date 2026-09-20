/**
 * The OTP screen.
 *
 * The property under test is that the screen has NO opinion of its own about
 * how long an OTP is. The server issues the code and states its length in the
 * challenge (`otpLength`, from OTP_LENGTH in server/src/core/config.ts); the
 * UI renders exactly that many boxes. It used to hardcode 6, which meant the
 * backend and the frontend each carried their own definition and a change to
 * one silently broke the other.
 *
 * That is why these tests assert against a challenge, not against the number
 * four: changing OTP_LENGTH must not require editing this file.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import OTPVerification from "./OTPVerification";
import { renderScreen } from "../../test/render";
import { created, fail, mockApi } from "../../test/server";
import * as fixtures from "../../test/fixtures";

const PHONE = "9812345678";

function challengeOf(otpLength) {
  return { ...fixtures.otpChallenge, otpLength };
}

function routes(overrides = {}) {
  return {
    "GET /auth/csrf": { csrfToken: "test-csrf-token" },
    "GET /me": fail(401, "UNAUTHENTICATED"),
    ...overrides,
  };
}

function renderOtp(challenge, { purpose = "register" } = {}) {
  return renderScreen(<OTPVerification />, {
    route: "/verify-otp",
    state: { challenge, phone: PHONE, purpose },
  });
}

const boxes = () => screen.getAllByRole("textbox", { name: /OTP digit/i });

describe("OTP screen renders the length the server issued", () => {
  it("shows four boxes for a four-digit challenge", async () => {
    mockApi(routes());

    renderOtp(challengeOf(4));

    await waitFor(() => expect(boxes()).toHaveLength(4));
  });

  it("follows the server rather than a hardcoded constant", async () => {
    // Same component, a different server-stated length. If the count were
    // hardcoded anywhere on the client, one of these two must fail.
    mockApi(routes());

    renderOtp(challengeOf(6));

    await waitFor(() => expect(boxes()).toHaveLength(6));
  });

  it("states the length in the instruction text too", async () => {
    mockApi(routes());

    renderOtp(challengeOf(4));

    await waitFor(() => {
      expect(screen.getByText(/sent a 4-digit OTP to/i)).toBeInTheDocument();
    });
  });

  it("verifies a complete four-digit code", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({
        "POST /auth/otp/verify": created({ userId: fixtures.me.userId }),
      }),
    );

    renderOtp(challengeOf(4));
    await waitFor(() => expect(boxes()).toHaveLength(4));

    for (const [index, digit] of [..."4821"].entries()) {
      await user.type(boxes()[index], digit);
    }

    await user.click(screen.getByRole("button", { name: /Verify/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/otp/verify")).not.toBeNull();
    });
    expect(api.lastCall("POST", "/auth/otp/verify").body.otp).toBe("4821");
  });

  it("refuses to submit a partial code, and says how many digits are needed", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());

    renderOtp(challengeOf(4));
    await waitFor(() => expect(boxes()).toHaveLength(4));

    await user.type(boxes()[0], "4");
    await user.type(boxes()[1], "8");
    await user.click(screen.getByRole("button", { name: /Verify/i }));

    expect(api.countOf("POST", "/auth/otp/verify")).toBe(0);
    expect(screen.getByText(/complete 4-digit OTP/i)).toBeInTheDocument();
  });

  it("pastes a four-digit code and submits it", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({
        "POST /auth/otp/verify": created({ userId: fixtures.me.userId }),
      }),
    );

    renderOtp(challengeOf(4));
    await waitFor(() => expect(boxes()).toHaveLength(4));

    boxes()[0].focus();
    await user.paste("4821");

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/otp/verify")).not.toBeNull();
    });
    expect(api.lastCall("POST", "/auth/otp/verify").body.otp).toBe("4821");
  });

  /*
   * The farmer should not have to find a button after typing the last digit.
   * These pin that the screen submits on completion, once, and still refuses
   * an incomplete code.
   */
  it("submits on its own as soon as the last digit is entered", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({
        "POST /auth/otp/verify": created({ userId: fixtures.me.userId }),
      }),
    );

    renderOtp(challengeOf(4));
    await waitFor(() => expect(boxes()).toHaveLength(4));

    for (const [i, d] of [..."4821"].entries()) {
      await user.type(boxes()[i], d);
    }
    // No click on Verify anywhere in this test.

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/otp/verify")).not.toBeNull();
    });
    expect(api.lastCall("POST", "/auth/otp/verify").body.otp).toBe("4821");
    expect(api.countOf("POST", "/auth/otp/verify")).toBe(1);
  });

  it("does not submit until the code is complete", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());

    renderOtp(challengeOf(4));
    await waitFor(() => expect(boxes()).toHaveLength(4));

    await user.type(boxes()[0], "4");
    await user.type(boxes()[1], "8");
    await user.type(boxes()[2], "2");

    expect(api.countOf("POST", "/auth/otp/verify")).toBe(0);
  });

  it("clears the boxes on a rejected code and does not resubmit it", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({ "POST /auth/otp/verify": fail(400, "OTP_INVALID") }),
    );

    renderOtp(challengeOf(4));
    await waitFor(() => expect(boxes()).toHaveLength(4));

    for (const [i, d] of [..."1111"].entries()) {
      await user.type(boxes()[i], d);
    }

    await waitFor(() => {
      expect(api.countOf("POST", "/auth/otp/verify")).toBe(1);
    });
    // Emptied, so the auto-submit cannot loop on a code the server rejected.
    await waitFor(() => {
      expect(boxes().map((b) => b.value)).toEqual(["", "", "", ""]);
    });
    expect(api.countOf("POST", "/auth/otp/verify")).toBe(1);
  });
});

describe("demo OTP arrives with the challenge", () => {
  /*
   * The backend echoes the code it issued as `challenge.devOtp` when it runs
   * in DEMO_MODE. That needs no frontend flag, no dev token and no second
   * request — which is the point: the previous route to the same information
   * depended on all three and failed silently whenever any of them was wrong.
   */
  it("shows the code the server sent, above the input boxes", async () => {
    mockApi(routes());

    renderOtp({ ...challengeOf(4), devOtp: "4821" });

    await waitFor(() => {
      expect(screen.getByText("4821")).toBeInTheDocument();
    });

    // It reads unmistakably as a demo affordance, not a real SMS.
    expect(screen.getByText(/Demo mode . use this OTP/i)).toBeInTheDocument();
    expect(screen.getByText(/No SMS is sent/i)).toBeInTheDocument();

    // Above the boxes, so it is read before they are filled.
    const panel = screen.getByText("4821");
    const firstBox = screen.getAllByRole("textbox", { name: /OTP digit/i })[0];
    expect(
      panel.compareDocumentPosition(firstBox) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("needs no second request when the challenge already carries the code", async () => {
    const api = mockApi(routes());

    renderOtp({ ...challengeOf(4), devOtp: "4821" });
    await waitFor(() => expect(screen.getByText("4821")).toBeInTheDocument());

    expect(api.countOf("GET", "/dev/last-otp")).toBe(0);
  });

  it("does not auto-fill the boxes", async () => {
    mockApi(routes());

    renderOtp({ ...challengeOf(4), devOtp: "4821" });
    await waitFor(() => expect(screen.getByText("4821")).toBeInTheDocument());

    // The demo still exercises the real typing path.
    const values = screen
      .getAllByRole("textbox", { name: /OTP digit/i })
      .map((b) => b.value);
    expect(values).toEqual(["", "", "", ""]);
  });

  it("sends what the user typed, not the displayed code", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({ "POST /auth/otp/verify": fail(400, "OTP_INVALID") }),
    );

    renderOtp({ ...challengeOf(4), devOtp: "4821" });
    await waitFor(() => expect(screen.getByText("4821")).toBeInTheDocument());

    // Deliberately type a DIFFERENT code from the one on screen.
    for (const [i, d] of [..."1111"].entries()) {
      await user.type(
        screen.getAllByRole("textbox", { name: /OTP digit/i })[i],
        d,
      );
    }
    await user.click(screen.getByRole("button", { name: /Verify/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/otp/verify")).not.toBeNull();
    });
    // The client never substitutes the demo code, and never assumes success.
    expect(api.lastCall("POST", "/auth/otp/verify").body.otp).toBe("1111");
  });

  it("verifies when the user types the displayed code", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({
        "POST /auth/otp/verify": created({ userId: fixtures.me.userId }),
      }),
    );

    renderOtp({ ...challengeOf(4), devOtp: "4821" });
    await waitFor(() => expect(screen.getByText("4821")).toBeInTheDocument());

    for (const [i, d] of [..."4821"].entries()) {
      await user.type(
        screen.getAllByRole("textbox", { name: /OTP digit/i })[i],
        d,
      );
    }
    await user.click(screen.getByRole("button", { name: /Verify/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/otp/verify")).not.toBeNull();
    });
    expect(api.lastCall("POST", "/auth/otp/verify").body.otp).toBe("4821");
  });

  it("shows no panel when no demo code is available", async () => {
    // Production shape: the challenge carries no devOtp. `/dev/last-otp` is
    // unstubbed here, so it 404s exactly as it does with DEMO_MODE off, and
    // the screen must then show nothing rather than an empty demo box.
    mockApi(routes());

    renderOtp(challengeOf(4));
    await waitFor(() => {
      expect(
        screen.getAllByRole("textbox", { name: /OTP digit/i }),
      ).toHaveLength(4);
    });

    expect(
      screen.queryByText(/Demo mode . use this OTP/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No SMS is sent/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/No demo OTP is available for this number/i),
    ).toBeInTheDocument();
  });
});

describe("demo OTP is visible on screen when demo mode is on", () => {
  it("renders the issued code and fills the boxes on tap", async () => {
    // DEMO_OTP_ENABLED is read from import.meta.env when src/lib/api.js is
    // first evaluated, so the flags must be stubbed before a fresh import.
    vi.stubEnv("VITE_DEMO_OTP", "true");
    vi.stubEnv("VITE_DEV_OTP_TOKEN", "test-dev-token");
    vi.resetModules();

    const { default: DemoOtpScreen } = await import("./OTPVerification");
    const { renderScreen: renderFresh } = await import("../../test/render");
    const { mockApi: freshMockApi, fail: freshFail } =
      await import("../../test/server");

    const user = userEvent.setup();
    const api = freshMockApi({
      "GET /auth/csrf": { csrfToken: "test-csrf-token" },
      "GET /me": freshFail(401, "UNAUTHENTICATED"),
      "GET /dev/last-otp": { otp: "4821" },
      "POST /auth/otp/verify": created({ userId: fixtures.me.userId }),
    });

    renderFresh(<DemoOtpScreen />, {
      route: "/verify-otp",
      state: { challenge: challengeOf(4), phone: PHONE, purpose: "register" },
    });

    // The code appears on the display, which is the whole point of demo mode:
    // no SMS provider is configured, so it has to be readable somewhere.
    await waitFor(() => {
      expect(screen.getByText("4821")).toBeInTheDocument();
    });

    // It is fetched from the token-protected dev endpoint, never from the
    // authentication response — the OTP is never in an auth body by design.
    const reveal = api.lastCall("GET", "/dev/last-otp");
    expect(reveal).not.toBeNull();
    expect(reveal.headers["x-dev-token"]).toBe("test-dev-token");

    // One tap now fills AND submits, since a complete code auto-verifies.
    await user.click(screen.getByRole("button", { name: /Fill this code/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/otp/verify")).not.toBeNull();
    });
    expect(api.lastCall("POST", "/auth/otp/verify").body.otp).toBe("4821");

    vi.unstubAllEnvs();
  });
});
