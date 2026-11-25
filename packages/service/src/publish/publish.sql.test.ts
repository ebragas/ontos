import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { UserSource } from '../auth/index.ts';
import { createPool } from '../db/index.ts';
import { createDb, fallibleOf, type Db } from '../db/promise.test-utils.ts';
import type { Handle, Settings } from '../handler/index.ts';
import type { GrantsFile } from '../ontology/index.ts';
import {
  attributesIr,
  grantsOf,
  irOf,
  jobsiteIr,
  NS,
  ONTOLOGY_RID,
  stored,
  twinIr,
  twinObjectType,
  USE,
} from '../ontology/stored.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { newDatabase, sql, type TestDatabase, expectAllOnNewest } from './publish.test-utils.ts';
import { testSettings } from '../service.test-utils.ts';
import { jobsiteGrants } from '../../twin/seed/jobsite.test-utils.ts';
import {
  createTestIssuer,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PERSON,
  SERVICE_USER,
  type TestIssuer,
} from '../tokens.test-utils.ts';
import {
  STUB_APPLICATION,
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubWorkos,
  type StubMembership,
  type StubWorkos,
} from '../workos.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ACCOUNT_IR = irOf(twinObjectType('Account'));
const PUBLISH = '/api/ontology-service/v1/publish';
const settings: Settings = { ...testSettings, productRid: ONTOLOGY_RID };
const SECOND_RID = 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111';

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfter: string | null;
}

let postgres: TestPostgres;
let issuer: TestIssuer;
let database: TestDatabase;
let pooledDb: Db;
let endPooled: () => Promise<void>;
let consoleLog: MockInstance<typeof console.log>;
let handle: Handle;
let stub: StubWorkos;
let auth: typeof import('../auth/index.ts');

beforeAll(async () => {
  await import('../handler/index.ts');

  await import('../auth/index.ts');

  postgres = await startPostgres();

  issuer = await createTestIssuer(settings.auth);
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);

  const pool = createPool(database.url);

  pooledDb = createDb(pool);

  endPooled = () => pool.end();

  consoleLog = vi.spyOn(console, 'log');

  stub = newStub([]);

  vi.resetModules();

  handle = (await import('../handler/index.ts')).handle;

  auth = await import('../auth/index.ts');
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  consoleLog.mockRestore();

  await endPooled();

  await database.end();
});

function newStub(memberships: readonly StubMembership[]): StubWorkos {
  return stubWorkos([STUB_PERSON], memberships, { roles: {} });
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
  users: UserSource = auth.workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }),
): Promise<Answer> {
  const input = {
    db: fallibleOf(pooledDb),
    directDb: fallibleOf(database.db),
    settings,
    keys: issuer.keys,
    users,
    workos: auth.workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }),
  };

  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const response = await handle(request, input);

  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    retryAfter: response.headers.get('retry-after'),
  };
}

function body(ir: OntologyIr, grants: unknown, extra: Record<string, unknown> = {}) {
  return {
    product: 'twin',
    ir,
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants,
    validateOnly: false,
    ...extra,
  };
}

const publish = async (ir: OntologyIr, grants: unknown, extra: Record<string, unknown> = {}, token?: string) =>
  send('POST', PUBLISH, token ?? (await issuer.github()), body(ir, grants, extra));

const versions = async () =>
  (
    await database.db.query<{ version: number }>(
      sql('SELECT version FROM ontology_registry.product_versions ORDER BY version'),
    )
  ).map(({ version }) => version);

const writes = () => stub.writes.map(({ method, path }) => `${method} ${path}`);
const refusal = (answer: Answer) => [answer.status, answer.body['errorName'], answer.body['parameters']];

