import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ACCOUNT, LOAD_ACCOUNTS, startInstalled, type Installed } from './installed.test-utils.ts';
import { workosUsers, type UserSource } from './index.ts';
import { createPool } from '../db/index.ts';
import { keptAnswers, workosUnavailable } from './kept.ts';
import { type ApiError, type AsyncFallible } from '../errors/index.ts';
import { handle, routes, type Ctx, type HandleInput, type RouteAnswer, type RouteInput } from '../handler/index.ts';
import { ontologyEngineChanges, sharedEngineChanges } from '../db/engineChanges.ts';
import { routeSpans, routeTraceProblems } from '../routeHarness.test-utils.ts';
import {
  given,
  handlerDb,
  promised,
  rejecting,
  SCHEMAS,
  testInput,
  testMcpSettings,
  testSettings,
  TEST_ONTOLOGY_RID,
} from '../service.test-utils.ts';
import {
  createTestIssuer,
  now,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PERSON,
  SERVICE_USER,
  type Claims,
  type TestIssuer,
} from '../tokens.test-utils.ts';
import {
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubWorkos,
  type StubFailure,
  type StubMembership,
  type StubWorkos,
} from '../workos.test-utils.ts';
import { workosServer } from './workosServer.test-utils.ts';

const url = `http://localhost/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectSets/loadObjects`;
const MEMBERSHIP_READ = `/user_management/organization_memberships?user_id=${PERSON}&organization_id=${ORGANIZATION}`;
const roleRead = (slug: string): string => `/authorization/organizations/${ORGANIZATION}/roles/${slug}`;
const P1 = 'jobsite:read';
const P2 = 'jobsite:write';
const P3 = 'daily-log:write';

let issuer: TestIssuer;
let installed: Installed;
let ended: HandleInput['db'];
let loadObjects: MockInstance<(input: RouteInput, ctx: Ctx) => RouteAnswer>;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, P1);

  const pool = createPool('postgres://localhost/ended');

  await pool.end();

  ended = handlerDb(pool);

  const route = routes.find((candidate) => candidate.path.endsWith('/objectSets/loadObjects'));

  if (!route) throw new Error('The route table has no loadObjects route.');

  loadObjects = vi.spyOn(route as { run: (input: RouteInput, ctx: Ctx) => RouteAnswer }, 'run');
});

afterAll(async () => {
  loadObjects?.mockRestore();

  await installed?.stop();
});

beforeEach(() => {
  loadObjects.mockClear();

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  vi.useRealTimers();

  consoleLog.mockRestore();

  consoleError.mockRestore();
});

function membership(
  roles: readonly string[] = ['member'],
  status: StubMembership['status'] = 'active',
): StubMembership {
  return { user_id: PERSON, organization_id: ORGANIZATION, status, roles };
}

const answerWorkos = workosServer();

function workos(memberships: readonly StubMembership[] = [membership()]): StubWorkos {
  return stubWorkos([STUB_PERSON], memberships, {
    roles: { [ORGANIZATION]: { member: [P1, P2], reviewer: [P2, P3] } },
  });
}

function instance(stub: StubWorkos, reportFault: HandleInput['reportFault'] = () => undefined): HandleInput {
  return {
    ...testInput,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }),
    reportFault,
  };
}

function token(claims: Claims = {}): Promise<string> {
  return issuer.workos({ exp: now() + 3600, ...claims });
}

async function ask(input: HandleInput, claims: Claims = {}): Promise<Response> {
  return send(input, await token(claims));
}

function send(input: HandleInput, bearer: string): Promise<Response> {
  return handle(
    new Request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(LOAD_ACCOUNTS),
    }),
    input,
  );
}

const ACCOUNT_PAGE = expect.objectContaining({ data: [], objectSetEntities: { objectTypeApiNames: [ACCOUNT] } });

function routeCaller(): Ctx['caller'] {
  expect(loadObjects).toHaveBeenCalledOnce();

  const caller = loadObjects.mock.calls[0]?.[1].caller;

  loadObjects.mockClear();

  if (caller === undefined) throw new Error('The loadObjects route got no caller.');

  return caller;
}

async function permissions(response: Response | Promise<Response>): Promise<unknown> {
  const answer = await response;

  const body: unknown = await answer.json();

  const { permissions } = routeCaller();

  expect([answer.status, body]).toEqual(
    permissions.includes(P1)
      ? [200, ACCOUNT_PAGE]
      : [404, expect.objectContaining({ errorName: 'ObjectTypeNotFound' })],
  );

  return permissions;
}

function tracked(promise: Promise<unknown>): { settled: boolean; error: unknown } {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };

  promise.then(
    () => (state.settled = true),
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );

  return state;
}

