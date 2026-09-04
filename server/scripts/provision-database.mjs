#!/usr/bin/env node
/**
 * Provision a database from zero to bookable — no `psql` required.
 *
 * A Node port of provision-database.sh, for anyone deploying without the
 * PostgreSQL client tools on their PATH (e.g. a fresh Vercel/Neon setup).
 * Runs migrations, then the bootstrap administrator, then both imports,
 * exactly as the shell script does — using the `pg` package already in
 * server/package.json.
 *
 *   DATABASE_URL=postgres://user:pass@host/db \
 *     node server/scripts/provision-database.mjs
 *
 * Safe to re-run: migrations are skipped once applied (schema_migrations),
 * the seed admin is idempotent (ON CONFLICT DO NOTHING), and the imports
 * follow the same pattern the .sql files already document.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '../migrations');
const IMPORTS_DIR = path.join(HERE, '../imports');
const SEED_ADMIN_FILE = path.join(HERE, 'seed-bootstrap-admin.sql');

const ADMIN_ID = '33333333-0000-4000-a000-000000000001';

const DB_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.error('Set DATABASE_URL (or TEST_DATABASE_URL).');
  process.exit(1);
}

/** Strips psql meta-commands (lines starting with `\`) — plain SQL only. */
function stripPsqlMetaCommands(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n');
}

/** Replaces psql `:'name'` variable references with a quoted literal. */
function substitutePsqlVariables(sql, vars) {
  let out = sql;
  for (const [name, value] of Object.entries(vars)) {
    out = out.replaceAll(`:'${name}'`, `'${value}'`);
  }
  return out;
}

async function run() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  try {
    console.log('migrate');
    const migrationFiles = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let appliedVersions = new Set();
    try {
      const res = await client.query('SELECT version FROM schema_migrations');
      appliedVersions = new Set(res.rows.map((r) => r.version));
    } catch {
      // schema_migrations does not exist yet — first migration creates it.
    }

    for (const file of migrationFiles) {
      const version = file.split('_')[0];
      if (appliedVersions.has(version)) {
        console.log(`skip   ${file} (already applied)`);
        continue;
      }
      console.log(`apply  ${file}`);
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
    }

    console.log('\nseed      bootstrap administrator');
    const seedSql = stripPsqlMetaCommands(await readFile(SEED_ADMIN_FILE, 'utf8'));
    await client.query(seedSql);

    const imports = [
      { file: '0001_msp_rms_2026_27_kms_2026_27.sql', varName: 'activating_admin', label: '0001 MSP (OFFICIAL)' },
      { file: '0002_up_demonstration_geography.sql', varName: 'configured_by', label: '0002 UP demonstration geography (CONFIGURED)' },
      { file: '0003_notification_templates.sql', varName: 'configured_by', label: '0003 notification templates (CONFIGURED)' },
      { file: '0004_up_mandi_parishad_mandis.sql', varName: 'configured_by', label: '0004 UP Mandi Parishad mandis (OFFICIAL)' },
    ];

    for (const { file, varName, label } of imports) {
      console.log(`import    ${label}`);
      const raw = await readFile(path.join(IMPORTS_DIR, file), 'utf8');
      const sql = substitutePsqlVariables(raw, { [varName]: ADMIN_ID });
      await client.query(sql);
    }

    console.log();
    const summary = await client.query(`
      SELECT format(
        'ready: %s migrations, %s crops, %s MSP rates, %s mandis, %s centres, %s bookings',
        (SELECT count(*) FROM schema_migrations),
        (SELECT count(*) FROM crops),
        (SELECT count(*) FROM msp_rates),
        (SELECT count(*) FROM mandis),
        (SELECT count(*) FROM procurement_centres),
        (SELECT count(*) FROM bookings)
      ) AS summary
    `);
    console.log(summary.rows[0].summary);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