describe('the grants field of the publish body', () => {
  it('service/publish#grants-check: a missing grants, a grants file of v2, and a grants of another shape each get 400 with part grants', async () => {
    const v2 = { roles: ['admin'], objectTypes: { [ACCOUNT]: ['admin'] }, actionTypes: {} };

    const answers = [
      await publish(ACCOUNT_IR, undefined),
      await publish(ACCOUNT_IR, v2),
      await publish(ACCOUNT_IR, { ...grantsOf(ACCOUNT_IR), defaultRoles: { admin: 'twin:use' } }),
    ];

    expect(answers.map(refusal)).toEqual([
      [400, 'Default:InvalidArgument', { part: 'grants', problems: ['The grants file is not a JSON object.'] }],
      [
        400,
        'Default:InvalidArgument',
        {
          part: 'grants',
          problems: [
            'The grants file has the key roles. Its keys are permissions, objectTypes, actionTypes, defaultRoles, queryTypes, and personAttributes.',
          ],
        },
      ],
      [
        400,
        'Default:InvalidArgument',
        { part: 'grants', problems: ['The default role admin is not a list of permission slugs.'] },
      ],
    ]);

    expect([await versions(), writes()]).toEqual([[], []]);
  });

  it('service/publish#grants-check: a failed check gets 1 400 with part grants and the text of each problem', async () => {
    const grants: GrantsFile = {
      ...grantsOf(ACCOUNT_IR),
      permissions: {
        [USE]: { description: 'Use the twin' },
        'ontology:x': { description: 'A permission with the prefix of the service' },
      },
      defaultRoles: { 'org-admin': [USE] },
    };

    expect(refusal(await publish(ACCOUNT_IR, grants))).toEqual([
      400,
      'Default:InvalidArgument',
      {
        part: 'grants',
        problems: [
          'The product permission ontology:x has the prefix ontology:, which the Ontology service keeps for its own permissions.',
          'The default role org-admin has the prefix org-, which WorkOS keeps for the custom roles of each Organization.',
        ],
      },
    ]);
  });

  it('service/publish#grants-check: a validateOnly request with no Functions warns for each function-backed Action Type', async () => {
    const ir = twinIr('0.7.0');
    const grants = grantsOf(ir);

    const answer = await publish(ir, grants, { validateOnly: true });

    expect([answer.status, answer.body['warnings']]).toEqual([
      200,
      [
        `The grants check did not run the default role rule for these function-backed Action Types, because the request has no Functions: ${NS}close-account-action, ${NS}probe-version-check-action, ${NS}set-relationship-action.`,
      ],
    ]);
  });

  it('service/publish#route: a validateOnly publish with no Functions still compiles each function-backed Action, because each stand-in Function returns a list of edits', async () => {
    const ir = twinIr('0.7.0');

    const answer = await publish(ir, grantsOf(ir), { validateOnly: true });

    const actionTypes =
      (answer.body['metadata'] as { actionTypes: Record<string, { parameters: unknown }> } | undefined)?.actionTypes ??
      {};

    const functionBacked = ['close-account-action', 'probe-version-check-action', 'set-relationship-action'].map(
      (name) => [answer.status, actionTypes[`${NS}${name}`]?.parameters],
    );

    expect(functionBacked).toEqual([
      [200, {}],
      [200, {}],
      [200, {}],
    ]);
  });
});

describe('the Person attributes of the grants file', () => {
  const ir = attributesIr();

  const declared = (): GrantsFile => ({
    ...grantsOf(ir),
    permissions: { ...grantsOf(ir).permissions, admin: { description: 'See each Object' } },
  });

  it('service/publish#security-policies: a policy that reads a Person attribute that personAttributes does not declare fails the grants check', async () => {
    const answer = await publish(ir, declared());

    expect(answer.status).toBe(400);

    expect(answer.body['parameters']).toEqual({
      part: 'grants',
      problems: [
        `The object security policy of the Object Type ${NS}CrewMember reads the Person attribute memberIds, which personAttributes does not declare.`,
        `The object security policy of the Object Type ${NS}Jobsite reads the Person attribute jobsiteIds, which personAttributes does not declare.`,
      ],
    });
  });

  it('service/publish#security-policies: a path of personAttributes that names a missing Object Type, a missing Property, a Property that is not a String, or a bad Link side fails the grants check', async () => {
    const personAttributes = {
      jobsiteIds: { start: { objectType: `${NS}Nosuchtype`, property: 'userId' }, links: [] },
      memberIds: { start: { objectType: `${NS}CrewMember`, property: 'nosuch' }, links: ['nosuchside'] },
    };

    const answer = await publish(ir, { ...declared(), personAttributes });

    expect(answer.status).toBe(400);

    expect(answer.body['parameters']).toEqual({
      part: 'grants',
      problems: [
        `The Person attribute jobsiteIds starts at the Object Type ${NS}Nosuchtype, which the IR does not have.`,
        `The Person attribute memberIds starts at the Property nosuch, which the Object Type ${NS}CrewMember does not have.`,
      ],
    });
  });
});

