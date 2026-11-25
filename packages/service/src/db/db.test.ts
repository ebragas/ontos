import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPool, quoteName } from './index.ts';

describe('names', () => {
  it('quotes a name and doubles each quote in it', () => {
    expect(quoteName('work_order')).toBe('"work_order"');
    expect(quoteName('a"b')).toBe('"a""b"');
  });
});

async function poolConnectionString(connectionString: string): Promise<string> {
  const pool = createPool(connectionString);

  try {
    return pool.options.connectionString ?? '';
  } finally {
    await pool.end();
  }
}

const requireHere = createRequire(import.meta.url);
const PARSER_PATH = createRequire(requireHere.resolve('pg')).resolve('pg-connection-string');

const PRINT_WARNINGS =
  "process.on('warning', (warning) => console.log(warning.message)); require(process.argv[1]).parse(process.argv[2]);";

function parseWarnings(connectionString: string): string {
  return execFileSync(process.execPath, ['-e', PRINT_WARNINGS, PARSER_PATH, connectionString], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe('createPool', () => {
  it('service/storage#connection: a pool to a database on another host requires SSL unless sslmode=disable is set', async () => {
    const pool = createPool('postgresql://app:secret@ep-quiet-1.us-east-2.aws.neon.tech/neondb');
    const dockerPool = createPool('postgresql://ontos:ontos@postgres:5432/ontos?sslmode=disable');

    try {
      expect(pool.options.ssl).toBe(true);
      expect(dockerPool.options.ssl).toBe(false);
    } finally {
      await Promise.all([pool.end(), dockerPool.end()]);
    }
  });

  const neon = (query: string) => `postgresql://app:secret@ep-quiet-1-pooler.us-east-2.aws.neon.tech/neondb${query}`;

  it.each([
    [neon('?sslmode=require'), neon('?sslmode=verify-full')],
    [neon('?sslmode=prefer'), neon('?sslmode=verify-full')],
    [neon('?sslmode=verify-ca'), neon('?sslmode=verify-full')],
    [neon('?sslmode=verify-full'), neon('?sslmode=verify-full')],
    [neon(''), neon('')],
    [neon('?sslmode=require&channel_binding=require'), neon('?sslmode=verify-full&channel_binding=require')],
    [neon('?sslmode=require&sslmode=disable'), neon('?sslmode=verify-full')],
    [
      'postgresql://postgres:postgres@localhost:5432/ontology?sslmode=require',
      'postgresql://postgres:postgres@localhost:5432/ontology?sslmode=require',
    ],
  ])('service/storage#connection: the pool of %s connects with %s', async (given, used) => {
    expect(await poolConnectionString(given)).toBe(used);
  });

  describe('SSL warning', () => {
    const required = neon('?sslmode=require&channel_binding=require');
    let rawWarnings = '';
    let poolWarnings = '';

    beforeAll(async () => {
      rawWarnings = parseWarnings(required);

      poolWarnings = parseWarnings(await poolConnectionString(required));
    });

    it('service/storage#connection: a parse of the connection string of the pool emits no SSL warning', () => {
      expect(rawWarnings).toContain('SECURITY WARNING');
      expect(poolWarnings).toBe('');
    });
  });

  it('uses direct SSL negotiation for Neon SSL pools and leaves non-Neon, local, and explicit overrides unchanged', async () => {
    const negotiationOf = (client: pg.Client & { readonly sslNegotiation?: string }) => client.sslNegotiation;
    const remote = createPool(neon('?sslmode=require'));
    const nonNeon = createPool('postgresql://postgres:postgres@0.0.0.0:5432/ontology');
    const local = createPool('postgresql://postgres:postgres@localhost:5432/ontology');
    const override = createPool(neon('?sslmode=verify-full&sslnegotiation=postgres'));
    const disabled = createPool(neon('?sslmode=disable'));

    try {
      expect(remote.options.sslnegotiation).toBe('direct');
      expect(nonNeon.options.sslnegotiation).toBeUndefined();
      expect(local.options.sslnegotiation).toBeUndefined();
      expect(override.options.sslnegotiation).toBeUndefined();
      expect(disabled.options.sslnegotiation).toBeUndefined();
      expect(negotiationOf(new pg.Client(remote.options))).toBe('direct');
      expect(negotiationOf(new pg.Client(nonNeon.options))).toBe('postgres');
      expect(negotiationOf(new pg.Client(local.options))).toBe('postgres');
      expect(negotiationOf(new pg.Client(override.options))).toBe('postgres');
      expect(negotiationOf(new pg.Client(disabled.options))).toBe('postgres');
    } finally {
      await Promise.all([remote.end(), nonNeon.end(), local.end(), override.end(), disabled.end()]);
    }
  });

  it('defaults idleTimeoutMillis to 60_000 and allows an explicit override', async () => {
    const defaultPool = createPool('postgresql://postgres:postgres@localhost:5432/ontology');

    const customPool = createPool('postgresql://postgres:postgres@localhost:5432/ontology', {
      idleTimeoutMillis: 15_000,
    });

    try {
      expect(defaultPool.options.idleTimeoutMillis).toBe(60_000);
      expect(customPool.options.idleTimeoutMillis).toBe(15_000);
    } finally {
      await Promise.all([defaultPool.end(), customPool.end()]);
    }
  });
});
