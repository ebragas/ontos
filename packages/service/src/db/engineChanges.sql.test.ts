import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, ontologyEngineChanges, sharedEngineChanges } from './index.ts';
import { applyEngineChanges, createDb, type Db } from './promise.test-utils.ts';
import { ENGINE_CHANGES_LOCK } from './engineChanges.ts';
import { span } from '../spans/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  columnsOf,
  EDIT_HISTORY_COLUMNS,
  firstOntology,
  newDatabase,
  publishAndInstall,
  PUBLISHER,
  request,
  sql,
  tablesOf,
  waitForLockWaits,
  type TestDatabase,
  APPLY,
  expectAllOnNewest,
} from '../publish/publish.test-utils.ts';
import { SCHEMAS, TEST_PRODUCT } from '../service.test-utils.ts';
import { recordSpans } from '../tracing.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url, { empty: true });
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

const PG_TRGM = '0003-pg-trgm';
const ONTOLOGIES = '0004-ontologies';
const SHARED_IDS = sharedEngineChanges.map((change) => change.id);

async function applyEarlierRelease(db: Db, count: number): Promise<void> {
  for (const change of sharedEngineChanges.slice(0, count)) {
    await db.transaction(async (tx) => {
      await tx.query(sql(change.sql));

      await tx.query(sql('INSERT INTO ontology_registry.engine_changes (id) VALUES ($1)', change.id));
    });
  }
}

async function appliedIds(db: Db): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    sql('SELECT id FROM ontology_registry.engine_changes ORDER BY xmin::text::bigint, id'),
  );

  return rows.map((row) => row.id);
}

async function transactionOf(db: Db, id: string): Promise<string> {
  const [row] = await db.query<{ xmin: string }>(
    sql('SELECT xmin::text AS xmin FROM ontology_registry.engine_changes WHERE id = $1', id),
  );

  return row?.xmin ?? '';
}

async function transactionOfTable(db: Db, table: string): Promise<string> {
  const [row] = await db.query<{ xmin: string }>(
    sql('SELECT xmin::text AS xmin FROM pg_type WHERE typrelid = to_regclass($1)', table),
  );

  return row?.xmin ?? '';
}