async function after(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

async function expectDenied(response: Response | Promise<Response>): Promise<void> {
  const answer = await response;

  expect([answer.status, await answer.json()]).toEqual([
    403,
    {
      errorCode: 'PERMISSION_DENIED',
      errorName: 'Default:PermissionDenied',
      errorInstanceId: expect.any(String),
      parameters: {},
    },
  ]);
}

async function expectUnavailable(response: Response | Promise<Response>): Promise<void> {
  const answer = await response;

  expect(answer.status).toBe(503);
  expect(answer.headers.get('retry-after')).toBe('10');

  expect(await answer.json()).toEqual({
    errorCode: 'INTERNAL',
    errorName: 'OntologyService:WorkosUnavailable',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
}

describe('service/authentication#permissions-of-a-caller: a caller has a user ID, an Organization, a caller kind, and permissions', () => {
  it('service/authentication#permissions-of-a-caller: the caller of a person token has its user ID, its Organization, the caller kind person, and the permissions of the stub', async () => {
    const response = await ask(instance(workos()));

    expect([response.status, await response.json()]).toEqual([200, ACCOUNT_PAGE]);

    expect(routeCaller()).toEqual({ user: PERSON, kind: 'person', organization: ORGANIZATION, permissions: [P1, P2] });
  });
});

describe('service/authentication#permissions-of-a-caller: the membership read, then 1 role read for each role', () => {
  it('service/authentication#permissions-of-a-caller: the stub gets the membership read, then 1 role read for each role, and the permissions are the union', async () => {
    const stub = workos([membership(['member', 'reviewer'])]);

    expect(await permissions(ask(instance(stub)))).toEqual([P3, P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), roleRead('reviewer')]);
  });

  it('service/authentication#permissions-of-a-caller: a role that the Organization does not have gives no permission', async () => {
    const stub = workos([membership(['member', 'org-gone'])]);

    expect(await permissions(ask(instance(stub)))).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), roleRead('org-gone')]);
  });
});

