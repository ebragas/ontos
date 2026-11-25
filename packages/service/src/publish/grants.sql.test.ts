import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { Handle, HandleInput } from '../handler/index.ts';
import type { GrantsFile } from '../ontology/index.ts';
import {
  grantsOf,
  irOf,
  NS,
  twinFunctions,
  twinGrants,
  twinIr,
  twinObjectType,
  USE,
} from '../ontology/stored.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { noUsers, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { createTestIssuer, OTHER_ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { newDatabase, OSDK_SET, sql, type TestDatabase, expectAllOnNewest } from './publish.test-utils.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import { STUB_WORKOS_KEY, stubPublish, stubWorkos } from '../workos.test-utils.ts';
import { workosPublish } from '../auth/index.ts';
import type { DiscoveredDataType, DiscoveredFunction, PublishedFunctions, WorkosPort } from './index.ts';

const ACCOUNT_IR = irOf(twinObjectType('Account'));
const ACCOUNT = `${NS}Account`;
const OTHER_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000002';

const ADMIN_ONLY: GrantsFile = {
  permissions: { 'twin:admin': { description: 'Administer the twin' } },
  objectTypes: { [ACCOUNT]: 'twin:admin' },
  actionTypes: {},
  defaultRoles: { admin: ['ontology:install', 'twin:admin'], member: [] },
};

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
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
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  consoleLog.mockRestore();

  await endPooled();

  await database.end();
});

async function newInstance(): Promise<Handle> {
  vi.resetModules();

  return (await import('../handler/index.ts')).handle;
}

function input(workos: WorkosPort = stubPublish()): HandleInput {
  return {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings: testSettings,
    keys: issuer.keys,
    users: noUsers,
    workos,
  };
}

function body(validateOnly: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ir: ACCOUNT_IR,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: grantsOf(ACCOUNT_IR),
    validateOnly,
    ...extra,
  };
}

async function publish(
  handle: Handle,
  request: Record<string, unknown>,
  workos?: WorkosPort,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handle(
    new Request('http://localhost/api/ontology-service/v1/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.github()}` },
      body: JSON.stringify(request),
    }),
    input(workos),
  );

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function fullMetadata(handle: Handle): Promise<number> {
  const url = `http://localhost/api/v2/ontologies/${TEST_ONTOLOGY_RID}/fullMetadata`;

  return (
    await buffered(handle(new Request(url, { headers: { authorization: `Bearer ${await issuer.workos()}` } }), input()))
  ).status;
}

function narrowedEngagement(member: readonly string[]): GrantsFile {
  const twin = twinGrants('0.4.0');

  return {
    ...twin,
    permissions: { ...twin.permissions, 'engagements:secret': { description: 'View secret engagements' } },
    objectTypes: { ...twin.objectTypes, [`${NS}Engagement`]: 'engagements:secret' },
    defaultRoles: { admin: [...(twin.defaultRoles['admin'] ?? []), 'engagements:secret'], member },
  };
}

function storedGrants(): Promise<{ version: number; grants: unknown }[]> {
  return database.db.query(sql('SELECT version, grants FROM ontology_registry.product_versions ORDER BY version'));
}

