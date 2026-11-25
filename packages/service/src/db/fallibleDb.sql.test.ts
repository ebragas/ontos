import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db, type DbFailure } from './index.ts';
import { settle, type AsyncFallible } from '../errors/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { checkTrace, span } from '../spans/index.ts';
import { routeRecording } from '../tracing.test-utils.ts';

let postgres: TestPostgres;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  postgres = await startPostgres();

  pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });

  db = createDb(pool);

  await settle(db.query({ text: 'CREATE TABLE t (id text PRIMARY KEY)', values: [] }));
});

afterAll(async () => {
  await pool?.end();

  await postgres?.stop();
});

beforeEach(async () => {
  await settle(db.query({ text: 'DELETE FROM t', values: [] }));
});

const sql = (text: string, ...values: unknown[]) => ({ text, values });

const written = async (id: string) => {
  const read = await settle(db.query<{ id: string }>(sql('SELECT id FROM t WHERE id = $1', id)));

  return read.ok ? read.value.length === 1 : read;
};

async function ended(pid: number): Promise<void> {
  for (;;) {
    const read = await settle(
      db.query<{ n: number }>(sql('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', pid)),
    );

    if (read.ok && read.value[0]?.n === 0) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const insert = (tx: Db, id: string) => tx.query(sql('INSERT INTO t VALUES ($1)', id));

describe('the fallible Db', () => {
  it('commits a run that ends with its value, and the calls inside the run pass their failures up with yield*', async () => {
    const result = await settle(
      db.transaction(async function* (tx): AsyncFallible<number, DbFailure> {
        yield* insert(tx, 'a');

        const rows = yield* tx.query<{ n: number }>(sql('SELECT count(*)::int AS n FROM t'));

        return rows[0]?.n ?? 0;
      }),
    );

    expect(result).toEqual({ ok: true, value: 1 });

    expect(await written('a')).toBe(true);
  });

  it('rolls back a run that yields a failure, and gives that failure as a value', async () => {
    const result = await settle(
      db.transaction(async function* (tx): AsyncFallible<never, string | DbFailure> {
        yield* insert(tx, 'b');

        return yield 'stop';
      }),
    );

    expect(result).toEqual({ ok: false, error: 'stop' });

    expect(await written('b')).toBe(false);

    expect(pool.idleCount).toBe(1);
  });

  it('rolls back a run whose statement fails, and gives the kind refused with the error of Postgres', async () => {
    const result = await settle(
      db.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
        yield* insert(tx, 'c');

        yield* insert(tx, 'c');
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'refused', error: { code: '23505' } } });

    expect(await written('c')).toBe(false);
  });

  it('rolls back a run that throws, and passes the thrown value on unchanged', async () => {
    const thrown = new Error('a defect');

    const run = settle(
      db.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
        yield* insert(tx, 'd');

        throw thrown;
      }),
    );

    await expect(run).rejects.toBe(thrown);

    expect(await written('d')).toBe(false);

    expect(pool.idleCount).toBe(1);
  });

  it('gives the kind refused for a COMMIT that Postgres answers with an error, as a deferred constraint does', async () => {
    await settle(
      db.query(sql('CREATE TABLE IF NOT EXISTS d (id text, CONSTRAINT one UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)')),
    );

    const result = await settle(
      db.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
        yield* tx.query(sql("INSERT INTO d VALUES ('x'), ('x')"));
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'refused', error: { code: '23505' } } });
  });

  it('gives the kind outcomeUnknown for a COMMIT whose connection drops after it is sent', async () => {
    let pid: number | undefined;
    const lossy = createPool(postgres.url, { max: 1 });
    const connect = lossy.connect.bind(lossy);

    const dropping = async () => {
      const client = await connect();

      const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

      const dropAfterCommit = (text: unknown, values?: unknown) => {
        const sent = query(text, values);

        if (text === 'COMMIT') {
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- pg keeps the socket in its private field connection.stream, and the test destroys it.
          (client as unknown as { connection: { stream: { destroy: () => void } } }).connection.stream.destroy();
        }

        return sent;
      };

      return Object.assign(client, { query: dropAfterCommit });
    };

    try {
      const result = await settle(
        createDb(Object.assign(lossy, { connect: dropping })).transaction(async function* (tx): AsyncFallible<
          void,
          DbFailure
        > {
          const [row] = yield* tx.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));

          pid = row?.pid;

          yield* insert(tx, 'e');
        }),
      );

      expect(result).toMatchObject({ ok: false, error: { kind: 'outcomeUnknown' } });

      if (pid === undefined) throw new Error('The run read no server process.');

      await ended(pid);
    } finally {
      await lossy.end();
    }
  });

  it('gives the kind refused, with the code 25P04, for a COMMIT after the server ended the session at its transaction_timeout', async () => {
    const result = await settle(
      db.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
        yield* tx.query(sql("SELECT set_config('transaction_timeout', '200ms', true)"));

        yield* insert(tx, 'f');

        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'refused', error: { code: '25P04' } } });

    expect(await written('f')).toBe(false);
  });

  it('gives the kind unavailable when the pool gives no connection', async () => {
    const closed = createPool('postgres://postgres@127.0.0.1:1/none', { connectionTimeoutMillis: 500 });

    try {
      expect(await settle(createDb(closed).query(sql('SELECT 1')))).toMatchObject({
        ok: false,
        error: { kind: 'unavailable' },
      });
    } finally {
      await closed.end();
    }
  });

  it('streams the rows, gives the failure of the read as its return value, and drops its connection', async () => {
    const rows: unknown[] = [];

    const stream = db.stream<{ n: number }>(
      sql('SELECT g AS n FROM generate_series(1, 1500) AS g WHERE 1 / (1200 - g) IS NOT NULL'),
    );

    let step = await stream.next();

    while (!step.done) {
      rows.push(step.value.n);

      step = await stream.next();
    }

    expect(rows).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
    expect(step.value).toMatchObject({ kind: 'refused', error: { code: '22012' } });
    expect(pool.totalCount).toBe(0);
  });

  it('refuses a nested transaction and a call on an ended transaction Db as defects', async () => {
    let kept: Db | undefined;

    await settle(
      db.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
        kept = tx;

        yield* tx.query(sql('SELECT 1'));

        await expect(settle(tx.transaction(() => tx.query(sql('SELECT 1'))))).rejects.toThrow(
          'A transaction is already open on this Db.',
        );
      }),
    );

    if (!kept) throw new Error('The run kept no Db.');

    await expect(settle(kept.query(sql('SELECT 1')))).rejects.toThrow(
      'This transaction has ended. Use its Db only inside the run of transaction or snapshot.',
    );
  });
});

