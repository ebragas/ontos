import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Sql } from '../db/index.ts';
import { type Db, fallibleOf, rejecting } from '../db/promise.test-utils.ts';
import { grantsOf, twinIr, type TwinVersion } from '../ontology/stored.test-utils.ts';
import { handle } from '../handler/index.ts';
import type { CompiledActionType, CompiledOntology } from '../ontology/index.ts';
import type { CheckedFunctions, CheckedRequest, PublishResponse, SchemaMigration } from './index.ts';
import { type PublishInput } from './publishOntology.ts';
import { storedNameKeys } from './pure/storedNames.ts';
import { checkReservedNames, readVersionNameKeys } from './versions.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { noUsers, TEST_PRODUCT, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import {
  joinedOntology,
  namespacedCompleteWorkOrder,
  realCompile,
  type RealCompile,
} from './realCompile.test-utils.ts';
import {
  actionTypeDisplay,
  APPLY,
  completeWorkOrderFunction,
  expectAllOnNewest,
  firstOntology,
  modeOf,
  NAMESPACE,
  newDatabase,
  objectType,
  onNewConnection,
  ontology,
  OSDK_SET,
  property,
  publishAndInstall,
  PUBLISHER,
  publishOntology,
  refusal,
  request,
  roleDefaults,
  sql,
  tablesOf,
  technician,
  type TestDatabase,
  waitForLockWaits,
  workOrder,
} from './publish.test-utils.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;
let others: pg.Client[];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  await onNewConnection(postgres.url, 'ALTER ROLE CURRENT_USER RESET ALL');

  database = await newDatabase(postgres.url);

  others = [];
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  for (const client of others) await client.end().catch(() => undefined);

  await database.end();
});

const renameWorkOrder: CompiledActionType = {
  apiName: `${NAMESPACE}rename-work-order`,
  rid: 'ri.actions.main.action-type.renameWorkOrder',
  status: 'experimental',
  display: actionTypeDisplay(`${NAMESPACE}rename-work-order`),
  parameters: new Map([
    [
      'workOrder',
      {
        id: 'workOrder',
        type: { kind: 'object', objectType: workOrder.apiName },
        required: true,
        allowed: { kind: 'objectQuery' },
      },
    ],
  ]),
  criteria: [{ condition: { kind: 'true' }, failureMessage: '' }],
  logic: {
    kind: 'rules',
    rules: [
      {
        kind: 'modifyObject',
        object: 'workOrder',
        properties: new Map([['title', { kind: 'static', value: 'Renamed' }]]),
      },
    ],
  },
};

const BUNDLE_A = 'export const functions = { completeWorkOrder: () => [] };';
const BUNDLE_B = 'export const functions = { completeWorkOrder: () => [{ type: "deleteObject" }] };';

const V1 = realCompile(firstOntology);
const V2 = realCompile(ontology({ objectTypes: [workOrder], actionTypes: [renameWorkOrder] }));

const WITH_FUNCTION = realCompile(
  ontology({
    objectTypes: [workOrder],
    actionTypes: [namespacedCompleteWorkOrder],
    functions: [completeWorkOrderFunction],
  }),
  { bundle: BUNDLE_A },
);

const LINKED = realCompile(joinedOntology);

function functionsWith(bundle: string): CheckedFunctions {
  if (!WITH_FUNCTION.functions) throw new Error('WITH_FUNCTION has no Functions.');

  return { ...WITH_FUNCTION.functions, bundle };
}

interface Publish {
  readonly ontology: CompiledOntology;
  readonly ir: CheckedRequest['ir'];
  readonly validateOnly?: boolean;
  readonly functions?: CheckedRequest['functions'];
  readonly migrations?: readonly SchemaMigration[];
  readonly osdkSet?: CheckedRequest['osdkSet'];
  readonly options?: Pick<PublishInput, 'transactionTimeout' | 'roleDefaults'>;
}

function publish(p: Publish, db: Db = database.db): Promise<PublishResponse> {
  return publishAndInstall(db, {
    ...TEST_PRODUCT,
    ontology: p.ontology,
    request: {
      ...request(p.validateOnly ?? false),
      ir: p.ir,
      ...(p.migrations ? { schemaMigrations: { migrations: p.migrations } } : {}),
      ...(p.osdkSet ? { osdkSet: p.osdkSet } : {}),
      ...(p.functions ? { functions: p.functions } : {}),
    },
    publisher: PUBLISHER,
    mode: modeOf(p.validateOnly ?? false),
    ...p.options,
  });
}

