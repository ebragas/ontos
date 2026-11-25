import type { OntologyIr, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workosPublish } from '../auth/index.ts';
import { createPool, type Sql } from '../db/index.ts';
import { createDb, type Db } from '../db/promise.test-utils.ts';
import type { GrantsFile } from '../ontology/index.ts';

import type { CheckedRequest, PublishResponse } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { convertOrThrow, irOf, NS, twinObjectType } from '../ontology/stored.test-utils.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import {
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubWorkos,
  type StubEnvironment,
  type StubWorkos,
} from '../workos.test-utils.ts';
import { APPLY, expectAllOnNewest, OSDK_SET, PUBLISHER, publishOntology } from './publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PRODUCT = 'twin';
const ONTOLOGIES = 'ontology_registry.ontologies';
const VERSIONS = 'ontology_registry.product_versions';
const REQUIRED = { nullabilityV2: { noNulls: true, noEmptyCollections: false }, propertyTypeConstraints: [] };
const SERVICE_PASSWORD = 'reconcile-rollback';

let postgres: TestPostgres;
let serviceRole: string;
let template: string;
let databases = 0;
let admin: pg.Client;
let adminUrl: string;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  postgres = await startPostgres();

  serviceRole = `${postgres.role}_service`;

  await onAdmin(
    postgres.url,
    `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: serviceRole, password: SERVICE_PASSWORD });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  const name = `${postgres.role}_rollback_${++databases}`;

  await onAdmin(postgres.url, `CREATE DATABASE ${name} TEMPLATE ${template}`);

  await onAdmin(postgres.url, `GRANT CREATE ON DATABASE ${name} TO ${serviceRole}`);

  const url = new URL(postgres.url);

  url.pathname = `/${name}`;

  adminUrl = url.toString();

  admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  pool = createPool(url.toString());

  db = createDb(pool);

  await db.query({ text: 'ALTER ROLE CURRENT_USER RESET ALL', values: [] });
});

afterEach(async () => {
  try {
    await expectAllOnNewest(db);
  } finally {
    await Promise.allSettled([admin.end(), pool.end()]);
  }
});

async function onAdmin(url: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

function account(change: (block: OntologyIrObjectTypeBlockDataV2) => void = () => undefined): OntologyIr {
  const block = twinObjectType('Account');
  const phase = block.objectType.propertyTypes['phase'];

  if (phase) phase.status = { type: 'experimental', experimental: {} };

  change(block);

  return irOf(block);
}

const v1 = () => account();

const phaseRequired = () =>
  account((block) => {
    const phase = block.objectType.propertyTypes['phase'];

    if (phase) phase.dataConstraints = REQUIRED;
  });

const withRegion = () =>
  account((block) => {
    const phase = block.objectType.propertyTypes['phase'];

    if (phase) block.objectType.propertyTypes['region'] = { ...phase, apiName: 'region' };
  });

function grants(roles: Readonly<Record<string, readonly string[]>>): GrantsFile {
  const slugs = [...new Set(Object.values(roles).flat())].filter((slug) => !slug.startsWith('ontology:')).sort();

  return {
    permissions: Object.fromEntries(slugs.map((slug) => [slug, { description: `Use ${slug}` }])),
    objectTypes: { [ACCOUNT]: 'a' },
    actionTypes: {},
    defaultRoles: roles,
  };
}

interface Options {
  readonly between?: () => Promise<unknown>;
  readonly ended?: () => void;
  readonly on?: Db;
}

function publish(
  ir: OntologyIr,
  file: unknown,
  stub: StubWorkos | undefined,
  options: Options = {},
): Promise<PublishResponse> {
  const on = options.on ?? db;

  const request = {
    product: PRODUCT,
    ir: JSON.parse(JSON.stringify(ir)),
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: file,
    validateOnly: false,
  };

  const hooked: Db = {
    ...on,
    transaction: async (run) => {
      await options.between?.();

      try {
        return await on.transaction(run);
      } finally {
        options.ended?.();
      }
    },
  };

  return publishOntology(hooked, {
    product: PRODUCT,
    productRid: TEST_ONTOLOGY_RID,
    ontology: convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, 1),
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- A test stores a grants file that does not parse, which a checked request cannot hold.
    request: request as unknown as CheckedRequest,
    publisher: PUBLISHER,
    mode: APPLY,
    ...(stub ? { workos: workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }) } : {}),
  });
}

function newStub(environment?: StubEnvironment): StubWorkos {
  return stubWorkos(
    [STUB_PERSON],
    [{ user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['member'] }],
    { roles: {}, ...(environment ? { environment } : {}) },
  );
}

function roles(stub: StubWorkos): Record<string, string[]> {
  return Object.fromEntries(Object.entries(stub.environment().roles).map(([slug, held]) => [slug, [...held].sort()]));
}

async function setRole(stub: StubWorkos, role: string, permissions: readonly string[]): Promise<void> {
  const answer = await stub.fetch(`https://api.workos.com/authorization/roles/${role}/permissions`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${STUB_WORKOS_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ permissions }),
  });

  expect(answer.status).toBe(200);
}

