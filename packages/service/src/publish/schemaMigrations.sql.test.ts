import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import type {
  CompiledActionType,
  CompiledLinkType,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  PropertyType,
  Status,
} from '../ontology/index.ts';
import type { PublishResponse, SchemaMigration } from './index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { joinedTechnicianWorkOrders, namespacedCompleteWorkOrder, realCompile } from './realCompile.test-utils.ts';
import {
  actionTypeDisplay,
  APPLY,
  columnsOf,
  columnTypes,
  completeWorkOrderFunction,
  droppedColumns,
  EDIT_HISTORY_COLUMNS,
  expectAllOnNewest,
  foreignKey,
  modeOf,
  newDatabase,
  objectType,
  onNewConnection,
  ontology,
  property,
  publishAndInstall,
  PUBLISHER,
  publishOntology,
  refusal,
  request,
  sql,
  tablesOf,
  technician,
  type TestDatabase,
  withPrimaryKey,
} from './publish.test-utils.ts';
import { TEST_ONTOLOGY_RID, TEST_PRODUCT } from '../service.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;
let others: TestDatabase[];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  others = [];
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  for (const other of others) await other.end();

  await database.end();
});

function publish(
  literal: CompiledOntology,
  options: {
    readonly validateOnly?: boolean;
    readonly migrations?: readonly SchemaMigration[];
    readonly db?: Db;
    readonly noFunctions?: boolean;
  } = {},
): Promise<PublishResponse> {
  const { ontology: compiled, ir, functions } = realCompile(literal);

  return publishAndInstall(options.db ?? database.db, {
    ...TEST_PRODUCT,
    ontology: compiled,
    request: {
      ...request(options.validateOnly ?? false),
      ir,
      ...(functions && !options.noFunctions ? { functions } : {}),
      product: 'twin',
      schemaMigrations: { migrations: options.migrations ?? [] },
    },
    publisher: PUBLISHER,
    mode: modeOf(options.validateOnly ?? false),
  });
}

async function expectRefused(
  compiled: CompiledOntology,
  parameters: Record<string, unknown>,
  migrations: readonly SchemaMigration[] = [],
): Promise<void> {
  for (const validateOnly of [true, false]) {
    const error = await refusal(publish(compiled, { validateOnly, migrations }));

    expect({ status: error.status, errorName: error.errorName, parameters: error.parameters }).toEqual({
      status: 400,
      errorName: 'Default:InvalidArgument',
      parameters,
    });
  }
}

const ONTOLOGY = TEST_ONTOLOGY_RID;

function expectRefusedIn(
  compiled: CompiledOntology,
  parameters: Record<string, unknown>,
  migrations: readonly SchemaMigration[] = [],
): Promise<void> {
  return expectRefused(compiled, { ...parameters, ontologyRid: ONTOLOGY }, migrations);
}

async function versions(db: Db = database.db): Promise<number[]> {
  const rows = await db.query<{ version: number }>(
    sql('SELECT version FROM ontology_registry.product_versions ORDER BY version'),
  );

  return rows.map((row) => row.version);
}

async function insertRows(
  table: string,
  rows: readonly Record<string, unknown>[],
  db: Db = database.db,
): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    const places = columns.map((_, i) => `$${i + 1}`);

    await db.query(
      sql(
        `INSERT INTO ontology_1_objects.${table} (${columns.join(', ')}) VALUES (${places.join(', ')})`,
        ...Object.values(row),
      ),
    );
  }
}

