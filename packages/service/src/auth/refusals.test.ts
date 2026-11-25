import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { errors } from 'jose';
import { setupServer } from 'msw/node';
import { remoteKeys, workosPublish, workosUsers, type KeySource } from './index.ts';
import { ApiError } from '../errors/index.ts';
import { handle, inputFromEnv, settingsFromEnv, type HandleInput, type Settings } from '../handler/index.ts';
import { noDb, testEnv, testInput, testMcpSettings, testSettings } from '../service.test-utils.ts';
import { stubAuthkitToken } from '../authkitToken.test-utils.ts';
import { recordSpans, type SpanRecorder } from '../tracing.test-utils.ts';
import {
  createTestIssuer,
  MCP_CLIENT,
  now,
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
  rejectingPort,
  stubWorkos,
  type StubFailure,
  type StubMembership,
  type StubWorkos,
} from '../workos.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const base = 'http://localhost';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN = 'user_01UNKNOWN0000000000000000';

const FORMER = {
  id: 'user_01FORMER00000000000000000',
  email: 'grace@example.com',
  first_name: 'Grace',
  last_name: 'Hopper',
};

const INVITED = {
  id: 'user_01INVITED0000000000000000',
  email: 'edsger@example.com',
  first_name: 'Edsger',
  last_name: 'Dijkstra',
};

const MEMBERSHIPS: readonly StubMembership[] = [
  { user_id: PERSON, organization_id: ORGANIZATION, status: 'active' },
  { user_id: FORMER.id, organization_id: ORGANIZATION, status: 'inactive' },
  { user_id: INVITED.id, organization_id: ORGANIZATION, status: 'pending' },
];

let issuer: TestIssuer;
let recorder: SpanRecorder;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;

const faults: {
  readonly name: string;
  readonly message: string;
  readonly errorName: string;
  readonly route: string | undefined;
}[] = [];

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  recorder = recordSpans();
});

afterAll(() => recorder.stop());

beforeEach(() => {
  faults.length = 0;

  recorder.reset();

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  vi.useRealTimers();

  vi.unstubAllGlobals();

  consoleLog.mockRestore();

  consoleError.mockRestore();
});

function workos(): StubWorkos {
  return stubWorkos([STUB_PERSON, FORMER, INVITED], MEMBERSHIPS);
}

const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function overriding(
  stub: StubWorkos,
  over: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined,
): typeof globalThis.fetch {
  return async (input, init) => (await over(new URL(requestUrl(input)), init)) ?? stub.fetch(input, init);
}

function instance(fetch: typeof globalThis.fetch, extra: Partial<HandleInput> = {}): HandleInput {
  return {
    ...testInput,
    db: fallibleOf(noDb),
    settings: testMcpSettings,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY, { fetch }),
    reportFault: (error, fields) =>
      void faults.push({
        name: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        errorName: fields.errorName,
        route: fields.route,
      }),
    ...extra,
  };
}

async function answerOf(response: Response): Promise<unknown> {
  const text = await response.text();

  let body: unknown = text === '' ? null : text;

  if (response.headers.get('content-type')?.startsWith('application/json')) {
    body = JSON.parse(text) as unknown;

    if (typeof body === 'object' && body !== null && 'errorInstanceId' in body) {
      expect(body.errorInstanceId).toMatch(UUID);

      delete body.errorInstanceId;
    }
  }

  const spans = recorder.spans().map(({ name, status, attributes }) => ({
    name,
    status: status.code,
    ...(attributes['error.type'] === undefined ? {} : { errorType: attributes['error.type'] }),
    ...(attributes['http.status_code'] === undefined ? {} : { httpStatus: attributes['http.status_code'] }),
  }));

  return { status: response.status, headers: Object.fromEntries(response.headers), body, faults: [...faults], spans };
}

type Bearer = string | undefined | Promise<string | undefined>;

async function send(path: string, bearer: Bearer, input: HandleInput, init: RequestInit = {}): Promise<unknown> {
  const token = await bearer;

  const headers = {
    ...(token === undefined ? {} : { authorization: token.includes(' ') ? token : `Bearer ${token}` }),
    ...(init.headers as Record<string, string> | undefined),
  };

  return answerOf(await handle(new Request(`${base}${path}`, { ...init, headers }), input));
}

function pin(cases: readonly (readonly [string, () => Promise<unknown>])[]): void {
  for (const [name, run] of cases) it(name, async () => expect(await run()).toMatchSnapshot());
}

const CURRENT = '/api/v2/admin/users/getCurrent';

describe('the token check of a route of a person', () => {
  const ask = (bearer: Bearer, input = instance(workos().fetch)) => send(CURRENT, bearer, input);

  pin([
    ['no token', () => ask(undefined)],
    ['a Basic header', () => ask('Basic abc')],
    ['an empty Bearer', () => ask('Bearer ')],
    ['a token that is not a JWT', () => ask('not-a-jwt')],
    ['a token of a key that the key set lacks', () => ask(issuer.workos({}, { key: 'stranger' }))],
    ['an expired WorkOS token', () => ask(issuer.workos({ iat: now() - 120, exp: now() - 60 }))],
    ['a WorkOS token with no exp', () => ask(issuer.workos({ exp: undefined }))],
    ['a WorkOS token of an unknown issuer', () => ask(issuer.workos({ iss: 'https://evil.example' }))],
    ['a WorkOS token of another client', () => ask(issuer.workos({ client_id: 'client_other' }))],
    ['a WorkOS token with a sub that is no WorkOS user ID', () => ask(issuer.workos({ sub: 'repo:example/test-app' }))],
    ['a WorkOS token with an empty sub', () => ask(issuer.workos({ sub: '' }))],
    ['a WorkOS token with no sub', () => ask(issuer.workos({ sub: undefined }))],
    ['a GitHub token of another audience', () => ask(issuer.github({ aud: 'https://other.example' }))],
    ['a GitHub token of another repository', () => ask(issuer.github({ repository: 'example/other' }))],
    ['a GitHub token of another environment', () => ask(issuer.github({ environment: 'publish-production' }))],
    ['a GitHub token of the publish workflow', () => ask(issuer.github())],
    ['a GitHub token of a pull request check', () => ask(issuer.github({ environment: undefined }))],
    ['an MCP token', () => ask(issuer.authkit())],
    [
      'a person token with no org_id',
      () =>
        send('/api/v2/admin/users/getBatch', issuer.workos({ org_id: undefined }), instance(workos().fetch), {
          method: 'POST',
          body: JSON.stringify([{ userId: PERSON }]),
        }),
    ],
  ]);
});