interface Installed {
  readonly rid: string;
  readonly table: string;
}

async function install(apiName: string): Promise<Installed> {
  const rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`;

  await installOntology(db, { rid, product: PRODUCT, apiName, displayName: apiName, organization: ORGANIZATION });

  const { rows } = await admin.query<{ number: number }>(`SELECT number FROM ${ONTOLOGIES} WHERE rid = $1`, [rid]);

  const table = `ontology_${rows[0]?.number ?? 0}_objects.account`;

  for (const [id, name, phase] of [
    ['a1', 'Acme', 'lead'],
    ['a2', 'Bolt', 'won'],
  ]) {
    await admin.query(`INSERT INTO ${table} (account_id, name, phase) VALUES ($1, $2, $3)`, [id, name, phase]);
  }

  return { rid, table };
}

async function three(): Promise<[Installed, Installed, Installed]> {
  return [await install('first'), await install('middle'), await install('last')];
}

async function versions(): Promise<number[]> {
  return (await admin.query<{ version: number }>(`SELECT version FROM ${VERSIONS} ORDER BY version`)).rows.map(
    (row) => row.version,
  );
}

interface Thrown {
  readonly status?: number;
  readonly errorName?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

async function failure(call: Promise<unknown>): Promise<Thrown> {
  return (await call.then(
    () => ({ errorName: 'The call passed.' }),
    (error: unknown) => error,
  )) as Thrown;
}

function shape(error: Thrown): unknown[] {
  const { transactionMs, ...rest } = error.parameters ?? {};

  return [error.status, error.errorName, rest, typeof transactionMs];
}

async function holding(lock: string): Promise<pg.Client> {
  const other = new pg.Client({ connectionString: adminUrl });

  await other.connect();

  await other.query('BEGIN');

  await other.query(lock);

  return other;
}

async function release(other: pg.Client): Promise<void> {
  await other.query('ROLLBACK').catch(() => undefined);

  await other.end();
}

async function lockWaitPublish(
  row: Installed,
  ir: OntologyIr,
  file: GrantsFile,
  stub: StubWorkos,
  options: Options = {},
): Promise<Thrown> {
  const other = await holding(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = '${row.rid}' FOR UPDATE`);

  try {
    return await failure(publish(ir, file, stub, options));
  } finally {
    await release(other);
  }
}

const G1 = grants({ member: ['a', 'b'] });

