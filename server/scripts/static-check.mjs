#!/usr/bin/env node
/**
 * FarmQueue — migration static checker.
 *
 * WHAT THIS IS: a text-and-structure checker for the migration SQL. It runs with
 * zero dependencies on Node's standard library alone, and needs no database.
 *
 * WHAT THIS IS NOT: a PostgreSQL parser. It cannot prove that the SQL is
 * syntactically valid, that an expression is IMMUTABLE, that an operator class
 * exists for a GiST exclusion element, or that a plan will be chosen. Those
 * require a real server. Anything this tool reports as OK is "consistent and
 * plausible", never "verified by PostgreSQL".
 *
 * Usage:  node server/scripts/static-check.mjs
 * Exit:   0 = all checks passed, 1 = at least one failure
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

const PG_MAX_IDENTIFIER_LENGTH = 63;

/** Tables that may only ever be populated by the Phase 3/4 import pipeline. */
const GOVERNMENT_DATA_TABLES = new Set([
  'data_sources', 'states', 'districts', 'villages', 'mandis',
  'crops', 'crop_aliases', 'procurement_centres',
  'storage_facilities', 'storage_capacity', 'storage_inventory',
  'msp_rates', 'msp_import_batches', 'msp_import_rows',
]);

/** Tables the seed migration is allowed to write to. */
const SEEDABLE_TABLES = new Set([
  'roles', 'permissions', 'role_permissions', 'seasons',
  'booking_status_transitions', 'reference_versions', 'schema_migrations',
]);

/**
 * Column-name fragments that must never appear, because the corresponding data
 * is either forbidden by Decision D-6/D-7 or must only ever be stored hashed.
 */
const FORBIDDEN_COLUMN_PATTERNS = [
  { pattern: /aadhaar/i,           why: 'Decision D-6: no Aadhaar reference is stored.' },
  { pattern: /\bifsc/i,            why: 'Decision D-6: no bank IFSC is stored.' },
  { pattern: /account_number/i,    why: 'Decision D-7: FarmQueue does not disburse; no bank account data.' },
  { pattern: /^otp$|_otp$|^otp_(?!hash|challenge)/i,
                                   why: 'OTPs may only be stored as otp_hash.' },
  { pattern: /^password$|_password$/i,
                                   why: 'Passwords may only be stored as password_hash.' },
  { pattern: /^session_token$|^token$/i,
                                   why: 'Session tokens may only be stored as token_hash.' },
];

const failures = [];
const warnings = [];
const notes = [];

const fail = (check, detail) => failures.push({ check, detail });
const warn = (check, detail) => warnings.push({ check, detail });
const note = (line) => notes.push(line);

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migration files found in', MIGRATIONS_DIR);
  process.exit(1);
}

const migrations = files.map((name) => ({
  name,
  raw: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
}));

/**
 * Neutralise everything that could confuse structural parsing, while KEEPING
 * string contents so that content assertions (e.g. "data_type <> 'OFFICIAL'")
 * still match.
 *
 * A single pass of regex replacements is not sufficient here: an apostrophe
 * inside a line comment ("PostgreSQL's") looks exactly like the start of a
 * string literal, and a "--" inside a string literal looks exactly like the
 * start of a comment. Only a stateful scan gets both right, so this walks the
 * text one character at a time.
 *
 * Inside string literals the structural characters ( ) , ; $ are replaced with
 * '_' so that parenthesis depth and comma splitting stay correct, while the
 * alphanumeric content survives for content assertions.
 */
function stripNoise(sql) {
  const STRUCTURAL = new Set(['(', ')', ',', ';', '$']);
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Dollar-quoted block: blank it out entirely, preserving newlines.
    if (ch === '$' && next === '$') {
      const end = sql.indexOf('$$', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (let j = i; j < stop; j += 1) out += sql[j] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }

    // Line comment: drop to end of line.
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }

    // Block comment.
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (let j = i; j < stop; j += 1) out += sql[j] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }

    // String literal, with '' as the escape for a literal quote.
    if (ch === "'") {
      out += "'";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += '__'; i += 2; continue; }
        if (sql[i] === "'") { out += "'"; i += 1; break; }
        out += STRUCTURAL.has(sql[i]) ? '_' : sql[i];
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Remove only comments, keeping strings (for checks that read literals). */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