describe('the key sources', () => {
  const failing = (fault: unknown): KeySource => ({
    ...issuer.keys,
    workos: () => Promise.reject(fault as Error),
    authkit: () => Promise.reject(fault as Error),
  });

  pin([
    [
      'a key source that fails with a network error',
      () => send(CURRENT, issuer.workos(), instance(workos().fetch, { keys: failing(new TypeError('fetch failed')) })),
    ],
    [
      'a key source that fails with a JWKS time-out',
      () => send(CURRENT, issuer.workos(), instance(workos().fetch, { keys: failing(new errors.JWKSTimeout()) })),
    ],
    [
      'a key source that fails with a bad JWKS',
      () =>
        send(
          CURRENT,
          issuer.workos(),
          instance(workos().fetch, { keys: failing(new errors.JWKSInvalid('not a key set')) }),
        ),
    ],
    [
      'a key source that is no token failure of jose',
      () => send(CURRENT, issuer.workos(), instance(workos().fetch, { keys: failing(new errors.JWKSNoMatchingKey()) })),
    ],
    [
      'the remote keys, with a JWKS fetch that fails',
      () =>
        send(
          CURRENT,
          issuer.workos(),
          instance(workos().fetch, {
            keys: remoteKeys(testSettings.auth, {
              authkitDomain: testSettings.authkitDomain,
              fetch: () => Promise.reject(new TypeError('fetch failed')),
            }),
          }),
        ),
    ],
    [
      'the remote keys, with a JWKS fetch that answers 500',
      () =>
        send(
          CURRENT,
          issuer.workos(),
          instance(workos().fetch, {
            keys: remoteKeys(testSettings.auth, { fetch: () => Promise.resolve(new Response('no', { status: 500 })) }),
          }),
        ),
    ],
    [
      'the remote keys of a service user token, with no AuthKit domain',
      () => send(CURRENT, issuer.m2m(), instance(workos().fetch, { keys: remoteKeys(testSettings.auth) })),
    ],
  ]);
});

describe('the token check of the MCP route', () => {
  const ask = (bearer: Bearer, input = instance(workos().fetch)) =>
    send('/api/mcp', bearer, input, { method: 'POST', body: '{}' });

  pin([
    ['no token', () => ask(undefined)],
    ['a Basic header', () => ask('Basic abc')],
    ['a token that is not a JWT', () => ask('not-a-jwt')],
    ['a WorkOS token', () => ask(issuer.workos())],
    ['a GitHub token', () => ask(issuer.github())],
    ['an AuthKit token of another issuer', () => ask(issuer.authkit({ iss: 'https://other.authkit.app' }))],
    ['an AuthKit token of another audience', () => ask(issuer.authkit({ aud: `${base}/api/other` }))],
    ['an AuthKit token with no exp', () => ask(issuer.authkit({ exp: undefined }))],
    ['an AuthKit token of a stranger key', () => ask(issuer.authkit({}, { key: 'stranger' }))],
    ['an AuthKit token of a service user', () => ask(issuer.authkit({ sub: MCP_CLIENT }))],
    ['an AuthKit token with a sub that is no WorkOS user ID', () => ask(issuer.authkit({ sub: 'someone' }))],
    ['an M2M token', () => ask(issuer.m2m())],
    [
      'a key source that fails',
      () =>
        ask(
          issuer.authkit(),
          instance(workos().fetch, {
            keys: { ...issuer.keys, authkit: () => Promise.reject(new TypeError('fetch failed')) },
          }),
        ),
    ],
  ]);
});

describe('the token check of a service user', () => {
  const stub = (apps: Parameters<StubWorkos['setApplication']>[1]) => {
    const made = workos();

    made.setApplication(SERVICE_USER, apps);

    return made;
  };

  const ask = (bearer: Bearer, fetch: typeof globalThis.fetch) => send(CURRENT, bearer, instance(fetch));

  pin([
    [
      'a token with a sub that differs from its client_id',
      () => ask(issuer.m2m({ sub: 'client_01JOTHER000000000000000000' }), workos().fetch),
    ],
    [
      'a token with a client_id that is no client ID',
      () => ask(issuer.m2m({ sub: 'client_x', client_id: 'client_x' }), workos().fetch),
    ],
    ['a token with no org_id', () => ask(issuer.m2m({ org_id: undefined }), workos().fetch)],
    ['a token with a sid', () => ask(issuer.m2m({ sid: 'session_1' }), workos().fetch)],
    ['a token with a sub_profile', () => ask(issuer.m2m({ sub_profile: {} }), workos().fetch)],
    ['a token of another audience', () => ask(issuer.m2m({ aud: 'client_other' }), workos().fetch)],
    ['an application that WorkOS does not find', () => ask(issuer.m2m(), stub(undefined).fetch)],
    [
      'an application of another type',
      () => ask(issuer.m2m(), stub({ ...STUB_APPLICATION, application_type: 'oauth' }).fetch),
    ],
    [
      'an application of another Organization',
      () => ask(issuer.m2m(), stub({ ...STUB_APPLICATION, organization_id: OTHER_ORGANIZATION }).fetch),
    ],
    [
      'an application read that fails with a network error',
      () => ask(issuer.m2m(), failedRead('network', 'application')),
    ],
    ['an application read that fails with a 5xx', () => ask(issuer.m2m(), failedRead('5xx', 'application'))],
    ['an application read that fails with a 429', () => ask(issuer.m2m(), failedRead('429', 'application', '4'))],
    [
      'an application read that answers 401',
      () =>
        ask(
          issuer.m2m(),
          overriding(workos(), () => Response.json({ message: 'Unauthorized' }, { status: 401 })),
        ),
    ],
    [
      'an application read with a body that is not JSON',
      () =>
        ask(
          issuer.m2m(),
          overriding(workos(), (url) =>
            url.pathname.startsWith('/connect/applications/') ? new Response('<html>', { status: 200 }) : undefined,
          ),
        ),
    ],
    [
      'an application read with a body of another shape',
      () =>
        ask(
          issuer.m2m(),
          overriding(workos(), (url) =>
            url.pathname.startsWith('/connect/applications/') ? Response.json({ client_id: 5 }) : undefined,
          ),
        ),
    ],
  ]);
});

