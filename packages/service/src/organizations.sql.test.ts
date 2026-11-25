import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from './db/index.ts';
import { createDb, type Db, fallibleOf, rejecting } from './db/promise.test-utils.ts';
import { routes, type OrganizationCaller, type Settings } from './handler/index.ts';
import { type UserSource } from './auth/index.ts';
import { UserId } from './auth/caller.ts';
import { openOntology } from './ontology/index.ts';
import { ONTOLOGY_RID, twinGrants } from './ontology/stored.test-utils.ts';
import { personOf } from './people.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from './postgres.test-utils.ts';
import { SCHEMAS, testSettings } from './service.test-utils.ts';
import {
  createTestIssuer,
  now,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PERSON,
  type Claims,
  type TestIssuer,
} from './tokens.test-utils.ts';
import { publishTwin } from '../twin/seed/seed.test-utils.ts';
import { newDatabase, onNewConnection, type TestDatabase, expectAllOnNewest } from './publish/publish.test-utils.ts';
import { STUB_PERSON, stubPublish, stubUsers, type StubMembership } from './workos.test-utils.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';

const INSTALL = '/api/ontology-service/v1/ontologies';
const LIST = '/api/v2/ontologies';
const RID_V4 = /^ri\.ontology\.main\.ontology\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const settings: Settings = { ...testSettings, productRid: ONTOLOGY_RID };

const MIXED = 'user_01HM1XED00000000000000000MX';
const ADMIN = { sub: personOf('admin') };
const MEMBER = { sub: PERSON };

function organizationUsers(): UserSource {
  const roles = twinGrants('0.7.0').defaultRoles;

  const users = [
    STUB_PERSON,
    { ...STUB_PERSON, id: personOf('admin'), email: 'admin@example.com' },
    { ...STUB_PERSON, id: MIXED, email: 'mixed@example.com' },
  ];

  const membership = (user: string, organization: string, role: string): StubMembership => ({
    user_id: user,
    organization_id: organization,
    status: 'active',
    organization_name: organization,
    roles: [role],
  });

  const memberships = [ORGANIZATION, OTHER_ORGANIZATION].flatMap((organization) => [
    membership(PERSON, organization, 'member'),
    membership(personOf('admin'), organization, 'admin'),
  ]);

  return stubUsers(
    users,
    [...memberships, membership(MIXED, ORGANIZATION, 'admin'), membership(MIXED, OTHER_ORGANIZATION, 'member')],
    { roles: { [ORGANIZATION]: roles, [OTHER_ORGANIZATION]: roles } },
  );
}

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let server: Server;
let baseUrl: string;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;

let serviceRole: { readonly name: string; readonly password: string };
let template: string;