describe('parallel snapshot reads', () => {
  it('runs concurrent snapshot queries across up to 4 Postgres backends in parallel, and uses only 1 connection for sequential queries', async () => {
    const wide = createPool(postgres.url, { max: 10, connectionTimeoutMillis: 2_000 });
    const wideDb = createDb(wide);

    try {
      const sequential = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<number[], DbFailure> {
          const first = yield* tx.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));
          const second = yield* tx.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));

          return [first[0]?.pid ?? 0, second[0]?.pid ?? 0];
        }),
      );

      if (!sequential.ok) throw new Error('Expected sequential snapshot to succeed.');

      expect(new Set(sequential.value).size).toBe(1);

      expect(wide.totalCount).toBe(1);

      const queryCount = 8;
      const sleepSeconds = 0.12;

      const parallel = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<number[], DbFailure> {
          const results = await Promise.all(
            Array.from({ length: queryCount }, () =>
              settle(tx.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid, pg_sleep($1)', sleepSeconds))),
            ),
          );

          const pids: number[] = [];

          for (const item of results) {
            if (!item.ok) return yield item.error;

            pids.push(item.value[0]?.pid ?? 0);
          }

          return pids;
        }),
      );

      if (!parallel.ok) throw new Error('Expected parallel snapshot to succeed.');

      expect(parallel.value).toHaveLength(queryCount);
      expect(new Set(parallel.value).size).toBe(4);
      expect(wide.totalCount).toBe(4);
      expect(wide.idleCount).toBe(4);
    } finally {
      await wide.end();
    }
  });

  it('keeps strict repeatable-read isolation across lazily opened sibling connections', async () => {
    const wide = createPool(postgres.url, { max: 10, connectionTimeoutMillis: 2_000 });
    const wideDb = createDb(wide);

    try {
      await settle(wideDb.query(sql('INSERT INTO t VALUES ($1)', 'before')));

      const seen = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<
          { readonly pids: number[]; readonly snapshots: string[][] },
          DbFailure
        > {
          const committed = await settle(wideDb.query(sql('INSERT INTO t VALUES ($1)', 'after')));

          if (!committed.ok) return yield committed.error;

          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              settle(
                tx.query<{ pid: number; ids: string[] }>(
                  sql(
                    'SELECT pg_backend_pid() AS pid, (SELECT array_agg(id ORDER BY id) FROM t) AS ids, pg_sleep(0.08)',
                  ),
                ),
              ),
            ),
          );

          const pids: number[] = [];
          const snapshots: string[][] = [];

          for (const item of results) {
            if (!item.ok) return yield item.error;

            pids.push(item.value[0]?.pid ?? 0);

            snapshots.push(item.value[0]?.ids ?? []);
          }

          return { pids, snapshots };
        }),
      );

      if (!seen.ok) throw new Error('Expected repeatable-read snapshot to succeed.');

      expect(new Set(seen.value.pids).size).toBe(4);
      expect(seen.value.snapshots).toEqual([['before'], ['before'], ['before'], ['before']]);

      expect(wide.idleCount).toBe(wide.totalCount);
    } finally {
      await wide.end();
    }
  });

  it('queues concurrent snapshot queries without deadlock on a max-1 pool', async () => {
    const ran = await settle(
      db.snapshot(async function* (tx): AsyncFallible<number[], DbFailure> {
        const results = await Promise.all(
          Array.from({ length: 4 }, (_, index) => settle(tx.query<{ n: number }>(sql('SELECT $1::int AS n', index)))),
        );

        const values: number[] = [];

        for (const item of results) {
          if (!item.ok) return yield item.error;

          values.push(item.value[0]?.n ?? -1);
        }

        return values;
      }),
    );

    expect(ran).toEqual({ ok: true, value: [0, 1, 2, 3] });
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
  });

  it('releases all sibling and primary connections cleanly when a sibling query fails or the run throws', async () => {
    const wide = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
    const wideDb = createDb(wide);

    try {
      const failed = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<void, DbFailure> {
          const results = await Promise.all([
            settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
            settle(tx.query(sql('SELECT 1 / 0'))),
            settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
            settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
          ]);

          for (const item of results) if (!item.ok) return yield item.error;
        }),
      );

      expect(failed).toMatchObject({ ok: false, error: { kind: 'refused', error: { code: '22012' } } });
      expect(wide.idleCount).toBe(wide.totalCount);
      expect(wide.waitingCount).toBe(0);

      const defect = new Error('snapshot exploded');

      await expect(
        settle(
          wideDb.snapshot(async function* (tx): AsyncFallible<void, DbFailure> {
            const results = await Promise.all([
              settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
              settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
              settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
              settle(tx.query(sql('SELECT pg_sleep(0.05)'))),
            ]);

            for (const item of results) if (!item.ok) return yield item.error;

            throw defect;
          }),
        ),
      ).rejects.toBe(defect);

      expect(wide.idleCount).toBe(wide.totalCount);
      expect(wide.waitingCount).toBe(0);

      expect(await settle(wideDb.query(sql('SELECT 1 AS ok')))).toEqual({ ok: true, value: [{ ok: 1 }] });
    } finally {
      await wide.end();
    }
  });

  it('runs concurrent snapshot streams across up to 4 Postgres backends and releases every connection cleanly', async () => {
    const wide = createPool(postgres.url, { max: 10, connectionTimeoutMillis: 2_000 });
    const wideDb = createDb(wide);

    try {
      const readAll = async (stream: AsyncGenerator<{ pid: number; n: number }, DbFailure | undefined, undefined>) => {
        const rows: { pid: number; n: number }[] = [];

        let step = await stream.next();

        while (!step.done) {
          rows.push(step.value);

          step = await stream.next();
        }

        if (step.value !== undefined) throw step.value;

        return rows;
      };

      const ran = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<number[], DbFailure> {
          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              readAll(
                tx.stream<{ pid: number; n: number }>(
                  sql(
                    'SELECT pg_backend_pid() AS pid, g AS n FROM generate_series(1, 3) AS g WHERE pg_sleep(0.03) IS NOT NULL',
                  ),
                ),
              ),
            ),
          );

          if (results.some((rows) => rows.length !== 3))
            return yield { kind: 'refused', error: new Error('unexpected row count') };

          return results.map((rows) => rows[0]?.pid ?? 0);
        }),
      );

      if (!ran.ok) throw new Error('Expected concurrent streams snapshot to succeed.');

      expect(new Set(ran.value).size).toBe(4);

      expect(wide.totalCount).toBe(4);
      expect(wide.idleCount).toBe(4);
    } finally {
      await wide.end();
    }
  });

  const earlyExitDefect = new Error('abort mid-open');

  it.each([
    [
      'returns early',
      (): string => 'early',
      { status: 'resolved', value: { ok: true, value: 'early' } },
      'primary:COMMIT',
    ],
    [
      'throws',
      (): string => {
        throw earlyExitDefect;
      },
      { status: 'rejected', error: earlyExitDefect },
      'primary:ROLLBACK',
    ],
  ] as const)(
    'drains in-flight sibling opens before ending primary when the snapshot run %s',
    async (_label, finish, expected, primaryEnd) => {
      const recorder = routeRecording.recorder;

      if (recorder === undefined) throw new Error('The sql project setup records the spans.');

      const wide = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
      const connect = wide.connect.bind(wide);
      const events: string[] = [];
      const siblingImporting = Promise.withResolvers<undefined>();
      const releaseSibling = Promise.withResolvers<undefined>();
      let connectCount = 0;

      const intercepted = async () => {
        const client = await connect();

        connectCount += 1;

        const isPrimary = connectCount === 1;
        const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;
        const release = client.release.bind(client);

        const wrappedQuery = async (text: unknown, values?: unknown) => {
          if (isPrimary && (text === 'COMMIT' || text === 'ROLLBACK')) events.push(`primary:${text}`);

          if (!isPrimary && typeof text === 'string' && text.startsWith('SET TRANSACTION SNAPSHOT ')) {
            siblingImporting.resolve(undefined);

            await releaseSibling.promise;
          }

          const answer = await query(text, values);

          if (!isPrimary && text === 'ROLLBACK') events.push('sibling:ROLLBACK');

          return answer;
        };

        const wrappedRelease = (err?: Error | boolean) => {
          events.push(isPrimary ? 'primary:release' : 'sibling:release');

          release(err);
        };

        return Object.assign(client, { query: wrappedQuery, release: wrappedRelease });
      };

      const wrappedDb = createDb(Object.assign(wide, { connect: intercepted }));

      recorder.reset();

      try {
        const run = span('root', { 'route.key': 'GET /api/v2/ontologies' }, () =>
          settle(
            wrappedDb.snapshot(async function* (tx): AsyncFallible<string, DbFailure> {
              const first = settle(tx.query(sql('SELECT pg_sleep(0.03)')));

              void settle(tx.query(sql('SELECT 1'))).catch(() => undefined);

              await siblingImporting.promise;

              const firstResult = await first;

              if (!firstResult.ok) return yield firstResult.error;

              setTimeout(() => releaseSibling.resolve(undefined), 40);

              return finish();
            }),
          ),
        );

        const outcome = await run.then(
          (value) => ({ status: 'resolved' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

        expect(outcome).toEqual(expected);

        expect(events.indexOf('sibling:ROLLBACK')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('sibling:release')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('sibling:ROLLBACK')).toBeLessThan(events.indexOf(primaryEnd));
        expect(events.indexOf('sibling:release')).toBeLessThan(events.indexOf(primaryEnd));
        expect(wide.totalCount).toBe(wide.idleCount);
        expect(wide.waitingCount).toBe(0);
        expect(recorder.open()).toEqual([]);
        expect(checkTrace(recorder.spans())).toEqual([]);
      } finally {
        await wide.end();
      }
    },
  );

  it('falls back to primary and disables further sibling opens when SET TRANSACTION SNAPSHOT fails', async () => {
    const wide = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
    const connect = wide.connect.bind(wide);
    let connectCount = 0;
    let importAttempts = 0;

    const intercepted = async () => {
      const client = await connect();

      connectCount += 1;

      const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

      const wrappedQuery = (text: unknown, values?: unknown) => {
        if (typeof text === 'string' && text.startsWith('SET TRANSACTION SNAPSHOT ')) {
          importAttempts += 1;

          return Promise.reject(
            Object.assign(new Error('SET TRANSACTION SNAPSHOT unsupported'), { severity: 'ERROR', code: '0A000' }),
          );
        }

        return query(text, values);
      };

      return Object.assign(client, { query: wrappedQuery });
    };

    const wrappedDb = createDb(Object.assign(wide, { connect: intercepted }));

    try {
      const ran = await settle(
        wrappedDb.snapshot(async function* (tx): AsyncFallible<number[], DbFailure> {
          const wave1 = await Promise.all([
            settle(tx.query<{ n: number }>(sql('SELECT 1::int AS n, pg_sleep(0.04)'))),
            settle(tx.query<{ n: number }>(sql('SELECT 2::int AS n'))),
          ]);

          const wave2 = await Promise.all([
            settle(tx.query<{ n: number }>(sql('SELECT 3::int AS n, pg_sleep(0.04)'))),
            settle(tx.query<{ n: number }>(sql('SELECT 4::int AS n'))),
            settle(tx.query<{ n: number }>(sql('SELECT 5::int AS n'))),
          ]);

          const values: number[] = [];

          for (const item of [...wave1, ...wave2]) {
            if (!item.ok) return yield item.error;

            values.push(item.value[0]?.n ?? -1);
          }

          return values;
        }),
      );

      expect(ran).toEqual({ ok: true, value: [1, 2, 3, 4, 5] });
      expect(importAttempts).toBe(1);
      expect(connectCount).toBe(2);
      expect(wide.totalCount).toBe(wide.idleCount);
      expect(wide.waitingCount).toBe(0);
    } finally {
      await wide.end();
    }
  });

  it('reuses a parallel sibling slot cleanly after an early break mid-cursor on tx.stream()', async () => {
    const wide = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
    const wideDb = createDb(wide);

    try {
      const ran = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<
          {
            readonly primaryPid: number;
            readonly siblingPid: number;
            readonly reusedPid: number;
            readonly seen: number[];
          },
          DbFailure
        > {
          const holdPrimary = settle(tx.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid, pg_sleep(0.25)')));
          const seen: number[] = [];
          let siblingPid = 0;

          const stream = tx.stream<{ pid: number; n: number }>(
            sql('SELECT pg_backend_pid() AS pid, g AS n FROM generate_series(1, 500) AS g'),
          );

          try {
            let step = await stream.next();

            while (!step.done) {
              siblingPid = step.value.pid;

              seen.push(step.value.n);

              if (seen.length === 3) break;

              step = await stream.next();
            }

            if (step.done && step.value !== undefined) return yield step.value;
          } finally {
            await stream.return(undefined);
          }

          const reused = yield* tx.query<{ pid: number; ok: number }>(sql('SELECT pg_backend_pid() AS pid, 42 AS ok'));

          const primaryResult = await holdPrimary;

          if (!primaryResult.ok) return yield primaryResult.error;

          return { primaryPid: primaryResult.value[0]?.pid ?? 0, siblingPid, reusedPid: reused[0]?.pid ?? 0, seen };
        }),
      );

      if (!ran.ok) throw new Error('Expected sibling stream reuse snapshot to succeed.');

      expect(ran.value.seen).toEqual([1, 2, 3]);
      expect(ran.value.siblingPid).not.toBe(ran.value.primaryPid);
      expect(ran.value.reusedPid).toBe(ran.value.siblingPid);

      expect(wide.totalCount).toBe(2);
      expect(wide.idleCount).toBe(2);
      expect(wide.waitingCount).toBe(0);
    } finally {
      await wide.end();
    }
  });

  it('drops connections whose cleanup ROLLBACK fails in openSibling', async () => {
    const siblingPool = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
    const siblingConnect = siblingPool.connect.bind(siblingPool);
    let siblingConnects = 0;

    const failingSiblingConnect = async () => {
      const client = await siblingConnect();

      siblingConnects += 1;

      if (siblingConnects === 1) return client;

      const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

      const wrappedQuery = (text: unknown, values?: unknown) => {
        if (typeof text === 'string' && text.startsWith('SET TRANSACTION SNAPSHOT '))
          return Promise.reject(new Error('import failed'));

        if (text === 'ROLLBACK') return Promise.reject(new Error('sibling rollback failed'));

        return query(text, values);
      };

      return Object.assign(client, { query: wrappedQuery });
    };

    try {
      const ran = await settle(
        createDb(Object.assign(siblingPool, { connect: failingSiblingConnect })).snapshot(
          async function* (tx): AsyncFallible<number[], DbFailure> {
            const results = await Promise.all([
              settle(tx.query<{ n: number }>(sql('SELECT 1::int AS n, pg_sleep(0.04)'))),
              settle(tx.query<{ n: number }>(sql('SELECT 2::int AS n'))),
            ]);

            const values: number[] = [];

            for (const item of results) {
              if (!item.ok) return yield item.error;

              values.push(item.value[0]?.n ?? -1);
            }

            return values;
          },
        ),
      );

      expect(ran).toEqual({ ok: true, value: [1, 2] });
      expect(siblingPool.totalCount).toBe(1);
      expect(siblingPool.idleCount).toBe(1);
    } finally {
      await siblingPool.end();
    }
  });

  const primaryAbortDefect = new Error('primary abort');

  it.each([
    ['yields', (): string => 'stop', { status: 'resolved', value: { ok: false, error: 'stop' } }],
    [
      'throws',
      (): string => {
        throw primaryAbortDefect;
      },
      { status: 'rejected', error: primaryAbortDefect },
    ],
  ] as const)(
    'drops primary connections whose cleanup ROLLBACK fails in inSnapshot when the run %s',
    async (_mode, fail, expected) => {
      const primaryPool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
      const primaryConnect = primaryPool.connect.bind(primaryPool);

      const failingPrimaryConnect = async () => {
        const client = await primaryConnect();

        const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

        const wrappedQuery = (text: unknown, values?: unknown) => {
          if (text === 'ROLLBACK') return Promise.reject(new Error('primary rollback failed'));

          return query(text, values);
        };

        return Object.assign(client, { query: wrappedQuery });
      };

      try {
        const run = settle(
          createDb(Object.assign(primaryPool, { connect: failingPrimaryConnect })).snapshot(
            async function* (tx): AsyncFallible<never, string | DbFailure> {
              yield* tx.query(sql('SELECT 1'));

              return yield fail();
            },
          ),
        );

        const outcome = await run.then(
          (value) => ({ status: 'resolved' as const, value }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

        expect(outcome).toEqual(expected);
        expect(primaryPool.totalCount).toBe(0);
      } finally {
        await primaryPool.end();
      }
    },
  );

  it('starts a snapshot in 1 SQL roundtrip and commits primary and siblings concurrently on clean completion', async () => {
    const wide = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
    const connect = wide.connect.bind(wide);
    const primaryQueries: string[] = [];
    const primaryCommitting = Promise.withResolvers<undefined>();
    const siblingCommitting = Promise.withResolvers<undefined>();
    let connectCount = 0;

    const intercepted = async () => {
      const client = await connect();

      connectCount += 1;

      const isPrimary = connectCount === 1;
      const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

      const wrappedQuery = async (text: unknown, values?: unknown) => {
        if (isPrimary && typeof text === 'string') primaryQueries.push(text);

        if (text === 'COMMIT') {
          if (isPrimary) {
            primaryCommitting.resolve(undefined);

            await siblingCommitting.promise;
          } else {
            siblingCommitting.resolve(undefined);

            await primaryCommitting.promise;
          }
        }

        return query(text, values);
      };

      return Object.assign(client, { query: wrappedQuery });
    };

    try {
      const ran = await settle(
        createDb(Object.assign(wide, { connect: intercepted })).snapshot(async function* (tx): AsyncFallible<
          number[],
          DbFailure
        > {
          const results = await Promise.all([
            settle(tx.query<{ n: number }>(sql('SELECT 1::int AS n, pg_sleep(0.05)'))),
            settle(tx.query<{ n: number }>(sql('SELECT 2::int AS n'))),
          ]);

          const values: number[] = [];

          for (const item of results) {
            if (!item.ok) return yield item.error;

            values.push(item.value[0]?.n ?? -1);
          }

          return values;
        }),
      );

      expect(ran).toEqual({ ok: true, value: [1, 2] });

      expect(primaryQueries[0]).toBe(
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot() AS snapshot',
      );

      expect(primaryQueries.filter((q) => q.includes('pg_export_snapshot'))).toHaveLength(1);
      expect(wide.totalCount).toBe(2);
      expect(wide.idleCount).toBe(2);
    } finally {
      await wide.end();
    }
  });

  it('opens a sibling immediately while primary holds a paused stream cursor without deadlocking', async () => {
    const wide = createPool(postgres.url, { max: 6, connectionTimeoutMillis: 2_000 });
    const wideDb = createDb(wide);

    try {
      const ran = await settle(
        wideDb.snapshot(async function* (tx): AsyncFallible<
          { readonly first: number; readonly sibling: number; readonly total: number },
          DbFailure
        > {
          const stream = tx.stream<{ n: number }>(sql('SELECT g AS n FROM generate_series(1, 50) AS g'));

          try {
            const firstStep = await stream.next();

            if (firstStep.done) return yield firstStep.value ?? { kind: 'refused', error: new Error('empty stream') };

            const [siblingRow] = yield* tx.query<{ n: number }>(sql('SELECT 99::int AS n'));
            let total = 1;

            for (let step = await stream.next(); !step.done; step = await stream.next()) total += 1;

            return { first: firstStep.value.n, sibling: siblingRow?.n ?? 0, total };
          } finally {
            await stream.return(undefined);
          }
        }),
      );

      expect(ran).toEqual({ ok: true, value: { first: 1, sibling: 99, total: 50 } });
      expect(wide.totalCount).toBe(2);
      expect(wide.idleCount).toBe(2);
    } finally {
      await wide.end();
    }
  });
});
