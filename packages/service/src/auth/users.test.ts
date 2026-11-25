import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { workosUsers, type UserSource } from './index.ts';
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
import { workosServer, type WorkosAnswer } from './workosServer.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const base = 'http://localhost';
const GITHUB_SUBJECT = 'repo:example/test-app:environment:publish-staging';
const UNKNOWN = 'user_01UNKNOWN0000000000000000';

const NO_NAMES = {
  id: 'user_01NONAMES000000000000000',
  email: 'ci+test-app@example.com',
  first_name: null,
  last_name: null,
};

const FORMER = {
  id: 'user_01FORMER00000000000000000',
  email: 'grace@example.com',
  first_name: 'Grace',
  last_name: 'Hopper',
};

const OUTSIDER = {
  id: 'user_01OUTSIDER000000000000000',
  email: 'alan@example.com',
  first_name: 'Alan',
  last_name: 'Turing',
};

const INVITED = {
  id: 'user_01INVITED0000000000000000',
  email: 'edsger@example.com',
  first_name: 'Edsger',
  last_name: 'Dijkstra',
};

const MEMBERSHIPS: readonly StubMembership[] = [
  { user_id: PERSON, organization_id: ORGANIZATION, status: 'active' },
  { user_id: NO_NAMES.id, organization_id: ORGANIZATION, status: 'active' },
  { user_id: FORMER.id, organization_id: ORGANIZATION, status: 'inactive' },
  { user_id: FORMER.id, organization_id: OTHER_ORGANIZATION, status: 'active' },
  { user_id: OUTSIDER.id, organization_id: OTHER_ORGANIZATION, status: 'active' },
  { user_id: INVITED.id, organization_id: ORGANIZATION, status: 'pending' },
];

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

const GRACE = {
  id: FORMER.id,
  username: 'grace@example.com',
  email: 'grace@example.com',
  givenName: 'Grace',
  familyName: 'Hopper',
  realm: 'workos',
  status: 'DELETED',
  attributes: {},
};

const MEMBER_LIST = `/user_management/organization_memberships?organization_id=${ORGANIZATION}&statuses=active%2Cinactive&limit=100&order=asc`;

function routeUsers(...args: Parameters<typeof workosUsers>): UserSource {
  return { ...workosUsers(...args), permissions: () => given([]) };
}

const answerWorkos = workosServer();

let issuer: TestIssuer;
let workos: StubWorkos;
let input: HandleInput;
let token: string;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  token = await issuer.workos();
});

beforeEach(() => {
  expect(STUB_PERSON.id).toBe(PERSON);

  workos = stubWorkos([STUB_PERSON, NO_NAMES, FORMER, OUTSIDER, INVITED], MEMBERSHIPS);

  input = {
    ...testInput,
    db: fallibleOf(noDb),
    keys: issuer.keys,
    users: routeUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }),
  };

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

