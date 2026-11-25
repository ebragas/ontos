import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool, ontologyEngineChanges } from '../db/index.ts';
import { applyEngineChanges, createDb, type Db, fallibleOf, rejecting } from '../db/promise.test-utils.ts';
import { grantsOf, USE } from '../ontology/stored.test-utils.ts';
import { ApiError } from '../errors/index.ts';
import type { Handle, HandleInput } from '../handler/index.ts';
import type { CompiledOntology } from '../ontology/index.ts';
import type { OsdkSet } from './index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { testSettings, MEMBER, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import {
  FIRST_IR,
  INTERFACE_IR,
  LATER_SET,
  LISTED_SET,
  publishFirst,
  recording,
  rejection,
  storedVersions,
  storeVersion,
  workOrderTableExists,
} from './releasesSupport.test-utils.ts';
import { firstOntology, IR, newDatabase, OSDK_SETS_FILE, sql, type TestDatabase } from './publish.test-utils.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

const NOT_SUPPORTED = { status: 503, errorName: 'OntologyService:OntologyVersionNotSupported' };

const NOT_SUPPORTED_BODY = {
  errorCode: 'INTERNAL',
  errorName: 'OntologyService:OntologyVersionNotSupported',
  errorInstanceId: expect.any(String),
  parameters: {},
};

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  await import('../ontology/index.ts');

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

  consoleError = vi.spyOn(console, 'error');
});

afterEach(async () => {
  consoleLog.mockRestore();

  consoleError.mockRestore();

  await endPooled();

  await database.end();
});

async function loadCurrent(db: Db = database.db): Promise<CompiledOntology> {
  vi.resetModules();

  const { openOntology } = await import('../ontology/index.ts');

  return (await rejecting(openOntology(fallibleOf(db), TEST_ONTOLOGY_RID, { ...MEMBER, permissions: [USE] }))).ontology;
}

async function newInstance(): Promise<Handle> {
  vi.resetModules();

  return (await import('../handler/index.ts')).handle;
}

function input(): HandleInput {
  return {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: testSettings,
    keys: issuer.keys,
    users: roleUsers({ member: [USE] }),
    workos: stubPublish(),
  };
}

async function fullMetadata(handle: Handle, rid = TEST_ONTOLOGY_RID): Promise<Response> {
  const url = `http://localhost/api/v2/ontologies/${rid}/fullMetadata`;

  return buffered(handle(new Request(url, { headers: { authorization: `Bearer ${await issuer.workos()}` } }), input()));
}

async function sendPublish(handle: Handle, osdkSet: OsdkSet): Promise<Response> {
  const request = new Request('http://localhost/api/ontology-service/v1/publish', {
    method: 'POST',
    headers: { authorization: `Bearer ${await issuer.github()}` },
    body: JSON.stringify({
      ir: IR,
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet,
      grants: grantsOf(IR),
      validateOnly: true,
    }),
  });

  return buffered(handle(request, input()));
}

describe('the cold-start check', () => {
  it('an environment with no product version and no Ontology passes the cold-start check, and answers client-config', async () => {
    const handle = await newInstance();

    const response = await buffered(
      handle(new Request('http://localhost/api/ontology-service/v1/client-config'), input()),
    );

    expect(response.status).toBe(200);
  });

  it('a current version with a listed set and an IR that compiles passes', async () => {
    await publishFirst(database.db, false);

    expect((await loadCurrent()).version).toBe(1);
  });

  it('the check reads the current version, the last one', async () => {
    await storeVersion(database.db, 1, LATER_SET);

    await storeVersion(database.db, 2, LISTED_SET);

    expect((await loadCurrent()).version).toBe(2);
  });

  it('a stored IR that the release does not support fails the check with 503', async () => {
    await storeVersion(database.db, 1, LISTED_SET, INTERFACE_IR);

    const error = await rejection(loadCurrent());

    expect((error as object).constructor.name).toBe(ApiError.name);
    expect(error).toMatchObject(NOT_SUPPORTED);
  });

  it('service/releases#osdk-sets: a stored set of the 5 packages passes, because the check does not compare platformPackages', async () => {
    expect(OSDK_SETS_FILE[0]?.platformPackages).toHaveProperty(['@osdk/foundry.ontologies']);

    expect(Object.keys(LISTED_SET)).toEqual([
      '@osdk/maker',
      '@osdk/maker-experimental',
      '@osdk/client',
      '@osdk/cli',
      '@osdk/functions',
    ]);

    await storeVersion(database.db, 1, LISTED_SET);

    expect((await loadCurrent()).version).toBe(1);
  });

  it('service/releases#osdk-sets: a current version whose OSDK set the release does not list fails the cold-start check with 503', async () => {
    await storeVersion(database.db, 1, LATER_SET);

    const error = await rejection(loadCurrent());

    expect((error as object).constructor.name).toBe(ApiError.name);
    expect(error).toMatchObject(NOT_SUPPORTED);
  });
});

