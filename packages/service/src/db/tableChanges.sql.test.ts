import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './promise.test-utils.ts';
import type { CompiledLinkType, CompiledObjectType, CompiledOntology, CompiledProperty } from '../ontology/index.ts';
import type { PublishResponse, SchemaMigration } from '../publish/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { joinedTechnicianWorkOrders, realCompile } from '../publish/realCompile.test-utils.ts';
import {
  columnsOf,
  columnTypes,
  droppedColumns,
  foreignKey,
  newDatabase,
  objectType,
  ontology,
  property,
  publishAndInstall,
  PUBLISHER,
  refusal,
  request,
  sql,
  tablesOf,
  technician,
  type TestDatabase,
  modeOf,
  expectAllOnNewest,
} from '../publish/publish.test-utils.ts';
import { TEST_PRODUCT } from '../service.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

function publish(
  literal: CompiledOntology,
  options: { readonly validateOnly?: boolean; readonly migrations?: readonly SchemaMigration[] } = {},
): Promise<PublishResponse> {
  const { ontology: compiled, ir } = realCompile(literal);

  return publishAndInstall(database.db, {
    ...TEST_PRODUCT,
    ontology: compiled,
    request: {
      ...request(options.validateOnly ?? false),
      ir,
      product: 'twin',
      schemaMigrations: { migrations: options.migrations ?? [] },
    },
    publisher: PUBLISHER,
    mode: modeOf(options.validateOnly ?? false),
  });
}

const searchable = (p: CompiledProperty): CompiledProperty => ({ ...p, searchable: true });

interface Index {
  readonly table: string;
  readonly method: string;
  readonly primary: boolean;
  readonly columns: string[];
  readonly opclasses: string[];
}

async function indexes(db: Db): Promise<Index[]> {
  const rows = await db.query<Index>(
    sql(
      `SELECT t.relname AS table, am.amname AS method, i.indisprimary AS primary,
         array(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.n) AS columns,
         array(SELECT oc.opcname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(oid, n)
               JOIN pg_opclass oc ON oc.oid = k.oid ORDER BY k.n) AS opclasses
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
       WHERE n.nspname = 'ontology_1_objects'`,
    ),
  );

  const key = (index: Index) => `${index.table} ${index.columns.join(',')} ${index.method}`;

  return rows.sort((a, b) => key(a).localeCompare(key(b)));
}

const NS = 'com.example.crm.';

const DECIMAL = { kind: 'decimal', precision: 10, scale: 2 } as const;
const TIMESTAMP = { kind: 'timestamp' } as const;

const reading = objectType(`${NS}Reading`, 'reading', 'readingId', [
  property('readingId', 'reading_id', { kind: 'string' }, true),
  property('label', 'label', { kind: 'string' }),
  property('active', 'active', { kind: 'boolean' }),
  property('count', 'count', { kind: 'integer' }),
  property('ratio', 'ratio', { kind: 'double' }),
  property('amount', 'amount', DECIMAL),
  property('readOn', 'read_on', { kind: 'date' }),
  property('readAt', 'read_at', TIMESTAMP),
  property('labels', 'labels', { kind: 'array', element: { kind: 'string' } }),
  property('flags', 'flags', { kind: 'array', element: { kind: 'boolean' } }),
  property('counts', 'counts', { kind: 'array', element: { kind: 'integer' } }),
  property('ratios', 'ratios', { kind: 'array', element: { kind: 'double' } }),
  property('amounts', 'amounts', { kind: 'array', element: DECIMAL }),
  property('dates', 'dates', { kind: 'array', element: { kind: 'date' } }),
  property('times', 'times', { kind: 'array', element: TIMESTAMP }),
  property('location', 'location', {
    kind: 'struct',
    fields: new Map([
      ['city', { kind: 'string' }],
      ['floor', { kind: 'integer' }],
    ]),
  }),
]);

const readingOntology = ontology({ objectTypes: [reading] });

