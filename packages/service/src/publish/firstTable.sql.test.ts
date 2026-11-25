import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db } from '../db/promise.test-utils.ts';
import { columnName, joinTableName, snakeCase, tableName, type CompiledOntology } from '../ontology/index.ts';
import type { PublishResponse } from './index.ts';
import type { PublishLog, RoleDefaults } from './publishOntology.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  APPLY,
  columnsOf,
  completeWorkOrder,
  completeWorkOrderFunction,
  expectAllOnNewest,
  firstOntology,
  LONG_COLUMN,
  LONG_PROPERTY,
  linkedOntology,
  modeOf,
  newDatabase,
  objectType,
  ontology,
  onNewConnection,
  property,
  publishAndInstall,
  PUBLISHER,
  request,
  refusal,
  roleDefaults,
  sql,
  tablesOf,
  technician,
  workOrder,
  type TestDatabase,
} from './publish.test-utils.ts';
import { TEST_PRODUCT } from '../service.test-utils.ts';

let postgres: TestPostgres;
let template: string;

beforeAll(async () => {
  postgres = await startPostgres();

  const admin = new pg.Client({ connectionString: postgres.url });

  await admin.connect();

  await admin.query('CREATE ROLE other_app NOLOGIN');

  await admin.end();

  template = await createEngineTemplate(postgres.url, undefined, { icu: true });
});

type Fixture = 'empty' | 'first' | 'linked';

const fixtures = new Map<Fixture, Promise<TestDatabase>>();
const owned: TestDatabase[] = [];

afterAll(async () => {
  await Promise.all([...fixtures.values()].map(async (made) => (await made).end()));

  await postgres?.stop();
});

beforeEach(async () => {
  await onNewConnection(postgres.url, 'ALTER ROLE CURRENT_USER RESET ALL');
});

afterEach(async () => {
  const own = owned.splice(0);

  try {
    for (const database of [...own, ...(await Promise.all(fixtures.values()))]) await expectAllOnNewest(database.db);
  } finally {
    await Promise.all(own.map((database) => database.end()));
  }
});

async function ownDatabase(): Promise<TestDatabase> {
  const database = await newDatabase(postgres.url, { template });

  owned.push(database);

  return database;
}

function shared(fixture: Fixture): Promise<Db> {
  let made = fixtures.get(fixture);

  if (!made) {
    made = (async () => {
      const database = await newDatabase(postgres.url, { template });

      if (fixture !== 'empty') await publish(database.db, fixture === 'first' ? firstOntology : linkedOntology, false);

      return database;
    })();

    fixtures.set(fixture, made);
  }

  return made.then((database) => database.db);
}

function publish(
  db: Db,
  compiled: CompiledOntology,
  validateOnly: boolean,
  defaults?: RoleDefaults,
): Promise<PublishResponse> {
  return publishAndInstall(db, {
    ...TEST_PRODUCT,
    ontology: compiled,
    request: request(validateOnly),
    publisher: PUBLISHER,
    mode: modeOf(validateOnly),
    ...(defaults ? { roleDefaults: defaults } : {}),
  });
}

async function exists(db: Db, name: string): Promise<boolean> {
  const [row] = await db.query<{ found: boolean }>(sql('SELECT to_regclass($1) IS NOT NULL AS found', name));

  return row?.found ?? false;
}

function newSession(url: string): Promise<Record<string, string>[]> {
  return onNewConnection(
    url,
    `SELECT current_setting('statement_timeout') AS statement_timeout,
       current_setting('idle_in_transaction_session_timeout') AS idle,
       current_setting('jit') AS jit`,
  );
}

const WORK_ORDER_COLUMNS = ['work_order_id', 'title', 'start_date', 'tags', LONG_COLUMN];

