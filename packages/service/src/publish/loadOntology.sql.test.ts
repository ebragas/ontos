import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ontologyEngineChanges, type Sql } from '../db/index.ts';
import { type Db, fallibleOf, rejecting } from '../db/promise.test-utils.ts';
import type { Handle } from '../handler/index.ts';
import type { CompiledOntology, OntologyView } from '../ontology/index.ts';
import type { PublishedFunctions } from './index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { asSnapshot, testSettings, MEMBER, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { irNaming } from './releasesSupport.test-utils.ts';
import {
  firstOntology,
  linkedOntology,
  newDatabase,
  OSDK_SET,
  PUBLISHER,
  sql,
  type TestDatabase,
  expectAllOnNewest,
} from './publish.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

const RID = TEST_ONTOLOGY_RID;
const ENGINE_CHANGE_COUNT = ontologyEngineChanges({ object: '', engine: '' }).length;

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  await import('../ontology/index.ts');

  await import('../handler/index.ts');

  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  await database.db.query(
    sql(
      `INSERT INTO ontology_registry.ontologies (rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
       VALUES ($1, 'test', 'Test', 'ontology_1_objects', 'ontology_1_engine', 'test', 1, $2, $3)`,
      RID,
      ORGANIZATION,
      ENGINE_CHANGE_COUNT,
    ),
  );

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  consoleLog.mockRestore();

  await database.end();
});

type Open = (db: Db) => Promise<OntologyView>;

const CALLER = { ...MEMBER, permissions: [USE] };

async function newOpen(): Promise<Open> {
  vi.resetModules();

  const { openOntology } = await import('../ontology/index.ts');

  return (db) => rejecting(openOntology(fallibleOf(db), RID, CALLER));
}

async function newHandle(): Promise<Handle> {
  vi.resetModules();

  const { handle } = await import('../handler/index.ts');

  return handle;
}

function metadataOf(n: number, compiled: CompiledOntology = firstOntology): CompiledOntology['metadata'] {
  const [name = '', first] = Object.entries(compiled.metadata.objectTypes)[0] ?? [];

  if (!first) throw new Error('A version of these tests needs 1 Object Type.');

  return {
    ...compiled.metadata,
    objectTypes: {
      ...compiled.metadata.objectTypes,
      [name]: { ...first, objectType: { ...first.objectType, description: `Version ${n}` } },
    },
  };
}

function propertiesOf(compiled: CompiledOntology): unknown {
  const properties = [...compiled.objectTypes.values()][0]?.properties;

  if (!properties) throw new Error('The view has no Object Type.');

  return properties;
}

function versionOf(metadata: CompiledOntology['metadata']): string | undefined {
  return Object.values(metadata.objectTypes)[0]?.objectType.description;
}

async function storeVersion(
  version: number,
  metadata: CompiledOntology['metadata'] = metadataOf(version),
  functions?: PublishedFunctions,
  db: Db = database.db,
): Promise<void> {
  const grants = {
    permissions: { [USE]: { description: 'Use the twin' } },
    objectTypes: Object.fromEntries(Object.keys(metadata.objectTypes).map((name) => [name, USE])),
    actionTypes: {},
    defaultRoles: { member: [USE] },
  };

  await db.query(
    sql(
      `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, publisher, grants)
       VALUES ('test', $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb)`,
      version,
      JSON.stringify(irNaming(Object.keys(metadata.objectTypes))),
      JSON.stringify(metadata),
      JSON.stringify({ migrations: [] }),
      JSON.stringify(OSDK_SET),
      functions ? JSON.stringify(functions) : null,
      PUBLISHER,
      JSON.stringify(grants),
    ),
  );
}

async function moveTo(version: number, db: Db = database.db): Promise<void> {
  await db.query(sql('UPDATE ontology_registry.ontologies SET version = $1', version));
}