function get(userId: string, bearer = token, status?: string): Promise<Response> {
  const query = status === undefined ? '' : `?status=${encodeURIComponent(status)}`;

  return handle(
    new Request(`${base}/api/v2/admin/users/${encodeURIComponent(userId)}${query}`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
    input,
  );
}

function getCurrent(bearer = token): Promise<Response> {
  return handle(
    new Request(`${base}/api/v2/admin/users/getCurrent`, { headers: { authorization: `Bearer ${bearer}` } }),
    input,
  );
}

function getBatch(body: unknown, bearer = token): Promise<Response> {
  return handle(
    new Request(`${base}/api/v2/admin/users/getBatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
    input,
  );
}

describe('the Organization of the caller', () => {
  it('service/authentication#user-ids: a person of another Organization gets 404 UserNotFound from Users.get for a member of this one', async () => {
    const response = await get(PERSON, await issuer.workos({ org_id: OTHER_ORGANIZATION }));

    expect(response.status).toBe(404);

    expect(await response.json()).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'UserNotFound',
      errorInstanceId: expect.any(String),
      parameters: { userId: PERSON },
    });
  });

  it('service/authentication#user-ids: a person of another Organization gets no entry from Users.getBatch for a member of this one', async () => {
    const response = await getBatch([{ userId: PERSON }], await issuer.workos({ org_id: OTHER_ORGANIZATION }));

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: {} });
  });

  it('service/authentication#user-ids: 3 reads in 60 seconds make 1 WorkOS call, the read of the kept member list', async () => {
    expect((await get(PERSON)).status).toBe(200);

    expect((await get(FORMER.id, token, 'DELETED')).status).toBe(200);

    expect((await getBatch([{ userId: PERSON }])).status).toBe(200);

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });

  it('service/authentication#user-ids: a user ID cannot name another Organization in the WorkOS query', async () => {
    const userId = `${OUTSIDER.id}&organization_id=${OTHER_ORGANIZATION}`;

    const response = await get(userId);

    expect(response.status).toBe(404);

    expect(await response.json()).toMatchObject({ errorName: 'UserNotFound', parameters: { userId } });

    expect(workos.requests).toEqual([]);
  });

  it('a person with no Organization gets 403 OntologyService:NoOrganization, with no WorkOS call', async () => {
    const bearer = await issuer.workos({ org_id: undefined });

    const body = {
      errorCode: 'PERMISSION_DENIED',
      errorName: 'OntologyService:NoOrganization',
      errorInstanceId: expect.any(String),
      parameters: {},
    };

    const single = await get(PERSON, bearer);

    expect(single.status).toBe(403);

    expect(await single.json()).toEqual(body);

    const batch = await getBatch([{ userId: PERSON }], bearer);

    expect(batch.status).toBe(403);

    expect(await batch.json()).toEqual(body);

    expect(workos.requests).toEqual([]);
  });

  it('a GitHub token gets 403 Default:PermissionDenied, with no WorkOS call', async () => {
    const bearer = await issuer.github();

    const body = {
      errorCode: 'PERMISSION_DENIED',
      errorName: 'Default:PermissionDenied',
      errorInstanceId: expect.any(String),
      parameters: {},
    };

    const single = await get(PERSON, bearer);

    expect(single.status).toBe(403);

    expect(await single.json()).toEqual(body);

    const batch = await getBatch([{ userId: PERSON }], bearer);

    expect(batch.status).toBe(403);

    expect(await batch.json()).toEqual(body);

    expect(workos.requests).toEqual([]);
  });
});

describe('a WorkOS answer that ignores the filter', () => {
  const OTHER_USER = {
    id: 'user_01OTHERUSER00000000000000',
    email: 'eve@example.com',
    first_name: 'Eve',
    last_name: 'Mallory',
  };

  const membership = (
    user: { readonly id: string },
    organization_id: string,
    status: 'active' | 'inactive' | 'pending' = 'active',
  ) => ({
    object: 'organization_membership',
    user_id: user.id,
    organization_id,
    organization_name: 'Name',
    status,
    user,
  });

  const OTHER_USER_ELSEWHERE = membership(OTHER_USER, OTHER_ORGANIZATION);
  const MINE_ELSEWHERE = membership(STUB_PERSON, OTHER_ORGANIZATION);
  const OTHER_USER_HERE = membership(OTHER_USER, ORGANIZATION);

  function answers(data: readonly unknown[]): void {
    answerWorkos(() => Response.json({ object: 'list', data, list_metadata: { before: null, after: null } }));

    input = { ...input, users: routeUsers(STUB_WORKOS_KEY) };
  }

  it.each([
    ['another Organization', [MINE_ELSEWHERE]],
    ['another user', [OTHER_USER_HERE]],
    ['another user in another Organization', [OTHER_USER_ELSEWHERE]],
    ['another Organization and another user', [MINE_ELSEWHERE, OTHER_USER_HERE, OTHER_USER_ELSEWHERE]],
    [
      'the requested user with the user object of another user',
      [{ ...membership(STUB_PERSON, ORGANIZATION), user: OTHER_USER }],
    ],
    [
      'another user with the user object of the requested user',
      [{ ...membership(STUB_PERSON, ORGANIZATION), user_id: OTHER_USER.id }],
    ],
    ['the requested user that is only invited', [membership(STUB_PERSON, ORGANIZATION, 'pending')]],
  ])(
    'service/authentication#user-ids: a membership of %s gives 404 UserNotFound from Users.get and no entry from Users.getBatch',
    async (_, data) => {
      answers(data);

      const single = await get(PERSON);

      expect(single.status).toBe(404);

      expect(await single.json()).toMatchObject({ errorName: 'UserNotFound', parameters: { userId: PERSON } });

      const batch = await getBatch([{ userId: PERSON }, { userId: PERSON, status: 'DELETED' }]);

      expect(batch.status).toBe(200);

      const text = await batch.text();

      expect(JSON.parse(text)).toEqual({ data: {} });
      expect(text).not.toMatch(/eve@example\.com|Mallory/);
    },
  );

  it('service/authentication#user-ids: the matching membership counts when it is not first in the list', async () => {
    answers([MINE_ELSEWHERE, OTHER_USER_HERE, membership(STUB_PERSON, ORGANIZATION), OTHER_USER_ELSEWHERE]);

    expect(await (await get(PERSON)).json()).toEqual(ADA);

    expect(await (await getBatch([{ userId: PERSON }])).json()).toEqual({ data: { [PERSON]: ADA } });
  });

  it('service/authentication#user-ids: the status is the status of the matching membership, not of the first item', async () => {
    answers([membership(STUB_PERSON, OTHER_ORGANIZATION, 'active'), membership(STUB_PERSON, ORGANIZATION, 'inactive')]);

    const response = await get(PERSON, token, 'DELETED');

    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({ id: PERSON, status: 'DELETED' });
  });

  it('service/authentication#organizations: the Organizations route shows no Organization of another user', async () => {
    answers([membership(OTHER_USER, 'org_01SECRET000000000000000000'), membership(STUB_PERSON, ORGANIZATION)]);

    const response = await handle(
      new Request(`${base}/api/ontology-service/v1/organizations`, { headers: { authorization: `Bearer ${token}` } }),
      input,
    );

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: [{ id: ORGANIZATION, name: 'Name' }] });
  });

  it('service/authentication#organizations: the Organizations route shows no inactive or pending membership of the caller', async () => {
    answers([
      membership(STUB_PERSON, OTHER_ORGANIZATION, 'inactive'),
      membership(STUB_PERSON, 'org_01INVITED00000000000000000', 'pending'),
      membership(STUB_PERSON, ORGANIZATION),
    ]);

    const response = await handle(
      new Request(`${base}/api/ontology-service/v1/organizations`, { headers: { authorization: `Bearer ${token}` } }),
      input,
    );

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: [{ id: ORGANIZATION, name: 'Name' }] });
  });
});

describe('the status parameter', () => {
  const found = (user: object) => ({ status: 200, body: user });

  const refused = (errorName: string, userId: string) => ({
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName,
      errorInstanceId: expect.any(String),
      parameters: { principalId: userId },
    },
  });

  const notFound = (userId: string) => ({
    status: 404,
    body: {
      errorCode: 'NOT_FOUND',
      errorName: 'UserNotFound',
      errorInstanceId: expect.any(String),
      parameters: { userId },
    },
  });

  it.each([
    ['an active member', PERSON, undefined, found(ADA)],
    ['an active member', PERSON, 'ACTIVE', found(ADA)],
    ['an active member', PERSON, 'DELETED', refused('UserIsActive', PERSON)],
    ['a former member', FORMER.id, undefined, refused('UserDeleted', FORMER.id)],
    ['a former member', FORMER.id, 'ACTIVE', refused('UserDeleted', FORMER.id)],
    ['a former member', FORMER.id, 'DELETED', found(GRACE)],
    ['a user of another Organization', OUTSIDER.id, undefined, notFound(OUTSIDER.id)],
    ['a user of another Organization', OUTSIDER.id, 'ACTIVE', notFound(OUTSIDER.id)],
    ['a user of another Organization', OUTSIDER.id, 'DELETED', notFound(OUTSIDER.id)],
    ['an invited user', INVITED.id, undefined, notFound(INVITED.id)],
    ['an invited user', INVITED.id, 'DELETED', notFound(INVITED.id)],
  ])('service/authentication#user-ids: Users.get of %s (%s) with status %s', async (_, userId, status, expected) => {
    const response = await get(userId, token, status);

    expect(response.status).toBe(expected.status);

    expect(await response.json()).toEqual(expected.body);
  });

  it.each([
    ['an active member', PERSON, undefined, { [PERSON]: ADA }],
    ['an active member', PERSON, 'ACTIVE', { [PERSON]: ADA }],
    ['an active member', PERSON, 'DELETED', {}],
    ['a former member', FORMER.id, undefined, {}],
    ['a former member', FORMER.id, 'ACTIVE', {}],
    ['a former member', FORMER.id, 'DELETED', { [FORMER.id]: GRACE }],
    ['a user of another Organization', OUTSIDER.id, undefined, {}],
    ['a user of another Organization', OUTSIDER.id, 'ACTIVE', {}],
    ['a user of another Organization', OUTSIDER.id, 'DELETED', {}],
    ['an invited user', INVITED.id, 'DELETED', {}],
  ])('service/authentication#user-ids: Users.getBatch of %s (%s) with status %s', async (_, userId, status, data) => {
    const response = await getBatch([{ userId, ...(status === undefined ? {} : { status }) }]);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data });
  });

  it('service/authentication#user-ids: a mixed batch gives only the elements whose status matches', async () => {
    const response = await getBatch([
      { userId: PERSON },
      { userId: NO_NAMES.id, status: 'DELETED' },
      { userId: FORMER.id, status: 'DELETED' },
      { userId: OUTSIDER.id, status: 'ACTIVE' },
    ]);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: { [PERSON]: ADA, [FORMER.id]: GRACE } });
  });

  it('service/authentication#user-ids: the status of a membership is the status in the Organization of the caller', async () => {
    const other = await issuer.workos({ org_id: OTHER_ORGANIZATION });

    expect(await (await get(FORMER.id, other)).json()).toMatchObject({ id: FORMER.id, status: 'ACTIVE' });

    expect(await (await get(FORMER.id, token, 'DELETED')).json()).toMatchObject({ id: FORMER.id, status: 'DELETED' });
  });

  it('service/authentication#user-ids: the User of a former member has status DELETED, realm workos, and empty attributes', async () => {
    expect(await (await get(FORMER.id, token, 'DELETED')).json()).toEqual({
      id: 'user_01FORMER00000000000000000',
      username: 'grace@example.com',
      email: 'grace@example.com',
      givenName: 'Grace',
      familyName: 'Hopper',
      realm: 'workos',
      status: 'DELETED',
      attributes: {},
    });
  });

  it.each(['active', 'deleted', 'PENDING', ''])(
    'the query status "%s" gets 400 Default:InvalidArgument, with no WorkOS call',
    async (status) => {
      const response = await get(PERSON, token, status);

      expect(response.status).toBe(400);

      expect(await response.json()).toMatchObject({ errorName: 'Default:InvalidArgument' });

      expect(workos.requests).toEqual([]);
    },
  );

  it.each([['active'], ['PENDING'], [7], [null]])(
    'the element status %j gets 400 Default:InvalidArgument for the whole batch, with no WorkOS call',
    async (status) => {
      const response = await getBatch([{ userId: PERSON }, { userId: FORMER.id, status }]);

      expect(response.status).toBe(400);

      expect(await response.json()).toMatchObject({ errorName: 'Default:InvalidArgument' });

      expect(workos.requests).toEqual([]);
    },
  );
});

describe('the WorkOS calls of the user routes', () => {
  it('service/authentication#user-ids: Users.get lists the members and former members of the Organization of the caller, 100 at a time', async () => {
    await get(FORMER.id, token, 'DELETED');

    expect(workos.requests).toEqual([
      '/user_management/organization_memberships?organization_id=org_01TEST0RG00000000000000001&statuses=active%2Cinactive&limit=100&order=asc',
    ]);
  });

  it('service/authentication#user-ids: Users.getBatch reads the member list once, whatever the count of its IDs', async () => {
    await getBatch([
      { userId: PERSON },
      { userId: FORMER.id, status: 'DELETED' },
      { userId: UNKNOWN },
      { userId: OUTSIDER.id },
    ]);

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });

  it('service/authentication#user-ids: an ID named twice with the same status gives 1 entry', async () => {
    expect(
      await (
        await getBatch([
          { userId: FORMER.id, status: 'DELETED' },
          { userId: FORMER.id, status: 'DELETED' },
        ])
      ).json(),
    ).toEqual({ data: { [FORMER.id]: GRACE } });

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });

  it.each([
    [
      'ACTIVE first',
      [
        { userId: FORMER.id, status: 'ACTIVE' },
        { userId: FORMER.id, status: 'DELETED' },
      ],
    ],
    ['DELETED first', [{ userId: FORMER.id, status: 'DELETED' }, { userId: FORMER.id }]],
  ])('service/authentication#user-ids: an ID named with both statuses, %s, gives 1 entry', async (_, body) => {
    expect(await (await getBatch(body)).json()).toEqual({ data: { [FORMER.id]: GRACE } });

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });
});

describe('Users.get', () => {
  it('service/http-api#routes: reads the WorkOS member list of the Organization with the API key of the environment', async () => {
    const response = await get(PERSON);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual(ADA);

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });

  it('service/authentication#user-ids: id is the WorkOS user ID, username and email are the email, givenName and familyName are the first and last names', async () => {
    const user = (await (await get(PERSON)).json()) as Record<string, unknown>;

    expect(user).toMatchObject({
      id: STUB_PERSON.id,
      username: STUB_PERSON.email,
      email: STUB_PERSON.email,
      givenName: STUB_PERSON.first_name,
      familyName: STUB_PERSON.last_name,
    });
  });

  it('service/authentication#user-ids: a WorkOS user with no names has no givenName and no familyName', async () => {
    expect(await (await get(NO_NAMES.id)).json()).toEqual({
      id: NO_NAMES.id,
      username: NO_NAMES.email,
      email: NO_NAMES.email,
      realm: 'workos',
      status: 'ACTIVE',
      attributes: {},
    });
  });

  it('service/authentication#user-ids: realm is workos, status is ACTIVE for a member, and attributes is empty', async () => {
    expect(await (await get(PERSON)).json()).toMatchObject({ realm: 'workos', status: 'ACTIVE', attributes: {} });
  });

  it.each([
    ['a GitHub subject', GITHUB_SUBJECT],
    ['an unknown ID', UNKNOWN],
  ])('service/authentication#user-ids: %s gets 404 UserNotFound', async (_, userId) => {
    const response = await get(userId);

    expect(response.status).toBe(404);

    expect(await response.json()).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'UserNotFound',
      errorInstanceId: expect.any(String),
      parameters: { userId },
    });
  });

  it('service/authentication#user-ids: a GitHub subject needs no WorkOS call, and an unknown user ID reads the member list', async () => {
    await get(GITHUB_SUBJECT);

    expect(workos.requests).toEqual([]);

    await get(UNKNOWN);

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });

  it('a WorkOS answer other than 200 or 404, such as a refused API key, gets 500, and the key is in no log line, body, or fault', async () => {
    const faults: unknown[] = [];

    input = {
      ...input,
      users: routeUsers('sk_test_wrong', { fetch: workos.fetch }),
      reportFault: (error, fields) => void faults.push(error, fields),
    };

    const response = await get(PERSON);

    expect(response.status).toBe(500);

    const body = await response.text();

    expect(JSON.parse(body)).toMatchObject({ errorCode: 'INTERNAL', errorName: 'Default:Internal' });
    expect(faults).toHaveLength(2);

    const seen = [
      body,
      ...consoleLog.mock.calls.flat().map(String),
      ...faults.map((fault) => (fault instanceof Error ? `${fault.message} ${fault.stack}` : JSON.stringify(fault))),
    ];

    for (const text of seen) expect(text).not.toContain('sk_test_wrong');
  });

  it('a malformed user ID gets 404 UserNotFound, with no WorkOS call', async () => {
    const response = await get('user_not-a-valid-id');

    expect(response.status).toBe(404);

    expect(await response.json()).toMatchObject({ errorName: 'UserNotFound' });

    expect(workos.requests).toEqual([]);
  });

  it.each([400, 404, 422])(
    'a WorkOS %i on the member list gets 500 from Users.get and Users.getBatch, so a refused query is no silent 404',
    async (status) => {
      answerWorkos(() => Response.json({ message: 'Invalid' }, { status }));

      input = { ...input, users: routeUsers(STUB_WORKOS_KEY), reportFault: () => undefined };

      expect((await get(UNKNOWN)).status).toBe(500);

      expect((await getBatch([{ userId: UNKNOWN }])).status).toBe(500);
    },
  );

  it('service/code-layout#seams: the user routes read no database and load no Ontology', async () => {
    expect((await get(PERSON)).status).toBe(200);

    expect((await getBatch([{ userId: PERSON }])).status).toBe(200);

    expect((await getCurrent()).status).toBe(200);

    expect(
      (
        await handle(
          new Request(`${base}/api/ontology-service/v1/organizations`, {
            headers: { authorization: `Bearer ${token}` },
          }),
          input,
        )
      ).status,
    ).toBe(200);
  });
});

describe('Users.getCurrent', () => {
  it('service/http-api#routes, service/code-layout#seams: a WorkOS caller gets the User of its sub, as Users.get gives it', async () => {
    const response = await getCurrent();

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual(ADA);

    expect(workos.requests).toEqual([`/user_management/users/${PERSON}`]);

    expect(await (await get(PERSON)).json()).toEqual(ADA);
  });

  it.each([
    ['with no Organization', { org_id: undefined }],
    ['of an Organization that has no membership of the user', { org_id: OTHER_ORGANIZATION }],
  ])(
    'service/authentication#user-ids: a person %s reads the WorkOS user of the sub, with no read of the memberships',
    async (_, claims) => {
      const response = await getCurrent(await issuer.workos(claims));

      expect(response.status).toBe(200);

      expect(await response.json()).toEqual(ADA);

      expect(workos.requests).toEqual([`/user_management/users/${PERSON}`]);
    },
  );

  it('service/authentication#user-ids: a former member of the Organization of the token gets ACTIVE from getCurrent, and DELETED from Users.get', async () => {
    const former = await issuer.workos({ sub: FORMER.id, org_id: ORGANIZATION });

    const response = await getCurrent(former);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ ...GRACE, status: 'ACTIVE' });

    expect(await (await get(FORMER.id, token, 'DELETED')).json()).toEqual(GRACE);
  });

  it('a WorkOS caller that is not a user of the environment gets 404 UserNotFound', async () => {
    const response = await getCurrent(await issuer.workos({ sub: UNKNOWN }));

    expect(response.status).toBe(404);

    expect(await response.json()).toMatchObject({ errorName: 'UserNotFound', parameters: { userId: UNKNOWN } });
  });

  it('service/authentication#user-ids: a GitHub token gets 403 Default:PermissionDenied, with no WorkOS call', async () => {
    const response = await getCurrent(await issuer.github({ sub: GITHUB_SUBJECT }));

    expect(response.status).toBe(403);

    expect(await response.json()).toEqual({
      errorCode: 'PERMISSION_DENIED',
      errorName: 'Default:PermissionDenied',
      errorInstanceId: expect.any(String),
      parameters: {},
    });

    expect(workos.requests).toEqual([]);
  });

  it('service/authentication#user-ids: concurrent and repeated getCurrent reads within 60s coalesce and hit the kept answer', async () => {
    workos.hold();

    const first = Promise.all([getCurrent(), getCurrent(), getCurrent()]);

    await workos.reached(1);

    workos.release();

    for (const response of await first) {
      expect(response.status).toBe(200);

      expect(await response.json()).toEqual(ADA);
    }

    const warm = await getCurrent();

    expect(warm.status).toBe(200);

    expect(await warm.json()).toEqual(ADA);

    expect(workos.requests).toEqual([`/user_management/users/${PERSON}`]);
  });

  it('service/authentication#user-ids: kept getCurrent answers isolate callers across users and organizations', async () => {
    const outsiderToken = await issuer.workos({ sub: OUTSIDER.id, org_id: OTHER_ORGANIZATION });

    const otherOrgToken = await issuer.workos({ sub: PERSON, org_id: OTHER_ORGANIZATION });

    expect(await (await getCurrent(token)).json()).toEqual(ADA);

    expect(await (await getCurrent(outsiderToken)).json()).toEqual({
      id: OUTSIDER.id,
      username: OUTSIDER.email,
      email: OUTSIDER.email,
      givenName: OUTSIDER.first_name,
      familyName: OUTSIDER.last_name,
      realm: 'workos',
      status: 'ACTIVE',
      attributes: {},
    });

    expect(await (await getCurrent(otherOrgToken)).json()).toEqual(ADA);

    expect(await (await getCurrent(outsiderToken)).json()).toMatchObject({ id: OUTSIDER.id });

    expect(workos.requests).toEqual([`/user_management/users/${PERSON}`, `/user_management/users/${OUTSIDER.id}`]);
  });

  it('service/authentication#user-ids: getCurrent refreshes in background at 60s via onBackground and evicts past 300s when WorkOS fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

    try {
      const freshToken = await issuer.workos({ exp: Math.floor(Date.now() / 1000) + 3600 });

      const person = { ...STUB_PERSON };
      const stub = stubWorkos([person], MEMBERSHIPS);
      const background: Promise<void>[] = [];

      input = {
        ...input,
        users: routeUsers(STUB_WORKOS_KEY, {
          fetch: stub.fetch,
          onBackground: (pending) => void background.push(pending),
        }),
      };

      expect(await (await getCurrent(freshToken)).json()).toEqual(ADA);

      expect(stub.requests).toEqual([`/user_management/users/${PERSON}`]);

      person.first_name = 'Augusta';

      await vi.advanceTimersByTimeAsync(60_000);

      expect(await (await getCurrent(freshToken)).json()).toEqual(ADA);

      expect(background).toHaveLength(1);

      await Promise.all(background);

      expect(await (await getCurrent(freshToken)).json()).toEqual({ ...ADA, givenName: 'Augusta' });

      expect(stub.requests).toEqual([`/user_management/users/${PERSON}`, `/user_management/users/${PERSON}`]);

      stub.fail('5xx');

      await vi.advanceTimersByTimeAsync(300_000);

      expect((await getCurrent(freshToken)).status).toBe(200);

      await vi.advanceTimersByTimeAsync(1_000);

      const failed = await getCurrent(freshToken);

      expect([failed.status, ((await failed.json()) as { errorName: string }).errorName]).toEqual([
        503,
        'OntologyService:WorkosUnavailable',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Users.getBatch', () => {
  it('service/http-api#routes: a batch of a person, a GitHub subject, and an unknown ID gives only the person', async () => {
    const response = await getBatch([{ userId: PERSON }, { userId: GITHUB_SUBJECT }, { userId: UNKNOWN }]);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: { [PERSON]: ADA } });

    expect(workos.requests).toEqual([MEMBER_LIST]);
  });

  it('service/authentication#user-ids: an ID that the batch names twice gets 1 WorkOS call and 1 entry', async () => {
    expect(await (await getBatch([{ userId: PERSON }, { userId: PERSON }])).json()).toEqual({
      data: { [PERSON]: ADA },
    });

    expect(workos.requests).toHaveLength(1);
  });

  it.each([
    [150, 200, ['ACTIVE', 2]],
    [2_000, 200, ['ACTIVE', 20]],
    [2_001, 500, ['Default:Internal', 20]],
  ])(
    'service/authentication#user-ids: a member list of %i members gives %i, with each page read in turn and never a partial answer',
    async (count, status, [answer, pages]) => {
      const many = Array.from({ length: count - 1 }, (_, index) => ({
        id: `user_01MANY${String(index).padStart(20, '0')}`,
        email: `m${index}@example.com`,
        first_name: null,
        last_name: null,
      }));

      workos = stubWorkos(
        [STUB_PERSON, ...many],
        [
          { user_id: PERSON, organization_id: ORGANIZATION, status: 'active' },
          ...many.map((user): StubMembership => ({
            user_id: user.id,
            organization_id: ORGANIZATION,
            status: 'active',
          })),
        ],
      );

      input = { ...input, users: routeUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }), reportFault: () => undefined };

      const response = await getBatch([{ userId: PERSON }]);

      const body = (await response.json()) as {
        readonly data?: Record<string, { readonly status: string }>;
        readonly errorName?: string;
      };

      expect([response.status, body.data?.[PERSON]?.status ?? body.errorName, workos.requests.length]).toEqual([
        status,
        answer,
        pages,
      ]);

      expect(workos.requests.slice(1).every((path, index) => path.endsWith(`&after=${(index + 1) * 100}`))).toBe(true);
    },
  );

  it.each([
    ['an empty list', []],
    ['an object', { userId: PERSON }],
    ['an element with no userId', [{}]],
    ['a userId that is not a string', [{ userId: 7 }]],
    ['more than 500 elements', Array.from({ length: 501 }, (_, index) => ({ userId: `user_${index}` }))],
  ])('service/authentication#user-ids: %s gets 400 Default:InvalidArgument, with no WorkOS call', async (_, body) => {
    const response = await getBatch(body);

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({ errorName: 'Default:InvalidArgument' });

    expect(workos.requests).toEqual([]);
  });
});

describe('the callers of the user routes', () => {
  it('service/authentication#errors: a request with no token gets 401 MissingCredentials', async () => {
    const response = await handle(new Request(`${base}/api/v2/admin/users/${PERSON}`), input);

    expect(response.status).toBe(401);
    expect(workos.requests).toEqual([]);
  });

  it('service/authentication#ci-workflows: a pull request check gets 403', async () => {
    const check = await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' });

    expect((await get(PERSON, check)).status).toBe(403);

    expect((await getBatch([{ userId: PERSON }], check)).status).toBe(403);

    expect((await getCurrent(check)).status).toBe(403);

    expect(workos.requests).toEqual([]);
  });
});

describe('the Organizations of the caller', () => {
  const ORGANIZATIONS_URL = `${base}/api/ontology-service/v1/organizations`;

  const NAMED: readonly StubMembership[] = [
    { user_id: PERSON, organization_id: OTHER_ORGANIZATION, status: 'active', organization_name: 'Beta' },
    { user_id: PERSON, organization_id: ORGANIZATION, status: 'active', organization_name: 'Acme' },
    {
      user_id: PERSON,
      organization_id: 'org_01TEST0RG00000000000000003',
      status: 'inactive',
      organization_name: 'Former',
    },
    {
      user_id: PERSON,
      organization_id: 'org_01TEST0RG00000000000000004',
      status: 'pending',
      organization_name: 'Invited',
    },
    {
      user_id: OUTSIDER.id,
      organization_id: 'org_01TEST0RG00000000000000005',
      status: 'active',
      organization_name: 'Secret',
    },
  ];

  const organizations = (bearer: string, memberships: readonly StubMembership[] = NAMED): Promise<Response> =>
    handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${bearer}` } }), {
      ...input,
      users: routeUsers(STUB_WORKOS_KEY, { fetch: stubWorkos([STUB_PERSON, OUTSIDER], memberships).fetch }),
    });

  it('a person gets only their own active memberships, by name', async () => {
    const response = await organizations(token);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({
      data: [
        { id: ORGANIZATION, name: 'Acme' },
        { id: OTHER_ORGANIZATION, name: 'Beta' },
      ],
    });
  });

  it('a token with no org_id gets the list, and no NoOrganization error', async () => {
    const response = await organizations(await issuer.workos({ org_id: undefined, role: undefined }));

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({
      data: [
        { id: ORGANIZATION, name: 'Acme' },
        { id: OTHER_ORGANIZATION, name: 'Beta' },
      ],
    });
  });

  it('a person in no Organization gets an empty list', async () => {
    const response = await organizations(token, []);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: [] });
  });

  it('a person in more Organizations than 1 WorkOS page gets each of them', async () => {
    const many: readonly StubMembership[] = Array.from({ length: 103 }, (_, index) => ({
      user_id: PERSON,
      organization_id: `org_${String(index).padStart(3, '0')}`,
      status: 'active',
      organization_name: `Org ${String(index).padStart(3, '0')}`,
    }));

    const response = await organizations(token, many);

    const { data } = (await response.json()) as { data: { id: string; name: string }[] };

    expect(data.length).toBe(103);
    expect(data[102]).toEqual({ id: 'org_102', name: 'Org 102' });
  });

  it('service/authentication#organizations: a person past 20 WorkOS pages gets 500, and no partial list', async () => {
    const many: readonly StubMembership[] = Array.from({ length: 2001 }, (_, index) => ({
      user_id: PERSON,
      organization_id: `org_${String(index).padStart(4, '0')}`,
      status: 'active',
      organization_name: `Org ${String(index).padStart(4, '0')}`,
    }));

    const stub = stubWorkos([STUB_PERSON], many);

    const response = await handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }), {
      ...input,
      users: routeUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }),
    });

    expect(response.status).toBe(500);

    expect(await response.text()).not.toContain('Org 0000');

    expect(stub.requests.length).toBe(20);
  });

  it('a GitHub token gets 403 Default:PermissionDenied', async () => {
    const response = await organizations(await issuer.github());

    expect(response.status).toBe(403);

    expect(await response.json()).toMatchObject({ errorName: 'Default:PermissionDenied' });
  });

  it('service/authentication#organizations: a person and a service user each get their Organizations, and a GitHub token gets 403', async () => {
    const person = await organizations(token);

    expect(person.status).toBe(200);

    expect(await person.json()).toEqual({
      data: [
        { id: ORGANIZATION, name: 'Acme' },
        { id: OTHER_ORGANIZATION, name: 'Beta' },
      ],
    });

    const service = await organizations(await issuer.m2m());

    expect(service.status).toBe(200);

    expect(await service.json()).toEqual({ data: [{ id: ORGANIZATION, name: 'Test Organization' }] });

    const github = await organizations(await issuer.github());

    expect(github.status).toBe(403);

    expect(await github.json()).toEqual({
      errorCode: 'PERMISSION_DENIED',
      errorName: 'Default:PermissionDenied',
      errorInstanceId: expect.any(String),
      parameters: {},
    });
  });

  it('service/authentication#organizations: a service user gets its 1 Organization, the org_id of its token, with its name from the stub', async () => {
    const stub = stubWorkos([STUB_PERSON], NAMED, { organizationNames: { [ORGANIZATION]: 'Acme Field Services' } });

    const response = await handle(
      new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${await issuer.m2m()}` } }),
      { ...input, users: routeUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }) },
    );

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: [{ id: ORGANIZATION, name: 'Acme Field Services' }] });

    expect(stub.requests).toEqual([`/connect/applications/${SERVICE_USER}`, `/organizations/${ORGANIZATION}`]);
  });

  it('service/authentication#organizations: concurrent and repeated reads within 60s coalesce and hit the kept answer', async () => {
    const stub = stubWorkos([STUB_PERSON, OUTSIDER], NAMED);
    const shared = { ...input, users: routeUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }) };

    stub.hold();

    const first = Promise.all([
      handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }), shared),
      handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }), shared),
      handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }), shared),
    ]);

    await stub.reached(1);

    stub.release();

    const responses = await first;

    for (const response of responses) {
      expect(response.status).toBe(200);

      expect(await response.json()).toEqual({
        data: [
          { id: ORGANIZATION, name: 'Acme' },
          { id: OTHER_ORGANIZATION, name: 'Beta' },
        ],
      });
    }

    const warm = await handle(
      new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }),
      shared,
    );

    expect(warm.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
  });

  it('service/authentication#organizations: kept answers isolate organizations by caller user ID', async () => {
    const memberships: readonly StubMembership[] = [
      { user_id: PERSON, organization_id: ORGANIZATION, status: 'active', organization_name: 'Acme' },
      { user_id: OUTSIDER.id, organization_id: OTHER_ORGANIZATION, status: 'active', organization_name: 'Beta' },
    ];

    const stub = stubWorkos([STUB_PERSON, OUTSIDER], memberships);
    const shared = { ...input, users: routeUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }) };

    const outsiderToken = await issuer.workos({ sub: OUTSIDER.id, org_id: OTHER_ORGANIZATION });

    expect(
      await (
        await handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }), shared)
      ).json(),
    ).toEqual({
      data: [{ id: ORGANIZATION, name: 'Acme' }],
    });

    expect(
      await (
        await handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${outsiderToken}` } }), shared)
      ).json(),
    ).toEqual({
      data: [{ id: OTHER_ORGANIZATION, name: 'Beta' }],
    });

    expect(
      await (
        await handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${token}` } }), shared)
      ).json(),
    ).toEqual({
      data: [{ id: ORGANIZATION, name: 'Acme' }],
    });

    expect(
      await (
        await handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${outsiderToken}` } }), shared)
      ).json(),
    ).toEqual({
      data: [{ id: OTHER_ORGANIZATION, name: 'Beta' }],
    });

    expect(stub.requests).toHaveLength(2);
  });

  it('service/authentication#organizations: refreshes in background at 60s and evicts past 300s when WorkOS fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

    try {
      const freshToken = await issuer.workos({ exp: Math.floor(Date.now() / 1000) + 3600 });

      const stub = stubWorkos(
        [STUB_PERSON],
        [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', organization_name: 'Acme' }],
      );

      const shared = { ...input, users: routeUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }) };

      const askOrgs = () =>
        handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${freshToken}` } }), shared);

      expect(await (await askOrgs()).json()).toEqual({ data: [{ id: ORGANIZATION, name: 'Acme' }] });

      expect(stub.requests).toHaveLength(1);

      stub.memberships.push({
        user_id: PERSON,
        organization_id: OTHER_ORGANIZATION,
        status: 'active',
        organization_name: 'Beta',
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(await (await askOrgs()).json()).toEqual({ data: [{ id: ORGANIZATION, name: 'Acme' }] });

      await vi.advanceTimersByTimeAsync(0);

      expect(stub.requests).toHaveLength(2);

      expect(await (await askOrgs()).json()).toEqual({
        data: [
          { id: ORGANIZATION, name: 'Acme' },
          { id: OTHER_ORGANIZATION, name: 'Beta' },
        ],
      });

      expect(stub.requests).toHaveLength(2);

      stub.fail('5xx');

      await vi.advanceTimersByTimeAsync(300_000);

      expect((await askOrgs()).status).toBe(200);

      await vi.advanceTimersByTimeAsync(1_000);

      const failed = await askOrgs();

      expect([failed.status, ((await failed.json()) as { errorName: string }).errorName]).toEqual([
        503,
        'OntologyService:WorkosUnavailable',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('service/authentication#organizations: WorkOS does not find the Organization of a service user', () => {
  it('service/authentication#organizations: the stub finds no Organization of the service user, and the route gives 500 Default:Internal and 1 report', async () => {
    const stub = stubWorkos([STUB_PERSON], MEMBERSHIPS, { organizationNames: {} });
    const reported: unknown[] = [];

    const response = await handle(
      new Request(`${base}/api/ontology-service/v1/organizations`, {
        headers: { authorization: `Bearer ${await issuer.m2m()}` },
      }),
      {
        ...input,
        users: routeUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }),
        reportFault: (_, fields) => void reported.push(fields),
      },
    );

    expect([response.status, await response.json(), reported]).toEqual([
      500,
      { errorCode: 'INTERNAL', errorName: 'Default:Internal', errorInstanceId: expect.any(String), parameters: {} },
      [expect.objectContaining({ errorName: 'Default:Internal', userId: SERVICE_USER, callerKind: 'service' })],
    ]);

    expect(stub.requests).toEqual([`/connect/applications/${SERVICE_USER}`, `/organizations/${ORGANIZATION}`]);
  });
});

describe('a failed WorkOS read of a user', () => {
  const UNAVAILABLE = {
    errorCode: 'INTERNAL',
    errorName: 'OntologyService:WorkosUnavailable',
    errorInstanceId: expect.any(String),
    parameters: {},
  };

  function failingList(answer: WorkosAnswer): void {
    answerWorkos((request) =>
      request.url.includes('/organization_memberships?organization_id=') ? answer(request) : workos.fetch(request),
    );

    input = { ...input, users: routeUsers(STUB_WORKOS_KEY) };
  }

  it.each([
    ['fails', () => Response.error()],
    ['answers 500', () => Response.json({ message: 'Server error' }, { status: 500 })],
  ])(
    'service/authentication#user-ids: a member list read that %s, with no kept list, fails Users.getBatch with 503 WorkosUnavailable, with no partial answer',
    async (_, answer) => {
      failingList(answer);

      const ids = [PERSON, NO_NAMES.id, FORMER.id, UNKNOWN].map((userId) => ({ userId }));

      const response = await getBatch(ids);

      expect([response.status, response.headers.get('retry-after')]).toEqual([503, '10']);

      expect(await response.json()).toEqual(UNAVAILABLE);
    },
  );

  describe('that WorkOS answers with 429', () => {
    const limited = (retryAfter?: string) => () =>
      Response.json(
        { message: 'Too many requests' },
        { status: 429, ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }) },
      );

    const RATE_LIMITED = {
      errorCode: 'INTERNAL',
      errorName: 'OntologyService:WorkosRateLimited',
      errorInstanceId: expect.any(String),
      parameters: {},
    };

    it.each([
      ['7', '7'],
      ['0', '0'],
      [undefined, '10'],
      ['soon', '10'],
      ['Wed, 21 Oct 2026 07:28:00 GMT', '10'],
      ['-3', '10'],
    ])(
      'service/authentication#user-ids: a member list read with Retry-After %s fails Users.getBatch with 503 and Retry-After %s, with no partial answer',
      async (workosValue, expected) => {
        failingList(limited(workosValue));

        const response = await getBatch([PERSON, NO_NAMES.id, FORMER.id, UNKNOWN].map((userId) => ({ userId })));

        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe(expected);

        expect(await response.json()).toEqual(RATE_LIMITED);
      },
    );

    it('service/authentication#user-ids: fails Users.get and Users.getCurrent with 503 and Retry-After', async () => {
      answerWorkos(limited('3'));

      input = { ...input, users: routeUsers(STUB_WORKOS_KEY) };

      for (const response of [await get(PERSON), await getCurrent()]) {
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('3');

        expect(await response.json()).toEqual(RATE_LIMITED);
      }
    });

    it('service/authentication#user-ids: fails the Organizations route with 503 and Retry-After, with no partial list', async () => {
      answerWorkos(limited('4'));

      const users = workosUsers(STUB_WORKOS_KEY);

      const response = await handle(
        new Request(`${base}/api/ontology-service/v1/organizations`, { headers: { authorization: `Bearer ${token}` } }),
        { ...input, users },
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('4');

      expect(await response.json()).toEqual(RATE_LIMITED);
    });
  });

  it('service/authentication#user-ids: a member list read with no answer in 5 seconds fails Users.getBatch with 503 WorkosUnavailable', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

    try {
      let started = false;

      failingList(() => {
        started = true;

        return new Promise<Response>(() => undefined);
      });

      const pending = getBatch([{ userId: PERSON }, { userId: NO_NAMES.id }]);

      while (!started) await new Promise((resolve) => setImmediate(resolve));

      await vi.advanceTimersByTimeAsync(4999);

      const early = await Promise.race([pending, Promise.resolve('waiting')]);

      expect(early).toBe('waiting');

      await vi.advanceTimersByTimeAsync(1);

      const response = await pending;

      expect(response.status).toBe(503);

      expect(await response.json()).toEqual(UNAVAILABLE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('service/authentication#user-ids: an unknown, a foreign, and an invited ID give no entry', async () => {
    const response = await getBatch([
      { userId: UNKNOWN },
      { userId: OUTSIDER.id },
      { userId: INVITED.id },
      { userId: PERSON },
    ]);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ data: { [PERSON]: ADA } });
  });

  it('service/authentication#user-ids: an aborted request stops its wait at once, and its shared list read goes on to keep its answer', async () => {
    const signals: AbortSignal[] = [];
    const fetched = Promise.withResolvers<undefined>();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));

    answerWorkos(async (request) => {
      signals.push(request.signal);

      fetched.resolve(undefined);

      await held;

      return workos.fetch(request);
    });

    input = { ...input, users: routeUsers(STUB_WORKOS_KEY) };

    const controller = new AbortController();

    const pending = handle(
      new Request(`${base}/api/v2/admin/users/getBatch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify([{ userId: PERSON }]),
        signal: controller.signal,
      }),
      input,
    );

    await fetched.promise;

    expect(signals).toHaveLength(1);

    controller.abort();

    expect((await pending).status).toBe(500);

    expect(signals[0]?.aborted).toBe(false);

    release();

    await vi.waitFor(() => expect(workos.requests).toEqual([MEMBER_LIST]));

    expect(await (await get(PERSON)).json()).toEqual(ADA);

    expect(signals).toHaveLength(1);
  });

  describe('Users.getCurrent and the Organizations route on a WorkOS outage', () => {
    const ORGANIZATIONS_URL = `${base}/api/ontology-service/v1/organizations`;

    const sendRoute = async (
      route: 'getCurrent' | 'person organizations' | 'service organization',
      customInput = input,
    ): Promise<Response> => {
      if (route === 'getCurrent')
        return handle(
          new Request(`${base}/api/v2/admin/users/getCurrent`, { headers: { authorization: `Bearer ${token}` } }),
          customInput,
        );

      const bearer = route === 'service organization' ? await issuer.m2m() : token;

      return handle(new Request(ORGANIZATIONS_URL, { headers: { authorization: `Bearer ${bearer}` } }), customInput);
    };

    const routes = [
      ['getCurrent', 'user', 1],
      ['person organizations', 'membership', 1],
      ['service organization', 'organization', 2],
    ] as const;

    for (const [route, read] of routes) {
      it.each(['5xx', 'network'] as const)(
        `service/authentication#errors: ${route} returns 503 WorkosUnavailable with Retry-After on a WorkOS %s`,
        async (failure) => {
          workos.fail(failure, { reads: [read] });

          const response = await sendRoute(route);

          expect([response.status, response.headers.get('retry-after')]).toEqual([503, '10']);

          expect(await response.json()).toEqual(UNAVAILABLE);
        },
      );

      it(`service/authentication#errors: ${route} keeps 500 Default:Internal on a WorkOS 401`, async () => {
        answerWorkos((request) => {
          const path = new URL(request.url).pathname;

          if (
            (read === 'user' && path.startsWith('/user_management/users/')) ||
            (read === 'membership' && path === '/user_management/organization_memberships') ||
            (read === 'organization' && path.startsWith('/organizations/'))
          ) {
            return Response.json({ message: 'Unauthorized' }, { status: 401 });
          }

          return workos.fetch(request);
        });

        const response = await sendRoute(route, {
          ...input,
          users: routeUsers(STUB_WORKOS_KEY),
          reportFault: () => undefined,
        });

        expect([response.status, response.headers.get('retry-after')]).toEqual([500, null]);

        expect(await response.json()).toMatchObject({ errorName: 'Default:Internal' });
      });
    }

    for (const [route, read, reaches] of routes) {
      it.each(['timeout', 'stalled body'] as const)(
        `service/authentication#errors: ${route} returns 503 WorkosUnavailable with Retry-After after 5 seconds on a %s`,
        async (failure) => {
          vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

          try {
            workos.fail(failure, { reads: [read] });

            const pending = sendRoute(route);

            await workos.reached(reaches);

            await vi.advanceTimersByTimeAsync(4999);

            expect(await Promise.race([pending, Promise.resolve('waiting')])).toBe('waiting');

            await vi.advanceTimersByTimeAsync(1);

            const response = await pending;

            expect([response.status, response.headers.get('retry-after')]).toEqual([503, '10']);

            expect(await response.json()).toEqual(UNAVAILABLE);
          } finally {
            vi.useRealTimers();
          }
        },
      );
    }

    it('service/authentication#user-ids: a client disconnect stops Users.getCurrent at once and does not report WorkosUnavailable', async () => {
      workos.fail('timeout', { reads: ['user'] });

      const faults: { readonly errorName: string }[] = [];
      const controller = new AbortController();

      const pending = handle(
        new Request(`${base}/api/v2/admin/users/getCurrent`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        }),
        { ...input, reportFault: (_, fields) => void faults.push({ errorName: fields.errorName }) },
      );

      await workos.reached(1);

      controller.abort(new Error('the client left'));

      const response = await pending;

      expect([response.status, response.headers.get('retry-after')]).toEqual([500, null]);

      expect(await response.json()).toMatchObject({ errorName: 'Default:Internal' });

      expect(faults).toEqual([{ errorName: 'Default:Internal' }]);
    });
  });
});