describe('the planned changes and the response', () => {
  it('an applied publish answers with its planned changes, the Ontology metadata, and version 1', async () => {
    const { db } = await ownDatabase();

    const response = await publish(db, firstOntology, false);

    expect(response).toEqual({
      changes: [{ description: 'Create Object Type com.example.crm.WorkOrder' }],
      metadata: firstOntology.metadata,
      version: 1,
      transactionMs: expect.any(Number),
    });

    expect(Object.keys(response.metadata.objectTypes)).toEqual(['com.example.crm.WorkOrder']);
  });

  it('a publish of 2 Object Types and a join table plans 1 change for each, in Ontology order', async () => {
    const { db } = await ownDatabase();

    const response = await publish(db, linkedOntology, false);

    expect(response.changes).toEqual([
      { description: 'Create Object Type com.example.crm.WorkOrder' },
      { description: 'Create Object Type com.example.crm.Technician' },
      { description: 'Create Link Type technicianWorkOrders' },
    ]);
  });

  it('service/publish#route: a validateOnly publish plans every change and applies nothing', async () => {
    const db = await shared('empty');

    const response = await publish(db, linkedOntology, true);

    expect(response).toEqual({
      changes: [
        { description: 'Create Object Type com.example.crm.WorkOrder' },
        { description: 'Create Object Type com.example.crm.Technician' },
        { description: 'Create Link Type technicianWorkOrders' },
      ],
      metadata: linkedOntology.metadata,
    });

    expect(Object.keys(response.metadata.objectTypes)).toEqual([
      'com.example.crm.WorkOrder',
      'com.example.crm.Technician',
    ]);

    expect(await tablesOf(db, 'ontology_1_objects')).toEqual([]);

    const versions = await db.query(sql('SELECT count(*)::int AS count FROM ontology_registry.product_versions'));

    expect(versions).toEqual([{ count: 0 }]);

    expect(await roleDefaults(db)).toEqual([]);
  });

  it('service/publish#route: a validateOnly publish runs every check, so it fails where the applied publish fails', async () => {
    const clash = ontology({
      objectTypes: [
        objectType('com.example.crm.HTTPServer', 'http_server', 'id', [property('id', 'id', { kind: 'string' }, true)]),
        objectType('com.example.crm.HttpServer', 'http_server', 'id', [property('id', 'id', { kind: 'string' }, true)]),
      ],
    });

    const { db } = await ownDatabase();

    expect((await refusal(publish(db, clash, true))).status).toBe(400);

    expect((await refusal(publish(db, clash, false))).status).toBe(400);
  });
});

describe('Functions', () => {
  const withFunction = ontology({
    objectTypes: [workOrder],
    actionTypes: [completeWorkOrder],
    functions: [completeWorkOrderFunction],
  });

  it('service/publish#route: a validateOnly publish with no Functions skips the Function checks, and its metadata shows the function-backed Action with no parameters', async () => {
    expect(Object.keys(withFunction.metadata.actionTypes.completeWorkOrder?.parameters ?? {})).toEqual(['workOrder']);

    const response = await publish(await shared('empty'), withFunction, true);

    expect(response.changes).toEqual([
      { description: 'Create Object Type com.example.crm.WorkOrder' },
      { description: 'Create Action Type completeWorkOrder' },
    ]);

    expect(response.metadata.actionTypes.completeWorkOrder?.parameters).toEqual({});
  });
});

const SCHEMAS = "('ontology_registry', 'ontology_1_objects', 'ontology_1_engine')";

