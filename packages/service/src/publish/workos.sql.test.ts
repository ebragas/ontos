import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workosPublish, workosUsers } from '../auth/index.ts';
import { UserId } from '../auth/caller.ts';
import { createPool } from '../db/index.ts';
import { createDb, type Db } from '../db/promise.test-utils.ts';
import type { GrantsFile } from '../ontology/index.ts';
import type { CheckedRequest, PublishResponse, WorkosPort } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { type PublishLog } from './publishOntology.ts';
import { planWorkosSteps } from './workosSteps.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { rejecting, TEST_PRODUCT } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import {
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubWorkos,
  type StubEnvironment,
  type StubMembership,
  type StubWorkos,
} from '../workos.test-utils.ts';
import { joinedOntology, realCompile } from './realCompile.test-utils.ts';
import {
  expectAllOnNewest,
  modeOf,
  newDatabaseUrl,
  onNewConnection,
  PUBLISHER,
  publishOntology,
  reconcile,
  request,
  technician,
  type TestDatabase,
  workOrder,
} from './publish.test-utils.ts';

const T1 = workOrder.apiName;
const T2 = technician.apiName;
const { ontology: LINKED, ir: IR } = realCompile(joinedOntology);
const VERSIONS = 'ontology_registry.product_versions';

const SERVICE_PASSWORD = 'workos-service';

let postgres: TestPostgres;
let serviceRole: string;
let template: string;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();

  serviceRole = `${postgres.role}_service`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: serviceRole, password: SERVICE_PASSWORD }, { icu: true });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await serviceDatabase();
});

async function serviceDatabase(): Promise<TestDatabase> {
  const createdUrl = await newDatabaseUrl(postgres.url, { template });

  const name = new URL(createdUrl).pathname.slice(1);

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

  const url = new URL(createdUrl);

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  const pool = createPool(url.toString());
  const db = createDb(pool);

  await db.query({ text: 'ALTER ROLE CURRENT_USER RESET ALL', values: [] });

  return {
    url: url.toString(),
    db,
    end: async () => {
      await pool.end();

      await onNewConnection(postgres.url, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

function grantsFile(
  t1: string,
  t2: string,
  member: readonly string[],
  others: Readonly<Record<string, readonly string[]>> = {},
): GrantsFile {
  const slugs = [...new Set([t1, t2, ...member, ...Object.values(others).flat()])].filter(
    (slug) => !slug.startsWith('ontology:'),
  );

  return {
    permissions: Object.fromEntries(slugs.sort().map((slug) => [slug, { description: `Use ${slug}` }])),
    objectTypes: { [T1]: t1, [T2]: t2 },
    actionTypes: {},
    defaultRoles: { member, ...others },
  };
}

interface PublishOptions {
  readonly validateOnly?: boolean;
  readonly product?: string;
  readonly between?: () => Promise<void>;
  readonly rollback?: boolean;
  readonly ended?: () => void;
  readonly log?: (log: PublishLog) => void;
}

function publish(
  stub: StubWorkos,
  grants: GrantsFile,
  options: PublishOptions = {},
  db: Db = database.db,
): Promise<PublishResponse> {
  const validateOnly = options.validateOnly ?? false;

  const hooked: Db = {
    ...db,
    transaction: async (run) => {
      await options.between?.();

      try {
        return await db.transaction(async (tx) => {
          const result = await run(tx);

          if (options.rollback) throw new Error('A failure after the last step of the transaction.');

          return result;
        });
      } finally {
        options.ended?.();
      }
    },
  };

  return publishOntology(hooked, {
    product: options.product ?? TEST_PRODUCT.product,
    productRid: TEST_PRODUCT.productRid,
    ontology: LINKED,
    request: { ...request(validateOnly), product: options.product ?? TEST_PRODUCT.product, ir: IR, grants },
    publisher: PUBLISHER,
    mode: modeOf(validateOnly),
    workos: workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }),
    ...(options.log ? { log: options.log } : {}),
  });
}

const V2_GRANTS = { roles: [], objectTypes: {}, actionTypes: {} };

async function publishV2(grants: object = V2_GRANTS): Promise<number | undefined> {
  const response = await publishOntology(database.db, {
    product: TEST_PRODUCT.product,
    productRid: TEST_PRODUCT.productRid,
    ontology: LINKED,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The test stores a grants file that does not parse, which a checked request cannot hold.
    request: { ...request(false), ir: IR, grants: grants as unknown as CheckedRequest['grants'] },
    publisher: PUBLISHER,
    mode: modeOf(false),
  });

  return response.version;
}

async function refusal(call: Promise<unknown>): Promise<unknown[]> {
  const error = await thrown(call);

  return [error.status, error.errorName, error.parameters];
}

interface Thrown {
  readonly status?: number;
  readonly errorName?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

async function thrown(call: Promise<unknown>): Promise<Thrown> {
  return (await call.then(
    () => new Error('The call passed.'),
    (error: unknown) => error,
  )) as Thrown;
}

function withoutMs(error: Thrown): unknown[] {
  const { transactionMs, ...rest } = error.parameters ?? {};

  return [error.status, error.errorName, rest, typeof transactionMs];
}

const I1 = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000c1';
const I2 = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000c2';
const I3 = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000c3';

async function installed(): Promise<number[]> {
  return (
    await database.db.query<{ version: number }>({
      text: 'SELECT version FROM ontology_registry.ontologies ORDER BY number',
      values: [],
    })
  ).map((row) => row.version);
}

function port(stub: StubWorkos) {
  return workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch });
}

async function versions(db: Db = database.db): Promise<number[]> {
  return (
    await db.query<{ version: number }>({ text: `SELECT version FROM ${VERSIONS} ORDER BY version`, values: [] })
  ).map((row) => row.version);
}

async function setRolePermissions(stub: StubWorkos, role: string, permissions: readonly string[]): Promise<void> {
  const answer = await stub.fetch(`https://api.workos.com/authorization/roles/${role}/permissions`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${STUB_WORKOS_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ permissions }),
  });

  expect(answer.status).toBe(200);
}