describe('the grants field of the publish body', () => {
  it.each([true, false])(
    'service/publish#route service/publish#grants-check: a body with no grants gets 400 with part grants (validateOnly %s)',
    async (validateOnly) => {
      const request = body(validateOnly);

      delete request['grants'];

      expect(await publish(await newInstance(), request)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          errorInstanceId: expect.any(String),
          parameters: { part: 'grants', problems: ['The grants file is not a JSON object.'] },
        },
      });

      expect(await storedGrants()).toEqual([]);
    },
  );

  it('service/publish#grants-check: a grants field of another shape gets 400 with part grants', async () => {
    const response = await publish(
      await newInstance(),
      body(false, { grants: { roles: 'admin', objectTypes: {}, actionTypes: {} } }),
    );

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          'The grants file has the key roles. Its keys are permissions, objectTypes, actionTypes, defaultRoles, queryTypes, and personAttributes.',
        ],
      },
    ]);

    expect(await storedGrants()).toEqual([]);
  });

  it('service/publish#what-the-app-publishes publish checks the grants file of the body, and a failed check applies nothing', async () => {
    const response = await publish(
      await newInstance(),
      body(false, {
        grants: {
          permissions: {},
          objectTypes: {},
          actionTypes: { [`${NS}close-payroll`]: 'payroll:close' },
          defaultRoles: { admin: ['owner'] },
        },
      }),
    );

    expect([response.status, response.body['errorName'], response.body['parameters']]).toEqual([
      400,
      'Default:InvalidArgument',
      {
        part: 'grants',
        problems: [
          `The Object Type ${ACCOUNT} names no permission.`,
          `The key ${NS}close-payroll of actionTypes names no Action Type of the IR.`,
          'The default role admin names the permission owner, which is not a permission of the product or of the Ontology service.',
        ],
      },
    ]);

    expect(await storedGrants()).toEqual([]);
  });

  it('a wider Action Type gets 1 400 that lists each problem, also with validateOnly', async () => {
    const ir = twinIr('0.4.0');

    const grants = narrowedEngagement([
      'accounts:read',
      'accounts:write',
      'accounts:close',
      'engagements:read',
      'engagements:write',
      'probes:read',
    ]);

    const response = await publish(await newInstance(), body(true, { ir, functions: twinFunctions('0.4.0'), grants }));

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          `The default role member holds the permission engagements:write of the Action Type ${NS}create-engagement, but not engagements:secret, which its Object Types need.`,
          `The default role member holds the permission engagements:write of the Action Type ${NS}set-engagement-status, but not engagements:secret, which its Object Types need.`,
          `The default role member holds the permission engagements:write of the Action Type ${NS}delete-engagement, but not engagements:secret, which its Object Types need.`,
          `The default role member holds the permission accounts:close of the Action Type ${NS}close-account-action, but not engagements:secret, which its Object Types need.`,
        ],
      },
    ]);
  });

  it('a validateOnly request with no Functions answers 200 with 1 warning that names each function-backed Action Type', async () => {
    const ir = twinIr('0.4.0');

    const response = await publish(await newInstance(), body(true, { ir, grants: twinGrants('0.4.0') }));

    expect([response.status, response.body['warnings']]).toEqual([
      200,
      [
        `The grants check did not run the default role rule for these function-backed Action Types, because the request has no Functions: ${NS}close-account-action.`,
      ],
    ]);
  });

  it('a publish that applies runs the default role rule of each function-backed Action Type', async () => {
    const ir = twinIr('0.4.0');

    const narrowed = narrowedEngagement([
      'accounts:read',
      'accounts:write',
      'accounts:close',
      'engagements:read',
      'probes:read',
    ]);

    const response = await publish(
      await newInstance(),
      body(false, { ir, functions: twinFunctions('0.4.0'), grants: narrowed }),
    );

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          `The default role member holds the permission accounts:close of the Action Type ${NS}close-account-action, but not engagements:secret, which its Object Types need.`,
        ],
      },
    ]);

    expect(await storedGrants()).toEqual([]);
  });

  it('a default role with an empty list of permissions is published and stored', async () => {
    const grants: GrantsFile = {
      permissions: { [USE]: { description: 'Use the twin' } },
      objectTypes: { [ACCOUNT]: USE },
      actionTypes: {},
      defaultRoles: { admin: [USE], member: [] },
    };

    expect((await publish(await newInstance(), body(false, { grants }))).status).toBe(200);

    expect(await storedGrants()).toEqual([
      {
        version: 1,
        grants: {
          permissions: { 'twin:use': { description: 'Use the twin' } },
          objectTypes: { [ACCOUNT]: 'twin:use' },
          actionTypes: {},
          defaultRoles: { admin: ['twin:use'], member: [] },
        },
      },
    ]);
  });
});

