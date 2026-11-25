import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { LOAD_ACCOUNTS, startInstalled, type Installed } from './installed.test-utils.ts';
import { workosUsers } from './index.ts';
import { handle, routes, type Ctx, type HandleInput, type RouteInput } from '../handler/index.ts';
import { testInput, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import {
  AUTHKIT_DOMAIN,
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
  STUB_APPLICATION,
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubWorkos,
  type StubApplication,
  type StubFailure,
  type StubWorkos,
} from '../workos.test-utils.ts';

const url = `http://localhost/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectSets/loadObjects`;
const APPLICATION_READ = `/connect/applications/${SERVICE_USER}`;
const P1 = 'jobsite:read';
const P2 = 'jobsite:write';
const P3 = 'daily-log:write';

let issuer: TestIssuer;
let installed: Installed;
let loadObjects: MockInstance<(input: RouteInput, ctx: Ctx) => Promise<Response>>;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, P1);
});

afterAll(() => installed?.stop());

beforeEach(() => {
  const route = routes.find(
    (candidate) => candidate.access === 'ontology' && candidate.path.endsWith('/objectSets/loadObjects'),
  );

  if (route?.access !== 'ontology') throw new Error('The route table has no loadObjects route.');

  loadObjects = vi.spyOn(route, 'run');

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  vi.useRealTimers();

  loadObjects.mockRestore();

  consoleLog.mockRestore();

  consoleError.mockRestore();
});

function application(scopes: readonly string[] = [P2, P1], fields: Partial<StubApplication> = {}): StubApplication {
  return { ...STUB_APPLICATION, scopes, ...fields };
}

function workos(app: StubApplication | null = application()): StubWorkos {
  return stubWorkos([STUB_PERSON], undefined, {
    roles: { [ORGANIZATION]: { member: [P1] } },
    applications: app === null ? {} : { [SERVICE_USER]: app },
  });
}

function instance(stub: StubWorkos): HandleInput {
  return {
    ...testInput,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }),
  };
}