async function primaryKeyColumns(db: Db, table: string): Promise<string[]> {
  const [row] = await db.query<{ columns: string[] }>(
    sql(
      `SELECT array(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.n) AS columns
       FROM pg_index i WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
      `ontology_1_objects.${table}`,
    ),
  );

  return row?.columns ?? [];
}

async function insertHistory(entries: readonly (readonly [string, string])[]): Promise<void> {
  for (const [type, key] of entries) {
    await database.db.query(
      sql(
        `INSERT INTO ontology_1_engine.edit_history (${EDIT_HISTORY_COLUMNS.join(', ')}) VALUES ($1, $2, $3::jsonb)`,
        type,
        key,
        JSON.stringify({ edit: 'create' }),
      ),
    );
  }
}

async function historyRows(): Promise<{ object_type: string; primary_key: string }[]> {
  return database.db.query(
    sql('SELECT object_type, primary_key FROM ontology_1_engine.edit_history ORDER BY object_type, primary_key'),
  );
}

const DEPRECATED = { message: 'Use remarks.', deadline: '2026-12-31T00:00:00Z', replacedBy: undefined };

function withObjectTypeStatus(compiled: CompiledOntology, apiName: string, status: Status): CompiledOntology {
  const type = compiled.objectTypes.get(apiName);

  if (!type) throw new Error(`No Object Type ${apiName}.`);

  return { ...compiled, objectTypes: new Map(compiled.objectTypes).set(apiName, { ...type, status }) };
}

function withPropertyStatus(
  compiled: CompiledOntology,
  apiName: string,
  propertyName: string,
  status: Status,
): CompiledOntology {
  const type = compiled.objectTypes.get(apiName);
  const target = type?.properties.get(propertyName);

  if (!type || !target) throw new Error(`No Property ${propertyName} of ${apiName}.`);

  const changed: CompiledProperty = {
    ...target,
    status: status === 'deprecated' ? { type: 'deprecated', ...DEPRECATED } : { type: status },
  };

  const properties = new Map(type.properties).set(propertyName, changed);
  const primaryKey = type.primaryKey.apiName === propertyName ? changed : type.primaryKey;

  return { ...compiled, objectTypes: new Map(compiled.objectTypes).set(apiName, { ...type, properties, primaryKey }) };
}

function withLinkTypeStatus(compiled: CompiledOntology, link: CompiledLinkType, status: Status): CompiledOntology {
  if (!compiled.linkTypes.has(link.apiName)) throw new Error(`No Link Type ${link.apiName}.`);

  return { ...compiled, linkTypes: new Map(compiled.linkTypes).set(link.apiName, { ...link, status }) };
}

const NS = 'com.example.crm.';
const WORK_ORDER = `${NS}WorkOrder`;

const workOrderId = property('workOrderId', 'work_order_id', { kind: 'string' }, true);
const title = property('title', 'title', { kind: 'string' }, true);
const notes = property('notes', 'notes', { kind: 'string' });

const workOrderV1 = objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, title, notes]);

function workOrderWithout(extra: readonly CompiledProperty[] = []): CompiledObjectType {
  return objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, title, ...extra]);
}

function workOrderWithNotes(changed: CompiledProperty): CompiledObjectType {
  return objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, title, changed]);
}

async function insertWorkOrder(notesValue: string): Promise<void> {
  await database.db.query(
    sql(
      "INSERT INTO ontology_1_objects.work_order (work_order_id, title, notes) VALUES ('wo-1', 'Fix the pump', $1)",
      notesValue,
    ),
  );
}

async function insertWorkOrders(db: Db = database.db): Promise<void> {
  await insertRows(
    'work_order',
    [
      { work_order_id: 'wo-1', title: 'Fix the pump', notes: 'Check the seal' },
      { work_order_id: 'wo-2', title: 'Fix the valve', notes: null },
    ],
    db,
  );
}

function workOrderWithLocation(
  fields: ReadonlyMap<string, { kind: 'string' } | { kind: 'integer' }>,
): CompiledObjectType {
  return objectType(WORK_ORDER, 'work_order', 'workOrderId', [
    workOrderId,
    title,
    property('location', 'location', { kind: 'struct', fields }),
  ]);
}

const LOCATION_FIELDS = new Map([
  ['city', { kind: 'string' } as const],
  ['floor', { kind: 'integer' } as const],
]);

const renameWorkOrder: CompiledActionType = {
  apiName: `${NS}rename-work-order`,
  rid: 'ri.actions.main.action-type.renameWorkOrder',
  status: 'active',
  display: actionTypeDisplay(`${NS}rename-work-order`),
  parameters: new Map([
    [
      'workOrder',
      {
        id: 'workOrder',
        type: { kind: 'object', objectType: WORK_ORDER },
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

const dropNotes: SchemaMigration = { type: 'dropProperty', objectType: WORK_ORDER, property: 'notes' };

const moveNotes: SchemaMigration = {
  type: 'renameProperty',
  objectType: WORK_ORDER,
  source: 'notes',
  target: 'remarks',
};

const remarks = property('remarks', 'remarks', { kind: 'string' });

const completeWorkOrderWithNoParameter: CompiledActionType = { ...namespacedCompleteWorkOrder, parameters: new Map() };

describe('the check of an apply', () => {
  it('an apply plans with the real Functions, never stand-ins, so an active function-backed Action Type that loses a parameter is refused also when the request has no Functions', async () => {
    await publish(
      ontology({
        objectTypes: [workOrderV1],
        actionTypes: [namespacedCompleteWorkOrder],
        functions: [completeWorkOrderFunction],
      }),
    );

    const withNoParameter = ontology({
      objectTypes: [workOrderV1],
      actionTypes: [completeWorkOrderWithNoParameter],
      functions: [{ ...completeWorkOrderFunction, parameters: new Map() }],
    });

    const error = await refusal(publish(withNoParameter, { noFunctions: true }));

    expect([error.status, error.errorName, error.parameters]).toEqual([
      400,
      'Default:InvalidArgument',
      {
        change: `Delete parameter workOrder of Action Type ${namespacedCompleteWorkOrder.apiName}`,
        status: 'active',
        requiredStatus: 'deprecated',
      },
    ]);

    expect(await versions()).toEqual([1]);
  });
});

describe('changes that need no schema migration', () => {
  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: a publish applies a change that needs no schema migration directly, with an empty schema migrations file', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const response = await publish(
      ontology({ objectTypes: [workOrderWithNotes(notes), technician], actionTypes: [renameWorkOrder] }),
    );

    expect(response.version).toBe(2);
    expect(response.changes.filter((change) => change.migration !== undefined)).toEqual([]);

    expect(await versions()).toEqual([1, 2]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['technician', 'work_order']);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: a new Object Type, Property, Link Type, and Action Type need no schema migration on an Object Type that has Objects', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const priority = property('priority', 'priority', { kind: 'string' });

    const response = await publish(
      ontology({
        objectTypes: [
          objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, title, notes, priority]),
          technician,
        ],
        linkTypes: [joinedTechnicianWorkOrders],
        actionTypes: [renameWorkOrder],
      }),
    );

    expect(response.version).toBe(2);
    expect(response.changes.filter((change) => change.migration !== undefined)).toEqual([]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);

    expect(
      await database.db.query(
        sql('SELECT work_order_id, notes, priority FROM ontology_1_objects.work_order ORDER BY work_order_id'),
      ),
    ).toEqual([
      { work_order_id: 'wo-1', notes: 'Check the seal', priority: null },
      { work_order_id: 'wo-2', notes: null, priority: null },
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: a new display name, description, title key, or status needs no schema migration and changes no table', async () => {
    const v1 = ontology({ objectTypes: [workOrderV1] });

    await publish(v1);

    await insertWorkOrders();

    const display = { ...workOrderV1.display, displayName: 'Work order', description: 'A job at a site.' };

    const v2 = withObjectTypeStatus(
      ontology({ objectTypes: [{ ...workOrderV1, display, titleKey: 'title' }] }),
      WORK_ORDER,
      'deprecated',
    );

    const response = await publish(v2);

    expect(response.version).toBe(2);
    expect(response.changes.filter((change) => change.migration !== undefined)).toEqual([]);

    const [stored] = await database.db.query<{ object_type: unknown }>(
      sql(
        "SELECT metadata->'objectTypes'->$1->'objectType' AS object_type FROM ontology_registry.product_versions WHERE version = 2",
        WORK_ORDER,
      ),
    );

    expect(stored?.object_type).toMatchObject({
      displayName: 'Work order',
      description: 'A job at a site.',
      titleProperty: 'title',
      status: 'DEPRECATED',
    });

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.work_order'))).toEqual([
      { count: 2 },
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: a Property whose Objects all have no value is deleted with no schema migration', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', notes: null }]);

    const response = await publish(ontology({ objectTypes: [workOrderWithout()] }));

    expect(response.version).toBe(2);

    expect(response.changes).toEqual([
      { description: 'Delete Property notes of Object Type com.example.crm.WorkOrder' },
    ]);

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual(['work_order_id', 'title', '__version']);

    expect(await database.db.query(sql('SELECT work_order_id, title FROM ontology_1_objects.work_order'))).toEqual([
      { work_order_id: 'wo-1', title: 'Fix the pump' },
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: the base type of a Property that holds no values changes with no schema migration', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', notes: null }]);

    const response = await publish(
      ontology({ objectTypes: [workOrderWithNotes(property('notes', 'notes', { kind: 'integer' }))] }),
    );

    expect(response.changes).toEqual([
      { description: 'Change the base type of Property notes of Object Type com.example.crm.WorkOrder' },
    ]);

    expect((await columnTypes(database.db, 'work_order')).notes).toBe('integer');
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: an Object Type that has no Objects is deleted with no schema migration', async () => {
    const experimental = (compiled: CompiledOntology) =>
      withObjectTypeStatus(compiled, technician.apiName, 'experimental');

    await publish(experimental(ontology({ objectTypes: [workOrderV1, technician] })));

    await insertWorkOrders();

    const response = await publish(ontology({ objectTypes: [workOrderV1] }));

    expect(response.changes).toEqual([{ description: 'Delete Object Type com.example.crm.Technician' }]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: a Link Type that has no Links is deleted with no schema migration', async () => {
    await publish(ontology({ objectTypes: [workOrderV1, technician], linkTypes: [joinedTechnicianWorkOrders] }));

    await insertWorkOrders();

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    const response = await publish(ontology({ objectTypes: [workOrderV1, technician] }));

    expect(response.changes).toEqual([{ description: 'Delete Link Type technicianWorkOrders' }]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['technician', 'work_order']);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: the primary key of an Object Type that has no Objects changes with no schema migration', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const response = await publish(ontology({ objectTypes: [withPrimaryKey(workOrderV1, 'title')] }));

    expect(response.changes).toEqual([
      { description: 'Change the primary key of Object Type com.example.crm.WorkOrder' },
    ]);

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['title']);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-no-schema-migration: a struct field that holds no values is deleted with no schema migration', async () => {
    await publish(ontology({ objectTypes: [workOrderWithLocation(LOCATION_FIELDS)] }));

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', location: JSON.stringify({ city: 'Austin' }) },
    ]);

    const response = await publish(
      ontology({ objectTypes: [workOrderWithLocation(new Map([['city', { kind: 'string' }]]))] }),
    );

    expect(response.version).toBe(2);
    expect(response.changes.filter((change) => change.migration !== undefined)).toEqual([]);

    expect(await database.db.query(sql('SELECT location FROM ontology_1_objects.work_order'))).toEqual([
      { location: { city: 'Austin' } },
    ]);
  });
});

describe('changes that need a schema migration', () => {
  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: with validateOnly, a change that needs a schema migration is refused without it, and is planned with it', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const v2 = ontology({ objectTypes: [workOrderWithout()] });

    const error = await refusal(publish(v2, { validateOnly: true }));

    expect(error.status).toBe(400);

    const planned = await publish(v2, { validateOnly: true, migrations: [dropNotes] });

    expect(planned.version).toBeUndefined();

    expect(planned.changes).toEqual([
      { description: 'Delete Property notes of Object Type com.example.crm.WorkOrder', migration: dropNotes },
    ]);

    expect(await versions()).toEqual([1]);

    expect(
      await database.db.query(sql("SELECT notes FROM ontology_1_objects.work_order WHERE work_order_id = 'wo-1'")),
    ).toEqual([{ notes: 'Check the seal' }]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: deleting a Property that holds values needs a Drop, and with no new Property of the same type a Move cannot apply', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    await expectRefusedIn(ontology({ objectTypes: [workOrderWithout()] }), {
      change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropProperty'],
    });

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: a value that a write adds after the check and before the transaction still needs a Drop, so the transaction fails the installation by name, and the value stays', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', notes: null }]);

    const db = database.db;

    const racing: Db = {
      query: <Row extends object>(statement: Sql) => db.query<Row>(statement),
      stream: <Row extends object>(statement: Sql) => db.stream<Row>(statement),
      snapshot: (run) => db.snapshot(run),
      transaction: async (run) => {
        await onNewConnection(database.url, "UPDATE ontology_1_objects.work_order SET notes = 'Check the seal'");

        return db.transaction(run);
      },
    };

    const without = realCompile(ontology({ objectTypes: [workOrderWithout()] }));

    const error = await refusal(
      publishOntology(racing, {
        ...TEST_PRODUCT,
        ontology: without.ontology,
        request: { ...request(false), ir: without.ir, product: 'twin' },
        publisher: PUBLISHER,
        mode: APPLY,
      }),
    );

    const change = 'Delete Property notes of Object Type com.example.crm.WorkOrder';
    const { transactionMs, ...parameters } = error.parameters;

    expect([error.status, error.errorName, parameters, typeof transactionMs]).toEqual([
      400,
      'Default:InvalidArgument',
      { change, schemaMigrations: ['dropProperty'], ontologyRid: TEST_PRODUCT.productRid },
      'number',
    ]);

    expect(await versions()).toEqual([1]);

    expect(await database.db.query(sql('SELECT version FROM ontology_registry.ontologies'))).toEqual([{ version: 1 }]);

    expect(await database.db.query(sql('SELECT notes FROM ontology_1_objects.work_order'))).toEqual([
      { notes: 'Check the seal' },
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: renaming a Property that holds values needs a Drop or a Move', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    await expectRefusedIn(ontology({ objectTypes: [workOrderWithout([remarks])] }), {
      change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropProperty', 'renameProperty'],
    });

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: changing the base type of a Property that holds values needs a Drop', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    await expectRefusedIn(
      ontology({ objectTypes: [workOrderWithNotes(property('notes', 'notes', { kind: 'integer' }))] }),
      {
        change: 'Change the base type of Property notes of Object Type com.example.crm.WorkOrder',
        schemaMigrations: ['dropProperty'],
      },
    );

    expect((await columnTypes(database.db, 'work_order')).notes).toBe('text');
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: deleting a struct field that holds values needs a Drop of its Property', async () => {
    await publish(ontology({ objectTypes: [workOrderWithLocation(LOCATION_FIELDS)] }));

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', location: JSON.stringify({ city: 'Austin', floor: 3 }) },
    ]);

    await expectRefusedIn(ontology({ objectTypes: [workOrderWithLocation(new Map([['city', { kind: 'string' }]]))] }), {
      change: 'Delete struct field floor of Property location of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropProperty'],
    });

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: changing the base type of a struct field that holds values needs a Drop of its Property, and with the Drop the values are deleted', async () => {
    await publish(ontology({ objectTypes: [workOrderWithLocation(LOCATION_FIELDS)] }));

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', location: JSON.stringify({ city: 'Austin', floor: 3 }) },
    ]);

    const floorAsText = ontology({
      objectTypes: [
        workOrderWithLocation(
          new Map([
            ['city', { kind: 'string' }],
            ['floor', { kind: 'string' }],
          ]),
        ),
      ],
    });

    await expectRefusedIn(floorAsText, {
      change:
        'Change the base type of struct field floor of Property location of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropProperty'],
    });

    const dropLocation: SchemaMigration = { type: 'dropProperty', objectType: WORK_ORDER, property: 'location' };

    await publish(floorAsText, { migrations: [dropLocation] });

    expect(await database.db.query(sql('SELECT work_order_id, location FROM ontology_1_objects.work_order'))).toEqual([
      { work_order_id: 'wo-1', location: {} },
    ]);
  });

  it('service/storage#base-type-columns: a Drop of a required struct Property for a deleted struct field applies, and the column holds {}', async () => {
    const requiredLocation = (fields: ReadonlyMap<string, { kind: 'string' } | { kind: 'integer' }>) =>
      objectType(WORK_ORDER, 'work_order', 'workOrderId', [
        workOrderId,
        title,
        property('location', 'location', { kind: 'struct', fields }, true),
      ]);

    await publish(ontology({ objectTypes: [requiredLocation(LOCATION_FIELDS)] }));

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', location: JSON.stringify({ city: 'Austin', floor: 3 }) },
    ]);

    const dropLocation: SchemaMigration = { type: 'dropProperty', objectType: WORK_ORDER, property: 'location' };

    const response = await publish(
      ontology({ objectTypes: [requiredLocation(new Map([['city', { kind: 'string' }]]))] }),
      {
        migrations: [dropLocation],
      },
    );

    expect(response.version).toBe(2);

    expect(await database.db.query(sql('SELECT work_order_id, location FROM ontology_1_objects.work_order'))).toEqual([
      { work_order_id: 'wo-1', location: {} },
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: changing the primary key of an Object Type that has Objects needs a Drop of all its Objects', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    await expectRefusedIn(ontology({ objectTypes: [withPrimaryKey(workOrderV1, 'title')] }), {
      change: 'Change the primary key of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropAllPatches'],
    });

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['work_order_id']);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: deleting an Object Type that has Objects needs a Drop of all its Objects', async () => {
    await publish(
      withObjectTypeStatus(ontology({ objectTypes: [workOrderV1, technician] }), technician.apiName, 'experimental'),
    );

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    await expectRefusedIn(ontology({ objectTypes: [workOrderV1] }), {
      change: 'Delete Object Type com.example.crm.Technician',
      schemaMigrations: ['dropAllPatches'],
    });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['technician', 'work_order']);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: deleting a Link Type that has Links needs a Drop of all its Links', async () => {
    await publish(ontology({ objectTypes: [workOrderV1, technician], linkTypes: [joinedTechnicianWorkOrders] }));

    await insertWorkOrders();

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    await insertRows('technician_work_orders', [{ a_technician_id: 'tech-1', b_work_order_id: 'wo-1' }]);

    await expectRefusedIn(ontology({ objectTypes: [workOrderV1, technician] }), {
      change: 'Delete Link Type technicianWorkOrders',
      schemaMigrations: ['dropLinks'],
    });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: a one-to-many Link Type that has Links is deleted with no schema migration, its foreign key Property keeps its values, and a delete of that Property needs its own Drop', async () => {
    const assignedWorkOrder = objectType(WORK_ORDER, 'work_order', 'workOrderId', [
      workOrderId,
      title,
      notes,
      property('assignedTechnicianId', 'assigned_technician_id', { kind: 'string' }),
    ]);

    const assignedTechnician: CompiledLinkType = {
      apiName: 'assignedTechnician',
      rid: 'ri.ontology.main.relation.assignedTechnician',
      status: 'experimental',
      storage: foreignKey(assignedWorkOrder, 'assignedTechnicianId', technician),
    };

    await publish(ontology({ objectTypes: [assignedWorkOrder, technician], linkTypes: [assignedTechnician] }));

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', assigned_technician_id: 'tech-1' },
    ]);

    const response = await publish(ontology({ objectTypes: [assignedWorkOrder, technician] }));

    expect(response.changes).toEqual([{ description: 'Delete Link Type assignedTechnician' }]);

    expect(
      await database.db.query(sql('SELECT work_order_id, assigned_technician_id FROM ontology_1_objects.work_order')),
    ).toEqual([{ work_order_id: 'wo-1', assigned_technician_id: 'tech-1' }]);

    await expectRefusedIn(ontology({ objectTypes: [workOrderV1, technician] }), {
      change: 'Delete Property assignedTechnicianId of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropProperty'],
    });
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: turning off Object Edit History for an Object Type that has history needs a Drop edit history', async () => {
    const history = { storeAllPreviousProperties: false };

    await publish(ontology({ objectTypes: [{ ...workOrderV1, editsHistory: history }] }));

    await insertHistory([[WORK_ORDER, 'wo-1']]);

    await expectRefusedIn(ontology({ objectTypes: [workOrderV1] }), {
      change: 'Turn off Object Edit History of Object Type com.example.crm.WorkOrder',
      schemaMigrations: ['dropEditHistory'],
    });

    expect(await historyRows()).toEqual([{ object_type: WORK_ORDER, primary_key: 'wo-1' }]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: turning off Object Edit History for an Object Type with no history needs no schema migration', async () => {
    const history = { storeAllPreviousProperties: false };

    await publish(ontology({ objectTypes: [{ ...workOrderV1, editsHistory: history }] }));

    const response = await publish(ontology({ objectTypes: [workOrderV1] }));

    expect(response.changes).toEqual([
      { description: 'Turn off Object Edit History of Object Type com.example.crm.WorkOrder' },
    ]);

    expect(await versions()).toEqual([1, 2]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: without the schema migration it needs, a publish fails with 400 that names the change and the schema migration, and a schema migration of another change does not count', async () => {
    await publish(ontology({ objectTypes: [workOrderV1, technician] }));

    await insertWorkOrders();

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    const otherChange: SchemaMigration = { type: 'dropProperty', objectType: technician.apiName, property: 'notes' };

    await expectRefusedIn(
      ontology({ objectTypes: [workOrderWithout(), technician] }),
      {
        change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
        schemaMigrations: ['dropProperty'],
      },
      [otherChange],
    );

    expect(await versions()).toEqual([1]);
  });
});

describe('what the app publishes', () => {
  it('service/publish#what-the-app-publishes: a publish whose changes fail the schema migrations check applies nothing', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const error = await refusal(publish(ontology({ objectTypes: [workOrderWithout(), technician] })));

    expect(error.status).toBe(400);

    expect(await versions()).toEqual([1]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);

    expect(
      await database.db.query(
        sql('SELECT work_order_id, notes FROM ontology_1_objects.work_order ORDER BY work_order_id'),
      ),
    ).toEqual([
      { work_order_id: 'wo-1', notes: 'Check the seal' },
      { work_order_id: 'wo-2', notes: null },
    ]);
  });
});

describe('the schema migrations file', () => {
  it('ontology/object-edits/schema-migrations#the-schema-migrations-file: a publish applies each schema migration that matches a change, and ignores the others', async () => {
    await publish(ontology({ objectTypes: [workOrderV1, technician] }));

    await insertWorkOrders();

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    const file: SchemaMigration[] = [
      { type: 'dropProperty', objectType: technician.apiName, property: 'name' },
      { type: 'renameProperty', objectType: WORK_ORDER, source: 'legacyNotes', target: 'notes' },
      dropNotes,
    ];

    const response = await publish(ontology({ objectTypes: [workOrderWithout(), technician] }), { migrations: file });

    expect(response.changes.filter((change) => change.migration !== undefined)).toEqual([
      { description: 'Delete Property notes of Object Type com.example.crm.WorkOrder', migration: dropNotes },
    ]);

    expect(await database.db.query(sql('SELECT technician_id, name FROM ontology_1_objects.technician'))).toEqual([
      { technician_id: 'tech-1', name: 'Ana' },
    ]);
  });

  it('ontology/object-edits/schema-migrations#the-schema-migrations-file: the same file serves the staging publishes and the later production publish', async () => {
    const production = await newDatabase(postgres.url);

    others.push(production);

    const v1 = ontology({ objectTypes: [workOrderV1] });
    const v2 = ontology({ objectTypes: [workOrderWithout()] });
    const v3 = ontology({ objectTypes: [workOrderWithout([property('priority', 'priority', { kind: 'string' })])] });
    const file = [dropNotes];

    for (const db of [database.db, production.db]) {
      await publish(v1, { db });

      await insertWorkOrders(db);
    }

    await publish(v2, { migrations: file });

    const staging3 = await publish(v3, { migrations: file });

    expect(staging3.changes).toEqual([
      { description: 'Create Property priority of Object Type com.example.crm.WorkOrder' },
    ]);

    const production2 = await publish(v3, { db: production.db, migrations: file });

    expect(production2.changes.filter((change) => change.migration !== undefined)).toEqual([
      { description: 'Delete Property notes of Object Type com.example.crm.WorkOrder', migration: dropNotes },
    ]);

    for (const db of [database.db, production.db]) {
      expect(Object.keys(await columnTypes(db, 'work_order'))).toEqual([
        'work_order_id',
        'title',
        '__version',
        'priority',
      ]);
    }
  });
});

describe('V1 schema migrations', () => {
  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Drop of a Property deletes its values, then the change applies', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const response = await publish(ontology({ objectTypes: [workOrderWithout()] }), { migrations: [dropNotes] });

    expect(response.changes).toEqual([
      { description: 'Delete Property notes of Object Type com.example.crm.WorkOrder', migration: dropNotes },
    ]);

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual(['work_order_id', 'title', '__version']);

    expect(
      await database.db.query(
        sql('SELECT work_order_id, title FROM ontology_1_objects.work_order ORDER BY work_order_id'),
      ),
    ).toEqual([
      { work_order_id: 'wo-1', title: 'Fix the pump' },
      { work_order_id: 'wo-2', title: 'Fix the valve' },
    ]);
  });

  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Drop of all Objects of an Object Type deletes them, then the change applies', async () => {
    await publish(
      withObjectTypeStatus(ontology({ objectTypes: [workOrderV1, technician] }), technician.apiName, 'experimental'),
    );

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    const dropTechnicians: SchemaMigration = { type: 'dropAllPatches', objectType: technician.apiName };

    const response = await publish(ontology({ objectTypes: [workOrderV1] }), { migrations: [dropTechnicians] });

    expect(response.changes).toEqual([
      { description: 'Delete Object Type com.example.crm.Technician', migration: dropTechnicians },
    ]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);
  });

  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Drop of all Links of a Link Type deletes them, then the change applies', async () => {
    await publish(ontology({ objectTypes: [workOrderV1, technician], linkTypes: [joinedTechnicianWorkOrders] }));

    await insertWorkOrders();

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    await insertRows('technician_work_orders', [{ a_technician_id: 'tech-1', b_work_order_id: 'wo-1' }]);

    const dropLinks: SchemaMigration = { type: 'dropLinks', linkType: joinedTechnicianWorkOrders.apiName };

    const response = await publish(ontology({ objectTypes: [workOrderV1, technician] }), { migrations: [dropLinks] });

    expect(response.changes).toEqual([{ description: 'Delete Link Type technicianWorkOrders', migration: dropLinks }]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['technician', 'work_order']);

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.work_order'))).toEqual([
      { count: 2 },
    ]);
  });

  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Move copies the values of a Property to a new Property with the same base type, then deletes the old Property', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const response = await publish(ontology({ objectTypes: [workOrderWithout([remarks])] }), {
      migrations: [moveNotes],
    });

    expect(response.changes).toEqual([
      { description: 'Move Property notes to remarks of Object Type com.example.crm.WorkOrder', migration: moveNotes },
    ]);

    expect(
      await database.db.query(
        sql('SELECT work_order_id, remarks FROM ontology_1_objects.work_order ORDER BY work_order_id'),
      ),
    ).toEqual([
      { work_order_id: 'wo-1', remarks: 'Check the seal' },
      { work_order_id: 'wo-2', remarks: null },
    ]);

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).not.toContain('notes');
  });

  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Move to a Property with another base type is refused, so the delete still needs a Drop', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const remarksAsNumber = property('remarks', 'remarks', { kind: 'integer' });

    await expectRefusedIn(
      ontology({ objectTypes: [workOrderWithout([remarksAsNumber])] }),
      {
        change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
        schemaMigrations: ['dropProperty'],
      },
      [moveNotes],
    );

    expect(await versions()).toEqual([1]);
  });

  const moveCases: readonly { part: string; source: PropertyType; target: PropertyType; value: unknown }[] = [
    {
      part: 'the Decimal precision',
      source: { kind: 'decimal', precision: 10, scale: 2 },
      target: { kind: 'decimal', precision: 12, scale: 2 },
      value: '12.50',
    },
    {
      part: 'the Decimal scale',
      source: { kind: 'decimal', precision: 10, scale: 2 },
      target: { kind: 'decimal', precision: 10, scale: 3 },
      value: '12.50',
    },
    {
      part: 'the array element type',
      source: { kind: 'array', element: { kind: 'string' } },
      target: { kind: 'array', element: { kind: 'integer' } },
      value: ['3'],
    },
    {
      part: 'the Struct fields',
      source: { kind: 'struct', fields: new Map([['city', { kind: 'string' }]]) },
      target: {
        kind: 'struct',
        fields: new Map([
          ['city', { kind: 'string' }],
          ['floor', { kind: 'integer' }],
        ]),
      },
      value: JSON.stringify({ city: 'Austin' }),
    },
  ];

  for (const { part, source, target, value } of moveCases) {
    it(`ontology/object-edits/schema-migrations#schema-migrations-1: a Move to a Property that differs only in ${part} is refused, so the delete still needs a Drop`, async () => {
      await publish(ontology({ objectTypes: [workOrderWithNotes(property('estimate', 'estimate', source))] }));

      await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', estimate: value }]);

      const moveEstimate: SchemaMigration = {
        type: 'renameProperty',
        objectType: WORK_ORDER,
        source: 'estimate',
        target: 'budget',
      };

      await expectRefusedIn(
        ontology({ objectTypes: [workOrderWithNotes(property('budget', 'budget', target))] }),
        {
          change: 'Delete Property estimate of Object Type com.example.crm.WorkOrder',
          schemaMigrations: ['dropProperty'],
        },
        [moveEstimate],
      );

      expect(await versions()).toEqual([1]);
    });
  }

  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Drop edit history allows a publish to turn off Object Edit History, and deletes the history of that Object Type', async () => {
    const history = { storeAllPreviousProperties: false };

    await publish(
      ontology({
        objectTypes: [
          { ...workOrderV1, editsHistory: history },
          { ...technician, editsHistory: history },
        ],
      }),
    );

    await insertHistory([
      [WORK_ORDER, 'wo-1'],
      [technician.apiName, 'tech-1'],
    ]);

    const dropHistory: SchemaMigration = { type: 'dropEditHistory', objectType: WORK_ORDER };

    const response = await publish(ontology({ objectTypes: [workOrderV1, { ...technician, editsHistory: history }] }), {
      migrations: [dropHistory],
    });

    expect(response.changes).toEqual([
      { description: 'Turn off Object Edit History of Object Type com.example.crm.WorkOrder', migration: dropHistory },
    ]);

    expect(await historyRows()).toEqual([{ object_type: technician.apiName, primary_key: 'tech-1' }]);
  });
});