describe('service/authentication#permissions-of-a-caller: a person with no active membership gets 403 on each route that needs an Organization', () => {
  const inOrganization = (status: StubMembership['status']) => [membership(['member'], status)];

  for (const [what, memberships] of [
    ['an inactive membership', inOrganization('inactive')],
    ['a pending membership', inOrganization('pending')],
    ['a membership of another Organization only', [{ ...membership(), organization_id: OTHER_ORGANIZATION }]],
    ['no membership', []],
  ] as const) {
    it(`service/authentication#permissions-of-a-caller: ${what} holds no permission, so it gets no role read, and sees no type: 403 Default:PermissionDenied`, async () => {
      const stub = workos(memberships);

      await expectDenied(ask(instance(stub)));

      expect(stub.requests).toEqual([MEMBERSHIP_READ]);
    });
  }

  function unfiltered(stub: StubWorkos, data: readonly object[]): HandleInput {
    answerWorkos((request) =>
      new URL(request.url).pathname === '/user_management/organization_memberships'
        ? Response.json({ object: 'list', data, list_metadata: { before: null, after: null } })
        : stub.fetch(request),
    );

    return {
      ...testInput,
      db: installed.db,
      directDb: installed.db,
      keys: issuer.keys,
      users: workosUsers(STUB_WORKOS_KEY),
      reportFault: () => undefined,
    };
  }

  const item = (status: string, organization = ORGANIZATION) => ({
    user_id: PERSON,
    organization_id: organization,
    status,
    roles: [{ slug: 'member' }],
  });

  for (const [what, data] of [
    ['an inactive item', [item('inactive')]],
    ['a pending item', [item('pending')]],
    ['an active item of another Organization', [item('active', OTHER_ORGANIZATION)]],
    ['these 3 items together', [item('inactive'), item('pending'), item('active', OTHER_ORGANIZATION)]],
  ] as const) {
    it(`service/authentication#permissions-of-a-caller: a WorkOS answer that ignores the filters and gives only ${what} gets 403 on a read, List Ontologies, Users.get, and install`, async () => {
      const input = unfiltered(workos(), data);

      const authorization = `Bearer ${await token()}`;

      await expectDenied(ask(input));

      await expectDenied(
        handle(new Request('http://localhost/api/v2/ontologies', { headers: { authorization } }), input),
      );

      await expectDenied(
        handle(new Request(`http://localhost/api/v2/admin/users/${PERSON}`, { headers: { authorization } }), input),
      );

      await expectDenied(
        handle(
          new Request('http://localhost/api/ontology-service/v1/ontologies', {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/json' },
            body: '{"product":"twin"}',
          }),
          input,
        ),
      );
    });
  }

  it('service/authentication#permissions-of-a-caller: an active item of the token Organization after those 3 items gives its permissions', async () => {
    const input = unfiltered(workos(), [
      item('inactive'),
      item('pending'),
      item('active', OTHER_ORGANIZATION),
      item('active'),
    ]);

    expect(await permissions(ask(input))).toEqual([P1, P2]);
  });

  it('service/authentication#permissions-of-a-caller service/ontology-service#permission-catalog: install, List Ontologies, the catalog, Users.get, and Users.getBatch each give 403', async () => {
    const stub = workos(inOrganization('inactive'));
    const input = instance(stub);

    const authorization = `Bearer ${await token()}`;

    const json = { authorization, 'content-type': 'application/json' };

    const requests = [
      new Request('http://localhost/api/ontology-service/v1/ontologies', {
        method: 'POST',
        headers: json,
        body: '{"product":"twin"}',
      }),
      new Request('http://localhost/api/v2/ontologies', { headers: { authorization } }),
      new Request(`http://localhost/api/ontology-service/v1/ontologies/${TEST_ONTOLOGY_RID}/permissions`, {
        headers: { authorization },
      }),
      new Request(`http://localhost/api/v2/admin/users/${PERSON}`, { headers: { authorization } }),
      new Request('http://localhost/api/v2/admin/users/getBatch', {
        method: 'POST',
        headers: json,
        body: JSON.stringify([{ userId: PERSON }]),
      }),
    ];

    for (const request of requests) await expectDenied(handle(request, input));

    expect(stub.requests).toEqual([MEMBERSHIP_READ]);
  });

  it('service/authentication#permissions-of-a-caller: Users.get and Users.getBatch of a service user of the Organization also give 403 to a person with no active membership', async () => {
    const stub = workos(inOrganization('inactive'));
    const input = instance(stub);

    const authorization = `Bearer ${await token()}`;

    await expectDenied(
      handle(new Request(`http://localhost/api/v2/admin/users/${SERVICE_USER}`, { headers: { authorization } }), input),
    );

    await expectDenied(
      handle(
        new Request('http://localhost/api/v2/admin/users/getBatch', {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify([{ userId: SERVICE_USER }]),
        }),
        input,
      ),
    );

    expect(stub.requests).toEqual([MEMBERSHIP_READ]);
  });

  it('service/ontology-service#permission-catalog: the catalog gives 503 OntologyService:WorkosUnavailable while WorkOS is down with no kept answer', async () => {
    const stub = workos();

    stub.fail('5xx');

    const authorization = `Bearer ${await token()}`;

    await expectUnavailable(
      handle(
        new Request(`http://localhost/api/ontology-service/v1/ontologies/${TEST_ONTOLOGY_RID}/permissions`, {
          headers: { authorization },
        }),
        instance(stub),
      ),
    );

    expect(stub.requests).toEqual([MEMBERSHIP_READ]);
  });

  it('service/authentication#permissions-of-a-caller: Users.getCurrent and the Organizations route need no Organization, so they read no membership of the token Organization', async () => {
    const stub = workos(inOrganization('inactive'));
    const input = instance(stub);

    const authorization = `Bearer ${await token()}`;

    const current = await handle(
      new Request('http://localhost/api/v2/admin/users/getCurrent', { headers: { authorization } }),
      input,
    );

    const organizations = await handle(
      new Request('http://localhost/api/ontology-service/v1/organizations', { headers: { authorization } }),
      input,
    );

    expect([current.status, await current.json(), organizations.status, await organizations.json()]).toEqual([
      200,
      expect.objectContaining({ id: PERSON }),
      200,
      { data: [] },
    ]);

    expect(stub.requests).not.toContain(MEMBERSHIP_READ);
  });

  it('service/authentication#permissions-of-a-caller: a person with 2 roles gets the union, and no 403', async () => {
    expect(await permissions(ask(instance(workos([membership(['member', 'reviewer'])]))))).toEqual([P3, P1, P2]);
  });

  it('service/authentication#permissions-of-a-caller: GET /api/v2/ontologies checks active membership without reading role permissions, and warms the membership cache for later data reads', async () => {
    const stub = workos([membership(['member', 'reviewer'])]);

    stub.fail('5xx', { reads: ['role'] });

    const shared = instance(stub);

    const authorization = `Bearer ${await token()}`;

    const listed = await handle(
      new Request('http://localhost/api/v2/ontologies', { headers: { authorization } }),
      shared,
    );

    expect(listed.status).toBe(200);

    expect(await listed.json()).toEqual({ data: [expect.objectContaining({ rid: TEST_ONTOLOGY_RID })] });

    expect(stub.requests).toEqual([MEMBERSHIP_READ]);

    stub.fail(undefined);

    expect(await permissions(ask(shared))).toEqual([P3, P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), roleRead('reviewer')]);
  });

  it('service/authentication#permissions-of-a-caller: a membership removed while the kept answer is fresh still serves at 59 seconds, refreshes in background at 60 seconds, and gives 403 after the refresh', async () => {
    const stub = workos();
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    stub.memberships.splice(0, 1);

    await after(59);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(1);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(0);

    await expectDenied(ask(input));
  });

  it('service/authentication#permissions-of-a-caller: with WorkOS down, a removed membership serves from the kept answer up to 300 seconds, then gets 503, never 403 or 200', async () => {
    const stub = workos();
    const input = instance(stub);

    await permissions(ask(input));

    stub.memberships.splice(0, 1);

    stub.fail('5xx');

    await after(30);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);

    await after(270);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(1);

    await expectUnavailable(ask(input));

    await after(600);

    await expectUnavailable(ask(input));

    stub.fail(undefined);

    await expectDenied(ask(input));
  });

  it('service/authentication#permissions-of-a-caller: a kept "no active membership" answer gives 403 up to 300 seconds while WorkOS is down, then 503', async () => {
    const stub = workos(inOrganization('inactive'));
    const input = instance(stub);

    await expectDenied(ask(input));

    stub.fail('network');

    await after(300);

    await expectDenied(ask(input));

    await after(1);

    await expectUnavailable(ask(input));
  });
});