describe('schemas and access', () => {
  it('the Object Type tables and the join table are in the Object schema', async () => {
    const db = await shared('linked');

    expect(await tablesOf(db, 'ontology_1_objects')).toEqual(['technician', 'technician_work_orders', 'work_order']);

    expect(await tablesOf(db, 'public')).toEqual([]);
  });

  it('the shared tables are in ontology_registry, the engine table in the engine schema, and the product version 1 in the shared schema', async () => {
    const db = await shared('first');

    expect(await tablesOf(db, 'ontology_registry')).toEqual(['engine_changes', 'ontologies', 'product_versions']);

    expect(await tablesOf(db, 'ontology_1_engine')).toEqual(['edit_history']);

    expect(await tablesOf(db, 'ontology_1_objects')).toEqual(['work_order']);

    const versions = await db.query(sql('SELECT version::int AS version FROM ontology_registry.product_versions'));

    expect(versions).toEqual([{ version: 1 }]);
  });

  it('service/storage#schema-and-access: the role of the Ontology service owns each schema, and no other role can use them', async () => {
    const db = await shared('first');

    const rows = await db.query(
      sql(
        `SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
           has_schema_privilege('other_app', n.oid, 'USAGE') AS other_usage,
           has_schema_privilege('other_app', n.oid, 'CREATE') AS other_create
         FROM pg_namespace n WHERE n.nspname IN ${SCHEMAS} ORDER BY n.nspname`,
      ),
    );

    expect(rows).toEqual([
      { schema: 'ontology_1_engine', owner: postgres.role, other_usage: false, other_create: false },
      { schema: 'ontology_1_objects', owner: postgres.role, other_usage: false, other_create: false },
      { schema: 'ontology_registry', owner: postgres.role, other_usage: false, other_create: false },
    ]);

    const tableOwners = await db.query(
      sql(`SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname IN ${SCHEMAS}`),
    );

    expect(tableOwners).toEqual([{ owner: postgres.role }]);
  });

  it('service/storage#schema-and-access: row-level security is on for each table in each schema, with 1 policy that lets the role read and write all rows', async () => {
    const db = await shared('linked');

    const tables = await db.query<{ schema: string; table: string; rls: boolean }>(
      sql(
        `SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND n.nspname IN ${SCHEMAS}`,
      ),
    );

    expect(tables.filter((t) => t.schema === 'ontology_1_objects')).toHaveLength(3);
    expect(tables.filter((t) => t.schema === 'ontology_1_engine')).toHaveLength(1);
    expect(tables.filter((t) => t.schema === 'ontology_registry')).toHaveLength(3);
    expect(tables.filter((t) => !t.rls)).toEqual([]);

    const policies = await db.query<{ schema: string; table: string }>(
      sql(
        `SELECT schemaname AS schema, tablename AS table, cmd, permissive, array_to_string(roles, ',') AS roles,
           qual, coalesce(with_check, qual) AS with_check
         FROM pg_policies WHERE schemaname IN ${SCHEMAS}`,
      ),
    );

    expect(policies).toHaveLength(tables.length);

    for (const table of tables) {
      expect(policies.filter((p) => p.schema === table.schema && p.table === table.table)).toEqual([
        {
          schema: table.schema,
          table: table.table,
          cmd: 'ALL',
          permissive: 'PERMISSIVE',
          roles: postgres.role,
          qual: 'true',
          with_check: 'true',
        },
      ]);
    }
  });

  it('service/storage#ownership: no schema holds a trigger or a function, and its only constraints are primary keys', async () => {
    const db = await shared('linked');

    const schemas = SCHEMAS;

    const notExtension = (catalog: string, oid: string) =>
      `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

    const [row] = await db.query(
      sql(
        `SELECT
           (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname IN ${schemas} AND NOT t.tgisinternal) AS triggers,
           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ${schemas} AND ${notExtension('pg_proc', 'p.oid')}) AS functions,
           (SELECT array_agg(DISTINCT k.contype::text) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
              WHERE n.nspname IN ${schemas}) AS constraint_kinds`,
      ),
    );

    expect(row).toEqual({ triggers: 0, functions: 0, constraint_kinds: ['p'] });
  });

  it('service/authentication#people: no schema has a table of people or users', async () => {
    const db = await shared('linked');

    const tables = [
      ...(await tablesOf(db, 'ontology_1_objects')),
      ...(await tablesOf(db, 'ontology_1_engine')),
      ...(await tablesOf(db, 'ontology_registry')),
    ];

    expect(tables.length).toBeGreaterThan(3);
    expect(tables.filter((name) => /people|person|user|member/.test(name))).toEqual([]);
  });

  it('no schema holds a table of revoked tokens', async () => {
    const db = await shared('linked');

    const rows = await db.query<{ name: string }>(
      sql(
        `SELECT schemaname || '.' || tablename AS name FROM pg_tables
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
      ),
    );

    expect(rows.length).toBeGreaterThan(3);

    expect(rows.map((row) => row.name).filter((name) => /revok|token|session|denylist|blocklist/.test(name))).toEqual(
      [],
    );
  });
});