async function versions(db: Db = database.db): Promise<number[]> {
  const rows = await db.query<{ version: number }>(
    sql('SELECT version FROM ontology_registry.product_versions ORDER BY version'),
  );

  return rows.map((row) => row.version);
}

async function holdLock(lockSql: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: database.url });

  await client.connect();

  others.push(client);

  await client.query('BEGIN');

  await client.query(lockSql);

  return client;
}

const OTHER_PUBLISH = 'LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE';

function withUuidAction(linkId: string, title: string): RealCompile {
  const createWorkOrder: CompiledActionType = {
    apiName: `${NAMESPACE}create-work-order`,
    rid: 'ri.actions.main.action-type.createWorkOrder',
    status: 'experimental',
    display: actionTypeDisplay(`${NAMESPACE}create-work-order`),
    parameters: new Map(),
    criteria: [{ condition: { kind: 'true' }, failureMessage: '' }],
    logic: {
      kind: 'rules',
      rules: [
        {
          kind: 'addObject',
          objectType: workOrder.apiName,
          properties: new Map([
            ['workOrderId', { kind: 'uniqueIdentifier' }],
            ['title', { kind: 'static', value: title }],
          ]),
        },
      ],
    },
  };

  return realCompile(ontology({ objectTypes: [workOrder], actionTypes: [createWorkOrder] }), { linkId });
}