beforeAll(async () => {
  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);

  serviceRole = { name: `${new URL(postgres.url).username}_service`, password: 'service-role-test-only' };

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${serviceRole.name} LOGIN PASSWORD '${serviceRole.password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, serviceRole, { icu: true });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url, { template });

  const name = new URL(database.url).pathname.slice(1);

  await database.db.query({ text: `GRANT CREATE ON DATABASE ${name} TO ${serviceRole.name}`, values: [] });

  const url = new URL(database.url);

  url.username = serviceRole.name;
  url.password = serviceRole.password;

  const pool = createPool(url.toString());

  pooledDb = createDb(pool);

  endPooled = () => pool.end();

  consoleLog = vi.spyOn(console, 'log');

  vi.resetModules();

  const { createNodeServer } = await import('./node.ts');

  server = createNodeServer({
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(pooledDb),
    settings,
    keys: issuer.keys,
    users: organizationUsers(),
    workos: stubPublish(),
  });

  baseUrl = await listenLocal(server);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await closeServer(server);

  consoleLog.mockRestore();

  await endPooled();

  await database.end();
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function send(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();

  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

function person(claims: Claims = {}): Promise<string> {
  return issuer.workos(claims);
}

function publish(): Promise<void> {
  return publishTwin({ baseUrl, publishToken: () => issuer.github({ exp: now() + 3600 }) }, '0.7.0');
}

async function install(apiName: string, claims: Claims = {}, product = 'twin'): Promise<Answer> {
  return send('POST', INSTALL, await person({ ...ADMIN, ...claims }), {
    product,
    apiName,
    displayName: `The ${apiName} Ontology`,
  });
}

function ridOf(answer: Answer): string {
  return (answer.body as { rid: string }).rid;
}

describe('service/publish#install: POST /api/ontology-service/v1/ontologies installs a product, and gives the OntologyV2 of the new Ontology', () => {
  it('service/publish#install: an admin installs the twin, and gets its rid, apiName, displayName, and description', async () => {
    await publish();

    const answer = await install('sales');

    expect(answer).toEqual({
      status: 200,
      body: {
        rid: expect.stringMatching(RID_V4),
        apiName: 'sales',
        displayName: 'The sales Ontology',
        description: '',
      },
    });
  });
});

describe('service/http-api#routes service/http-api#metadata-routes: GET /api/v2/ontologies gives the Ontologies of the caller Organization', () => {
  it('service/http-api#metadata-routes service/authentication#organizations: gives only the Ontologies that the token org_id owns, in the code point order of their API names', async () => {
    await publish();

    const zeta = ridOf(await install('zeta'));

    const alpha = ridOf(await install('alpha'));

    const joined = ridOf(await install('ab'));

    const upper = ridOf(await install('beta'));

    await database.db.query({
      text: "UPDATE ontology_registry.ontologies SET api_name = 'Beta', display_name = 'The Beta Ontology' WHERE rid = $1",
      values: [upper],
    });

    const hyphen = ridOf(await install('a-b'));

    await install('other', { org_id: OTHER_ORGANIZATION });

    expect(await send('GET', LIST, await person(MEMBER))).toEqual({
      status: 200,
      body: {
        data: [
          { rid: upper, apiName: 'Beta', displayName: 'The Beta Ontology', description: '' },
          { rid: hyphen, apiName: 'a-b', displayName: 'The a-b Ontology', description: '' },
          { rid: joined, apiName: 'ab', displayName: 'The ab Ontology', description: '' },
          { rid: alpha, apiName: 'alpha', displayName: 'The alpha Ontology', description: '' },
          { rid: zeta, apiName: 'zeta', displayName: 'The zeta Ontology', description: '' },
        ],
      },
    });
  });

  it('service/http-api#metadata-routes: gives an empty data list to an Organization with no Ontology', async () => {
    await publish();

    await install('sales');

    expect(await send('GET', LIST, await person({ org_id: OTHER_ORGANIZATION }))).toEqual({
      status: 200,
      body: { data: [] },
    });
  });
});

describe('only a person whose role holds the permission ontology:install installs', () => {
  it('a member gets 403 Default:PermissionDenied, and installs nothing', async () => {
    await publish();

    expect(await install('sales', MEMBER)).toEqual({
      status: 403,
      body: {
        errorCode: 'PERMISSION_DENIED',
        errorName: 'Default:PermissionDenied',
        errorInstanceId: expect.any(String),
        parameters: {},
      },
    });

    expect(await send('GET', LIST, await person())).toEqual({ status: 200, body: { data: [] } });
  });

  it('the same person installs as an admin of 1 Organization, and is refused as a member of another', async () => {
    await publish();

    expect((await install('sales', { sub: MIXED })).status).toBe(200);

    expect((await install('sales', { sub: MIXED, org_id: OTHER_ORGANIZATION })).status).toBe(403);
  });

  it('a GitHub token gets 403 Default:PermissionDenied on install and on List Ontologies', async () => {
    await publish();

    const token = await issuer.github();

    const body = { product: 'twin', apiName: 'sales', displayName: 'Sales' };

    expect([(await send('POST', INSTALL, token, body)).body, (await send('GET', LIST, token)).body]).toEqual([
      {
        errorCode: 'PERMISSION_DENIED',
        errorName: 'Default:PermissionDenied',
        errorInstanceId: expect.any(String),
        parameters: {},
      },
      {
        errorCode: 'PERMISSION_DENIED',
        errorName: 'Default:PermissionDenied',
        errorInstanceId: expect.any(String),
        parameters: {},
      },
    ]);
  });

  it('service/authentication#organizations: a person token with no org_id gets 403 OntologyService:NoOrganization on install and on List Ontologies', async () => {
    await publish();

    const token = await person({ org_id: undefined });

    const body = { product: 'twin', apiName: 'sales', displayName: 'Sales' };

    const noOrganization = {
      errorCode: 'PERMISSION_DENIED',
      errorName: 'OntologyService:NoOrganization',
      errorInstanceId: expect.any(String),
      parameters: {},
    };

    expect([await send('POST', INSTALL, token, body), await send('GET', LIST, token)]).toEqual([
      { status: 403, body: noOrganization },
      { status: 403, body: noOrganization },
    ]);
  });
});

describe('service/publish#install: the errors of install', () => {
  it('service/publish#install: a product with no version gets 404 OntologyService:ProductNotFound', async () => {
    await publish();

    expect(await install('sales', {}, 'nothing')).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'OntologyService:ProductNotFound',
        errorInstanceId: expect.any(String),
        parameters: { product: 'nothing' },
      },
    });
  });

  it('service/publish#install: an apiName that another Ontology of the same Organization has gets 409 OntologyService:ApiNameAlreadyExists, and another Organization can take it', async () => {
    await publish();

    expect((await install('sales')).status).toBe(200);

    expect(await install('sales')).toEqual({
      status: 409,
      body: {
        errorCode: 'CONFLICT',
        errorName: 'OntologyService:ApiNameAlreadyExists',
        errorInstanceId: expect.any(String),
        parameters: { apiName: 'sales' },
      },
    });

    expect((await install('sales', { org_id: OTHER_ORGANIZATION })).status).toBe(200);
  });

  it.each([
    '$crm',
    'Sales',
    'sales_team',
    'sales.team',
    '-sales',
    'sales-',
    'sales--team',
    '1sales',
    'sales team',
    'séance',
  ])(
    'service/publish#install: the apiName %j gets 400 Default:InvalidArgument that names it, and no Ontology',
    async (apiName) => {
      await publish();

      expect(
        await send('POST', INSTALL, await person(ADMIN), { product: 'twin', apiName, displayName: 'Sales' }),
      ).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          errorInstanceId: expect.any(String),
          parameters: { part: 'apiName' },
        },
      });

      expect(await send('GET', LIST, await person())).toEqual({ status: 200, body: { data: [] } });
    },
  );

  it('service/publish#install: a bad apiName gets 400 before the product lookup, so a product that has no version does not answer 404', async () => {
    expect(
      await send('POST', INSTALL, await person(ADMIN), { product: 'twin', apiName: '$crm', displayName: 'Sales' }),
    ).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        errorInstanceId: expect.any(String),
        parameters: { part: 'apiName' },
      },
    });
  });

  it.each(['sales', 'example-app', 'app-tracer', 'a1-b2-c3'])(
    'service/publish#install: the apiName %j installs',
    async (apiName) => {
      await publish();

      expect((await install(apiName)).status).toBe(200);
    },
  );

  it('service/publish#install: a request with no displayName gets 400 Default:InvalidArgument that names it', async () => {
    await publish();

    expect(await send('POST', INSTALL, await person(ADMIN), { product: 'twin', apiName: 'sales' })).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        errorInstanceId: expect.any(String),
        parameters: { part: 'displayName' },
      },
    });
  });
});