describe('the stored grants', () => {
  it('service/storage#registry: the table of product versions has the nullable jsonb column grants', async () => {
    await newInstance().then((handle) => fullMetadata(handle));

    expect(
      await database.db.query(
        sql(
          "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'ontology_registry' AND table_name = 'product_versions' AND column_name = 'grants'",
        ),
      ),
    ).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
  });

  it('service/publish#versions the new version row holds the grants file of the publish', async () => {
    const response = await publish(await newInstance(), body(false, { grants: ADMIN_ONLY }));

    expect([response.status, response.body['version']]).toEqual([200, 1]);

    expect(await storedGrants()).toEqual([
      {
        version: 1,
        grants: {
          permissions: { 'twin:admin': { description: 'Administer the twin' } },
          objectTypes: { [ACCOUNT]: 'twin:admin' },
          actionTypes: {},
          defaultRoles: { admin: ['ontology:install', 'twin:admin'], member: [] },
        },
      },
    ]);
  });

  it('each installation of the product reads the 1 grants file of its product version', async () => {
    const handle = await newInstance();

    expect((await publish(handle, body(false))).status).toBe(200);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    await installOnce(database.db, OTHER_RID, 'twin', OTHER_ORGANIZATION);

    expect((await publish(handle, body(false, { grants: ADMIN_ONLY }))).body['version']).toBe(2);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    const installed = await database.db.query(
      sql(
        'SELECT o.rid, o.version, v.grants FROM ontology_registry.ontologies o JOIN ontology_registry.product_versions v USING (product, version) ORDER BY o.rid',
      ),
    );

    const grants = {
      permissions: { 'twin:admin': { description: 'Administer the twin' } },
      objectTypes: { [ACCOUNT]: 'twin:admin' },
      actionTypes: {},
      defaultRoles: { admin: ['ontology:install', 'twin:admin'], member: [] },
    };

    expect(installed).toEqual([
      { rid: TEST_ONTOLOGY_RID, version: 2, grants },
      { rid: OTHER_RID, version: 2, grants },
    ]);
  });

  it('service/publish#versions: a publish that changes only the grants file makes a new version', async () => {
    const handle = await newInstance();

    expect((await publish(handle, body(false))).body['version']).toBe(1);

    expect((await publish(handle, body(false))).body['version']).toBe(1);

    const changed = await publish(handle, body(false, { grants: ADMIN_ONLY }));

    expect([changed.body['version'], changed.body['changes']]).toEqual([2, []]);

    expect(await storedGrants()).toEqual([
      {
        version: 1,
        grants: {
          permissions: { 'twin:use': { description: 'Use the twin' } },
          objectTypes: { [ACCOUNT]: 'twin:use' },
          actionTypes: {},
          defaultRoles: { admin: ['ontology:install', 'twin:use'], member: ['twin:use'] },
        },
      },
      {
        version: 2,
        grants: {
          permissions: { 'twin:admin': { description: 'Administer the twin' } },
          objectTypes: { [ACCOUNT]: 'twin:admin' },
          actionTypes: {},
          defaultRoles: { admin: ['ontology:install', 'twin:admin'], member: [] },
        },
      },
    ]);
  });

  it('the compile step does not read the grants, so a stored version with no grants, or grants that fail the check, still passes the cold start', async () => {
    expect((await publish(await newInstance(), body(false))).status).toBe(200);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    await database.db.query(sql('UPDATE ontology_registry.product_versions SET grants = NULL'));

    expect(await fullMetadata(await newInstance())).toBe(200);

    await database.db.query(
      sql(`UPDATE ontology_registry.product_versions SET grants = '{"roles": "not a list"}'::jsonb`),
    );

    expect(await fullMetadata(await newInstance())).toBe(200);
  });

  it('service/publish#versions: a stored version with no grants and a publish of the same parts with grants makes a new version', async () => {
    const handle = await newInstance();

    expect((await publish(handle, body(false))).body['version']).toBe(1);

    await database.db.query(sql('UPDATE ontology_registry.product_versions SET grants = NULL'));

    expect((await publish(handle, body(false))).body['version']).toBe(2);
  });
});