describe('versions', () => {
  it('each environment numbers its Ontology versions 1, 2, 3', async () => {
    const first = await publish({ ...V1 });

    const second = await publish({ ...V2 });

    const third = await publish({ ...V1 });

    expect([first.version, second.version, third.version]).toEqual([1, 2, 3]);

    expect(await versions()).toEqual([1, 2, 3]);
  });

  it('each environment has its own numbers, so a second database starts at 1', async () => {
    await publish({ ...V1 });

    await publish({ ...V2 });

    const other = await newDatabase(postgres.url);

    try {
      const response = await publish({ ...V2 }, other.db);

      expect(response.version).toBe(1);

      expect(await versions(other.db)).toEqual([1]);
    } finally {
      await other.end();
    }
  });

  it('a publish with the same IR, metadata, OSDK set, and Function bundle makes no new version', async () => {
    const ir = WITH_FUNCTION.ir;

    await publish({ ontology: WITH_FUNCTION.ontology, ir, functions: functionsWith(BUNDLE_A) });

    const again = await publish({ ontology: WITH_FUNCTION.ontology, ir, functions: functionsWith(BUNDLE_A) });

    expect(again).toEqual({
      changes: [],
      metadata: WITH_FUNCTION.ontology.metadata,
      version: 1,
      transactionMs: expect.any(Number),
    });

    expect(await versions()).toEqual([1]);
  });

  it('a publish with the same IR and new Ontology metadata makes a new version, as after a converter change', async () => {
    const ir = V1.ir;

    await publish({ ontology: V1.ontology, ir });

    const converted: CompiledOntology = {
      ...V1.ontology,
      metadata: { ...V1.ontology.metadata, ontology: { ...V1.ontology.metadata.ontology, description: 'Work orders' } },
    };

    const response = await publish({ ontology: converted, ir });

    expect(response).toEqual({
      changes: [],
      metadata: converted.metadata,
      version: 2,
      transactionMs: expect.any(Number),
    });

    const [row] = await database.db.query(
      sql(
        "SELECT metadata->'ontology'->>'description' AS description FROM ontology_registry.product_versions WHERE version = 2",
      ),
    );

    expect(row).toEqual({ description: 'Work orders' });
  });

  it('a publish with a new Function bundle makes a new version', async () => {
    const ir = WITH_FUNCTION.ir;

    await publish({ ontology: WITH_FUNCTION.ontology, ir, functions: functionsWith(BUNDLE_A) });

    const response = await publish({ ontology: WITH_FUNCTION.ontology, ir, functions: functionsWith(BUNDLE_B) });

    expect(response.version).toBe(2);

    expect(await versions()).toEqual([1, 2]);
  });

  it('a publish with a new OSDK set makes a new version, so the current version holds the OSDK set of the last publish', async () => {
    const ir = V1.ir;
    const earlierSet = { ...OSDK_SET, '@osdk/client': '2.79.0' };

    await database.db.query(
      sql(
        `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, publisher)
         VALUES ('test', 1, $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, NULL, $5)`,
        JSON.stringify(ir),
        JSON.stringify(V1.ontology.metadata),
        JSON.stringify({ migrations: [] }),
        JSON.stringify(earlierSet),
        PUBLISHER,
      ),
    );

    const response = await publish({ ontology: V1.ontology, ir });

    expect(response).toEqual({
      changes: [],
      metadata: V1.ontology.metadata,
      version: 2,
      transactionMs: expect.any(Number),
    });

    const rows = await database.db.query(
      sql(
        "SELECT version, osdk_set->>'@osdk/client' AS client FROM ontology_registry.product_versions ORDER BY version",
      ),
    );

    expect(rows).toEqual([
      { version: 1, client: '2.79.0' },
      { version: 2, client: OSDK_SET['@osdk/client'] },
    ]);
  });

  it('service/publish#versions: 2 IRs that differ only in the linkId of a generated UUID value make no new version', async () => {
    const first = withUuidAction('0b7e2f3c-6a1d-4c1e-9f0a-2d5b8e4c7a11', 'New work order');
    const second = withUuidAction('5f9c1d2e-3b4a-4e6f-8a7b-9c0d1e2f3a44', 'New work order');

    await publish({ ...first });

    const again = await publish({ ...second });

    expect(again).toEqual({
      changes: [],
      metadata: first.ontology.metadata,
      version: 1,
      transactionMs: expect.any(Number),
    });

    const rows = await database.db.query(
      sql(
        `SELECT ir->'ontology'->'actionTypes'->$1->'actionType'->'actionTypeLogic'->'logic'->'rules'->0
           ->'addObjectRule'->'propertyValues'->'workOrderId'->'uniqueIdentifier'->>'linkId' AS link_id
         FROM ontology_registry.product_versions`,
        `${NAMESPACE}create-work-order`,
      ),
    );

    expect(rows).toEqual([{ link_id: '0b7e2f3c-6a1d-4c1e-9f0a-2d5b8e4c7a11' }]);
  });

  it('service/publish#versions: 2 IRs that differ in another value beside the linkId make a new version', async () => {
    const first = withUuidAction('0b7e2f3c-6a1d-4c1e-9f0a-2d5b8e4c7a11', 'New work order');
    const second = withUuidAction('0b7e2f3c-6a1d-4c1e-9f0a-2d5b8e4c7a11', 'Work order');

    await publish({ ...first });

    const response = await publish({ ...second });

    expect(response.version).toBe(2);

    expect(await versions()).toEqual([1, 2]);
  });

  it('each version keeps its IR, metadata, schema migrations file, Function bundle, OSDK set, publisher, and time', async () => {
    const ir1 = WITH_FUNCTION.ir;

    const migrations: SchemaMigration[] = [
      { type: 'dropProperty', objectType: workOrder.apiName, property: 'startDate' },
    ];

    const before = Date.now();

    await publish({ ontology: WITH_FUNCTION.ontology, ir: ir1, functions: functionsWith(BUNDLE_A), migrations });

    const after = Date.now();

    await publish({ ...WITH_FUNCTION, functions: functionsWith(BUNDLE_B) });

    const [row] = await database.db.query<Record<string, unknown> & { published_at: Date }>(
      sql(
        `SELECT ir, metadata, schema_migrations, functions->>'bundle' AS bundle, osdk_set, publisher, published_at
         FROM ontology_registry.product_versions WHERE version = 1`,
      ),
    );

    expect(row).toEqual({
      ir: JSON.parse(JSON.stringify(ir1)),
      metadata: JSON.parse(JSON.stringify(WITH_FUNCTION.ontology.metadata)),
      schema_migrations: {
        migrations: [{ type: 'dropProperty', objectType: 'com.example.crm.WorkOrder', property: 'startDate' }],
      },
      bundle: BUNDLE_A,
      osdk_set: OSDK_SET,
      publisher: 'repo:example/test-app:environment:publish-staging',
      published_at: expect.any(Date),
    });

    expect(row?.published_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row?.published_at.getTime()).toBeLessThanOrEqual(after + 1_000);

    expect(await versions()).toEqual([1, 2]);
  });
});

describe('Functions', () => {
  it('ontology/functions/functions#discovery: each version stores the Function bundle of its publish, so a Function changes only with a publish', async () => {
    const ir = WITH_FUNCTION.ir;

    await publish({ ontology: WITH_FUNCTION.ontology, ir, functions: functionsWith(BUNDLE_A) });

    await publish({ ontology: WITH_FUNCTION.ontology, ir, functions: functionsWith(BUNDLE_B) });

    const rows = await database.db.query(
      sql(
        `SELECT version, functions->>'bundle' AS bundle,
           functions->'discovered'->0->'locator'->'typescript'->>'functionName' AS function
         FROM ontology_registry.product_versions ORDER BY version`,
      ),
    );

    expect(rows).toEqual([
      { version: 1, bundle: BUNDLE_A, function: 'completeWorkOrder' },
      { version: 2, bundle: BUNDLE_B, function: 'completeWorkOrder' },
    ]);
  });
});

