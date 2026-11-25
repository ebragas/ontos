import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { workosUsers, type UserSource, type WorkosUser } from './index.ts';
import { handle, type HandleInput } from '../handler/index.ts';
import { given, noDb, testInput, testSettings } from '../service.test-utils.ts';
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
import { workosServer } from './workosServer.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const base = 'http://localhost';
const MEMBER_COUNT = 250;

const MEMBERS: readonly WorkosUser[] = Array.from({ length: MEMBER_COUNT - 1 }, (_, i) => ({
  id: `user_01MEMBER${String(i).padStart(18, '0')}`,
  email: `member${i}@example.com`,
  first_name: null,
  last_name: null,
}));

const OUTSIDER: WorkosUser = {
  id: 'user_01OUTSIDER000000000000000',
  email: 'alan@example.com',
  first_name: 'Alan',
  last_name: 'Turing',
};

const MEMBERSHIPS: readonly StubMembership[] = [
  { user_id: PERSON, organization_id: ORGANIZATION, status: 'active' },
  ...MEMBERS.map((user): StubMembership => ({ user_id: user.id, organization_id: ORGANIZATION, status: 'active' })),
  { user_id: OUTSIDER.id, organization_id: OTHER_ORGANIZATION, status: 'active' },
];

const MADE_UP_USERS = Array.from({ length: 500 }, (_, i) => ({
  userId: `user_01MADEUP${String(i).padStart(18, '0')}`,
}));

const MADE_UP_CLIENTS = Array.from({ length: 500 }, (_, i) => ({
  userId: `client_01MADEUP${String(i).padStart(18, '0')}`,
}));

const ADA = {
  id: PERSON,
  username: 'ada@example.com',
  email: 'ada@example.com',
  givenName: 'Ada',
  familyName: 'Lovelace',
  realm: 'workos',
  status: 'ACTIVE',
  attributes: {},
};

const NIGHTLY_SYNC = {
  id: SERVICE_USER,
  username: SERVICE_USER,
  givenName: 'Nightly sync',
  realm: 'workos',
  status: 'ACTIVE',
  attributes: {},
};

function routeUsers(fetch?: typeof globalThis.fetch): UserSource {
  return { ...workosUsers(STUB_WORKOS_KEY, fetch === undefined ? {} : { fetch }), permissions: () => given([]) };
}

const answerWorkos = workosServer();

let issuer: TestIssuer;
let workos: StubWorkos;
let input: HandleInput;
let token: string;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);
});

