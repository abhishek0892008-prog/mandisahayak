/**
 * HTTP plumbing: request context, cookies, CSRF, and the single error mapper.
 */
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { AppError, ErrorCodes } from './errors.ts';
import { log } from './logging.ts';
import { randomId, issueCsrfToken, isValidCsrfToken, tokensMatch } from './crypto.ts';
import { getConfig } from './config.ts';
import { CSRF_COOKIE, CSRF_HEADER, resolveSession, sessionCookieName, touchSession } from './session.ts';
import type { Actor } from './session.ts';
import { withTransaction } from './db.ts';
import { writeAudit, AuditActions } from './audit.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      requestId?: string;
      clientIp?: string | null;
    }
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function sendData(res: Response, status: number, data: unknown, meta?: unknown) {
  res.status(status).json(meta === undefined ? { data } : { data, meta });
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = randomId();
  req.clientIp = req.ip ?? null;
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/** Minimal, dependency-free cookie parsing. */
export const parseCookies: RequestHandler = (req, _res, next) => {
  const header = req.headers.cookie;
  const jar: Record<string, string> = {};
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) jar[k] = decodeURIComponent(v);
    }
  }
  (req as unknown as { cookies: Record<string, string> }).cookies = jar;
  next();
};

export function cookies(req: { cookies?: Record<string, string> }): Record<string, string> {
  return req.cookies ?? {};
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  if (getConfig().cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
};

// ---------------------------------------------------------------------------
// Authentication (attaches an actor when a valid session cookie is present)
// ---------------------------------------------------------------------------

export const attachActor: RequestHandler = async (req, _res, next) => {
  try {
    const token = cookies(req)[sessionCookieName()];
    if (!token) return next();

    const actor = await resolveSession(token);
    if (!actor) return next();

    req.actor = actor;
    // Sliding expiry; failure here must not break the request.
    void touchSession(actor.sessionId, actor.isStaff).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// CSRF — stateless double-submit
// ---------------------------------------------------------------------------

/**
 * Issues a CSRF cookie to anyone who does not have a valid one. Readable by JS
 * BY DESIGN: the client must echo it in a header, which a cross-site attacker
 * cannot do because they cannot read the cookie from another origin.
 *
 * Anonymous visitors get one too, so login and registration are protected
 * against login-CSRF rather than being quietly exempt.
 */
export const issueCsrf: RequestHandler = (req, res, next) => {
  const cfg = getConfig();
  const existing = cookies(req)[CSRF_COOKIE];
  if (!isValidCsrfToken(existing, cfg.CSRF_PEPPER)) {
    const token = issueCsrfToken(cfg.CSRF_PEPPER);
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: cfg.cookieSecure,
      sameSite: 'lax',
      path: '/',
    });
    (req as unknown as { issuedCsrf?: string }).issuedCsrf = token;
  }
  next();
};

/**
 * Verifies the double submit on state-changing requests: the header must equal
 * the cookie, AND the value must carry a valid server HMAC so a client cannot
 * simply invent a matching pair.
 */
export function requireCsrf(): RequestHandler {
  return (req, _res, next) => {
    const cfg = getConfig();
    const cookieToken = cookies(req)[CSRF_COOKIE];
    const headerToken = req.header(CSRF_HEADER) ?? undefined;

    const ok =
      isValidCsrfToken(cookieToken, cfg.CSRF_PEPPER) && tokensMatch(cookieToken, headerToken);

    if (!ok) {
      void withTransaction((client) =>
        writeAudit(client, {
          action: AuditActions.CSRF_REJECTED,
          entityType: 'request',
          actorUserId: req.actor?.userId ?? null,
          actorRole: req.actor ? ((req.actor.roles[0] as 'FARMER') ?? null) : 'SYSTEM',
          actorIp: req.clientIp ?? null,
          requestId: req.requestId ?? null,
          metadata: {
            method: req.method,
            path: req.path,
            hadCookie: Boolean(cookieToken),
            hadHeader: Boolean(headerToken),
          },
        }),
      ).catch(() => {});

      return next(new AppError(403, ErrorCodes.CSRF_TOKEN_INVALID, 'CSRF token missing or invalid'));
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Error mapping — the only place an error becomes a response
// ---------------------------------------------------------------------------

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? null;

  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error('request failed', { requestId, code: err.code, err: err.message });
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
    return;
  }

  // Body parser rejects malformed JSON with a SyntaxError carrying a status.
  const maybe = err as { type?: string; status?: number; message?: string };
  if (maybe?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: ErrorCodes.MALFORMED_JSON, message: 'Request body is not valid JSON', requestId },
    });
    return;
  }

  log.error('unhandled error', {
    requestId,
    err: maybe?.message ?? String(err),
    stack: (err as Error)?.stack,
  });

  // Internal detail never reaches the client.
  res.status(500).json({
    error: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal server error', requestId },
  });
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: ErrorCodes.NOT_FOUND,
      message: 'No such endpoint',
      requestId: req.requestId ?? null,
    },
  });
};

/** Wraps an async handler so a rejected promise reaches the error mapper. */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
