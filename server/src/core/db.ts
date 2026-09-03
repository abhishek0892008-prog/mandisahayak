/**
 * PostgreSQL access.
 *
 * The only place in the codebase that opens a connection or a transaction.
 * Services receive a client and never reach for the pool themselves, which is
 * what makes "the audit row is written in the same transaction as the change"
 * enforceable rather than aspirational.
 */
import pg from 'pg';
import { getConfig } from './config.ts';

export type Db = pg.PoolClient | pg.Pool;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getConfig().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      // An idle client failing must not take the process down.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on any
 * throw. Every state change in this application goes through here.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth surfacing.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read-only convenience for queries that need no transaction. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}
