import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb as createFallibleDb,
  createPool,
  type Db as FallibleDb,
  type DbFailure,
  type Sql,
} from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import { settle, type AsyncFallible } from '../errors/index.ts';

import { installOntology } from '../install.test-utils.ts';
import { readOwners, remap, type RemapInput } from './remap.ts';
import { convertOrThrow, grantsOf, irOf, NS, twinObjectType, USE } from '../ontology/stored.test-utils.ts';
import { handle } from '../handler/index.ts';
import { createEngineTemplate, startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { noUsers, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { createTestIssuer, PERSON, type TestIssuer } from '../tokens.test-utils.ts';
import { onNewConnection, OSDK_SET, sql, waitForLockWaits, expectAllOnNewest } from './publish.test-utils.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import { STUB_PERSON, stubPublish, stubUsers } from '../workos.test-utils.ts';

const NO_PERMISSION = 'user_01HN0PERM1SS10N00000000NP';

const ONTOLOGIES = 'ontology_registry.ontologies';
const PRODUCT = 'twin';
const BRANCH = 'br-staging-0001';
const ACME = 'org_ACME';
const BOLT = 'org_BOLT';
const ACME_MIRROR = 'org_ACME_MIRROR';
const BOLT_MIRROR = 'org_BOLT_MIRROR';
const SERVICE_PASSWORD = 'remap-role-test-only';
const PRODUCTION_USER = 'user_01PRODUCTION0000000000000';

let postgres: TestPostgres;
let issuer: TestIssuer;
let serviceRole: string;
let template: string;
let databases = 0;
let databaseName: string;
let admin: pg.Client;
let adminUrl: string;
let serviceUrl: string;
let pool: pg.Pool;
let db: Db;
let fallible: FallibleDb;

async function ranOf<T>(run: AsyncFallible<T, DbFailure>): Promise<T> {
  const result = await settle(run);

  if (!result.ok) throw result.error.error;

  return result.value;
}

const remapped = (on: FallibleDb, request: RemapInput) => ranOf(remap(on, request));

beforeAll(async () => {
  postgres = await startPostgres();

  issuer = await createTestIssuer(testSettings.auth);

  serviceRole = `${postgres.role}_service`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${serviceRole} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  template = await createEngineTemplate(postgres.url, { name: serviceRole, password: SERVICE_PASSWORD });
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  databaseName = `${postgres.role}_remap_${++databases}`;

  await onNewConnection(postgres.url, `CREATE DATABASE ${databaseName} TEMPLATE ${template}`);

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${databaseName} TO ${serviceRole}`);

  await onNewConnection(postgres.url, `ALTER DATABASE ${databaseName} SET neon.branch_id = '${BRANCH}'`);

  const url = new URL(postgres.url);

  url.pathname = `/${databaseName}`;

  adminUrl = url.toString();

  admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  url.username = serviceRole;
  url.password = SERVICE_PASSWORD;

  serviceUrl = url.toString();

  pool = createPool(serviceUrl);

  db = createDb(pool);

  fallible = createFallibleDb(pool);

  const metadata = convertOrThrow(
    { ir: irOf(twinObjectType('Account')), osdkSet: OSDK_SET, validateOnly: false },
    TEST_ONTOLOGY_RID,
    1,
  ).metadata;

  await admin.query(
    `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
     VALUES ($1, 1, $2::jsonb, $3::jsonb, '{"migrations":[]}'::jsonb, $4::jsonb, NULL, $5::jsonb, 'test')`,
    [
      PRODUCT,
      JSON.stringify(irOf(twinObjectType('Account'))),
      JSON.stringify(metadata),
      JSON.stringify(OSDK_SET),
      JSON.stringify(grantsOf(irOf(twinObjectType('Account')))),
    ],
  );
});

afterEach(async () => {
  await expectAllOnNewest(db);

  await admin.end();

  await pool.end();
});

async function install(apiName: string, organization: string | null): Promise<string> {
  const rid = `ri.ontology.main.ontology.${crypto.randomUUID()}`;

  await installOntology(db, {
    rid,
    product: PRODUCT,
    apiName,
    displayName: `The ${apiName} display name`,
    organization: organization ?? 'org_NONE',
  });

  if (organization === null) await admin.query(`UPDATE ${ONTOLOGIES} SET organization = NULL WHERE rid = $1`, [rid]);

  const { rows } = await admin.query<{ number: number }>(`SELECT number FROM ${ONTOLOGIES} WHERE rid = $1`, [rid]);

  const number = rows[0]?.number;

  await admin.query(
    `INSERT INTO ontology_${number}_objects.account (account_id, name, phase) VALUES ('a1', $1, 'lead')`,
    [apiName],
  );

  await admin.query(
    `INSERT INTO ontology_${number}_engine.edit_history (object_type, primary_key, entry) VALUES ('Account', 'a1', $1::jsonb)`,
    [JSON.stringify({ userId: PRODUCTION_USER, action: 'edit-account' })],
  );

  return rid;
}

async function registry(): Promise<Record<string, unknown>[]> {
  return (await admin.query(`SELECT * FROM ${ONTOLOGIES} ORDER BY number`)).rows;
}

function withoutOrganization(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'organization')));
}

async function owners(): Promise<{ api_name: string; organization: string | null }[]> {
  return (
    await admin.query<{ api_name: string; organization: string | null }>(
      `SELECT api_name, organization FROM ${ONTOLOGIES} ORDER BY number`,
    )
  ).rows;
}

async function schemaRows(): Promise<Record<string, unknown[]>> {
  const { rows: tables } = await admin.query<{ name: string }>(
    `SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
     WHERE table_schema ~ '^ontology_[0-9]+_(objects|engine)$' ORDER BY 1`,
  );

  const out: Record<string, unknown[]> = {};

  for (const { name } of tables)
    out[name] = (await admin.query(`SELECT to_jsonb(t) AS row FROM ${name} t ORDER BY to_jsonb(t)::text`)).rows.map(
      (row) => row.row,
    );

  return out;
}

const input = (mirrors: Record<string, string>, extra: Partial<RemapInput> = {}): RemapInput => ({
  mirrors: new Map(Object.entries(mirrors)),
  branchId: BRANCH,
  ...extra,
});

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

async function seed(): Promise<{ acme1: string; acme2: string; bolt: string; none: string }> {
  const acme1 = await install('alpha', ACME);

  const bolt = await install('alpha', BOLT);

  const acme2 = await install('beta', ACME);

  const none = await install('gamma', null);

  return { acme1, acme2, bolt, none };
}

describe('readOwners', () => {
  it('service/storage#remap: gives each distinct owner of the registry once, with no row that has no owner', async () => {
    await seed();

    expect(await ranOf(readOwners(fallible))).toEqual([ACME, BOLT]);
  });

  it('service/storage#remap: an owner that is the empty text is no owner', async () => {
    await seed();

    await install('epsilon', '');

    expect(await ranOf(readOwners(fallible))).toEqual([ACME, BOLT]);
  });
});

describe('an owner that is the empty text', () => {
  it('service/storage#remap: the remap does not change its row, even when the mirrors name the empty text', async () => {
    await seed();

    const empty = await install('epsilon', '');

    const before = await registry();

    expect(await remapped(fallible, input({ '': 'org_EMPTY_MIRROR' }))).toEqual({
      kind: 'remapped',
      remapped: [],
      clashes: [],
    });

    expect(await registry()).toEqual(before);

    expect((await registry()).find((r) => r['rid'] === empty)?.['organization']).toBe('');
  });
});

describe('remap', () => {
  it('service/storage#remap: with 1 mirrored owner, only the rows of that owner change, only in organization, and the row with no owner and the other owner stay', async () => {
    const { acme1, acme2 } = await seed();

    const before = await registry();

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }))).toEqual({
      kind: 'remapped',
      remapped: [
        { ontologyRid: acme1, apiName: 'alpha', from: ACME, to: ACME_MIRROR },
        { ontologyRid: acme2, apiName: 'beta', from: ACME, to: ACME_MIRROR },
      ],
      clashes: [],
    });

    expect(await owners()).toEqual([
      { api_name: 'alpha', organization: ACME_MIRROR },
      { api_name: 'alpha', organization: BOLT },
      { api_name: 'beta', organization: ACME_MIRROR },
      { api_name: 'gamma', organization: null },
    ]);

    const after = await registry();

    expect(withoutOrganization(after)).toEqual(withoutOrganization(before));
  });

  it('service/storage#remap: after the remap, a token of the Mirror Organization reads fullMetadata of the copy, and a token of the production owner gets 404', async () => {
    const { acme1 } = await seed();

    const read = async (organization: string): Promise<number> => {
      const token = await issuer.workos({ org_id: organization });

      const request = new Request(`http://localhost/api/v2/ontologies/${acme1}/fullMetadata`, {
        headers: { authorization: `Bearer ${token}` },
      });

      return (
        await buffered(
          handle(request, {
            db: fallibleOf(db),
            directDb: fallibleOf(db),
            settings: testSettings,
            keys: issuer.keys,
            users: noUsers,
            workos: stubPublish(),
          }),
        )
      ).status;
    };

    expect([await read(ACME), await read(ACME_MIRROR)]).toEqual([200, 404]);

    await remapped(fallible, input({ [ACME]: ACME_MIRROR }));

    expect([await read(ACME_MIRROR), await read(ACME)]).toEqual([200, 404]);
  });

  it('service/storage#remap: with 2 mirrored owners, each row of each owner moves to its own Mirror Organization', async () => {
    const { acme1, acme2, bolt } = await seed();

    await admin.query(`UPDATE ${ONTOLOGIES} SET held = false WHERE rid = $1`, [acme1]);

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR, [BOLT]: BOLT_MIRROR }))).toEqual({
      kind: 'remapped',
      remapped: [
        { ontologyRid: acme1, apiName: 'alpha', from: ACME, to: ACME_MIRROR },
        { ontologyRid: bolt, apiName: 'alpha', from: BOLT, to: BOLT_MIRROR },
        { ontologyRid: acme2, apiName: 'beta', from: ACME, to: ACME_MIRROR },
      ],
      clashes: [],
    });

    expect(await owners()).toEqual([
      { api_name: 'alpha', organization: ACME_MIRROR },
      { api_name: 'alpha', organization: BOLT_MIRROR },
      { api_name: 'beta', organization: ACME_MIRROR },
      { api_name: 'gamma', organization: null },
    ]);
  });

  it('service/storage#remap: with no mirrored owner, the remap changes no row', async () => {
    await seed();

    const before = await registry();

    expect(await remapped(fallible, input({}))).toEqual({ kind: 'remapped', remapped: [], clashes: [] });

    expect(await registry()).toEqual(before);
  });

  it('service/deployment#projects-and-environments: after the remap, a member of the Mirror Organization reads the copy with the permissions of its role, and the copy keeps each User ID', async () => {
    const { acme1 } = await seed();

    await remapped(fallible, input({ [ACME]: ACME_MIRROR }));

    const users = stubUsers(
      [STUB_PERSON, { ...STUB_PERSON, id: NO_PERMISSION, email: 'none@example.com' }],
      [
        { user_id: PERSON, organization_id: ACME_MIRROR, status: 'active', roles: ['member'] },
        { user_id: NO_PERMISSION, organization_id: ACME_MIRROR, status: 'active', roles: ['org-none'] },
      ],
      { roles: { [ACME_MIRROR]: { member: [USE], 'org-none': [] } } },
    );

    const call = async (sub: string, path: string, body: unknown) => {
      const token = await issuer.workos({ sub, org_id: ACME_MIRROR });

      const request = new Request(`http://localhost/api/v2/ontologies/${acme1}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const response = await handle(request, {
        db: fallibleOf(db),
        directDb: fallibleOf(db),
        settings: testSettings,
        keys: issuer.keys,
        users,
        workos: stubPublish(),
      });

      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const ACCOUNT = `${NS}Account`;

    const loaded = await call(PERSON, '/objectSets/loadObjects', {
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: ['accountId', 'name'],
    });

    expect([
      loaded.status,
      (loaded.body['data'] as Record<string, unknown>[]).map(({ accountId, name }) => ({ accountId, name })),
    ]).toEqual([200, [{ accountId: 'a1', name: 'alpha' }]]);

    const refused = await call(NO_PERMISSION, '/objectSets/loadObjects', {
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: ['accountId'],
    });

    expect([refused.status, refused.body['errorName']]).toEqual([404, 'ObjectTypeNotFound']);

    const {
      rows: [registered],
    } = await admin.query<{ engine_schema: string }>(`SELECT engine_schema FROM ${ONTOLOGIES} WHERE rid = $1`, [acme1]);

    const rows = await admin.query<{ entry: unknown }>(
      `SELECT entry FROM ${registered?.engine_schema ?? ''}.edit_history`,
    );

    expect(rows.rows.map(({ entry }) => entry)).toEqual([{ userId: PRODUCTION_USER, action: 'edit-account' }]);
  });

  it('each column of the registry and each row of the 2 schemas stays, except organization, so each User ID of the copied data stays', async () => {
    await seed();

    await admin.query(`UPDATE ${ONTOLOGIES} SET held = true WHERE api_name = 'beta'`);

    const registryBefore = await registry();

    const rowsBefore = await schemaRows();

    expect(Object.keys(rowsBefore)).toHaveLength(8);

    expect(
      Object.entries(rowsBefore)
        .filter(([table]) => table.endsWith('.edit_history'))
        .map(([, rows]) => rows),
    ).toEqual(
      Array.from({ length: 4 }, () => [
        expect.objectContaining({ entry: { userId: PRODUCTION_USER, action: 'edit-account' } }),
      ]),
    );

    await remapped(fallible, input({ [ACME]: ACME_MIRROR, [BOLT]: BOLT_MIRROR }));

    expect(await schemaRows()).toEqual(rowsBefore);

    const registryAfter = await registry();

    expect(registryAfter.map((row) => row['organization'])).toEqual([ACME_MIRROR, BOLT_MIRROR, ACME_MIRROR, null]);
    expect(withoutOrganization(registryAfter)).toEqual(withoutOrganization(registryBefore));
  });

  it('service/storage#remap: a second remap with the same Mirror Organizations changes no row', async () => {
    await seed();

    await remapped(fallible, input({ [ACME]: ACME_MIRROR }));

    const before = await registry();

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }))).toEqual({
      kind: 'remapped',
      remapped: [],
      clashes: [],
    });

    expect(await registry()).toEqual(before);
  });

  it('service/storage#remap: a row whose Mirror Organization already has an Ontology of its API name stays and is a clash, and the other rows commit', async () => {
    const { acme1, acme2 } = await seed();

    const taken = await install('alpha', ACME_MIRROR);

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }))).toEqual({
      kind: 'remapped',
      remapped: [{ ontologyRid: acme2, apiName: 'beta', from: ACME, to: ACME_MIRROR }],
      clashes: [{ ontologyRid: acme1, apiName: 'alpha', organization: ACME, mirror: ACME_MIRROR }],
    });

    expect(await owners()).toEqual([
      { api_name: 'alpha', organization: ACME },
      { api_name: 'alpha', organization: BOLT },
      { api_name: 'beta', organization: ACME_MIRROR },
      { api_name: 'gamma', organization: null },
      { api_name: 'alpha', organization: ACME_MIRROR },
    ]);

    expect((await registry()).filter((row) => row['organization'] === ACME_MIRROR).map((row) => row['rid'])).toEqual([
      acme2,
      taken,
    ]);
  });

  it('service/storage#remap: 2 rows of 1 owner with 1 API name give 1 remapped row and 1 clash, in the order of the registry number', async () => {
    const first = await install('alpha', ACME);

    const second = await install('beta', ACME);

    await admin.query(`UPDATE ${ONTOLOGIES} SET api_name = 'alpha' WHERE rid = $1`, [second]);

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }))).toEqual({
      kind: 'remapped',
      remapped: [{ ontologyRid: first, apiName: 'alpha', from: ACME, to: ACME_MIRROR }],
      clashes: [{ ontologyRid: second, apiName: 'alpha', organization: ACME, mirror: ACME_MIRROR }],
    });
  });

  it('service/storage#remap: the remap waits for a second connection that holds lockProductVersions, then remaps', async () => {
    const { acme1, acme2 } = await seed();

    const other = await holding('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

    try {
      const running = remapped(fallible, input({ [ACME]: ACME_MIRROR }));

      await waitForLockWaits(db, 1);

      expect((await owners()).map((row) => row.organization)).toEqual([ACME, BOLT, ACME, null]);

      await release(other);

      expect(await running).toMatchObject({
        kind: 'remapped',
        remapped: [{ ontologyRid: acme1 }, { ontologyRid: acme2 }],
      });
    } finally {
      await release(other);
    }
  });

  it('service/storage#remap: 2 remaps at once end in the rows of 1 remap, and only 1 of them changes a row', async () => {
    await seed();

    const other = await holding('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

    try {
      const first = remapped(fallible, input({ [ACME]: ACME_MIRROR }));
      const second = remapped(fallible, input({ [ACME]: ACME_MIRROR }));

      await waitForLockWaits(db, 2);

      await release(other);

      const results = await Promise.all([first, second]);

      const counts = results.map((result) =>
        result.kind === 'remapped'
          ? `${result.remapped.length} remapped, ${result.clashes.length} clashes`
          : result.errorName,
      );

      expect(counts.sort()).toEqual(['0 remapped, 0 clashes', '2 remapped, 0 clashes']);
    } finally {
      await release(other);
    }

    expect((await owners()).map((row) => row.organization)).toEqual([ACME_MIRROR, BOLT, ACME_MIRROR, null]);
  });

  it('service/storage#remap: with no lockTimeout, the transaction sets lock_timeout 90s and statement_timeout 120s as their own statements, reads the branch, then takes lockProductVersions', async () => {
    await seed();

    const statements: Sql[] = [];
    const settings: unknown[] = [];

    const recording = (inner: FallibleDb): FallibleDb => ({
      query: (statement) => (statements.push(statement), inner.query(statement)),
      stream: (statement) => inner.stream(statement),
      transaction: <T, E>(run: (tx: FallibleDb) => AsyncFallible<T, E>) =>
        inner.transaction(async function* (tx): AsyncFallible<T, E | DbFailure> {
          const result = yield* run(recording(tx));

          settings.push(
            ...(yield* tx.query(
              sql(
                "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
              ),
            )),
          );

          return result;
        }),
      snapshot: (run) => inner.snapshot(run),
    });

    const single = createPool(serviceUrl, { max: 1 });
    const one = createFallibleDb(single);

    try {
      expect(await remapped(recording(one), input({ [ACME]: ACME_MIRROR }))).toMatchObject({ kind: 'remapped' });

      expect(
        await ranOf(
          one.query(
            sql(
              "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
            ),
          ),
        ),
      ).toEqual([{ lock_timeout: '0', statement_timeout: '0' }]);
    } finally {
      await single.end();
    }

    expect(settings).toEqual([{ lock_timeout: '90s', statement_timeout: '2min' }]);

    expect(statements.slice(0, 4)).toEqual([
      { text: "SELECT set_config('lock_timeout', $1, true)", values: ['90s'] },
      { text: "SELECT set_config('statement_timeout', '120s', true)", values: [] },
      { text: "SELECT current_setting('neon.branch_id', true) AS branch", values: [] },
      { text: 'LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE', values: [] },
    ]);
  });

  it('service/storage#remap: when the lock wait ends, the remap changes nothing and gives PublishLockTimeout, and a repeat after the lock ends remaps', async () => {
    await seed();

    const before = await registry();

    const other = await holding('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

    try {
      expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }, { lockTimeout: '300ms' }))).toEqual({
        kind: 'refused',
        errorName: 'PublishLockTimeout',
      });

      expect(await registry()).toEqual(before);
    } finally {
      await release(other);
    }

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }, { lockTimeout: '300ms' }))).toMatchObject({
      kind: 'remapped',
      clashes: [],
    });

    expect((await owners()).map((row) => row.organization)).toEqual([ACME_MIRROR, BOLT, ACME_MIRROR, null]);
  });
});

describe('a deadlock', () => {
  it('service/storage#remap: a deadlock with a second connection gives PublishLockTimeout, and changes no row', async () => {
    const { bolt } = await seed();

    const before = await registry();

    const other = await holding(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = '${bolt}' FOR UPDATE`);

    try {
      await other.query("SET deadlock_timeout = '30s'");

      const running = remapped(fallible, input({ [ACME]: ACME_MIRROR, [BOLT]: BOLT_MIRROR }, { lockTimeout: '20s' }));

      await waitForLockWaits(db, 1);

      const second = other.query('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

      expect(await running).toEqual({ kind: 'refused', errorName: 'PublishLockTimeout' });

      await second;
    } finally {
      await release(other);
    }

    expect(await registry()).toEqual(before);
  });
});