describe('base type columns', () => {
  it('service/storage#base-type-columns: each base type maps to 1 Postgres type', async () => {
    await publish(readingOntology);

    expect(await columnTypes(database.db, 'reading')).toEqual({
      reading_id: 'text',
      label: 'text',
      active: 'boolean',
      count: 'integer',
      ratio: 'double precision',
      amount: 'numeric(10,2)',
      read_on: 'date',
      read_at: 'timestamp with time zone',
      labels: 'text[]',
      flags: 'boolean[]',
      counts: 'integer[]',
      ratios: 'double precision[]',
      amounts: 'numeric(10,2)[]',
      dates: 'date[]',
      times: 'timestamp with time zone[]',
      location: 'jsonb',
      __version: 'bigint',
    });
  });

  it("service/storage#base-type-columns: a struct column defaults to '{}', and accepts NULL", async () => {
    await publish(readingOntology);

    const [column] = await database.db.query<{ column_default: string | null }>({
      text: `SELECT column_default FROM information_schema.columns WHERE table_schema = 'ontology_1_objects' AND table_name = 'reading' AND column_name = 'location'`,
      values: [],
    });

    expect(column?.column_default).toBe("'{}'::jsonb");

    await database.db.query({
      text: `INSERT INTO ontology_1_objects.reading (reading_id) VALUES ('unset')`,
      values: [],
    });

    await database.db.query({
      text: `INSERT INTO ontology_1_objects.reading (reading_id, location) VALUES ('cleared', NULL)`,
      values: [],
    });

    const rows = await database.db.query<{ reading_id: string; location: unknown }>({
      text: `SELECT reading_id, location FROM ontology_1_objects.reading ORDER BY reading_id`,
      values: [],
    });

    expect(rows).toEqual([
      { reading_id: 'cleared', location: null },
      { reading_id: 'unset', location: {} },
    ]);
  });

  it("service/storage#base-type-columns: a struct Property that a later publish adds holds '{}' on each existing Object", async () => {
    const withoutLocation = ontology({
      objectTypes: [
        { ...reading, properties: new Map([...reading.properties].filter(([apiName]) => apiName !== 'location')) },
      ],
    });

    await publish(withoutLocation);

    await database.db.query({
      text: `INSERT INTO ontology_1_objects.reading (reading_id) VALUES ('before')`,
      values: [],
    });

    await publish(readingOntology);

    const rows = await database.db.query<{ location: unknown }>({
      text: `SELECT location FROM ontology_1_objects.reading`,
      values: [],
    });

    expect(rows).toEqual([{ location: {} }]);
  });
});

const assignedWorkOrder = objectType(`${NS}WorkOrder`, 'work_order', 'workOrderId', [
  property('workOrderId', 'work_order_id', { kind: 'string' }, true),
  searchable(property('title', 'title', { kind: 'string' }, true)),
  property('notes', 'notes', { kind: 'string' }),
  searchable(property('tags', 'tags', { kind: 'array', element: { kind: 'string' } })),
  searchable(property('priority', 'priority', { kind: 'integer' })),
  property('assignedTechnicianId', 'assigned_technician_id', { kind: 'string' }),
]);

const searchableTechnician: CompiledObjectType = {
  ...technician,
  properties: new Map([...technician.properties].map(([name, p]) => [name, name === 'name' ? searchable(p) : p])),
};

const assignedTechnician: CompiledLinkType = {
  apiName: 'assignedTechnician',
  rid: 'ri.ontology.main.relation.assignedTechnician',
  status: 'experimental',
  storage: foreignKey(assignedWorkOrder, 'assignedTechnicianId', technician),
};

const linkedOntology = ontology({
  objectTypes: [assignedWorkOrder, searchableTechnician],
  linkTypes: [assignedTechnician, joinedTechnicianWorkOrders],
});

describe('Link Types', () => {
  it('service/storage#links: a one-to-many Link Type uses the foreign key Property column on the many side, and makes no table', async () => {
    await publish(linkedOntology);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);

    const types = await columnTypes(database.db, 'work_order');

    expect(types.assigned_technician_id).toBe('text');

    expect((await columnTypes(database.db, 'technician')).technician_id).toBe('text');
  });

  it('service/storage#links: a many-to-many Link Type has a join table with 1 column for the primary key of each side, and the pair is its primary key', async () => {
    await publish(linkedOntology);

    const columns = await columnsOf(database.db, 'technician_work_orders');

    expect(columns).toEqual([
      { column_name: 'a_technician_id', is_nullable: 'NO', data_type: 'text', udt_name: 'text' },
      { column_name: 'b_work_order_id', is_nullable: 'NO', data_type: 'text', udt_name: 'text' },
    ]);

    const keys = (await indexes(database.db)).filter(
      (index) => index.table === 'technician_work_orders' && index.primary,
    );

    expect(keys.map((index) => index.columns)).toEqual([['a_technician_id', 'b_work_order_id']]);
  });
});