describe('names', () => {
  it('com.example.crm.WorkOrder gets the table ontology_1_objects.work_order', async () => {
    expect(tableName('com.example.crm.WorkOrder')).toBe('work_order');

    const db = await shared('first');

    expect(await exists(db, 'ontology_1_objects.work_order')).toBe(true);
  });

  it('service/storage#names: the Property startDate gets the column start_date', async () => {
    expect(columnName('startDate')).toBe('start_date');

    const db = await shared('first');

    expect((await columnsOf(db, 'work_order')).map((c) => c.column_name)).toContain('start_date');
  });

  it('service/storage#names: the Link Type technicianWorkOrders gets the join table ontology_1_objects.technician_work_orders', async () => {
    expect(joinTableName('technicianWorkOrders')).toBe('technician_work_orders');

    const db = await shared('linked');

    expect(await exists(db, 'ontology_1_objects.technician_work_orders')).toBe(true);
  });

  it('service/storage#names: a Property API name longer than 63 bytes gets its snake_case form cut to 63 bytes', async () => {
    expect(LONG_PROPERTY.length).toBeGreaterThan(63);
    expect(snakeCase(LONG_PROPERTY)).toBe('estimated_completion_time_for_the_scheduled_preventive_maintena');

    const db = await shared('first');

    expect((await columnsOf(db, 'work_order')).map((c) => c.column_name)).toContain(
      'estimated_completion_time_for_the_scheduled_preventive_maintena',
    );
  });

  it('service/storage#names: 2 Object Types with the same table name fail with 400 that names both', async () => {
    const clash = ontology({
      objectTypes: [
        objectType('com.example.crm.HTTPServer', 'http_server', 'id', [property('id', 'id', { kind: 'string' }, true)]),
        objectType('com.example.crm.HttpServer', 'http_server', 'id', [property('id', 'id', { kind: 'string' }, true)]),
      ],
    });

    const error = await refusal(publish(await shared('empty'), clash, true));

    expect(error.status).toBe(400);
    expect(error.errorName).toBe('Default:InvalidArgument');
    expect(JSON.stringify(error.parameters)).toContain('com.example.crm.HTTPServer');
    expect(JSON.stringify(error.parameters)).toContain('com.example.crm.HttpServer');
  });

  it('service/storage#names: 2 Properties with the same column name in 1 Object Type fail with 400 that names both', async () => {
    const clash = ontology({
      objectTypes: [
        objectType('com.example.crm.Part', 'part', 'itemId', [
          property('itemId', 'item_id', { kind: 'string' }, true),
          property('itemID', 'item_id', { kind: 'string' }),
        ]),
      ],
    });

    const error = await refusal(publish(await shared('empty'), clash, true));

    expect(error.status).toBe(400);
    expect(JSON.stringify(error.parameters)).toContain('"itemId"');
    expect(JSON.stringify(error.parameters)).toContain('"itemID"');
  });

  it('service/storage#names: 2 Property names that are the same after the cut to 63 bytes fail with 400', async () => {
    const clash = ontology({
      objectTypes: [
        objectType('com.example.crm.Visit', 'visit', 'visitId', [
          property('visitId', 'visit_id', { kind: 'string' }, true),
          property(LONG_PROPERTY, LONG_COLUMN, { kind: 'double' }),
          property('estimatedCompletionTimeForTheScheduledPreventiveMaintenanceVisitInMinutes', LONG_COLUMN, {
            kind: 'double',
          }),
        ]),
      ],
    });

    const error = await refusal(publish(await shared('empty'), clash, true));

    expect(error.status).toBe(400);
    expect(JSON.stringify(error.parameters)).toContain(`"${LONG_PROPERTY}"`);

    expect(JSON.stringify(error.parameters)).toContain(
      '"estimatedCompletionTimeForTheScheduledPreventiveMaintenanceVisitInMinutes"',
    );
  });

  it('service/storage#names: a join table with the name of an Object Type table fails with 400', async () => {
    const technicianTable = ontology({
      objectTypes: [workOrder, technician],
      linkTypes: [
        {
          apiName: 'workOrder',
          rid: 'ri.ontology.main.relation.workOrder',
          status: 'experimental',
          storage: {
            kind: 'joinTable',
            table: 'work_order',
            a: { objectType: 'com.example.crm.Technician', column: 'technician_id' },
            b: { objectType: 'com.example.crm.WorkOrder', column: 'work_order_id' },
          },
        },
      ],
    });

    const error = await refusal(publish(await shared('empty'), technicianTable, true));

    expect(error.status).toBe(400);
    expect(JSON.stringify(error.parameters)).toContain('"com.example.crm.WorkOrder"');
    expect(JSON.stringify(error.parameters)).toContain('"workOrder"');
  });
});