describe('rollback', () => {
  it('service/publish#rollback: to roll back, the app publishes an earlier IR again, and it becomes a new version', async () => {
    const ir1 = V1.ir;

    await publish({ ontology: V1.ontology, ir: ir1 });

    await publish({ ...V2 });

    const rollback = await publish({ ontology: V1.ontology, ir: ir1 });

    expect(rollback).toEqual({
      changes: [{ description: `Delete Action Type ${renameWorkOrder.apiName}` }],
      metadata: V1.ontology.metadata,
      version: 3,
      transactionMs: expect.any(Number),
    });

    const rows = await database.db.query(
      sql(
        `SELECT version, ir = (SELECT ir FROM ontology_registry.product_versions WHERE version = 1) AS ir_of_1,
           metadata = (SELECT metadata FROM ontology_registry.product_versions WHERE version = 1) AS metadata_of_1
         FROM ontology_registry.product_versions ORDER BY version`,
      ),
    );

    expect(rows).toEqual([
      { version: 1, ir_of_1: true, metadata_of_1: true },
      { version: 2, ir_of_1: false, metadata_of_1: false },
      { version: 3, ir_of_1: true, metadata_of_1: true },
    ]);
  });

  it('a rollback fails with 400 when it uses an API name that a later publish deleted, and changes nothing', async () => {
    const withAction = V2.ir;

    await publish({ ontology: V2.ontology, ir: withAction });

    await publish({ ...V1 });

    const error = await refusal(publish({ ontology: V2.ontology, ir: withAction }));

    expect(error.status).toBe(400);
    expect(error.errorName).toBe('Default:InvalidArgument');

    expect(error.parameters).toEqual({
      change: `Create Action Type ${renameWorkOrder.apiName}`,
      reservedApiName: renameWorkOrder.apiName,
      deletedInVersion: 2,
    });

    expect(await versions()).toEqual([1, 2]);
  });

  it('a validateOnly rollback runs the same checks, so it fails the same way', async () => {
    const withAction = V2.ir;

    await publish({ ontology: V2.ontology, ir: withAction });

    await publish({ ...V1 });

    const error = await refusal(publish({ ontology: V2.ontology, ir: withAction, validateOnly: true }));

    expect(error.status).toBe(400);

    expect(error.parameters).toEqual({
      change: `Create Action Type ${renameWorkOrder.apiName}`,
      reservedApiName: renameWorkOrder.apiName,
      deletedInVersion: 2,
    });
  });

  it('service/publish#rollback: values that a Drop deleted stay deleted after a rollback', async () => {
    const withText = objectType(workOrder.apiName, 'work_order', 'workOrderId', [
      property('workOrderId', 'work_order_id', { kind: 'string' }, true),
      property('estimate', 'estimate', { kind: 'string' }),
    ]);

    const withNumber = objectType(workOrder.apiName, 'work_order', 'workOrderId', [
      property('workOrderId', 'work_order_id', { kind: 'string' }, true),
      property('estimate', 'estimate', { kind: 'double' }),
    ]);

    const textOntology = realCompile(ontology({ objectTypes: [withText] }));
    const numberOntology = realCompile(ontology({ objectTypes: [withNumber] }));
    const ir1 = textOntology.ir;

    await publish({ ontology: textOntology.ontology, ir: ir1 });

    await database.db.query(
      sql(
        "INSERT INTO ontology_1_objects.work_order (work_order_id, estimate) VALUES ('wo-1', '3 hours'), ('wo-2', '5 hours')",
      ),
    );

    await publish({
      ontology: numberOntology.ontology,
      ir: numberOntology.ir,
      migrations: [{ type: 'dropProperty', objectType: workOrder.apiName, property: 'estimate' }],
    });

    const rollback = await publish({ ontology: textOntology.ontology, ir: ir1 });

    expect(rollback.version).toBe(3);

    const rows = await database.db.query(
      sql('SELECT work_order_id, estimate FROM ontology_1_objects.work_order ORDER BY work_order_id'),
    );

    expect(rows).toEqual([
      { work_order_id: 'wo-1', estimate: null },
      { work_order_id: 'wo-2', estimate: null },
    ]);
  });

  it('service/publish#rollback: Object Edit History that a Drop edit history deleted stays deleted after a rollback', async () => {
    const history = { storeAllPreviousProperties: false };

    const technicianType = objectType('com.example.crm.Technician', 'technician', 'technicianId', [
      property('technicianId', 'technician_id', { kind: 'string' }, true),
    ]);

    const withHistory = realCompile(
      ontology({
        objectTypes: [
          { ...workOrder, editsHistory: history },
          { ...technicianType, editsHistory: history },
        ],
      }),
    );

    const withoutHistory = realCompile(
      ontology({
        objectTypes: [workOrder, { ...technicianType, editsHistory: history }],
      }),
    );

    const ir1 = withHistory.ir;

    await publish({ ontology: withHistory.ontology, ir: ir1 });

    await database.db.query(
      sql(
        `INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry) VALUES
           ('com.example.crm.WorkOrder', 'wo-1', '{"title": "Pump"}'),
           ('com.example.crm.WorkOrder', 'wo-2', '{"title": "Valve"}'),
           ('com.example.crm.Technician', 'tech-1', '{"technicianId": "tech-1"}')`,
      ),
    );

    await publish({
      ontology: withoutHistory.ontology,
      ir: withoutHistory.ir,
      migrations: [{ type: 'dropEditHistory', objectType: workOrder.apiName }],
    });

    const rollback = await publish({ ontology: withHistory.ontology, ir: ir1 });

    expect(rollback.version).toBe(3);

    const rows = await database.db.query(
      sql('SELECT object_type, primary_key FROM ontology_1_engine.edit_history ORDER BY object_type, primary_key'),
    );

    expect(rows).toEqual([{ object_type: 'com.example.crm.Technician', primary_key: 'tech-1' }]);
  });
});