describe('service/authentication#people: a sub that is not a WorkOS user ID gets 401 in the token check', () => {
  const subs = [
    'user_',
    `user_${'a'.repeat(65)}`,
    'user_01TEST0000000000000000000-',
    'client_01JSERV1CEUSER0000000000AB',
    'repo:example/test-app:pull_request',
    `${PERSON}/../x`,
  ];

  for (const sub of subs) {
    it(`service/authentication#people: a WorkOS token with sub ${JSON.stringify(sub)} gets 401 Default:Unauthorized, and the stub gets no read`, async () => {
      const stub = workos();

      const answer = await ask(instance(stub), { sub });

      expect([answer.status, await answer.json(), stub.requests]).toEqual([
        401,
        {
          errorCode: 'UNAUTHORIZED',
          errorName: 'Default:Unauthorized',
          errorInstanceId: expect.any(String),
          parameters: {},
        },
        [],
      ]);
    });

    it(`service/authentication#people: an MCP token with sub ${JSON.stringify(sub)} gets 401 Default:Unauthorized, and the stub gets no read`, async () => {
      const stub = workos();

      const bearer = await issuer.authkit({ exp: now() + 3600, sub });

      const request = new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      });

      const answer = await handle(request, { ...instance(stub), settings: testMcpSettings });

      expect([answer.status, await answer.json(), stub.requests]).toEqual([
        401,
        {
          errorCode: 'UNAUTHORIZED',
          errorName: 'Default:Unauthorized',
          errorInstanceId: expect.any(String),
          parameters: {},
        },
        [],
      ]);
    });
  }

  it('service/authentication#people: a sub of user_ and 64 letters and digits passes', async () => {
    const sub = `user_${'aZ9'.repeat(21)}a`;

    const stub = stubWorkos([STUB_PERSON], [{ ...membership(), user_id: sub }], {
      roles: { [ORGANIZATION]: { member: [P1] } },
    });

    expect(await permissions(ask(instance(stub), { sub }))).toEqual([P1]);
  });
});

describe('service/authentication#permissions-of-a-caller: no role, scope, or permissions claim decides the permissions', () => {
  it('service/authentication#permissions-of-a-caller: a token with role, scope, and permissions claims still gets the permissions of the stub', async () => {
    const stub = workos();

    expect(
      await permissions(
        ask(instance(stub), {
          role: 'admin',
          scope: 'daily-log:write ontology:install',
          permissions: [P3, 'ontology:install'],
        }),
      ),
    ).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });

  it('service/authentication#permissions-of-a-caller: a cold instance with WorkOS down gives 503 to a token with a permissions claim', async () => {
    const stub = workos();

    stub.fail('5xx');

    await expectUnavailable(ask(instance(stub), { permissions: [P1, P2] }));
  });
});

describe('service/authentication#permissions-of-a-caller: each instance keeps each WorkOS answer in memory', () => {
  it('service/authentication#permissions-of-a-caller: a second request reads no WorkOS', async () => {
    const stub = workos();
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(30);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });

  it('service/authentication#permissions-of-a-caller: a not found role and no active membership are kept the same way', async () => {
    const stub = workos([membership(['org-gone'])]);
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([]);

    await after(30);

    expect(await permissions(ask(input))).toEqual([]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('org-gone')]);

    const inactive = workos([membership(['member'], 'inactive')]);
    const other = instance(inactive);

    await expectDenied(ask(other));

    await expectDenied(ask(other));

    expect(inactive.requests).toEqual([MEMBERSHIP_READ]);
  });

  it('service/authentication#permissions-of-a-caller: 2 instances keep their own answers, with no shared store', async () => {
    const stub = workos();

    expect(await permissions(ask(instance(stub)))).toEqual([P1, P2]);

    expect(await permissions(ask(instance(stub)))).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ, roleRead('member')]);
  });
});