function newStub(roles: readonly string[] = ['member'], environment?: StubEnvironment): StubWorkos {
  const memberships: StubMembership[] = [
    { user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles },
  ];

  return stubWorkos([STUB_PERSON], memberships, { roles: {}, ...(environment ? { environment } : {}) });
}

describe('the WorkOS steps of a publish', () => {
  it('service/publish#default-roles-in-workos service/publish#reconcile: a first publish creates each permission before the store, and each default role with its list in the reconcile, before the answer', async () => {
    const stub = newStub();
    let atStore: StubEnvironment | undefined;

    const response = await publish(stub, grantsFile('a', 'b', ['a', 'b'], { admin: ['ontology:install', 'a', 'b'] }), {
      between: async () => {
        atStore = stub.environment();
      },
    });

    const permissions = {
      a: 'Use a',
      b: 'Use b',
      'ontology:install': 'Install an Ontology of a product in the Organization',
    };

    expect([response.version, atStore, stub.environment(), response.workosSteps]).toEqual([
      1,
      { permissions, roles: {} },
      { permissions, roles: { admin: ['a', 'b', 'ontology:install'], member: ['a', 'b'] } },
      undefined,
    ]);
  });

  it('service/publish#default-roles-in-workos: a second run of the same publish writes nothing, and a validateOnly run plans no step', async () => {
    const stub = newStub();
    const grants = grantsFile('a', 'b', ['a', 'b']);

    await publish(stub, grants);

    const writes = stub.writes.length;

    expect((await publish(stub, grants)).version).toBe(1);

    expect((await publish(stub, grants, { validateOnly: true })).workosSteps).toEqual([]);

    expect(stub.writes.length - writes).toBe(0);
  });

  it('the permissions constructor, __proto__, and toString, each held by a default role, publish with their own descriptions', async () => {
    const stub = newStub();
    const grants = grantsFile('constructor', '__proto__', ['constructor', '__proto__', 'toString']);

    expect(Object.keys(grants.permissions)).toEqual(['__proto__', 'constructor', 'toString']);

    const response = await publish(stub, grants);

    expect([response.version, stub.environment()]).toEqual([
      1,
      {
        permissions: Object.fromEntries([
          ['__proto__', 'Use __proto__'],
          ['constructor', 'Use constructor'],
          ['toString', 'Use toString'],
        ]),
        roles: { member: ['__proto__', 'constructor', 'toString'] },
      },
    ]);

    expect(stub.writes.filter((write) => write.method === 'PATCH').map((write) => [write.path, write.body])).toEqual([
      ['/authorization/permissions/__proto__', { description: 'Use __proto__' }],
      ['/authorization/permissions/constructor', { description: 'Use constructor' }],
      ['/authorization/permissions/toString', { description: 'Use toString' }],
    ]);
  });

  it('a validateOnly publish writes nothing, and answers with the planned steps before the transaction, in their order', async () => {
    const stub = newStub();

    const response = await publish(stub, grantsFile('a', 'b', ['b']), { validateOnly: true });

    expect([response.workosSteps, stub.writes, await versions()]).toEqual([
      [
        { step: 'createPermission', permission: 'a' },
        { step: 'createPermission', permission: 'b' },
        { step: 'setDescription', permission: 'a', description: 'Use a' },
        { step: 'setDescription', permission: 'b', description: 'Use b' },
      ],
      [],
      [],
    ]);
  });

  it('service/publish#default-roles-in-workos: a publish that drops permissions and a default role that no person has deletes no permission and no role', async () => {
    const stub = newStub(['member']);

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a', 'c'] }));

    const writes = stub.writes.length;

    expect((await publish(stub, grantsFile('a', 'b', ['b']))).version).toBe(2);

    expect([stub.writes.slice(writes), stub.environment()]).toEqual([
      [
        { method: 'PUT', path: '/authorization/roles/member/permissions', body: { permissions: ['b'] } },
        { method: 'PUT', path: '/authorization/roles/viewer/permissions', body: { permissions: [] } },
      ],
      { permissions: { a: 'Use a', b: 'Use b', c: 'Use c' }, roles: { member: ['b'], viewer: [] } },
    ]);
  });

  it('service/publish#default-roles-in-workos: each publish reads the stub again, with a kept answer of the request path present', async () => {
    const stub = newStub();
    const users = workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch });
    const grants = grantsFile('a', 'b', ['a', 'b']);

    await publish(stub, grants);

    expect(await rejecting(users.permissions(UserId.parse(STUB_PERSON.id), ORGANIZATION))).toEqual(['a', 'b']);

    await setRolePermissions(stub, 'member', ['b']);

    expect(await rejecting(users.permissions(UserId.parse(STUB_PERSON.id), ORGANIZATION))).toEqual(['a', 'b']);

    await publish(stub, grants);

    expect([
      stub.requests.filter((path) => path === '/authorization/permissions?limit=100&order=asc').length,
      stub.environment().roles['member'],
    ]).toEqual([4, ['b', 'a']]);
  });

  it('service/publish#default-roles-in-workos: a crash after each addition, then a second run, gives the same end state, and a failed addition stores no version', async () => {
    const v1 = grantsFile('a', 'b', ['a', 'b']);
    const v2 = grantsFile('a', 'b', ['a', 'b', 'c'], { viewer: ['a'] });
    const start: StubEnvironment = { permissions: { a: 'Use a', b: 'Use b' }, roles: { member: ['a', 'b'] } };

    const end: StubEnvironment = {
      permissions: { a: 'Use a', b: 'Use b', c: 'Use c' },
      roles: { member: ['a', 'b', 'c'], viewer: ['a'] },
    };

    const steps = planWorkosSteps(
      v2,
      {
        permissions: new Map(Object.entries(start.permissions) as [string, string][]),
        roles: new Map([['member', new Set(['a', 'b'])]]),
      },
      new Set(['member']),
    );

    expect(steps).toHaveLength(3);

    const outcomes: unknown[] = [];

    for (const failure of ['5xx', 'answer lost'] as const) {
      for (let after = 0; after < steps.length; after += 1) {
        const run = await serviceDatabase();

        try {
          const stub = newStub(['member'], start);

          await publish(stub, v1, {}, run.db);

          const first = stub.writes.length;

          stub.failWrites(after, failure);

          const failed = await refusal(publish(stub, v2, {}, run.db));

          const firstRun = stub.writes.length;

          stub.failWrites(undefined);

          const stored = await versions(run.db);

          await publish(stub, v2, {}, run.db);

          const text = ({ method, path, body }: { method: string; path: string; body: unknown }) =>
            `${method} ${path} ${JSON.stringify(body)}`;

          const made = stub.writes.slice(first, first + after + (failure === 'answer lost' ? 1 : 0)).map(text);
          const secondRun = stub.writes.slice(firstRun).map(text);

          outcomes.push([
            failed,
            stored,
            await versions(run.db),
            stub.environment(),
            secondRun.filter((write) => made.includes(write)),
            secondRun.length,
          ]);
        } finally {
          await run.end();
        }
      }
    }

    const unavailable = [503, 'OntologyService:WorkosUnavailable', {}];
    const addC = 'POST /authorization/roles/member/permissions {"slug":"c"}';

    expect(outcomes).toEqual([
      ...[5, 4, 3].map((left) => [unavailable, [1], [1, 2], end, [], left]),
      ...[4, 3].map((left) => [unavailable, [1], [1, 2], end, [], left]),
      [unavailable, [1], [1, 2], end, [addC], 3],
    ]);
  });
});

