import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { Handle, HandleInput } from '../handler/index.ts';
import type { ListedOsdkSet } from '../ontology/index.ts';
import type { PublishResponse } from './index.ts';
import { grantsOf, irOf, twinObjectType } from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { noUsers, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { newDatabase, OSDK_SET, type TestDatabase, expectAllOnNewest } from './publish.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

const LATER_SET = { ...OSDK_SET, '@osdk/client': '2.90.0' };

const LISTED: ListedOsdkSet[] = [
  { name: 'client-2.80.0', packages: OSDK_SET, platformPackages: {}, deprecated: true },
  { name: 'client-2.90.0', packages: LATER_SET, platformPackages: {} },
];

// oxlint-disable-next-line landmines/no-test-doubles -- The real osdk-sets.json lists no deprecated set.
vi.mock('../ontology/index.ts', async (original) => ({
  ...(await original<typeof import('../ontology/index.ts')>()),
  readOsdkSets: () => LISTED,
}));

const WARNING =
  'The OSDK set client-2.80.0 is deprecated. Move to an OSDK set that is not deprecated: client-2.90.0. Only a new major version can remove it.';

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

async function publish(
  osdkSet: Readonly<Record<string, string>>,
  validateOnly: boolean,
): Promise<{ status: number; answer: PublishResponse; text: string }> {
  vi.resetModules();

  const handle: Handle = (await import('../handler/index.ts')).handle;

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
      ir: irOf(twinObjectType('Account')),
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet,
      grants: grantsOf(irOf(twinObjectType('Account'))),
      validateOnly,
    }),
  });

  const response = await handle(request, input);

  const text = await response.text();

  return { status: response.status, answer: JSON.parse(text) as PublishResponse, text };
}

describe('a publish with a deprecated OSDK set', () => {
  it.each([
    { validateOnly: true, version: undefined },
    { validateOnly: false, version: 1 },
  ])(
    'service/releases#osdk-sets service/publish#route: succeeds, and the answer holds the warning (validateOnly $validateOnly)',
    async ({ validateOnly, version }) => {
      const { status, answer } = await publish(OSDK_SET, validateOnly);

      expect(status).toBe(200);
      expect(answer.warnings).toEqual([WARNING]);
      expect(answer.version).toBe(version);
    },
  );

  it('service/publish#route: the warnings stay the last field of the answer, as the same bytes', async () => {
    const { text } = await publish(OSDK_SET, true);

    expect(text.endsWith(`,"warnings":${JSON.stringify([WARNING])}}`)).toBe(true);
    expect(text.split('"warnings"')).toHaveLength(2);
  });

  it('service/releases#osdk-sets service/publish#route: a publish with a set that is not deprecated has no warnings', async () => {
    const { status, answer } = await publish(LATER_SET, false);

    expect(status).toBe(200);
    expect(answer).not.toHaveProperty('warnings');
    expect(answer.version).toBe(1);
  });
});
