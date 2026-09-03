import { describe, expect, it } from "vitest";

import i18n from "../i18n";
import {
  translateBookingStatus,
  translateError,
  translateEtaConfidence,
  translateFieldErrors,
  translatePaymentBlocked,
  translatePaymentStatus,
  translateReason,
  statusTone,
} from "./codes";

const t = i18n.getFixedT("en");
const th = i18n.getFixedT("hi");

describe("server codes become sentences, never raw codes", () => {
  it("translates a known error code", () => {
    expect(translateError(t, { code: "PHONE_ALREADY_REGISTERED" })).toMatch(/already registered/i);
  });

  it("falls back to a generic sentence for a code it has never seen", () => {
    const text = translateError(t, { code: "SOME_FUTURE_CODE" });

    expect(text).toBe(t("codes.errors.INTERNAL_ERROR"));
    expect(text).not.toContain("SOME_FUTURE_CODE");
  });

  it("interpolates retryAfterSeconds when the server sends one", () => {
    const text = translateError(t, {
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: 42 },
    });

    expect(text).toContain("42");
  });

  it("falls back to the plain variant when no _RETRY string exists", () => {
    const text = translateError(t, {
      code: "PHONE_ALREADY_REGISTERED",
      details: { retryAfterSeconds: 5 },
    });

    expect(text).toMatch(/already registered/i);
  });

  it("never renders the developer message", () => {
    const text = translateError(t, {
      code: "OTP_INVALID",
      message: "hashed_otp mismatch for challenge 1a2b",
    });

    expect(text).not.toContain("hashed_otp");
  });

  it("maps per-field codes onto field names", () => {
    const fields = translateFieldErrors(t, {
      fields: { phone: "PHONE_INVALID_INDIAN_MOBILE", fullName: "NAME_TOO_SHORT" },
    });

    expect(fields.phone).toMatch(/10-digit/i);
    expect(fields.fullName).toMatch(/full name/i);
  });

  it("returns an empty map when there are no field errors", () => {
    expect(translateFieldErrors(t, { code: "NOT_FOUND" })).toEqual({});
  });
});

describe("both languages are complete", () => {
  const codes = [
    "OTP_INVALID",
    "NO_AVAILABILITY",
    "CANCELLATION_WINDOW_CLOSED",
    "SLOT_NO_LONGER_AVAILABLE",
    "DUPLICATE_ACTIVE_BOOKING",
    "RATE_LIMITED",
    "NETWORK_UNAVAILABLE",
  ];

  it.each(codes)("translates %s in Hindi, not English fallback", (code) => {
    const english = translateError(t, { code });
    const hindi = translateError(th, { code });

    expect(hindi).not.toBe(english);
    expect(hindi).not.toBe(th("codes.errors.INTERNAL_ERROR"));
  });

  it("translates statuses in both languages", () => {
    expect(translateBookingStatus(t, "CONFIRMED")).toBe("Confirmed");
    expect(translateBookingStatus(th, "CONFIRMED")).not.toBe("Confirmed");
  });
});

describe("domain vocabularies", () => {
  it("translates payment status", () => {
    expect(translatePaymentStatus(t, "PAID")).toBe("Paid");
  });

  it("explains why a payment is blocked, in plain language", () => {
    expect(translatePaymentBlocked(t, "MSP_AMBIGUOUS")).toMatch(/grade/i);
    expect(translatePaymentBlocked(t, "NO_ACTIVE_MSP")).toMatch(/support price/i);
  });

  it("has a fallback for an unknown blocked reason", () => {
    expect(translatePaymentBlocked(t, "SOMETHING_NEW")).toBe(t("codes.paymentBlocked.UNKNOWN"));
  });

  it("labels ETA confidence so a projection is not read as a promise", () => {
    expect(translateEtaConfidence(t, "SCHEDULED")).toMatch(/reserved/i);
    expect(translateEtaConfidence(t, "PROJECTED")).toMatch(/estimate/i);
  });

  it("explains a reason code returned inside a 200", () => {
    expect(translateReason(t, "NO_VILLAGE_DATA_FOR_DISTRICT")).toMatch(/village/i);
    expect(translateReason(t, "NO_CAPACITY_DATA_FOR_CENTRE")).toMatch(/storage/i);
  });
});

describe("status tone", () => {
  it("treats terminal-good and terminal-bad differently", () => {
    expect(statusTone("PAID")).toBe("success");
    expect(statusTone("CANCELLED")).toBe("danger");
    expect(statusTone("WEIGHING")).toBe("progress");
    expect(statusTone("ANYTHING_ELSE")).toBe("neutral");
  });
});
