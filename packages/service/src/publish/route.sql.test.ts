import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { OntologyIr } from '@osdk/client.unstable';
import type { Handle, HandleInput } from '../handler/index.ts';
import type { PublishedFunctions, PublishResponse } from './index.ts';
import {
  grantsOf,
  irOf,
  NS,
  stringProperty,
  twinFunctions,
  twinIr,
  twinObjectType,
} from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { noUsers, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { recording } from './releasesSupport.test-utils.ts';
import {
  columnsOf,
  newDatabase,
  OSDK_SET,
  sql,
  tablesOf,
  type TestDatabase,
  expectAllOnNewest,
} from './publish.test-utils.ts';
import { buffered, routeSpans } from '../routeHarness.test-utils.ts';
import type { FinishedSpan } from '../spans/index.ts';
import { STUB_WORKOS_KEY, stubPublish, stubWorkos, type StubWorkos } from '../workos.test-utils.ts';

const ACCOUNT_IR = irOf(twinObjectType('Account'));
const ACCOUNT = `${NS}Account`;

function withRegion(): OntologyIr {
  const block = twinObjectType('Account');

  block.objectType.propertyTypes['region'] = stringProperty('region');

  return irOf(block);
}

const INTERFACE = `${NS}Asset`;

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The IR types do not fit a partial Interface block, and the test needs only the Interface key.
const INTERFACE_IR = {
  ...ACCOUNT_IR,
  ontology: { ...ACCOUNT_IR.ontology, interfaceTypes: { [INTERFACE]: {} } },
} as unknown as OntologyIr;

const NO_INTERFACES = `The IR has the Interface ${INTERFACE}. V1 has no Interfaces.`;
const base = 'http://localhost';
const publishPath = '/api/ontology-service/v1/publish';

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let pooledStatements: string[];
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  await import('../handler/index.ts');

  await import('../auth/index.ts');

  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  const pool = createPool(database.url);

  pooledStatements = [];

  pooledDb = recording(createDb(pool), pooledStatements);

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

type Caller = 'publish' | 'person' | 'check';

async function token(caller: Caller): Promise<string> {
  if (caller === 'person') return issuer.workos();

  if (caller === 'check') return issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' });

  return issuer.github();
}

async function send(handle: Handle, caller: Caller, body: unknown, path = publishPath): Promise<Response> {
  const input: HandleInput = {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: testSettings,
    keys: issuer.keys,
    users: {
      ...noUsers,
      // oxlint-disable-next-line require-yield -- stub permission source for person validateOnly test.
      permissions: async function* () {
        return ['ontology:install'];
      },
    },
    workos: stubPublish(),
  };

  const request = new Request(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token(caller)}` },
    body: JSON.stringify(body),
  });

  return buffered(handle(request, input));
}

function body(validateOnly: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ir = extra['ir'] ?? ACCOUNT_IR;

  return {
    ir,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: grantsOf(ir),
    validateOnly,
    ...extra,
  };
}

function logLine(): Record<string, unknown> {
  const lines = consoleLog.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{'));

  return JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
}

interface StoredVersion {
  readonly version: number;
  readonly ir: unknown;
  readonly metadata: PublishResponse['metadata'];
  readonly schema_migrations: unknown;
  readonly osdk_set: unknown;
  readonly functions: unknown;
}

function storedVersions(): Promise<StoredVersion[]> {
  return database.db.query<StoredVersion>(
    sql(
      'SELECT version, ir, metadata, schema_migrations, osdk_set, functions FROM ontology_registry.product_versions ORDER BY version',
    ),
  );
}

const PLANNED = [{ description: `Create Object Type ${ACCOUNT}` }];

describe('the route', () => {
  it('service/publish#route: POST /api/ontology-service/v1/publish serves the publish', async () => {
    const response = await send(await newInstance(), 'publish', body(true));

    expect(response.status).toBe(200);

    const answer = (await response.json()) as PublishResponse;

    expect(answer.changes).toEqual(PLANNED);
    expect(Object.keys(answer.metadata.objectTypes)).toEqual([ACCOUNT]);
  });

  it('service/publish#route: the OSDK HTTP API v2 prefix has no publish route', async () => {
    const path = `/api/v2/ontologies/${TEST_ONTOLOGY_RID}/publish`;

    const response = await send(await newInstance(), 'publish', body(true), path);

    expect(response.status).toBe(404);

    expect(await response.text()).toBe('');
  });

  it('a request with the IR, the schema migrations file, the OSDK set, the Functions, and validateOnly is served', async () => {
    const functions: PublishedFunctions = { discovered: [], bundle: 'export const functions = {};' };

    const response = await send(await newInstance(), 'publish', body(true, { functions }));

    expect(response.status).toBe(200);
  });

  it.each(['ir', 'schemaMigrations', 'osdkSet'])(
    'a request with no %s fails with 400 that names the part',
    async (part) => {
      const request = Object.fromEntries(Object.entries(body(true)).filter(([key]) => key !== part));

      const response = await send(await newInstance(), 'publish', request);

      expect(response.status).toBe(400);

      expect(await response.json()).toEqual({
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        errorInstanceId: expect.any(String),
        parameters: { part },
      });
    },
  );

  it.each([
    ['ir', 'an IR with no ontology', { ir: {} }],
    ['ir', 'an IR with no Object Types', { ir: { ontology: { actionTypes: {} } } }],
    ['ir', 'an IR with no Action Types', { ir: { ontology: { objectTypes: {} } } }],
    ['functions', 'Functions whose discovered list is not a list', { functions: { discovered: 'x', bundle: '' } }],
    ['functions', 'a discovered Function with no locator', { functions: { discovered: [{}], bundle: '' } }],
    ['functions', 'Functions that are a number', { functions: 1 }],
    ['functions', 'Functions with no bundle', { functions: { discovered: [] } }],
    ['functions', 'Functions whose bundle is a number', { functions: { discovered: [], bundle: 1 } }],
    ['schemaMigrations', 'a null migration', { schemaMigrations: { migrations: [null] } }],
    ['schemaMigrations', 'a number migration', { schemaMigrations: { migrations: [1] } }],
    ['schemaMigrations', 'a migrations list that is not a list', { schemaMigrations: { migrations: {} } }],
    ['schemaMigrations', 'a migration with no kind', { schemaMigrations: { migrations: [{ objectType: ACCOUNT }] } }],
    [
      'schemaMigrations',
      'a dropProperty with no property',
      { schemaMigrations: { migrations: [{ type: 'dropProperty', objectType: ACCOUNT }] } },
    ],
    [
      'schemaMigrations',
      'a dropProperty with no Object Type',
      { schemaMigrations: { migrations: [{ type: 'dropProperty', property: 'name' }] } },
    ],
    [
      'schemaMigrations',
      'a dropAllPatches with no Object Type',
      { schemaMigrations: { migrations: [{ type: 'dropAllPatches' }] } },
    ],
    [
      'schemaMigrations',
      'a dropLinks whose Link Type is a number',
      { schemaMigrations: { migrations: [{ type: 'dropLinks', linkType: 1 }] } },
    ],
    [
      'schemaMigrations',
      'a renameProperty with no target',
      { schemaMigrations: { migrations: [{ type: 'renameProperty', objectType: ACCOUNT, source: 'name' }] } },
    ],
    [
      'schemaMigrations',
      'a renameProperty with no source',
      { schemaMigrations: { migrations: [{ type: 'renameProperty', objectType: ACCOUNT, target: 'fullName' }] } },
    ],
    [
      'schemaMigrations',
      'a renameProperty with no Object Type',
      { schemaMigrations: { migrations: [{ type: 'renameProperty', source: 'name', target: 'fullName' }] } },
    ],
    [
      'schemaMigrations',
      'a dropEditHistory with no Object Type',
      { schemaMigrations: { migrations: [{ type: 'dropEditHistory' }] } },
    ],
    ['osdkSet', 'an OSDK set that is a list', { osdkSet: [] }],
    ['osdkSet', 'a package version that is a number', { osdkSet: { ...OSDK_SET, '@osdk/client': 2 } }],
    ['validateOnly', 'a validateOnly that is a string', { validateOnly: 'true' }],
  ])('a request whose %s part is malformed (%s) fails with 400 that names the part', async (part, _case, extra) => {
    const response = await send(await newInstance(), 'publish', body(true, extra));

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { part },
    });
  });

  it.each([
    [
      '187f6a02',
      { type: 'cast', objectType: ACCOUNT, property: 'name', source: { type: 'string' }, target: { type: 'integer' } },
      'Cast property to new type',
    ],
    [
      '35977713',
      { type: 'revert', objectType: ACCOUNT, revert: 'ri.ontology.main.schema-migration.1' },
      'Revert migration',
    ],
    [
      '2829ac0a',
      { type: 'dropStructField', objectType: ACCOUNT, property: 'location', structField: 'floor' },
      'Drop all struct field edits',
    ],
    [
      '2829ac0a',
      {
        type: 'renameStructField',
        objectType: ACCOUNT,
        property: 'location',
        sourceStructField: 'floor',
        targetStructField: 'level',
      },
      'Move struct field edits',
    ],
    [
      '2829ac0a',
      {
        type: 'castStructField',
        objectType: ACCOUNT,
        property: 'location',
        structField: 'floor',
        source: { type: 'integer' },
        target: { type: 'string' },
      },
      'Cast struct field to new type',
    ],
    [
      'b9e43345',
      {
        type: 'renameDatasource',
        objectType: ACCOUNT,
        sourceDatasource: 'ri.datasource.1',
        targetDatasource: 'ri.datasource.2',
      },
      'Move edits to a new datasource',
    ],
  ])(
    'ontology/object-edits/schema-migrations#out-of-scope/%s: the route refuses %o, and the error names the feature %s',
    async (_rule, migration, feature) => {
      for (const validateOnly of [true, false]) {
        const response = await send(
          await newInstance(),
          'publish',
          body(validateOnly, { schemaMigrations: { migrations: [migration] } }),
        );

        expect(response.status).toBe(400);

        expect(await response.json()).toMatchObject({ errorName: 'Default:InvalidArgument', parameters: { feature } });
      }

      expect(await storedVersions()).toEqual([]);
    },
  );

  it('service/publish#route: an applied publish stores each schema migration with only the fields of its kind', async () => {
    const migration = { type: 'dropAllPatches', objectType: `${NS}Gone`, note: 'not stored' };
    const schemaMigrations = { migrations: [migration], comment: 'not stored' };

    const response = await send(await newInstance(), 'publish', body(false, { schemaMigrations }));

    expect(response.status).toBe(200);

    const [stored] = await storedVersions();

    expect(stored?.schema_migrations).toEqual({ migrations: [{ type: 'dropAllPatches', objectType: `${NS}Gone` }] });
  });

  it('an applied publish answers with the planned changes, the Ontology metadata, and the new version', async () => {
    const response = await send(await newInstance(), 'publish', body(false));

    expect(response.status).toBe(200);

    const [stored] = await storedVersions();

    expect(await response.json()).toEqual({
      changes: PLANNED,
      metadata: stored?.metadata,
      version: 1,
      transactionMs: expect.any(Number),
    });

    expect(Object.keys(stored?.metadata.objectTypes ?? {})).toEqual([ACCOUNT]);
  });

  it('service/publish#route: a pull request check validates the publish, and it applies nothing', async () => {
    const response = await send(await newInstance(), 'check', body(true));

    expect(response.status).toBe(200);

    const answer = (await response.json()) as PublishResponse;

    expect(answer.changes).toEqual(PLANNED);
    expect(Object.keys(answer.metadata.objectTypes)).toEqual([ACCOUNT]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);

    expect(await storedVersions()).toEqual([]);
  });

  it('service/publish#route: a person validates the publish, and it applies nothing', async () => {
    const response = await send(await newInstance(), 'person', body(true));

    expect(response.status).toBe(200);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);

    expect(await storedVersions()).toEqual([]);
  });
});

describe('what the app publishes', () => {
  it('publish compiles the IR of the request and its OSDK set', async () => {
    const response = await send(await newInstance(), 'publish', body(false));

    expect(response.status).toBe(200);

    const answer = (await response.json()) as PublishResponse;

    expect(answer.metadata.objectTypes[ACCOUNT]?.objectType.apiName).toBe(ACCOUNT);

    expect(await storedVersions()).toEqual([
      expect.objectContaining({ version: 1, ir: ACCOUNT_IR, osdk_set: OSDK_SET, metadata: answer.metadata }),
    ]);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    expect(await tablesOf(database.db, 'ontology_1_objects')).toContain('account');
  });

  it('service/publish#what-the-app-publishes: an applied publish sends the schema migrations file and the Functions, and applies', async () => {
    const functions = twinFunctions('0.7.0');

    const response = await send(await newInstance(), 'publish', body(false, { ir: twinIr('0.7.0'), functions }));

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({ version: 1 });

    expect(await storedVersions()).toEqual([
      expect.objectContaining({ version: 1, schema_migrations: { migrations: [] }, functions }),
    ]);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    expect(await tablesOf(database.db, 'ontology_1_objects')).toContain('account');
  });

  it('service/publish#what-the-app-publishes: a request with no schema migrations file fails with 400', async () => {
    const request = body(false);

    delete request.schemaMigrations;

    const response = await send(await newInstance(), 'publish', request);

    expect(response.status).toBe(400);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);
  });

  it('service/publish#what-the-app-publishes: publish runs the IR check of Ontology-as-code, and an IR that fails it applies nothing', async () => {
    const response = await send(await newInstance(), 'publish', body(false, { ir: INTERFACE_IR }));

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({ parameters: { feature: NO_INTERFACES } });

    expect(await storedVersions()).toEqual([]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);
  });
});

describe('errors', () => {
  it('service/publish#route: a failed check gets the OSDK error shape, and the error names the feature', async () => {
    const response = await send(await newInstance(), 'publish', body(true, { ir: INTERFACE_IR }));

    expect(response.status).toBe(400);

    const error: unknown = await response.json();

    expect(error).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { feature: NO_INTERFACES },
    });

    expect(Object.keys(error as object)).not.toContain('message');
  });
});

describe('connections', () => {
  it('service/storage#connection: publish changes the schema through the direct connection, and never through the pooled one', async () => {
    const handle = await newInstance();

    await send(handle, 'publish', body(false));

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    const response = await send(handle, 'publish', body(false, { ir: withRegion() }));

    expect(response.status).toBe(200);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    expect((await columnsOf(database.db, 'account')).map((column) => column.column_name)).toContain('region');

    const schemaChanges = pooledStatements.filter((text) =>
      /^\s*(CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT)\b/i.test(text),
    );

    expect(schemaChanges).toEqual([]);
  });
});

describe('the reconcile', () => {
  async function sendOn(handle: Handle, stub: StubWorkos, failReconcile: boolean): Promise<Response> {
    const directDb: Db = {
      ...database.db,
      transaction: async (run) => {
        try {
          return await database.db.transaction(run);
        } finally {
          if (failReconcile) stub.fail('5xx', { reads: ['roles'] });
        }
      },
    };

    const { workosPublish } = await import('../auth/index.ts');

    const input: HandleInput = {
      db: fallibleOf(pooledDb),
      directDb: fallibleOf(directDb),
      settings: testSettings,
      keys: issuer.keys,
      users: noUsers,
      workos: workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }),
    };

    const request = new Request(base + publishPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('publish')}` },
      body: JSON.stringify(body(false, { ir: withRegion() })),
    });

    try {
      return await buffered(handle(request, input));
    } finally {
      stub.fail(undefined);
    }
  }

  it('service/publish#reconcile: a WorkOS failure in the reconcile after a commit gives 503 with version and reconciled false, and a rerun gets 200 with no new version', async () => {
    const handle = await newInstance();

    const stub = stubWorkos([], [], { roles: {} });

    expect((await send(handle, 'publish', body(false))).status).toBe(200);

    const failed = await sendOn(handle, stub, true);

    const error = (await failed.json()) as { errorName: string; parameters: Record<string, unknown> };

    expect([
      failed.status,
      failed.headers.get('retry-after'),
      error.errorName,
      { ...error.parameters, transactionMs: typeof error.parameters['transactionMs'] },
    ]).toEqual([
      503,
      '10',
      'OntologyService:WorkosUnavailable',
      { version: 2, reconciled: false, transactionMs: 'number' },
    ]);

    expect(logLine()).toMatchObject({ publish: { outcome: 'failed', versionBefore: 1, versionAfter: 2 } });

    const rerun = await sendOn(handle, stub, false);

    expect([
      rerun.status,
      ((await rerun.json()) as PublishResponse).version,
      (await storedVersions()).map((row) => row.version),
    ]).toEqual([200, 2, [1, 2]]);
  });
});

