import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { OntologyIr } from '@osdk/client.unstable';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { Handle, HandleInput, Settings } from '../handler/index.ts';
import {
  convertOrThrow,
  grantsOf,
  irOf,
  NS,
  ONTOLOGY_RID,
  stringProperty,
  twinObjectType,
} from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { testSettings } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { newDatabase, OSDK_SET, sql, type TestDatabase, modeOf, expectAllOnNewest } from './publish.test-utils.ts';
import { STUB_WORKOS_KEY, stubPublish, stubWorkos } from '../workos.test-utils.ts';
import { workosPublish } from '../auth/index.ts';
import { ApiError } from '../errors/index.ts';
import type { JsonValue } from '../ontology/index.ts';

const ACCOUNT = `${NS}Account`;
const ACCOUNT_IR = irOf(twinObjectType('Account'));
const SECOND_RID = 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111';
const OTHER_PRODUCT_RID = 'ri.ontology.main.ontology.22222222-2222-4222-8222-222222222222';
const base = 'http://localhost';

const settings: Settings = { ...testSettings, productRid: ONTOLOGY_RID };
let port = stubPublish();

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;
let handle: Handle;

beforeAll(async () => {
  await import('../handler/index.ts');

  await import('../ontology/compile.ts');

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

  vi.resetModules();

  handle = (await import('../handler/index.ts')).handle;
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  consoleLog.mockRestore();

  await endPooled();

  await database.end();
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const USERS = roleUsers(grantsOf(irOf()).defaultRoles);

async function send(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
  with_: Partial<Settings> = {},
): Promise<Answer> {
  const input: HandleInput = {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: { ...settings, ...with_ },
    keys: issuer.keys,
    users: USERS,
    workos: port,
  };

  const request = new Request(base + path, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const response = await handle(request, input);

  const text = await response.text();

  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

function publishBody(ir: OntologyIr, extra: Record<string, unknown> = {}) {
  return {
    product: 'twin',
    ir,
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: grantsOf(ir),
    validateOnly: false,
    ...extra,
  };
}

async function publish(
  ir: OntologyIr,
  extra: Record<string, unknown> = {},
  with_: Partial<Settings> = {},
): Promise<Answer> {
  const body = publishBody(ir, extra);

  const answer = await send('POST', '/api/ontology-service/v1/publish', await issuer.github(), body, with_);

  if (answer.status === 200 && body.product === 'twin') await installOnce(database.db, ONTOLOGY_RID, 'twin');

  return answer;
}

async function publishOther(ir: OntologyIr, extra: Record<string, unknown> = {}): Promise<Answer> {
  const { publishOntology, readNewestVersion, readRequest } = await import('./publish.test-utils.ts');

  const request = readRequest(JSON.parse(JSON.stringify(publishBody(ir, { product: 'other', ...extra }))) as JsonValue);

  const before = (await readNewestVersion(database.db, 'other'))?.version ?? 0;

  try {
    const ontology = convertOrThrow(request, OTHER_PRODUCT_RID, before + 1);

    const answer = await publishOntology(database.db, {
      product: 'other',
      productRid: OTHER_PRODUCT_RID,
      ontology,
      request,
      publisher: 'test',
      mode: modeOf(request.validateOnly),
    });

    return { status: 200, body: { ...answer } };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    return { status: error.status, body: { errorName: error.errorName, parameters: error.parameters } };
  }
}

async function install(rid: string, apiName: string, product = 'twin', displayName = apiName): Promise<void> {
  const { installOntology } = await import('../install.test-utils.ts');

  await installOntology(database.db, { rid, product, apiName, displayName, organization: ORGANIZATION });
}

async function read(rid: string, path: string): Promise<Answer> {
  return send('GET', `/api/v2/ontologies/${rid}${path}`, await issuer.workos());
}

async function loadAccounts(rid: string): Promise<Answer> {
  return send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects`, await issuer.workos(), {
    objectSet: { type: 'base', objectType: ACCOUNT },
    select: ['accountId', 'name'],
  });
}

async function names(query: string, ...values: unknown[]): Promise<string[]> {
  const rows = await database.db.query<{ name: string }>(sql(query, ...values));

  return rows.map((row) => row.name);
}

const schemaNames = () =>
  names("SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'ontology%' ORDER BY nspname");

const tableNames = (schema: string) =>
  names('SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', schema);

function withRegion(): OntologyIr {
  const block = twinObjectType('Account');

  block.objectType.propertyTypes['region'] = {
    ...stringProperty('region'),
    status: { type: 'experimental', experimental: {} },
  };

  return irOf(block);
}

describe('the shared schema and the registry', () => {
  it('service/storage#schema-and-access service/storage#table-changes: the cold start makes ontology_registry with the registry, the product versions, and the applied engine changes, and no schema ontology or ontology_service', async () => {
    expect((await read(SECOND_RID, '/fullMetadata')).status).toBe(404);

    expect(await schemaNames()).toEqual(['ontology_registry']);

    expect(await tableNames('ontology_registry')).toEqual(['engine_changes', 'ontologies', 'product_versions']);
  });

  it('service/storage#schema-and-access: the registry row holds the number, the RID, the API name, the display name, the 2 schema names, the product, the version, the owner, and the engine-change count', async () => {
    expect((await publish(ACCOUNT_IR)).status).toBe(200);

    await install(SECOND_RID, 'second');

    const rows = await database.db.query(
      sql(
        'SELECT number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count FROM ontology_registry.ontologies ORDER BY number',
      ),
    );

    expect(rows).toEqual([
      {
        number: 1,
        rid: ONTOLOGY_RID,
        api_name: 'twin',
        display_name: 'twin',
        object_schema: 'ontology_1_objects',
        engine_schema: 'ontology_1_engine',
        product: 'twin',
        version: 1,
        organization: 'org_01TEST0RG00000000000000001',
        engine_change_count: 3,
      },
      {
        number: 2,
        rid: SECOND_RID,
        api_name: 'second',
        display_name: 'second',
        object_schema: 'ontology_2_objects',
        engine_schema: 'ontology_2_engine',
        product: 'twin',
        version: 1,
        organization: 'org_01TEST0RG00000000000000001',
        engine_change_count: 3,
      },
    ]);
  });

  it('each product version is 1 row: the product, the version, the IR, the metadata, the schema migrations, the OSDK set, the Functions, the publisher, and the time', async () => {
    await publish(ACCOUNT_IR);

    await publish(withRegion());

    const rows = await database.db.query<Record<string, unknown>>(
      sql(
        "SELECT product, version, ir = $1::jsonb AS same_ir, metadata -> 'ontology' ->> 'rid' AS rid, schema_migrations, osdk_set = $2::jsonb AS same_set, functions, publisher, published_at IS NOT NULL AS has_time FROM ontology_registry.product_versions ORDER BY version",
        JSON.stringify(ACCOUNT_IR),
        JSON.stringify(OSDK_SET),
      ),
    );

    expect(rows).toEqual([
      {
        product: 'twin',
        version: 1,
        same_ir: true,
        rid: ONTOLOGY_RID,
        schema_migrations: { migrations: [] },
        same_set: true,
        functions: null,
        publisher: 'repo:example/test-app:environment:publish-staging',
        has_time: true,
      },
      {
        product: 'twin',
        version: 2,
        same_ir: false,
        rid: ONTOLOGY_RID,
        schema_migrations: { migrations: [] },
        same_set: true,
        functions: null,
        publisher: 'repo:example/test-app:environment:publish-staging',
        has_time: true,
      },
    ]);
  });
});

describe('install', () => {
  it('service/storage#schema-and-access service/storage#names service/storage#object-edit-history: install makes the Object schema with the Object Type tables and the engine schema with edit_history', async () => {
    await publish(ACCOUNT_IR);

    await install(SECOND_RID, 'second');

    expect(await schemaNames()).toEqual([
      'ontology_1_engine',
      'ontology_1_objects',
      'ontology_2_engine',
      'ontology_2_objects',
      'ontology_registry',
    ]);

    expect(await tableNames('ontology_2_objects')).toEqual(['account']);

    expect(await tableNames('ontology_2_engine')).toEqual(['edit_history']);

    const columns = await names(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'ontology_2_engine' AND table_name = 'edit_history' ORDER BY ordinal_position",
    );

    expect(columns).toEqual(['object_type', 'primary_key', 'entry', 'created_at']);
  });

  it('service/storage#registry: install makes the 2 schemas, their tables, and the registry row in 1 transaction, so a failed install leaves none of them', async () => {
    await publish(ACCOUNT_IR);

    await database.db.query(sql('CREATE SCHEMA ontology_2_engine'));

    await expect(install(SECOND_RID, 'second')).rejects.toThrow('schema "ontology_2_engine" already exists');

    expect(await schemaNames()).toEqual([
      'ontology_1_engine',
      'ontology_1_objects',
      'ontology_2_engine',
      'ontology_registry',
    ]);

    expect(await names('SELECT rid AS name FROM ontology_registry.ontologies ORDER BY number')).toEqual([ONTOLOGY_RID]);
  });

  it('install of a product with no version gets 404 OntologyService:ProductNotFound', async () => {
    await publish(ACCOUNT_IR);

    await expect(install(SECOND_RID, 'second', 'other')).rejects.toMatchObject({
      status: 404,
      errorName: 'OntologyService:ProductNotFound',
      parameters: { product: 'other' },
    });
  });
});

describe('the request path', () => {
  it('service/storage#registry: each request reads the schemas of its Ontology from the registry, so 2 Ontologies in 1 database read only their own rows', async () => {
    await publish(ACCOUNT_IR);

    await install(SECOND_RID, 'second');

    await database.db.query(sql("INSERT INTO ontology_1_objects.account (account_id, name) VALUES ('acc-1', 'Acme')"));

    await database.db.query(
      sql("INSERT INTO ontology_2_objects.account (account_id, name) VALUES ('acc-2', 'Globex')"),
    );

    const first = await loadAccounts(ONTOLOGY_RID);

    const second = await loadAccounts(SECOND_RID);

    expect([first.status, (first.body['data'] as { name: string }[]).map((o) => o.name)]).toEqual([200, ['Acme']]);
    expect([second.status, (second.body['data'] as { name: string }[]).map((o) => o.name)]).toEqual([200, ['Globex']]);
  });

  it('an RID that no registry row has gets 404 OntologyNotFound', async () => {
    await publish(ACCOUNT_IR);

    const answer = await read(SECOND_RID, '/objectTypes');

    expect([answer.status, answer.body['errorName'], answer.body['parameters']]).toEqual([
      404,
      'OntologyNotFound',
      { ontologyRid: SECOND_RID },
    ]);
  });

  it('service/http-api#rids service/publish#versions: 2 Ontologies of 1 product have the same derived RIDs, from the product RID, and each serves its own Ontology RID', async () => {
    await publish(ACCOUNT_IR);

    await install(SECOND_RID, 'second');

    const first = (await read(ONTOLOGY_RID, '/fullMetadata')).body;

    const second = (await read(SECOND_RID, '/fullMetadata')).body;

    expect(first['ontology']).toEqual({ apiName: 'twin', displayName: 'twin', description: '', rid: ONTOLOGY_RID });
    expect(second['ontology']).toEqual({ apiName: 'second', displayName: 'second', description: '', rid: SECOND_RID });
    expect({ ...second, ontology: undefined }).toEqual({ ...first, ontology: undefined });

    const objectType = (await read(SECOND_RID, `/objectTypes/${ACCOUNT}`)).body;

    expect(objectType['rid']).toBe('ri.ontology.main.object-type.0a27acfd-4041-57d9-9e98-8de722bf00fd');

    await database.db.query(sql("INSERT INTO ontology_2_objects.account (account_id, name) VALUES ('acc-1', 'Acme')"));

    const object = (await loadAccounts(SECOND_RID)).body['data'] as { __rid: string }[];

    expect(object.map((o) => o.__rid)).toEqual([
      'ri.phonograph2-objects.main.object.8d7bec66-1177-57d5-8311-9617d1f43aa2',
    ]);
  });

  it('service/http-api#metadata-routes: the ontology block of fullMetadata equals the List Ontologies entry of that Ontology, for each of 2 Ontologies of 1 product', async () => {
    await publish(ACCOUNT_IR);

    await install(SECOND_RID, 'second', 'twin', 'Second Ontology');

    const listed = (await send('GET', '/api/v2/ontologies', await issuer.workos())).body['data'] as { rid: string }[];

    expect(listed.map((entry) => entry.rid)).toEqual([SECOND_RID, ONTOLOGY_RID]);

    for (const entry of listed) expect((await read(entry.rid, '/fullMetadata')).body['ontology']).toEqual(entry);

    expect(listed).toContainEqual({
      rid: SECOND_RID,
      apiName: 'second',
      displayName: 'Second Ontology',
      description: '',
    });
  });

  it('service/code-layout#seams: 2 Ontologies of 1 product version share 1 compile', async () => {
    await publish(ACCOUNT_IR);

    await install(SECOND_RID, 'second');

    vi.resetModules();

    const spy = vi.spyOn(await import('../ontology/compile.ts'), 'compileOntology');

    handle = (await import('../handler/index.ts')).handle;

    expect((await read(ONTOLOGY_RID, '/objectTypes')).status).toBe(200);

    expect((await read(SECOND_RID, '/objectTypes')).status).toBe(200);

    expect((await read(ONTOLOGY_RID, '/objectTypes')).status).toBe(200);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the cold start checks the product version of each Ontology, and when 1 fails, each request gets 503', async () => {
    await publish(ACCOUNT_IR);

    await publishOther(ACCOUNT_IR);

    await install(SECOND_RID, 'second', 'other');

    vi.resetModules();

    handle = (await import('../handler/index.ts')).handle;

    expect([
      (await read(ONTOLOGY_RID, '/objectTypes')).status,
      (await read(SECOND_RID, '/objectTypes')).status,
    ]).toEqual([200, 200]);

    await database.db.query(
      sql(
        `UPDATE ontology_registry.product_versions SET osdk_set = '{"@osdk/client": "0.0.1"}'::jsonb WHERE product = 'other'`,
      ),
    );

    vi.resetModules();

    handle = (await import('../handler/index.ts')).handle;

    const listed = await read(ONTOLOGY_RID, '/objectTypes');

    const ontologies = await send('GET', '/api/v2/ontologies', await issuer.workos());

    expect([listed.status, listed.body['errorName'], ontologies.status]).toEqual([
      503,
      'OntologyService:OntologyVersionNotSupported',
      503,
    ]);
  });
});

describe('publish of a product', () => {
  it('service/publish#what-the-app-publishes: a request with no product gets 400 that names the part', async () => {
    const answer = await publish(ACCOUNT_IR, { product: undefined });

    expect([answer.status, answer.body['errorName'], answer.body['parameters']]).toEqual([
      400,
      'Default:InvalidArgument',
      { part: 'product' },
    ]);
  });

  it('service/publish#what-the-app-publishes: through the route, a publish of another product gets 400 with part product before the grants check and the read of the grants field, and WorkOS gets no call', async () => {
    await publish(ACCOUNT_IR);

    const stub = stubWorkos();

    port = workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch });

    try {
      const bad = {
        ...grantsOf(ACCOUNT_IR),
        permissions: { 'ontology:x': { description: 'A product permission with the prefix of the service' } },
      };

      const v2 = { roles: ['admin'], objectTypes: {}, actionTypes: {} };

      for (const [grants, validateOnly] of [
        [bad, true],
        [bad, false],
        [v2, false],
      ] as const) {
        const answer = await publish(ACCOUNT_IR, { product: 'other', grants, validateOnly });

        expect([answer.status, answer.body['errorName'], answer.body['parameters']]).toEqual([
          400,
          'Default:InvalidArgument',
          { part: 'product' },
        ]);
      }

      expect([
        stub.requests,
        await names('SELECT DISTINCT product AS name FROM ontology_registry.product_versions'),
      ]).toEqual([[], ['twin']]);
    } finally {
      port = stubPublish();
    }
  });

  it('service/publish#what-the-app-publishes: the product RID of each version is PRODUCT_RID, and a publish with another product RID gets 400', async () => {
    await publish(ACCOUNT_IR);

    const answer = await publish(withRegion(), {}, { productRid: OTHER_PRODUCT_RID });

    expect([answer.status, answer.body['errorName'], answer.body['parameters']]).toEqual([
      400,
      'Default:InvalidArgument',
      { product: 'twin', productRid: OTHER_PRODUCT_RID, storedProductRid: ONTOLOGY_RID },
    ]);

    expect(
      await names("SELECT metadata -> 'ontology' ->> 'rid' AS name FROM ontology_registry.product_versions"),
    ).toEqual([ONTOLOGY_RID]);
  });

  it('service/publish#versions service/publish#route: each product numbers its own versions, and the same parts make no new version', async () => {
    const first = await publish(ACCOUNT_IR);

    const same = await publish(ACCOUNT_IR);

    const next = await publish(withRegion());

    const other = await publishOther(ACCOUNT_IR);

    expect([first.body['version'], same.body['version'], next.body['version'], other.body['version']]).toEqual([
      1, 1, 2, 1,
    ]);

    expect(next.body['changes']).toEqual([{ description: `Create Property region of Object Type ${ACCOUNT}` }]);

    expect((next.body['metadata'] as { ontology: unknown }).ontology).toEqual({
      apiName: 'ontology',
      displayName: 'Ontology',
      description: '',
      rid: ONTOLOGY_RID,
    });
  });

  it('service/publish#versions service/publish#rollback: a deleted API name stays reserved for its product only', async () => {
    await publish(withRegion());

    await publish(ACCOUNT_IR, {
      schemaMigrations: { migrations: [{ type: 'dropProperty', objectType: ACCOUNT, property: 'region' }] },
    });

    const rollback = await publish(withRegion());

    expect([rollback.status, rollback.body['parameters']]).toEqual([
      400,
      { change: `Create Property region of Object Type ${ACCOUNT}`, reservedApiName: 'region', deletedInVersion: 2 },
    ]);

    const other = await publishOther(withRegion());

    expect([other.status, other.body['version']]).toEqual([200, 1]);
  });

  it('through the route, a publish stores the version and moves each Ontology of the product', async () => {
    await publish(ACCOUNT_IR);

    await install(SECOND_RID, 'second');

    const stored = await send(
      'POST',
      '/api/ontology-service/v1/publish',
      await issuer.github(),
      publishBody(withRegion()),
    );

    expect([stored.status, stored.body['version']]).toEqual([200, 2]);

    expect(
      await names("SELECT rid || ' ' || version AS name FROM ontology_registry.ontologies ORDER BY number"),
    ).toEqual([`${ONTOLOGY_RID} 2`, `${SECOND_RID} 2`]);

    expect(
      await names(
        "SELECT table_schema AS name FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'region' ORDER BY table_schema",
      ),
    ).toEqual(['ontology_1_objects', 'ontology_2_objects']);
  });

  it('when the plan of 1 Ontology fails, nothing commits, and the error names that Ontology and the change', async () => {
    await publish(withRegion());

    await install(SECOND_RID, 'second');

    await database.db.query(
      sql("INSERT INTO ontology_2_objects.account (account_id, name, region) VALUES ('acc-1', 'Acme', 'west')"),
    );

    const answer = await publish(ACCOUNT_IR);

    expect([answer.status, answer.body['errorName'], answer.body['parameters']]).toEqual([
      400,
      'Default:InvalidArgument',
      {
        change: `Delete Property region of Object Type ${ACCOUNT}`,
        schemaMigrations: ['dropProperty'],
        ontologyRid: SECOND_RID,
      },
    ]);

    expect(
      await names("SELECT rid || ' ' || version AS name FROM ontology_registry.ontologies ORDER BY number"),
    ).toEqual([`${ONTOLOGY_RID} 1`, `${SECOND_RID} 1`]);

    expect(await names('SELECT version::text AS name FROM ontology_registry.product_versions')).toEqual(['1']);
  });
});