describe('service/releases#compatibility-with-earlier-releases: an environment with no product version and no Ontology', () => {
  it('service/releases#compatibility-with-earlier-releases: passes the cold start, lists no Ontology, and install gets 404 OntologyService:ProductNotFound', async () => {
    expect(await send('GET', LIST, await person())).toEqual({ status: 200, body: { data: [] } });

    expect(await install('sales')).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'OntologyService:ProductNotFound',
        errorInstanceId: expect.any(String),
        parameters: { product: 'twin' },
      },
    });
  });
});

describe('service/publish#install: install makes a new random RID, and writes its schemas, tables, and registry row in 1 transaction', () => {
  it('service/publish#install: 2 installs of the same product get 2 different RIDs', async () => {
    await publish();

    const first = ridOf(await install('sales'));

    const second = ridOf(await install('support'));

    expect(first).not.toBe(second);
  });

  it('service/publish#install: an install that fails in Postgres leaves no registry row and no schema', async () => {
    await publish();

    await database.db.query({ text: `CREATE SCHEMA ${SCHEMAS.object}`, values: [] });

    expect((await install('sales')).status).toBe(500);

    expect(await send('GET', LIST, await person())).toEqual({ status: 200, body: { data: [] } });

    const schemas = await database.db.query<{ name: string }>({
      text: "SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'ontology\\_%' ORDER BY nspname",
      values: [],
    });

    expect(schemas.map((row) => row.name)).toEqual(['ontology_1_objects', 'ontology_registry']);
  });
});