describe('edge rules', () => {
  it('ontology/object-edits/schema-migrations#edge-rules: a new struct field needs no schema migration, and the stored values stay', async () => {
    await publish(ontology({ objectTypes: [workOrderWithLocation(new Map([['city', { kind: 'string' }]]))] }));

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', location: JSON.stringify({ city: 'Austin' }) },
    ]);

    const response = await publish(ontology({ objectTypes: [workOrderWithLocation(LOCATION_FIELDS)] }));

    expect(response.version).toBe(2);
    expect(response.changes.filter((change) => change.migration !== undefined)).toEqual([]);

    expect(await database.db.query(sql('SELECT location FROM ontology_1_objects.work_order'))).toEqual([
      { location: { city: 'Austin' } },
    ]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a primary key change with a Drop of all Objects deletes the Objects and moves the primary key', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const dropWorkOrders: SchemaMigration = { type: 'dropAllPatches', objectType: WORK_ORDER };

    const response = await publish(ontology({ objectTypes: [withPrimaryKey(workOrderV1, 'title')] }), {
      migrations: [dropWorkOrders],
    });

    expect(response.changes).toEqual([
      { description: 'Change the primary key of Object Type com.example.crm.WorkOrder', migration: dropWorkOrders },
    ]);

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.work_order'))).toEqual([
      { count: 0 },
    ]);

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['title']);
  });

  it('service/storage#indexes: after a primary key change, the primary key index is still pk_<table> with a hash', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const dropWorkOrders: SchemaMigration = { type: 'dropAllPatches', objectType: WORK_ORDER };

    await publish(ontology({ objectTypes: [withPrimaryKey(workOrderV1, 'title')] }), { migrations: [dropWorkOrders] });

    const rows = await database.db.query<{ name: string }>(
      sql(
        `SELECT ic.relname AS name FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_class ic ON ic.oid = i.indexrelid
          WHERE n.nspname = 'ontology_1_objects' AND t.relname = 'work_order' AND i.indisprimary`,
      ),
    );

    expect(rows.map((row) => row.name)).toEqual([expect.stringMatching(/^pk_work_order_[0-9a-f]{8}$/)]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a primary key change to a new Property with a Drop of all Objects deletes the Objects before it adds the new key column', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const dropWorkOrders: SchemaMigration = { type: 'dropAllPatches', objectType: WORK_ORDER };
    const id = property('id', 'id', { kind: 'string' }, true);

    const response = await publish(
      ontology({ objectTypes: [objectType(WORK_ORDER, 'work_order', 'id', [id, workOrderId, title, notes])] }),
      {
        migrations: [dropWorkOrders],
      },
    );

    expect(response.version).toBe(2);

    expect(response.changes).toEqual([
      { description: 'Create Property id of Object Type com.example.crm.WorkOrder' },
      { description: 'Change the primary key of Object Type com.example.crm.WorkOrder', migration: dropWorkOrders },
    ]);

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.work_order'))).toEqual([
      { count: 0 },
    ]);

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['id']);
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a primary key change to an optional Property with no value on an Object, with a Drop of all Objects, applies', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const dropWorkOrders: SchemaMigration = { type: 'dropAllPatches', objectType: WORK_ORDER };
    const notesKey = withPrimaryKey(workOrderWithNotes({ ...notes, required: true }), 'notes');

    const response = await publish(ontology({ objectTypes: [notesKey] }), { migrations: [dropWorkOrders] });

    expect(response.version).toBe(2);

    expect(response.changes).toEqual([
      { description: 'Make Property notes required of Object Type com.example.crm.WorkOrder' },
      { description: 'Change the primary key of Object Type com.example.crm.WorkOrder', migration: dropWorkOrders },
    ]);

    expect(await database.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_objects.work_order'))).toEqual([
      { count: 0 },
    ]);

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['notes']);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Move does not allow a primary key change on an Object Type that has Objects', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    await expectRefusedIn(
      ontology({ objectTypes: [withPrimaryKey(workOrderV1, 'title')] }),
      {
        change: 'Change the primary key of Object Type com.example.crm.WorkOrder',
        schemaMigrations: ['dropAllPatches'],
      },
      [{ type: 'renameProperty', objectType: WORK_ORDER, source: 'workOrderId', target: 'title' }],
    );
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an active Property cannot be deleted, also with a Drop', async () => {
    const v1 = withPropertyStatus(ontology({ objectTypes: [workOrderV1] }), WORK_ORDER, 'notes', 'active');

    await publish(v1);

    await insertWorkOrders();

    await expectRefused(
      ontology({ objectTypes: [workOrderWithout()] }),
      {
        change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
        status: 'active',
        requiredStatus: 'deprecated',
      },
      [dropNotes],
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an active Property cannot be renamed, also with a Move', async () => {
    await publish(withPropertyStatus(ontology({ objectTypes: [workOrderV1] }), WORK_ORDER, 'notes', 'active'));

    await insertWorkOrders();

    await expectRefused(
      ontology({ objectTypes: [workOrderWithout([remarks])] }),
      {
        change: 'Move Property notes to remarks of Object Type com.example.crm.WorkOrder',
        status: 'active',
        requiredStatus: 'deprecated',
      },
      [moveNotes],
    );
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an active Property that holds no values cannot be deleted', async () => {
    await publish(withPropertyStatus(ontology({ objectTypes: [workOrderV1] }), WORK_ORDER, 'notes', 'active'));

    await expectRefused(ontology({ objectTypes: [workOrderWithout()] }), {
      change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
      status: 'active',
      requiredStatus: 'deprecated',
    });

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an active Object Type that has no Objects cannot be deleted', async () => {
    await publish(
      withObjectTypeStatus(ontology({ objectTypes: [workOrderV1, technician] }), technician.apiName, 'active'),
    );

    await expectRefused(ontology({ objectTypes: [workOrderV1] }), {
      change: 'Delete Object Type com.example.crm.Technician',
      status: 'active',
      requiredStatus: 'deprecated',
    });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['technician', 'work_order']);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a deprecated Property can be deleted with a Drop', async () => {
    await publish(withPropertyStatus(ontology({ objectTypes: [workOrderV1] }), WORK_ORDER, 'notes', 'active'));

    await insertWorkOrders();

    await publish(withPropertyStatus(ontology({ objectTypes: [workOrderV1] }), WORK_ORDER, 'notes', 'deprecated'));

    const response = await publish(ontology({ objectTypes: [workOrderWithout()] }), { migrations: [dropNotes] });

    expect(response.version).toBe(3);

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual(['work_order_id', 'title', '__version']);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an active Object Type cannot be deleted, also with a Drop of all its Objects', async () => {
    await publish(
      withObjectTypeStatus(ontology({ objectTypes: [workOrderV1, technician] }), technician.apiName, 'active'),
    );

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    await expectRefused(
      ontology({ objectTypes: [workOrderV1] }),
      {
        change: 'Delete Object Type com.example.crm.Technician',
        status: 'active',
        requiredStatus: 'deprecated',
      },
      [{ type: 'dropAllPatches', objectType: technician.apiName }],
    );

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['technician', 'work_order']);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: an active Link Type cannot be deleted, also with a Drop of all its Links', async () => {
    await publish(
      withLinkTypeStatus(
        ontology({ objectTypes: [workOrderV1, technician], linkTypes: [joinedTechnicianWorkOrders] }),
        joinedTechnicianWorkOrders,
        'active',
      ),
    );

    await insertWorkOrders();

    await insertRows('technician', [{ technician_id: 'tech-1', name: 'Ana' }]);

    await insertRows('technician_work_orders', [{ a_technician_id: 'tech-1', b_work_order_id: 'wo-1' }]);

    await expectRefused(
      ontology({ objectTypes: [workOrderV1, technician] }),
      {
        change: 'Delete Link Type technicianWorkOrders',
        status: 'active',
        requiredStatus: 'deprecated',
      },
      [{ type: 'dropLinks', linkType: joinedTechnicianWorkOrders.apiName }],
    );

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a new required Property on an Object Type that has Objects fails with 400, not a Postgres error', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const priority = property('priority', 'priority', { kind: 'string' }, true);

    await expectRefusedIn(
      ontology({
        objectTypes: [objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, title, notes, priority])],
      }),
      {
        change: 'Create Property priority of Object Type com.example.crm.WorkOrder',
        objectType: WORK_ORDER,
        property: 'priority',
        badObjects: 2,
        primaryKeys: ['wo-1', 'wo-2'],
      },
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a publish that makes a Property required names the count of 12 bad Objects and the first 10 primary keys in order', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const ids = Array.from({ length: 12 }, (_, index) => `wo-${String(index + 1).padStart(2, '0')}`);

    await insertRows(
      'work_order',
      [...ids].reverse().map((id) => ({ work_order_id: id, title: 'Fix', notes: null })),
    );

    await expectRefusedIn(
      ontology({ objectTypes: [workOrderWithNotes(property('notes', 'notes', { kind: 'string' }, true))] }),
      {
        change: 'Make Property notes required of Object Type com.example.crm.WorkOrder',
        objectType: WORK_ORDER,
        property: 'notes',
        badObjects: 12,
        primaryKeys: ids.slice(0, 10),
      },
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a new required Property on an Object Type with no Objects applies', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const priority = property('priority', 'priority', { kind: 'string' }, true);

    await publish(
      ontology({
        objectTypes: [objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, title, notes, priority])],
      }),
    );

    const column = (await columnsOf(database.db, 'work_order')).find((c) => c.column_name === 'priority');

    expect(column).toMatchObject({ is_nullable: 'NO', data_type: 'text' });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: making a Property required fails while an Object has no value for it, and applies after each Object has one', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const requiredNotes = ontology({
      objectTypes: [workOrderWithNotes(property('notes', 'notes', { kind: 'string' }, true))],
    });

    await expectRefusedIn(requiredNotes, {
      change: 'Make Property notes required of Object Type com.example.crm.WorkOrder',
      objectType: WORK_ORDER,
      property: 'notes',
      badObjects: 1,
      primaryKeys: ['wo-2'],
    });

    await database.db.query(
      sql("UPDATE ontology_1_objects.work_order SET notes = 'Check the stem' WHERE work_order_id = 'wo-2'"),
    );

    const response = await publish(requiredNotes);

    expect(response.changes).toEqual([
      { description: 'Make Property notes required of Object Type com.example.crm.WorkOrder' },
    ]);

    const column = (await columnsOf(database.db, 'work_order')).find((c) => c.column_name === 'notes');

    expect(column).toMatchObject({ is_nullable: 'NO' });
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a later publish cannot use the API name of a Property that an earlier publish deleted', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await publish(ontology({ objectTypes: [workOrderWithout()] }));

    await expectRefused(ontology({ objectTypes: [workOrderV1] }), {
      change: 'Create Property notes of Object Type com.example.crm.WorkOrder',
      reservedApiName: 'notes',
      deletedInVersion: 2,
    });

    expect(await versions()).toEqual([1, 2]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Move deletes the old API name, so a later publish cannot use it', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    await publish(ontology({ objectTypes: [workOrderWithout([remarks])] }), { migrations: [moveNotes] });

    await expectRefused(ontology({ objectTypes: [workOrderWithout([remarks, notes])] }), {
      change: 'Create Property notes of Object Type com.example.crm.WorkOrder',
      reservedApiName: 'notes',
      deletedInVersion: 2,
    });
  });
});