describe('the request log', () => {
  it('an applied publish logs its outcome, lock wait, planned changes, and the versions before and after', async () => {
    await send(await newInstance(), 'publish', body(false));

    expect(logLine()).toMatchObject({
      publish: {
        outcome: 'applied',
        lockWaitMs: expect.any(Number),
        changes: [`Create Object Type ${ACCOUNT}`],
        versionBefore: 0,
        versionAfter: 1,
      },
    });
  });

  it('a publish that fails in Postgres logs the outcome failed, and the Postgres error code and message', async () => {
    const handle = await newInstance();

    const experimentalRegion = withRegion();
    const region = experimentalRegion.ontology.objectTypes[ACCOUNT]?.objectType.propertyTypes['region'];

    if (region) region.status = { type: 'experimental', experimental: {} };

    await send(handle, 'publish', body(false, { ir: experimentalRegion }));

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    await database.db.query(sql('ALTER TABLE ontology_1_objects.account DROP COLUMN region'));

    const response = await send(handle, 'publish', body(false));

    expect(response.status).toBe(500);

    expect(logLine()).toMatchObject({
      publish: {
        outcome: 'failed',
        lockWaitMs: 0,
        changes: [],
        versionBefore: 1,
        versionAfter: 1,
        postgresError: { code: '42703', message: 'column "region" does not exist' },
      },
    });
  });

  it('a publish whose IR fails the check logs the outcome failed, and no new version', async () => {
    const response = await send(await newInstance(), 'publish', body(false, { ir: INTERFACE_IR }));

    expect(response.status).toBe(400);

    expect(logLine().publish).toEqual({
      outcome: 'failed',
      lockWaitMs: 0,
      changes: [],
      versionBefore: 0,
      versionAfter: 0,
    });
  });

  it('a validateOnly publish logs the outcome validated, and no new version', async () => {
    await send(await newInstance(), 'publish', body(true));

    expect(logLine()).toMatchObject({
      publish: {
        outcome: 'validated',
        lockWaitMs: expect.any(Number),
        changes: [`Create Object Type ${ACCOUNT}`],
        versionBefore: 0,
        versionAfter: 0,
      },
    });
  });
});