describe('service/authentication#permissions-of-a-caller: a kept membership is fresh for less than 60 seconds and a kept role for less than 300 seconds from the WorkOS answer', () => {
  it('service/authentication#permissions-of-a-caller: at 59 seconds no read, at 60 seconds a background membership read, and at 300 seconds a background role read', async () => {
    const stub = workos();
    const input = instance(stub);

    await permissions(ask(input));

    await after(59);

    await permissions(ask(input));

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);

    await after(1);

    await permissions(ask(input));

    await after(0);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ]);

    await after(240);

    await permissions(ask(input));

    await after(0);

    expect(stub.requests).toEqual([
      MEMBERSHIP_READ,
      roleRead('member'),
      MEMBERSHIP_READ,
      MEMBERSHIP_READ,
      roleRead('member'),
    ]);
  });

  it('service/authentication#permissions-of-a-caller: the age counts from the answer, not from the start of the read', async () => {
    const stub = workos();
    const input = instance(stub);

    stub.hold();

    const first = ask(input);

    await after(3);

    stub.release();

    expect(await permissions(first)).toEqual([P1, P2]);

    await after(59);

    await permissions(ask(input));

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);

    await after(1);

    await permissions(ask(input));

    await after(0);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ]);
  });
});

describe('service/authentication#permissions-of-a-caller: past freshness, a request serves the kept answer at once and refreshes in the background', () => {
  it('service/authentication#permissions-of-a-caller: when WorkOS answers the background refresh at 300 seconds, the next request uses the new role answer and keeps it', async () => {
    const stub = workos();
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    stub.setRole(ORGANIZATION, 'member', [P1]);

    await after(300);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(0);

    expect(await permissions(ask(input))).toEqual([P1]);

    stub.fail('5xx');

    await after(200);

    expect(await permissions(ask(input))).toEqual([P1]);
  });

  it('service/authentication#permissions-of-a-caller: with the stub down, the kept answer serves at 300 seconds and not at 301', async () => {
    const stub = workos();
    const input = instance(stub);

    await permissions(ask(input));

    stub.fail('5xx');

    await after(300);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(0);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ, roleRead('member')]);

    await after(1);

    await expectUnavailable(ask(input));
  });
});

describe('service/authentication#permissions-of-a-caller: with no kept answer of at most 300 seconds, a failed read gives 503', () => {
  it('service/authentication#permissions-of-a-caller: a cold start with the stub down gives 503, never access', async () => {
    const stub = workos();

    stub.fail('network');

    await expectUnavailable(ask(instance(stub)));

    expect(stub.requests).toEqual([MEMBERSHIP_READ]);
  });

  it('service/authentication#permissions-of-a-caller: List Ontologies, a route of an Organization, gives 503 on a cold start with the stub down', async () => {
    const stub = workos();

    stub.fail('5xx');

    const authorization = `Bearer ${await token()}`;

    await expectUnavailable(
      handle(new Request('http://localhost/api/v2/ontologies', { headers: { authorization } }), instance(stub)),
    );

    expect(stub.requests).toEqual([MEMBERSHIP_READ]);
  });

  it('service/authentication#permissions-of-a-caller: the membership read answers, the role read fails, and no role answer is kept: 503', async () => {
    const stub = workos();

    stub.fail('5xx', { reads: ['role'] });

    await expectUnavailable(ask(instance(stub)));

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });
});

describe('service/authentication#permissions-of-a-caller: concurrent requests of 1 key share 1 WorkOS call, each with its own time limit', () => {
  it('service/authentication#permissions-of-a-caller: 2 concurrent requests make 1 call of the stub', async () => {
    const stub = workos();
    const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

    stub.hold();

    const first = source(PERSON, ORGANIZATION);
    const second = source(PERSON, ORGANIZATION);

    await after(1);

    stub.release();

    expect(await first).toEqual([P1, P2]);

    expect(await second).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });

  it('service/authentication#permissions-of-a-caller: a request that stops does not stop the shared call of another request', async () => {
    const stub = workos();
    const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

    stub.hold();

    const stop = new AbortController();
    const first = tracked(source(PERSON, ORGANIZATION, stop.signal));
    const second = source(PERSON, ORGANIZATION);

    await after(1);

    stop.abort(new Error('the caller stopped'));

    await after(1);

    expect(first.error).toEqual(new Error('the caller stopped'));

    stub.release();

    expect(await second).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });

  it('service/authentication#permissions-of-a-caller: a request that joins a hung call at 3 seconds fails 5 seconds after it joined, not with the first', async () => {
    const stub = workos();
    const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

    stub.hold();

    const first = tracked(source(PERSON, ORGANIZATION));

    await after(3);

    const joined = tracked(source(PERSON, ORGANIZATION));

    await after(2);

    expect(first.error).toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });
    expect(joined.settled).toBe(false);

    await after(3);

    expect(joined.error).toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });
    expect(stub.requests).toEqual([MEMBERSHIP_READ]);

    stub.release();
  });
});