describe('table changes of a later publish', () => {
  it('service/storage#table-changes: a Drop of a Property that holds values drops its column', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrder('Check the seal');

    await publish(ontology({ objectTypes: [workOrderWithout()] }), {
      migrations: [{ type: 'dropProperty', objectType: workOrderV1.apiName, property: 'notes' }],
    });

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual(['work_order_id', 'title', '__version']);

    expect(await droppedColumns(database.db, 'work_order')).toBe(1);

    expect(await database.db.query(sql('SELECT work_order_id, title FROM ontology_1_objects.work_order'))).toEqual([
      { work_order_id: 'wo-1', title: 'Fix the pump' },
    ]);
  });

  it('service/storage#table-changes: a base type change drops the old column and adds a new one with the same name', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrder('3');

    await publish(ontology({ objectTypes: [workOrderWithout([property('notes', 'notes', { kind: 'integer' })])] }), {
      migrations: [{ type: 'dropProperty', objectType: workOrderV1.apiName, property: 'notes' }],
    });

    expect((await columnTypes(database.db, 'work_order')).notes).toBe('integer');

    expect(await droppedColumns(database.db, 'work_order')).toBe(1);

    expect(await database.db.query(sql('SELECT work_order_id, notes FROM ontology_1_objects.work_order'))).toEqual([
      { work_order_id: 'wo-1', notes: null },
    ]);
  });

  it('service/storage#table-changes: a Move renames the column, keeps the values, and leaves no dropped column', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrder('Check the seal');

    await publish(ontology({ objectTypes: [workOrderWithout([property('remarks', 'remarks', { kind: 'string' })])] }), {
      migrations: [{ type: 'renameProperty', objectType: workOrderV1.apiName, source: 'notes', target: 'remarks' }],
    });

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual([
      'work_order_id',
      'title',
      'remarks',
      '__version',
    ]);

    expect(await droppedColumns(database.db, 'work_order')).toBe(0);

    expect(await database.db.query(sql('SELECT work_order_id, remarks FROM ontology_1_objects.work_order'))).toEqual([
      { work_order_id: 'wo-1', remarks: 'Check the seal' },
    ]);
  });
});