function failedRead(
  failure: StubFailure,
  read: Parameters<StubWorkos['fail']>[1] extends { reads?: readonly (infer R)[] } | undefined ? R : never,
  retryAfter?: string,
): typeof globalThis.fetch {
  const stub = workos();

  stub.fail(failure, { reads: [read], ...(retryAfter === undefined ? {} : { retryAfter }) });

  return stub.fetch;
}

const USER_ROUTE = `/api/v2/admin/users/${PERSON}`;

describe('the permissions of a person', () => {
  const ask = (fetch: typeof globalThis.fetch, bearer: Bearer = issuer.workos()) =>
    send(USER_ROUTE, bearer, instance(fetch));

  pin([
    ['a person with no Organization', () => ask(workos().fetch, issuer.workos({ org_id: undefined }))],
    ['a person with no membership', () => ask(stubWorkos([STUB_PERSON], []).fetch)],
    [
      'a person with a pending membership',
      () =>
        ask(stubWorkos([STUB_PERSON], [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'pending' }]).fetch),
    ],
    ['a person in another Organization', () => ask(workos().fetch, issuer.workos({ org_id: OTHER_ORGANIZATION }))],
    ['a membership read that fails with a network error', () => ask(failedRead('network', 'membership'))],
    ['a membership read that fails with a 5xx', () => ask(failedRead('5xx', 'membership'))],
    ['a membership read that fails with a 429', () => ask(failedRead('429', 'membership', '7'))],
    [
      'a membership read that fails with a 429 and a date',
      () => ask(failedRead('429', 'membership', 'Wed, 21 Oct 2026 07:28:00 GMT')),
    ],
    [
      'a membership read that answers 401',
      () => ask(overriding(workos(), () => Response.json({ message: 'Unauthorized' }, { status: 401 }))),
    ],
    [
      'a membership read with a body that is not JSON',
      () =>
        ask(
          overriding(workos(), (url) =>
            url.pathname.endsWith('/organization_memberships') ? new Response('<html>', { status: 200 }) : undefined,
          ),
        ),
    ],
    [
      'a membership read with a body of another shape',
      () =>
        ask(
          overriding(workos(), (url) =>
            url.pathname.endsWith('/organization_memberships') ? Response.json({ data: 5 }) : undefined,
          ),
        ),
    ],
    [
      'a membership read with the body null',
      () =>
        ask(
          overriding(workos(), (url) =>
            url.pathname.endsWith('/organization_memberships') ? new Response('null', { status: 200 }) : undefined,
          ),
        ),
    ],
    ['a role read that fails with a network error', () => ask(failedRead('network', 'role'))],
    ['a role read that fails with a 5xx', () => ask(failedRead('5xx', 'role'))],
    ['a role read that fails with a 429', () => ask(failedRead('429', 'role', '3'))],
    [
      'a role read with a body of another shape',
      () =>
        ask(
          overriding(workos(), (url) =>
            url.pathname.includes('/roles/') ? Response.json({ permissions: 5 }) : undefined,
          ),
        ),
    ],
    [
      'a role read that answers 403',
      () =>
        ask(
          overriding(workos(), (url) =>
            url.pathname.includes('/roles/') ? Response.json({ message: 'Forbidden' }, { status: 403 }) : undefined,
          ),
        ),
    ],
    [
      '2 role reads that fail one after the other',
      () =>
        ask(
          overriding(
            stubWorkos(
              [STUB_PERSON],
              [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member', 'reviewer'] }],
            ),
            (url) => (url.pathname.includes('/roles/') ? new Response('{', { status: 200 }) : undefined),
          ),
        ),
    ],
  ]);

  it('a WorkOS fetch that throws at once', async () => {
    const thrown = new Error('fetch threw at once');

    const answer = await ask((() => {
      throw thrown;
    }) as typeof globalThis.fetch);

    expect(answer).toMatchInlineSnapshot(`
      {
        "body": {
          "errorCode": "INTERNAL",
          "errorName": "Default:Internal",
          "parameters": {},
        },
        "faults": [
          {
            "errorName": "Default:Internal",
            "message": "fetch threw at once",
            "name": "Error",
            "route": "GET /api/v2/admin/users/{userId}",
          },
        ],
        "headers": {
          "content-type": "application/json",
        },
        "spans": [
          {
            "name": "token check",
            "status": 0,
          },
          {
            "errorType": "Error",
            "name": "workos read",
            "status": 2,
          },
          {
            "name": "response.body",
            "status": 0,
          },
        ],
        "status": 500,
      }
    `);
  });

  describe('with the time limit of 5 seconds', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));

    for (const failure of ['timeout', 'stalled body'] as const) {
      it(`a membership read with a ${failure}`, async () => {
        const stub = workos();

        stub.fail(failure, { reads: ['membership'] });

        const asked = send(USER_ROUTE, issuer.workos(), instance(stub.fetch));

        await stub.reached(1);

        await vi.advanceTimersByTimeAsync(5000);

        expect(await asked).toMatchSnapshot();
      });
    }

    it('a role read with a timeout', async () => {
      const stub = workos();

      stub.fail('timeout', { reads: ['role'] });

      const asked = send(USER_ROUTE, issuer.workos(), instance(stub.fetch));

      await stub.reached(2);

      await vi.advanceTimersByTimeAsync(5000);

      expect(await asked).toMatchSnapshot();
    });

    it('a request that the client stops while a membership read waits', async () => {
      const stub = workos();

      stub.fail('timeout', { reads: ['membership'] });

      const controller = new AbortController();

      const asked = handle(
        new Request(`${base}${USER_ROUTE}`, {
          headers: { authorization: `Bearer ${await issuer.workos()}` },
          signal: controller.signal,
        }),
        instance(stub.fetch),
      );

      await stub.reached(1);

      controller.abort(new Error('the client left'));

      expect(await answerOf(await asked)).toMatchSnapshot();
    });
  });
});