describe('indexes', () => {
  async function indexNames(table: string): Promise<{ name: string; primary: boolean }[]> {
    return database.db.query<{ name: string; primary: boolean }>(
      sql(
        `SELECT ic.relname AS name, i.indisprimary AS primary
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_class ic ON ic.oid = i.indexrelid
          WHERE n.nspname = 'ontology_1_objects' AND t.relname = $1
          ORDER BY ic.relname`,
        table,
      ),
    );
  }

  it('service/storage#indexes: the primary key index of each Object table and join table is pk_<table> with a hash', async () => {
    await publish(linkedOntology);

    for (const table of ['work_order', 'technician', 'technician_work_orders']) {
      const primary = (await indexNames(table)).filter((index) => index.primary);

      expect(primary).toHaveLength(1);
      expect(primary[0]?.name).toMatch(new RegExp(`^pk_${table}_[0-9a-f]{8}$`));
    }
  });

  it('service/storage#indexes: an Object Type whose table name is the default primary key name of another table applies', async () => {
    const account = objectType(`${NS}Account`, 'account', 'accountId', [
      property('accountId', 'account_id', { kind: 'string' }, true),
    ]);

    const accountPkey = objectType(`${NS}AccountPkey`, 'account_pkey', 'accountPkeyId', [
      property('accountPkeyId', 'account_pkey_id', { kind: 'string' }, true),
    ]);

    await publish(ontology({ objectTypes: [account] }));

    await publish(ontology({ objectTypes: [account, accountPkey] }));

    expect((await columnTypes(database.db, 'account_pkey')).account_pkey_id).toBe('text');
  });

  it('service/storage#indexes: each foreign key Property column and each join table column is the first column of an index', async () => {
    await publish(linkedOntology);

    const all = await indexes(database.db);

    const leading = (table: string, column: string) =>
      all.filter((index) => index.table === table && index.columns[0] === column);

    expect(leading('work_order', 'assigned_technician_id')).toEqual([
      {
        table: 'work_order',
        method: 'btree',
        primary: false,
        columns: ['assigned_technician_id'],
        opclasses: ['text_ops'],
      },
    ]);

    expect(leading('technician_work_orders', 'a_technician_id')).toHaveLength(1);

    expect(leading('technician_work_orders', 'b_work_order_id')).toEqual([
      {
        table: 'technician_work_orders',
        method: 'btree',
        primary: false,
        columns: ['b_work_order_id'],
        opclasses: ['text_ops'],
      },
    ]);
  });

  it('service/storage#indexes: 2 Link Types on 1 foreign key Property share 1 index, which stays while 1 of them uses it', async () => {
    const sharing = (apiName: string): CompiledLinkType => ({
      ...assignedTechnician,
      apiName,
      rid: `ri.ontology.main.relation.${apiName}`,
    });

    const reviewingTechnician = sharing('reviewingTechnician');

    const withLinks = (...linkTypes: CompiledLinkType[]) =>
      ontology({ objectTypes: [assignedWorkOrder, searchableTechnician], linkTypes });

    const foreignKeyIndexes = async () =>
      (await indexes(database.db)).filter(
        (index) => index.table === 'work_order' && index.columns[0] === 'assigned_technician_id',
      );

    const one = [
      {
        table: 'work_order',
        method: 'btree',
        primary: false,
        columns: ['assigned_technician_id'],
        opclasses: ['text_ops'],
      },
    ];

    expect((await publish(withLinks(assignedTechnician, reviewingTechnician))).version).toBe(1);

    expect(await foreignKeyIndexes()).toEqual(one);

    expect((await publish(withLinks(assignedTechnician))).version).toBe(2);

    expect(await foreignKeyIndexes()).toEqual(one);

    expect((await publish(withLinks(assignedTechnician, sharing('inspectingTechnician')))).version).toBe(3);

    expect(await foreignKeyIndexes()).toEqual(one);

    expect((await publish(withLinks())).version).toBe(4);

    expect(await foreignKeyIndexes()).toEqual([]);
  });

  it('service/storage#indexes: each Searchable String Property that is not an array gets a GIN index with gin_trgm_ops', async () => {
    await publish(linkedOntology);

    const gin = (await indexes(database.db)).filter((index) => index.method === 'gin');

    expect(gin).toEqual([
      { table: 'technician', method: 'gin', primary: false, columns: ['name'], opclasses: ['gin_trgm_ops'] },
      { table: 'work_order', method: 'gin', primary: false, columns: ['title'], opclasses: ['gin_trgm_ops'] },
    ]);

    const definitions = await database.db.query<{ indexdef: string }>(
      sql(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'ontology_1_objects' AND indexdef LIKE '% USING gin %' ORDER BY tablename",
      ),
    );

    expect(definitions.map((row) => row.indexdef.replace(/^.* USING /, ''))).toEqual([
      'gin (name ontology_registry.gin_trgm_ops)',
      'gin (title ontology_registry.gin_trgm_ops)',
    ]);
  });

  it('service/storage#indexes: the Ontology service creates no other index', async () => {
    await publish(linkedOntology);

    expect(await indexes(database.db)).toEqual([
      { table: 'technician', method: 'gin', primary: false, columns: ['name'], opclasses: ['gin_trgm_ops'] },
      { table: 'technician', method: 'btree', primary: true, columns: ['technician_id'], opclasses: ['text_ops'] },
      {
        table: 'technician_work_orders',
        method: 'btree',
        primary: true,
        columns: ['a_technician_id', 'b_work_order_id'],
        opclasses: ['text_ops', 'text_ops'],
      },
      {
        table: 'technician_work_orders',
        method: 'btree',
        primary: false,
        columns: ['b_work_order_id'],
        opclasses: ['text_ops'],
      },
      {
        table: 'work_order',
        method: 'btree',
        primary: false,
        columns: ['assigned_technician_id'],
        opclasses: ['text_ops'],
      },
      { table: 'work_order', method: 'gin', primary: false, columns: ['title'], opclasses: ['gin_trgm_ops'] },
      { table: 'work_order', method: 'btree', primary: true, columns: ['work_order_id'], opclasses: ['text_ops'] },
    ]);
  });

  it('ontology/object-link-types/properties#searchable: a String Property that is not Searchable, a Searchable array, and a Searchable Integer get no text search index', async () => {
    await publish(linkedOntology);

    const indexed = (await indexes(database.db))
      .filter((index) => index.table === 'work_order')
      .flatMap((index) => index.columns);

    expect(indexed).toContain('title');
    expect(indexed).not.toContain('notes');
    expect(indexed).not.toContain('tags');
    expect(indexed).not.toContain('priority');
  });

  it('service/storage#indexes, ontology/object-link-types/properties#searchable: a later publish creates the index of a Property that becomes Searchable, and drops it when the Property stops being Searchable', async () => {
    const plain = (titleSearchable: boolean) =>
      ontology({
        objectTypes: [
          objectType(`${NS}WorkOrder`, 'work_order', 'workOrderId', [
            property('workOrderId', 'work_order_id', { kind: 'string' }, true),
            { ...property('title', 'title', { kind: 'string' }, true), searchable: titleSearchable },
          ]),
        ],
      });

    const gin = async () =>
      (await indexes(database.db)).filter((index) => index.method === 'gin').map((index) => index.columns);

    await publish(plain(false));

    expect(await gin()).toEqual([]);

    await publish(plain(true));

    expect(await gin()).toEqual([['title']]);

    await publish(plain(false));

    expect(await gin()).toEqual([]);
  });
});

