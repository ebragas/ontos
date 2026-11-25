import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import { grantsOf } from '../ontology/stored.test-utils.ts';
import type { HandleInput } from '../handler/index.ts';
import type { PublishResponse } from './index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { noUsers, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { LISTED_SET } from './releasesSupport.test-utils.ts';
import { newDatabase, sql, tablesOf, type TestDatabase, expectAllOnNewest } from './publish.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

const IR_0_7_0: unknown = JSON.parse(readFileSync(new URL('../../twin/ir/0.7.0.json', import.meta.url), 'utf8'));

const FUNCTION_BACKED = [
  'com.example.twin.close-account-action',
  'com.example.twin.probe-version-check-action',
  'com.example.twin.set-relationship-action',
];

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  await import('../handler/index.ts');

  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  const pool = createPool(database.url);

  pooledDb = createDb(pool);

  endPooled = () => pool.end();

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  consoleLog.mockRestore();

  await endPooled();

  await database.end();
});

async function publishWithNoFunctions(validateOnly: boolean): Promise<Response> {
  vi.resetModules();

  const { handle } = await import('../handler/index.ts');

  const input: HandleInput = {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: testSettings,
    keys: issuer.keys,
    users: noUsers,
    workos: stubPublish(),
  };

  const request = new Request('http://localhost/api/ontology-service/v1/publish', {
    method: 'POST',
    headers: { authorization: `Bearer ${await issuer.github()}` },
    body: JSON.stringify({
      ir: IR_0_7_0,
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet: LISTED_SET,
      grants: grantsOf(IR_0_7_0),
      validateOnly,
    }),
  });

  return handle(request, input);
}

async function storedVersionCount(): Promise<number> {
  const [row] = await database.db.query<{ count: number }>(
    sql('SELECT count(*)::int AS count FROM ontology_registry.product_versions'),
  );

  return row?.count ?? -1;
}

describe('a function-backed IR with no Functions', () => {
  it('service/publish#route: a validateOnly publish through the route skips the Function checks, applies nothing, and shows each function-backed Action with no parameters', async () => {
    const response = await publishWithNoFunctions(true);

    expect(response.status).toBe(200);

    const body = (await response.json()) as PublishResponse;

    expect(body.version).toBeUndefined();

    for (const apiName of FUNCTION_BACKED) {
      expect(body.metadata.actionTypes[apiName]).toMatchObject({ apiName, parameters: {} });
    }

    expect(await storedVersionCount()).toBe(0);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);
  });

  it('service/publish#route: a publish that applies through the route still fails with 400 that names the Function, and applies nothing', async () => {
    const response = await publishWithNoFunctions(false);

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: {
        feature:
          'Action Type com.example.twin.close-account-action has a Function rule for the Function closeAccount, which the version does not have. A function-backed Action needs its Function.',
      },
    });

    expect(await storedVersionCount()).toBe(0);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);
  });
});