describe('applying', () => {
  it('service/publish#applying: a store that a newer version refuses commits no version and no role default', async () => {
    await publish({ ...V1 });

    const defaults = await roleDefaults(database.db);

    const db = database.db;

    const racing: Db = {
      ...db,
      transaction: async (run) => {
        await publish({ ...V2 });

        return db.transaction(run);
      },
    };

    const error = await refusal(
      publishOntology(racing, {
        ...TEST_PRODUCT,
        ontology: LINKED.ontology,
        request: { ...request(false), ir: LINKED.ir },
        publisher: PUBLISHER,
        mode: APPLY,
        roleDefaults: { statementTimeout: '61s', idleInTransactionSessionTimeout: '91s' },
      }),
    );

    expect([error.status, error.errorName, error.parameters]).toEqual([
      409,
      'PublishLockTimeout',
      {
        phase: 'version',
        table: 'ontology_registry.product_versions',
        changed: false,
        transactionMs: expect.any(Number),
      },
    ]);

    expect(await versions()).toEqual([1, 2]);

    expect(await roleDefaults(database.db)).toEqual(defaults);
  });

  it('the transaction inserts the new version and runs each table change of the installation', async () => {
    const statements: { text: string; inTransaction: boolean }[] = [];

    await publish({ ...V1 });

    const response = await publishOntology(transactionRecording(database.db, statements), {
      ...TEST_PRODUCT,
      ontology: LINKED.ontology,
      request: { ...request(false), ir: LINKED.ir },
      publisher: PUBLISHER,
      mode: APPLY,
    });

    expect(response.version).toBe(2);

    const inserts = statements.filter((s) => /^\s*INSERT INTO ontology_registry\.product_versions/.test(s.text));

    expect(inserts.map((s) => s.inTransaction)).toEqual([true]);

    const changes = statements.filter((s) => /^\s*(CREATE|DROP|DELETE|ALTER\s+TABLE)\b/i.test(s.text));

    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((s) => s.inTransaction)).toBe(true);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);
  });

  it('the transaction inserts its version and runs each table change with lock_timeout 5s', async () => {
    const seen = await settingsOfPublish();

    expect(seen[0]).toEqual({
      statement: 'INSERT INTO ontology_registry.product_versions',
      lock_timeout: '5s',
      transaction_timeout: '1min',
    });

    expect(new Set(seen.map((s) => s.lock_timeout))).toEqual(new Set(['5s']));
  });

  it('the transaction of this release runs with transaction_timeout 60s', async () => {
    const seen = await settingsOfPublish();

    expect(new Set(seen.map((s) => s.transaction_timeout))).toEqual(new Set(['1min']));
  });

  it('a publish that runs longer than its transaction_timeout gets 400 PublishTimeExceededLimit and changes nothing', async () => {
    const other = await holdLock(OTHER_PUBLISH);

    const start = performance.now();

    const error = await refusal(publish({ ...V1, options: { transactionTimeout: '1s' } }));

    const waited = performance.now() - start;

    await other.query('COMMIT');

    expect(error.status).toBe(400);
    expect(error.errorName).toBe('PublishTimeExceededLimit');

    expect(error.parameters).toEqual({
      phase: 'version',
      table: 'ontology_registry.product_versions',
      changed: false,
      transactionMs: expect.any(Number),
    });

    expect(waited).toBeGreaterThanOrEqual(900);

    expect(await versions()).toEqual([]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);
  });

  it('a write in progress on an Object table makes the transaction wait, and the transaction builds the index after the write ends', async () => {
    const plain = V1;

    await publish({ ...plain });

    const searchableWorkOrder = objectType(workOrder.apiName, 'work_order', 'workOrderId', [
      ...[...workOrder.properties.values()].map((p) => (p.apiName === 'title' ? { ...p, searchable: true } : p)),
    ]);

    const searchable = realCompile(ontology({ objectTypes: [searchableWorkOrder] }));

    const write = await holdLock('LOCK TABLE ontology_1_objects.work_order IN ROW EXCLUSIVE MODE');

    const storing = publishOntology(database.db, {
      ...TEST_PRODUCT,
      ontology: searchable.ontology,
      request: { ...request(false), ir: searchable.ir },
      publisher: PUBLISHER,
      mode: APPLY,
    });

    await waitForLockWaits(database.db, 1);

    expect(await textIndexes()).toEqual([]);

    await write.query('COMMIT');

    expect((await storing).version).toBe(2);

    expect(await textIndexes()).toHaveLength(1);
  });

  it('service/publish#applying: a publish that ran out of time changed nothing, so the same publish runs again on the same pool and applies', async () => {
    const other = await holdLock(OTHER_PUBLISH);

    const ir = V1.ir;

    const error = await refusal(publish({ ontology: V1.ontology, ir, options: { transactionTimeout: '1s' } }));

    expect(error.status).toBe(400);

    await other.query('COMMIT');

    const response = await publish({ ontology: V1.ontology, ir });

    expect(response.version).toBe(1);

    expect(await versions()).toEqual([1]);
  });

  it('service/publish#applying: when a publish commits and its response is lost, a new run of the same publish makes no new version', async () => {
    const ir = V1.ir;

    await publish({ ontology: V1.ontology, ir });

    const again = await publish({ ontology: V1.ontology, ir });

    expect(again).toEqual({
      changes: [],
      metadata: V1.ontology.metadata,
      version: 1,
      transactionMs: expect.any(Number),
    });

    expect(await versions()).toEqual([1]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);
  });
});