interface ColumnLayout {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

function engineLayout(db: Db): Promise<ColumnLayout[]> {
  return db.query<ColumnLayout>(
    sql(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'ontology_registry' AND table_name IN ('engine_changes', 'product_versions')
       ORDER BY table_name, ordinal_position`,
    ),
  );
}

const changeSql = () =>
  [...sharedEngineChanges, ...ontologyEngineChanges(SCHEMAS)].map((change) => ({
    id: change.id,
    sql: change.sql.replace(/--[^\n]*/g, ''),
  }));

describe('the lists of engine changes', () => {
  it('the engine changes are 2 ordered lists in the db module, and each change has an ID and its SQL', () => {
    expect(SHARED_IDS).toEqual([
      '0001-registry-schema',
      '0002-product-versions',
      PG_TRGM,
      ONTOLOGIES,
      '0005-product-version-grants',
      '0006-installation-hold',
    ]);

    expect(ontologyEngineChanges(SCHEMAS).map((change) => change.id)).toEqual([
      '0001-schemas',
      '0002-edit-history',
      '0003-edit-history-indexes',
    ]);

    for (const change of [...sharedEngineChanges, ...ontologyEngineChanges(SCHEMAS)]) {
      expect(change.id).toMatch(/^\d{4}-[a-z0-9-]+$/);
      expect(change.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('service/storage#engine-changes: the IDs and the SQL of the changes of an earlier release never change', () => {
    expect(sharedEngineChanges[0]).toEqual({
      id: '0001-registry-schema',
      sql: `CREATE SCHEMA ontology_registry;
REVOKE ALL ON SCHEMA ontology_registry FROM PUBLIC;
CREATE TABLE ontology_registry.engine_changes (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ontology_registry.engine_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ontology_service ON ontology_registry.engine_changes FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);`,
    });

    expect(ontologyEngineChanges(SCHEMAS)[0]).toEqual({
      id: '0001-schemas',
      sql: `CREATE SCHEMA ontology_1_objects;
CREATE SCHEMA ontology_1_engine;
REVOKE ALL ON SCHEMA ontology_1_objects, ontology_1_engine FROM PUBLIC;`,
    });
  });

  it('service/storage#engine-changes service/releases#compatibility-with-earlier-releases: an engine change only adds: no drop, rename, type change, function, trigger, or new not-null column without a default', () => {
    for (const change of changeSql()) {
      expect({ id: change.id, drops: /\b(DROP|RENAME|TRUNCATE|DELETE)\b/i.test(change.sql) }).toEqual({
        id: change.id,
        drops: false,
      });

      const logic = /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|TRIGGER|RULE)\b/i.test(change.sql);

      expect({ id: change.id, logic }).toEqual({ id: change.id, logic: false });

      expect({ id: change.id, alters: /ALTER\s+TABLE[^;]*\bALTER\b/i.test(change.sql) }).toEqual({
        id: change.id,
        alters: false,
      });

      const notNullWithoutDefault = [...change.sql.matchAll(/ADD\s+(?:COLUMN\s+)?([^;,]*)/gi)].some(
        ([, column]) => /NOT\s+NULL/i.test(column ?? '') && !/DEFAULT/i.test(column ?? ''),
      );

      expect({ id: change.id, notNullWithoutDefault }).toEqual({ id: change.id, notNullWithoutDefault: false });
    }
  });

  it('service/storage#engine-changes service/releases#compatibility-with-earlier-releases: an engine change never rewrites or backfills a table: no volatile default, no type change, and no row write', () => {
    for (const change of changeSql()) {
      const volatileDefault =
        /DEFAULT\s+(clock_timestamp|random|gen_random_uuid|uuid_generate\w*|timeofday|nextval)\s*\(/i.test(change.sql);

      const writesRows = /\b(INSERT\s+INTO|UPDATE)\b/i.test(change.sql);
      const typeChange = /ALTER\s+TABLE[^;]*\bTYPE\b/i.test(change.sql);

      expect({ id: change.id, volatileDefault, writesRows, typeChange }).toEqual({
        id: change.id,
        volatileDefault: false,
        writesRows: false,
        typeChange: false,
      });
    }
  });
});

describe('applying the engine changes', () => {
  it('after the cold start, ontology_registry.engine_changes holds the ID of each shared engine change', async () => {
    await applyEngineChanges(database.db);

    expect(await appliedIds(database.db)).toEqual(SHARED_IDS);
  });

  it('the shared engine changes create the registry, the product versions, and the engine changes; install creates edit_history', async () => {
    await applyEngineChanges(database.db);

    expect(await tablesOf(database.db, 'ontology_registry')).toEqual([
      'engine_changes',
      'ontologies',
      'product_versions',
    ]);

    await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    const editHistory = await database.db.query(
      sql(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'ontology_1_engine' AND table_name = 'edit_history' ORDER BY ordinal_position`,
      ),
    );

    expect(editHistory).toEqual([
      { column_name: EDIT_HISTORY_COLUMNS[0], data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: EDIT_HISTORY_COLUMNS[1], data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: EDIT_HISTORY_COLUMNS[2], data_type: 'jsonb', is_nullable: 'NO', column_default: null },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
    ]);
  });

  it('service/storage#engine-changes: an engine change changes the database of the release and makes no Ontology table; a publish makes the Ontology tables and no engine change', async () => {
    await applyEngineChanges(database.db);

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual([]);

    const before = await appliedIds(database.db);

    await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    expect(await tablesOf(database.db, 'ontology_1_objects')).toEqual(['work_order']);

    expect(await appliedIds(database.db)).toEqual(before);
  });

  it('service/storage#ownership: an engine change creates pg_trgm 1.6 in the ontology_registry schema, the only extension that Storage adds', async () => {
    await applyEngineChanges(database.db);

    const extensions = await database.db.query(
      sql(
        `SELECT e.extname, e.extversion, n.nspname AS schema FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY e.extname`,
      ),
    );

    expect(extensions).toEqual([{ extname: 'pg_trgm', extversion: '1.6', schema: 'ontology_registry' }]);

    const [extension] = await database.db.query<{ xmin: string }>(
      sql("SELECT xmin::text AS xmin FROM pg_extension WHERE extname = 'pg_trgm'"),
    );

    expect(extension?.xmin).toBe(await transactionOf(database.db, PG_TRGM));
  });

  it('service/storage#schema-and-access: on a new database, the cold start, a publish, and an install make no schema ontology or ontology_service, and each text index uses pg_trgm in ontology_registry', async () => {
    await applyEngineChanges(database.db);

    const searchable = {
      ...firstOntology,
      objectTypes: new Map(
        [...firstOntology.objectTypes].map(([name, type]) => [
          name,
          {
            ...type,
            properties: new Map(
              [...type.properties].map(([key, p]) => [key, key === 'title' ? { ...p, searchable: true } : p]),
            ),
          },
        ]),
      ),
    };

    await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: searchable,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    const schemas = await database.db.query(
      sql("SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'ontology%' ORDER BY 1"),
    );

    expect(schemas).toEqual([
      { name: 'ontology_1_engine' },
      { name: 'ontology_1_objects' },
      { name: 'ontology_registry' },
    ]);

    const extension = await database.db.query(
      sql("SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'pg_trgm'"),
    );

    expect(extension).toEqual([{ schema: 'ontology_registry' }]);

    const indexes = await database.db.query(
      sql(
        "SELECT schemaname || '.' || indexname AS name FROM pg_indexes WHERE indexdef LIKE '% ontology_registry.gin_trgm_ops)' ORDER BY 1",
      ),
    );

    expect(indexes).toEqual([{ name: 'ontology_1_objects.trgm_work_order_title_80a96415' }]);
  });

  it('on a database of an earlier release, the cold start applies only the changes that the database does not have, in list order', async () => {
    await applyEarlierRelease(database.db, 2);

    const versionsTable = await transactionOfTable(database.db, 'ontology_registry.product_versions');

    await applyEngineChanges(database.db);

    expect(await appliedIds(database.db)).toEqual(SHARED_IDS);

    expect(await transactionOfTable(database.db, 'ontology_registry.product_versions')).toBe(versionsTable);

    expect(await transactionOf(database.db, '0002-product-versions')).toBe(versionsTable);
  });

  it('the cold start waits for the advisory lock, and applies nothing while another session holds it', async () => {
    const holder = new pg.Client({ connectionString: database.url });

    await holder.connect();

    try {
      await holder.query('SELECT pg_advisory_lock($1)', [ENGINE_CHANGES_LOCK]);

      let done = false;

      const applying = applyEngineChanges(database.db).then(() => {
        done = true;
      });

      await waitForLockWaits(database.db, 1);

      expect(done).toBe(false);

      expect(await tablesOf(database.db, 'ontology_registry')).toEqual([]);

      await holder.query('SELECT pg_advisory_unlock($1)', [ENGINE_CHANGES_LOCK]);

      await applying;

      expect(done).toBe(true);
    } finally {
      await holder.end();
    }

    expect(await appliedIds(database.db)).toEqual(SHARED_IDS);
  });

  it('2 instances that start together on 1 database apply each engine change once, because each holds the advisory lock', async () => {
    const otherPool = createPool(database.url);

    try {
      await Promise.all([applyEngineChanges(database.db), applyEngineChanges(createDb(otherPool))]);
    } finally {
      await otherPool.end();
    }

    expect(await appliedIds(database.db)).toEqual(SHARED_IDS);
  });

  it('each engine change and its ID commit in 1 transaction', async () => {
    await applyEngineChanges(database.db);

    const transactions = await Promise.all(SHARED_IDS.map((id) => transactionOf(database.db, id)));

    expect(transactions.filter((xmin) => xmin === '')).toEqual([]);

    expect(await transactionOfTable(database.db, 'ontology_registry.engine_changes')).toBe(
      await transactionOf(database.db, '0001-registry-schema'),
    );

    expect(await transactionOfTable(database.db, 'ontology_registry.product_versions')).toBe(
      await transactionOf(database.db, '0002-product-versions'),
    );

    expect(await transactionOfTable(database.db, 'ontology_registry.ontologies')).toBe(
      await transactionOf(database.db, ONTOLOGIES),
    );
  });

  it('when the ID of a change cannot be written, the change rolls back with it, and the cold start fails', async () => {
    await applyEarlierRelease(database.db, 1);

    await database.db.query(
      sql(
        `ALTER TABLE ontology_registry.engine_changes ADD CONSTRAINT refuse_ontologies CHECK (id <> '${ONTOLOGIES}')`,
      ),
    );

    await expect(applyEngineChanges(database.db)).rejects.toThrow();

    expect(await appliedIds(database.db)).toEqual(['0001-registry-schema', '0002-product-versions', PG_TRGM]);

    expect(await tablesOf(database.db, 'ontology_registry')).toEqual(['engine_changes', 'product_versions']);

    await database.db.query(sql('ALTER TABLE ontology_registry.engine_changes DROP CONSTRAINT refuse_ontologies'));

    await applyEngineChanges(database.db);

    expect(await tablesOf(database.db, 'ontology_registry')).toEqual([
      'engine_changes',
      'ontologies',
      'product_versions',
    ]);
  });

  it('the cold start ignores an ID in the table that its list does not have', async () => {
    await applyEngineChanges(database.db);

    await database.db.query(sql("INSERT INTO ontology_registry.engine_changes (id) VALUES ('9999-later-release')"));

    await applyEngineChanges(database.db);

    expect(await appliedIds(database.db)).toEqual([...SHARED_IDS, '9999-later-release']);
  });

  it('on a database that already has all shared changes, the cold start skips advisory locks and transactions', async () => {
    await applyEngineChanges(database.db);

    const recorder = recordSpans();

    try {
      await span('root', { 'route.key': 'GET /api/v2/ontologies' }, () => applyEngineChanges(database.db));

      const templates = recorder
        .spans()
        .filter((s) => s.name === 'sql')
        .map((s) => String(s.attributes['sql.template']));

      expect(templates).toEqual([
        'SELECT id FROM ontology_registry.engine_changes',
        'SELECT rid FROM ontology_registry.ontologies WHERE engine_change_count < $1 ORDER BY number',
      ]);
    } finally {
      recorder.stop();
    }
  });

  it('on a partial database, 2 concurrent cold starts apply only the missing shared changes under the advisory lock', async () => {
    await applyEarlierRelease(database.db, 2);

    const versionsTable = await transactionOfTable(database.db, 'ontology_registry.product_versions');

    const otherPool = createPool(database.url);
    const recorder = recordSpans();

    try {
      await span('root', { 'route.key': 'GET /api/v2/ontologies' }, () =>
        Promise.all([applyEngineChanges(database.db), applyEngineChanges(createDb(otherPool))]),
      );

      const locks = recorder
        .spans()
        .filter((s) => s.name === 'sql' && s.attributes['sql.template'] === 'SELECT pg_advisory_xact_lock($1)');

      const missing = sharedEngineChanges.length - 2;

      expect(locks.length).toBeGreaterThanOrEqual(missing);
      expect(locks.length).toBeLessThanOrEqual(missing * 2);
    } finally {
      recorder.stop();

      await otherPool.end();
    }

    expect(await appliedIds(database.db)).toEqual(SHARED_IDS);

    expect(await transactionOfTable(database.db, 'ontology_registry.product_versions')).toBe(versionsTable);
  });
});