describe('index names', () => {
  async function textIndexNames(): Promise<{ table: string; column: string; name: string }[]> {
    return database.db.query(
      sql(
        `SELECT t.relname AS table, a.attname AS column, ic.relname AS name
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
         WHERE n.nspname = 'ontology_1_objects' AND am.amname = 'gin' ORDER BY 1, 2`,
      ),
    );
  }

  const checkNames = (names: readonly string[]) => {
    expect(new Set(names).size).toBe(names.length);

    for (const name of names) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/_[0-9a-f]{8}$/);
    }
  };

  it('2 long column names on 1 table that are the same in their first 63 bytes of index name each get their index', async () => {
    const one = 'free_text_comment_that_the_technician_writes_after_visit_one';
    const two = 'free_text_comment_that_the_technician_writes_after_visit_two';

    await publish(
      ontology({
        objectTypes: [
          objectType(`${NS}WorkOrder`, 'work_order', 'workOrderId', [
            property('workOrderId', 'work_order_id', { kind: 'string' }, true),
            searchable(property('freeTextCommentThatTheTechnicianWritesAfterVisitOne', one, { kind: 'string' })),
            searchable(property('freeTextCommentThatTheTechnicianWritesAfterVisitTwo', two, { kind: 'string' })),
          ]),
        ],
      }),
    );

    const indexes = await textIndexNames();

    expect(indexes.map(({ table, column }) => ({ table, column }))).toEqual([
      { table: 'work_order', column: one },
      { table: 'work_order', column: two },
    ]);

    checkNames(indexes.map((index) => index.name));
  });

  it('1 column on 2 long table names that are the same in their first 63 bytes of index name each get their index', async () => {
    const north = 'inspection_record_of_the_preventive_maintenance_programme_a';
    const south = 'inspection_record_of_the_preventive_maintenance_programme_b';

    const inspection = (apiName: string, table: string) =>
      objectType(`${NS}${apiName}`, table, 'inspectionId', [
        property('inspectionId', 'inspection_id', { kind: 'string' }, true),
        searchable(property('comment', 'comment', { kind: 'string' })),
      ]);

    await publish(
      ontology({
        objectTypes: [
          inspection('InspectionRecordOfThePreventiveMaintenanceProgrammeA', north),
          inspection('InspectionRecordOfThePreventiveMaintenanceProgrammeB', south),
        ],
      }),
    );

    const indexes = await textIndexNames();

    expect(indexes.map(({ table, column }) => ({ table, column }))).toEqual([
      { table: north, column: 'comment' },
      { table: south, column: 'comment' },
    ]);

    checkNames(indexes.map((index) => index.name));
  });

  it('2 table and column pairs that join to the same text, such as order and item_name, and order_item and name, each get their index', async () => {
    await publish(
      ontology({
        objectTypes: [
          objectType(`${NS}Order`, 'order', 'orderId', [
            property('orderId', 'order_id', { kind: 'string' }, true),
            searchable(property('itemName', 'item_name', { kind: 'string' })),
          ]),
          objectType(`${NS}OrderItem`, 'order_item', 'orderItemId', [
            property('orderItemId', 'order_item_id', { kind: 'string' }, true),
            searchable(property('name', 'name', { kind: 'string' })),
          ]),
        ],
      }),
    );

    const indexes = await textIndexNames();

    expect(indexes.map(({ table, column }) => ({ table, column }))).toEqual([
      { table: 'order', column: 'item_name' },
      { table: 'order_item', column: 'name' },
    ]);

    checkNames(indexes.map((index) => index.name));
  });
});