describe('turning Object Edit History off', () => {
  it('ontology/object-edits/edit-history#turning-it-on: a publish that turns history off deletes all history of that Object Type and keeps the history of the others', async () => {
    const history = { storeAllPreviousProperties: false };

    await publish(
      ontology({
        objectTypes: [
          { ...workOrderV1, editsHistory: history },
          { ...technician, editsHistory: history },
        ],
      }),
    );

    for (const [type, key] of [
      [workOrderV1.apiName, 'wo-1'],
      [workOrderV1.apiName, 'wo-2'],
      [technician.apiName, 'tech-1'],
    ]) {
      await database.db.query(
        sql(
          `INSERT INTO ontology_1_engine.edit_history (${EDIT_HISTORY_COLUMNS.join(', ')}) VALUES ($1, $2, $3::jsonb)`,
          type,
          key,
          JSON.stringify({ edit: 'create' }),
        ),
      );
    }

    await publish(ontology({ objectTypes: [workOrderV1, { ...technician, editsHistory: history }] }), {
      migrations: [{ type: 'dropEditHistory', objectType: workOrderV1.apiName }],
    });

    const rows = await database.db.query(
      sql('SELECT object_type, primary_key FROM ontology_1_engine.edit_history ORDER BY primary_key'),
    );

    expect(rows).toEqual([{ object_type: technician.apiName, primary_key: 'tech-1' }]);
  });
});

