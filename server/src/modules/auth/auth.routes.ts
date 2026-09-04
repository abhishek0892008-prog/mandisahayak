/**
 * Authentication routes.
 *
 * Every route below is registered in the RBAC route registry with an explicit
 * auth declaration. The startup assertion refuses to boot if one is missing.
 */
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { getConfig } from "../../core/config.ts";
import { withTransaction } from "../../core/db.ts";
import { asyncHandler, sendData } from "../../core/http.ts";
import {
  badRequest,
  ErrorCodes,
  forbidden,
  unauthenticated,
} from "../../core/errors.ts";
import { declareRoute, requireAuth } from "../../core/rbac.ts";
import {
  clearedSessionCookieOptions,
  sessionCookieName,
  sessionCookieOptions,
} from "../../core/session.ts";
import { consumeAll, RateLimits, toError } from "../../core/rateLimit.ts";
import { writeAudit, AuditActions } from "../../core/audit.ts";
import {
  LoginStartSchema,
  OtpResendSchema,
  OtpVerifySchema,
  RegisterStartSchema,
  StaffLoginSchema,
  StaffRegisterSchema,
  zodFields,
} from "./auth.schemas.ts";
import { resendChallenge } from "./otp.service.ts";
import {
  logout as logoutService,
  startFarmerLogin,
  startRegistration,
  startStaffLogin,
  submitOfficerRegistration,
  verifyOtpAndCreateSession,
} from "./auth.service.ts";
import { readDemoOtp } from "./demoOtpStore.ts";

const BASE = "/api/v1";

function ctxOf(req: Request) {
  return {
    ip: req.clientIp ?? null,
    userAgent: req.header("user-agent") ?? null,
    requestId: req.requestId ?? null,
  };
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      ErrorCodes.VALIDATION_FAILED,
      "Request validation failed",
      zodFields(result.error),
    );
  }
  return result.data;
}

/** Audits a rate-limit rejection before surfacing it. */
async function rejectRateLimited(
  req: Request,
  outcome: NonNullable<Awaited<ReturnType<typeof consumeAll>>>,
) {
  await withTransaction((client) =>
    writeAudit(client, {
      action: AuditActions.RATE_LIMIT_EXCEEDED,
      entityType: "request",
      actorUserId: req.actor?.userId ?? null,
      actorRole: "SYSTEM",
      actorIp: req.clientIp ?? null,
      requestId: req.requestId ?? null,
      metadata: { rule: outcome.rule.name, hits: outcome.hits, path: req.path },
    }),
  ).catch(() => {});
  return toError(outcome);
}

