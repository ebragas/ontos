import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Sql } from './index.ts';
import { createDb, type Db } from './promise.test-utils.ts';
import { checkTrace, span, type FinishedSpan } from '../spans/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { recordSpans, type SpanRecorder } from '../tracing.test-utils.ts';

const RULE = 'service/observability#traces';
const STATEMENT: Sql = { text: "SELECT $1::text AS v, 'k' AS k, 7 AS n", values: ['CANARY-sql'] };
const TEMPLATE = 'SELECT $1::text AS v, ? AS k, ? AS n';

let postgres: TestPostgres;
let db: Db;
let end: () => Promise<void>;
let recorder: SpanRecorder;

beforeAll(async () => {
  postgres = await startPostgres();

  const pool = createPool(postgres.url);

  db = createDb(pool);

  end = () => pool.end();

  recorder = recordSpans();
});

afterAll(async () => {
  recorder.stop();

  await end();

  await postgres.stop();
});

beforeEach(() => recorder.reset());

async function rows(source: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const read = [];

  for await (const row of source) read.push(row);

  return read;
}

async function traceOf(site: (db: Db) => Promise<Record<string, unknown>[]>): Promise<FinishedSpan[]> {
  const read = await span('root', { 'route.key': 'GET /api/v2/ontologies' }, () => site(db));

  expect(read).toEqual([{ v: 'CANARY-sql', k: 'k', n: 7 }]);

  return recorder.spans();
}

const statements = (spans: readonly FinishedSpan[]) => spans.filter((s) => s.name === 'sql');
const templates = (spans: readonly FinishedSpan[]) => statements(spans).map((s) => s.attributes['sql.template']);

const SITES: readonly [string, (db: Db) => Promise<Record<string, unknown>[]>, readonly string[], true | undefined][] =
  [
    ['query', (d) => d.query(STATEMENT), [TEMPLATE], undefined],
    ['stream', (d) => rows(d.stream(STATEMENT)), [TEMPLATE], undefined],
    [
      'transaction, with the query of its Db',
      (d) => d.transaction((tx) => tx.query(STATEMENT)),
      ['BEGIN ISOLATION LEVEL READ COMMITTED', TEMPLATE, 'COMMIT'],
      true,
    ],
    [
      'transaction, with the stream of its Db',
      (d) => d.transaction((tx) => rows(tx.stream(STATEMENT))),
      ['BEGIN ISOLATION LEVEL READ COMMITTED', TEMPLATE, 'COMMIT'],
      true,
    ],
    [
      'snapshot, with the query of its Db',
      (d) => d.snapshot((tx) => tx.query(STATEMENT)),
      ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot() AS snapshot', TEMPLATE, 'COMMIT'],
      true,
    ],
    [
      'snapshot, with the stream of its Db',
      (d) => d.snapshot((tx) => rows(tx.stream(STATEMENT))),
      ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot() AS snapshot', TEMPLATE, 'COMMIT'],
      true,
    ],
  ];

describe('the spans of the SQL sites', () => {
  it.each(SITES)(
    `${RULE}: %s gives a statement span with its template and 1 connection wait span`,
    async (_site, site, expected) => {
      const spans = await traceOf(site);

      expect(templates(spans)).toEqual(expected);

      const waits = spans.filter((s) => s.name === 'sql connection wait');

      expect(waits).toHaveLength(1);
      expect(waits[0]?.end).toBeLessThanOrEqual(statements(spans)[0]?.start ?? 0n);
      expect(checkTrace(spans)).toEqual([]);
    },
  );

  it.each(SITES)(
    `${RULE}: %s gives held only to a statement inside a transaction or a snapshot`,
    async (_site, site, _expected, held) => {
      const spans = await traceOf(site);

      expect(statements(spans)).not.toHaveLength(0);

      for (const s of statements(spans)) expect(s.attributes['sql.held']).toBe(held);
    },
  );

  it.each(SITES)(`${RULE}: %s gives no span that holds the parameter value CANARY-sql`, async (_site, site) => {
    const spans = await traceOf(site);

    expect(statements(spans)).not.toHaveLength(0);

    const text = spans.map((s) => [s.name, ...Object.values(s.attributes).map(String)].join(' ')).join('\n');

    expect(text).not.toContain('CANARY-sql');
  });

  it(`${RULE}: parallel reads in a snapshot record held SQL spans with a parameterized snapshot template and a valid trace`, async () => {
    const read = await span('root', { 'route.key': 'GET /api/v2/ontologies' }, () =>
      db.snapshot((tx) =>
        Promise.all([
          tx.query({ text: 'SELECT $1::text AS v, pg_sleep(0.05)', values: ['CANARY-sql'] }),
          tx.query({ text: 'SELECT $1::text AS v, pg_sleep(0.05)', values: ['CANARY-sql'] }),
        ]),
      ),
    );

    expect(read).toHaveLength(2);

    const spans = recorder.spans();

    expect(templates(spans)).toContain(
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot() AS snapshot',
    );

    expect(templates(spans)).toContain('SET TRANSACTION SNAPSHOT ?');
    expect(spans.filter((s) => s.name === 'sql connection wait').length).toBe(2);

    for (const s of statements(spans)) expect(s.attributes['sql.held']).toBe(true);

    const text = spans.map((s) => [s.name, ...Object.values(s.attributes).map(String)].join(' ')).join('\n');

    expect(text).not.toContain('CANARY-sql');
    expect(checkTrace(spans)).toEqual([]);
  });
});

