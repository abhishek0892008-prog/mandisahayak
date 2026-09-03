/**
 * Server codes → translation keys.
 *
 * The backend returns stable machine codes and an English developer `message`
 * that the contract explicitly forbids showing a user (authentication.md §1.1).
 * Everything a farmer reads is therefore looked up here and rendered through
 * i18next, so both languages stay correct as codes are added.
 *
 * Every helper falls back to a generic translated string rather than leaking a
 * raw code onto the screen.
 */

/**
 * Every server vocabulary lives under a single `codes` root so a code name can
 * never collide with a hand-written UI label. `paymentStatus`, for one, already
 * existed as a screen heading.
 */
const NAMESPACES = {
  error: "codes.errors",
  field: "codes.fieldErrors",
  bookingStatus: "codes.bookingStatus",
  displayStatus: "codes.displayStatus",
  queueState: "codes.queueState",
  etaConfidence: "codes.etaConfidence",
  etaReason: "codes.etaReason",
  paymentStatus: "codes.paymentStatus",
  paymentBlocked: "codes.paymentBlocked",
  qualityStatus: "codes.qualityStatus",
  procurementStatus: "codes.procurementStatus",
  notification: "codes.notificationType",
  reason: "codes.reasonCode",
};

const GENERIC_ERROR = "codes.errors.INTERNAL_ERROR";

function lookup(t, namespace, code, fallbackKey) {
  if (!code) return t(fallbackKey);

  return t(`${namespace}.${code}`, { defaultValue: t(fallbackKey) });
}

/**
 * Turns any thrown API failure into a sentence. Rate limits and resend
 * cooldowns carry `retryAfterSeconds`, which is interpolated so the farmer is
 * told how long to wait rather than just that they must.
 */
export function translateError(t, error) {
  if (!error) return null;

  const code = error.code ?? "INTERNAL_ERROR";
  const seconds = error.details?.retryAfterSeconds;

  if (typeof seconds === "number" && seconds > 0) {
    return t(`${NAMESPACES.error}.${code}_RETRY`, {
      seconds: Math.ceil(seconds),
      defaultValue: t(`${NAMESPACES.error}.${code}`, {
        defaultValue: t(GENERIC_ERROR),
      }),
    });
  }

  return lookup(t, NAMESPACES.error, code, GENERIC_ERROR);
}

/**
 * Per-field validation codes arrive as `error.fields`, e.g.
 * `{ phone: "PHONE_INVALID_INDIAN_MOBILE" }`. Returns a map of field name to
 * translated text, ready to drop into form state.
 */
export function translateFieldErrors(t, error) {
  if (!error?.fields) return {};

  const result = {};

  for (const [field, code] of Object.entries(error.fields)) {
    result[field] = lookup(t, NAMESPACES.field, code, "codes.errors.VALIDATION_FAILED");
  }

  return result;
}

export const translateBookingStatus = (t, code) =>
  lookup(t, NAMESPACES.bookingStatus, code, "unknownStatus");

export const translateDisplayStatus = (t, code) =>
  lookup(t, NAMESPACES.displayStatus, code, "unknownStatus");

export const translateQueueState = (t, code) =>
  lookup(t, NAMESPACES.queueState, code, "unknownStatus");

export const translateEtaConfidence = (t, code) =>
  lookup(t, NAMESPACES.etaConfidence, code, "unknownStatus");

export const translateEtaReason = (t, code) =>
  lookup(t, NAMESPACES.etaReason, code, "codes.etaReason.UNKNOWN");

export const translatePaymentStatus = (t, code) =>
  lookup(t, NAMESPACES.paymentStatus, code, "unknownStatus");

export const translatePaymentBlocked = (t, code) =>
  lookup(t, NAMESPACES.paymentBlocked, code, "codes.paymentBlocked.UNKNOWN");

export const translateQualityStatus = (t, code) =>
  lookup(t, NAMESPACES.qualityStatus, code, "unknownStatus");

export const translateProcurementStatus = (t, code) =>
  lookup(t, NAMESPACES.procurementStatus, code, "unknownStatus");

export const translateNotificationType = (t, code) =>
  lookup(t, NAMESPACES.notification, code, "notifications");

export const translateReason = (t, code) =>
  lookup(t, NAMESPACES.reason, code, "codes.reasonCode.UNKNOWN");

/**
 * Booking statuses that mean the produce has been handled, so procurement and
 * payment screens have something real to show. Mirrors the queue membership
 * table in queue.md §3.
 */
export const PROCUREMENT_STARTED_STATUSES = new Set([
  "WEIGHING",
  "QUALITY_CHECK",
  "PROCUREMENT_RECORDED",
  "PAYMENT_PENDING",
  "COMPLETED",
]);

export const ACTIVE_BOOKING_STATUSES = new Set([
  "CONFIRMED",
  "ARRIVED",
  "WEIGHING",
  "QUALITY_CHECK",
  "PROCUREMENT_RECORDED",
  "PAYMENT_PENDING",
]);

export const TERMINAL_BOOKING_STATUSES = new Set(["COMPLETED", "CANCELLED", "NO_SHOW"]);

/** Colour intent per status, so every screen badges a status the same way. */
export function statusTone(status) {
  switch (status) {
    case "CONFIRMED":
    case "COMPLETED":
    case "PAID":
    case "ACCEPTED":
      return "success";
    case "CANCELLED":
    case "NO_SHOW":
    case "FAILED":
    case "REJECTED":
    case "BLOCKED":
      return "danger";
    case "ARRIVED":
    case "WEIGHING":
    case "QUALITY_CHECK":
    case "PROCUREMENT_RECORDED":
    case "PAYMENT_PENDING":
    case "INITIATED":
    case "PARTIALLY_ACCEPTED":
      return "progress";
    default:
      return "neutral";
  }
}
