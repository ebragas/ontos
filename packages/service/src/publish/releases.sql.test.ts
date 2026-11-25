import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import { ApiError } from '../errors/index.ts';
import type { Handle, HandleInput } from '../handler/index.ts';
import type { GrantsFile } from '../ontology/index.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import type { OsdkSet } from './index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { noUsers, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import {
  FIRST_IR,
  LATER_SET,
  LISTED_SET,
  OSDK_SETS_FILE,
  publishFirst,
  rejection,
  storedVersions,
  workOrderTableExists,
} from './releasesSupport.test-utils.ts';
import { firstOntology, newDatabase, type TestDatabase, expectAllOnNewest } from './publish.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

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

async function newInstance(): Promise<Handle> {
  vi.resetModules();

  return (await import('../handler/index.ts')).handle;
}

const GRANTS: GrantsFile = {
  permissions: { [USE]: { description: 'Use the twin' } },
  objectTypes: Object.fromEntries([...firstOntology.objectTypes.keys()].map((name) => [name, USE])),
  actionTypes: Object.fromEntries([...firstOntology.actionTypes.keys()].map((name) => [name, USE])),
  defaultRoles: { admin: [USE] },
};

async function sendPublish(handle: Handle, validateOnly: boolean, osdkSet: OsdkSet): Promise<Response> {
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
      ir: FIRST_IR,
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet,
      grants: GRANTS,
      validateOnly,
    }),
  });

  return handle(request, input);
}

describe('the OSDK set of a publish', () => {
  it('service/releases#osdk-sets: an applied publish of a set that the release does not list fails with 400, names the package and the listed sets, and applies nothing', async () => {
    const error = await rejection(publishFirst(database.db, false, LATER_SET));

    expect(error).toBeInstanceOf(ApiError);

    expect(error).toMatchObject({
      status: 400,
      errorName: 'Default:InvalidArgument',
      parameters: { packages: ['@osdk/client'], listedOsdkSets: OSDK_SETS_FILE },
    });

    expect(await workOrderTableExists(database.db)).toBe(false);

    expect(await storedVersions(database.db)).toEqual([]);
  });

  it('service/releases#osdk-sets: a validateOnly publish of a set that the release does not list also fails with 400', async () => {
    const error = await rejection(publishFirst(database.db, true, LATER_SET));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, parameters: { packages: ['@osdk/client'] } });
  });

  it('service/releases#osdk-sets: the route refuses the set in the OSDK error shape, and the error names the package and the listed sets', async () => {
    const response = await sendPublish(await newInstance(), true, LATER_SET);

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { packages: ['@osdk/client'], listedOsdkSets: OSDK_SETS_FILE },
    });
  });

  it('service/releases#osdk-sets: publish takes the listed sets from packages/service/osdk-sets.json', async () => {
    for (const set of OSDK_SETS_FILE) {
      await expect(publishFirst(database.db, true, set.packages)).resolves.toMatchObject({
        changes: expect.any(Array),
      });
    }

    expect(await rejection(publishFirst(database.db, true, LATER_SET))).toMatchObject({
      parameters: { listedOsdkSets: OSDK_SETS_FILE },
    });
  });

  it('an environment with no Ontology version passes the cold-start check, so the first publish works', async () => {
    const response = await sendPublish(await newInstance(), false, LISTED_SET);

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({ version: 1 });
  });
});