describe('the RoleInUse check of publish', () => {
  it('service/publish#default-roles-in-workos: a removed default role that a member of the stub has gets 409 OntologyService:RoleInUse, also with validateOnly', async () => {
    const stub = newStub(['viewer']);

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] }));

    const writes = stub.writes.length;

    for (const validateOnly of [true, false]) {
      expect(await refusal(publish(stub, grantsFile('a', 'b', ['a', 'b']), { validateOnly }))).toEqual([
        409,
        'OntologyService:RoleInUse',
        { role: 'viewer' },
      ]);
    }

    expect([stub.writes.length - writes, await versions()]).toEqual([0, [1]]);
  });

  it('service/publish#default-roles-in-workos: the RoleInUse check pages each Organization of the stub, and runs only when a default role is dropped', async () => {
    const stub = newStub(['member']);

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] }));

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'c'], { viewer: ['a'] }));

    expect(stub.requests.filter((path) => path.startsWith('/organizations'))).toEqual([]);

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'c']));

    expect(
      stub.requests.filter((path) => path.startsWith('/organizations') || path.includes('organization_id=')),
    ).toEqual([
      '/organizations?limit=100&order=asc',
      `/user_management/organization_memberships?organization_id=${ORGANIZATION}&statuses=active%2Cinactive%2Cpending&limit=100&order=asc`,
    ]);

    expect(await versions()).toEqual([1, 2, 3]);
  });
});

describe('the RoleInUse check of publish on a WorkOS failure', () => {
  it('the RoleInUse check: a WorkOS failure on the first page of members gives 503, writes nothing, and stores no version', async () => {
    const stub = newStub(['member']);

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] }));

    const writes = stub.writes.length;

    stub.fail('5xx', { reads: ['membership'] });

    for (const validateOnly of [true, false]) {
      expect(
        (await refusal(publish(stub, grantsFile('a', 'b', ['a', 'b', 'c']), { validateOnly }))).slice(0, 2),
      ).toEqual([503, 'OntologyService:WorkosUnavailable']);
    }

    expect([stub.writes.length - writes, await versions()]).toEqual([0, [1]]);
  });
});