function survey(others: number, added = 0): CompiledObjectType {
  const strings = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => property(`${prefix}${i}`, `${prefix}${i}`, { kind: 'string' }));

  return objectType(`${NS}Survey`, 'survey', 'surveyId', [
    property('surveyId', 'survey_id', { kind: 'string' }, true),
    ...strings('p', others),
    ...strings('q', added),
  ]);
}

describe('the 1,600 column limit', () => {
  it('ontology/object-link-types/object-types#parts: the check counts the dropped columns', async () => {
    await publish(ontology({ objectTypes: [survey(1_499)] }));

    const tooWide = ontology({ objectTypes: [survey(1_399, 100)] });

    for (const validateOnly of [true, false]) {
      const error = await refusal(publish(tooWide, { validateOnly }));

      expect(error.status).toBe(400);
      expect(error.errorName).toBe('Default:InvalidArgument');
      expect(JSON.stringify(error.parameters)).toContain('"com.example.crm.Survey"');
    }

    expect(await droppedColumns(database.db, 'survey')).toBe(0);

    await publish(ontology({ objectTypes: [survey(1_399, 99)] }));

    expect(Object.keys(await columnTypes(database.db, 'survey'))).toHaveLength(1_500);

    expect(await droppedColumns(database.db, 'survey')).toBe(100);
  });

  it('ontology/object-link-types/object-types#parts: a table at the limit accepts a Move, because a Move renames a column and adds none', async () => {
    await publish(ontology({ objectTypes: [survey(1_499)] }));

    const atLimit = survey(1_399, 99);

    await publish(ontology({ objectTypes: [atLimit] }));

    const properties = [...atLimit.properties.values()];

    const moved = objectType(`${NS}Survey`, 'survey', 'surveyId', [
      ...properties.filter((p) => p.apiName !== 'q0'),
      property('moved', 'moved', { kind: 'string' }),
    ]);

    const move: SchemaMigration = { type: 'renameProperty', objectType: `${NS}Survey`, source: 'q0', target: 'moved' };

    const response = await publish(ontology({ objectTypes: [moved] }), { migrations: [move] });

    expect(response.version).toBe(3);

    expect(response.changes).toEqual([
      { description: 'Move Property q0 to moved of Object Type com.example.crm.Survey', migration: move },
    ]);

    expect(Object.keys(await columnTypes(database.db, 'survey'))).toHaveLength(1_500);

    expect(await droppedColumns(database.db, 'survey')).toBe(100);
  });
});