describe('the requests of an instance', () => {
  it('service/releases#osdk-sets: when the release does not list the set of the current version, each request gets 503', async () => {
    await storeVersion(database.db, 1, LATER_SET);

    const handle = await newInstance();

    const first = await fullMetadata(handle);

    expect(first.status).toBe(503);

    expect(await first.json()).toEqual(NOT_SUPPORTED_BODY);

    expect((await fullMetadata(handle)).status).toBe(503);

    expect((await sendPublish(handle, LISTED_SET)).status).toBe(503);
  });

  it('when the stored IR does not compile, each request gets 503', async () => {
    await storeVersion(database.db, 1, LISTED_SET, INTERFACE_IR);

    const handle = await newInstance();

    const first = await fullMetadata(handle);

    expect(first.status).toBe(503);

    expect(await first.json()).toEqual(NOT_SUPPORTED_BODY);

    expect((await sendPublish(handle, LISTED_SET)).status).toBe(503);
  });
});

describe('compatibility with earlier releases', () => {
  it('service/releases#compatibility-with-earlier-releases: this release reads and writes the tables after the engine changes of a later release', async () => {
    await database.db.query(sql('ALTER TABLE ontology_registry.product_versions ADD COLUMN later_field text'));

    await database.db.query(sql('CREATE TABLE ontology_registry.later_table (id text PRIMARY KEY)'));

    await database.db.query(sql("INSERT INTO ontology_registry.engine_changes (id) VALUES ('9999-later-release')"));

    await applyEngineChanges(database.db);

    expect(await publishFirst(database.db, false)).toMatchObject({ version: 1 });

    expect((await loadCurrent()).version).toBe(1);
  });

  it('service/releases#compatibility-with-earlier-releases: a rollback to a release that does not list the current set fails the check, and undoes no publish', async () => {
    await publishFirst(database.db, false);

    await storeVersion(database.db, 2, LATER_SET);

    const before = await storedVersions(database.db);

    expect(await rejection(loadCurrent())).toMatchObject(NOT_SUPPORTED);

    expect(await storedVersions(database.db)).toEqual(before);

    expect(before.map((row) => row.version)).toEqual([1, 2]);

    expect(await workOrderTableExists(database.db)).toBe(true);
  });

  it('service/releases#compatibility-with-earlier-releases: a rollback to a release that does not support a concept of the current IR fails the check, and undoes no publish', async () => {
    await publishFirst(database.db, false);

    await storeVersion(database.db, 2, LISTED_SET, INTERFACE_IR);

    const before = await storedVersions(database.db);

    expect(await rejection(loadCurrent())).toMatchObject(NOT_SUPPORTED);

    expect(await storedVersions(database.db)).toEqual(before);

    expect(await workOrderTableExists(database.db)).toBe(true);
  });

  it('service/releases#compatibility-with-earlier-releases: a cold start of a release serves the stored Ontology metadata, and changes nothing that is stored', async () => {
    await publishFirst(database.db, false, LISTED_SET, FIRST_IR);

    const before = await storedVersions(database.db);

    const statements: string[] = [];
    const db = recording(database.db, statements);

    await applyEngineChanges(db);

    const served = await loadCurrent(db);

    expect(served.version).toBe(1);

    const named = (metadata: unknown) => ({
      ...(metadata as object),
      ontology: { rid: TEST_ONTOLOGY_RID, apiName: 'test', displayName: 'test', description: '' },
    });

    expect(served.metadata).toEqual(named(JSON.parse(before[0]?.metadata ?? 'null')));
    expect(served.metadata).toEqual(named(firstOntology.metadata));

    expect(await storedVersions(database.db)).toEqual(before);

    const writes = statements.filter((text) => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(text));

    expect(writes).toEqual([]);
  });
});