describe('the reconcile after a real rollback', () => {
  it('service/publish#reconcile: bad data in the middle installation: each stored role equals the newest grants file, a new role is not created, and another app role is not touched', async () => {
    const stub = newStub({ permissions: { z: null }, roles: { otherapp: ['a', 'z'] } });

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    await setRole(stub, 'member', ['a', 'b', 'z']);

    const error = await failure(
      publish(phaseRequired(), grants({ member: ['a', 'b', 'c'], viewer: ['a'] }), stub, {
        between: () => admin.query(`UPDATE ${middle.table} SET phase = NULL WHERE account_id = 'a1'`),
      }),
    );

    expect([shape(error), await versions(), roles(stub)]).toEqual([
      [400, 'Default:InvalidArgument', expect.objectContaining({ ontologyRid: middle.rid }), 'number'],
      [1],
      { otherapp: ['a', 'z'], member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a lock wait on the registry row of the middle installation leaves each role as the newest stored grants file gives it', async () => {
    const stub = newStub();

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const error = await lockWaitPublish(middle, withRegion(), grants({ member: ['a', 'b', 'c'], viewer: ['a'] }), stub);

    expect([error.status, error.errorName, await versions(), roles(stub)]).toEqual([
      409,
      'PublishLockTimeout',
      [1],
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: a first publish that waits for the lock of the product versions creates no role', async () => {
    const stub = newStub();

    const other = await holding(`LOCK TABLE ${VERSIONS} IN EXCLUSIVE MODE`);

    let error: Thrown;

    try {
      error = await failure(publish(v1(), G1, stub));
    } finally {
      await release(other);
    }

    expect([error.status, error.errorName, await versions(), roles(stub)]).toEqual([409, 'PublishLockTimeout', [], {}]);
  });

  it('service/publish#reconcile: a WorkOS role that existed before, and that the publish names, is untouched by a rollback', async () => {
    const stub = newStub({ permissions: { p0: null }, roles: { admin: ['p0'] } });

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const error = await lockWaitPublish(middle, withRegion(), grants({ member: ['a', 'b'], admin: ['a', 'p0'] }), stub);

    expect([error.status, await versions(), roles(stub)]).toEqual([409, [1], { admin: ['p0'], member: ['a', 'b'] }]);
  });
});

describe('a WorkOS failure at each point of a publish that rolls back', () => {
  it('service/publish#reconcile: the read of the reconcile fails after a rollback, then a rerun rolls back, then a commit drops the role: the new role never exists', async () => {
    const stub = newStub();

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const G2 = grants({ member: ['a', 'b'], viewer: ['a'] });

    const first = await lockWaitPublish(middle, withRegion(), G2, stub, {
      ended: () => stub.fail('5xx', { reads: ['roles'] }),
    });

    stub.fail(undefined);

    const afterFirst = roles(stub);

    const second = await lockWaitPublish(middle, withRegion(), G2, stub);

    const afterRerun = roles(stub);

    const third = await publish(withRegion(), G1, stub);

    expect([first.status, second.status, third.version, await versions()]).toEqual([409, 409, 2, [1, 2]]);

    expect({ afterFirst, afterRerun, afterCommit: roles(stub) }).toEqual({
      afterFirst: { member: ['a', 'b'] },
      afterRerun: { member: ['a', 'b'] },
      afterCommit: { member: ['a', 'b'] },
    });
  });

  it('service/publish#reconcile: the same failures on a WorkOS role that existed before: admin keeps only p0', async () => {
    const stub = newStub({ permissions: { p0: null }, roles: { admin: ['p0'] } });

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const G2 = grants({ member: ['a', 'b'], admin: ['a', 'b'] });

    await lockWaitPublish(middle, withRegion(), G2, stub, { ended: () => stub.fail('5xx', { reads: ['roles'] }) });

    stub.fail(undefined);

    const afterFirst = roles(stub)['admin'];

    await lockWaitPublish(middle, withRegion(), G2, stub);

    const afterRerun = roles(stub)['admin'];

    await publish(withRegion(), G1, stub);

    expect({ afterFirst, afterRerun, afterCommit: roles(stub)['admin'] }).toEqual({
      afterFirst: ['p0'],
      afterRerun: ['p0'],
      afterCommit: ['p0'],
    });
  });

  it('service/publish#reconcile: a rerun that fails at the check runs no reconcile, and the new role does not exist', async () => {
    const stub = newStub();

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const G2 = grants({ member: ['a', 'b'], viewer: ['a'] });
    const bad = () => admin.query(`UPDATE ${middle.table} SET phase = NULL WHERE account_id = 'a1'`);

    const first = await failure(
      publish(phaseRequired(), G2, stub, { between: bad, ended: () => stub.fail('5xx', { reads: ['roles'] }) }),
    );

    stub.fail(undefined);

    const writes = stub.writes.length;

    const second = await failure(publish(phaseRequired(), G2, stub));

    expect([
      first.status,
      second.status,
      'transactionMs' in (second.parameters ?? {}),
      stub.writes.length - writes,
      roles(stub),
    ]).toEqual([400, 400, false, 0, { member: ['a', 'b'] }]);
  });

  it('service/publish#reconcile: the additions fail halfway and each later write fails, then a rerun rolls back, then a commit drops the role: the new role never exists', async () => {
    const stub = newStub();

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const G2 = grants({ member: ['a', 'b', 'c'], viewer: ['a', 'b'] });

    stub.failWrites(1);

    const first = await failure(publish(withRegion(), G2, stub));

    stub.failWrites(undefined);

    const afterFirst = roles(stub);

    await lockWaitPublish(middle, withRegion(), G2, stub);

    const afterRerun = roles(stub);

    await publish(withRegion(), G1, stub);

    expect([first.status, first.errorName, afterFirst, afterRerun, roles(stub)]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
      { member: ['a', 'b'] },
      { member: ['a', 'b'] },
      { member: ['a', 'b'] },
    ]);
  });

  it('service/publish#reconcile: the reconcile after a rollback fails between its 2 writes, and a rerun that rolls back again repairs each stored role', async () => {
    const stub = newStub();

    await publish(v1(), grants({ member: ['a', 'b'], admin: ['a'] }), stub);

    const [, middle] = await three();

    const G2 = grants({ member: ['a', 'b', 'c'], admin: ['a', 'c'], viewer: ['a'] });
    const before = stub.writes.length;

    stub.failWrites(5);

    const first = await lockWaitPublish(middle, withRegion(), G2, stub);

    stub.failWrites(undefined);

    const afterFirst = roles(stub);
    const reconcileWrites = stub.writes.slice(before + 4).map((write) => [write.path, write.body]);

    await lockWaitPublish(middle, withRegion(), G2, stub);

    expect([first.status, reconcileWrites, afterFirst]).toEqual([
      409,
      [
        ['/authorization/roles/admin/permissions', { permissions: ['a'] }],
        ['/authorization/roles/member/permissions', { permissions: ['a', 'b'] }],
      ],
      { admin: ['a'], member: ['a', 'b', 'c'] },
    ]);

    expect(roles(stub)).toEqual({ admin: ['a'], member: ['a', 'b'] });
  });

  it('service/publish#reconcile: after a rollback whose reconcile read failed, a rerun that commits creates the new role with its list', async () => {
    const stub = newStub();

    await publish(v1(), G1, stub);

    const [, middle] = await three();

    const G2 = grants({ member: ['a', 'b'], viewer: ['a'] });

    await lockWaitPublish(middle, withRegion(), G2, stub, { ended: () => stub.fail('5xx', { reads: ['roles'] }) });

    stub.fail(undefined);

    const afterFirst = roles(stub);

    const rerun = await publish(withRegion(), G2, stub);

    expect([afterFirst, rerun.version, await versions(), roles(stub)]).toEqual([
      { member: ['a', 'b'] },
      2,
      [1, 2],
      { member: ['a', 'b'], viewer: ['a'] },
    ]);
  });
});

describe('the reconcile with a fault or a file that does not parse', () => {
  it('a Postgres fault on the read of the reconcile after a commit gives 500 Default:Internal, and the version is stored', async () => {
    const stub = newStub();

    await publish(v1(), G1, stub);

    await three();

    let ended = false;

    const faulty: Db = {
      ...db,
      query: (statement: Sql) =>
        ended && statement.text.startsWith('SELECT grants FROM')
          ? Promise.reject(Object.assign(new Error('terminating connection'), { code: '57P01' }))
          : db.query(statement),
    } as Db;

    const error = await failure(publish(withRegion(), G1, stub, { on: faulty, ended: () => (ended = true) }));

    expect([shape(error), await versions()]).toEqual([
      [500, 'Default:Internal', {}, 'number'],
      [1, 2],
    ]);
  });

  it('service/publish#reconcile: when the newest grants file does not parse, a rollback adds nothing to a role, and the reconcile changes nothing', async () => {
    const stub = newStub({ permissions: { a: null, b: null }, roles: { member: ['a', 'b'] } });

    await publish(v1(), { roles: [], objectTypes: {}, actionTypes: {} }, undefined);

    const [, middle] = await three();

    const error = await lockWaitPublish(middle, withRegion(), grants({ member: ['a', 'b', 'c'] }), stub);

    expect([error.status, await versions(), roles(stub)]).toEqual([409, [1], { member: ['a', 'b'] }]);
  });

  it('service/publish#reconcile: a publish with the same parts stores no version and runs the reconcile, and a second one writes nothing', async () => {
    const stub = newStub({ permissions: { z0: null }, roles: {} });

    await publish(v1(), G1, stub);

    await three();

    await setRole(stub, 'member', ['a', 'b', 'z0']);

    const before = stub.writes.length;

    const first = await publish(v1(), G1, stub);

    const firstWrites = stub.writes.slice(before);
    const middle = stub.writes.length;

    const second = await publish(v1(), G1, stub);

    expect([
      first.version,
      second.version,
      await versions(),
      firstWrites,
      stub.writes.length - middle,
      roles(stub),
    ]).toEqual([
      1,
      1,
      [1],
      [{ method: 'PUT', path: '/authorization/roles/member/permissions', body: { permissions: ['a', 'b'] } }],
      0,
      { member: ['a', 'b'] },
    ]);
  });
});