const workOrderV1 = objectType(`${NS}WorkOrder`, 'work_order', 'workOrderId', [
  property('workOrderId', 'work_order_id', { kind: 'string' }, true),
  property('title', 'title', { kind: 'string' }, true),
  property('notes', 'notes', { kind: 'string' }),
]);

function workOrderWithout(extra: readonly CompiledProperty[] = []): CompiledObjectType {
  return objectType(`${NS}WorkOrder`, 'work_order', 'workOrderId', [
    property('workOrderId', 'work_order_id', { kind: 'string' }, true),
    property('title', 'title', { kind: 'string' }, true),
    ...extra,
  ]);
}

describe('table changes of a later publish', () => {
  it('service/storage#table-changes: a later publish adds and removes Object Type tables, columns, and join tables', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const priority = property('priority', 'priority', { kind: 'integer' });

    await publish(
      ontology({ objectTypes: [workOrderWithout([priority]), technician], linkTypes: [joinedTechnicianWorkOrders] }),
    );

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([
      'technician',
      'technician_work_orders',
      'work_order',
    ]);

    expect(await columnTypes(database.db, 'work_order')).toEqual({
      work_order_id: 'text',
      title: 'text',
      __version: 'bigint',
      priority: 'integer',
    });

    await publish(ontology({ objectTypes: [workOrderWithout([priority])] }));

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);
  });

  it('service/storage#table-changes: a publish that deletes an Object Type and adds one with the same table name drops the old table before it creates the new one', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    const job = objectType('com.example.jobs.WorkOrder', 'work_order', 'jobId', [
      property('jobId', 'job_id', { kind: 'string' }, true),
    ]);

    const response = await publish(ontology({ objectTypes: [job] }));

    expect(response.changes).toEqual([
      { description: 'Delete Object Type com.example.crm.WorkOrder' },
      { description: 'Create Object Type com.example.jobs.WorkOrder' },
    ]);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);

    expect(await columnTypes(database.db, 'work_order')).toEqual({ job_id: 'text', __version: 'bigint' });
  });

  it('service/storage#table-changes: removing a Property drops its column, and the dropped column stays in the table', async () => {
    await publish(ontology({ objectTypes: [workOrderV1] }));

    await publish(ontology({ objectTypes: [workOrderWithout()] }));

    expect(Object.keys(await columnTypes(database.db, 'work_order'))).toEqual(['work_order_id', 'title', '__version']);

    expect(await droppedColumns(database.db, 'work_order')).toBe(1);
  });
});