describe('service/authentication#permissions-of-a-caller: 1 time limit of 5 seconds covers all the WorkOS reads of permissions of 1 request', () => {
  it('service/authentication#permissions-of-a-caller: a membership read and a role read that each take 3 seconds give 503 at 5 seconds', async () => {
    const stub = workos();
    const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

    stub.hold();

    const answer = tracked(source(PERSON, ORGANIZATION));

    await after(3);

    stub.release();

    stub.hold();

    await stub.reached(2);

    await after(1.999);

    expect(answer.settled).toBe(false);

    await after(0.001);

    expect(answer.error).toMatchObject({
      status: 503,
      errorName: 'OntologyService:WorkosUnavailable',
      headers: { 'retry-after': '10' },
    });

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);

    stub.release();
  });

  it('service/authentication#permissions-of-a-caller: the shared role read keeps its own 5 seconds, so its answer at 6 seconds is kept after the request stopped at 5', async () => {
    const stub = workos();
    const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

    stub.hold();

    const first = tracked(source(PERSON, ORGANIZATION));

    await after(3);

    stub.release();

    stub.hold();

    await stub.reached(2);

    await after(2);

    expect(first.error).toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });

    await after(1);

    stub.release();

    await after(0);

    expect(await source(PERSON, ORGANIZATION)).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });

  it('service/authentication#permissions-of-a-caller: a kept answer of at most 300 seconds serves at once while the refresh waits', async () => {
    const stub = workos();
    const source = promised(workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }).permissions);

    expect(await source(PERSON, ORGANIZATION)).toEqual([P1, P2]);

    await after(120);

    stub.hold();

    const answer = tracked(source(PERSON, ORGANIZATION));

    await after(0);

    expect(answer).toEqual({ settled: true, error: undefined });
    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ]);

    stub.release();

    await after(0);
  });
});

describe('service/authentication#permissions-of-a-caller: an instance removes a kept answer when its age passes 300 seconds', () => {
  const read = (value: string) => () => given(value);

  const failing = async function* (error: ApiError): AsyncFallible<never, ApiError> {
    return yield error;
  };

  const limit = () => ({ signal: new AbortController().signal, start: () => undefined });

  it('service/authentication#permissions-of-a-caller: an answer of 301 seconds is gone at the next read of another key, and one of 300 seconds stays', async () => {
    const kept = keptAnswers<string>();

    await rejecting(kept.get('a', read('A'), limit()));

    await after(1);

    await rejecting(kept.get('b', read('B'), limit()));

    await after(299);

    await rejecting(kept.get('c', read('C'), limit()));

    expect(kept.size).toBe(3);

    await after(1);

    await rejecting(kept.get('c', read('C'), limit()));

    expect(kept.size).toBe(2);
  });

  it('service/authentication#permissions-of-a-caller: with WorkOS down after 300 seconds, the removed answer gives 503', async () => {
    const kept = keptAnswers<string>();

    await rejecting(kept.get('a', read('A'), limit()));

    await after(301);

    await expect(rejecting(kept.get('a', () => failing(workosUnavailable()), limit()))).rejects.toMatchObject({
      status: 503,
      errorName: 'OntologyService:WorkosUnavailable',
    });

    expect(kept.size).toBe(0);
  });
});

describe('service/authentication#permissions-of-a-caller: WorkOS fails on a network error, a 5xx, a 429, or no answer in 5 seconds', () => {
  const failures: readonly StubFailure[] = ['network', '5xx', '429', 'timeout', 'stalled body'];

  for (const failure of failures) {
    it(`service/authentication#permissions-of-a-caller: a ${failure} of the stub counts as a failure: a kept answer of 120 seconds serves`, async () => {
      const stub = workos();
      const input = instance(stub);

      await permissions(ask(input));

      await after(120);

      stub.fail(failure);

      const answer = ask(input);

      expect(await permissions(answer)).toEqual([P1, P2]);

      await stub.reached(3);

      await after(5);

      expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ]);
    });

    it(`service/authentication#permissions-of-a-caller: a ${failure} of the stub with no kept answer gives 503`, async () => {
      const stub = workos();

      stub.fail(failure);

      const answer = ask(instance(stub));

      await stub.reached(1);

      await after(5);

      const failed = await answer;

      expect(failed.status).toBe(503);

      expect(await failed.json()).toMatchObject({
        errorName: failure === '429' ? 'OntologyService:WorkosRateLimited' : 'OntologyService:WorkosUnavailable',
      });
    });
  }

  it('service/authentication#permissions-of-a-caller: a 401 of WorkOS is no failure: it gives 500 and keeps nothing', async () => {
    const stub = workos();
    const input = { ...instance(stub), users: workosUsers('sk_test_wrong', { fetch: stub.fetch }) };

    const answer = await ask(input);

    expect(answer.status).toBe(500);

    expect(await answer.json()).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'Default:Internal',
      errorInstanceId: expect.any(String),
      parameters: {},
    });
  });
});

describe('service/authentication#errors: 503 OntologyService:WorkosUnavailable with Retry-After 10', () => {
  it('service/authentication#errors: with the stub down and no kept answer, 503 OntologyService:WorkosUnavailable with Retry-After 10, and 1 error report', async () => {
    const stub = workos();

    stub.fail('5xx');

    const reportFault = vi.fn();

    await expectUnavailable(ask(instance(stub, reportFault)));

    expect(reportFault).toHaveBeenCalledTimes(1);

    expect(reportFault.mock.calls[0]?.[1]).toMatchObject({
      errorName: 'OntologyService:WorkosUnavailable',
      userId: PERSON,
    });
  });
});