function breaking(stub: StubWorkos, matches: (url: URL) => boolean, answer: () => unknown): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    matches(new URL(requestUrl(input))) ? answer() : stub.fetch(input, init)) as typeof globalThis.fetch;
}

const withText = (text: () => unknown): Response => Object.assign(Response.json({}), { text });

describe('a WorkOS read whose fetch or Response breaks a type', () => {
  const MEMBER_WITH_ROLE: readonly StubMembership[] = [
    { user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member'] },
  ];

  const reads: readonly (readonly [string, (answer: () => unknown) => Promise<unknown>])[] = [
    [
      'a membership read',
      (answer) =>
        send(
          USER_ROUTE,
          issuer.workos(),
          instance(breaking(workos(), (url) => url.pathname.endsWith('/organization_memberships'), answer)),
        ),
    ],
    [
      'a role read',
      (answer) =>
        send(
          '/api/ontology-service/v1/ontologies',
          issuer.workos(),
          instance(
            breaking(stubWorkos([STUB_PERSON], MEMBER_WITH_ROLE), (url) => url.pathname.includes('/roles/'), answer),
          ),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        ),
    ],
    [
      'an application read',
      (answer) =>
        send(
          CURRENT,
          issuer.m2m(),
          instance(breaking(workos(), (url) => url.pathname.startsWith('/connect/applications/'), answer)),
        ),
    ],
  ];

  const breaks: readonly (readonly [string, () => unknown])[] = [
    [
      'a Response whose text() throws a RangeError at once',
      () =>
        Promise.resolve(
          withText(() => {
            throw new RangeError('text threw at once');
          }),
        ),
    ],
    [
      'a Response whose text() throws a 418 ApiError at once',
      () =>
        Promise.resolve(
          withText(() => {
            throw new ApiError(418, 'Teapot');
          }),
        ),
    ],
    ['a Response whose text() gives a string with no Promise', () => Promise.resolve(withText(() => '{}'))],
    ['a fetch that gives a 500 Response with no Promise', () => new Response('', { status: 500 })],
    ['a fetch that gives a 404 Response with no Promise', () => new Response('', { status: 404 })],
    ['a fetch that gives undefined', () => undefined],
    ['a fetch that gives null', () => null],
    ['a Response whose text() gives undefined', () => Promise.resolve(withText(() => undefined))],
    [
      'a fetch that gives an object whose catch gives a 404 Response',
      () => ({ catch: () => Promise.resolve(new Response('', { status: 404 })) }),
    ],
    [
      'a Response whose text() gives an object whose catch gives the text',
      () => Promise.resolve(withText(() => ({ catch: () => Promise.resolve('{}') }))),
    ],
    [
      'a fetch that gives a thenable that rejects',
      () => ({ then: (_resolve: unknown, reject: (error: unknown) => void) => reject(new Error('thenable rejects')) }),
    ],
    [
      'a fetch that gives a thenable of a 404',
      () => ({ then: (resolve: (value: Response) => void) => resolve(new Response('', { status: 404 })) }),
    ],
  ];

  for (const [read, ask] of reads)
    pin(breaks.map(([name, answer]) => [`${read} with ${name}`, () => ask(answer)] as const));
});

describe('Users.get, Users.getBatch, and Users.getCurrent', () => {
  const user =
    (id: string, query = '') =>
    (fetch: typeof globalThis.fetch) =>
      send(`/api/v2/admin/users/${id}${query}`, issuer.workos(), instance(fetch));

  const batch = (body: unknown, fetch: typeof globalThis.fetch = workos().fetch, bearer: Bearer = issuer.workos()) =>
    send('/api/v2/admin/users/getBatch', bearer, instance(fetch), { method: 'POST', body: JSON.stringify(body) });

  const current = (fetch: typeof globalThis.fetch, bearer: Bearer = issuer.workos()) =>
    send(CURRENT, bearer, instance(fetch));

  const members = (url: URL) => url.pathname === '/user_management/organization_memberships';

  pin([
    ['get of an unknown user', () => user(UNKNOWN)(workos().fetch)],
    ['get of a former member', () => user(FORMER.id)(workos().fetch)],
    ['get of an active member with the status DELETED', () => user(PERSON, '?status=DELETED')(workos().fetch)],
    ['get of a former member with the status DELETED', () => user(FORMER.id, '?status=DELETED')(workos().fetch)],
    ['get with a status that is no status', () => user(PERSON, '?status=BOGUS')(workos().fetch)],
    ['get of an invited user', () => user(INVITED.id)(workos().fetch)],
    ['getBatch with an object', () => batch({})],
    ['getBatch with an empty list', () => batch([])],
    [
      'getBatch with 501 elements',
      () => batch(Array.from({ length: 501 }, (_, index) => ({ userId: `user_${index}` }))),
    ],
    ['getBatch with an element that is no object', () => batch([5])],
    ['getBatch with a userId that is no string', () => batch([{ userId: 5 }])],
    ['getBatch with a status that is no status', () => batch([{ userId: PERSON, status: 'BOGUS' }])],
    [
      'getBatch with a person with no Organization',
      () => batch([{ userId: PERSON }], workos().fetch, issuer.workos({ org_id: undefined })),
    ],
    ['getBatch of a GitHub token', () => batch([{ userId: PERSON }], workos().fetch, issuer.github())],
    [
      'getBatch with a member list that fails with a 5xx',
      () => batch([{ userId: PERSON }], failedRead('5xx', 'membership')),
    ],
    [
      'getBatch with a member list read of the Organization that fails with a 5xx',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses') ? Response.json({}, { status: 503 }) : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list read that fails with a 429',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses')
              ? Response.json({}, { status: 429, headers: { 'retry-after': '5' } })
              : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list read that fails with a network error',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses')
              ? Promise.reject(new TypeError('fetch failed'))
              : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list read that answers 404',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses') ? Response.json({}, { status: 404 }) : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list read that answers 403',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses') ? Response.json({}, { status: 403 }) : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list of another shape',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses') ? Response.json({ data: [{}] }) : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list that is not JSON',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses') ? new Response('<html>') : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list of 21 pages',
      () =>
        batch(
          [{ userId: PERSON }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses')
              ? Response.json({ data: [], list_metadata: { after: 'next' } })
              : undefined,
          ),
        ),
    ],
    [
      'getBatch with an application list of 21 pages',
      () =>
        batch(
          [{ userId: SERVICE_USER }],
          overriding(workos(), (url) =>
            url.pathname === '/connect/applications'
              ? Response.json({ data: [], list_metadata: { after: 'next' } })
              : undefined,
          ),
        ),
    ],
    [
      'getBatch with a member list and an application list that both fail',
      () =>
        batch(
          [{ userId: PERSON }, { userId: SERVICE_USER }],
          overriding(workos(), (url) =>
            members(url) && url.searchParams.has('statuses')
              ? Response.json({}, { status: 503 })
              : url.pathname === '/connect/applications'
                ? Response.json({}, { status: 429 })
                : undefined,
          ),
        ),
    ],
    ['getCurrent of a user that WorkOS does not find', () => current(workos().fetch, issuer.workos({ sub: UNKNOWN }))],
    ['getCurrent with a user read that fails with a network error', () => current(failedRead('network', 'user'))],
    ['getCurrent with a user read that fails with a 5xx', () => current(failedRead('5xx', 'user'))],
    ['getCurrent with a user read that fails with a 429', () => current(failedRead('429', 'user', '9'))],
    [
      'getCurrent with a user read that is not JSON',
      () =>
        current(
          overriding(workos(), (url) =>
            url.pathname.startsWith('/user_management/users/') ? new Response('<html>') : undefined,
          ),
        ),
    ],
    [
      'getCurrent with a user read of another shape',
      () =>
        current(
          overriding(workos(), (url) =>
            url.pathname.startsWith('/user_management/users/') ? Response.json({ id: 1 }) : undefined,
          ),
        ),
    ],
    [
      'getCurrent with a user read with the body null',
      () =>
        current(
          overriding(workos(), (url) =>
            url.pathname.startsWith('/user_management/users/') ? new Response('null') : undefined,
          ),
        ),
    ],
    [
      'getCurrent of a service user that the application list lacks',
      () =>
        current(
          overriding(workos(), (url) =>
            url.pathname === '/connect/applications' ? Response.json({ data: [] }) : undefined,
          ),
          issuer.m2m(),
        ),
    ],
    [
      'getCurrent of a service user with an application list that fails',
      () =>
        current(
          overriding(workos(), (url) =>
            url.pathname === '/connect/applications' ? Response.json({}, { status: 500 }) : undefined,
          ),
          issuer.m2m(),
        ),
    ],
  ]);

  it('getCurrent with a user read that has no answer in 5 seconds', async () => {
    const reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    expect(
      await current(
        overriding(workos(), (url) =>
          url.pathname.startsWith('/user_management/users/') ? Promise.reject(reason) : undefined,
        ),
      ),
    ).toMatchSnapshot();
  });
});