describe('install takes the lock of publish', () => {
  it('an install waits while a publish holds the lock, and starts at the version that the publish stores', async () => {
    await publish();

    const holder = new pg.Client({ connectionString: database.url });

    await holder.connect();

    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;

    await holder.query('BEGIN');

    await holder.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

    await holder.query(
      "INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, publisher) SELECT product, 2, ir, metadata, schema_migrations, osdk_set, functions, publisher FROM ontology_registry.product_versions WHERE product = 'twin' AND version = 1",
    );

    let settled = false;

    const installing = install('sales').then((answer) => {
      settled = true;

      return answer;
    });

    await vi.waitFor(async () => {
      const waiting = await database.db.query<{ role: string }>({
        text: `SELECT a.usename AS role FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
               WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                 AND l.relation = 'ontology_registry.product_versions'::regclass AND NOT l.granted
                 AND $1 = ANY (pg_blocking_pids(l.pid))`,
        values: [holderPid],
      });

      expect(waiting).toEqual([{ role: serviceRole.name }]);
    });

    expect(settled).toBe(false);

    await holder.query('COMMIT');

    await holder.end();

    expect((await installing).status).toBe(200);

    const rows = await database.db.query<{ version: number }>({
      text: "SELECT version FROM ontology_registry.ontologies WHERE api_name = 'sales'",
      values: [],
    });

    expect(rows).toEqual([{ version: 2 }]);
  });
});