describe('a publish that another publish commits ahead of', () => {
  async function untilLockWaiters(count: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const [row] = await database.db.query<{ waiting: number }>(
        sql(
          `SELECT count(*)::int AS waiting FROM pg_locks
           WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
             AND relation = 'ontology_registry.product_versions'::regclass`,
        ),
      );

      if (row?.waiting === count) return;

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`${count} publishes did not wait for the lock of the versions table.`);
  }

  async function race(ahead: Publish, behind: Publish): Promise<PromiseSettledResult<PublishResponse>[]> {
    const other = await holdLock(OTHER_PUBLISH);

    const first = Promise.allSettled([publish(ahead)]);

    await untilLockWaiters(1);

    const second = Promise.allSettled([publish(behind)]);

    await untilLockWaiters(2);

    await other.query('COMMIT');

    return (await Promise.all([first, second])).flat();
  }

  it('service/publish#applying: the publish behind gets 409 PublishLockTimeout with phase version, and its rerun plans from the version ahead of it', async () => {
    await publish({ ...V1 });

    const withTechnician = realCompile(ontology({ objectTypes: [workOrder, technician] }));

    const [ahead, behind] = await race({ ...withTechnician }, { ...LINKED });

    expect(ahead).toMatchObject({ status: 'fulfilled', value: { version: 2 } });

    expect(behind).toMatchObject({
      status: 'rejected',
      reason: {
        status: 409,
        errorName: 'PublishLockTimeout',
        parameters: { phase: 'version', table: 'ontology_registry.product_versions', changed: false },
      },
    });

    expect(await versions()).toEqual([1, 2]);

    const rerun = await publish({ ...LINKED });

    expect(rerun).toEqual({
      changes: [{ description: 'Create Link Type technicianWorkOrders' }],
      metadata: LINKED.ontology.metadata,
      version: 3,
      transactionMs: expect.any(Number),
    });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);
  });

  it('service/publish#applying: the rerun of the publish behind fails with 400 when it uses an API name that the version ahead of it deleted, and changes nothing', async () => {
    await publish({ ...V2 });

    const [ahead, behind] = await race({ ...V1 }, { ...V2 });

    expect(ahead).toMatchObject({ status: 'fulfilled', value: { version: 2 } });
    expect(behind).toMatchObject({ status: 'rejected', reason: { status: 409, errorName: 'PublishLockTimeout' } });

    const rerun = await refusal(publish({ ...V2 }));

    expect([rerun.status, rerun.parameters]).toEqual([
      400,
      {
        change: `Create Action Type ${renameWorkOrder.apiName}`,
        reservedApiName: renameWorkOrder.apiName,
        deletedInVersion: 2,
      },
    ]);

    expect(await versions()).toEqual([1, 2]);
  });
});