describe('the Organizations route', () => {
  const organizations = (fetch: typeof globalThis.fetch, bearer: Bearer = issuer.workos()) =>
    send('/api/ontology-service/v1/organizations', bearer, instance(fetch));

  const organization = (url: URL) => url.pathname.startsWith('/organizations/');
  const memberships = (url: URL) => url.pathname === '/user_management/organization_memberships';

  pin([
    [
      'a person whose list of memberships has 21 pages',
      () =>
        organizations(
          overriding(workos(), (url) =>
            memberships(url) ? Response.json({ data: [], list_metadata: { after: 'next' } }) : undefined,
          ),
        ),
    ],
    [
      'a person whose list of memberships fails with a 429',
      () =>
        organizations(
          overriding(workos(), (url) =>
            memberships(url) ? Response.json({}, { status: 429, headers: { 'retry-after': '2' } }) : undefined,
          ),
        ),
    ],
    [
      'a person whose list of memberships fails with a 500',
      () =>
        organizations(
          overriding(workos(), (url) => (memberships(url) ? Response.json({}, { status: 500 }) : undefined)),
        ),
    ],
    [
      'a person whose list of memberships has another shape',
      () => organizations(overriding(workos(), (url) => (memberships(url) ? Response.json({ data: [] }) : undefined))),
    ],
    [
      'a person whose list of memberships has no body',
      () =>
        organizations(
          overriding(workos(), (url) => (memberships(url) ? Response.json({}, { status: 404 }) : undefined)),
        ),
    ],
    ['a GitHub token', () => organizations(workos().fetch, issuer.github())],
    [
      'a service user whose Organization WorkOS does not find',
      () => organizations(stubWorkos([STUB_PERSON], MEMBERSHIPS, { organizationNames: {} }).fetch, issuer.m2m()),
    ],
    [
      'a service user whose Organization has another ID',
      () =>
        organizations(
          overriding(workos(), (url) =>
            organization(url) ? Response.json({ id: 'org_other', name: 'Other' }) : undefined,
          ),
          issuer.m2m(),
        ),
    ],
    [
      'a service user whose Organization read fails with a 500',
      () =>
        organizations(
          overriding(workos(), (url) => (organization(url) ? Response.json({}, { status: 500 }) : undefined)),
          issuer.m2m(),
        ),
    ],
    [
      'a service user whose Organization read fails with a 429',
      () =>
        organizations(
          overriding(workos(), (url) => (organization(url) ? Response.json({}, { status: 429 }) : undefined)),
          issuer.m2m(),
        ),
    ],
    [
      'a service user whose Organization read fails with a network error',
      () =>
        organizations(
          overriding(workos(), (url) =>
            organization(url) ? Promise.reject(new TypeError('fetch failed')) : undefined,
          ),
          issuer.m2m(),
        ),
    ],
    [
      'a service user whose Organization read has a body of another shape',
      () =>
        organizations(
          overriding(workos(), (url) => (organization(url) ? Response.json({ id: 1 }) : undefined)),
          issuer.m2m(),
        ),
    ],
  ]);
});