describe('service/authentication#errors: a 429 of WorkOS with no kept answer gives 503 OntologyService:WorkosRateLimited', () => {
  it('service/authentication#errors: a 429 of the stub with no kept answer gives 503 OntologyService:WorkosRateLimited with the Retry-After of WorkOS, and 1 error report', async () => {
    const stub = workos();

    stub.fail('429', { retryAfter: '7' });

    const reportFault = vi.fn();

    const answer = await ask(instance(stub, reportFault));

    expect(answer.status).toBe(503);
    expect(answer.headers.get('retry-after')).toBe('7');

    expect(await answer.json()).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'OntologyService:WorkosRateLimited',
      errorInstanceId: expect.any(String),
      parameters: {},
    });

    expect(reportFault).toHaveBeenCalledTimes(1);
  });

  it('service/authentication#errors: a Retry-After that is not a whole number of seconds gives Retry-After 10', async () => {
    const stub = workos();

    stub.fail('429', { retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' });

    const answer = await ask(instance(stub));

    expect(answer.status).toBe(503);
    expect(answer.headers.get('retry-after')).toBe('10');

    expect(await answer.json()).toMatchObject({ errorName: 'OntologyService:WorkosRateLimited' });
  });
});

describe('service/authentication#organizations: WorkOS holds each membership and each role', () => {
  it('service/authentication#organizations: the permissions come from the WorkOS stub, with a database that fails each call', async () => {
    const stub = workos();
    const faults: { fault: string; reads: string[] }[] = [];
    const base = instance(stub, (error) => void faults.push({ fault: String(error), reads: [...stub.requests] }));
    const permitted: (readonly string[])[] = [];
    const permissions = base.users.permissions;

    const users: UserSource = {
      ...base.users,
      permissions: async function* (
        ...args: Parameters<UserSource['permissions']>
      ): ReturnType<UserSource['permissions']> {
        const held = yield* permissions(...args);

        permitted.push(held);

        return held;
      },
    };

    const input = { ...base, users, db: ended, directDb: ended };

    const failsAfterPermissions = async (): Promise<void> => {
      const answer = await ask(input);

      expect([answer.status, await answer.json()]).toEqual([
        500,
        expect.objectContaining({ errorName: 'Default:Internal' }),
      ]);

      expect(loadObjects).not.toHaveBeenCalled();
    };

    await failsAfterPermissions();

    stub.setRole(ORGANIZATION, 'member', [P3]);

    await after(300);

    await failsAfterPermissions();

    await after(0);

    await failsAfterPermissions();

    const fault = 'Error: Cannot use a pool after calling end on the pool';

    expect(faults).toEqual([
      { fault, reads: [MEMBERSHIP_READ, roleRead('member')] },
      { fault, reads: [MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ, roleRead('member')] },
      { fault, reads: [MEMBERSHIP_READ, roleRead('member'), MEMBERSHIP_READ, roleRead('member')] },
    ]);

    expect(permitted).toEqual([[P1, P2], [P1, P2], [P3]]);
  });

  it('service/authentication#organizations: no engine table holds a membership, a role, or a permission', () => {
    const tables = JSON.stringify([sharedEngineChanges, ontologyEngineChanges(SCHEMAS)]);

    expect(tables.match(/membership|permission|\brole/gi)).toBeNull();
  });
});

describe('service/authentication#people: a removed membership ends the permissions', () => {
  it('service/authentication#people: a removed membership ends access after the background refresh at 60 seconds when WorkOS answers', async () => {
    const stub = workos();
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    stub.memberships.splice(0, 1, membership(['member'], 'inactive'));

    await after(59);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(1);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(0);

    await expectDenied(ask(input));
  });

  it('service/authentication#people: a removed membership ends access within 5 minutes when WorkOS fails', async () => {
    const stub = workos();
    const input = instance(stub);

    await permissions(ask(input));

    stub.memberships.splice(0, 1);

    stub.fail('5xx');

    await after(300);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(1);

    await expectUnavailable(ask(input));
  });
});