for (const m of migrations) {
  m.clean = stripNoise(m.raw);
  m.noComments = stripComments(m.raw);
}

// ---------------------------------------------------------------------------
// 1. File naming, numbering and self-registration
// ---------------------------------------------------------------------------
{
  let expected = 1;
  for (const m of migrations) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(m.name);
    if (!match) {
      fail('naming', `${m.name}: expected NNNN_snake_case_name.sql`);
      continue;
    }
    const [, version, slug] = match;
    if (Number(version) !== expected) {
      fail('numbering', `${m.name}: expected version ${String(expected).padStart(4, '0')}, found ${version}`);
    }
    expected = Number(version) + 1;

    const begins = (m.clean.match(/\bBEGIN\s*;/gi) || []).length;
    const commits = (m.clean.match(/\bCOMMIT\s*;/gi) || []).length;
    if (begins !== 1 || commits !== 1) {
      fail('transaction', `${m.name}: expected exactly one BEGIN; and one COMMIT; (found ${begins}/${commits})`);
    }
    if (!/^\s*BEGIN\s*;/m.test(m.clean.trimStart())) {
      warn('transaction', `${m.name}: BEGIN; should be the first statement`);
    }

    const ledger = new RegExp(
      `INSERT\\s+INTO\\s+schema_migrations\\s*\\(\\s*version\\s*,\\s*name\\s*\\)\\s*VALUES\\s*\\(\\s*'${version}'\\s*,\\s*'${slug}'\\s*\\)`,
      'i',
    );
    if (!ledger.test(m.noComments)) {
      fail('ledger', `${m.name}: must end by inserting ('${version}', '${slug}') into schema_migrations`);
    }
  }
  note(`${migrations.length} migration files, versions 0001..${String(expected - 1).padStart(4, '0')}`);
}

// ---------------------------------------------------------------------------
// 2. Delimiter balance
// ---------------------------------------------------------------------------
for (const m of migrations) {
  const dollars = (m.raw.match(/\$\$/g) || []).length;
  if (dollars % 2 !== 0) {
    fail('delimiters', `${m.name}: odd number of $$ delimiters (${dollars})`);
  }

  let depth = 0;
  let bad = false;
  for (const ch of m.clean) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) { bad = true; break; }
    }
  }
  if (bad || depth !== 0) {
    fail('delimiters', `${m.name}: unbalanced parentheses (final depth ${depth})`);
  }

  if (!/;\s*$/.test(m.raw.trimEnd())) {
    fail('delimiters', `${m.name}: file does not end with a terminated statement`);
  }
}

// ---------------------------------------------------------------------------
// 3. Collect objects
// ---------------------------------------------------------------------------
const tables = new Map();   // name -> { file, order, columns, indexedLeading:Set, checks:[], hasDataType }
const domains = new Set();
const allIdentifiers = [];  // { kind, name, file }

migrations.forEach((m, order) => {
  // Domains
  for (const match of m.clean.matchAll(/CREATE\s+DOMAIN\s+(\w+)/gi)) {
    domains.add(match[1]);
    allIdentifiers.push({ kind: 'domain', name: match[1], file: m.name });
  }

  // Tables — capture the parenthesised body by scanning for the matching paren.
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi;
  for (const match of m.clean.matchAll(tableRe)) {
    const name = match[1];
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < m.clean.length; i += 1) {
      if (m.clean[i] === '(') depth += 1;
      else if (m.clean[i] === ')') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = m.clean.slice(start + 1, end);
    tables.set(name, {
      file: m.name,
      order,
      body,
      columns: [],
      indexedLeading: new Set(),
      foreignKeys: [],
      constraintNames: [],
      hasDataType: false,
    });
    allIdentifiers.push({ kind: 'table', name, file: m.name });
  }
});