describe('the paths of a Move and of a primary key change', () => {
  const nullable = async (column: string) =>
    (await columnsOf(database.db, 'work_order')).find((c) => c.column_name === column)?.is_nullable;

  async function textIndexColumns(): Promise<string[]> {
    const rows = await database.db.query<{ definition: string }>(
      sql(
        "SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = 'ontology_1_objects' AND tablename = 'work_order' AND indexdef LIKE '%gin_trgm_ops%'",
      ),
    );

    return rows.map((row) => /USING gin \((\w+) /.exec(row.definition)?.[1] ?? row.definition);
  }

  it('ontology/object-edits/schema-migrations#edge-rules: 2 Moves to 1 Property are refused, and the error names the second Move and the target', async () => {
    const summary = property('summary', 'summary', { kind: 'string' });

    await publish(ontology({ objectTypes: [workOrderWithout([notes, summary])] }));

    await insertRows('work_order', [
      { work_order_id: 'wo-1', title: 'Fix the pump', notes: 'Check the seal', summary: 'Pump' },
    ]);

    const moveSummary: SchemaMigration = {
      type: 'renameProperty',
      objectType: WORK_ORDER,
      source: 'summary',
      target: 'remarks',
    };

    await expectRefused(
      ontology({ objectTypes: [workOrderWithout([remarks])] }),
      { change: 'Move Property summary to remarks of Object Type com.example.crm.WorkOrder', target: 'remarks' },
      [moveNotes, moveSummary],
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: the error names the Move of the later old Property in the Object Type, whatever the order of the Moves in the file', async () => {
    const summary = property('summary', 'summary', { kind: 'string' });

    await publish(ontology({ objectTypes: [workOrderWithout([notes, summary])] }));

    const moveSummary: SchemaMigration = {
      type: 'renameProperty',
      objectType: WORK_ORDER,
      source: 'summary',
      target: 'remarks',
    };

    await expectRefused(
      ontology({ objectTypes: [workOrderWithout([remarks])] }),
      { change: 'Move Property summary to remarks of Object Type com.example.crm.WorkOrder', target: 'remarks' },
      [moveSummary, moveNotes],
    );
  });

  it('service/storage#indexes: a Move of a Searchable String Property drops the text search index of the old column and creates one on the new column', async () => {
    await publish(ontology({ objectTypes: [workOrderWithout([{ ...notes, searchable: true }])] }));

    await insertWorkOrders();

    expect(await textIndexColumns()).toEqual(['notes']);

    const response = await publish(ontology({ objectTypes: [workOrderWithout([{ ...remarks, searchable: true }])] }), {
      migrations: [moveNotes],
    });

    expect(response.changes).toEqual([
      { description: 'Move Property notes to remarks of Object Type com.example.crm.WorkOrder', migration: moveNotes },
    ]);

    expect(await textIndexColumns()).toEqual(['remarks']);
  });

  it('service/storage#indexes: a Move of a String array Property that the object security policy reads drops the policy index of the old column and creates one on the new column', async () => {
    const readBy = (name: string) => ({
      ...workOrderWithout([property(name, name, { kind: 'array', element: { kind: 'string' } })]),
      policy: {
        kind: 'compare',
        object: { kind: 'property', property: name },
        operator: 'intersects',
        person: { kind: 'permissions' },
      } as const,
    });

    const policyIndexes = async () =>
      database.db.query<{ indexname: string; indexdef: string }>(
        sql(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'ontology_1_objects' AND indexname LIKE 'policy\\_%'",
        ),
      );

    await publish(ontology({ objectTypes: [readBy('notes')] }));

    expect((await policyIndexes()).map((row) => row.indexname)).toEqual(['policy_work_order_notes_8882297b']);

    const response = await publish(ontology({ objectTypes: [readBy('remarks')] }), { migrations: [moveNotes] });

    expect(response.changes).toEqual([
      { description: 'Move Property notes to remarks of Object Type com.example.crm.WorkOrder', migration: moveNotes },
    ]);

    expect(await policyIndexes()).toEqual([
      {
        indexname: 'policy_work_order_remarks_0cf69789',
        indexdef:
          "CREATE INDEX policy_work_order_remarks_0cf69789 ON ontology_1_objects.work_order USING gin (COALESCE(array_remove(remarks, NULL::text), '{}'::text[]))",
      },
    ]);
  });

  it('service/storage#table-changes: a Move between 2 API names with the same column keeps the column and its values', async () => {
    const customerID = property('customerID', 'customer_id', { kind: 'string' });
    const customerId = property('customerId', 'customer_id', { kind: 'string' });

    await publish(ontology({ objectTypes: [workOrderWithout([customerID])] }));

    await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', customer_id: 'c-1' }]);

    const move: SchemaMigration = {
      type: 'renameProperty',
      objectType: WORK_ORDER,
      source: 'customerID',
      target: 'customerId',
    };

    const response = await publish(ontology({ objectTypes: [workOrderWithout([customerId])] }), { migrations: [move] });

    expect(response.changes).toEqual([
      {
        description: 'Move Property customerID to customerId of Object Type com.example.crm.WorkOrder',
        migration: move,
      },
    ]);

    expect(await database.db.query(sql('SELECT customer_id FROM ontology_1_objects.work_order'))).toEqual([
      { customer_id: 'c-1' },
    ]);
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a Move to a required Property fails while an Object has no value, and applies after each Object has one', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const requiredRemarks = ontology({ objectTypes: [workOrderWithout([{ ...remarks, required: true }])] });

    await expectRefusedIn(
      requiredRemarks,
      {
        change: 'Move Property notes to remarks of Object Type com.example.crm.WorkOrder',
        objectType: WORK_ORDER,
        property: 'notes',
        badObjects: 1,
        primaryKeys: ['wo-2'],
      },
      [moveNotes],
    );

    await database.db.query(
      sql("UPDATE ontology_1_objects.work_order SET notes = 'Check the stem' WHERE work_order_id = 'wo-2'"),
    );

    await publish(requiredRemarks, { migrations: [moveNotes] });

    expect(await nullable('remarks')).toBe('NO');
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Move from a required Property to an optional one makes the column optional', async () => {
    await publish(ontology({ objectTypes: [workOrderWithout([{ ...notes, required: true }])] }));

    await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', notes: 'Check the seal' }]);

    await publish(ontology({ objectTypes: [workOrderWithout([remarks])] }), { migrations: [moveNotes] });

    expect(await nullable('remarks')).toBe('YES');

    expect(await database.db.query(sql('SELECT remarks FROM ontology_1_objects.work_order'))).toEqual([
      { remarks: 'Check the seal' },
    ]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Move from a required Property to a required one keeps the column required', async () => {
    await publish(ontology({ objectTypes: [workOrderWithout([{ ...notes, required: true }])] }));

    await insertRows('work_order', [{ work_order_id: 'wo-1', title: 'Fix the pump', notes: 'Check the seal' }]);

    await publish(ontology({ objectTypes: [workOrderWithout([{ ...remarks, required: true }])] }), {
      migrations: [moveNotes],
    });

    expect(await nullable('remarks')).toBe('NO');
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Move of the old primary key is refused, also with a Drop of all Objects, and the publish changes nothing', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const code = property('code', 'code', { kind: 'string' });
    const dropWorkOrders: SchemaMigration = { type: 'dropAllPatches', objectType: WORK_ORDER };

    const moveKey: SchemaMigration = {
      type: 'renameProperty',
      objectType: WORK_ORDER,
      source: 'workOrderId',
      target: 'code',
    };

    await expectRefused(
      ontology({ objectTypes: [objectType(WORK_ORDER, 'work_order', 'title', [code, title, notes])] }),
      {
        change: 'Move Property workOrderId to code of Object Type com.example.crm.WorkOrder',
        primaryKey: 'workOrderId',
      },
      [dropWorkOrders, moveKey],
    );

    expect(await versions()).toEqual([1]);

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['work_order_id']);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a Move of the old primary key is refused without a Drop of all Objects too', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const code = property('code', 'code', { kind: 'string' });

    const moveKey: SchemaMigration = {
      type: 'renameProperty',
      objectType: WORK_ORDER,
      source: 'workOrderId',
      target: 'code',
    };

    await expectRefused(
      ontology({ objectTypes: [objectType(WORK_ORDER, 'work_order', 'title', [code, title, notes])] }),
      {
        change: 'Move Property workOrderId to code of Object Type com.example.crm.WorkOrder',
        primaryKey: 'workOrderId',
      },
      [moveKey],
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#edge-rules: a primary key change that makes the old key optional drops its NOT NULL after the key change', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const response = await publish(
      ontology({
        objectTypes: [
          objectType(WORK_ORDER, 'work_order', 'title', [{ ...workOrderId, required: false }, title, notes]),
        ],
      }),
    );

    expect(response.changes).toEqual([
      { description: 'Change the primary key of Object Type com.example.crm.WorkOrder' },
      { description: 'Make Property workOrderId optional of Object Type com.example.crm.WorkOrder' },
    ]);

    expect(await primaryKeyColumns(database.db, 'work_order')).toEqual(['title']);

    expect(await nullable('work_order_id')).toBe('YES');
  });

  it('ontology/object-edits/schema-migrations#schema-migrations-1: a Move takes the place of the delete of its old Property among the planned changes', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const priority = property('priority', 'priority', { kind: 'string' });

    const response = await publish(ontology({ objectTypes: [workOrderWithout([remarks, priority])] }), {
      migrations: [moveNotes],
    });

    expect(response.changes).toEqual([
      { description: 'Move Property notes to remarks of Object Type com.example.crm.WorkOrder', migration: moveNotes },
      { description: 'Create Property priority of Object Type com.example.crm.WorkOrder' },
    ]);

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual([
      'work_order_id',
      'title',
      'remarks',
      '__version',
      'priority',
    ]);
  });

  it('ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: a schema migration of another Property of the same Object Type does not count', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrders();

    const dropTitle: SchemaMigration = { type: 'dropProperty', objectType: WORK_ORDER, property: 'title' };

    const moveTitle: SchemaMigration = {
      type: 'renameProperty',
      objectType: WORK_ORDER,
      source: 'title',
      target: 'remarks',
    };

    await expectRefusedIn(
      ontology({ objectTypes: [workOrderWithout([remarks])] }),
      {
        change: 'Delete Property notes of Object Type com.example.crm.WorkOrder',
        schemaMigrations: ['dropProperty', 'renameProperty'],
      },
      [moveTitle, dropTitle],
    );

    await expectRefusedIn(
      ontology({ objectTypes: [workOrderWithNotes(property('notes', 'notes', { kind: 'integer' }))] }),
      {
        change: 'Change the base type of Property notes of Object Type com.example.crm.WorkOrder',
        schemaMigrations: ['dropProperty'],
      },
      [dropTitle],
    );

    expect(await versions()).toEqual([1]);
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a new required Property on an Object Type that has 1 Object fails', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrder('Check the seal');

    const priority = property('priority', 'priority', { kind: 'string' }, true);

    await expectRefusedIn(ontology({ objectTypes: [workOrderWithout([notes, priority])] }), {
      change: 'Create Property priority of Object Type com.example.crm.WorkOrder',
      objectType: WORK_ORDER,
      property: 'priority',
      badObjects: 1,
      primaryKeys: ['wo-1'],
    });
  });

  it('ontology/object-edits/schema-migrations#stored-data-checks: a base type change of a required Property, with a Drop, fails while the Object Type has Objects, because the new column has no value', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await insertWorkOrder('Check the seal');

    const dropTitle: SchemaMigration = { type: 'dropProperty', objectType: WORK_ORDER, property: 'title' };
    const titleAsNumber = property('title', 'title', { kind: 'integer' }, true);

    await expectRefusedIn(
      ontology({
        objectTypes: [objectType(WORK_ORDER, 'work_order', 'workOrderId', [workOrderId, titleAsNumber, notes])],
      }),
      {
        change: 'Change the base type of Property title of Object Type com.example.crm.WorkOrder',
        objectType: WORK_ORDER,
        property: 'title',
        badObjects: 1,
        primaryKeys: ['wo-1'],
      },
      [dropTitle],
    );

    expect(await versions()).toEqual([1]);
  });
});
