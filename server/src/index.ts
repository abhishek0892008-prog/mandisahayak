/**
 * API entrypoint.
 *
 * Startup order is a security property, not a convenience:
 *   1. load and validate configuration (fail fast on a bad secret)
 *   2. reach the database
 *   3. assert every route declares a permission — refuse to boot otherwise
 *   4. only then listen
 */
import { loadConfig } from './core/config.ts';
import { closePool, query } from './core/db.ts';
import { log } from './core/logging.ts';
import { buildApp, routeSummary, verifyRouteProtection } from './app.ts';
import { assertDomainMatchesDatabase } from './domain/quantity.ts';

async function main() {
  const cfg = loadConfig();

  const version = await query<{ version: string }>('SELECT version()');
  log.info('database connected', { server: version.rows[0].version.split(',')[0] });

  const app = buildApp();

  // Refuses to start if any route lacks an auth declaration, names a permission
  // that does not exist, or mutates state without CSRF.
  await verifyRouteProtection();
  log.info('route protection verified', { routes: routeSummary().length });

  // Refuses to start if the quantity rule in code has drifted from the CHECK
  // constraint in the database.
  await assertDomainMatchesDatabase();
  log.info('quantity domain matches the database constraint');

  if (cfg.DEMO_MODE) {
    log.warn('DEMO_MODE is ENABLED — OTPs are written to the log and exposed via /api/v1/dev/last-otp');
  }

  const server = app.listen(cfg.PORT, () => {
    log.info('listening', { port: cfg.PORT, env: cfg.NODE_ENV });
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('startup failed', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