describe('a row with held = true', () => {
  it('service/publish#upgrade: a publish that takes from a role a permission that it still declares, while a row has held = true, gets no PermissionInUse and stores', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'p']));

    const rid = 'ri.ontology.main.ontology.00000000-0000-4000-8000-0000000000b1';

    await installOntology(database.db, {
      rid,
      product: TEST_PRODUCT.product,
      apiName: 'held',
      displayName: 'held',
      organization: ORGANIZATION,
    });

    await database.db.query({
      text: 'UPDATE ontology_registry.ontologies SET held = true WHERE rid = $1',
      values: [rid],
    });

    const taken = grantsFile('a', 'b', ['a', 'b']);
    const declared = { ...taken, permissions: { ...taken.permissions, p: { description: 'Use p' } } };

    const checked = await publish(stub, declared, { validateOnly: true });

    const stored = await publish(stub, declared);

    expect([checked.version, checked.warnings, stored.version, stored.warnings, await versions()]).toEqual([
      undefined,
      undefined,
      2,
      undefined,
      [1, 2],
    ]);
  });
});

describe('replays of the default roles model', () => {
  it('service/publish#default-roles-in-workos: path 6: a permission that exists in WorkOS is added to the role that lacks it, before the store', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a']));

    const writes = stub.writes.length;
    let atStore: readonly string[] | undefined;

    await publish(stub, grantsFile('b', 'b', ['b']), {
      between: async () => {
        atStore = stub.environment().roles['member'];
      },
    });

    expect([stub.writes.slice(writes), atStore]).toEqual([
      [
        { method: 'POST', path: '/authorization/roles/member/permissions', body: { slug: 'b' } },
        { method: 'PUT', path: '/authorization/roles/member/permissions', body: { permissions: ['b'] } },
      ],
      ['a', 'b'],
    ]);
  });

  it('service/publish#default-roles-in-workos: path 8, split drop: a job that stops between the create of c and its add adds c on the next run', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    stub.failWrites(1);

    expect((await refusal(publish(stub, grantsFile('c', 'b', ['b', 'c']))))[1]).toBe(
      'OntologyService:WorkosUnavailable',
    );

    stub.failWrites(undefined);

    expect(stub.environment()).toEqual({
      permissions: { a: 'Use a', b: 'Use b', c: null },
      roles: { member: ['a', 'b'] },
    });

    expect((await publish(stub, grantsFile('c', 'b', ['b', 'c']))).version).toBe(2);

    expect(stub.environment()).toEqual({
      permissions: { a: 'Use a', b: 'Use b', c: 'Use c' },
      roles: { member: ['b', 'c'] },
    });
  });
});