describe('the branch guard', () => {
  it('service/storage#remap: a role that is not a superuser reads neon.branch_id of the database with current_setting', async () => {
    const { rows } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [serviceRole],
    );

    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    expect(
      await db.query(sql("SELECT current_user AS role, current_setting('neon.branch_id', true) AS branch")),
    ).toEqual([{ role: serviceRole, branch: BRANCH }]);
  });

  it('service/storage#remap: an equal branch remaps', async () => {
    await seed();

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }, { branchId: BRANCH }))).toMatchObject({
      kind: 'remapped',
      clashes: [],
    });

    expect((await owners()).map((row) => row.organization)).toEqual([ACME_MIRROR, BOLT, ACME_MIRROR, null]);
  });

  it('service/storage#remap: a different branch changes no row, and names both branches', async () => {
    await seed();

    const before = await registry();

    expect(await remapped(fallible, input({ [ACME]: ACME_MIRROR }, { branchId: 'br-production-0002' }))).toEqual({
      kind: 'refused',
      errorName: 'WrongBranch',
      setting: BRANCH,
      branchId: 'br-production-0002',
    });

    expect(await registry()).toEqual(before);
  });

  it('service/storage#remap: with no neon.branch_id, the remap changes no row', async () => {
    await seed();

    const before = await registry();

    await admin.query(`ALTER DATABASE ${databaseName} RESET neon.branch_id`);

    const fresh = createPool(serviceUrl);

    try {
      expect(await remapped(createFallibleDb(fresh), input({ [ACME]: ACME_MIRROR }))).toEqual({
        kind: 'refused',
        errorName: 'WrongBranch',
        setting: null,
        branchId: BRANCH,
      });
    } finally {
      await fresh.end();
    }

    expect(await registry()).toEqual(before);
  });

  it.each([
    ['a setting that differs only in letter case', 'BR-STAGING-0001', BRANCH],
    ['a setting with a leading space', ` ${BRANCH}`, BRANCH],
    ['a setting with a trailing space', `${BRANCH} `, BRANCH],
    ['a NEON_BRANCH_ID with a trailing space', BRANCH, `${BRANCH} `],
    ['a setting that starts with the branch ID', `${BRANCH}x`, BRANCH],
    ['a branch ID that starts with the setting', BRANCH, `${BRANCH}x`],
  ])('service/storage#remap: %s refuses, and changes no row', async (_, setting, branchId) => {
    await seed();

    const before = await registry();

    await admin.query(`ALTER DATABASE ${databaseName} SET neon.branch_id = '${setting}'`);

    const fresh = createPool(serviceUrl);

    try {
      expect(await remapped(createFallibleDb(fresh), input({ [ACME]: ACME_MIRROR }, { branchId }))).toEqual({
        kind: 'refused',
        errorName: 'WrongBranch',
        setting,
        branchId,
      });
    } finally {
      await fresh.end();
    }

    expect(await registry()).toEqual(before);
  });

  it('service/storage#remap: an empty neon.branch_id does not match an empty NEON_BRANCH_ID', async () => {
    await seed();

    const before = await registry();

    await admin.query(`ALTER DATABASE ${databaseName} SET neon.branch_id = ''`);

    const fresh = createPool(serviceUrl);

    try {
      expect(await remapped(createFallibleDb(fresh), input({ [ACME]: ACME_MIRROR }, { branchId: '' }))).toEqual({
        kind: 'refused',
        errorName: 'WrongBranch',
        setting: '',
        branchId: '',
      });
    } finally {
      await fresh.end();
    }

    expect(await registry()).toEqual(before);
  });
});