describe('service/authentication#permissions-of-a-caller: each change takes effect after its background refresh, and within its usable window when WorkOS fails', () => {
  it('service/authentication#permissions-of-a-caller: a changed role takes effect after the background refresh at 60 seconds', async () => {
    const stub = workos();
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    stub.memberships.splice(0, 1, membership(['reviewer']));

    await after(60);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(0);

    expect(await permissions(ask(input))).toEqual([P3, P2]);
  });

  it('service/authentication#permissions-of-a-caller: a changed permission takes effect after the background role refresh at 300 seconds', async () => {
    const stub = workos();
    const input = instance(stub);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    stub.setRole(ORGANIZATION, 'member', [P1]);

    await after(300);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(0);

    expect(await permissions(ask(input))).toEqual([P1]);
  });

  it('service/authentication#permissions-of-a-caller: a changed role takes effect within 5 minutes when WorkOS fails', async () => {
    const stub = workos();
    const input = instance(stub);

    await permissions(ask(input));

    stub.memberships.splice(0, 1, membership(['reviewer']));

    stub.fail('network');

    await after(300);

    expect(await permissions(ask(input))).toEqual([P1, P2]);

    await after(1);

    await expectUnavailable(ask(input));

    stub.fail(undefined);

    expect(await permissions(ask(input))).toEqual([P3, P2]);
  });

  it('service/authentication#permissions-of-a-caller: bug path 1 (UpToDate): a 60-second-old claim gets no use, and the request reads WorkOS', async () => {
    const stub = workos();
    const instance1 = instance(stub);

    const claimed = await token({ permissions: [P1, P2] });

    await after(60);

    expect(await permissions(send(instance1, claimed))).toEqual([P1, P2]);

    expect(stub.requests).toEqual([MEMBERSHIP_READ, roleRead('member')]);
  });

  it('service/authentication#permissions-of-a-caller: bug path 2 (Revoke60): P2 removed from the role is refused at 60 seconds, despite a claim with P2', async () => {
    const stub = workos();
    const instance1 = instance(stub);
    const claim = { permissions: [P1, P2] };

    stub.setRole(ORGANIZATION, 'member', [P1]);

    await after(60);

    expect(await permissions(ask(instance1, claim))).toEqual([P1]);
  });

  it('service/authentication#permissions-of-a-caller: bug path 3 (Grant60): P2 added again to the role is allowed at 60 seconds, despite a claim with P1 only', async () => {
    const stub = workos();

    stub.setRole(ORGANIZATION, 'member', [P1]);

    const instance1 = instance(stub);
    const claim = { permissions: [P1] };

    stub.setRole(ORGANIZATION, 'member', [P1, P2]);

    await after(60);

    expect(await permissions(ask(instance1, claim))).toEqual([P1, P2]);
  });

  it('service/authentication#permissions-of-a-caller: bug path 4 (ColdDown503): a cold instance with WorkOS down gives 503 to a token with the claim P1 and P2', async () => {
    const stub = workos();
    const claim = { permissions: [P1, P2] };

    stub.fail('5xx');

    await expectUnavailable(ask(instance(stub), claim));
  });

  it('service/authentication#permissions-of-a-caller: bug path 5 (NoWorseThanNewest): during a failure, instance 1 allows P2 that the newer answer of instance 2 refuses until its kept membership expires past 5 minutes', async () => {
    const stub = workos();
    const instance1 = instance(stub);
    const instance2 = instance(stub);

    expect(await permissions(ask(instance1))).toEqual([P1, P2]);

    stub.setRole(ORGANIZATION, 'member', [P1]);

    await after(60);

    expect(await permissions(ask(instance2))).toEqual([P1]);

    stub.fail('5xx');

    expect(await permissions(ask(instance1))).toEqual([P1, P2]);

    await after(241);

    await expectUnavailable(ask(instance1));
  });

  it('service/observability#traces: an SWR background memberships page refresh on /organizations that ends after its parent passes the trace check', async () => {
    const stub = workos([{ ...membership(), organization_name: 'Acme' }]);
    const input = instance(stub);

    const bearer = await token();

    const askOrgs = () =>
      handle(
        new Request('http://localhost/api/ontology-service/v1/organizations', {
          headers: { authorization: `Bearer ${bearer}` },
        }),
        input,
      );

    const first = await askOrgs();

    expect([first.status, await first.json()]).toEqual([200, { data: [{ id: ORGANIZATION, name: 'Acme' }] }]);

    await routeSpans();

    stub.memberships.push({
      user_id: PERSON,
      organization_id: OTHER_ORGANIZATION,
      status: 'active',
      organization_name: 'Beta',
      roles: ['member'],
    });

    await after(60);

    stub.hold();

    const stale = await askOrgs();

    expect([stale.status, await stale.json()]).toEqual([200, { data: [{ id: ORGANIZATION, name: 'Acme' }] }]);

    await stub.reached(2);

    await new Promise((resolve) => setImmediate(resolve));

    stub.release();

    await new Promise((resolve) => setImmediate(resolve));

    const spans = await routeSpans();

    const refreshSpans = spans.filter(
      (span) => span.name === 'workos read' && span.attributes['workos.read'] === 'memberships page',
    );

    const byId = new Map(spans.map((span) => [span.spanId, span]));

    expect(
      refreshSpans.some((span) => {
        const parent = span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);

        return parent !== undefined && span.end > parent.end;
      }),
    ).toBe(true);

    expect(routeTraceProblems(spans)).toEqual([]);

    const refreshed = await askOrgs();

    expect([refreshed.status, await refreshed.json()]).toEqual([
      200,
      {
        data: [
          { id: ORGANIZATION, name: 'Acme' },
          { id: OTHER_ORGANIZATION, name: 'Beta' },
        ],
      },
    ]);
  });
});