describe('releases', () => {
  it('service/storage#engine-changes: an earlier release starts and publishes on the tables of a later release, and ignores the change it does not know', async () => {
    await applyEngineChanges(database.db);

    await database.db.transaction(async (tx) => {
      await tx.query(sql('ALTER TABLE ontology_registry.product_versions ADD COLUMN later_field text'));

      await tx.query(sql("INSERT INTO ontology_registry.engine_changes (id) VALUES ('9999-later-release')"));
    });

    await applyEngineChanges(database.db);

    const response = await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    expect(response.version).toBe(1);

    const versions = await database.db.query(
      sql('SELECT version, publisher, later_field FROM ontology_registry.product_versions'),
    );

    expect(versions).toEqual([{ version: 1, publisher: PUBLISHER, later_field: null }]);
  });

  it('service/storage#engine-changes: a release keeps the table layout of each engine table and each Object table of an earlier release', async () => {
    await applyEngineChanges(database.db);

    await publishAndInstall(database.db, {
      ...TEST_PRODUCT,
      ontology: firstOntology,
      request: request(false),
      publisher: PUBLISHER,
      mode: APPLY,
    });

    const objectTable = await columnsOf(database.db, 'work_order');

    expect(objectTable.map((column) => column.column_name)).toContain('__version');

    const earlier = await engineLayout(database.db);

    expect(earlier).toEqual([
      { table_name: 'engine_changes', column_name: 'id', data_type: 'text', is_nullable: 'NO', column_default: null },
      {
        table_name: 'engine_changes',
        column_name: 'applied_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      },
      {
        table_name: 'product_versions',
        column_name: 'product',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'version',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'ir',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'metadata',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'schema_migrations',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'osdk_set',
        data_type: 'jsonb',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'functions',
        data_type: 'jsonb',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'publisher',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
      },
      {
        table_name: 'product_versions',
        column_name: 'published_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      },
      {
        table_name: 'product_versions',
        column_name: 'grants',
        data_type: 'jsonb',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);

    await applyEngineChanges(database.db);

    expect(await engineLayout(database.db)).toEqual(expect.arrayContaining(earlier));

    expect(await columnsOf(database.db, 'work_order')).toEqual(expect.arrayContaining(objectTable));
  });

  it('service/storage#engine-changes: the engine changes of this release rewrite no table of an earlier release that holds rows', async () => {
    await applyEarlierRelease(database.db, 2);

    await database.db.query(
      sql(
        "INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, publisher) VALUES ('test', 1, '{}', '{}', '{}', '{}', 'p')",
      ),
    );

    const fileNodes = () =>
      database.db.query(
        sql(
          `SELECT relname, relfilenode::text AS file FROM pg_class
           WHERE oid IN ('ontology_registry.engine_changes'::regclass, 'ontology_registry.product_versions'::regclass)
           ORDER BY relname`,
        ),
      );

    const before = await fileNodes();

    await applyEngineChanges(database.db);

    expect(await fileNodes()).toEqual(before);
  });
});