describe('service/publish#install: V1 has no uninstall, no Ontology delete, and no move', () => {
  it.each([
    ['DELETE', `${INSTALL}/ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000`],
    ['DELETE', `${LIST}/ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000`],
    ['PUT', `${INSTALL}/ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000`],
    ['POST', `${INSTALL}/ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000/move`],
  ])('service/publish#install: %s %s gets 404 with an empty body', async (method, path) => {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${await person()}` },
    });

    expect([response.status, await response.text()]).toEqual([404, '']);
  });
});

describe('service/authentication#organizations: 2 Organizations install the twin, and each reads only its own data', () => {
  const ACCOUNT = 'com.example.twin.Account';
  const CREATE_ACCOUNT = 'com.example.twin.create-account';

  async function twoInstalls(): Promise<{ readonly mine: string; readonly theirs: string }> {
    await publish();

    const mine = ridOf(await install('sales'));

    const theirs = ridOf(await install('sales', { org_id: OTHER_ORGANIZATION }));

    return { mine, theirs };
  }

  async function accountIds(rid: string, claims: Claims = {}): Promise<unknown> {
    const answer = await send('POST', `${LIST}/${rid}/objectSets/loadObjects`, await person(claims), {
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: ['accountId'],
    });

    return answer.status === 200
      ? (answer.body as { data: { accountId: string }[] }).data.map((row) => row.accountId)
      : answer.status;
  }

  it('service/authentication#organizations service/ontology-service#contract: a member of each Organization applies an Action, and reads only the Objects of its own Ontology', async () => {
    const { mine, theirs } = await twoInstalls();

    const apply = async (rid: string, accountId: string, claims: Claims) =>
      (
        await send('POST', `${LIST}/${rid}/actions/${CREATE_ACCOUNT}/apply`, await person({ ...MEMBER, ...claims }), {
          parameters: { accountId, name: accountId },
        })
      ).status;

    expect(await apply(mine, 'a-mine', {})).toBe(200);

    expect(await apply(theirs, 'a-theirs', { org_id: OTHER_ORGANIZATION })).toBe(200);

    expect([
      await accountIds(mine, MEMBER),
      await accountIds(theirs, { ...MEMBER, org_id: OTHER_ORGANIZATION }),
    ]).toEqual([['a-mine'], ['a-theirs']]);
  });

  it('an admin, whose role holds each permission of the twin, views each Object Type and Action Type of its Ontology', async () => {
    const { mine } = await twoInstalls();

    const token = await person(ADMIN);

    const objectTypes = await send('GET', `${LIST}/${mine}/objectTypes`, token);

    const actionTypes = await send('GET', `${LIST}/${mine}/actionTypes`, token);

    expect([
      objectTypes.status,
      (objectTypes.body as { data: { apiName: string }[] }).data.map((type) => type.apiName),
    ]).toEqual([200, ['com.example.twin.Account', 'com.example.twin.Engagement', 'com.example.twin.StructProbe']]);

    expect([actionTypes.status, (actionTypes.body as { data: unknown[] }).data.length]).toEqual([200, 13]);
  });

  it.each(routes.filter((route) => route.access === 'ontology').map((route) => [route.method, route.path] as const))(
    'service/http-api#requests service/authentication#organizations %s %s gives 404 OntologyNotFound for the RID of the other Organization',
    async (method, path) => {
      const { theirs } = await twoInstalls();

      const answer = await send(
        method as 'GET' | 'POST',
        path.replace('{ontology}', theirs).replace(/\{\w+\}/g, 'x'),
        await person(),
        method === 'POST' ? {} : undefined,
      );

      expect(answer).toEqual({
        status: 404,
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'OntologyNotFound',
          errorInstanceId: expect.any(String),
          parameters: { ontologyRid: theirs },
        },
      });
    },
  );

  it('service/http-api#requests: an unknown RID and an API name each get the same 404 OntologyNotFound as the RID of the other Organization', async () => {
    await twoInstalls();

    const unknown = 'ri.ontology.main.ontology.99999999-9999-4999-8999-999999999999';

    const answers = [
      await send('GET', `${LIST}/${unknown}/objectTypes`, await person()),
      await send('GET', `${LIST}/sales/objectTypes`, await person()),
    ];

    expect(answers.map((answer) => [answer.status, (answer.body as { errorName: string }).errorName])).toEqual([
      [404, 'OntologyNotFound'],
      [404, 'OntologyNotFound'],
    ]);
  });

  it('the Organization comes only from the token, so the same person reads an Ontology with 1 org_id and gets 404 with another', async () => {
    const { mine } = await twoInstalls();

    expect([await accountIds(mine), await accountIds(mine, { org_id: OTHER_ORGANIZATION })]).toEqual([[], 404]);
  });

  it('no schema holds a membership, Organization, or revoked-token table', async () => {
    await twoInstalls();

    const tables = await database.db.query<{ name: string }>({
      text: "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_name ~ '(member|organi[sz]ation|revoke|token|session)' ORDER BY name",
      values: [],
    });

    expect(tables).toEqual([]);
  });
});

describe('openOntology(db, rid, caller)', () => {
  async function open(rid: string, viewer: OrganizationCaller): Promise<unknown> {
    return rejecting(openOntology(fallibleOf(pooledDb), rid, viewer)).then(
      (view) => ({
        rid: view.rid,
        schemas: view.schemas,
        ontologyRid: view.ontology.metadata.ontology.rid,
        version: view.ontology.version,
      }),
      (error: unknown) => error,
    );
  }

  it('gives a person of the owner Organization the view: the RID, the 2 schema names, and the compiled Ontology of its version', async () => {
    await publish();

    const rid = ridOf(await install('sales'));

    expect(
      await open(rid, { user: UserId.parse('user_1'), kind: 'person', organization: ORGANIZATION, permissions: [] }),
    ).toEqual({
      rid,
      schemas: { object: 'ontology_1_objects', engine: 'ontology_1_engine' },
      ontologyRid: rid,
      version: 1,
    });
  });

  it('throws 404 OntologyNotFound for a person of another Organization', async () => {
    await publish();

    const rid = ridOf(await install('sales'));

    expect(
      await open(rid, {
        user: UserId.parse('user_1'),
        kind: 'person',
        organization: OTHER_ORGANIZATION,
        permissions: [],
      }),
    ).toMatchObject({
      status: 404,
      errorName: 'OntologyNotFound',
      parameters: { ontologyRid: rid },
    });
  });

  it('service/authentication#organizations: throws 404 OntologyNotFound for a registry row with no owner, also for a person of each Organization', async () => {
    await publish();

    const rid = ridOf(await install('sales'));

    await database.db.query({
      text: 'UPDATE ontology_registry.ontologies SET organization = NULL WHERE rid = $1',
      values: [rid],
    });

    expect(
      await open(rid, {
        user: UserId.parse('user_1'),
        kind: 'person',
        organization: ORGANIZATION,
        permissions: ['ontology:install'],
      }),
    ).toMatchObject({ status: 404, errorName: 'OntologyNotFound', parameters: { ontologyRid: rid } });
  });
});

describe('a GitHub token reads and writes no data of any Organization', () => {
  const DENIED = {
    errorCode: 'PERMISSION_DENIED',
    errorName: 'Default:PermissionDenied',
    errorInstanceId: expect.any(String),
    parameters: {},
  };

  const ACCOUNT = 'com.example.twin.Account';

  async function accountCount(rid: string): Promise<number> {
    const answer = await send('POST', `${LIST}/${rid}/objectSets/loadObjects`, await person(), {
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: ['accountId'],
    });

    return (answer.body as { data: unknown[] }).data.length;
  }

  it('a token of the publish job gets 403 on loadObjects of an Ontology that an Organization owns', async () => {
    await publish();

    const rid = ridOf(await install('sales'));

    const answer = await send(
      'POST',
      `${LIST}/${rid}/objectSets/loadObjects`,
      await issuer.github({ exp: now() + 3600 }),
      { objectSet: { type: 'base', objectType: ACCOUNT }, select: ['accountId'] },
    );

    expect(answer).toEqual({ status: 403, body: DENIED });
  });

  it('a token of the publish job gets 403 on an apply, and writes no Object', async () => {
    await publish();

    const rid = ridOf(await install('sales'));

    const before = await accountCount(rid);

    const answer = await send(
      'POST',
      `${LIST}/${rid}/actions/com.example.twin.create-account/apply`,
      await issuer.github({ exp: now() + 3600 }),
      { parameters: { accountId: 'from-ci', name: 'From CI' } },
    );

    expect(answer).toEqual({ status: 403, body: DENIED });

    expect(await accountCount(rid)).toBe(before);
  });

  it('service/authentication#ci-workflows: the same token publishes a new version', async () => {
    await publish();

    await expect(
      publishTwin({ baseUrl, publishToken: () => issuer.github({ exp: now() + 3600 }) }, '0.7.0'),
    ).resolves.toBeUndefined();
  });

  it('service/authentication#errors: a GitHub token on a data route, a pull request check that applies a publish, a person that applies a publish, and a member without ontology:install who installs each get 403 with no parameters', async () => {
    await publish();

    expect(await send('GET', LIST, await issuer.github({ exp: now() + 3600 }))).toEqual({ status: 403, body: DENIED });

    const path = '/api/ontology-service/v1/publish';
    const applied = { validateOnly: false };

    const check = await issuer.github({ environment: undefined, exp: now() + 3600 });

    expect(await send('POST', path, check, applied)).toEqual({ status: 403, body: DENIED });

    expect(await send('POST', path, await person(ADMIN), applied)).toEqual({ status: 403, body: DENIED });

    expect(
      await send('POST', INSTALL, await person(MEMBER), { product: 'twin', apiName: 'sales', displayName: 'Sales' }),
    ).toEqual({ status: 403, body: DENIED });
  });
});

describe('service/authentication#organizations: a caller that the route refuses learns nothing of a RID', () => {
  it.each(
    (['publish', 'check'] as const).flatMap((kind) =>
      routes.filter((route) => route.access === 'ontology').map((route) => [kind, route.method, route.path] as const),
    ),
  )(
    'service/authentication#organizations: a %s token gets the same 403 Default:PermissionDenied on %s %s for an owned RID and an unknown RID',
    async (kind, method, path) => {
      await publish();

      const owned = ridOf(await install('sales', { org_id: OTHER_ORGANIZATION }));

      const unknown = 'ri.ontology.main.ontology.99999999-9999-4999-8999-999999999999';

      const token = kind === 'check' ? await issuer.github({ environment: undefined }) : await issuer.github();

      const answer = async (rid: string) => {
        const { status, body } = await send(
          method as 'GET' | 'POST',
          path.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x'),
          token,
          method === 'POST' ? {} : undefined,
        );

        return {
          status,
          errorName: (body as { errorName: string }).errorName,
          parameters: (body as { parameters: unknown }).parameters,
        };
      };

      expect([await answer(owned), await answer(unknown)]).toEqual([
        { status: 403, errorName: 'Default:PermissionDenied', parameters: {} },
        { status: 403, errorName: 'Default:PermissionDenied', parameters: {} },
      ]);
    },
  );
});
