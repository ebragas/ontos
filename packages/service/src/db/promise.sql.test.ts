import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type DbFailure } from './index.ts';
import { createDb, fallibleOf, type Db } from './promise.test-utils.ts';
import { settle, type AsyncFallible } from '../errors/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';

let postgres: TestPostgres;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  postgres = await startPostgres();

  pool = createPool(postgres.url);

  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();

  await postgres?.stop();
});

const sql = (text: string) => ({ text, values: [] });

async function endSession(tx: Db): Promise<void> {
  const [row] = await tx.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));

  await db.query({ text: 'SELECT pg_terminate_backend($1)', values: [row?.pid] });

  await new Promise((resolve) => setTimeout(resolve, 300));
}

describe('a session that the server ends between 2 statements of a transaction', () => {
  it('gives the end of the session, 57P01, when the next statement fails with no code', async () => {
    const run = db.transaction(async (tx) => {
      await endSession(tx);

      await tx.query(sql('SELECT 1'));
    });

    await expect(run).rejects.toMatchObject({ code: '57P01' });
  });

  it('gives the end of the session, 57P01, when the run then throws its own error with no code', async () => {
    const run = db.transaction(async (tx) => {
      await endSession(tx);

      throw new Error('the run refused');
    });

    await expect(run).rejects.toMatchObject({ code: '57P01' });
  });

  it('gives the end of the session, 57P01, when the run wraps the failed statement in an error with no code', async () => {
    const run = db.transaction(async (tx) => {
      await endSession(tx);

      await tx.query(sql('SELECT 1')).catch((error: unknown) => {
        throw new Error('The upgrade of 1 installation failed.', { cause: error });
      });
    });

    await expect(run).rejects.toMatchObject({ code: '57P01' });
  });
});

describe('the fallible form that fallibleOf makes from a Promise Db', () => {
  it('keeps the kind outcomeUnknown of a COMMIT whose connection drops after it is sent', async () => {
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
      const reverse = fallibleOf(createDb(Object.assign(lossy, { connect: dropping })));

      const result = await settle(
        reverse.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
          yield* tx.query(sql('SELECT 1'));
        }),
      );

      expect(result).toMatchObject({ ok: false, error: { kind: 'outcomeUnknown' } });
    } finally {
      await lossy.end();
    }
  });

  it('keeps the kind refused of a statement that Postgres answers with an error', async () => {
    expect(await settle(fallibleOf(db).query(sql('SELECT 1 / 0')))).toMatchObject({
      ok: false,
      error: { kind: 'refused', error: { code: '22012' } },
    });
  });
});