// Parse table bodies for columns, constraints and inline keys.
for (const [tableName, t] of tables) {
  // Split top-level, comma-separated items.
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of t.body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { items.push(current); current = ''; }
    else current += ch;
  }
  if (current.trim()) items.push(current);

  for (const rawItem of items) {
    const item = rawItem.trim().replace(/\s+/g, ' ');
    if (!item) continue;

    const constraintMatch = /^CONSTRAINT\s+(\w+)\s+(.*)$/i.exec(item);
    const isBareConstraint = /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(item);

    if (constraintMatch) {
      const [, cname, rest] = constraintMatch;
      t.constraintNames.push(cname);
      allIdentifiers.push({ kind: 'constraint', name: cname, file: t.file });
      recordKeyColumns(t, rest);
      recordForeignKey(t, rest, tableName);
      continue;
    }
    if (isBareConstraint) {
      recordKeyColumns(t, item);
      recordForeignKey(t, item, tableName);
      continue;
    }

    // Column definition: first token is the column name.
    const colMatch = /^(\w+)\s+(.+)$/.exec(item);
    if (!colMatch) continue;
    const [, colName, colDef] = colMatch;
    t.columns.push(colName);
    allIdentifiers.push({ kind: 'column', name: `${tableName}.${colName}`, file: t.file });
    if (colName === 'data_type') t.hasDataType = true;

    if (/\bPRIMARY\s+KEY\b/i.test(colDef) || /\bUNIQUE\b/i.test(colDef)) {
      t.indexedLeading.add(colName);
    }
    const refMatch = /\bREFERENCES\s+(\w+)\s*(?:\(([^)]*)\))?/i.exec(colDef);
    if (refMatch) {
      t.foreignKeys.push({ columns: [colName], target: refMatch[1] });
    }
  }
}

function recordKeyColumns(t, text) {
  const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(text);
  if (pk) t.indexedLeading.add(pk[1].split(',')[0].trim().split(/\s+/)[0]);
  const uq = /^UNIQUE\s*\(([^)]*)\)/i.exec(text);
  if (uq) t.indexedLeading.add(uq[1].split(',')[0].trim().split(/\s+/)[0]);
}

function recordForeignKey(t, text, tableName) {
  const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\w+)/i.exec(text);
  if (fk) {
    t.foreignKeys.push({
      columns: fk[1].split(',').map((c) => c.trim()),
      target: fk[2],
      viaTableConstraint: true,
      owner: tableName,
    });
  }
}

// ALTER TABLE ... ADD CONSTRAINT (exclusion constraints and deferred FKs).
const alterConstraints = [];
migrations.forEach((m, order) => {
  const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+([\s\S]*?);/gi;
  for (const match of m.clean.matchAll(re)) {
    const [, table, cname, body] = match;
    alterConstraints.push({ file: m.name, order, table, name: cname, body });
    allIdentifiers.push({ kind: 'constraint', name: cname, file: m.name });

    const t = tables.get(table);
    const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\w+)/i.exec(body);
    if (fk && t) {
      t.foreignKeys.push({
        columns: fk[1].split(',').map((c) => c.trim()),
        target: fk[2],
        addedIn: order,
      });
    }
  }
});

// CREATE INDEX
const indexes = [];
migrations.forEach((m, order) => {
  const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)([^;]*);/gi;
  for (const match of m.clean.matchAll(re)) {
    const [, unique, name, table, cols, tail] = match;
    const leading = cols.split(',')[0].trim().split(/\s+/)[0];
    indexes.push({
      file: m.name, order, name, table,
      unique: Boolean(unique),
      columns: cols.trim(),
      leading,
      partial: /\bWHERE\b/i.test(tail),
    });
    allIdentifiers.push({ kind: 'index', name, file: m.name });
    const t = tables.get(table);
    if (t) t.indexedLeading.add(leading);
  }
});