export function buildAuthRouter(): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /auth/farmer/register/start-otp
  // -------------------------------------------------------------------------
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/farmer/register/start-otp`,
    auth: { kind: "public", reason: "Registration precedes any identity." },
    csrf: true,
    summary: "Begin farmer registration and issue an OTP challenge.",
  });
  router.post(
    "/auth/farmer/register/start-otp",
    asyncHandler(async (req, res) => {
      const input = parse(RegisterStartSchema, req.body);

      const limited = await consumeAll([
        {
          rule: RateLimits.REGISTER_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
        { rule: RateLimits.OTP_SEND_PER_PHONE, subject: input.phone },
        { rule: RateLimits.OTP_SEND_PER_PHONE_DAILY, subject: input.phone },
        {
          rule: RateLimits.OTP_SEND_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const view = await withTransaction((client) =>
        startRegistration(client, input, ctxOf(req)),
      );
      sendData(res, 201, view);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /auth/farmer/login/start-otp
  // -------------------------------------------------------------------------
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/farmer/login/start-otp`,
    auth: { kind: "public", reason: "Login is by definition unauthenticated." },
    csrf: true,
    summary: "Issue a login OTP challenge. Enumeration-resistant.",
  });
  router.post(
    "/auth/farmer/login/start-otp",
    asyncHandler(async (req, res) => {
      const input = parse(LoginStartSchema, req.body);

      const limited = await consumeAll([
        { rule: RateLimits.OTP_SEND_PER_PHONE, subject: input.phone },
        { rule: RateLimits.OTP_SEND_PER_PHONE_DAILY, subject: input.phone },
        {
          rule: RateLimits.OTP_SEND_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const view = await withTransaction((client) =>
        startFarmerLogin(client, input.phone, ctxOf(req)),
      );
      sendData(res, 201, view);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /auth/staff/register
  // -------------------------------------------------------------------------
  //
  // PUBLIC, and it grants NOTHING. It records an application in
  // `officer_registration_requests` — a table that is not `users`, holds no
  // role, and is never read by `startStaffLogin`. An account exists only once
  // an administrator with `officer.create` approves the request.
  //
  // The response is the same whatever happens next, and carries no request id,
  // so it cannot be used to probe which employee codes or usernames exist
  // beyond the conflict already surfaced for the applicant's own benefit.
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/staff/register`,
    auth: {
      kind: "public",
      reason:
        "Applying for an officer account must be possible without one. Creates a review request only — no user, no role, no assignment, and it cannot authenticate.",
    },
    csrf: true,
    summary: "Submit an officer account application for administrator review.",
  });
  router.post(
    "/auth/staff/register",
    asyncHandler(async (req, res) => {
      const input = parse(StaffRegisterSchema, req.body);

      const limited = await consumeAll([
        {
          rule: RateLimits.STAFF_REGISTER_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const result = await withTransaction((client) =>
        submitOfficerRegistration(client, input, ctxOf(req)),
      );

      sendData(res, 201, result);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /auth/staff/login
  // -------------------------------------------------------------------------
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/staff/login`,
    auth: { kind: "public", reason: "First factor of staff authentication." },
    csrf: true,
    summary: "Verify staff password and issue the OTP second factor.",
  });
  router.post(
    "/auth/staff/login",
    asyncHandler(async (req, res) => {
      const input = parse(StaffLoginSchema, req.body);

      const limited = await consumeAll([
        { rule: RateLimits.OTP_SEND_PER_PHONE, subject: input.phone },
        {
          rule: RateLimits.STAFF_LOGIN_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const view = await withTransaction((client) =>
        startStaffLogin(client, input.phone, ctxOf(req)),
      );
      sendData(res, 201, view);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /auth/otp/verify
  // -------------------------------------------------------------------------
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/otp/verify`,
    auth: {
      kind: "public",
      reason: "Completes authentication; a session does not exist yet.",
    },
    csrf: true,
    summary: "Verify an OTP challenge and create a session.",
  });
  router.post(
    "/auth/otp/verify",
    asyncHandler(async (req, res) => {
      const input = parse(OtpVerifySchema, req.body);

      const limited = await consumeAll([
        {
          rule: RateLimits.OTP_VERIFY_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      // The service manages its own transactions: failed-attempt bookkeeping
      // must commit even though the request fails.
      const result = await verifyOtpAndCreateSession(
        input.challengeId,
        input.otp,
        ctxOf(req),
      );

      res.cookie(
        sessionCookieName(),
        result.session.token,
        sessionCookieOptions(result.session.expiresAt),
      );

      // The session token is delivered ONLY as an HttpOnly cookie. It is never
      // in the body, so frontend JavaScript can never read or store it.
      sendData(res, 201, {
        userId: result.userId,
        roles: result.roles,
        expiresAt: result.session.expiresAt.toISOString(),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /auth/otp/resend
  // -------------------------------------------------------------------------
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/otp/resend`,
    auth: {
      kind: "public",
      reason: "Operates on an unauthenticated challenge.",
    },
    csrf: true,
    summary: "Resend an OTP, subject to cooldown and resend limit.",
  });
  router.post(
    "/auth/otp/resend",
    asyncHandler(async (req, res) => {
      const input = parse(OtpResendSchema, req.body);

      const limited = await consumeAll([
        {
          rule: RateLimits.OTP_SEND_PER_IP,
          subject: req.clientIp ?? "unknown",
        },
      ]);
      if (limited) throw await rejectRateLimited(req, limited);

      const view = await withTransaction(async (client) => {
        const v = await resendChallenge(client, input.challengeId);
        await writeAudit(client, {
          action: AuditActions.OTP_RESENT,
          entityType: "otp_challenge",
          entityId: input.challengeId,
          actorRole: "SYSTEM",
          actorIp: req.clientIp ?? null,
          requestId: req.requestId ?? null,
        });
        return v;
      });

      sendData(res, 200, view);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  declareRoute({
    method: "POST",
    path: `${BASE}/auth/logout`,
    auth: { kind: "authenticated" },
    csrf: true,
    summary: "Revoke the current session server-side and clear the cookie.",
  });
  router.post(
    "/auth/logout",
    requireAuth,
    asyncHandler(async (req, res) => {
      const actor = req.actor!;
      await withTransaction((client) =>
        logoutService(
          client,
          actor.sessionId,
          actor.userId,
          actor.roles,
          ctxOf(req),
        ),
      );
      res.cookie(sessionCookieName(), "", clearedSessionCookieOptions());
      sendData(res, 200, { loggedOut: true });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /auth/csrf — lets a client obtain a token before its first write.
  // -------------------------------------------------------------------------
  declareRoute({
    method: "GET",
    path: `${BASE}/auth/csrf`,
    auth: {
      kind: "public",
      reason: "Issues the CSRF token needed before any authenticated write.",
    },
    csrf: false,
    summary: "Return the current CSRF token (also set as a readable cookie).",
  });
  router.get("/auth/csrf", (req, res) => {
    const issued = (req as unknown as { issuedCsrf?: string }).issuedCsrf;
    const current =
      issued ??
      (req as unknown as { cookies: Record<string, string> }).cookies?.fq_csrf;
    sendData(res, 200, { csrfToken: current ?? null });
  });

  // -------------------------------------------------------------------------
  // GET /dev/last-otp — DEMO_MODE ONLY, token protected, audited.
  // -------------------------------------------------------------------------
  declareRoute({
    method: "GET",
    path: `${BASE}/dev/last-otp`,
    auth: {
      kind: "public",
      reason: "DEMO_MODE only; guarded by a static dev token and audited.",
    },
    csrf: false,
    summary:
      "Reveal the last demo OTP for a phone. Never available in production.",
  });
  router.get(
    "/dev/last-otp",
    asyncHandler(async (req, res) => {
      const cfg = getConfig();
      if (!cfg.DEMO_MODE)
        throw forbidden(ErrorCodes.FORBIDDEN, "Not available");

      const provided = req.header("x-dev-token");
      if (!provided || provided !== cfg.DEV_TOOLS_TOKEN) {
        throw unauthenticated(ErrorCodes.UNAUTHENTICATED, "Dev token required");
      }

      const phoneRaw = String(req.query.phone ?? "");
      const parsed = LoginStartSchema.safeParse({ phone: phoneRaw });
      if (!parsed.success) {
        throw badRequest(
          ErrorCodes.VALIDATION_FAILED,
          "phone required",
          zodFields(parsed.error),
        );
      }

      const otp = readDemoOtp(parsed.data.phone);

      await withTransaction((client) =>
        writeAudit(client, {
          action: AuditActions.DEMO_OTP_REVEALED,
          entityType: "otp_challenge",
          actorRole: "SYSTEM",
          actorIp: req.clientIp ?? null,
          requestId: req.requestId ?? null,
          metadata: { phone: parsed.data.phone, found: otp !== null },
        }),
      );

      sendData(res, 200, { otp });
    }),
  );

  return router;
}