beforeEach(async () => {
  token = await issuer.workos();

  expect(STUB_PERSON.id).toBe(PERSON);

  workos = stubWorkos([STUB_PERSON, ...MEMBERS, OUTSIDER], MEMBERSHIPS);

  input = { ...testInput, db: fallibleOf(noDb), keys: issuer.keys, users: routeUsers(workos.fetch) };

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => {
  consoleLog.mockRestore();

  vi.useRealTimers();
});

function getBatch(body: unknown): Promise<Response> {
  return handle(
    new Request(`${base}/api/v2/admin/users/getBatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    input,
  );
}

function get(userId: string): Promise<Response> {
  return handle(
    new Request(`${base}/api/v2/admin/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    input,
  );
}

function readsSince(from: number): {
  readonly memberPages: number;
  readonly applicationPages: number;
  readonly applicationReads: number;
  readonly other: readonly string[];
} {
  const reads = workos.requests.slice(from);
  const memberPages = reads.filter((path) => path.startsWith('/user_management/organization_memberships?'));
  const applicationPages = reads.filter((path) => path.startsWith('/connect/applications?'));
  const applicationReads = reads.filter((path) => path.startsWith('/connect/applications/'));

  return {
    memberPages: memberPages.length,
    applicationPages: applicationPages.length,
    applicationReads: applicationReads.length,
    other: reads.filter((path) => ![...memberPages, ...applicationPages, ...applicationReads].includes(path)),
  };
}

describe('the WorkOS reads of the user routes follow the size of the Organization', () => {
  it('service/authentication#user-ids: 500 made-up user IDs cost at most ceil(members / 100) membership reads, and no application read', async () => {
    const from = workos.requests.length;

    const response = await getBatch(MADE_UP_USERS);

    expect([response.status, await response.json()]).toEqual([200, { data: {} }]);

    expect(readsSince(from)).toEqual({
      memberPages: Math.ceil(MEMBER_COUNT / 100),
      applicationPages: 0,
      applicationReads: 0,
      other: [],
    });
  });

  it('service/authentication#user-ids: each membership read is 1 page of 100 of the caller Organization, with the active and inactive statuses', async () => {
    const from = workos.requests.length;

    await getBatch(MADE_UP_USERS);

    const first = new URL(`https://api.workos.com${workos.requests[from] ?? ''}`).searchParams;

    expect(Object.fromEntries(first)).toEqual({
      organization_id: ORGANIZATION,
      statuses: 'active,inactive',
      limit: '100',
      order: 'asc',
    });
  });

  it('service/authentication#user-ids: 500 made-up client IDs cost 1 page of the application list of the Organization, and no read of an application by ID', async () => {
    const from = workos.requests.length;

    const response = await getBatch(MADE_UP_CLIENTS);

    expect([response.status, await response.json()]).toEqual([200, { data: {} }]);

    expect(readsSince(from)).toEqual({ memberPages: 0, applicationPages: 1, applicationReads: 0, other: [] });
  });

  it('service/authentication#user-ids: a second request in 60 seconds reads nothing from WorkOS', async () => {
    await getBatch([...MADE_UP_USERS.slice(0, 250), ...MADE_UP_CLIENTS.slice(0, 250)]);

    const from = workos.requests.length;

    expect((await get(MEMBERS[7]?.id ?? '')).status).toBe(200);

    expect((await get(SERVICE_USER)).status).toBe(200);

    expect((await getBatch([{ userId: PERSON }, ...MADE_UP_USERS.slice(1)])).status).toBe(200);

    expect(workos.requests.slice(from)).toEqual([]);
  });

  it('service/authentication#user-ids: a real member and a real service user get the same Users from the kept lists', async () => {
    const response = await getBatch([
      { userId: PERSON },
      { userId: SERVICE_USER },
      { userId: OUTSIDER.id },
      ...MADE_UP_USERS.slice(0, 10),
    ]);

    expect(await response.json()).toEqual({ data: { [PERSON]: ADA, [SERVICE_USER]: NIGHTLY_SYNC } });
  });
});

describe('the kept member list with WorkOS down', () => {
  it('service/authentication#user-ids: a kept list of at most 300 seconds answers, and then the request gets 503 OntologyService:WorkosUnavailable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    token = await issuer.workos();

    expect(await (await get(PERSON)).json()).toEqual(ADA);

    workos.fail('5xx');

    vi.advanceTimersByTime(299_000);

    expect(await (await get(PERSON)).json()).toEqual(ADA);

    vi.advanceTimersByTime(2_000);

    token = await issuer.workos();

    const refused = await get(PERSON);

    expect([
      refused.status,
      ((await refused.json()) as { errorName: string }).errorName,
      refused.headers.get('retry-after'),
    ]).toEqual([503, 'OntologyService:WorkosUnavailable', '10']);
  });

  it('service/authentication#user-ids: a cold instance with WorkOS down gives 503, never an empty answer', async () => {
    workos.fail('5xx');

    const refused = await getBatch([{ userId: PERSON }]);

    expect([refused.status, ((await refused.json()) as { errorName: string }).errorName]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
    ]);
  });

  it('service/authentication#user-ids: a kept application list of 61 seconds answers a service user while WorkOS is down', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    workos = stubWorkos([STUB_PERSON], undefined, { applications: { [SERVICE_USER]: STUB_APPLICATION } });

    input = { ...input, users: routeUsers(workos.fetch) };

    expect(await (await get(SERVICE_USER)).json()).toEqual(NIGHTLY_SYNC);

    workos.fail('network');

    vi.advanceTimersByTime(61_000);

    const from = workos.requests.length;

    expect(await (await get(SERVICE_USER)).json()).toEqual(NIGHTLY_SYNC);

    expect(readsSince(from)).toMatchObject({ applicationPages: 1 });
  });

  it('service/authentication#user-ids: a failed page 2 of 3 gives 503 and keeps nothing, and the next request reads the whole list again', async () => {
    let failed = false;

    answerWorkos((request) => {
      if (!failed && request.url.includes('organization_memberships?') && request.url.includes('after=100')) {
        failed = true;

        return Response.json({ message: 'Server error' }, { status: 500 });
      }

      return workos.fetch(request);
    });

    input = { ...input, users: routeUsers() };

    const refused = await getBatch([{ userId: PERSON }]);

    expect([refused.status, ((await refused.json()) as { errorName: string }).errorName]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
    ]);

    const from = workos.requests.length;

    expect(await (await getBatch([{ userId: PERSON }, { userId: MEMBERS[200]?.id ?? '' }])).json()).toMatchObject({
      data: { [PERSON]: ADA, [MEMBERS[200]?.id ?? '']: { status: 'ACTIVE' } },
    });

    expect(readsSince(from)).toMatchObject({ memberPages: 3 });
  });
});