describe('applying through the route', () => {
  let issuer: TestIssuer;
  let consoleLog: MockInstance<typeof console.log>;

  beforeAll(async () => {
    issuer = await createTestIssuer(testSettings.auth);
  });

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log');
  });

  afterEach(() => consoleLog.mockRestore());

  async function sendPublish(body: Record<string, unknown>, db: Db, directDb: Db): Promise<Response> {
    const httpRequest = new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.github()}` },
      body: JSON.stringify(body),
    });

    return buffered(
      handle(httpRequest, {
        db: fallibleOf(db),
        directDb: fallibleOf(directDb),
        settings: testSettings,
        keys: issuer.keys,
        users: noUsers,
        workos: stubPublish(),
      }),
    );
  }

  function body(ir: CheckedRequest['ir']): Record<string, unknown> {
    return {
      ir,
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet: OSDK_SET,
      grants: grantsOf(ir),
      validateOnly: false,
    };
  }

  it('service/publish#applying: the publish transaction runs on the direct connection, and the pooled connection runs none of it', async () => {
    const direct: { text: string; inTransaction: boolean }[] = [];
    const pooled: { text: string; inTransaction: boolean }[] = [];

    const response = await sendPublish(
      body(V1.ir),
      transactionRecording(database.db, pooled),
      transactionRecording(database.db, direct),
    );

    expect(response.status).toBe(200);

    const insert = (s: { text: string }) => /^\s*INSERT INTO ontology_registry\.product_versions/.test(s.text);

    expect(direct.filter((s) => insert(s) && s.inTransaction)).toHaveLength(1);

    expect(
      pooled.filter((s) => insert(s) || /^\s*(CREATE|LOCK|ALTER\s+ROLE)\b/i.test(s.text) || /set_config/i.test(s.text)),
    ).toEqual([]);
  });

  it('service/publish#applying: a publish that waits 5 s for the lock of the versions table answers 409 PublishLockTimeout in the OSDK error shape, changes nothing, and applies when it runs again', async () => {
    const other = await holdLock(OTHER_PUBLISH);

    const ir = V1.ir;
    const start = performance.now();

    const response = await sendPublish(body(ir), database.db, database.db);

    const waited = performance.now() - start;

    expect(response.status).toBe(409);

    expect(await response.json()).toEqual({
      errorCode: 'CONFLICT',
      errorName: 'PublishLockTimeout',
      errorInstanceId: expect.any(String),
      parameters: {
        phase: 'version',
        table: 'ontology_registry.product_versions',
        changed: false,
        transactionMs: expect.any(Number),
      },
    });

    expect(waited).toBeGreaterThanOrEqual(4_900);

    expect(await versions()).toEqual([]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);

    expect(await roleDefaults(database.db)).toEqual([]);

    await other.query('COMMIT');

    expect((await publish({ ontology: V1.ontology, ir })).version).toBe(1);

    expect(await versions()).toEqual([1]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);
  });
});

function transactionRecording(
  db: Db,
  statements: { text: string; inTransaction: boolean }[],
  inTransaction = false,
): Db {
  return {
    query: (statement) => {
      statements.push({ text: statement.text, inTransaction });

      return db.query(statement);
    },
    stream: (statement) => {
      statements.push({ text: statement.text, inTransaction });

      return db.stream(statement);
    },
    transaction: (run) => db.transaction((tx) => run(transactionRecording(tx, statements, true))),
    snapshot: (run) => db.snapshot(run),
  };
}

interface Settings {
  readonly statement: string;
  readonly lock_timeout: string;
  readonly transaction_timeout: string;
}

async function settingsOfPublish(): Promise<Settings[]> {
  const seen: Settings[] = [];
  const db = database.db;

  const watching: Db = {
    ...db,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          ...tx,
          query: async <Row extends object>(statement: Sql) => {
            if (/^\s*(CREATE|INSERT)\b/i.test(statement.text)) {
              const [lock] = await tx.query<{ lock_timeout: string }>(sql('SHOW lock_timeout'));

              const [time] = await tx.query<{ transaction_timeout: string }>(sql('SHOW transaction_timeout'));

              seen.push({
                statement: statement.text.trim().split(/\s+/).slice(0, 3).join(' '),
                lock_timeout: lock?.lock_timeout ?? '',
                transaction_timeout: time?.transaction_timeout ?? '',
              });
            }

            return tx.query<Row>(statement);
          },
        }),
      ),
  };

  await publish({ ...V1 });

  await publishOntology(watching, {
    ...TEST_PRODUCT,
    ontology: LINKED.ontology,
    request: { ...request(false), ir: LINKED.ir },
    publisher: PUBLISHER,
    mode: APPLY,
  });

  return seen;
}

async function textIndexes(): Promise<string[]> {
  const rows = await database.db.query<{ indexdef: string }>(
    sql(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'ontology_1_objects' AND tablename = 'work_order' AND indexdef LIKE '%gin_trgm_ops%'`,
    ),
  );

  return rows.map((row) => row.indexdef);
}

