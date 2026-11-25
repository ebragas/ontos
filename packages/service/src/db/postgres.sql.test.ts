import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPool, sharedEngineChanges } from './index.ts';
import { createDb, type Db } from './promise.test-utils.ts';
import { createEngineTemplate, engineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

describe('the test Postgres', () => {
  it('runs Postgres 17, as Neon does', async () => {
    const pool = createPool(postgres.url);

    try {
      const [row] = await createDb(pool).query<{ server_version_num: string }>({
        text: 'SHOW server_version_num',
        values: [],
      });

      expect(row?.server_version_num.slice(0, 2)).toBe('17');
    } finally {
      await pool.end();
    }
  });

  it('service/testing#postgres: runs with fsync and synchronous_commit off and its data directory on tmpfs', async () => {
    const pool = createPool(postgres.url);
    const db = createDb(pool);

    try {
      const [fsync] = await db.query<{ fsync: string }>({ text: 'SHOW fsync', values: [] });

      const [sync] = await db.query<{ synchronous_commit: string }>({ text: 'SHOW synchronous_commit', values: [] });

      const [dataDir] = await db.query<{ data_directory: string }>({ text: 'SHOW data_directory', values: [] });

      const [mounts] = await db.query<{ mounts: string }>({
        text: "SELECT pg_read_file('/proc/mounts') AS mounts",
        values: [],
      });

      const dataMount = mounts?.mounts.split('\n').find((line) => line.split(' ')[1] === dataDir?.data_directory);

      expect({
        fsync: fsync?.fsync,
        synchronous_commit: sync?.synchronous_commit,
        fstype: dataMount?.split(' ')[2],
      }).toEqual({
        fsync: 'off',
        synchronous_commit: 'off',
        fstype: 'tmpfs',
      });
    } finally {
      await pool.end();
    }
  });

  it('service/testing#postgres: clones databases concurrently from the run template with the shared engine changes applied, keeps each clone isolated, and keeps the template after stop', async () => {
    const template = engineTemplate();
    const expectedIds = sharedEngineChanges.map((change) => change.id);

    const clones = await Promise.all(Array.from({ length: 6 }, () => startPostgres({ template: 'engine' })));

    try {
      const results = await Promise.all(
        clones.map(async (clone, index) => {
          const pool = createPool(clone.url);
          const db = createDb(pool);

          try {
            const ids = (
              await db.query<{ id: string }>({
                text: 'SELECT id FROM ontology_registry.engine_changes ORDER BY xmin::text::bigint, id',
                values: [],
              })
            ).map((row) => row.id);

            const extensions = await db.query<{ extname: string; schema: string }>({
              text: "SELECT e.extname, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'",
              values: [],
            });

            const [locale] = await db.query<{ provider: string; icu: string | null }>({
              text: 'SELECT datlocprovider::text AS provider, datlocale AS icu FROM pg_database WHERE datname = current_database()',
              values: [],
            });

            await db.query({
              text: 'INSERT INTO ontology_registry.engine_changes (id) VALUES ($1)',
              values: [`clone-${index}`],
            });

            return { ids, extensions, locale };
          } finally {
            await pool.end();
          }
        }),
      );

      for (const result of results) {
        expect(result.ids).toEqual(expectedIds);
        expect(result.extensions).toEqual([{ extname: 'pg_trgm', schema: 'ontology_registry' }]);
        expect(result.locale).toEqual({ provider: 'i', icu: 'und' });
      }

      const counts = await Promise.all(
        clones.map(async (clone) => {
          const pool = createPool(clone.url);

          try {
            const [row] = await createDb(pool).query<{ count: number }>({
              text: "SELECT count(*)::int AS count FROM ontology_registry.engine_changes WHERE id LIKE 'clone-%'",
              values: [],
            });

            return row?.count;
          } finally {
            await pool.end();
          }
        }),
      );

      expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
    } finally {
      await Promise.all(clones.map((clone) => clone.stop()));
    }

    const pool = createPool(postgres.url);

    try {
      const db = createDb(pool);

      const remaining = await db.query<{ datname: string }>({
        text: 'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
        values: [clones.map((clone) => clone.role)],
      });

      expect(remaining).toEqual([]);

      const [kept] = await db.query<{ datname: string; datistemplate: boolean; datallowconn: boolean }>({
        text: 'SELECT datname, datistemplate, datallowconn FROM pg_database WHERE datname = $1',
        values: [template],
      });

      expect(kept).toEqual({ datname: template, datistemplate: true, datallowconn: false });
    } finally {
      await pool.end();
    }
  });

  it('service/testing#postgres: createEngineTemplate builds a per-role template whose clones let an ordinary role read and write ontology_registry, and stop drops both clones and template', async () => {
    const other = await startPostgres();

    const serviceRole = `${other.role}_ordinary`;
    const password = 'ordinary-template-password';
    const admin = new pg.Client({ connectionString: other.url });

    await admin.connect();

    let templateName = '';
    const cloneNames = [`${other.role}_clone_1`, `${other.role}_clone_2`];

    try {
      await admin.query(
        `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );

      templateName = await createEngineTemplate(other.url, { name: serviceRole, password });

      await Promise.all(
        cloneNames.map(async (name) => {
          const client = new pg.Client({ connectionString: other.url });

          await client.connect();

          try {
            await client.query(`CREATE DATABASE ${name} TEMPLATE ${templateName}`);

            await client.query(`GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);
          } finally {
            await client.end();
          }
        }),
      );
    } finally {
      await admin.end();
    }

    try {
      for (const name of cloneNames) {
        const url = new URL(other.url);

        url.username = serviceRole;
        url.password = password;
        url.pathname = `/${name}`;

        const pool = createPool(url.toString());
        const db = createDb(pool);

        try {
          const ids = (
            await db.query<{ id: string }>({
              text: 'SELECT id FROM ontology_registry.engine_changes ORDER BY xmin::text::bigint, id',
              values: [],
            })
          ).map((row) => row.id);

          expect(ids).toEqual(sharedEngineChanges.map((change) => change.id));

          await db.query({
            text: 'INSERT INTO ontology_registry.engine_changes (id) VALUES ($1)',
            values: [`ordinary-${name}`],
          });
        } finally {
          await pool.end();
        }
      }
    } finally {
      await other.stop();
    }

    const pool = createPool(postgres.url);

    try {
      const remaining = await createDb(pool).query<{ datname: string }>({
        text: 'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
        values: [[templateName, ...cloneNames]],
      });

      expect(remaining).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('commits a transaction, and rolls back a transaction that throws', async () => {
    const pool = createPool(postgres.url);
    const db = createDb(pool);

    try {
      await db.query({ text: 'CREATE TABLE t (id text primary key)', values: [] });

      await db.transaction((tx) => tx.query({ text: 'INSERT INTO t VALUES ($1)', values: ['a'] }));

      await expect(
        db.transaction(async (tx) => {
          await tx.query({ text: 'INSERT INTO t VALUES ($1)', values: ['b'] });

          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');

      expect(await db.query({ text: 'SELECT id FROM t ORDER BY id', values: [] })).toEqual([{ id: 'a' }]);
    } finally {
      await pool.end();
    }
  });

  it('opens a read-only repeatable read snapshot', async () => {
    const pool = createPool(postgres.url);
    const db = createDb(pool);

    try {
      const rows = await db.snapshot((tx) => tx.query({ text: 'SHOW transaction_isolation', values: [] }));

      expect(rows).toEqual([{ transaction_isolation: 'repeatable read' }]);

      await expect(db.snapshot((tx) => tx.query({ text: 'CREATE TABLE u (id text)', values: [] }))).rejects.toThrow(
        /read-only/,
      );
    } finally {
      await pool.end();
    }
  });

  it('frees its connection when the snapshot run throws, so a Function run never keeps it', async () => {
    const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
    const db = createDb(pool);

    try {
      await expect(
        db.snapshot(async (tx) => {
          await tx.query({ text: 'SELECT 1', values: [] });

          throw new Error('the Function failed');
        }),
      ).rejects.toThrow('the Function failed');

      expect(pool.idleCount).toBe(1);

      expect(await db.query({ text: 'SHOW transaction_isolation', values: [] })).toEqual([
        { transaction_isolation: 'read committed' },
      ]);
    } finally {
      await pool.end();
    }
  });

  it('refuses a query on a transaction Db or a SnapshotDb after its run ends', async () => {
    const pool = createPool(postgres.url);
    const db = createDb(pool);

    try {
      const kept = await db.transaction((tx) => Promise.resolve(tx));

      const keptSnapshot = await db.snapshot((tx) => Promise.resolve(tx));

      const ended = 'This transaction has ended. Use its Db only inside the run of transaction or snapshot.';

      await expect(kept.query({ text: 'SELECT 1', values: [] })).rejects.toThrow(ended);

      await expect(keptSnapshot.query({ text: 'SELECT 1', values: [] })).rejects.toThrow(ended);
    } finally {
      await pool.end();
    }
  });

  it('refuses a query on a kept Db after a run that throws at once, before it returns a promise', async () => {
    const pool = createPool(postgres.url);
    const db = createDb(pool);

    try {
      let kept: Db | undefined;
      let keptSnapshot: Db | undefined;

      const throwAtOnce = (tx: Db): Promise<never> => {
        kept = tx;

        throw new Error('the run failed at once');
      };

      await expect(db.transaction(throwAtOnce)).rejects.toThrow('the run failed at once');

      await expect(
        db.snapshot((tx) => {
          keptSnapshot = tx;

          throw new Error('the run failed at once');
        }),
      ).rejects.toThrow('the run failed at once');

      const ended = 'This transaction has ended. Use its Db only inside the run of transaction or snapshot.';

      await expect(kept?.query({ text: 'SELECT 1', values: [] })).rejects.toThrow(ended);

      await expect(keptSnapshot?.query({ text: 'SELECT 1', values: [] })).rejects.toThrow(ended);
    } finally {
      await pool.end();
    }
  });

  it('keeps serving after the database closes an idle connection, as on a restart', async () => {
    const pool = createPool(postgres.url);
    const db = createDb(pool);
    const admin = createPool(postgres.url);
    const logged = vi.spyOn(console, 'error');

    try {
      const [row] = await db.query<{ pid: number }>({ text: 'SELECT pg_backend_pid() AS pid', values: [] });

      const idleFailed = Promise.withResolvers<undefined>();

      pool.once('error', () => idleFailed.resolve(undefined));

      await createDb(admin).query({ text: 'SELECT pg_terminate_backend($1)', values: [row?.pid] });

      await idleFailed.promise;

      expect(logged).toHaveBeenCalledWith(
        'An idle database connection failed, and the pool removed it.',
        expect.objectContaining({ code: '57P01' }),
      );

      expect(await db.query({ text: 'SELECT 1 AS one', values: [] })).toEqual([{ one: 1 }]);
    } finally {
      logged.mockRestore();

      await pool.end();

      await admin.end();
    }
  });

  describe('stop', () => {
    async function connected(): Promise<{ other: TestPostgres; client: pg.Client; errors: unknown[] }> {
      const other = await startPostgres();

      const client = new pg.Client({ connectionString: other.url });
      const errors: unknown[] = [];

      client.on('error', (error) => errors.push(error));

      await client.connect();

      return { other, client, errors };
    }

    it('waits for a connection that closes while it runs, and that connection gets no error', async () => {
      const { other, client, errors } = await connected();

      let stopped: Promise<void> | undefined;

      const closed = new Promise<void>((resolve) => {
        stopped = other.stop(() => resolve(client.end()));
      });

      await closed;

      await stopped;

      expect(errors).toEqual([]);
    });

    it('ends the session of a connection that stays open', async () => {
      const { other, client, errors } = await connected();

      try {
        await other.stop();

        await vi.waitFor(() => expect(errors[0]).toMatchObject({ code: '57P01' }));
      } finally {
        await client.end();
      }
    });

    it('drops every database that the role owns', async () => {
      const other = await startPostgres();

      const extra = `${other.role}_extra`;
      const admin = new pg.Client({ connectionString: other.url });

      await admin.connect();

      try {
        await admin.query(`CREATE DATABASE ${extra}`);
      } finally {
        await admin.end();
      }

      await other.stop();

      const pool = createPool(postgres.url);

      try {
        const rows = await createDb(pool).query<{ datname: string }>({
          text: 'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
          values: [[other.role, extra]],
        });

        expect(rows).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });

  describe('stream', () => {
    const rows = { text: 'SELECT n FROM generate_series(1, $1::int) AS n', values: [500] };

    it('reads every row', async () => {
      const pool = createPool(postgres.url);

      try {
        const seen: number[] = [];

        for await (const row of createDb(pool).stream<{ n: number }>(rows)) seen.push(row.n);

        expect(seen).toHaveLength(500);
        expect(seen.at(-1)).toBe(500);
      } finally {
        await pool.end();
      }
    });

    it('frees its connection when the reader stops early, as when a client goes away', async () => {
      const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
      const db = createDb(pool);

      try {
        for await (const row of db.stream<{ n: number }>(rows)) if (row.n === 3) break;

        expect(await db.query({ text: 'SELECT 1 AS one', values: [] })).toEqual([{ one: 1 }]);
      } finally {
        await pool.end();
      }
    });

    it('frees its connection when the reader throws', async () => {
      const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
      const db = createDb(pool);

      try {
        await expect(
          (async () => {
            for await (const row of db.stream<{ n: number }>(rows)) if (row.n === 3) throw new Error('the page failed');
          })(),
        ).rejects.toThrow('the page failed');

        expect(await db.query({ text: 'SELECT 1 AS one', values: [] })).toEqual([{ one: 1 }]);
      } finally {
        await pool.end();
      }
    });

    it('frees its connection when the query fails', async () => {
      const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
      const db = createDb(pool);

      try {
        await expect(
          (async () => {
            for await (const row of db.stream({ text: 'SELECT * FROM no_such_table', values: [] })) void row;
          })(),
        ).rejects.toThrow(/no_such_table/);

        expect(await db.query({ text: 'SELECT 1 AS one', values: [] })).toEqual([{ one: 1 }]);
      } finally {
        await pool.end();
      }
    });

    describe('when the socket of its connection resets during the read', () => {
      const sleep = { text: 'SELECT pg_sleep(1)', values: [] };

      function resettingPool(): pg.Pool {
        const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });

        pool.on('acquire', (client) => {
          const { stream } = (client as pg.PoolClient & { connection: { stream: { destroy: (error: Error) => void } } })
            .connection;

          setTimeout(() => stream.destroy(new Error('reset')), 100);
        });

        return pool;
      }

      it('rejects, and the pool drops the connection', async () => {
        const pool = resettingPool();

        try {
          await expect(
            (async () => {
              for await (const row of createDb(pool).stream(sleep)) void row;
            })(),
          ).rejects.toThrow('reset');

          expect(pool.totalCount).toBe(0);
        } finally {
          await pool.end();
        }
      });

      it('rejects the snapshot that reads it', async () => {
        const pool = resettingPool();

        try {
          await expect(
            createDb(pool).snapshot(async (tx) => {
              for await (const row of tx.stream(sleep)) void row;
            }),
          ).rejects.toThrow('reset');

          expect(pool.totalCount).toBe(0);
        } finally {
          await pool.end();
        }
      });
    });

    it('rejects with the code of the server when the server ends the session during the read', async () => {
      const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
      const adminPool = createPool(postgres.url);
      const admin = createDb(adminPool);
      let terminated: Promise<unknown> | undefined;

      pool.on('acquire', (client) => {
        const { processID } = client as pg.PoolClient & { processID: number };

        setTimeout(() => {
          terminated = admin.query({ text: 'SELECT pg_terminate_backend($1)', values: [processID] });
        }, 100);
      });

      try {
        await expect(
          (async () => {
            for await (const row of createDb(pool).stream({ text: 'SELECT pg_sleep(1)', values: [] })) void row;
          })(),
        ).rejects.toMatchObject({ code: '57P01' });

        await terminated;

        expect(pool.totalCount).toBe(0);
      } finally {
        await pool.end();

        await adminPool.end();
      }
    });

    describe('when the connection breaks while the reader holds a row, and no fetch waits', () => {
      type Client = pg.PoolClient & { processID: number; connection: { stream: { destroy: (error: Error) => void } } };

      const many = { text: 'SELECT n FROM generate_series(1, 1000000) AS n', values: [] };
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      let adminPool: pg.Pool;

      beforeAll(() => {
        adminPool = createPool(postgres.url);
      });

      afterAll(() => adminPool.end());

      const breaks: [string, (client: Client) => Promise<unknown>, string][] = [
        [
          'its socket resets',
          async (client) => client.connection.stream.destroy(new Error('The test reset the connection.')),
          'The test reset the connection.',
        ],
        [
          'the server ends its session',
          (client) =>
            createDb(adminPool).query({ text: 'SELECT pg_terminate_backend($1)', values: [client.processID] }),
          'terminating connection due to administrator command',
        ],
      ];

      function watchedPool(): { pool: pg.Pool; client: () => Client } {
        const pool = createPool(postgres.url, { max: 1, connectionTimeoutMillis: 2_000 });
        let last: Client | undefined;

        pool.on('acquire', (client) => {
          last = client as Client;
        });

        return { pool, client: () => last as Client };
      }

      async function readAll(
        rows: AsyncIterable<unknown>,
        client: () => Client,
        breakIt: (client: Client) => Promise<unknown>,
      ) {
        let first = true;

        for await (const row of rows) {
          void row;

          if (!first) continue;

          first = false;

          await pause(300);

          await breakIt(client());

          await pause(300);
        }
      }

      describe.each(breaks)('as when %s', (_name, breakIt, error) => {
        it('rejects, and the pool drops the connection', async () => {
          const { pool, client } = watchedPool();

          try {
            await expect(readAll(createDb(pool).stream(many), client, breakIt)).rejects.toThrow(error);

            expect(pool.totalCount).toBe(0);
          } finally {
            await pool.end();
          }
        });

        it('rejects the snapshot that reads it', async () => {
          const { pool, client } = watchedPool();

          try {
            await expect(createDb(pool).snapshot((tx) => readAll(tx.stream(many), client, breakIt))).rejects.toThrow(
              error,
            );

            expect(pool.totalCount).toBe(0);
          } finally {
            await pool.end();
          }
        });
      });
    });

    it('leaves no end listener on its connection after each read', async () => {
      const pool = createPool(postgres.url, { max: 1 });
      let client: pg.PoolClient | undefined;

      pool.on('acquire', (acquired) => {
        client = acquired;
      });

      try {
        await createDb(pool).transaction(async (tx) => {
          const acquired = client;

          if (acquired === undefined) throw new Error('The pool gave no connection.');

          const before = acquired.listenerCount('end');

          for (let read = 0; read < 12; read++) for await (const row of tx.stream(rows)) void row;

          expect(acquired.listenerCount('end')).toBe(before);
        });
      } finally {
        await pool.end();
      }
    });

    it('reads in the snapshot of a SnapshotDb', async () => {
      const pool = createPool(postgres.url);
      const db = createDb(pool);

      try {
        const seen = await db.snapshot(async (tx) => {
          const isolation: unknown[] = [];

          for await (const row of tx.stream({ text: 'SHOW transaction_isolation', values: [] })) isolation.push(row);

          return isolation;
        });

        expect(seen).toEqual([{ transaction_isolation: 'repeatable read' }]);
      } finally {
        await pool.end();
      }
    });
  });
});
