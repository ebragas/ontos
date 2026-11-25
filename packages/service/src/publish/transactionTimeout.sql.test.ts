import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb } from '../db/promise.test-utils.ts';
import { ApiError } from '../errors/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  firstOntology,
  newDatabase,
  onNewConnection,
  publishAndInstall,
  PUBLISHER,
  request,
  sql,
  type TestDatabase,
  APPLY,
  CHECK,
  expectAllOnNewest,
} from './publish.test-utils.ts';
import { TEST_PRODUCT } from '../service.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  await onNewConnection(postgres.url, 'ALTER ROLE CURRENT_USER RESET ALL');

  database = await newDatabase(postgres.url);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

it('service/publish#applying: a publish that transaction_timeout ends gets 400 with no uncaught exception, and the next publish runs on a new connection', async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => void uncaught.push(error);

  process.on('uncaughtException', onUncaught);

  const pool = createPool(database.url, { max: 1 });

  const firstEnded = new Promise<void>((resolve) =>
    pool.once('connect', (client) => client.once('end', () => resolve())),
  );

  const db = createDb(pool);
  const other = new pg.Client({ connectionString: database.url });

  await other.connect();

  try {
    const [before] = await db.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));

    await other.query('BEGIN');

    await other.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

    const error = await publishAndInstall(db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
      transactionTimeout: '1s',
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).errorName).toBe('PublishTimeExceededLimit');

    expect((error as ApiError).parameters).toEqual({
      phase: 'version',
      table: 'ontology_registry.product_versions',
      changed: false,
      transactionMs: expect.any(Number),
    });

    await other.query('COMMIT');

    await firstEnded;

    expect(uncaught).toEqual([]);

    const response = await publishAndInstall(db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    expect(response.version).toBe(1);

    const [after] = await db.query<{ pid: number }>(sql('SELECT pg_backend_pid() AS pid'));

    expect(after?.pid).not.toBe(before?.pid);
    expect(pool.totalCount).toBe(1);
  } finally {
    process.off('uncaughtException', onUncaught);

    await other.end().catch(() => undefined);

    await pool.end();
  }
});

it('service/storage#connection: a role default of transaction_timeout stays after a validateOnly publish, and is gone after a publish that applies', async () => {
  await onNewConnection(database.url, "ALTER ROLE CURRENT_USER SET transaction_timeout = '1h'");

  try {
    const shown = async () =>
      (await onNewConnection<{ transaction_timeout: string }>(database.url, 'SHOW transaction_timeout'))[0]
        ?.transaction_timeout;

    expect(await shown()).toBe('1h');

    await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(true),
      publisher: PUBLISHER,
      mode: CHECK,
    });

    expect(await shown()).toBe('1h');

    await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    expect(await shown()).toBe('0');
  } finally {
    await onNewConnection(database.url, 'ALTER ROLE CURRENT_USER RESET transaction_timeout');
  }
});