describe('the token route', () => {
  const unstubbed = globalThis.fetch;
  const network = setupServer();

  beforeAll(() => network.listen({ onUnhandledRequest: 'error' }));

  afterAll(() => network.close());

  afterEach(() => network.resetHandlers());

  const { authkitDomain, ...withoutAuthkit } = testSettings;

  void authkitDomain;

  const post = async (
    form: string | Record<string, string>,
    answer: () => Response | 'network error' | 'no answer',
    settings: Settings = testSettings,
    init: RequestInit = {},
  ) => {
    const stub = stubAuthkitToken();

    stub.answer = answer;

    network.use(stub.handler);

    return answerOf(
      await handle(
        new Request(`${base}/multipass/api/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic abc' },
          body: typeof form === 'string' ? form : new URLSearchParams(form),
          ...init,
        }),
        instance(unstubbed, { settings }),
      ),
    );
  };

  const ok = () => Response.json({ access_token: 'x' });
  const grant = { grant_type: 'client_credentials' };

  pin([
    ['a body of more than 4096 bytes', () => post(`grant_type=client_credentials&x=${'a'.repeat(5000)}`, ok)],
    [
      'a parameter that the body holds twice',
      () => post('grant_type=client_credentials&grant_type=client_credentials', ok),
    ],
    ['a grant that is not client_credentials', () => post({ grant_type: 'password' }, ok)],
    ['no grant', () => post({}, ok)],
    ['an environment with no AuthKit domain', () => post(grant, ok, withoutAuthkit)],
    ['a WorkOS call that fails with a network error', () => post(grant, () => 'network error')],
    ['a WorkOS answer of 304', () => post(grant, () => new Response(null, { status: 304 }))],
    [
      'a WorkOS answer of a redirect',
      () => post(grant, () => new Response(null, { status: 302, headers: { location: 'https://evil.example/token' } })),
    ],
    ['a WorkOS answer of 400', () => post(grant, () => Response.json({ error: 'invalid_client' }, { status: 400 }))],
    [
      'a WorkOS answer of 429 with a Retry-After of a date',
      () =>
        post(grant, () =>
          Response.json(
            { error: 'slow_down' },
            { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
          ),
        ),
    ],
    ['a WorkOS answer of 204', () => post(grant, () => new Response(null, { status: 204 }))],
    [
      'a request body stream with a chunk that is null',
      () =>
        post(grant, ok, testSettings, {
          body: new ReadableStream({
            start: (controller) => {
              controller.enqueue(null as never);

              controller.close();
            },
          }),
          duplex: 'half',
        } as RequestInit),
    ],
    [
      'a WorkOS answer with a body that fails',
      () =>
        post(
          grant,
          () =>
            new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError('terminated')) }), {
              status: 200,
            }),
        ),
    ],
  ]);

  it('a request whose body getter throws', async () => {
    const request = new Request(`${base}/multipass/api/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic abc' },
      body: new URLSearchParams(grant),
    });

    Object.defineProperty(request, 'body', {
      get: () => {
        throw new Error('body getter threw');
      },
    });

    expect(await answerOf(await handle(request, instance(unstubbed)))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "invalid_request",
        },
        "faults": [],
        "headers": {
          "cache-control": "no-store",
          "content-type": "application/json",
          "pragma": "no-cache",
        },
        "spans": [
          {
            "name": "response.body",
            "status": 0,
          },
        ],
        "status": 400,
      }
    `);
  });

  it('a WorkOS answer whose status the route cannot copy', async () => {
    const answer = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    });

    Object.defineProperty(answer, 'status', { value: 700 });

    expect(await post(grant, () => answer)).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "temporarily_unavailable",
        },
        "faults": [
          {
            "errorName": "OntologyService:WorkosUnavailable",
            "message": "OntologyService:WorkosUnavailable",
            "name": "ApiError",
            "route": "POST /multipass/api/oauth2/token",
          },
        ],
        "headers": {
          "cache-control": "no-store",
          "content-type": "application/json",
          "pragma": "no-cache",
        },
        "spans": [
          {
            "errorType": "RangeError",
            "httpStatus": 700,
            "name": "workos token",
            "status": 2,
          },
          {
            "name": "response.body",
            "status": 0,
          },
        ],
        "status": 503,
      }
    `);
  });

  it('a request whose body another reader locked', async () => {
    const request = new Request(`${base}/multipass/api/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic abc' },
      body: new URLSearchParams(grant),
    });

    request.body?.getReader();

    expect(await answerOf(await handle(request, instance(unstubbed)))).toMatchSnapshot();
  });

  it('a request whose body is already read', async () => {
    const request = new Request(`${base}/multipass/api/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic abc' },
      body: new URLSearchParams(grant),
    });

    await request.text();

    expect(await answerOf(await handle(request, instance(unstubbed)))).toMatchSnapshot();
  });

  it('a client that stops the request', async () => {
    const stub = stubAuthkitToken();

    stub.answer = () => 'no answer';

    network.use(stub.handler);

    const controller = new AbortController();

    const asked = handle(
      new Request(`${base}/multipass/api/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic abc' },
        body: new URLSearchParams(grant),
        signal: controller.signal,
      }),
      instance(unstubbed),
    );

    while (stub.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

    controller.abort();

    expect(await answerOf(await asked)).toMatchSnapshot();
  });
});

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();

    return 'no error';
  } catch (error) {
    if (error instanceof ApiError)
      return {
        kind: 'ApiError',
        status: error.status,
        errorName: error.errorName,
        parameters: error.parameters,
        headers: error.headers,
      };

    return {
      kind: error instanceof Error ? error.constructor.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const port = (fetch: typeof globalThis.fetch) => rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch }));
const empty = () => stubWorkos([], [], { roles: {} });

const withMembers = () =>
  stubWorkos([], [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active' }], { roles: {} });

describe('the WorkOS port of publish', () => {
  pin([
    ['a read with a network error', () => rejected(() => port(failedPublish('network', 'permissions')).read())],
    ['a read with a 5xx', () => rejected(() => port(failedPublish('5xx', 'permissions')).read())],
    ['a read with a 429', () => rejected(() => port(failedPublish('429', 'permissions')).read())],
    [
      'a read with a body that is not JSON',
      () =>
        rejected(() =>
          port(
            overriding(empty(), (url) =>
              url.pathname === '/authorization/permissions' ? new Response('<html>') : undefined,
            ),
          ).read(),
        ),
    ],
    [
      'a read with a body of another shape',
      () =>
        rejected(() =>
          port(
            overriding(empty(), (url) =>
              url.pathname === '/authorization/permissions' ? Response.json({ data: 5 }) : undefined,
            ),
          ).read(),
        ),
    ],
    [
      'a role list that names a next page',
      () =>
        rejected(() =>
          port(
            overriding(empty(), (url) =>
              url.pathname === '/authorization/roles'
                ? Response.json({ data: [], list_metadata: { after: 'next' } })
                : undefined,
            ),
          ).read(),
        ),
    ],
    ['a role read that fails', () => rejected(() => port(failedPublish('5xx', 'roles')).read())],
    [
      'a write that fails with a 5xx',
      () => rejected(() => port(failedPublish('5xx', 'write')).apply({ step: 'createRole', role: 'admin' })),
    ],
    [
      'a write that fails with a network error',
      () =>
        rejected(() => port(failedPublish('network', 'write')).apply({ step: 'createPermission', permission: 'a:b' })),
    ],
    [
      'a write that answers 409 with another code',
      () =>
        rejected(() =>
          port(overriding(empty(), () => Response.json({ code: 'other' }, { status: 409 }))).apply({
            step: 'createRole',
            role: 'admin',
          }),
        ),
    ],
    [
      'a write that answers 409 with its code',
      () =>
        rejected(() =>
          port(overriding(empty(), () => Response.json({ code: 'role_slug_conflict' }, { status: 409 }))).apply({
            step: 'createRole',
            role: 'admin',
          }),
        ),
    ],
    [
      'a write that answers a body that is not JSON',
      () =>
        rejected(() =>
          port(overriding(empty(), () => new Response('<html>', { status: 500 }))).apply({
            step: 'createRole',
            role: 'admin',
          }),
        ),
    ],
    [
      'a set of permissions that fails',
      () => rejected(() => port(failedPublish('5xx', 'write')).setPermissions('admin', ['a:b'])),
    ],
    [
      'a description of a slug that the URL parser changes',
      () => rejected(() => port(empty().fetch).apply({ step: 'setDescription', permission: '..', description: 'd' })),
    ],
    [
      'an empty role slug of a permission add',
      () => rejected(() => port(empty().fetch).apply({ step: 'addPermission', role: '', permission: 'a:b' })),
    ],
    [
      'a set of permissions of a role slug that the URL parser changes',
      () => rejected(() => port(empty().fetch).setPermissions('.', [])),
    ],
    [
      'a list of members that has no role',
      () =>
        rejected(async () => {
          const slugs: unknown[] = [];

          for await (const roles of port(
            overriding(withMembers(), (url) =>
              url.pathname === '/user_management/organization_memberships' ? Response.json({ data: [{}] }) : undefined,
            ),
          ).memberRoles())
            slugs.push(roles);

          return slugs;
        }),
    ],
    [
      'a list of members that fails',
      () =>
        rejected(async () => {
          for await (const roles of port(failedPublish('5xx', 'membership', withMembers())).memberRoles()) void roles;
        }),
    ],
    [
      'a list of members of an Organization list that fails',
      () =>
        rejected(async () => {
          for await (const roles of port(failedPublish('5xx', 'organizations', withMembers())).memberRoles())
            void roles;
        }),
    ],
  ]);
});

async function traced(run: () => Promise<unknown>): Promise<unknown> {
  const error = await rejected(run);

  const spans = recorder
    .spans()
    .filter(({ name }) => name === 'workos read' || name === 'workos write')
    .map(({ name, status, attributes }) => ({
      name,
      kind: attributes['workos.read'] ?? attributes['workos.write'],
      status: status.code,
      ...(attributes['error.type'] === undefined ? {} : { errorType: attributes['error.type'] }),
      ...(attributes['http.status_code'] === undefined ? {} : { httpStatus: attributes['http.status_code'] }),
    }));

  return { error, spans };
}

const withJson = (json: () => unknown): Response => Object.assign(Response.json({}), { json });

describe('the WorkOS port of publish, whose fetch or Response breaks a type', () => {
  const calls: readonly (readonly [
    string,
    () => StubWorkos,
    (url: URL) => boolean,
    (broken: typeof globalThis.fetch) => Promise<unknown>,
  ])[] = [
    [
      'a permission read',
      empty,
      (url) => url.pathname === '/authorization/permissions',
      (broken) => port(broken).read(),
    ],
    [
      'a role create',
      empty,
      (url) => url.pathname === '/authorization/roles',
      (broken) => port(broken).apply({ step: 'createRole', role: 'admin' }),
    ],
    [
      'an Organization page',
      withMembers,
      (url) => url.pathname === '/organizations',
      async (broken) => {
        for await (const roles of port(broken).memberRoles()) void roles;
      },
    ],
  ];

  const breaks: readonly (readonly [string, () => unknown])[] = [
    [
      'a fetch that throws a RangeError at once',
      () => {
        throw new RangeError('fetch threw at once');
      },
    ],
    [
      'a fetch that throws a 418 ApiError at once',
      () => {
        throw new ApiError(418, 'Teapot');
      },
    ],
    ['a fetch that gives a 500 Response with no Promise', () => new Response('', { status: 500 })],
    ['a fetch that gives undefined', () => undefined],
    ['a fetch that gives null', () => null],
    [
      'a fetch that gives an object whose catch gives a 500 Response',
      () => ({ catch: () => Promise.resolve(new Response('', { status: 500 })) }),
    ],
    [
      'a fetch that gives a thenable that rejects',
      () => ({ then: (_resolve: unknown, reject: (error: unknown) => void) => reject(new Error('thenable rejects')) }),
    ],
    [
      'a fetch that gives a Promise that rejects with a 418 ApiError',
      () => Promise.reject(new ApiError(418, 'Teapot')),
    ],
    [
      'a Response whose json() throws a RangeError at once',
      () =>
        Promise.resolve(
          withJson(() => {
            throw new RangeError('json threw at once');
          }),
        ),
    ],
    [
      'a Response whose json() throws a 418 ApiError at once',
      () =>
        Promise.resolve(
          withJson(() => {
            throw new ApiError(418, 'Teapot');
          }),
        ),
    ],
    ['a Response whose json() gives an object with no Promise', () => Promise.resolve(withJson(() => ({ data: [] })))],
    ['a Response whose json() gives undefined', () => Promise.resolve(withJson(() => undefined))],
    [
      'a Response whose json() gives an object whose catch gives a page',
      () => Promise.resolve(withJson(() => ({ catch: () => Promise.resolve({ data: [] }) }))),
    ],
    [
      'a Response whose json() gives a Promise that rejects',
      () => Promise.resolve(withJson(() => Promise.reject(new RangeError('json rejects')))),
    ],
  ];

  for (const [call, stub, matches, run] of calls)
    pin(
      breaks.map(
        ([name, answer]) =>
          [`${call} with ${name}`, () => traced(() => run(breaking(stub(), matches, answer)))] as const,
      ),
    );
});

describe('the WorkOS port of publish, with the spans of a failure', () => {
  const members = (fetch: typeof globalThis.fetch) => async () => {
    for await (const roles of port(fetch).memberRoles()) void roles;
  };

  pin([
    ['a read with a 5xx', () => traced(() => port(failedPublish('5xx', 'permissions')).read())],
    ['a read with a 429', () => traced(() => port(failedPublish('429', 'permissions')).read())],
    ['a read with a network error', () => traced(() => port(failedPublish('network', 'permissions')).read())],
    [
      'a read with a body that is not JSON',
      () =>
        traced(() =>
          port(
            overriding(empty(), (url) =>
              url.pathname === '/authorization/permissions' ? new Response('<html>') : undefined,
            ),
          ).read(),
        ),
    ],
    [
      'a read with a body of another shape',
      () =>
        traced(() =>
          port(
            overriding(empty(), (url) =>
              url.pathname === '/authorization/permissions' ? Response.json({ data: 5 }) : undefined,
            ),
          ).read(),
        ),
    ],
    [
      'a role list that names a next page',
      () =>
        traced(() =>
          port(
            overriding(empty(), (url) =>
              url.pathname === '/authorization/roles'
                ? Response.json({ data: [], list_metadata: { after: 'next' } })
                : undefined,
            ),
          ).read(),
        ),
    ],
    ['a role read that fails', () => traced(() => port(failedPublish('5xx', 'roles')).read())],
    [
      'a write that fails with a 5xx',
      () => traced(() => port(failedPublish('5xx', 'write')).apply({ step: 'createRole', role: 'admin' })),
    ],
    [
      'a write that answers 409 with its code',
      () =>
        traced(() =>
          port(overriding(empty(), () => Response.json({ code: 'role_slug_conflict' }, { status: 409 }))).apply({
            step: 'createRole',
            role: 'admin',
          }),
        ),
    ],
    [
      'a write that answers 409 with another code',
      () =>
        traced(() =>
          port(overriding(empty(), () => Response.json({ code: 'other' }, { status: 409 }))).apply({
            step: 'createRole',
            role: 'admin',
          }),
        ),
    ],
    [
      'a set of permissions that fails',
      () => traced(() => port(failedPublish('5xx', 'write')).setPermissions('admin', ['a:b'])),
    ],
    [
      'a description of a slug that the URL parser changes',
      () => traced(() => port(empty().fetch).apply({ step: 'setDescription', permission: '..', description: 'd' })),
    ],
    [
      'a list of members that has no role',
      () =>
        traced(
          members(
            overriding(withMembers(), (url) =>
              url.pathname === '/user_management/organization_memberships' ? Response.json({ data: [{}] }) : undefined,
            ),
          ),
        ),
    ],
    ['a list of members that fails', () => traced(members(failedPublish('5xx', 'membership', withMembers())))],
  ]);
});

function failedPublish(
  failure: StubFailure,
  read: Parameters<typeof failedRead>[1],
  stub: StubWorkos = stubWorkos([], [], { roles: {} }),
): typeof globalThis.fetch {
  stub.fail(failure, { reads: [read] });

  return stub.fetch;
}

describe('the settings from the environment', () => {
  const without = (name: string) => Object.fromEntries(Object.entries(testEnv).filter(([key]) => key !== name));

  const message = (run: () => unknown): unknown => {
    try {
      run();

      return 'no error';
    } catch (error) {
      return {
        kind: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  pin([
    ['a missing PRODUCT_RID', async () => message(() => settingsFromEnv(without('PRODUCT_RID')))],
    ['a missing WORKOS_CLIENT_ID', async () => message(() => settingsFromEnv(without('WORKOS_CLIENT_ID')))],
    ['an empty ONTOLOGY_BASE_URL', async () => message(() => settingsFromEnv({ ...testEnv, ONTOLOGY_BASE_URL: '' }))],
    ['a missing AUTHKIT_DOMAIN', async () => message(() => settingsFromEnv(without('AUTHKIT_DOMAIN')))],
    ['a missing trusted repository', async () => message(() => settingsFromEnv(without('TRUSTED_GITHUB_REPOSITORY')))],
    [
      'a trusted environment with a comma',
      async () => message(() => settingsFromEnv({ ...testEnv, TRUSTED_GITHUB_ENVIRONMENT: 'a,b' })),
    ],
    [
      'a trusted repository with a space at its end',
      async () => message(() => settingsFromEnv({ ...testEnv, TRUSTED_GITHUB_REPOSITORY: 'example/test-app ' })),
    ],
    [
      'the input of an environment with the missing variables named',
      async () => inputFromEnv(without('WORKOS_API_KEY'), () => ({}) as never, []),
    ],
    [
      'a missing DATABASE_URL is a missing setting',
      async () => inputFromEnv({ ...testEnv, WORKOS_API_KEY: 'sk' }, () => ({}) as never, []),
    ],
  ]);
});