describe('a mirror run during a reset', () => {
  it('service/deployment#projects-and-environments: 2 remaps at once, where the second has a Mirror Organization that the first did not read, end in the rows of 1 remap with both', async () => {
    await seed();

    const other = await holding('LOCK TABLE ontology_registry.product_versions IN EXCLUSIVE MODE');

    try {
      const first = remapped(fallible, input({ [ACME]: ACME_MIRROR }));
      const second = remapped(fallible, input({ [ACME]: ACME_MIRROR, [BOLT]: BOLT_MIRROR }));

      await waitForLockWaits(db, 2);

      await release(other);

      await Promise.all([first, second]);
    } finally {
      await release(other);
    }

    expect(await owners()).toEqual([
      { api_name: 'alpha', organization: ACME_MIRROR },
      { api_name: 'alpha', organization: BOLT_MIRROR },
      { api_name: 'beta', organization: ACME_MIRROR },
      { api_name: 'gamma', organization: null },
    ]);
  });

  it('service/deployment#projects-and-environments: a remap whose connection ends after its first update and before its commit changes no row', async () => {
    const { bolt } = await seed();

    const before = await registry();

    const other = await holding(`SELECT 1 FROM ${ONTOLOGIES} WHERE rid = '${bolt}' FOR UPDATE`);

    try {
      const refused = expect(remapped(fallible, input({ [ACME]: ACME_MIRROR, [BOLT]: BOLT_MIRROR }))).rejects.toThrow();

      await waitForLockWaits(db, 1);

      const { rows } = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND usename = $1",
        [serviceRole],
      );

      expect(rows).toHaveLength(1);

      await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);

      await refused;
    } finally {
      await release(other);
    }

    expect(await registry()).toEqual(before);
  });
});