describe('a stream that the caller stops early', () => {
  const MANY: Sql = { text: 'SELECT n FROM generate_series(1, 1000) AS n', values: [] };

  const STOPPED: readonly [string, (db: Db) => Promise<unknown>][] = [
    ['stream', (d) => firstRow(d.stream(MANY))],
    ['transaction, with the stream of its Db', (d) => d.transaction((tx) => firstRow(tx.stream(MANY)))],
    ['snapshot, with the stream of its Db', (d) => d.snapshot((tx) => firstRow(tx.stream(MANY)))],
  ];

  async function firstRow(source: AsyncIterable<Record<string, unknown>>): Promise<unknown> {
    for await (const row of source) return row;

    throw new Error('The stream gave no row.');
  }

  it.each(STOPPED)(
    `${RULE}: %s ends its statement span when the caller stops after the first row`,
    async (_site, site) => {
      expect(await span('root', { 'route.key': 'GET /api/v2/ontologies' }, () => site(db))).toEqual({ n: 1 });

      const spans = recorder.spans();

      expect(templates(spans)).toContain('SELECT n FROM generate_series(?, ?) AS n');
      expect(recorder.open()).toEqual([]);
      expect(checkTrace(spans)).toEqual([]);
    },
  );
});

describe('a failed statement', () => {
  const FAILING: Sql = { text: 'SELECT $1::int AS v', values: ['CANARY-sql'] };

  const FAILED_SITES: readonly [string, (db: Db) => Promise<unknown>, readonly string[]][] = [
    ['query', (d) => d.query(FAILING), ['SELECT $1::int AS v']],
    ['stream', (d) => rows(d.stream(FAILING)), ['SELECT $1::int AS v']],
    [
      'transaction',
      (d) => d.transaction((tx) => tx.query(FAILING)),
      ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT $1::int AS v', 'ROLLBACK'],
    ],
  ];

  it.each(FAILED_SITES)(
    `${RULE}: %s gives a failed statement span with its template and no CANARY-sql`,
    async (_site, site, expected) => {
      const failure = await span('root', { 'route.key': 'GET /api/v2/ontologies' }, () => site(db)).catch(
        (error: unknown) => error,
      );

      expect(String(failure)).toContain('CANARY-sql');

      const spans = recorder.spans();

      expect(templates(spans)).toEqual(expected);

      const failed = statements(spans).find((s) => s.attributes['sql.template'] === 'SELECT $1::int AS v');

      expect(failed?.attributes['error.type']).toBe('DatabaseError');

      const text = spans.map((s) => [s.name, ...Object.values(s.attributes).map(String)].join(' ')).join('\n');

      expect(text).not.toContain('CANARY-sql');
    },
  );
});

describe('query on a pool connection', () => {
  it('rejects, and throws no uncaught exception, when the connection fails during the statement', async () => {
    const pool = createPool(postgres.url);

    pool.on('acquire', (client) => {
      if (!(client instanceof pg.Client)) throw new Error('The pool gave a client that is not a pg.Client.');

      setTimeout(() => client.connection.stream.destroy(new Error('The test reset the connection.')), 100);
    });

    try {
      await expect(createDb(pool).query({ text: 'SELECT pg_sleep(1)', values: [] })).rejects.toThrow(
        'The test reset the connection.',
      );
    } finally {
      await pool.end();
    }
  });

  it('drops the connection of a failed statement', async () => {
    const pool = createPool(postgres.url, { max: 1 });

    try {
      await expect(createDb(pool).query({ text: 'SELECT $1::int AS v', values: ['not a number'] })).rejects.toThrow(
        'invalid input syntax',
      );

      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