describe('the version of the Ontology', () => {
  it('an Ontology serves the Ontology metadata of its product version, with its own RID', async () => {
    await storeVersion(1);

    const stored = metadataOf(2, linkedOntology);

    await storeVersion(2, {
      ...stored,
      ontology: { ...stored.ontology, apiName: 'stored', displayName: 'Stored', description: 'A stored description' },
    });

    await moveTo(2);

    const { ontology } = await (await newOpen())(database.db);

    expect(ontology.version).toBe(2);

    expect(ontology.metadata).toEqual({
      ...stored,
      ontology: { apiName: 'test', displayName: 'Test', description: '', rid: RID },
    });
  });

  it('service/http-api#metadata-routes: 2 Ontologies of 1 product version each keep their own ontology block, when one opens after the other', async () => {
    const second = 'ri.ontology.main.ontology.22222222-2222-4222-8222-222222222222';

    await storeVersion(1);

    await database.db.query(
      sql(
        `INSERT INTO ontology_registry.ontologies (rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
         VALUES ($1, 'second', 'Second', 'ontology_2_objects', 'ontology_2_engine', 'test', 1, $2, $3)`,
        second,
        ORGANIZATION,
        ENGINE_CHANGE_COUNT,
      ),
    );

    vi.resetModules();

    const { openOntology } = await import('../ontology/index.ts');

    const first = await rejecting(openOntology(fallibleOf(database.db), RID, CALLER));

    await rejecting(openOntology(fallibleOf(database.db), second, CALLER));

    expect(first.ontology.metadata.ontology).toEqual({
      rid: RID,
      apiName: 'test',
      displayName: 'Test',
      description: '',
    });
  });

  it('a new release serves the stored metadata, and does not convert the IR again', async () => {
    await storeVersion(1, metadataOf(1, linkedOntology));

    const { ontology } = await (await newOpen())(database.db);

    expect(Object.keys(ontology.metadata.objectTypes)).toEqual([
      'com.example.crm.WorkOrder',
      'com.example.crm.Technician',
    ]);

    expect(versionOf(ontology.metadata)).toBe('Version 1');
  });

  it('the view holds the RID and the 2 schema names of the registry row', async () => {
    await storeVersion(1);

    const view = await (await newOpen())(database.db);

    expect([view.rid, view.schemas]).toEqual([RID, { object: 'ontology_1_objects', engine: 'ontology_1_engine' }]);
  });
});

describe('the compiled product versions in memory', () => {
  it('an instance reuses the compiled product version', async () => {
    await storeVersion(1);

    const open = await newOpen();

    const first = (await open(database.db)).ontology;

    const again = (await open(database.db)).ontology;

    expect(first.version).toBe(1);
    expect(propertiesOf(again)).toBe(propertiesOf(first));
  });

  it('after a publish, an instance compiles the new product version', async () => {
    await storeVersion(1);

    const open = await newOpen();

    const first = (await open(database.db)).ontology;

    expect(first.version).toBe(1);

    await storeVersion(2);

    await moveTo(2);

    const second = (await open(database.db)).ontology;

    expect(second.version).toBe(2);
    expect(versionOf(second.metadata)).toBe('Version 2');
    expect(propertiesOf(second)).not.toBe(propertiesOf(first));

    expect(propertiesOf((await open(database.db)).ontology)).toBe(propertiesOf(second));
  });

  it('a failed load keeps nothing, so the next request loads the version again', async () => {
    await storeVersion(1);

    await database.db.query(sql("UPDATE ontology_registry.product_versions SET ir = '{}'::jsonb WHERE version = 1"));

    const open = await newOpen();

    await expect(open(database.db)).rejects.toThrow();

    await database.db.query(
      sql(
        'UPDATE ontology_registry.product_versions SET ir = $1::jsonb WHERE version = 1',
        JSON.stringify(irNaming(Object.keys(firstOntology.metadata.objectTypes))),
      ),
    );

    const { ontology } = await open(database.db);

    expect(ontology.version).toBe(1);
    expect(versionOf(ontology.metadata)).toBe('Version 1');
  });
});