describe('the time limit of 1 list', () => {
  it('service/authentication#user-ids: a page 2 with no answer within the 5 seconds of the whole list gives 503 and keeps nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

    let held = false;

    answerWorkos((request) => {
      if (!request.url.includes('after=100')) return workos.fetch(request);

      held = true;

      return new Promise<Response>(() => undefined);
    });

    input = { ...input, users: routeUsers() };

    const pending = getBatch([{ userId: PERSON }]);

    while (!held) await new Promise((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(5_000);

    const refused = await pending;

    expect([refused.status, ((await refused.json()) as { errorName: string }).errorName]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
    ]);

    input = { ...input, users: routeUsers(workos.fetch) };
  });
});

describe('the order and the size of a list', () => {
  const APPLICATIONS = Array.from({ length: 150 }, (_, i) => ({
    object: 'connect_application',
    client_id: `client_01APP${String(i).padStart(21, '0')}`,
    name: `App ${i}`,
    application_type: 'm2m',
    organization_id: ORGANIZATION,
  }));

  const applicationList = (request: Request): Response => {
    const query = new URL(request.url).searchParams;

    if (query.get('order') !== 'asc')
      return Response.json({
        object: 'list',
        data: APPLICATIONS.slice(-100).reverse(),
        list_metadata: { before: 'older', after: null },
      });

    const start = Number(query.get('after') ?? 0);

    return Response.json({
      object: 'list',
      data: APPLICATIONS.slice(start, start + 100),
      list_metadata: { before: null, after: start + 100 < APPLICATIONS.length ? String(start + 100) : null },
    });
  };

  it('service/authentication#user-ids: the application list is read oldest first, so the oldest of 150 applications is on page 1 and the newest on page 2', async () => {
    answerWorkos(applicationList);

    input = { ...input, users: routeUsers() };

    const [oldest, newest] = [APPLICATIONS[0]?.client_id ?? '', APPLICATIONS[149]?.client_id ?? ''];

    expect(await (await getBatch([{ userId: oldest }, { userId: newest }])).json()).toMatchObject({
      data: { [oldest]: { givenName: 'App 0' }, [newest]: { givenName: 'App 149' } },
    });
  });

  it('service/authentication#user-ids: a list past 20 pages is kept as too large, so 3 requests in 60 seconds read its 20 pages once', async () => {
    const many = Array.from({ length: 2_000 }, (_, i) => ({
      id: `user_01MANY${String(i).padStart(20, '0')}`,
      email: `m${i}@example.com`,
      first_name: null,
      last_name: null,
    }));

    workos = stubWorkos(
      [STUB_PERSON, ...many],
      [
        { user_id: PERSON, organization_id: ORGANIZATION, status: 'active' },
        ...many.map((user): StubMembership => ({ user_id: user.id, organization_id: ORGANIZATION, status: 'active' })),
      ],
    );

    input = { ...input, users: routeUsers(workos.fetch), reportFault: () => undefined };

    for (let request = 0; request < 3; request += 1) {
      const refused = await getBatch([{ userId: PERSON }]);

      expect([refused.status, ((await refused.json()) as { errorName: string }).errorName]).toEqual([
        500,
        'Default:Internal',
      ]);
    }

    expect(readsSince(0)).toMatchObject({ memberPages: 20 });
  });

  function tooLarge(): void {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      id: `user_01MANY${String(i).padStart(20, '0')}`,
      email: `m${i}@example.com`,
      first_name: null,
      last_name: null,
    }));

    workos = stubWorkos(
      [STUB_PERSON, OUTSIDER, ...many],
      [
        { user_id: PERSON, organization_id: ORGANIZATION, status: 'active' },
        ...many.map((user): StubMembership => ({ user_id: user.id, organization_id: ORGANIZATION, status: 'active' })),
        { user_id: OUTSIDER.id, organization_id: OTHER_ORGANIZATION, status: 'active' },
      ],
    );

    input = { ...input, users: routeUsers(workos.fetch), reportFault: () => undefined };
  }

  it('service/authentication#user-ids: a too-large answer older than 60 seconds is no fallback: a WorkOS 5xx then gives 503 with Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    tooLarge();

    expect((await getBatch([{ userId: PERSON }])).status).toBe(500);

    vi.advanceTimersByTime(61_000);

    token = await issuer.workos();

    workos.fail('5xx');

    const refused = await getBatch([{ userId: PERSON }]);

    expect([
      refused.status,
      ((await refused.json()) as { errorName: string }).errorName,
      refused.headers.get('retry-after'),
    ]).toEqual([503, 'OntologyService:WorkosUnavailable', '10']);
  });

  it('service/authentication#user-ids: a too-large answer of 1 Organization does not change the answers for another Organization on the same instance', async () => {
    tooLarge();

    expect((await getBatch([{ userId: PERSON }])).status).toBe(500);

    token = await issuer.workos({ org_id: OTHER_ORGANIZATION });

    const other = await getBatch([{ userId: OUTSIDER.id }]);

    expect([other.status, await other.json()]).toEqual([
      200,
      { data: { [OUTSIDER.id]: expect.objectContaining({ id: OUTSIDER.id, status: 'ACTIVE' }) } },
    ]);
  });

  it('service/authentication#user-ids: the member list is read oldest first, so a stub with another default order still gives each of 250 members', async () => {
    const memberships = MEMBERSHIPS.filter((item) => item.organization_id === ORGANIZATION);
    const users = [STUB_PERSON, ...MEMBERS];

    answerWorkos((request) => {
      const query = new URL(request.url).searchParams;

      const item = (m: StubMembership) => ({
        object: 'organization_membership',
        ...m,
        user: users.find((user) => user.id === m.user_id),
      });

      if (query.get('order') !== 'asc')
        return Response.json({
          object: 'list',
          data: memberships.slice(-100).reverse().map(item),
          list_metadata: { before: 'older', after: null },
        });

      const start = Number(query.get('after') ?? 0);

      return Response.json({
        object: 'list',
        data: memberships.slice(start, start + 100).map(item),
        list_metadata: { before: null, after: start + 100 < memberships.length ? String(start + 100) : null },
      });
    });

    input = { ...input, users: routeUsers() };

    const newest = MEMBERS[MEMBERS.length - 1]?.id ?? '';

    const answer = (await (await getBatch([{ userId: PERSON }, { userId: newest }])).json()) as {
      data: Record<string, unknown>;
    };

    expect(Object.keys(answer.data).sort()).toEqual([PERSON, newest].sort());
  });
});