describe('service/publish#grants-check: the grants check refuses a bad slug that needs no WorkOS step, also with validateOnly', () => {
  it('service/publish#grants-check: a default role Admin that WorkOS already holds with each permission gets 400 with part grants, with no WorkOS read and no WorkOS write', async () => {
    const grants = { ...grantsOf(ACCOUNT_IR), defaultRoles: { Admin: [USE] } };

    const stub = stubWorkos([], [], {
      environment: { permissions: { [USE]: 'Use the twin' }, roles: { Admin: [USE] } },
    });

    const answers = [];

    for (const validateOnly of [true, false])
      answers.push(
        await publish(
          await newInstance(),
          body(validateOnly, { grants }),
          workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }),
        ),
      );

    const refused = {
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        errorInstanceId: expect.any(String),
        parameters: {
          part: 'grants',
          problems: [
            'The default role slug "Admin" has a form that WorkOS does not take: 1 to 48 characters of a to z, 0 to 9, -, and _.',
          ],
        },
      },
    };

    expect([answers, stub.requests, stub.writes, await storedGrants()]).toEqual([[refused, refused], [], [], []]);
  });
});

const ENGAGEMENT = `${NS}Engagement`;
const objectOf = (objectTypeId: string) => ({ type: 'object', object: { objectTypeId } });

function queryFunction(
  functionName: string,
  options: { documentation?: string; input?: string; output?: DiscoveredDataType } = {},
): DiscoveredFunction {
  return {
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      { name: 'source', dataType: objectOf(options.input ?? ACCOUNT) },
    ],
    output: { type: 'single', single: { dataType: options.output ?? { type: 'string', string: {} } } },
    customTypes: {},
    documentation: options.documentation ?? `The label of ${functionName}.`,
  };
}

function withQueries(...queries: DiscoveredFunction[]): PublishedFunctions {
  const twin = twinFunctions('0.4.0');

  return { ...twin, discovered: [...twin.discovered, ...queries] };
}

function twinWith(extra: Partial<GrantsFile>): GrantsFile {
  const twin = twinGrants('0.4.0');

  return {
    ...twin,
    ...extra,
    permissions: { ...twin.permissions, ...extra.permissions },
    defaultRoles: { ...twin.defaultRoles, ...extra.defaultRoles },
  };
}