describe('the Object table', () => {
  it('service/storage#objects: the primary key Property column is the only key column of the table', async () => {
    const db = await shared('first');

    const keys = await db.query(
      sql(
        `SELECT a.attname AS column, i.indisprimary AS primary
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = 'ontology_1_objects.work_order'::regclass AND (i.indisprimary OR i.indisunique)`,
      ),
    );

    expect(keys).toEqual([{ column: 'work_order_id', primary: true }]);
  });

  it('service/storage#objects: each Property is 1 column', async () => {
    const db = await shared('first');

    const columns = (await columnsOf(db, 'work_order')).map((c) => c.column_name);

    expect(columns).toEqual(expect.arrayContaining(WORK_ORDER_COLUMNS));
    expect(columns).toHaveLength(WORK_ORDER_COLUMNS.length + 1);
  });

  it('service/storage#objects: a required Property column is not null, and an optional one is nullable', async () => {
    const db = await shared('first');

    const nullable = Object.fromEntries((await columnsOf(db, 'work_order')).map((c) => [c.column_name, c.is_nullable]));

    expect(nullable).toMatchObject({
      work_order_id: 'NO',
      title: 'NO',
      start_date: 'YES',
      tags: 'YES',
      [LONG_COLUMN]: 'YES',
    });
  });

  it('service/storage#objects: an array Property is a Postgres array column', async () => {
    const db = await shared('first');

    const tags = (await columnsOf(db, 'work_order')).find((c) => c.column_name === 'tags');

    expect(tags).toMatchObject({ data_type: 'ARRAY', udt_name: '_text' });
  });

  it('service/storage#objects: no Object table has an Organization or tenant column', async () => {
    const db = await shared('linked');

    for (const table of ['work_order', 'technician']) {
      const columns = (await columnsOf(db, table)).map((c) => c.column_name);

      expect(columns.filter((c) => /org|tenant/.test(c))).toEqual([]);
    }
  });

  it('service/storage#objects: each Object table has 1 column that is not a Property: the version column', async () => {
    const db = await shared('linked');

    const extra = async (table: string, properties: readonly string[]) =>
      (await columnsOf(db, table)).filter((c) => !properties.includes(c.column_name));

    const workOrderExtra = await extra('work_order', WORK_ORDER_COLUMNS);

    const technicianExtra = await extra('technician', ['technician_id', 'name']);

    expect(workOrderExtra).toHaveLength(1);
    expect(technicianExtra).toHaveLength(1);
  });

  it('service/storage#objects: the version column of each Object table is named __version', async () => {
    const db = await shared('linked');

    for (const table of ['work_order', 'technician']) {
      const columns = (await columnsOf(db, table)).map((c) => c.column_name);

      expect(columns.filter((c) => c.startsWith('_'))).toEqual(['__version']);
    }
  });

  it('service/storage#objects: a Property whose column name is the version column name fails with 400', async () => {
    const clash = ontology({
      objectTypes: [
        objectType('com.example.crm.Part', 'part', 'partId', [
          property('partId', 'part_id', { kind: 'string' }, true),
          property('legacyVersion', '__version', { kind: 'string' }),
        ]),
      ],
    });

    const error = await refusal(publish(await shared('empty'), clash, true));

    expect(error.status).toBe(400);
    expect(error.errorName).toBe('Default:InvalidArgument');
    expect(JSON.stringify(error.parameters)).toContain('"__version"');
  });
});