describe('the group condition of a policy at publish', () => {
  it('ontology/object-security-policies#conditions: through the route, a policy that compares the group with EQUAL gets 400, and the error names the operator', async () => {
    const ir = jobsiteIr();
    const text = JSON.stringify(ir);
    const intersects = '"operator":"INTERSECTS","left":{"type":"userProperty","userProperty":{"type":"groupIds"';

    expect(text.includes(intersects)).toBe(true);

    const equal = JSON.parse(text.replace(intersects, intersects.replace('INTERSECTS', 'EQUAL'))) as OntologyIr;

    const answer = await publish(equal, jobsiteGrants(equal));

    expect([
      answer.status,
      answer.body['errorName'],
      JSON.stringify(answer.body['parameters']).includes('compares user.permissions with the operator EQUAL'),
    ]).toEqual([400, 'Default:InvalidArgument', true]);

    expect(await versions()).toEqual([]);
  });
});

describe('the grants check, then the WorkOS steps', () => {
  it('service/ontology-as-code#the-grants-file: a bad grants file fails before any WorkOS step, and a good first one writes its permissions to WorkOS before the store, and its default roles in the reconcile', async () => {
    const bad = { ...grantsOf(ACCOUNT_IR), defaultRoles: { admin: ['ontology:install', USE, 'accounts:export'] } };

    expect((await publish(ACCOUNT_IR, bad)).status).toBe(400);

    expect([stub.requests, await versions()]).toEqual([[], []]);

    const applied = await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR));

    expect([applied.status, applied.body['version'], await versions()]).toEqual([200, 1, [1]]);

    expect(writes()).toEqual([
      'POST /authorization/permissions',
      'POST /authorization/permissions',
      'PATCH /authorization/permissions/ontology%3Ainstall',
      'PATCH /authorization/permissions/twin%3Ause',
      'POST /authorization/roles',
      'PUT /authorization/roles/admin/permissions',
      'POST /authorization/roles',
      'PUT /authorization/roles/member/permissions',
    ]);

    expect(stub.environment()).toEqual({
      permissions: {
        'ontology:install': 'Install an Ontology of a product in the Organization',
        [USE]: 'Use the twin',
      },
      roles: { admin: ['ontology:install', USE], member: [USE] },
    });
  });

  it('service/publish#default-roles-in-workos: through the route, a WorkOS failure at a write of the publish route gives 503 WorkosUnavailable with Retry-After, stores no version, and the next run ends in the same state', async () => {
    stub.failWrites(1);

    const failed = await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR));

    expect([failed.status, failed.body['errorName'], failed.retryAfter, await versions()]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
      '10',
      [],
    ]);

    stub.failWrites(undefined);

    const next = await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR));

    expect([next.status, await versions(), stub.environment().roles]).toEqual([
      200,
      [1],
      { admin: ['ontology:install', USE], member: [USE] },
    ]);
  });

  it('service/publish#default-roles-in-workos: a validateOnly run of the publish caller and a pull request check each reads WorkOS, writes nothing, answers with workosSteps, and gets the same 409 errors', async () => {
    const callers = {
      publish: await issuer.github(),
      check: await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' }),
    };

    for (const [caller, token] of Object.entries(callers)) {
      const reads = stub.requests.length;

      const answer = await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR), { validateOnly: true }, token);

      expect([caller, answer.status, answer.body['workosSteps'], writes()]).toEqual([
        caller,
        200,
        [
          { step: 'createPermission', permission: 'ontology:install' },
          { step: 'createPermission', permission: USE },
          {
            step: 'setDescription',
            permission: 'ontology:install',
            description: 'Install an Ontology of a product in the Organization',
          },
          { step: 'setDescription', permission: USE, description: 'Use the twin' },
        ],
        [],
      ]);

      expect(stub.requests.slice(reads).filter((path) => path.startsWith('/authorization/')).length).toBeGreaterThan(0);
    }

    stub = newStub([{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member'] }]);

    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    const dropped = { ...grantsOf(ACCOUNT_IR), defaultRoles: { admin: ['ontology:install', USE] } };
    const before = stub.writes.length;

    for (const [caller, token] of Object.entries(callers)) {
      const answer = await publish(ACCOUNT_IR, dropped, { validateOnly: true }, token);

      expect([caller, ...refusal(answer)]).toEqual([caller, 409, 'OntologyService:RoleInUse', { role: 'member' }]);
    }

    expect(refusal(await publish(ACCOUNT_IR, dropped))).toEqual([409, 'OntologyService:RoleInUse', { role: 'member' }]);

    expect(stub.writes.length - before).toBe(0);
  });

  it('service/ontology-as-code#the-grants-file: 2 installations of 1 version have the same default roles, so a member of each Organization sees the same types', async () => {
    stub = newStub([
      { user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member'] },
      { user_id: PERSON, organization_id: OTHER_ORGANIZATION, status: 'active', roles: ['member'] },
    ]);

    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');

    await installOnce(database.db, SECOND_RID, 'twin', OTHER_ORGANIZATION);

    const objectTypes = async (rid: string, organization: string) => {
      const answer = await send(
        'GET',
        `/api/v2/ontologies/${rid}/objectTypes`,
        await issuer.workos({ org_id: organization }),
      );

      return (answer.body['data'] as { apiName: string }[]).map(({ apiName }) => apiName);
    };

    expect([await objectTypes(ONTOLOGY_RID, ORGANIZATION), await objectTypes(SECOND_RID, OTHER_ORGANIZATION)]).toEqual([
      [ACCOUNT],
      [ACCOUNT],
    ]);
  });
});