describe('the grants of a Query Function', () => {
  const ir = twinIr('0.4.0');

  const undocumented = (name: string): DiscoveredFunction => {
    const { documentation, ...rest } = queryFunction(name);

    void documentation;

    return rest;
  };

  it('service/ontology-as-code#the-grants-file: a grants file with the key queryTypes parses, and the publish of its Query Function gets 200', async () => {
    const grants = twinWith({ queryTypes: { accountLabel: 'accounts:read' } });

    const response = await publish(
      await newInstance(),
      body(true, { ir, functions: withQueries(queryFunction('accountLabel')), grants }),
    );

    expect([response.status, response.body['warnings']]).toEqual([200, undefined]);
  });

  it('service/ontology-as-code#the-grants-file service/publish#grants-check: a publish with no Query Function and no key queryTypes applies as before', async () => {
    const response = await publish(
      await newInstance(),
      body(false, { ir, functions: twinFunctions('0.4.0'), grants: twinGrants('0.4.0') }),
    );

    expect([response.status, response.body['warnings']]).toEqual([200, undefined]);
  });

  it('service/publish#grants-check: each bad entry of queryTypes is a problem that names the Function', async () => {
    const grants = twinWith({
      queryTypes: { closeAccount: 'accounts:read', noSuchFunction: 'accounts:read', undeclared: 'reports:read' },
    });

    const response = await publish(
      await newInstance(),
      body(true, { ir, functions: withQueries(queryFunction('unnamed'), queryFunction('undeclared')), grants }),
    );

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          'The Query Function unnamed names no permission.',
          'The key closeAccount of queryTypes names an edit Function. An edit Function has the permission of its Action Type.',
          'The key noSuchFunction of queryTypes names no Function.',
          'The Query Function undeclared names the permission reports:read, which the key permissions does not declare.',
        ],
      },
    ]);
  });

  it('service/publish#grants-check: a default role that holds the permission of a Query Function but not of an Object Type of its inputs or output is a problem', async () => {
    const grants = twinWith({
      permissions: { 'reports:read': { description: 'Run reports' } },
      queryTypes: { engagementOfAccount: 'reports:read', accountOfEngagement: 'reports:read' },
      defaultRoles: { reporter: ['reports:read', 'accounts:read'] },
    });

    const functions = withQueries(
      queryFunction('engagementOfAccount', { output: objectOf(ENGAGEMENT) }),
      queryFunction('accountOfEngagement', { input: ENGAGEMENT }),
    );

    const response = await publish(await newInstance(), body(true, { ir, functions, grants }));

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          'The default role reporter holds the permission reports:read of the Query Function engagementOfAccount, but not engagements:read, which its Object Types need.',
          'The default role reporter holds the permission reports:read of the Query Function accountOfEngagement, but not engagements:read, which its Object Types need.',
        ],
      },
    ]);
  });

  it('ontology/functions/query-functions#code service/publish#grants-check: a Query Function with no doc comment, or with an empty first line, is a problem that names the Function', async () => {
    const grants = twinWith({ queryTypes: { undocumented: 'accounts:read', blankFirstLine: 'accounts:read' } });

    const functions = withQueries(
      undocumented('undocumented'),
      queryFunction('blankFirstLine', { documentation: '\nThe label of an account.' }),
    );

    const response = await publish(await newInstance(), body(true, { ir, functions, grants }));

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          'The Query Function undocumented has no doc comment. Its first line is the description of the query type.',
          'The doc comment of the Query Function blankFirstLine has an empty first line. Its first line is the description of the query type.',
        ],
      },
    ]);
  });

  it('service/publish#grants-check: a publish that applies with no Functions checks queryTypes, and stores nothing on a problem', async () => {
    const handle = await newInstance();

    const grants = { ...grantsOf(ACCOUNT_IR), queryTypes: { ghost: 'undeclared:perm', other: 'ontology:install' } };

    const response = await publish(handle, body(false, { grants }));

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: ['The key ghost of queryTypes names no Function.', 'The key other of queryTypes names no Function.'],
      },
    ]);

    expect((await publish(handle, body(false))).body['version']).toBe(1);
  });

  it('service/publish#grants-check: a validateOnly request with no Functions still checks the permission of each entry of queryTypes', async () => {
    const grants = twinWith({ queryTypes: { ghost: 'undeclared:perm' } });

    const response = await publish(await newInstance(), body(true, { ir, grants }));

    expect([response.status, response.body['parameters']]).toEqual([
      400,
      {
        part: 'grants',
        problems: [
          'The Query Function ghost names the permission undeclared:perm, which the key permissions does not declare.',
        ],
      },
    ]);
  });

  it('service/publish#grants-check: a validateOnly request with no Functions does not match queryTypes with the Query Functions, and 1 warning says so', async () => {
    const response = await publish(
      await newInstance(),
      body(true, { ir, grants: twinWith({ queryTypes: { accountLabel: 'accounts:read' } }) }),
    );

    expect([response.status, response.body['warnings']]).toEqual([
      200,
      [
        `The grants check did not run the default role rule for these function-backed Action Types, because the request has no Functions: ${NS}close-account-action.`,
        'The grants check did not match the key queryTypes with the Query Functions, because the request has no Functions.',
      ],
    ]);
  });

  it('ontology/functions/query-functions#code service/publish#grants-check: a version load runs no check, so a stored Query Function with no doc comment and no queryTypes entry still loads', async () => {
    const functions = withQueries(queryFunction('accountLabel'));
    const grants = twinWith({ queryTypes: { accountLabel: 'accounts:read' } });

    expect((await publish(await newInstance(), body(false, { ir, functions, grants }))).status).toBe(200);

    await installOnce(database.db, TEST_ONTOLOGY_RID, 'twin');

    const at = functions.discovered.length - 1;

    const changed = await database.db.query(
      sql(`UPDATE ontology_registry.product_versions SET functions = functions #- '{discovered,${at},documentation}', grants = grants - 'queryTypes'
           WHERE functions #>> '{discovered,${at},documentation}' = 'The label of accountLabel.' AND grants ? 'queryTypes' RETURNING version`),
    );

    expect(changed).toEqual([{ version: 1 }]);

    expect(await fullMetadata(await newInstance())).toBe(200);
  });
});
