/**
 * Error model.
 *
 * PRINCIPLE P-8: the API returns stable machine-readable CODES, never English
 * prose as the contract. The UI is bilingual (en/hi); a backend that returns
 * "Quantity must be between..." is a backend that cannot be translated.
 *
 * `message` exists for developers and logs. It must never be rendered to a user.
 */

export const ErrorCodes = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_JSON: 'MALFORMED_JSON',

  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',

  // 404
  NOT_FOUND: 'NOT_FOUND',

  // 409
  PHONE_ALREADY_REGISTERED: 'PHONE_ALREADY_REGISTERED',

  // 410 / 422
  OTP_INVALID: 'OTP_INVALID',
  OTP_CHALLENGE_NOT_FOUND: 'OTP_CHALLENGE_NOT_FOUND',
  OTP_RESEND_COOLDOWN: 'OTP_RESEND_COOLDOWN',
  OTP_RESEND_LIMIT_REACHED: 'OTP_RESEND_LIMIT_REACHED',
  DISTRICT_NOT_FOUND: 'DISTRICT_NOT_FOUND',
  VILLAGE_NOT_IN_DISTRICT: 'VILLAGE_NOT_IN_DISTRICT',

  // Booking (Phase 7)
  CENTRE_NOT_AVAILABLE: 'CENTRE_NOT_AVAILABLE',
  CROP_NOT_CONFIGURED_AT_CENTRE: 'CROP_NOT_CONFIGURED_AT_CENTRE',
  CENTRE_CLOSED_ON_DATE: 'CENTRE_CLOSED_ON_DATE',
  OUTSIDE_BOOKING_HORIZON: 'OUTSIDE_BOOKING_HORIZON',
  NO_AVAILABILITY: 'NO_AVAILABILITY',
  SLOT_NO_LONGER_AVAILABLE: 'SLOT_NO_LONGER_AVAILABLE',
  DUPLICATE_ACTIVE_BOOKING: 'DUPLICATE_ACTIVE_BOOKING',
  FARMER_TIME_CONFLICT: 'FARMER_TIME_CONFLICT',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  CANCELLATION_WINDOW_CLOSED: 'CANCELLATION_WINDOW_CLOSED',

  // Officer operations and payment (Phase 8)
  PROCUREMENT_NOT_STARTED: 'PROCUREMENT_NOT_STARTED',
  WEIGHT_ALREADY_RECORDED: 'WEIGHT_ALREADY_RECORDED',
  QUANTITY_EXCEEDS_GROSS: 'QUANTITY_EXCEEDS_GROSS',
  REJECTION_REASON_REQUIRED: 'REJECTION_REASON_REQUIRED',
  REJECTION_REASON_NOT_APPLICABLE: 'REJECTION_REASON_NOT_APPLICABLE',
  PAYMENT_NOT_READY: 'PAYMENT_NOT_READY',
  PAYMENT_BLOCKED: 'PAYMENT_BLOCKED',
  PAYMENT_REFERENCE_REQUIRED: 'PAYMENT_REFERENCE_REQUIRED',
  INVALID_PAYMENT_TRANSITION: 'INVALID_PAYMENT_TRANSITION',

  // Admin configuration (Phase 13)
  CENTRE_CODE_TAKEN: 'CENTRE_CODE_TAKEN',
  CENTRE_HAS_ACTIVE_BOOKINGS: 'CENTRE_HAS_ACTIVE_BOOKINGS',
  LANE_HAS_ACTIVE_BOOKINGS: 'LANE_HAS_ACTIVE_BOOKINGS',
  DATE_HAS_ACTIVE_BOOKINGS: 'DATE_HAS_ACTIVE_BOOKINGS',
  OFFICER_INACTIVE: 'OFFICER_INACTIVE',

  // Officer provisioning (Phase 14)
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  EMPLOYEE_CODE_TAKEN: 'EMPLOYEE_CODE_TAKEN',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',

  // 500 / 503
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    opts: { fields?: Record<string, string>; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = opts.fields;
    this.details = opts.details;
  }
}

export const badRequest = (code: ErrorCode, message: string, fields?: Record<string, string>) =>
  new AppError(400, code, message, { fields });

export const unauthenticated = (code: ErrorCode = ErrorCodes.UNAUTHENTICATED, message = 'Authentication required') =>
  new AppError(401, code, message);

export const forbidden = (code: ErrorCode = ErrorCodes.FORBIDDEN, message = 'Not permitted', details?: Record<string, unknown>) =>
  new AppError(403, code, message, { details });

/**
 * Deliberately used for "exists but you may not see it" as well as "does not
 * exist" (architecture §5.2), so identifiers cannot be probed for existence.
 */
export const notFound = (message = 'Not found') => new AppError(404, ErrorCodes.NOT_FOUND, message);

export const conflict = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, { details });

export const unprocessable = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new AppError(422, code, message, { details });

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, ErrorCodes.RATE_LIMITED, 'Rate limit exceeded', {
    details: { retryAfterSeconds },
  });