describe('the role defaults and the session', () => {
  it('service/storage#connection: after an applied publish, the role has statement_timeout 60s, idle_in_transaction_session_timeout 90s, and jit off', async () => {
    const database = await ownDatabase();

    await publish(database.db, firstOntology, false);

    expect(await roleDefaults(database.db)).toEqual(
      expect.arrayContaining(['statement_timeout=60s', 'idle_in_transaction_session_timeout=90s', 'jit=off']),
    );

    const fresh = await newSession(database.url);

    expect(fresh).toEqual([{ statement_timeout: '1min', idle: '90s', jit: 'off' }]);
  });

  it('service/storage#connection: a validateOnly publish sets no role default, so a new session keeps the JIT of the Postgres default', async () => {
    const database = await ownDatabase();

    await publish(database.db, firstOntology, true);

    expect(await roleDefaults(database.db)).toEqual([]);

    const fresh = await newSession(database.url);

    expect(fresh).toEqual([{ statement_timeout: '0', idle: '0', jit: 'on' }]);

    expect(await onNewConnection(database.url, 'SELECT pg_jit_available() AS available')).toEqual([
      { available: true },
    ]);
  });

  it('service/storage#connection: a publish sets the values of the release that runs it, so a later release changes them at its next publish', async () => {
    const database = await ownDatabase();

    await publish(database.db, firstOntology, false, {
      statementTimeout: '45s',
      idleInTransactionSessionTimeout: '75s',
    });

    expect(await roleDefaults(database.db)).toEqual(
      expect.arrayContaining(['statement_timeout=45s', 'idle_in_transaction_session_timeout=75s', 'jit=off']),
    );

    const earlier = await newSession(database.url);

    expect(earlier).toEqual([{ statement_timeout: '45s', idle: '75s', jit: 'off' }]);

    const second = await newDatabase(postgres.url, { template });

    try {
      await publish(second.db, firstOntology, false);
    } finally {
      await second.end();
    }

    expect(await roleDefaults(database.db)).toEqual(
      expect.arrayContaining(['statement_timeout=60s', 'idle_in_transaction_session_timeout=90s', 'jit=off']),
    );

    expect(await roleDefaults(database.db)).toHaveLength(3);

    const later = await newSession(database.url);

    expect(later).toEqual([{ statement_timeout: '1min', idle: '90s', jit: 'off' }]);
  });

  it('service/storage#connection: after a publish, the idle limit of a new session is above the 60 s time limit of a Function run', async () => {
    const database = await ownDatabase();

    await publish(database.db, firstOntology, false);

    const [row] = await onNewConnection<{ seconds: number }>(
      database.url,
      `SELECT extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)::int AS seconds`,
    );

    expect(row?.seconds).toBe(90);
    expect(row?.seconds).toBeGreaterThan(60);
  });

  it('service/storage#connection: a publish leaves no session state on its connection: no setting and no prepared statement', async () => {
    const database = await ownDatabase();

    const pool = createPool(database.url, { max: 1 });
    const db = createDb(pool);

    try {
      await publishAndInstall(db, {
        ...TEST_PRODUCT,
        ontology: firstOntology,
        request: request(false),
        publisher: PUBLISHER,
        mode: APPLY,
      });

      const [row] = await db.query(
        sql(
          `SELECT current_setting('lock_timeout') AS lock_timeout,
             current_setting('transaction_timeout') AS transaction_timeout,
             current_setting('statement_timeout') AS statement_timeout,
             current_setting('idle_in_transaction_session_timeout') AS idle,
             (SELECT count(*)::int FROM pg_prepared_statements) AS prepared`,
        ),
      );

      expect(row).toEqual({
        lock_timeout: '0',
        transaction_timeout: '0',
        statement_timeout: '0',
        idle: '0',
        prepared: 0,
      });

      expect(pool.totalCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe('the request log', () => {
  it('a publish that waits too long for the lock logs the outcome failed and the real lock wait', async () => {
    const database = await ownDatabase();

    const holder = new pg.Client({ connectionString: database.url });

    await holder.connect();

    const logs: PublishLog[] = [];

    try {
      await holder.query('BEGIN');

      await holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

      const publishing = publishAndInstall(database.db, {
        ...TEST_PRODUCT,
        ontology: firstOntology,
        request: request(false),
        publisher: PUBLISHER,
        mode: APPLY,
        log: (log) => logs.push(log),
      });

      await expect(publishing).rejects.toThrow();
    } finally {
      await holder.query('ROLLBACK');

      await holder.end();
    }

    expect(logs).toHaveLength(1);

    expect(logs[0]).toMatchObject({
      outcome: 'failed',
      versionBefore: 0,
      versionAfter: 0,
      postgresError: { code: '55P03' },
    });

    expect(logs[0]?.lockWaitMs).toBeGreaterThanOrEqual(4500);
  });
});