describe('concurrent requests and the token check', () => {
  it('service/authentication#user-ids: 20 concurrent batches of made-up IDs on a cold instance share 1 read of the member list', async () => {
    const answers = await Promise.all(Array.from({ length: 20 }, () => getBatch(MADE_UP_USERS)));

    expect(answers.map((answer) => answer.status)).toEqual(Array.from({ length: 20 }, () => 200));

    expect(readsSince(0)).toEqual({
      memberPages: Math.ceil(MEMBER_COUNT / 100),
      applicationPages: 0,
      applicationReads: 0,
      other: [],
    });
  });

  it('service/authentication#user-ids: a listed M2M application of another Organization gets 404 UserNotFound and no entry', async () => {
    const foreign = {
      object: 'connect_application',
      client_id: SERVICE_USER,
      name: 'Foreign sync',
      application_type: 'm2m',
      organization_id: OTHER_ORGANIZATION,
    };

    input = {
      ...input,
      users: routeUsers(() =>
        Promise.resolve(
          Response.json({ object: 'list', data: [foreign], list_metadata: { before: null, after: null } }),
        ),
      ),
    };

    expect((await get(SERVICE_USER)).status).toBe(404);

    expect(await (await getBatch([{ userId: SERVICE_USER }])).json()).toEqual({ data: {} });
  });

  it('service/authentication#user-ids: a service user token with 500 made-up IDs costs 1 application read for its token check, and ceil(members / 100) membership reads', async () => {
    input = { ...input, users: workosUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }) };

    token = await issuer.m2m();

    const response = await getBatch(MADE_UP_USERS);

    expect([response.status, await response.json()]).toEqual([200, { data: {} }]);

    expect(readsSince(0)).toEqual({
      memberPages: Math.ceil(MEMBER_COUNT / 100),
      applicationPages: 0,
      applicationReads: 1,
      other: [],
    });
  });
});