describe('the reconcile after the transaction', () => {
  const PUT = '/authorization/roles/member/permissions';

  it('service/publish#reconcile: after a commit, each default role equals the new grants file, and no role holds a dropped permission', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'x'], { admin: ['a', 'x'] }));

    const writes = stub.writes.length;

    expect((await publish(stub, grantsFile('a', 'b', ['a', 'b'], { admin: ['a'] }))).version).toBe(2);

    expect([stub.writes.slice(writes), stub.environment()]).toEqual([
      [
        { method: 'PUT', path: '/authorization/roles/admin/permissions', body: { permissions: ['a'] } },
        { method: 'PUT', path: PUT, body: { permissions: ['a', 'b'] } },
      ],
      { permissions: { a: 'Use a', b: 'Use b', x: 'Use x' }, roles: { admin: ['a'], member: ['a', 'b'] } },
    ]);
  });

  it('service/publish#reconcile: a WorkOS role that a publish names for the first time is untouched after a rollback, and gets the full list of the grants file after a commit', async () => {
    const stub = newStub(['member'], { permissions: { p0: 'Use p0' }, roles: { admin: ['p0'] } });

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const writes = stub.writes.length;
    const v2 = grantsFile('a', 'b', ['a', 'b'], { admin: ['a', 'b'] });

    const error = await thrown(publish(stub, v2, { rollback: true }));

    const afterRollback = [withoutMs(error), await versions(), stub.writes.slice(writes), stub.environment().roles];

    expect((await publish(stub, v2)).version).toBe(2);

    expect([afterRollback, stub.writes.slice(writes), stub.environment().roles]).toEqual([
      [[500, 'Default:Internal', {}, 'number'], [1], [], { member: ['a', 'b'], admin: ['p0'] }],
      [{ method: 'PUT', path: '/authorization/roles/admin/permissions', body: { permissions: ['a', 'b'] } }],
      { member: ['a', 'b'], admin: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a first publish that rolls back creates each permission, and creates no role', async () => {
    const stub = newStub();

    const error = await thrown(publish(stub, grantsFile('a', 'b', ['a', 'b']), { rollback: true }));

    expect([
      withoutMs(error),
      await versions(),
      stub.writes.map((write) => `${write.method} ${write.path}`),
      stub.environment(),
    ]).toEqual([
      [500, 'Default:Internal', {}, 'number'],
      [],
      [
        'POST /authorization/permissions',
        'POST /authorization/permissions',
        'PATCH /authorization/permissions/a',
        'PATCH /authorization/permissions/b',
      ],
      { permissions: { a: 'Use a', b: 'Use b' }, roles: {} },
    ]);
  });

  it('service/publish#default-roles-in-workos: a new default role of a later publish whose reconcile fails lacks its permissions until the rerun, whose additions create and fill it', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const v2 = grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] });

    const error = await thrown(publish(stub, v2, { ended: () => stub.fail('5xx', { reads: ['roles'] }) }));

    stub.fail(undefined);

    const roles = stub.environment().roles;
    const writes = stub.writes.length;

    const rerun = await publish(stub, v2);

    expect([
      withoutMs(error),
      roles,
      rerun.version,
      stub.writes.slice(writes).map((write) => `${write.method} ${write.path} ${JSON.stringify(write.body)}`),
      stub.environment().roles,
    ]).toEqual([
      [503, 'OntologyService:WorkosUnavailable', { version: 2, reconciled: false }, 'number'],
      { member: ['a', 'b'] },
      2,
      [
        'POST /authorization/roles {"slug":"viewer","name":"viewer"}',
        'POST /authorization/roles/viewer/permissions {"slug":"a"}',
      ],
      { member: ['a', 'b'], viewer: ['a'] },
    ]);
  });

  it('service/publish#default-roles-in-workos: a WorkOS role that a publish names for the first time keeps its old list after a failed reconcile, and the rerun fills it and replaces its list', async () => {
    const stub = newStub(['member'], { permissions: { p0: 'Use p0' }, roles: { admin: ['p0'] } });

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const v2 = grantsFile('a', 'b', ['a', 'b'], { admin: ['a', 'b'] });

    const error = await thrown(publish(stub, v2, { ended: () => stub.fail('5xx', { reads: ['roles'] }) }));

    stub.fail(undefined);

    const afterFailure = stub.environment().roles;
    const writes = stub.writes.length;

    expect((await publish(stub, v2)).version).toBe(2);

    expect([
      withoutMs(error),
      afterFailure,
      stub.writes.slice(writes).map((write) => `${write.method} ${write.path} ${JSON.stringify(write.body)}`),
      stub.environment().roles,
    ]).toEqual([
      [503, 'OntologyService:WorkosUnavailable', { version: 2, reconciled: false }, 'number'],
      { member: ['a', 'b'], admin: ['p0'] },
      [
        'POST /authorization/roles/admin/permissions {"slug":"a"}',
        'POST /authorization/roles/admin/permissions {"slug":"b"}',
        'PUT /authorization/roles/admin/permissions {"permissions":["a","b"]}',
      ],
      { member: ['a', 'b'], admin: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a role that only an older stored version names and that WorkOS lacks gets no write, and the reconcile does not fail on it', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] }));

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const real = port(stub);

    const withoutViewer: WorkosPort = {
      ...real,
      read: async function* (): ReturnType<WorkosPort['read']> {
        const read = yield* real.read();

        return { ...read, roles: new Map([...read.roles].filter(([role]) => role !== 'viewer')) };
      },
    };

    const writes = stub.writes.length;

    await reconcile(database.db, TEST_PRODUCT.product, withoutViewer);

    expect(stub.writes.length - writes).toBe(0);
  });

  it('service/publish#reconcile service/publish#default-roles-in-workos: with no stored version, the reconcile changes nothing: a first publish that rolls back creates ontology:install for a role that no version names, and a first publish whose addition fails writes no role', async () => {
    const v1 = grantsFile('a', 'b', ['a', 'b'], { admin: ['ontology:install', 'a'] });
    const rolledBack = newStub();

    const error = await thrown(publish(rolledBack, v1, { rollback: true }));

    const failed = newStub();

    failed.failWrites(1);

    const refused = await thrown(publish(failed, v1));

    failed.failWrites(undefined);

    expect([
      withoutMs(error),
      rolledBack.environment(),
      [refused.status, refused.errorName, refused.parameters],
      failed.writes.map((write) => `${write.method} ${write.path}`),
      failed.environment(),
      await versions(),
    ]).toEqual([
      [500, 'Default:Internal', {}, 'number'],
      {
        permissions: {
          a: 'Use a',
          b: 'Use b',
          'ontology:install': 'Install an Ontology of a product in the Organization',
        },
        roles: {},
      },
      [503, 'OntologyService:WorkosUnavailable', {}],
      ['POST /authorization/permissions', 'POST /authorization/permissions'],
      { permissions: { a: null }, roles: {} },
      [],
    ]);
  });

  it('service/publish#default-roles-in-workos service/publish#reconcile: a WorkOS failure in the reconcile of a first publish gives 503 with version and reconciled false, leaves each role as before, and the additions of the rerun create and fill each role', async () => {
    const stub = newStub();
    const v1 = grantsFile('a', 'b', ['a', 'b'], { admin: ['ontology:install', 'a'] });

    const error = await thrown(publish(stub, v1, { ended: () => stub.fail('5xx', { reads: ['roles'] }) }));

    stub.fail(undefined);

    const roles = stub.environment().roles;
    const writes = stub.writes.length;

    const rerun = await publish(stub, v1);

    expect([
      withoutMs(error),
      roles,
      rerun.version,
      await versions(),
      stub.writes.slice(writes).map((write) => `${write.method} ${write.path} ${JSON.stringify(write.body)}`),
      stub.environment().roles,
    ]).toEqual([
      [503, 'OntologyService:WorkosUnavailable', { version: 1, reconciled: false }, 'number'],
      {},
      1,
      [1],
      [
        'POST /authorization/roles {"slug":"admin","name":"admin"}',
        'POST /authorization/roles {"slug":"member","name":"member"}',
        'POST /authorization/roles/admin/permissions {"slug":"a"}',
        'POST /authorization/roles/admin/permissions {"slug":"ontology:install"}',
        'POST /authorization/roles/member/permissions {"slug":"a"}',
        'POST /authorization/roles/member/permissions {"slug":"b"}',
      ],
      { admin: ['a', 'ontology:install'], member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a WorkOS failure in the reconcile after a rollback keeps the first error, and leaves a role that no stored version names as it was', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const v2 = grantsFile('a', 'b', ['a', 'b', 'c'], { viewer: ['a'] });

    const error = await thrown(publish(stub, v2, { rollback: true, ended: () => stub.failWrites(0) }));

    stub.failWrites(undefined);

    const afterFailure = [withoutMs(error), await versions(), stub.writes.at(-1), stub.environment().roles];

    await thrown(publish(stub, v2, { rollback: true }));

    expect([afterFailure, stub.environment().roles]).toEqual([
      [
        [500, 'Default:Internal', {}, 'number'],
        [1],
        { method: 'PUT', path: '/authorization/roles/member/permissions', body: { permissions: ['a', 'b'] } },
        { member: ['a', 'b', 'c'] },
      ],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#default-roles-in-workos service/publish#reconcile: after a rollback, a default role that only the failed publish names is not created and gets no permission', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const writes = stub.writes.length;

    const error = await thrown(publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] }), { rollback: true }));

    expect([withoutMs(error), await versions(), stub.writes.slice(writes), stub.environment().roles]).toEqual([
      [500, 'Default:Internal', {}, 'number'],
      [1],
      [],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: after a rollback, each default role equals the newest stored grants file, and a permission that the additions gave is gone', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const writes = stub.writes.length;
    let atStore: readonly string[] | undefined;

    const error = await thrown(
      publish(stub, grantsFile('a', 'b', ['a', 'b', 'c']), {
        rollback: true,
        between: async () => {
          atStore = stub.environment().roles['member'];
        },
      }),
    );

    expect([withoutMs(error), atStore, await versions(), stub.writes.slice(writes), stub.environment()]).toEqual([
      [500, 'Default:Internal', {}, 'number'],
      ['a', 'b', 'c'],
      [1],
      [
        { method: 'POST', path: '/authorization/permissions', body: { slug: 'c', name: 'c' } },
        { method: 'PATCH', path: '/authorization/permissions/c', body: { description: 'Use c' } },
        { method: 'POST', path: PUT, body: { slug: 'c' } },
        { method: 'PUT', path: PUT, body: { permissions: ['a', 'b'] } },
      ],
      { permissions: { a: 'Use a', b: 'Use b', c: 'Use c' }, roles: { member: ['a', 'b'] } },
    ]);

    const rerun = stub.writes.length;

    expect([
      (await publish(stub, grantsFile('a', 'b', ['a', 'b', 'c']))).version,
      stub.writes.slice(rerun),
      stub.environment().roles,
    ]).toEqual([2, [{ method: 'POST', path: PUT, body: { slug: 'c' } }], { member: ['a', 'b', 'c'] }]);
  });

  it('service/publish#reconcile: a permission that only an earlier stored version gives a role is removed, with 3 installations', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'x']));

    for (const [rid, apiName] of [
      [I1, 'one'],
      [I2, 'two'],
      [I3, 'three'],
    ] as const) {
      await installOntology(database.db, {
        rid,
        product: TEST_PRODUCT.product,
        apiName,
        displayName: apiName,
        organization: ORGANIZATION,
      });
    }

    const writes = stub.writes.length;

    expect((await publish(stub, grantsFile('c', 'b', ['b', 'c']))).version).toBe(2);

    expect([await installed(), stub.writes.slice(writes), stub.environment().roles]).toEqual([
      [2, 2, 2],
      [
        { method: 'POST', path: '/authorization/permissions', body: { slug: 'c', name: 'c' } },
        { method: 'PATCH', path: '/authorization/permissions/c', body: { description: 'Use c' } },
        { method: 'POST', path: PUT, body: { slug: 'c' } },
        { method: 'PUT', path: PUT, body: { permissions: ['b', 'c'] } },
      ],
      { member: ['b', 'c'] },
    ]);
  });

  it('service/publish#reconcile: a removed default role that a person holds also gets an empty list', async () => {
    const stub = newStub(['member']);

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a'] }));

    const v2 = grantsFile('a', 'b', ['a', 'b']);

    await publish(stub, v2);

    await setRolePermissions(stub, 'viewer', ['a']);

    stub.memberships.splice(0, 1, {
      user_id: STUB_PERSON.id,
      organization_id: ORGANIZATION,
      status: 'active',
      roles: ['viewer'],
    });

    const writes = stub.writes.length;

    expect((await publish(stub, v2)).version).toBe(2);

    expect([stub.writes.slice(writes), stub.environment().roles]).toEqual([
      [{ method: 'PUT', path: '/authorization/roles/viewer/permissions', body: { permissions: [] } }],
      { member: ['a', 'b'], viewer: [] },
    ]);
  });

  it('service/publish#reconcile: a default role that the newest version removed gets an empty list, and its name comes from the stored versions', async () => {
    const stub = newStub(['member'], { permissions: { a: null }, roles: { other: ['a'] } });

    await publish(stub, grantsFile('a', 'b', ['a', 'b'], { viewer: ['a', 'ontology:install'] }));

    const writes = stub.writes.length;

    expect((await publish(stub, grantsFile('a', 'b', ['a', 'b']))).version).toBe(2);

    expect([stub.writes.slice(writes), stub.environment().roles]).toEqual([
      [{ method: 'PUT', path: '/authorization/roles/viewer/permissions', body: { permissions: [] } }],
      { other: ['a'], member: ['a', 'b'], viewer: [] },
    ]);
  });

  it('service/publish#default-roles-in-workos: an older stored grants file that does not parse names no role, while the roles of a newest file that parses are named', async () => {
    const stub = newStub();

    expect(await publishV2({ objectTypes: {}, actionTypes: {}, defaultRoles: { viewer: ['a'] } })).toBe(1);

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const checked = await publish(stub, grantsFile('a', 'b', ['a', 'b', 'c'], { viewer: ['a'] }), {
      validateOnly: true,
    });

    expect([await versions(), checked.workosSteps, stub.environment().roles]).toEqual([
      [1, 2],
      [
        { step: 'createPermission', permission: 'c' },
        { step: 'setDescription', permission: 'c', description: 'Use c' },
        { step: 'addPermission', role: 'member', permission: 'c' },
      ],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#default-roles-in-workos: when the newest stored grants file does not parse, no version names a role: the additions plan no role step for a role that an earlier version names, and a rollback leaves it as it was', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    expect(await publishV2()).toBe(2);

    const v3 = grantsFile('a', 'b', ['a', 'b', 'c']);

    const checked = await publish(stub, v3, { validateOnly: true });

    const writes = stub.writes.length;

    const error = await thrown(publish(stub, v3, { rollback: true }));

    expect([
      checked.workosSteps,
      withoutMs(error),
      await versions(),
      stub.writes.slice(writes).map((write) => `${write.method} ${write.path}`),
      stub.environment().roles,
    ]).toEqual([
      [
        { step: 'createPermission', permission: 'c' },
        { step: 'setDescription', permission: 'c', description: 'Use c' },
      ],
      [500, 'Default:Internal', {}, 'number'],
      [1, 2],
      ['POST /authorization/permissions', 'PATCH /authorization/permissions/c'],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: the reconcile creates a role of the newest grants file that its read does not show, and a 409 role_slug_conflict of that create counts as done', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    await setRolePermissions(stub, 'member', ['a']);

    const real = port(stub);

    const hidden: WorkosPort = {
      ...real,
      read: async function* (): ReturnType<WorkosPort['read']> {
        return { ...(yield* real.read()), roles: new Map() };
      },
    };

    const writes = stub.writes.length;

    await reconcile(database.db, TEST_PRODUCT.product, hidden);

    expect([
      stub.writes.slice(writes).map((write) => `${write.method} ${write.path} ${JSON.stringify(write.body)}`),
      stub.environment().roles,
    ]).toEqual([
      [
        'POST /authorization/roles {"slug":"member","name":"member"}',
        'PUT /authorization/roles/member/permissions {"permissions":["a","b"]}',
      ],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a second run of the reconcile writes nothing, and a newest grants file that does not parse changes nothing', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'x']));

    await setRolePermissions(stub, 'member', ['x']);

    const writes = stub.writes.length;

    await reconcile(database.db, TEST_PRODUCT.product, port(stub));

    await reconcile(database.db, TEST_PRODUCT.product, port(stub));

    expect([stub.writes.slice(writes), stub.environment().roles]).toEqual([
      [{ method: 'PUT', path: PUT, body: { permissions: ['a', 'b', 'x'] } }],
      { member: ['a', 'b', 'x'] },
    ]);

    expect(await publishV2()).toBe(2);

    await setRolePermissions(stub, 'member', ['a']);

    const requests = stub.requests.length;

    await reconcile(database.db, TEST_PRODUCT.product, port(stub));

    expect([stub.requests.length - requests, stub.environment().roles]).toEqual([0, { member: ['a'] }]);
  });

  it('service/publish#applying service/publish#reconcile: a publish with the same parts stores no version, and runs the WorkOS additions and the reconcile', async () => {
    const stub = newStub(['member'], { permissions: { x: null }, roles: {} });
    const grants = grantsFile('a', 'b', ['a', 'b']);

    await publish(stub, grants);

    await setRolePermissions(stub, 'member', ['a', 'x']);

    const writes = stub.writes.length;

    expect([
      (await publish(stub, grants)).version,
      await versions(),
      stub.writes.slice(writes),
      stub.environment().roles,
    ]).toEqual([
      1,
      [1],
      [
        { method: 'POST', path: PUT, body: { slug: 'b' } },
        { method: 'PUT', path: PUT, body: { permissions: ['a', 'b'] } },
      ],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile service/publish#default-roles-in-workos: after a failed addition, the reconcile runs, and the publish stores no version', async () => {
    const stub = newStub(['member'], { permissions: { x: null }, roles: {} });

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    await setRolePermissions(stub, 'member', ['a', 'b', 'x']);

    const writes = stub.writes.length;

    stub.failWrites(1, '5xx', 1);

    expect([
      await refusal(publish(stub, grantsFile('a', 'b', ['a', 'b', 'c']))),
      await versions(),
      stub.writes.slice(writes),
      stub.environment().roles,
    ]).toEqual([
      [503, 'OntologyService:WorkosUnavailable', {}],
      [1],
      [
        { method: 'POST', path: '/authorization/permissions', body: { slug: 'c', name: 'c' } },
        { method: 'PATCH', path: '/authorization/permissions/c', body: { description: 'Use c' } },
        { method: 'PUT', path: PUT, body: { permissions: ['a', 'b'] } },
      ],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a WorkOS failure in the reconcile after a rollback, and after a failed addition, does not replace the first error', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b']));

    const afterRollback = await thrown(
      publish(stub, grantsFile('a', 'b', ['a', 'b', 'c']), {
        rollback: true,
        ended: () => stub.fail('5xx', { reads: ['roles'] }),
      }),
    );

    const heldAfterRollback = stub.environment().roles['member'];

    stub.fail(undefined);

    stub.failWrites(0);

    const afterAddition = await refusal(publish(stub, grantsFile('a', 'b', ['a', 'b', 'd'])));

    const failedPut = stub.writes.at(-1);

    stub.failWrites(undefined);

    expect([
      withoutMs(afterRollback),
      heldAfterRollback,
      afterAddition,
      failedPut,
      await versions(),
      stub.environment().roles,
    ]).toEqual([
      [500, 'Default:Internal', {}, 'number'],
      ['a', 'b', 'c'],
      [503, 'OntologyService:WorkosUnavailable', {}],
      { method: 'PUT', path: PUT, body: { permissions: ['a', 'b'] } },
      [1],
      { member: ['a', 'b', 'c'] },
    ]);

    expect([(await publish(stub, grantsFile('a', 'b', ['a', 'b']))).version, stub.environment().roles]).toEqual([
      1,
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a WorkOS failure in the reconcile after a commit gives 503 with version and reconciled false; a rerun stores no version, reconciles, and passes', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'x']));

    const logs: PublishLog[] = [];

    const failReconcile = {
      ended: () => stub.fail('5xx', { reads: ['roles'] }),
      log: (log: PublishLog) => logs.push(log),
    };

    const error = await thrown(publish(stub, grantsFile('a', 'b', ['a', 'b']), failReconcile));

    const failedLog = logs.at(-1);

    stub.fail(undefined);

    expect([
      withoutMs(error),
      error.headers,
      [failedLog?.outcome, failedLog?.versionBefore, failedLog?.versionAfter],
      await versions(),
      stub.environment().roles,
    ]).toEqual([
      [503, 'OntologyService:WorkosUnavailable', { version: 2, reconciled: false }, 'number'],
      { 'retry-after': '10' },
      ['failed', 1, 2],
      [1, 2],
      { member: ['a', 'b', 'x'] },
    ]);

    const writes = stub.writes.length;

    expect([
      (await publish(stub, grantsFile('a', 'b', ['a', 'b']))).version,
      await versions(),
      stub.writes.slice(writes),
      stub.environment().roles,
    ]).toEqual([2, [1, 2], [{ method: 'PUT', path: PUT, body: { permissions: ['a', 'b'] } }], { member: ['a', 'b'] }]);

    expect(withoutMs(await thrown(publish(stub, grantsFile('a', 'b', ['a', 'b']), failReconcile)))).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
      { version: 2, reconciled: false },
      'number',
    ]);

    stub.fail(undefined);
  });
});

describe('a reconcile that stops between 2 writes', () => {
  it('service/publish#reconcile: a WorkOS failure on the second PUT after a commit gives 503 with version and reconciled false, and the rerun writes only the PUT that failed', async () => {
    const stub = newStub();

    await publish(stub, grantsFile('a', 'b', ['a', 'b', 'x'], { admin: ['a', 'x'] }));

    stub.failWrites(1);

    const error = await thrown(publish(stub, grantsFile('a', 'b', ['a', 'b'], { admin: ['a'] })));

    stub.failWrites(undefined);

    expect([withoutMs(error), await versions(), stub.environment().roles]).toEqual([
      [503, 'OntologyService:WorkosUnavailable', { version: 2, reconciled: false }, 'number'],
      [1, 2],
      { admin: ['a'], member: ['a', 'b', 'x'] },
    ]);

    const writes = stub.writes.length;

    expect([
      (await publish(stub, grantsFile('a', 'b', ['a', 'b'], { admin: ['a'] }))).version,
      await versions(),
      stub.writes.slice(writes),
      stub.environment().roles,
    ]).toEqual([
      2,
      [1, 2],
      [{ method: 'PUT', path: '/authorization/roles/member/permissions', body: { permissions: ['a', 'b'] } }],
      { admin: ['a'], member: ['a', 'b'] },
    ]);
  });
});