describe('the trace', () => {
  const STEPS = new Set(['publish read', 'publish plan', 'publish store', 'publish reconcile', 'lock wait']);

  async function steps(): Promise<{ name: string; children: string[] }[]> {
    const spans = await routeSpans();

    const root = spans.find((s) => s.name === `POST ${publishPath}`);
    const trace = spans.filter((s) => s.traceId === root?.traceId);

    const stepsOf = (parent: FinishedSpan | undefined): FinishedSpan[] =>
      trace
        .filter((s) => s.parentSpanId === parent?.spanId && STEPS.has(s.name))
        .sort((a, b) => (a.start < b.start ? -1 : 1));

    return stepsOf(root).map((step) => ({ name: step.name, children: stepsOf(step).map((child) => child.name) }));
  }

  it('an applied publish with a schema migration gives the read, plan, store, and reconcile spans under the root, and the lock wait under the store', async () => {
    const schemaMigrations = { migrations: [{ type: 'dropAllPatches', objectType: `${NS}Gone` }] };

    const response = await send(await newInstance(), 'publish', body(false, { schemaMigrations }));

    expect(response.status).toBe(200);

    expect(await steps()).toEqual([
      { name: 'publish read', children: [] },
      { name: 'publish plan', children: [] },
      { name: 'publish store', children: ['lock wait'] },
      { name: 'publish reconcile', children: [] },
    ]);
  });

  it('a validateOnly publish gives the read and plan spans, and no store, no lock wait, and no reconcile', async () => {
    const response = await send(await newInstance(), 'check', body(true));

    expect(response.status).toBe(200);

    expect(await steps()).toEqual([
      { name: 'publish read', children: [] },
      { name: 'publish plan', children: [] },
    ]);
  });
});