const SECOND_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000002';
const ENGINE_CHANGE_COUNT = ontologyEngineChanges({ object: '', engine: '' }).length;

async function installSecond(version: number): Promise<void> {
  await database.db.query(
    sql(
      `INSERT INTO ontology_registry.ontologies (rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
       VALUES ($1, 'second', 'second', 'ontology_2_objects', 'ontology_2_engine', 'test', $2, $3, $4)`,
      SECOND_RID,
      version,
      ORGANIZATION,
      ENGINE_CHANGE_COUNT,
    ),
  );
}

describe('the cold-start check of the newest version of each installed product', () => {
  it('service/releases#compatibility-with-earlier-releases: with each installation on the newest version, whose set the release lists, the check passes and each installation serves', async () => {
    await storeVersion(database.db, 1, LATER_SET);

    await storeVersion(database.db, 2, LISTED_SET);

    await installSecond(2);

    const handle = await newInstance();

    for (const rid of [TEST_ONTOLOGY_RID, SECOND_RID]) {
      const served = await fullMetadata(handle, rid);

      expect([served.status, ((await served.json()) as { ontology: { rid: string } }).ontology.rid]).toEqual([
        200,
        rid,
      ]);
    }
  });

  it('service/releases#compatibility-with-earlier-releases: with each installation on the newest version, whose OSDK set the release does not list, each request gets 503', async () => {
    await storeVersion(database.db, 1, LISTED_SET);

    await storeVersion(database.db, 2, LATER_SET);

    await installSecond(2);

    const handle = await newInstance();

    for (const rid of [SECOND_RID, TEST_ONTOLOGY_RID]) {
      const refused = await fullMetadata(handle, rid);

      expect([refused.status, await refused.json()]).toEqual([503, NOT_SUPPORTED_BODY]);
    }
  });

  it('service/releases#compatibility-with-earlier-releases: the check compiles the newest version, not the version of a row, so a fault row on a listed version below an unlisted newest version still gives 503', async () => {
    await storeVersion(database.db, 1, LISTED_SET);

    await storeVersion(database.db, 2, LATER_SET);

    await database.db.query(
      sql('UPDATE ontology_registry.ontologies SET version = 1 WHERE rid = $1', TEST_ONTOLOGY_RID),
    );

    const handle = await newInstance();

    const refused = await fullMetadata(handle);

    expect([refused.status, await refused.json()]).toEqual([503, NOT_SUPPORTED_BODY]);
  });

  it('service/publish#upgrade service/storage#registry: the cold-start check reads a row with held = true as each other row, so the only row, held on listed v1 under unlisted v2, gives 503', async () => {
    await storeVersion(database.db, 1, LISTED_SET);

    await database.db.query(
      sql('UPDATE ontology_registry.ontologies SET held = true WHERE rid = $1', TEST_ONTOLOGY_RID),
    );

    const served = await fullMetadata(await newInstance());

    expect(served.status).toBe(200);

    await storeVersion(database.db, 2, LATER_SET);

    await database.db.query(
      sql('UPDATE ontology_registry.ontologies SET version = 1 WHERE rid = $1', TEST_ONTOLOGY_RID),
    );

    expect(await database.db.query(sql('SELECT version, held FROM ontology_registry.ontologies'))).toEqual([
      { version: 1, held: true },
    ]);

    const refused = await fullMetadata(await newInstance());

    expect([refused.status, await refused.json()]).toEqual([503, NOT_SUPPORTED_BODY]);
  });
});