async function ask(input: HandleInput, claims: Claims = {}): Promise<Response> {
  return send(input, await issuer.m2m(claims));
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

async function callerOf(response: Response | Promise<Response>): Promise<unknown> {
  const answer = await response;

  expect({ status: answer.status, body: await answer.json() }).toEqual({
    status: 200,
    body: expect.objectContaining({ data: expect.any(Array) }),
  });

  return loadObjects.mock.lastCall?.[1].caller;
}

async function expectUnauthorized(response: Response | Promise<Response>): Promise<void> {
  const answer = await response;

  expect(answer.status).toBe(401);

  expect(await answer.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName: 'Default:Unauthorized',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
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

async function after(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

const SERVICE_CALLER = { user: SERVICE_USER, kind: 'service', organization: ORGANIZATION, permissions: [P1, P2] };

describe('service/authentication#tokens: the Ontology service accepts tokens from 3 issuers', () => {
  it('service/authentication#tokens: a person token, a service user token, and a GitHub token each pass, each from its issuer', async () => {
    const input = instance(workos());

    expect(await callerOf(send(input, await issuer.workos()))).toEqual({
      user: PERSON,
      kind: 'person',
      organization: ORGANIZATION,
      permissions: [P1],
    });

    expect(await callerOf(send(input, await issuer.m2m()))).toEqual(SERVICE_CALLER);

    const publish = await send(input, await issuer.github());

    expect({ status: publish.status, body: await publish.json() }).toEqual({
      status: 403,
      body: expect.objectContaining({ errorCode: 'PERMISSION_DENIED' }),
    });
  });
});

describe('service/authentication#people: the OSDK routes refuse each token of the AuthKit issuer except a service user', () => {
  it('service/authentication#people: an MCP token on an OSDK route gets 401, and a service user token passes', async () => {
    const input = instance(workos());

    await expectUnauthorized(send(input, await issuer.authkit()));

    expect(await callerOf(send(input, await issuer.m2m()))).toEqual(SERVICE_CALLER);
  });
});

describe('service/authentication#service-users: a service user is 1 M2M application of 1 Organization', () => {
  it('service/authentication#service-users: the caller of an M2M token has the client ID as its user ID, the caller kind service, no role, and the scopes of the stub application', async () => {
    const stub = workos(application([P3, P1]));

    expect(await callerOf(ask(instance(stub)))).toEqual({
      user: SERVICE_USER,
      kind: 'service',
      organization: ORGANIZATION,
      permissions: [P3, P1],
    });

    expect(stub.requests).toEqual([APPLICATION_READ]);
  });
});

describe('service/authentication#service-users: part 1 checks the claims', () => {
  it('service/authentication#service-users: aud as a string or as a list that holds the client ID of the environment passes', async () => {
    const input = instance(workos());

    expect(await callerOf(ask(input, { aud: 'client_test' }))).toEqual(SERVICE_CALLER);

    expect(await callerOf(ask(input, { aud: ['https://other.example', 'client_test'] }))).toEqual(SERVICE_CALLER);
  });

  const failures: readonly (readonly [string, Claims])[] = [
    ['another aud', { aud: 'client_other' }],
    ['a list aud with no client ID of the environment', { aud: ['client_other'] }],
    ['no aud', { aud: undefined }],
    ['a sub that is not client_id', { sub: 'client_01JSERV1CEUSER0000000000AC' }],
    ['no client_id', { client_id: undefined }],
    ['no org_id', { org_id: undefined }],
    ['an empty org_id', { org_id: '' }],
    ['a sid', { sid: 'session_01TESTSESS0000000000000001' }],
    ['a sub_profile', { sub_profile: 'ai_agent' }],
    ['an exp in the past', { exp: now() - 10 }],
    ['no exp', { exp: undefined }],
    ['another iss', { iss: 'https://other-app.authkit.app' }],
    [
      'a client ID that is not client_ and 26 uppercase letters and digits',
      { sub: 'client_test', client_id: 'client_test' },
    ],
  ];

  for (const [name, claims] of failures) {
    it(`service/authentication#service-users: ${name} gets 401, and reads no WorkOS`, async () => {
      const stub = workos();

      await expectUnauthorized(ask(instance(stub), claims));

      expect(stub.requests).toEqual([]);
    });
  }

  it('service/authentication#service-users: a signature of another key gets 401, and reads no WorkOS', async () => {
    const stub = workos();

    await expectUnauthorized(send(instance(stub), await issuer.m2m({}, { key: 'stranger' })));

    expect(stub.requests).toEqual([]);
  });
});

describe('service/authentication#service-users: part 2 reads the application of the client_id', () => {
  it('service/authentication#service-users: the token passes only when the stub gives an m2m application of the org_id', async () => {
    const stub = workos();

    expect(await callerOf(ask(instance(stub)))).toEqual(SERVICE_CALLER);

    expect(stub.requests).toEqual([APPLICATION_READ]);
  });

  it('service/authentication#service-users: a second request in 60 seconds uses the kept answer and reads no WorkOS', async () => {
    const stub = workos();
    const input = instance(stub);

    await callerOf(ask(input));

    await after(59);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    expect(stub.requests).toEqual([APPLICATION_READ]);
  });
});

describe('service/authentication#permissions-of-a-caller: each instance keeps an application by client ID, and a not found answer', () => {
  it('service/authentication#permissions-of-a-caller: a not found application is kept, so a second request reads no WorkOS', async () => {
    const stub = workos(null);
    const input = instance(stub);

    await expectUnauthorized(ask(input));

    await expectUnauthorized(ask(input));

    expect(stub.requests).toEqual([APPLICATION_READ]);
  });
});

describe('service/authentication#service-users: a token of the AuthKit issuer that fails part 1, or an application that is not found, gets 401', () => {
  const others: readonly (readonly [string, Claims])[] = [
    [
      'an MCP token',
      {
        aud: 'http://localhost/api/mcp',
        sub: PERSON,
        client_id: 'https://claude.ai/.well-known/oauth-client-metadata.json',
      },
    ],
    ['an agent token', { sub_profile: 'ai_agent' }],
    ['a Connect user token', { sub: PERSON, client_id: SERVICE_USER }],
    [
      'a session token',
      { sub: PERSON, client_id: 'client_test', sid: 'session_01TESTSESS0000000000000001', scope: undefined },
    ],
  ];

  for (const [name, claims] of others) {
    it(`service/authentication#service-users: ${name} gets 401 on an OSDK route, and reads no WorkOS`, async () => {
      const stub = workos();

      await expectUnauthorized(ask(instance(stub), claims));

      expect(stub.requests).toEqual([]);
    });
  }

  const applications: readonly (readonly [string, StubApplication | null])[] = [
    ['an application that WorkOS does not find', null],
    ['an application that is not m2m', application([P1], { application_type: 'oauth' })],
    ['an application of another Organization', application([P1], { organization_id: OTHER_ORGANIZATION })],
  ];

  for (const [name, app] of applications) {
    it(`service/authentication#service-users: ${name} gets 401`, async () => {
      const stub = workos(app);

      await expectUnauthorized(ask(instance(stub)));

      expect(stub.requests).toEqual([APPLICATION_READ]);
    });
  }
});

describe('service/authentication#service-users: the permissions of a service user are the scopes of its application', () => {
  it('service/authentication#service-users: a token whose scope claim holds fewer scopes still gets each scope of the application', async () => {
    expect(await callerOf(ask(instance(workos(application([P3, P2, P1]))), { scope: P1 }))).toEqual({
      ...SERVICE_CALLER,
      permissions: [P3, P1, P2],
    });
  });

  it('service/authentication#service-users: a scope claim that holds a scope the application lacks adds nothing', async () => {
    expect(await callerOf(ask(instance(workos(application([P1]))), { scope: `${P1} ${P2} ontology:install` }))).toEqual(
      { ...SERVICE_CALLER, permissions: [P1] },
    );
  });
});

describe('service/authentication#service-users: part 2 ends the access of a valid token after the 60-second background refresh, and within 5 minutes when WorkOS fails', () => {
  it('service/authentication#service-users: a deleted application takes effect after the background refresh at 60 seconds when the stub answers', async () => {
    const stub = workos();
    const input = instance(stub);

    await callerOf(ask(input));

    stub.setApplication(SERVICE_USER, undefined);

    await after(59.999);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    await after(0.001);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    await after(0);

    await expectUnauthorized(ask(input));

    expect(stub.requests).toEqual([APPLICATION_READ, APPLICATION_READ]);
  });

  it('service/authentication#service-users: a removed scope takes effect after the background refresh at 60 seconds when the stub answers', async () => {
    const stub = workos();
    const input = instance(stub);

    await callerOf(ask(input));

    stub.setApplication(SERVICE_USER, application([P1]));

    await after(59.999);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    await after(0.001);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    await after(0);

    expect(await callerOf(ask(input))).toEqual({ ...SERVICE_CALLER, permissions: [P1] });
  });

  for (const kind of ['network', '5xx', 'timeout', 'stalled body'] as const satisfies readonly StubFailure[]) {
    it(`service/authentication#service-users: a deleted application takes effect after 300 seconds when the stub fails with ${kind}`, async () => {
      const stub = workos();
      const input = instance(stub);

      await callerOf(ask(input));

      stub.setApplication(SERVICE_USER, undefined);

      stub.fail(kind);

      const wait = kind === 'timeout' || kind === 'stalled body' ? 5 : 0;

      await after(300 - wait);

      const kept = ask(input);

      await stub.reached(2);

      await after(wait);

      expect(await callerOf(kept)).toEqual(SERVICE_CALLER);

      await after(0.001);

      const gone = ask(input);

      await stub.reached(3);

      await after(5);

      await expectUnavailable(gone);

      stub.fail(undefined);

      await expectUnauthorized(ask(input));
    });
  }

  it('service/authentication#service-users: a removed scope takes effect after 300 seconds when the stub fails', async () => {
    const stub = workos();
    const input = instance(stub);

    await callerOf(ask(input));

    stub.setApplication(SERVICE_USER, application([P1]));

    stub.fail('5xx');

    await after(300);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    await after(0.001);

    await expectUnavailable(ask(input));

    stub.fail(undefined);

    expect(await callerOf(ask(input))).toEqual({ ...SERVICE_CALLER, permissions: [P1] });
  });
});

describe('service/authentication#permissions-of-a-caller: a deleted application and a removed scope take effect after the 60-second background refresh, and within 5 minutes when WorkOS fails', () => {
  it('service/authentication#permissions-of-a-caller: a valid token of a deleted application gets 401 after the background refresh at 60 seconds', async () => {
    const stub = workos();
    const input = instance(stub);

    await callerOf(ask(input));

    stub.setApplication(SERVICE_USER, undefined);

    await after(60);

    expect(await callerOf(ask(input))).toEqual(SERVICE_CALLER);

    await after(0);

    await expectUnauthorized(ask(input));
  });

  it('service/authentication#permissions-of-a-caller: a cold instance with WorkOS down gives 503 to a service user, never access', async () => {
    const stub = workos();

    stub.fail('network');

    await expectUnavailable(ask(instance(stub)));
  });

  it('service/authentication#permissions-of-a-caller: 429 with no kept answer gives 503 OntologyService:WorkosRateLimited with the Retry-After of WorkOS', async () => {
    const stub = workos();

    stub.fail('429', { retryAfter: '7' });

    const answer = await ask(instance(stub));

    expect(answer.status).toBe(503);
    expect(answer.headers.get('retry-after')).toBe('7');

    expect(await answer.json()).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'OntologyService:WorkosRateLimited',
      errorInstanceId: expect.any(String),
      parameters: {},
    });
  });

  it('service/authentication#permissions-of-a-caller: bug path 6, during a WorkOS failure 1 instance allows a deleted service user that another instance already refuses', async () => {
    const stub = workos();
    const first = instance(stub);
    const second = instance(stub);

    await callerOf(ask(first));

    stub.setApplication(SERVICE_USER, undefined);

    await after(60);

    await expectUnauthorized(ask(second));

    stub.fail('5xx');

    expect(await callerOf(ask(first))).toEqual(SERVICE_CALLER);
  });

  it('service/authentication#permissions-of-a-caller: concurrent requests of 1 service user share 1 application read', async () => {
    const stub = workos();
    const input = instance(stub);

    stub.hold();

    const both = Promise.all([ask(input), ask(input)]);

    await stub.reached(1);

    stub.release();

    const [one, two] = await both;

    expect(await callerOf(one)).toEqual(SERVICE_CALLER);

    expect(await callerOf(two)).toEqual(SERVICE_CALLER);

    expect(stub.requests).toEqual([APPLICATION_READ]);
  });
});

describe('the AuthKit domain', () => {
  it('an M2M token of the AuthKit issuer of another environment gets 401', async () => {
    const other = await createTestIssuer(testSettings.auth, 'other-app.authkit.app');

    const stub = workos();

    await expectUnauthorized(send(instance(stub), await other.m2m()));

    expect(stub.requests).toEqual([]);
    expect(AUTHKIT_DOMAIN).toBe('test-app.authkit.app');
  });
});