describe('narrow reserved-name extraction in checkReservedNames', () => {
  async function insertStoredIr(product: string, version: number, ir: unknown): Promise<void> {
    await database.db.query(
      sql(
        `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, publisher)
         VALUES ($1, $2, $3::jsonb, '{}'::jsonb, '{"migrations":[]}'::jsonb, $4::jsonb, NULL, $5)`,
        product,
        version,
        JSON.stringify(ir),
        JSON.stringify(OSDK_SET),
        PUBLISHER,
      ),
    );
  }

  it('ontology/object-edits/schema-migrations#edge-rules: SQL extraction matches storedNameKeys across all twin versions and malformed IR shapes', async () => {
    const malformed = {
      ontology: {
        objectTypes: {
          a: null,
          b: { objectType: { apiName: 'ns.Account', propertyTypes: [1, 2] } },
          c: { objectType: { apiName: 7 } },
          d: { objectType: { apiName: '' } },
        },
        linkTypes: {
          x: { linkType: { id: 'account-to-engagements', definition: { type: 'intermediary', intermediary: {} } } },
          y: 'text',
        },
        actionTypes: 5,
      },
    };

    const cases: readonly { readonly version: number; readonly ir: unknown }[] = [
      ...(['0.4.0', '0.6.3', '0.7.0'] as readonly TwinVersion[]).map((tag, index) => ({
        version: index + 1,
        ir: twinIr(tag),
      })),
      { version: 4, ir: malformed },
      { version: 5, ir: null },
      { version: 6, ir: { ontology: [] } },
    ];

    for (const item of cases) await insertStoredIr('twin-equiv', item.version, item.ir);

    const extracted = await rejecting(readVersionNameKeys(fallibleOf(database.db), 'twin-equiv'));

    expect(extracted.map((entry) => entry.version)).toEqual(cases.map((item) => item.version));

    for (const [index, item] of cases.entries()) {
      expect([...(extracted[index]?.keys ?? [])].sort()).toEqual([...storedNameKeys(item.ir)].sort());
    }
  });

  it('ontology/object-edits/schema-migrations#edge-rules: enforces reserved names across multiple historical versions without transferring full ir payloads', async () => {
    await publish({ ...LINKED });

    await publish({ ...V2 });

    await publish({ ...V1 });

    const observedRows: Record<string, unknown>[] = [];
    const baseDb = database.db;

    const spyingDb: Db = {
      ...baseDb,
      query: async <Row extends object>(statement: Sql) => {
        const rows = await baseDb.query<Row>(statement);

        observedRows.push(...(rows as Record<string, unknown>[]));

        return rows;
      },
    };

    const error = await refusal(rejecting(checkReservedNames(fallibleOf(spyingDb), TEST_PRODUCT.product, V2.ontology)));

    expect(error.status).toBe(400);
    expect(error.errorName).toBe('Default:InvalidArgument');

    expect(error.parameters).toEqual({
      change: `Create Action Type ${renameWorkOrder.apiName}`,
      reservedApiName: renameWorkOrder.apiName,
      deletedInVersion: 3,
    });

    expect(observedRows).toHaveLength(3);

    for (const row of observedRows) {
      expect(row).not.toHaveProperty('ir');
      expect(Object.keys(row).sort()).toEqual(['names', 'version']);
    }

    const fullIrRows = await database.db.query<{ version: number; ir: unknown }>(
      sql(
        'SELECT version, ir FROM ontology_registry.product_versions WHERE product = $1 ORDER BY version',
        TEST_PRODUCT.product,
      ),
    );

    expect(JSON.stringify(observedRows).length).toBeLessThan(JSON.stringify(fullIrRows).length / 4);
  });
});
