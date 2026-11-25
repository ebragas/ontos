import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OntologyIr } from '@osdk/client.unstable';
import { createPool, ontologyEngineChanges, sharedEngineChanges, type Schemas } from './index.ts';
import { applyEngineChanges, createDb, type Db } from './promise.test-utils.ts';
import { ENGINE_CHANGES_LOCK } from './engineChanges.ts';
import type { JsonObject } from '../ontology/index.ts';

import type { CheckedRequest } from '../publish/index.ts';
import { installOntology } from '../install.test-utils.ts';
import {
  convertOrThrow,
  irOf,
  ONTOLOGY_RID,
  stored,
  twinObjectType,
  unchecked,
} from '../ontology/stored.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  APPLY,
  expectAllOnNewest,
  lockInstallation,
  NO_GRANTS,
  PUBLISHER,
  publishOntology,
  sql,
  waitForLockWaits,
} from '../publish/publish.test-utils.ts';

const SERVICE_ROLE = 'engine_count_service_role';
const SERVICE_PASSWORD = 'engine-count-test-only';

let postgres: TestPostgres;
let template: string;
let databases = 0;
let pool: pg.Pool;
let db: Db;
let url: string;

async function asAdmin(text: string): Promise<void> {
  const admin = new pg.Client({ connectionString: postgres.url });

  await admin.connect();

  try {
    await admin.query(text);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  postgres = await startPostgres();

  await asAdmin(
    `CREATE ROLE ${SERVICE_ROLE} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: SERVICE_ROLE, password: SERVICE_PASSWORD });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  const name = `engine_count_${++databases}`;

  await asAdmin(`CREATE DATABASE ${name} TEMPLATE ${template}`);

  await asAdmin(`GRANT CREATE ON DATABASE ${name} TO ${SERVICE_ROLE}`);

  const address = new URL(postgres.url);

  address.username = SERVICE_ROLE;
  address.password = SERVICE_PASSWORD;
  address.pathname = `/${name}`;

  url = address.toString();

  pool = createPool(url);

  db = createDb(pool);
});

afterEach(async () => {
  if (pool) await expectAllOnNewest(db);

  await pool?.end();
});

function schemasOf(number: number): Schemas {
  return { object: `ontology_${number}_objects`, engine: `ontology_${number}_engine` };
}

async function seedOntologyAtCount(number: number, count: number): Promise<void> {
  const schemas = schemasOf(number);

  await db.transaction(async (tx) => {
    await tx.query(
      sql(
        `INSERT INTO ontology_registry.ontologies (number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
         OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $3, $4, $5, 'test', 1, 'org_1', $6)`,
        number,
        `ri.ontology.main.ontology.${number}`,
        `ontology${number}`,
        schemas.object,
        schemas.engine,
        count,
      ),
    );

    for (const change of ontologyEngineChanges(schemas).slice(0, count)) await tx.query(sql(change.sql));
  });
}

async function counts(): Promise<Array<{ number: number; engine_change_count: number }>> {
  return db.query(sql('SELECT number, engine_change_count FROM ontology_registry.ontologies ORDER BY number'));
}

async function countsAndTransactions(): Promise<unknown[]> {
  return db.query(
    sql(
      `SELECT o.number, o.engine_change_count, o.xmin::text AS row_xmin,
         (SELECT t.xmin::text FROM pg_type t WHERE t.typrelid = to_regclass(o.engine_schema || '.edit_history')) AS edit_history_xmin
       FROM ontology_registry.ontologies o ORDER BY o.number`,
    ),
  );
}

describe('the per-Ontology engine changes at cold start', () => {
  it('service/storage#engine-changes: 3 Ontologies at the counts 0, 1, and 2 reach the full count 3 at 1 cold start, and a second cold start changes nothing', async () => {
    await seedOntologyAtCount(1, 0);

    await seedOntologyAtCount(2, 1);

    await seedOntologyAtCount(3, 2);

    await applyEngineChanges(db);

    expect(await counts()).toEqual([
      { number: 1, engine_change_count: 3 },
      { number: 2, engine_change_count: 3 },
      { number: 3, engine_change_count: 3 },
    ]);

    const tables = await db.query(
      sql(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema LIKE 'ontology\\_%\\_engine' ORDER BY 1",
      ),
    );

    expect(tables).toEqual([
      { table_schema: 'ontology_1_engine', table_name: 'edit_history' },
      { table_schema: 'ontology_2_engine', table_name: 'edit_history' },
      { table_schema: 'ontology_3_engine', table_name: 'edit_history' },
    ]);

    const indexes = await db.query<{ schemaname: string; indexname: string }>(
      sql(
        "SELECT schemaname, indexname FROM pg_indexes WHERE schemaname LIKE 'ontology\\_%\\_engine' AND tablename = 'edit_history' ORDER BY 1, 2",
      ),
    );

    expect(indexes).toEqual([
      { schemaname: 'ontology_1_engine', indexname: 'edit_history_type_created_pk_idx' },
      { schemaname: 'ontology_1_engine', indexname: 'edit_history_type_pk_created_idx' },
      { schemaname: 'ontology_2_engine', indexname: 'edit_history_type_created_pk_idx' },
      { schemaname: 'ontology_2_engine', indexname: 'edit_history_type_pk_created_idx' },
      { schemaname: 'ontology_3_engine', indexname: 'edit_history_type_created_pk_idx' },
      { schemaname: 'ontology_3_engine', indexname: 'edit_history_type_pk_created_idx' },
    ]);

    const before = await countsAndTransactions();

    await applyEngineChanges(db);

    expect(await countsAndTransactions()).toEqual(before);
  });

  it('service/storage#engine-changes: a cold start that fails between 2 Ontologies keeps the first one at the full count, and the next cold start resumes from the counts', async () => {
    await seedOntologyAtCount(1, 0);

    await seedOntologyAtCount(2, 1);

    await db.query(sql('DROP SCHEMA ontology_2_engine'));

    await expect(applyEngineChanges(db)).rejects.toThrow('schema "ontology_2_engine" does not exist');

    expect(await counts()).toEqual([
      { number: 1, engine_change_count: 3 },
      { number: 2, engine_change_count: 1 },
    ]);

    const [first] = await countsAndTransactions();

    await db.query(sql('CREATE SCHEMA ontology_2_engine'));

    await applyEngineChanges(db);

    expect(await counts()).toEqual([
      { number: 1, engine_change_count: 3 },
      { number: 2, engine_change_count: 3 },
    ]);

    expect((await countsAndTransactions())[0]).toEqual(first);
  });

  it('service/storage#engine-changes: when the 2nd of 3 Ontologies fails, the 3rd still reaches the full count, and the cold start error names the 2nd and holds its error as the cause', async () => {
    await seedOntologyAtCount(1, 0);

    await seedOntologyAtCount(2, 1);

    await seedOntologyAtCount(3, 0);

    await db.query(sql('DROP SCHEMA ontology_2_engine'));

    const failure = await applyEngineChanges(db).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(
      'The per-Ontology engine changes failed for ri.ontology.main.ontology.2 (schema "ontology_2_engine" does not exist).',
    );

    expect((failure?.cause as Error | undefined)?.message).toBe('schema "ontology_2_engine" does not exist');

    expect(await counts()).toEqual([
      { number: 1, engine_change_count: 3 },
      { number: 2, engine_change_count: 1 },
      { number: 3, engine_change_count: 3 },
    ]);
  });

  it('service/storage#engine-changes: when the 2nd and the 4th of 4 Ontologies fail, the 3rd still reaches the full count, and the cold start fails with 1 error that names both', async () => {
    await seedOntologyAtCount(1, 0);

    await seedOntologyAtCount(2, 1);

    await seedOntologyAtCount(3, 0);

    await seedOntologyAtCount(4, 1);

    await db.query(sql('DROP SCHEMA ontology_2_engine'));

    await db.query(sql('DROP SCHEMA ontology_4_engine'));

    const failure = await applyEngineChanges(db).then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );

    expect(failure).toBe(
      'The per-Ontology engine changes failed for ri.ontology.main.ontology.2 (schema "ontology_2_engine" does not exist), ri.ontology.main.ontology.4 (schema "ontology_4_engine" does not exist).',
    );

    expect(await counts()).toEqual([
      { number: 1, engine_change_count: 3 },
      { number: 2, engine_change_count: 1 },
      { number: 3, engine_change_count: 3 },
      { number: 4, engine_change_count: 1 },
    ]);
  });

  it('service/storage#engine-changes: a cold start that waited on the row reads the count again, and keeps a count that a later release raised meanwhile', async () => {
    await seedOntologyAtCount(1, 1);

    const holder = new pg.Client({ connectionString: url });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 1 FOR UPDATE');

      const applying = applyEngineChanges(db);

      await waitForLockWaits(db, 1);

      for (const change of ontologyEngineChanges(schemasOf(1)).slice(1)) await holder.query(change.sql);

      await holder.query('UPDATE ontology_registry.ontologies SET engine_change_count = 4 WHERE number = 1');

      await holder.query('COMMIT');

      await applying;
    } finally {
      await holder.end();
    }

    expect(await counts()).toEqual([{ number: 1, engine_change_count: 4 }]);
  });

  it('service/storage#engine-changes: while 1 Ontology is locked, the cold start has raised the Ontology before it, and waits, with the locked one still at its count', async () => {
    await seedOntologyAtCount(1, 1);

    await seedOntologyAtCount(2, 1);

    const holder = new pg.Client({ connectionString: url });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 2 FOR UPDATE');

      let done = false;

      const applying = applyEngineChanges(db).then(() => {
        done = true;
      });

      await waitForLockWaits(db, 1);

      expect(done).toBe(false);

      expect(await counts()).toEqual([
        { number: 1, engine_change_count: 3 },
        { number: 2, engine_change_count: 1 },
      ]);

      await holder.query('COMMIT');

      await applying;
    } finally {
      await holder.end();
    }

    expect(await counts()).toEqual([
      { number: 1, engine_change_count: 3 },
      { number: 2, engine_change_count: 3 },
    ]);
  });

  it('service/storage#engine-changes: 2 instances that reach 1 Ontology together apply each missing per-Ontology change once', async () => {
    await seedOntologyAtCount(1, 0);

    const otherPool = createPool(url);
    const holder = new pg.Client({ connectionString: url });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 1 FOR UPDATE');

      const both = Promise.all([applyEngineChanges(db), applyEngineChanges(createDb(otherPool))]);

      await waitForLockWaits(db, 2);

      await holder.query('COMMIT');

      await both;
    } finally {
      await holder.end();

      await otherPool.end();
    }

    expect(await counts()).toEqual([{ number: 1, engine_change_count: 3 }]);
  });

  it('service/storage#engine-changes: a release with a shorter list changes nothing on an Ontology that a later release raised', async () => {
    await seedOntologyAtCount(1, 3);

    await db.query(sql('UPDATE ontology_registry.ontologies SET engine_change_count = 4 WHERE number = 1'));

    const before = await countsAndTransactions();

    await applyEngineChanges(db);

    expect(await countsAndTransactions()).toEqual(before);

    expect(await counts()).toEqual([{ number: 1, engine_change_count: 4 }]);
  });
});

describe('the counts and the shared list', () => {
  it('service/storage#engine-changes: the engine changes are 2 ordered lists, the shared list and the per-Ontology list, and each change has an ID and its SQL', () => {
    expect(sharedEngineChanges.map((change) => change.id)).toEqual([
      '0001-registry-schema',
      '0002-product-versions',
      '0003-pg-trgm',
      '0004-ontologies',
      '0005-product-version-grants',
      '0006-installation-hold',
    ]);

    expect(ontologyEngineChanges(schemasOf(7)).map((change) => change.id)).toEqual([
      '0001-schemas',
      '0002-edit-history',
      '0003-edit-history-indexes',
    ]);

    expect(ontologyEngineChanges(schemasOf(7))[0]?.sql).toBe(`CREATE SCHEMA ontology_7_objects;
CREATE SCHEMA ontology_7_engine;
REVOKE ALL ON SCHEMA ontology_7_objects, ontology_7_engine FROM PUBLIC;`);
  });

  it('service/storage#engine-changes: the registry row counts the per-Ontology changes, and install sets the count to the length of the list', async () => {
    const ir: OntologyIr = irOf(twinObjectType('Account'));

    const checked: CheckedRequest = {
      product: 'counts',
      ir: unchecked<JsonObject>(ir),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants: NO_GRANTS,
      validateOnly: false,
    };

    await publishOntology(db, {
      product: 'counts',
      productRid: ONTOLOGY_RID,
      ontology: convertOrThrow(checked, ONTOLOGY_RID, 1),
      request: checked,
      publisher: PUBLISHER,
      mode: APPLY,
    });

    await installOntology(db, {
      rid: 'ri.ontology.main.ontology.33333333-3333-4333-8333-333333333333',
      product: 'counts',
      apiName: 'counts',
      displayName: 'counts',
      organization: 'org_01TEST0RG00000000000000001',
    });

    expect(await counts()).toEqual([{ number: 1, engine_change_count: 3 }]);

    const tables = await db.query(
      sql("SELECT table_name FROM information_schema.tables WHERE table_schema = 'ontology_1_engine'"),
    );

    expect(tables).toEqual([{ table_name: 'edit_history' }]);
  });

  it('service/storage#engine-changes: after the cold start, engine_changes holds the ID of each shared change, each written in the transaction of its change', async () => {
    const rows = await db.query(sql('SELECT id FROM ontology_registry.engine_changes ORDER BY xmin::text::bigint, id'));

    expect(rows).toEqual([
      { id: '0001-registry-schema' },
      { id: '0002-product-versions' },
      { id: '0003-pg-trgm' },
      { id: '0004-ontologies' },
      { id: '0005-product-version-grants' },
      { id: '0006-installation-hold' },
    ]);

    const together = await db.query(
      sql(
        `SELECT e.id, e.xmin::text = t.xmin::text AS same_transaction FROM ontology_registry.engine_changes e
         JOIN pg_type t ON t.typrelid = to_regclass(CASE e.id WHEN '0002-product-versions' THEN 'ontology_registry.product_versions' ELSE 'ontology_registry.ontologies' END)
         WHERE e.id IN ('0002-product-versions', '0004-ontologies') ORDER BY e.id`,
      ),
    );

    expect(together).toEqual([
      { id: '0002-product-versions', same_transaction: true },
      { id: '0004-ontologies', same_transaction: true },
    ]);
  });

  it('service/storage#engine-changes: the cold start ignores an ID in the table that its list does not have', async () => {
    await db.query(sql("INSERT INTO ontology_registry.engine_changes (id) VALUES ('9999-later-release')"));

    await applyEngineChanges(db);

    const rows = await db.query(sql('SELECT id FROM ontology_registry.engine_changes ORDER BY id'));

    expect(rows).toEqual([
      { id: '0001-registry-schema' },
      { id: '0002-product-versions' },
      { id: '0003-pg-trgm' },
      { id: '0004-ontologies' },
      { id: '0005-product-version-grants' },
      { id: '0006-installation-hold' },
      { id: '9999-later-release' },
    ]);
  });

  it('service/storage#engine-changes: the cold start waits for the advisory lock, and then applies the per-Ontology changes too', async () => {
    await db.query(sql('ALTER TABLE ontology_registry.ontologies DROP COLUMN held'));

    await db.query(sql("DELETE FROM ontology_registry.engine_changes WHERE id = '0006-installation-hold'"));

    await seedOntologyAtCount(1, 1);

    const holder = new pg.Client({ connectionString: url });

    await holder.connect();

    try {
      await holder.query('SELECT pg_advisory_lock($1)', [ENGINE_CHANGES_LOCK]);

      let done = false;

      const applying = applyEngineChanges(db).then(() => {
        done = true;
      });

      await waitForLockWaits(db, 1);

      expect(done).toBe(false);

      expect(await counts()).toEqual([{ number: 1, engine_change_count: 1 }]);

      await holder.query('SELECT pg_advisory_unlock($1)', [ENGINE_CHANGES_LOCK]);

      await applying;
    } finally {
      await holder.end();
    }

    expect(await counts()).toEqual([{ number: 1, engine_change_count: 3 }]);
  });
});

async function storeProductVersion(product: string, version: number): Promise<void> {
  await db.query(
    sql(
      `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, publisher)
       VALUES ($1, $2, '{}', '{}', '{"migrations": []}', '{}', $3)`,
      product,
      version,
      PUBLISHER,
    ),
  );
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    sql(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'ontology_registry' AND table_name = $1 ORDER BY ordinal_position",
      table,
    ),
  );

  return rows.map((row) => row.column_name);
}

describe('the column held', () => {
  it('service/storage#registry: a cold start on a database with 2 installations and no column held adds held false on each, records 0006-installation-hold, and a second cold start changes nothing', async () => {
    await db.query(sql('ALTER TABLE ontology_registry.ontologies DROP COLUMN held'));

    await db.query(sql("DELETE FROM ontology_registry.engine_changes WHERE id = '0006-installation-hold'"));

    await seedOntologyAtCount(1, 3);

    await seedOntologyAtCount(2, 3);

    await applyEngineChanges(db);

    const held = sql(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'ontology_registry' AND table_name = 'ontologies' AND column_name = 'held'",
    );

    expect(await db.query(held)).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);

    const state = () =>
      Promise.all([
        db.query(sql('SELECT number, held, xmin::text AS row_xmin FROM ontology_registry.ontologies ORDER BY number')),
        db.query(
          sql(
            "SELECT id, xmin::text AS row_xmin FROM ontology_registry.engine_changes WHERE id = '0006-installation-hold'",
          ),
        ),
      ]);

    const before = await state();

    expect(before[0].map(({ number, held: value }) => ({ number, held: value }))).toEqual([
      { number: 1, held: false },
      { number: 2, held: false },
    ]);

    expect(before[1].map(({ id }) => id)).toEqual(['0006-installation-hold']);

    await applyEngineChanges(db);

    expect(await state()).toEqual(before);
  });

  it('service/storage#registry: the registry and the product versions have exactly the listed columns, with the hold and with no failure and no pass of an upgrade', async () => {
    expect(await columnsOf('ontologies')).toEqual([
      'rid',
      'number',
      'api_name',
      'display_name',
      'object_schema',
      'engine_schema',
      'product',
      'version',
      'organization',
      'engine_change_count',
      'held',
    ]);

    expect(await columnsOf('product_versions')).toEqual([
      'product',
      'version',
      'ir',
      'metadata',
      'schema_migrations',
      'osdk_set',
      'functions',
      'publisher',
      'published_at',
      'grants',
    ]);
  });

  it('the row-lock read waits while a second connection holds the registry row, then reads the row that the holder wrote', async () => {
    await seedOntologyAtCount(1, 3);

    await storeProductVersion('test', 1);

    const holder = new pg.Client({ connectionString: url });

    await holder.connect();

    try {
      await holder.query('BEGIN');

      await holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 1 FOR UPDATE');

      let done = false;

      const locking = db
        .transaction((tx) => lockInstallation(tx, 'ri.ontology.main.ontology.1'))
        .then((locked) => {
          done = true;

          return locked;
        });

      await waitForLockWaits(db, 1);

      expect(done).toBe(false);

      await holder.query(
        `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, publisher)
         VALUES ('test', 2, '{}', '{}', '{"migrations": []}', '{}', 'holder')`,
      );

      await holder.query('UPDATE ontology_registry.ontologies SET version = 2 WHERE number = 1');

      await holder.query('COMMIT');

      expect(await locking).toEqual({
        number: 1,
        rid: 'ri.ontology.main.ontology.1',
        apiName: 'ontology1',
        product: 'test',
        schemas: schemasOf(1),
        version: 2,
      });
    } finally {
      await holder.end();
    }
  });

  it('the row lock stays until the transaction of the read ends, and an unknown RID reads undefined', async () => {
    await seedOntologyAtCount(1, 3);

    const holder = new pg.Client({ connectionString: url });

    await holder.connect();

    try {
      const locked = await db.transaction(async (tx) => {
        const read = await lockInstallation(tx, 'ri.ontology.main.ontology.1');

        await expect(
          holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 1 FOR UPDATE NOWAIT'),
        ).rejects.toThrow('could not obtain lock on row in relation "ontologies"');

        return read;
      });

      expect(locked).toMatchObject({ version: 1 });

      expect(
        (await holder.query('SELECT 1 FROM ontology_registry.ontologies WHERE number = 1 FOR UPDATE NOWAIT')).rowCount,
      ).toBe(1);
    } finally {
      await holder.end();
    }

    expect(await db.transaction((tx) => lockInstallation(tx, 'ri.ontology.main.ontology.unknown'))).toBeUndefined();
  });
});