describe('the check of a person or a service user', () => {
  const CHECK_SUB = 'repo:example/test-app:pull_request';
  const SKIPPED = 'The RoleInUse check did not run, because only the publish workflow and a pull request check run it.';

  const requiredPhase = (): OntologyIr => {
    const ir = structuredClone(ACCOUNT_IR);
    const phase = Object.values(ir.ontology.objectTypes)[0]?.objectType.propertyTypes['phase'];

    if (!phase) throw new Error('The Account type has no Property phase.');

    phase.dataConstraints = {
      propertyTypeConstraints: [],
      ...phase.dataConstraints,
      nullabilityV2: { noNulls: true, noEmptyCollections: false },
    };

    return ir;
  };

  const requests = (): [OntologyIr, GrantsFile][] => [
    [requiredPhase(), grantsOf(requiredPhase())],
    [ACCOUNT_IR, grantsOf(ACCOUNT_IR, ['admin'])],
  ];

  const outsiders = async () => {
    stub.setApplication(SERVICE_USER, {
      ...STUB_APPLICATION,
      organization_id: OTHER_ORGANIZATION,
      scopes: ['ontology:install', USE],
    });

    stub.memberships.push({
      user_id: PERSON,
      organization_id: OTHER_ORGANIZATION,
      status: 'active',
      roles: ['admin'],
    });

    return {
      person: await issuer.workos({ org_id: OTHER_ORGANIZATION }),
      service: await issuer.m2m({ org_id: OTHER_ORGANIZATION }),
    };
  };

  const answers = async (tokens: Record<string, string>) => {
    const out: Record<string, [number, Record<string, unknown>][]> = {};

    for (const [caller, token] of Object.entries(tokens)) {
      out[caller] = [];

      for (const [ir, grants] of requests()) {
        const answer = await publish(ir, grants, { validateOnly: true }, token);

        out[caller].push([answer.status, answer.body]);
      }
    }

    return out;
  };

  const statuses = (all: Record<string, [number, Record<string, unknown>][]>) =>
    Object.fromEntries(
      Object.entries(all).map(([caller, each]) => [caller, each.map(([status, body]) => [status, body['errorName']])]),
    );

  it('service/publish#route: a caller of another Organization gets the same answer with and without Objects and members in the first Organization', async () => {
    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    const tokens = await outsiders();

    const bare = await answers(tokens);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');

    const [registry] = await database.db.query<{ object_schema: string }>(
      sql('SELECT object_schema FROM ontology_registry.ontologies WHERE rid = $1', ONTOLOGY_RID),
    );

    for (const id of ['a-1', 'a-2']) {
      await database.db.query({
        text: `INSERT INTO "${registry?.object_schema}"."account" (account_id, name, phase, __version) VALUES ($1, $2, NULL, 1)`,
        values: [id, `Account ${id}`],
      });
    }

    stub.memberships.push({
      user_id: PERSON,
      organization_id: ORGANIZATION,
      status: 'active',
      roles: ['admin', 'member'],
    });

    const full = await answers(tokens);

    expect(full).toEqual(bare);

    expect(statuses(full)).toEqual(
      Object.fromEntries(
        Object.keys(tokens).map((caller) => [
          caller,
          [
            [200, undefined],
            [200, undefined],
          ],
        ]),
      ),
    );

    const insiders = await answers({
      check: await issuer.github({ environment: undefined, sub: CHECK_SUB }),
      person: await issuer.workos(),
    });

    expect(statuses(insiders)).toEqual({
      check: [
        [400, 'Default:InvalidArgument'],
        [409, 'OntologyService:RoleInUse'],
      ],
      person: [
        [400, 'Default:InvalidArgument'],
        [200, undefined],
      ],
    });

    expect(insiders['person']?.[0]?.[1]['parameters']).toMatchObject({ badObjects: 2, ontologyRid: ONTOLOGY_RID });
    expect(insiders['person']?.[1]?.[1]['warnings']).toEqual([SKIPPED]);
  });

  it('service/publish#default-roles-in-workos: a person and a service user cause no page of the Organizations or of the members of an Organization, get a warning when a default role is dropped, and get no workosSteps', async () => {
    stub = newStub([
      { user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['admin'] },
      { user_id: 'user_01PUBLISHMEMBER000000000', organization_id: ORGANIZATION, status: 'active', roles: ['member'] },
    ]);

    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    const tokens = { ...(await outsiders()), ownPerson: await issuer.workos() };

    const scans = () =>
      stub.requests.filter(
        (path) =>
          path.startsWith('/organizations?') ||
          (path.startsWith('/user_management/organization_memberships?') && !path.includes('user_id=')),
      ).length;

    for (const [caller, token] of Object.entries(tokens)) {
      const before = scans();

      const dropped = await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR, ['admin']), { validateOnly: true }, token);

      const kept = await publish(requiredPhase(), grantsOf(requiredPhase()), { validateOnly: true }, token);

      expect([
        caller,
        dropped.status,
        dropped.body['warnings'],
        'workosSteps' in dropped.body,
        kept.status,
        kept.body['warnings'],
        'workosSteps' in kept.body,
        scans() - before,
      ]).toEqual([caller, 200, [SKIPPED], false, 200, undefined, false, 0]);
    }

    const environmentReads = () =>
      stub.requests.filter(
        (path) => path.startsWith('/authorization/permissions') || path.startsWith('/authorization/roles'),
      ).length;

    for (const [caller, token] of Object.entries(tokens)) {
      const reads = environmentReads();

      const same = await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR), { validateOnly: true }, token);

      expect([caller, same.status, environmentReads() - reads]).toEqual([caller, 200, 0]);
    }

    const before = scans();

    const check = await publish(
      ACCOUNT_IR,
      grantsOf(ACCOUNT_IR, ['admin']),
      { validateOnly: true },
      await issuer.github({ environment: undefined, sub: CHECK_SUB }),
    );

    expect([...refusal(check), scans() - before > 0]).toEqual([
      409,
      'OntologyService:RoleInUse',
      { role: 'member' },
      true,
    ]);
  });

  it('refuses validateOnly publish for a person or service caller without ontology:install or without an Organization', async () => {
    stub = newStub([{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member'] }]);

    stub.setApplication(SERVICE_USER, { ...STUB_APPLICATION, organization_id: ORGANIZATION, scopes: [USE] });

    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');

    const refused = await answers({
      member: await issuer.workos(),
      noOrganization: await issuer.workos({ org_id: undefined }),
      serviceWithoutInstall: await issuer.m2m({ org_id: ORGANIZATION }),
    });

    expect(statuses(refused)).toEqual({
      member: [
        [403, 'Default:PermissionDenied'],
        [403, 'Default:PermissionDenied'],
      ],
      noOrganization: [
        [403, 'OntologyService:NoOrganization'],
        [403, 'OntologyService:NoOrganization'],
      ],
      serviceWithoutInstall: [
        [403, 'Default:PermissionDenied'],
        [403, 'Default:PermissionDenied'],
      ],
    });
  });

  it('service/authentication#permissions-of-a-caller: a person with an inactive, a pending, or a removed membership of the token Organization gets 403, and an active member gets the full answer', async () => {
    const [inactive, pending, removed] = [
      'user_01PUBLISHINACTIVE0000000',
      'user_01PUBLISHPENDING00000000',
      'user_01PUBLISHREMOVED00000000',
    ];

    stub = newStub([
      { user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['admin'] },
      { user_id: inactive, organization_id: ORGANIZATION, status: 'inactive', roles: ['admin'] },
      { user_id: pending, organization_id: ORGANIZATION, status: 'pending', roles: ['admin'] },
    ]);

    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');

    const refused = await answers({
      inactive: await issuer.workos({ sub: inactive }),
      pending: await issuer.workos({ sub: pending }),
      removed: await issuer.workos({ sub: removed }),
    });

    expect(statuses(refused)).toEqual(
      Object.fromEntries(
        ['inactive', 'pending', 'removed'].map((caller) => [caller, Array(2).fill([403, 'Default:PermissionDenied'])]),
      ),
    );

    const member = await answers({ member: await issuer.workos() });

    expect(statuses(member)).toEqual({
      member: [
        [200, undefined],
        [200, undefined],
      ],
    });
  });

  it('service/authentication#permissions-of-a-caller: a WorkOS failure at the membership read of a person gives 503 with Retry-After, and no answer of the check', async () => {
    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    stub.fail('5xx', { reads: ['membership'] });

    const answer = await publish(
      ACCOUNT_IR,
      grantsOf(ACCOUNT_IR, ['admin']),
      { validateOnly: true },
      await issuer.workos(),
    );

    expect([answer.status, answer.body['errorName'], answer.retryAfter, 'changes' in answer.body]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
      '10',
      false,
    ]);
  });
});

describe('a stored product version with a grants file of v2', () => {
  it('service/releases#compatibility-with-earlier-releases service/authentication#access: passes the cold-start check, client-config gives 200, and each caller sees no type', async () => {
    stub = newStub([{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['admin'] }]);

    expect((await publish(ACCOUNT_IR, grantsOf(ACCOUNT_IR))).status).toBe(200);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');

    const v2 = { roles: ['admin'], objectTypes: { [ACCOUNT]: ['admin'] }, actionTypes: {} };

    await database.db.query(
      sql('UPDATE ontology_registry.product_versions SET grants = $1::jsonb', JSON.stringify(v2)),
    );

    vi.resetModules();

    handle = (await import('../handler/index.ts')).handle;

    auth = await import('../auth/index.ts');

    const config = await send('GET', '/api/ontology-service/v1/client-config', '');

    const objectTypes = await send('GET', `/api/v2/ontologies/${ONTOLOGY_RID}/objectTypes`, await issuer.workos());

    expect([config.status, objectTypes.status, objectTypes.body['data']]).toEqual([200, 200, []]);
  });
});