// Triggers
const triggers = [];
migrations.forEach((m) => {
  for (const match of m.clean.matchAll(/CREATE\s+TRIGGER\s+(\w+)([\s\S]*?);/gi)) {
    triggers.push({ file: m.name, name: match[1], body: match[2] });
    allIdentifiers.push({ kind: 'trigger', name: match[1], file: m.name });
  }
});

note(`${tables.size} tables, ${domains.size} domains, ${indexes.length} standalone indexes, ` +
     `${alterConstraints.length} ALTER-added constraints, ${triggers.length} triggers`);

{
  let fkCount = 0;
  let checkCount = 0;
  let uniqueCount = 0;
  let pkCount = 0;
  let namedConstraints = 0;
  for (const t of tables.values()) {
    fkCount += t.foreignKeys.length;
    namedConstraints += t.constraintNames.length;
    checkCount += (t.body.match(/\bCHECK\s*\(/gi) || []).length;
    uniqueCount += (t.body.match(/\bUNIQUE\b/gi) || []).length;
    pkCount += (t.body.match(/\bPRIMARY\s+KEY\b/gi) || []).length;
  }
  const excludeCount = alterConstraints.filter((c) => /EXCLUDE\s+USING\s+gist/i.test(c.body)).length;
  const uniqueIndexes = indexes.filter((i) => i.unique).length;
  note(`${pkCount} primary keys, ${fkCount} foreign keys, ${checkCount} CHECK constraints, ` +
       `${uniqueCount} UNIQUE clauses, ${excludeCount} EXCLUDE constraints`);
  note(`${namedConstraints} explicitly named table constraints; ` +
       `${uniqueIndexes} of ${indexes.length} standalone indexes are UNIQUE`);
}

// ---------------------------------------------------------------------------
// 4. Identifier length (PostgreSQL truncates silently at 63 bytes)
// ---------------------------------------------------------------------------
for (const id of allIdentifiers) {
  const bare = id.name.includes('.') ? id.name.split('.')[1] : id.name;
  if (Buffer.byteLength(bare, 'utf8') > PG_MAX_IDENTIFIER_LENGTH) {
    fail('identifier-length',
      `${id.file}: ${id.kind} "${bare}" is ${bare.length} chars; PostgreSQL truncates at ${PG_MAX_IDENTIFIER_LENGTH}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Foreign key targets exist and are created no later than the referrer
// ---------------------------------------------------------------------------
for (const [tableName, t] of tables) {
  for (const fk of t.foreignKeys) {
    const target = tables.get(fk.target);
    if (!target) {
      fail('fk-target', `${t.file}: ${tableName} references unknown table "${fk.target}"`);
      continue;
    }
    const referrerOrder = fk.addedIn !== undefined ? fk.addedIn : t.order;
    if (target.order > referrerOrder) {
      fail('fk-order',
        `${t.file}: ${tableName} references ${fk.target}, which is created later (${target.file})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Every foreign key column is the leading column of some index
//    (PostgreSQL does not create these automatically)
// ---------------------------------------------------------------------------
for (const [tableName, t] of tables) {
  for (const fk of t.foreignKeys) {
    const leading = fk.columns[0];
    if (!t.indexedLeading.has(leading)) {
      fail('fk-index',
        `${t.file}: ${tableName}.${leading} is a foreign key with no index leading on it`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. data_type discipline: every table with data_type enforces OFFICIAL -> source_id
// ---------------------------------------------------------------------------
for (const [tableName, t] of tables) {
  if (!t.hasDataType) continue;

  const hasOfficialCheck = /data_type\s*<>\s*'OFFICIAL'\s*OR\s+source_id\s+IS\s+NOT\s+NULL/i.test(t.body);
  if (!hasOfficialCheck) {
    fail('provenance',
      `${t.file}: ${tableName} has a data_type column but no "data_type <> 'OFFICIAL' OR source_id IS NOT NULL" CHECK`);
  }
  if (!t.columns.includes('source_id')) {
    fail('provenance', `${t.file}: ${tableName} has data_type but no source_id column`);
  }
  if (!/\bdata_type_t\b/.test(t.body)) {
    fail('provenance', `${t.file}: ${tableName}.data_type should use the data_type_t domain`);
  }
}

// ---------------------------------------------------------------------------
// 8. Forbidden columns (D-6 / D-7 and secret-at-rest rules)
// ---------------------------------------------------------------------------
for (const [tableName, t] of tables) {
  for (const col of t.columns) {
    for (const { pattern, why } of FORBIDDEN_COLUMN_PATTERNS) {
      if (pattern.test(col)) {
        fail('forbidden-column', `${t.file}: ${tableName}.${col} — ${why}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 9. No government data inserted by any migration
// ---------------------------------------------------------------------------
for (const m of migrations) {
  for (const match of m.clean.matchAll(/INSERT\s+INTO\s+(\w+)/gi)) {
    const table = match[1];
    if (GOVERNMENT_DATA_TABLES.has(table)) {
      fail('no-fake-data',
        `${m.name}: INSERT INTO ${table} — government-data tables must only be filled by the Phase 3/4 import pipeline`);
    } else if (!SEEDABLE_TABLES.has(table)) {
      warn('seed-scope', `${m.name}: INSERT INTO ${table} is outside the agreed seed scope`);
    }
  }
}

// ---------------------------------------------------------------------------
// 10. PostgreSQL feature preconditions
// ---------------------------------------------------------------------------
{
  const btreeGistFile = migrations.findIndex((m) => /CREATE\s+EXTENSION[^;]*btree_gist/i.test(m.clean));
  if (btreeGistFile === -1) {
    fail('extension', 'btree_gist is never created, but EXCLUDE USING gist constraints combine "WITH =" and "WITH &&"');
  }

  const excludeUsers = [];
  migrations.forEach((m, order) => {
    if (/EXCLUDE\s+USING\s+gist/i.test(m.clean)) excludeUsers.push({ file: m.name, order });
  });
  for (const user of excludeUsers) {
    if (btreeGistFile !== -1 && user.order < btreeGistFile) {
      fail('extension', `${user.file}: uses EXCLUDE USING gist before btree_gist is created`);
    }
  }

  const guarded = migrations.some((m) => /server_version_num/i.test(m.raw));
  if (!guarded) warn('version-guard', 'No server_version_num guard found in any migration');

  // Every exclusion element that is an expression must be parenthesised.
  const allExclude = [...alterConstraints.filter((c) => /EXCLUDE\s+USING\s+gist/i.test(c.body))];
  for (const c of allExclude) {
    for (const el of c.body.matchAll(/([A-Za-z_][\w.]*)\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)\s+WITH\s+/gi)) {
      fail('exclude-syntax',
        `${c.file}: constraint ${c.name} has an unparenthesised function expression "${el[1]}(...) WITH" — ` +
        'expressions in an exclusion element must be wrapped in their own parentheses');
    }
  }
  note(`${allExclude.length} EXCLUDE USING gist constraints (added via ALTER TABLE)`);
}

// ---------------------------------------------------------------------------
// 11. Named business invariants that must exist
// ---------------------------------------------------------------------------
{
  const bookings = tables.get('bookings');
  if (!bookings) {
    fail('invariant', 'bookings table not found');
  } else {
    if (!/requested_quantity_kg\s+BETWEEN\s+2500\s+AND\s+5000/i.test(bookings.body)) {
      fail('invariant', 'bookings is missing the CHECK requested_quantity_kg BETWEEN 2500 AND 5000');
    }
    if (!/service_window\s+tstzrange\s+GENERATED\s+ALWAYS\s+AS/i.test(bookings.body)) {
      fail('invariant', 'bookings.service_window generated tstzrange column not found');
    }
    const laneOverlap = alterConstraints.find((c) => c.name === 'bookings_no_lane_overlap');
    if (!laneOverlap) fail('invariant', 'bookings_no_lane_overlap exclusion constraint not found');
    else if (!/WHERE\s*\(/i.test(laneOverlap.body)) {
      fail('invariant', 'bookings_no_lane_overlap must be partial (active statuses only)');
    }
    if (!alterConstraints.find((c) => c.name === 'bookings_no_farmer_overlap')) {
      fail('invariant', 'bookings_no_farmer_overlap exclusion constraint not found');
    }
  }

  const proc = tables.get('procurements');
  if (proc && !/accepted_quantity_kg\s*\+\s*rejected_quantity_kg\)?\s*<=\s*gross_quantity_kg/i.test(proc.body)) {
    fail('invariant', 'procurements is missing the accepted + rejected <= gross CHECK');
  }

  const cap = tables.get('storage_capacity');
  if (cap && !/storage_capacity_scope_target/i.test(cap.body)) {
    fail('invariant', 'storage_capacity is missing the scope-target guard (P-4)');
  }

  const notif = tables.get('notifications');
  if (notif && !/dedupe_key\s+text\s+NOT\s+NULL\s+UNIQUE/i.test(notif.body)) {
    fail('invariant', 'notifications.dedupe_key must be NOT NULL UNIQUE for send idempotency');
  }

  const msp = tables.get('msp_rates');
  if (msp && !/msp_rates_official_requires_import_batch/i.test(msp.body)) {
    fail('invariant', 'msp_rates must require an import batch for OFFICIAL rows');
  }
}

// ---------------------------------------------------------------------------
// 12. Audit immutability
// ---------------------------------------------------------------------------
{
  const required = ['UPDATE', 'DELETE', 'TRUNCATE'];
  const auditTriggers = triggers.filter((t) => /\bON\s+audit_logs\b/i.test(t.body));
  for (const op of required) {
    const found = auditTriggers.some(
      (t) => new RegExp(`BEFORE\\s+${op}\\s+ON\\s+audit_logs`, 'i').test(t.body)
             && /FOR\s+EACH\s+STATEMENT/i.test(t.body),
    );
    if (!found) {
      fail('audit-immutability',
        `audit_logs has no statement-level BEFORE ${op} trigger; a zero-row ${op} would otherwise succeed silently`);
    }
  }
  const auditTable = tables.get('audit_logs');
  if (auditTable) {
    if (/ON\s+DELETE\s+SET\s+NULL/i.test(auditTable.body)) {
      fail('audit-immutability',
        'audit_logs uses ON DELETE SET NULL, which is an UPDATE and would be blocked by its own immutability trigger');
    }
  }
  const revokes = migrations.some((m) => /REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+TABLE\s+audit_logs/i.test(m.raw));
  if (!revokes) warn('audit-immutability', 'No privilege REVOKE found for audit_logs');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const line = '-'.repeat(74);
console.log(line);
console.log('FarmQueue migration static check');
console.log('Text and structure only. This does NOT verify PostgreSQL syntax.');
console.log(line);
for (const n of notes) console.log('  info    ', n);

const partialIndexes = indexes.filter((i) => i.partial);
console.log('  info     ', `${partialIndexes.length} partial indexes`);
console.log(line);

if (warnings.length) {
  console.log(`WARNINGS (${warnings.length})`);
  for (const w of warnings) console.log(`  [${w.check}] ${w.detail}`);
  console.log(line);
}

if (failures.length) {
  console.log(`FAILURES (${failures.length})`);
  for (const f of failures) console.log(`  [${f.check}] ${f.detail}`);
  console.log(line);
  console.log('RESULT: FAILED');
  process.exit(1);
}

console.log(`RESULT: PASSED — ${failures.length} failures, ${warnings.length} warnings`);
console.log('Note: this tool checks text and structure only. It does not parse SQL.');
console.log('For real verification run server/scripts/verify-schema.sql against PostgreSQL.');
process.exit(0);