describe('a service user in the user routes', () => {
  const SECOND_SERVICE = 'client_01JSECONDSERV1CE00000000AB';
  const FOREIGN_SERVICE = 'client_01JFOREIGNSERV1CE0000000AB';
  const CONNECT_APP = 'client_01JCONNECTAPP00000000000AB';
  const UNKNOWN_CLIENT = 'client_01JUNKNOWNCL1ENT00000000AB';
  const applicationPath = (clientId: string) => `/connect/applications/${clientId}`;
  const APPLICATION_LIST = `/connect/applications?organization_id=${ORGANIZATION}&limit=100&order=asc`;

  const NOT_FOUND = (userId: string) => ({
    errorCode: 'NOT_FOUND',
    errorName: 'UserNotFound',
    errorInstanceId: expect.any(String),
    parameters: { userId },
  });

  const NIGHTLY_SYNC = {
    id: SERVICE_USER,
    username: SERVICE_USER,
    givenName: 'Nightly sync',
    realm: 'workos',
    status: 'ACTIVE',
    attributes: {},
  };

  const SECOND_SYNC = {
    id: SECOND_SERVICE,
    username: SECOND_SERVICE,
    givenName: 'Invoice export',
    realm: 'workos',
    status: 'ACTIVE',
    attributes: {},
  };

  let service: string;

  beforeEach(async () => {
    workos = stubWorkos([STUB_PERSON, NO_NAMES, FORMER, OUTSIDER, INVITED], MEMBERSHIPS, {
      applications: {
        [SERVICE_USER]: STUB_APPLICATION,
        [SECOND_SERVICE]: { ...STUB_APPLICATION, name: 'Invoice export' },
        [FOREIGN_SERVICE]: { ...STUB_APPLICATION, name: 'Foreign sync', organization_id: OTHER_ORGANIZATION },
        [CONNECT_APP]: { ...STUB_APPLICATION, name: 'Connect app', application_type: 'oauth' },
      },
    });

    input = { ...input, users: routeUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }) };

    service = await issuer.m2m();
  });

  it('service/authentication#user-ids: the user ID of a service user is its client ID, the sub of its token', async () => {
    const response = await getCurrent(service);

    expect(response.status).toBe(200);

    expect(((await response.json()) as { id: string }).id).toBe('client_01JSERV1CEUSER0000000000AB');
  });

  it('service/authentication#user-ids: Users.get gives a person a service user of its Organization, from 1 read of the kept application list', async () => {
    for (let read = 0; read < 2; read += 1) {
      const response = await get(SERVICE_USER);

      expect(response.status).toBe(200);

      expect(await response.json()).toEqual(NIGHTLY_SYNC);
    }

    expect(workos.requests).toEqual([APPLICATION_LIST]);
  });

  it('service/authentication#user-ids: Users.getCurrent gives a service user its own User, from the application list after the token check', async () => {
    const response = await getCurrent(service);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual(NIGHTLY_SYNC);

    expect(workos.requests).toEqual([applicationPath(SERVICE_USER), APPLICATION_LIST]);
  });

  it('service/authentication#user-ids: a service user gets itself, a person of its Organization, and another service user of its Organization', async () => {
    expect(await (await get(SERVICE_USER, service)).json()).toEqual(NIGHTLY_SYNC);

    expect(await (await get(PERSON, service)).json()).toEqual(ADA);

    expect(await (await get(SECOND_SERVICE, service)).json()).toEqual(SECOND_SYNC);
  });

  it('service/authentication#user-ids: a service user gets 404 UserNotFound for a person and a service user of another Organization', async () => {
    for (const userId of [OUTSIDER.id, FOREIGN_SERVICE]) {
      const response = await get(userId, service);

      expect(response.status).toBe(404);

      expect(await response.json()).toEqual(NOT_FOUND(userId));
    }
  });

  it.each([
    ['of another Organization', FOREIGN_SERVICE],
    ['that is not of the type m2m', CONNECT_APP],
  ])(
    'service/authentication#user-ids: an application %s gets the bytes of an unknown client ID, apart from the ID and the errorInstanceId',
    async (_, clientId) => {
      const answers: string[] = [];

      for (const userId of [clientId, UNKNOWN_CLIENT]) {
        const response = await get(userId);

        expect(response.status).toBe(404);

        const body = (await response.json()) as { errorInstanceId: string };

        expect(body).toEqual(NOT_FOUND(userId));

        answers.push(JSON.stringify({ ...body, errorInstanceId: '' }).replace(userId, '<id>'));

        expect([...response.headers.keys()].sort()).toEqual(['content-type']);
      }

      expect(answers[0]).toBe(answers[1]);
      expect(workos.requests).toEqual([APPLICATION_LIST]);
    },
  );

  it.each([
    ['too short', 'client_01JSERV1CEUSER'],
    ['in lowercase', 'client_01jserv1ceuser0000000000ab'],
    ['with a path', `client_01JSERV1CEUSER0000000000AB/../../users/${PERSON}`],
    ['with a query', `${SERVICE_USER}?x=1`],
  ])(
    'a client ID %s gets 404 UserNotFound, with no WorkOS call, so the ID never leaves its path segment',
    async (_, userId) => {
      const response = await get(userId);

      expect(response.status).toBe(404);

      expect(await response.json()).toEqual(NOT_FOUND(userId));

      expect(workos.requests).toEqual([]);
    },
  );

  it('service/authentication#user-ids: Users.getBatch gives the people and the service users of the Organization, and no entry for a foreign or an unknown ID', async () => {
    const ids = [
      SECOND_SERVICE,
      OUTSIDER.id,
      PERSON,
      FOREIGN_SERVICE,
      UNKNOWN,
      SERVICE_USER,
      UNKNOWN_CLIENT,
      CONNECT_APP,
      GITHUB_SUBJECT,
    ];

    const response = await getBatch(ids.map((userId) => ({ userId })));

    expect(response.status).toBe(200);

    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(body).toEqual({ data: { [SECOND_SERVICE]: SECOND_SYNC, [PERSON]: ADA, [SERVICE_USER]: NIGHTLY_SYNC } });
    expect(Object.keys(body.data)).toEqual([SECOND_SERVICE, PERSON, SERVICE_USER]);
    expect(workos.requests.toSorted()).toEqual([APPLICATION_LIST, MEMBER_LIST]);
  });

  it('service/authentication#user-ids: the User of a service user has id and username, the client ID, givenName, realm workos, status ACTIVE, and empty attributes', async () => {
    const response = await get(SERVICE_USER, token, 'ACTIVE');

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({
      id: 'client_01JSERV1CEUSER0000000000AB',
      username: 'client_01JSERV1CEUSER0000000000AB',
      givenName: 'Nightly sync',
      realm: 'workos',
      status: 'ACTIVE',
      attributes: {},
    });
  });

  it('service/authentication#user-ids: with status DELETED, a service user gets 400 UserIsActive from Users.get, and no entry from Users.getBatch', async () => {
    const single = await get(SERVICE_USER, token, 'DELETED');

    expect(single.status).toBe(400);

    expect(await single.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'UserIsActive',
      errorInstanceId: expect.any(String),
      parameters: { principalId: SERVICE_USER },
    });

    const batch = await getBatch([{ userId: SERVICE_USER, status: 'DELETED' }, { userId: SECOND_SERVICE }]);

    expect(await batch.json()).toEqual({ data: { [SECOND_SERVICE]: SECOND_SYNC } });
  });

  it('service/authentication#user-ids: a listed application with another client_id gets 404 UserNotFound', async () => {
    const listed = {
      client_id: SECOND_SERVICE,
      application_type: 'm2m',
      organization_id: ORGANIZATION,
      name: 'Invoice export',
    };

    answerWorkos(() => Response.json({ object: 'list', data: [listed], list_metadata: { before: null, after: null } }));

    input = { ...input, users: routeUsers(STUB_WORKOS_KEY) };

    expect(await (await get(SERVICE_USER)).json()).toEqual(NOT_FOUND(SERVICE_USER));
  });

  describe('after its application is deleted', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));

    afterEach(() => vi.useRealTimers());

    it('service/authentication#user-ids: the client ID gets 404 UserNotFound from Users.get and no entry from Users.getBatch once the kept list refreshes at 60 seconds', async () => {
      expect((await get(SERVICE_USER)).status).toBe(200);

      workos.setApplication(SERVICE_USER, undefined);

      await vi.advanceTimersByTimeAsync(59_000);

      expect((await get(SERVICE_USER)).status).toBe(200);

      await vi.advanceTimersByTimeAsync(1_000);

      expect((await get(SERVICE_USER)).status).toBe(200);

      await vi.advanceTimersByTimeAsync(0);

      const response = await get(SERVICE_USER);

      expect(response.status).toBe(404);

      expect(await response.json()).toEqual(NOT_FOUND(SERVICE_USER));

      expect(await (await getBatch([{ userId: SERVICE_USER }, { userId: PERSON }])).json()).toEqual({
        data: { [PERSON]: ADA },
      });
    });

    it('the service user whose token still passes on its kept answer gets 404 UserNotFound from Users.getCurrent after the application list refreshes', async () => {
      expect((await get(SERVICE_USER)).status).toBe(200);

      await vi.advanceTimersByTimeAsync(30_000);

      expect((await getCurrent(service)).status).toBe(200);

      workos.setApplication(SERVICE_USER, undefined);

      await vi.advanceTimersByTimeAsync(31_000);

      expect((await getCurrent(service)).status).toBe(200);

      await vi.advanceTimersByTimeAsync(0);

      const own = await getCurrent(service);

      expect(own.status).toBe(404);

      expect(await own.json()).toEqual(NOT_FOUND(SERVICE_USER));

      expect(workos.requests).toEqual([APPLICATION_LIST, applicationPath(SERVICE_USER), APPLICATION_LIST]);
    });
  });

  describe('when the application read fails', () => {
    it('service/authentication#user-ids: an application list read with no answer in 5 seconds fails Users.get with 503 WorkosUnavailable', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

      try {
        let started = false;

        answerWorkos(() => {
          started = true;

          return new Promise<Response>(() => undefined);
        });

        input = { ...input, users: routeUsers(STUB_WORKOS_KEY) };

        const pending = get(SERVICE_USER);

        while (!started) await new Promise((resolve) => setImmediate(resolve));

        await vi.advanceTimersByTimeAsync(4999);

        expect(await Promise.race([pending, Promise.resolve('waiting')])).toBe('waiting');

        await vi.advanceTimersByTimeAsync(1);

        const response = await pending;

        expect(response.status).toBe(503);

        expect(await response.json()).toEqual({
          errorCode: 'INTERNAL',
          errorName: 'OntologyService:WorkosUnavailable',
          errorInstanceId: expect.any(String),
          parameters: {},
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['aa1d03e1', '429', 'OntologyService:WorkosRateLimited', '7'],
      ['ae44d4a5', '5xx', 'OntologyService:WorkosUnavailable', '10'],
      ['ae44d4a5', 'network', 'OntologyService:WorkosUnavailable', '10'],
    ] as const)(
      'service/authentication#user-ids/%s: a WorkOS %s on the application list with no kept list gives 503 %s, never UserNotFound or a partial batch',
      async (_, failure, errorName, retryAfter) => {
        workos.fail(failure, { reads: ['application'], retryAfter: '7' });

        for (const response of [
          await get(SERVICE_USER),
          await getBatch([{ userId: PERSON }, { userId: SERVICE_USER }]),
        ]) {
          expect(response.status).toBe(503);

          const body = (await response.json()) as { errorName: string };

          expect(body.errorName).toBe(errorName);
          expect(response.headers.get('retry-after')).toBe(retryAfter);
        }
      },
    );
  });
});
