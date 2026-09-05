/**
 * Request validation.
 *
 * The BACKEND defines the authoritative registration contract. The frontend
 * prototype's fields were inspected (Phase 0) but deliberately not copied:
 *
 *   frontend field   -> backend contract
 *   fullName         -> fullName            (kept)
 *   phone            -> phone               (kept, normalised to E.164)
 *   district         -> districtId          (an id, not a free-text name)
 *   village          -> villageId, optional (an id, not free text)
 *   aadhaarLast4     -> REMOVED             (Decision D-6)
 *   ifscCode         -> REMOVED             (Decision D-6/D-7)
 *   consent checkbox -> consent object, recorded with policy version and hash
 *
 * Nothing here trusts frontend validation; every rule is re-applied server-side.
 */
import { z } from "zod";

/**
 * Accepts what an Indian farmer would actually type — 10 digits, or with a
 * leading 0, +91, or 91 — and normalises to E.164. Normalisation happens once,
 * here, so the rest of the system only ever sees +91XXXXXXXXXX.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s()-]/g, ""))
  .superRefine((v, ctx) => {
    const digits = v.replace(/^\+/, "");
    if (!/^\d+$/.test(digits)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PHONE_NOT_NUMERIC",
      });
    }
  })
  .transform((v) => {
    let d = v.replace(/^\+/, "");
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10) d = `91${d}`;
    return `+${d}`;
  })
  .refine((v) => /^\+91[6-9]\d{9}$/.test(v), {
    message: "PHONE_INVALID_INDIAN_MOBILE",
  });

export const FullNameSchema = z
  .string()
  .trim()
  .min(2, "NAME_TOO_SHORT")
  .max(120, "NAME_TOO_LONG")
  .refine(
    (v) => /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u.test(v),
    "NAME_INVALID_CHARACTERS",
  );

export const LocaleSchema = z.enum(["en", "hi"]);

export const ConsentSchema = z.object({
  policyVersion: z.string().trim().min(1, "CONSENT_VERSION_REQUIRED").max(32),
  accepted: z.literal(true, {
    errorMap: () => ({ message: "CONSENT_REQUIRED" }),
  }),
});

export const RegisterStartSchema = z.object({
  fullName: FullNameSchema,
  phone: PhoneSchema,
  districtId: z.string().uuid("DISTRICT_ID_INVALID"),
  villageId: z.string().uuid("VILLAGE_ID_INVALID").optional().nullable(),
  locale: LocaleSchema.default("en"),
  consent: ConsentSchema,
});
export type RegisterStartInput = z.infer<typeof RegisterStartSchema>;

export const LoginStartSchema = z.object({
  phone: PhoneSchema,
});

export const OtpVerifySchema = z.object({
  challengeId: z.string().uuid("CHALLENGE_ID_INVALID"),
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, "OTP_FORMAT_INVALID"),
});

export const OtpResendSchema = z.object({
  challengeId: z.string().uuid("CHALLENGE_ID_INVALID"),
});

/**
 * Staff sign-in takes a phone number and NOTHING ELSE.
 *
 * There is no password factor: the officer portal signs in the way the farmer
 * portal does, and `startStaffLogin` reads no credential beyond this phone.
 * `users.password_hash` still exists and admin provisioning still sets one,
 * but no login path reads it. That makes OFFICER and ADMIN single-factor
 * accounts — see the staff-auth row in docs/phase-5-authentication.md before
 * relying on it.
 */
export const StaffLoginSchema = z.object({
  phone: PhoneSchema,
});

/**
 * An application for an officer account.
 *
 * A minimum password length is enforced here because this is the one path
 * where the password is chosen by the applicant rather than issued by an
 * administrator. Twelve characters with no composition rule is the guidance
 * this project already follows for staff credentials.
 */
export const StaffRegisterSchema = z.object({
  fullName: FullNameSchema,
  phone: PhoneSchema,
  districtId: z.string().uuid("DISTRICT_ID_INVALID"),
  centreId: z.string().uuid("CENTRE_ID_INVALID"),
  cropIds: z
    .array(z.string().uuid("CROP_ID_INVALID"))
    .min(1, "CROP_ID_INVALID"),
  consent: ConsentSchema,
});
export type StaffRegisterInput = z.infer<typeof StaffRegisterSchema>;

export const UpdateMeSchema = z
  .object({
    fullName: FullNameSchema.optional(),
    locale: LocaleSchema.optional(),
    districtId: z.string().uuid("DISTRICT_ID_INVALID").optional(),
    villageId: z.string().uuid("VILLAGE_ID_INVALID").nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "NO_FIELDS_TO_UPDATE");

/** Converts a Zod failure into the API's field-error shape. */
export function zodFields(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