describe('the Functions of a version', () => {
  it('ontology/functions/functions#discovery: a product version gives the Function bundle that its publish stored', async () => {
    const functions = (bundle: string): PublishedFunctions => ({ discovered: [], bundle });

    await storeVersion(1, metadataOf(1), functions('export const functions = { v: 1 };'));

    await storeVersion(2, metadataOf(2), functions('export const functions = { v: 2 };'));

    const open = await newOpen();

    const one = (await open(database.db)).ontology;

    await moveTo(2);

    const two = (await open(database.db)).ontology;

    expect([one.version, one.functionBundle]).toEqual([1, 'export const functions = { v: 1 };']);
    expect([two.version, two.functionBundle]).toEqual([2, 'export const functions = { v: 2 };']);
    expect(versionOf(one.metadata)).toBe('Version 1');
  });
});

describe('requests', () => {
  interface Read {
    readonly log: Record<string, unknown>;
    readonly body: OntologyFullMetadata;
  }

  async function sendRead(handle: Handle, db: Db): Promise<Read> {
    const httpRequest = new Request(`http://localhost/api/v2/ontologies/${TEST_ONTOLOGY_RID}/fullMetadata`, {
      headers: { authorization: `Bearer ${await issuer.workos()}` },
    });

    consoleLog.mockClear();

    const response = await handle(httpRequest, {
      db: fallibleOf(db),
      directDb: fallibleOf(database.db),
      settings: testSettings,
      keys: issuer.keys,
      users: roleUsers({ member: [USE] }),
      workos: stubPublish(),
    });

    const lines = consoleLog.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{'));

    return {
      log: JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>,
      body: (await response.json()) as Read['body'],
    };
  }

  function publishAfterVersionsRead(db: Db, publishNow: () => Promise<void>): { db: Db; published: () => boolean } {
    let done = false;

    const after = async (text: string) => {
      if (done || !text.includes('ontology_registry.ontologies WHERE rid')) return;

      done = true;

      await publishNow();
    };

    const watch = (inner: Db): Db => ({
      query: async <Row extends object>(statement: Sql) => {
        const rows = await inner.query<Row>(statement);

        await after(statement.text);

        return rows;
      },
      stream: <Row extends object>(statement: Sql) =>
        (async function* () {
          yield* inner.stream<Row>(statement);

          await after(statement.text);
        })(),
      transaction: (run) => inner.transaction((tx) => run(watch(tx))),
      snapshot: (run) => inner.snapshot((tx) => run(asSnapshot(watch(tx)))),
    });

    return { db: watch(db), published: () => done };
  }

  it('service/observability#logs: the request log names the Ontology version that served the request', async () => {
    const handle = await newHandle();

    await storeVersion(1);

    expect((await sendRead(handle, database.db)).log).toMatchObject({ ontologyVersion: 1 });

    await storeVersion(2);

    await moveTo(2);

    expect((await sendRead(handle, database.db)).log).toMatchObject({ ontologyVersion: 2 });
  });

  it('service/publish#applying: a request uses the version that was current when it started, also when a publish commits during the request', async () => {
    await storeVersion(1);

    const during = publishAfterVersionsRead(database.db, async () => {
      await database.db.transaction(async (tx) => {
        await storeVersion(2, metadataOf(2), undefined, tx);

        await moveTo(2, tx);
      });
    });

    const handle = await newHandle();

    const first = await sendRead(handle, during.db);

    expect(during.published()).toBe(true);
    expect(first.log).toMatchObject({ ontologyVersion: 1 });
    expect(versionOf(first.body)).toBe('Version 1');

    const next = await sendRead(handle, database.db);

    expect(next.log).toMatchObject({ ontologyVersion: 2 });
    expect(versionOf(next.body)).toBe('Version 2');
  });
});
