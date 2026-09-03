/**
 * Authorization: deny by default.
 *
 * Every route MUST declare a permission (or be explicitly declared public). A
 * startup assertion walks the registry and refuses to boot if any route omits
 * one, which turns "I forgot to protect the endpoint" into a boot failure
 * rather than a security incident (architecture §5.2).
 *
 * Authorization is never inferred from frontend routing, hidden buttons, or
 * anything the client sends.
 */
import type { RequestHandler } from 'express';
import type { Actor } from './session.ts';
import { forbidden, unauthenticated, ErrorCodes } from './errors.ts';
import { withTransaction } from './db.ts';
import { writeAudit, AuditActions } from './audit.ts';

/** How a route is protected. */
export type RouteAuth =
  | { kind: 'public'; reason: string }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: string };

export type RouteDeclaration = {
  method: string;
  path: string;
  auth: RouteAuth;
  /** Whether the route mutates state and therefore requires a CSRF token. */
  csrf: boolean;
  summary: string;
};

const registry: RouteDeclaration[] = [];

export function declareRoute(decl: RouteDeclaration): RouteDeclaration {
  registry.push(decl);
  return decl;
}

export function getRegistry(): readonly RouteDeclaration[] {
  return registry;
}

/**
 * Startup assertion. Called before the server begins listening.
 *
 * Verifies that every registered route has an explicit auth declaration, that
 * every named permission actually exists in the database, and that every
 * state-changing route requires CSRF.
 */
export async function assertRoutesAreProtected(
  knownPermissions: ReadonlySet<string>,
): Promise<void> {
  const problems: string[] = [];

  if (registry.length === 0) {
    problems.push('No routes are registered; the registry assertion would be vacuous.');
  }

  for (const r of registry) {
    const id = `${r.method} ${r.path}`;

    if (!r.auth || !('kind' in r.auth)) {
      problems.push(`${id}: no auth declaration`);
      continue;
    }

    if (r.auth.kind === 'public' && !r.auth.reason?.trim()) {
      problems.push(`${id}: declared public without a stated reason`);
    }

    if (r.auth.kind === 'permission') {
      if (!r.auth.permission?.trim()) {
        problems.push(`${id}: permission declaration is empty`);
      } else if (!knownPermissions.has(r.auth.permission)) {
        problems.push(
          `${id}: declares permission "${r.auth.permission}", which does not exist in the permissions table`,
        );
      }
    }

    const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method.toUpperCase());
    if (mutating && !r.csrf) {
      problems.push(`${id}: state-changing route does not require CSRF`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Route protection assertion FAILED — refusing to start:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/** Requires an authenticated actor, without a specific permission. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.actor) return next(unauthenticated());
  next();
};

/**
 * Requires a specific permission. Denials are audited, because a farmer probing
 * an admin endpoint is a security event worth keeping.
 */
export function requirePermission(permission: string): RequestHandler {
  return (req, _res, next) => {
    const actor = req.actor;
    if (!actor) return next(unauthenticated());

    if (!actor.permissions.has(permission)) {
      void withTransaction((client) =>
        writeAudit(client, {
          action: AuditActions.AUTHORIZATION_DENIED,
          entityType: 'route',
          entityId: null,
          actorUserId: actor.userId,
          actorRole: (actor.roles[0] as 'FARMER' | 'OFFICER' | 'ADMIN') ?? null,
          actorIp: req.clientIp ?? null,
          requestId: req.requestId ?? null,
          metadata: {
            method: req.method,
            path: req.route?.path ?? req.path,
            requiredPermission: permission,
            actorRoles: actor.roles,
          },
        }),
      ).catch(() => {
        /* auditing a denial must never convert a 403 into a 500 */
      });

      return next(forbidden(ErrorCodes.FORBIDDEN, 'Missing required permission'));
    }

    next();
  };
}

/**
 * Officer centre scope. An officer may only act on centres they are assigned to.
 * Not used by Phase 5 routes, but defined here so Phase 10 does not invent a
 * second authorization mechanism.
 */
export function actorMayActOnCentre(actor: Actor, centreId: string): boolean {
  if (actor.roles.includes('ADMIN')) return true;
  return actor.centreIds.includes(centreId);
}
