/**
 * Express application assembly.
 *
 * Middleware order matters and is deliberate:
 *   context -> security headers -> body -> cookies -> CSRF issue -> actor
 *   -> CSRF verify (writes only) -> routes -> 404 -> error mapper
 */
import express from 'express';
import type { Express } from 'express';
import {
  attachActor,
  errorHandler,
  issueCsrf,
  notFoundHandler,
  parseCookies,
  requestContext,
  requireCsrf,
  securityHeaders,
} from './core/http.ts';
import { assertRoutesAreProtected, declareRoute, getRegistry } from './core/rbac.ts';
import { query } from './core/db.ts';
import { buildAuthRouter } from './modules/auth/auth.routes.ts';
import { buildIdentityRouter } from './modules/identity/identity.routes.ts';
import { buildReferenceRouter } from './modules/reference/reference.routes.ts';
import { buildBookingsRouter } from './modules/bookings/bookings.routes.ts';
import { buildOfficerRouter } from './modules/officer/officer.routes.ts';
import { buildQueueRouter } from './modules/queue/queue.routes.ts';
import { buildNotificationsRouter } from './modules/notifications/notifications.routes.ts';
import { buildAdminRouter } from './modules/admin/admin.routes.ts';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function buildApp(): Express {
  const app = express();

  // Behind a reverse proxy in production; needed for a correct req.ip.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));
  app.use(parseCookies);
  app.use(issueCsrf);
  app.use(attachActor);

  // CSRF is enforced on every state-changing request, before any route runs.
  app.use((req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    return requireCsrf()(req, res, next);
  });

  declareRoute({
    method: 'GET',
    path: '/healthz',
    auth: { kind: 'public', reason: 'Liveness probe; exposes no data.' },
    csrf: false,
    summary: 'Process liveness.',
  });
  app.get('/healthz', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });

  declareRoute({
    method: 'GET',
    path: '/readyz',
    auth: { kind: 'public', reason: 'Readiness probe; reports only migration state.' },
    csrf: false,
    summary: 'Database reachability and applied migration count.',
  });
  app.get('/readyz', (_req, res) => {
    query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations')
      .then((r) => res.json({ data: { status: 'ready', migrations: Number(r.rows[0].count) } }))
      .catch(() => res.status(503).json({ error: { code: 'MAINTENANCE', message: 'Database unavailable' } }));
  });

  app.use('/api/v1', buildAuthRouter());
  app.use('/api/v1', buildIdentityRouter());
  app.use('/api/v1', buildReferenceRouter());
  app.use('/api/v1', buildBookingsRouter());
  app.use('/api/v1', buildOfficerRouter());
  app.use('/api/v1', buildQueueRouter());
  app.use('/api/v1', buildNotificationsRouter());
  app.use('/api/v1', buildAdminRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Loads the permission codes the database actually knows about, then runs the
 * deny-by-default assertion. Called before listening.
 */
export async function verifyRouteProtection(): Promise<void> {
  const res = await query<{ code: string }>('SELECT code FROM permissions');
  const known = new Set(res.rows.map((r) => r.code));
  await assertRoutesAreProtected(known);
}

export function routeSummary() {
  return getRegistry().map((r) => ({
    method: r.method,
    path: r.path,
    auth: r.auth.kind === 'permission' ? r.auth.permission : r.auth.kind,
    csrf: r.csrf,
  }));
}
