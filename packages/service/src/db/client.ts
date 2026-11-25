import pg from 'pg';
import type { AsyncFallible } from '../errors/index.ts';
import { connect, inTransaction, poolStream, statement } from './connection.ts';
import { commitFailure } from './failure.ts';
import { inSnapshot } from './snapshot.ts';
import type { Db, DbFailure, Sql } from './types.ts';

export { applyEngineChanges, ontologyEngineChanges, REGISTRY_SCHEMA, sharedEngineChanges } from './engineChanges.ts';

export function createDb(pool: pg.Pool): Db {
  return {
    async *query<Row extends object>(sql: Sql): AsyncFallible<Row[], DbFailure> {
      const connection = yield* connect(pool);
      let failed = true;

      try {
        const rows = yield* statement<Row>(connection.client, sql, false, (error) =>
          commitFailure(undefined, false, error),
        );

        failed = false;

        return rows;
      } finally {
        connection.release(failed);
      }
    },
    stream: <Row extends object>(sql: Sql) => poolStream<Row>(pool, sql),
    transaction: (run) => inTransaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', run),
    snapshot: (run) => inSnapshot(pool, run),
  };
}

const IDLE_TIMEOUT_MS = 60_000;

export function createPool(
  connectionString: string,
  options: Pick<pg.PoolConfig, 'max' | 'connectionTimeoutMillis' | 'idleTimeoutMillis'> = {},
): pg.Pool {
  const url = new URL(connectionString);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const connection = local ? { connectionString } : remoteConnection(connectionString, url);
  const pool = new pg.Pool({ idleTimeoutMillis: IDLE_TIMEOUT_MS, ...connection, ...options });

  pool.on('error', (error) => console.error('An idle database connection failed, and the pool removed it.', error));

  return pool;
}

function remoteConnection(
  connectionString: string,
  url: URL,
): Pick<pg.PoolConfig, 'connectionString' | 'ssl' | 'sslnegotiation'> {
  const normalized = withVerifyFull(connectionString, url);

  if (!sslEnabled(url)) return { connectionString: normalized, ssl: false };

  const direct = isNeonHost(url.hostname) && !url.searchParams.has('sslnegotiation');

  return direct
    ? { connectionString: normalized, ssl: true, sslnegotiation: 'direct' }
    : { connectionString: normalized, ssl: true };
}

function isNeonHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith('.neon.tech');
}

function sslEnabled(url: URL): boolean {
  const sslmode = url.searchParams.getAll('sslmode').at(-1);

  if (sslmode !== undefined) return sslmode !== 'disable';

  return url.searchParams.getAll('ssl').at(-1) !== '0';
}

const VERIFY_FULL_ALIASES: readonly string[] = ['prefer', 'require', 'verify-ca'];

function withVerifyFull(connectionString: string, url: URL): string {
  if (!url.searchParams.getAll('sslmode').some((mode) => VERIFY_FULL_ALIASES.includes(mode))) return connectionString;

  url.searchParams.set('sslmode', 'verify-full');

  return url.href;
}
