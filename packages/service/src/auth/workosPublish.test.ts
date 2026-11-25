import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workosPublish } from './index.ts';
import type { GrantsFile } from '../ontology/index.ts';
import { rejecting } from '../publish/publish.test-utils.ts';
import { planWorkosSteps, refuseRoleInUse } from '../publish/workosSteps.ts';
import { recordSpans, type SpanRecorder } from '../tracing.test-utils.ts';
import {
  STUB_WORKOS_KEY,
  rejectingPort,
  stubWorkos,
  type StubFailure,
  type StubMembership,
  type StubWorkos,
} from '../workos.test-utils.ts';
import { workosServer } from './workosServer.test-utils.ts';

let recorder: SpanRecorder;

beforeAll(() => {
  recorder = recordSpans();
});

beforeEach(() => recorder.reset());

afterAll(() => recorder.stop());

const answerWorkos = workosServer();

const GRANTS: GrantsFile = {
  permissions: { 'accounts:read': { description: 'View accounts' } },
  objectTypes: {},
  actionTypes: {},
  defaultRoles: { admin: ['ontology:install', 'accounts:read'], member: ['accounts:read'] },
};

function emptyStub(memberships: readonly StubMembership[] = [], organizations: readonly string[] = []): StubWorkos {
  return stubWorkos([], memberships, { roles: {}, organizations });
}

async function applyPlan(port: ReturnType<typeof rejectingPort>, grants: GrantsFile): Promise<void> {
  for (const step of planWorkosSteps(grants, await port.read(), new Set(Object.keys(grants.defaultRoles))))
    await port.apply(step);
}

describe('the writes of the WorkOS steps', () => {
  it('service/publish#default-roles-in-workos: the steps reach the stub in the stated order, on the stated paths', async () => {
    const stub = emptyStub();

    await applyPlan(rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch })), GRANTS);

    expect(stub.writes).toEqual([
      { method: 'POST', path: '/authorization/permissions', body: { slug: 'accounts:read', name: 'accounts:read' } },
      {
        method: 'POST',
        path: '/authorization/permissions',
        body: { slug: 'ontology:install', name: 'ontology:install' },
      },
      { method: 'PATCH', path: '/authorization/permissions/accounts%3Aread', body: { description: 'View accounts' } },
      {
        method: 'PATCH',
        path: '/authorization/permissions/ontology%3Ainstall',
        body: { description: 'Install an Ontology of a product in the Organization' },
      },
      { method: 'POST', path: '/authorization/roles', body: { slug: 'admin', name: 'admin' } },
      { method: 'POST', path: '/authorization/roles', body: { slug: 'member', name: 'member' } },
      { method: 'POST', path: '/authorization/roles/admin/permissions', body: { slug: 'accounts:read' } },
      { method: 'POST', path: '/authorization/roles/admin/permissions', body: { slug: 'ontology:install' } },
      { method: 'POST', path: '/authorization/roles/member/permissions', body: { slug: 'accounts:read' } },
    ]);

    expect(stub.environment()).toEqual({
      permissions: {
        'accounts:read': 'View accounts',
        'ontology:install': 'Install an Ontology of a product in the Organization',
      },
      roles: { admin: ['accounts:read', 'ontology:install'], member: ['accounts:read'] },
    });
  });

  it('service/publish#default-roles-in-workos: a second plan after the steps is empty, and a 409 conflict of a create counts as done', async () => {
    const stub = emptyStub();
    const port = rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }));

    await applyPlan(port, GRANTS);

    expect(planWorkosSteps(GRANTS, await port.read(), new Set(Object.keys(GRANTS.defaultRoles)))).toEqual([]);

    await port.apply({ step: 'createPermission', permission: 'accounts:read' });

    await port.apply({ step: 'createRole', role: 'admin' });

    expect(stub.writes.slice(-2)).toEqual([
      { method: 'POST', path: '/authorization/permissions', body: { slug: 'accounts:read', name: 'accounts:read' } },
      { method: 'POST', path: '/authorization/roles', body: { slug: 'admin', name: 'admin' } },
    ]);
  });

  it('each read of the plan pages the permissions 100 at a time, oldest first', async () => {
    const permissions = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`p:${String(index).padStart(3, '0')}`, null]),
    );

    const stub = stubWorkos([], [], { roles: {}, environment: { permissions, roles: { admin: ['p:000'] } } });

    const read = await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch })).read();

    expect([read.permissions.size, read.permissions.get('p:149'), [...(read.roles.get('admin') ?? [])]]).toEqual([
      150,
      '',
      ['p:000'],
    ]);

    expect(stub.requests).toEqual([
      '/authorization/permissions?limit=100&order=asc',
      '/authorization/permissions?limit=100&order=asc&after=100',
      '/authorization/roles',
    ]);
  });

  it('service/publish#default-roles-in-workos: a failed write or read gets 503 OntologyService:WorkosUnavailable, with no WorkOS text and no cause', async () => {
    const failures: (StubFailure | 'answer lost' | 'conflict')[] = ['network', '5xx', '429', 'answer lost', 'conflict'];
    const answers: unknown[] = [];

    for (const failure of failures) {
      const stub = stubWorkos([], [], { roles: {}, environment: { permissions: {}, roles: { admin: [] } } });
      const port = rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }));

      if (failure === 'conflict') {
        answers.push(
          await port
            .apply({ step: 'addPermission', role: 'admin', permission: 'accounts:read' })
            .catch((error: unknown) => error),
        );

        continue;
      }

      stub.failWrites(0, failure);

      answers.push(await port.apply({ step: 'createRole', role: 'member' }).catch((error: unknown) => error));
    }

    const failedRead = stubWorkos([], [], { roles: {} });

    failedRead.fail('5xx', { reads: ['permissions'] });

    answers.push(
      await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: failedRead.fetch }))
        .read()
        .catch((error: unknown) => error),
    );

    expect(
      answers.map((error) => [
        (error as { status?: unknown }).status,
        (error as { errorName?: unknown }).errorName,
        (error as Error).cause,
        JSON.stringify(error).includes(STUB_WORKOS_KEY),
      ]),
    ).toEqual([
      [503, 'OntologyService:WorkosUnavailable', undefined, false],
      [503, 'OntologyService:WorkosUnavailable', undefined, false],
      [503, 'OntologyService:WorkosUnavailable', undefined, false],
      [503, 'OntologyService:WorkosUnavailable', undefined, false],
      [503, 'OntologyService:WorkosUnavailable', undefined, false],
      [503, 'OntologyService:WorkosUnavailable', undefined, false],
    ]);
  });

  it('a roles list that names a next page is a failure of WorkOS, so no role stays unread', async () => {
    const stub = emptyStub();

    answerWorkos(async (request) => {
      const answer = await stub.fetch(request);

      if (!request.url.endsWith('/authorization/roles')) return answer;

      return Response.json({ ...((await answer.json()) as object), list_metadata: { before: null, after: 'role_01' } });
    });

    const answer = await rejectingPort(workosPublish(STUB_WORKOS_KEY))
      .read()
      .catch((error: unknown) => error);

    expect([(answer as { status?: unknown }).status, (answer as { errorName?: unknown }).errorName]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
    ]);
  });

  it('a slug with dots inside it reaches the stub on its own path', async () => {
    const stub = stubWorkos([], [], {
      roles: {},
      environment: { permissions: { 'a.b': null, 'a..b': null }, roles: {} },
    });

    const port = rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }));

    await port.apply({ step: 'setDescription', permission: 'a.b', description: 'Dots' });

    await port.apply({ step: 'setDescription', permission: 'a..b', description: 'Dots' });

    expect([stub.writes.map(({ method, path }) => `${method} ${path}`), stub.environment().permissions]).toEqual([
      ['PATCH /authorization/permissions/a.b', 'PATCH /authorization/permissions/a..b'],
      { 'a.b': 'Dots', 'a..b': 'Dots' },
    ]);
  });

  it('a slug that changes the path after URL parsing gets 400 with part grants, and reaches no path', async () => {
    const stub = emptyStub();
    const port = rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }));
    const answers: unknown[] = [];

    for (const step of [
      { step: 'setDescription', permission: '..', description: '' },
      { step: 'setDescription', permission: '.', description: '' },
      { step: 'addPermission', role: '..', permission: 'a' },
    ] as const) {
      const error = (await port.apply(step).catch((thrown: unknown) => thrown)) as {
        status?: unknown;
        parameters?: unknown;
      };

      answers.push([error.status, error.parameters]);
    }

    expect([answers, stub.requests]).toEqual([
      [
        [400, { part: 'grants', problems: ['WorkOS refuses the slug "..".'] }],
        [400, { part: 'grants', problems: ['WorkOS refuses the slug ".".'] }],
        [400, { part: 'grants', problems: ['WorkOS refuses the slug "..".'] }],
      ],
      [],
    ]);
  });

  it('each WorkOS read and write of publish runs in its own span, and no span holds the API key', async () => {
    const stub = emptyStub();
    const port = rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }));

    await applyPlan(port, { ...GRANTS, defaultRoles: { member: ['accounts:read'] } });

    expect(recorder.spans().map((span) => [span.name, span.attributes])).toEqual([
      ['workos read', { 'workos.read': 'permissions', 'http.status_code': 200, 'sentry.op': 'http.client' }],
      ['workos read', { 'workos.read': 'roles', 'http.status_code': 200, 'sentry.op': 'http.client' }],
      ['workos write', { 'workos.write': 'createPermission', 'http.status_code': 201, 'sentry.op': 'http.client' }],
      ['workos write', { 'workos.write': 'setDescription', 'http.status_code': 200, 'sentry.op': 'http.client' }],
      ['workos write', { 'workos.write': 'createRole', 'http.status_code': 201, 'sentry.op': 'http.client' }],
      ['workos write', { 'workos.write': 'addPermission', 'http.status_code': 200, 'sentry.op': 'http.client' }],
    ]);

    expect(
      JSON.stringify(recorder.spans(), (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain(STUB_WORKOS_KEY);
  });
});

describe('the RoleInUse check', () => {
  const member = (user: number, organization: string, roles?: readonly string[]): StubMembership => ({
    user_id: `user_${String(user).padStart(4, '0')}`,
    organization_id: organization,
    status: 'active',
    ...(roles ? { roles } : {}),
  });

  const MEMBERSHIPS = '/user_management/organization_memberships';

  const page = (organization: string, after?: number) =>
    `${MEMBERSHIPS}?organization_id=${organization}&statuses=active%2Cinactive%2Cpending&limit=100&order=asc${after === undefined ? '' : `&after=${after}`}`;

  const twoOrganizations = (last: string): StubMembership[] => [
    ...Array.from({ length: 150 }, (_, index) => member(index, 'org_a')),
    ...Array.from({ length: 119 }, (_, index) => member(1000 + index, 'org_b')),
    member(2000, 'org_b', [last]),
  ];

  it('service/publish#default-roles-in-workos: the check lists each Organization, and reads its members 100 at a time, up to a later page', async () => {
    const stub = emptyStub(twoOrganizations('viewer'));

    const answer = await rejecting(
      refuseRoleInUse(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }), ['viewer']),
    ).catch((error: unknown) => error);

    expect([
      (answer as { status?: unknown }).status,
      (answer as { errorName?: unknown }).errorName,
      (answer as { parameters?: unknown }).parameters,
    ]).toEqual([409, 'OntologyService:RoleInUse', { role: 'viewer' }]);

    expect(stub.requests).toEqual([
      '/organizations?limit=100&order=asc',
      page('org_a'),
      page('org_a', 100),
      page('org_b'),
      page('org_b', 100),
    ]);
  });

  it('service/publish#default-roles-in-workos: the check reads each page of the Organization list, and finds a role in an Organization of a later page', async () => {
    const memberships = Array.from({ length: 150 }, (_, index) =>
      member(index, `org_${String(index).padStart(3, '0')}`, index === 149 ? ['viewer'] : undefined),
    );

    const stub = emptyStub(memberships);

    const answer = (await rejecting(
      refuseRoleInUse(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }), ['viewer']),
    ).catch((error: unknown) => error)) as { errorName?: unknown; parameters?: unknown };

    expect([answer.errorName, answer.parameters]).toEqual(['OntologyService:RoleInUse', { role: 'viewer' }]);

    expect(stub.requests.filter((path) => path.startsWith('/organizations'))).toEqual([
      '/organizations?limit=100&order=asc',
      '/organizations?limit=100&order=asc&after=100',
    ]);

    expect(stub.requests.filter((path) => path.startsWith(MEMBERSHIPS))).toHaveLength(150);
  });

  it('the RoleInUse check: a failure on the first page of the Organizations or of the members refuses with 503', async () => {
    const stub = emptyStub(twoOrganizations('member'));

    for (const failing of ['/organizations?limit=100&order=asc', page('org_a')]) {
      answerWorkos((request) => {
        const url = new URL(request.url);

        return url.pathname + url.search === failing
          ? Response.json({ message: 'Internal Server Error' }, { status: 500 })
          : stub.fetch(request);
      });

      const answer = (await rejecting(refuseRoleInUse(workosPublish(STUB_WORKOS_KEY), ['viewer'])).catch(
        (error: unknown) => error,
      )) as { status?: unknown; errorName?: unknown };

      expect([failing, answer.status, answer.errorName]).toEqual([failing, 503, 'OntologyService:WorkosUnavailable']);
    }
  });

  it('service/publish#default-roles-in-workos: with no dropped role, the check reads nothing', async () => {
    const stub = emptyStub([member(1, 'org_a', ['viewer'])]);

    await rejecting(refuseRoleInUse(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }), []));

    expect(stub.requests).toEqual([]);
  });

  it('service/publish#default-roles-in-workos: a role that no member holds passes after the last page, and a failure on a later page refuses', async () => {
    const stub = emptyStub(twoOrganizations('member'));

    await rejecting(refuseRoleInUse(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }), ['viewer']));

    expect(stub.requests).toEqual([
      '/organizations?limit=100&order=asc',
      page('org_a'),
      page('org_a', 100),
      page('org_b'),
      page('org_b', 100),
    ]);

    for (const failing of [page('org_a', 100), page('org_b', 100)]) {
      answerWorkos((request) => {
        const url = new URL(request.url);

        return url.pathname + url.search === failing
          ? Response.json({ message: 'Internal Server Error' }, { status: 500 })
          : stub.fetch(request);
      });

      const answer = await rejecting(refuseRoleInUse(workosPublish(STUB_WORKOS_KEY), ['viewer'])).catch(
        (error: unknown) => error,
      );

      expect([(answer as { status?: unknown }).status, (answer as { errorName?: unknown }).errorName]).toEqual([
        503,
        'OntologyService:WorkosUnavailable',
      ]);
    }
  });
});

describe('a 409 answer of a write', () => {
  it('a 409 on setDescription or addPermission, with no code or another code, gives 503, because only a create has a known 409 of a step that already ran', async () => {
    const answers: unknown[] = [];

    for (const body of [{}, { code: 'permission_slug_conflict' }]) {
      answerWorkos(() => Response.json(body, { status: 409 }));

      const port = rejectingPort(workosPublish(STUB_WORKOS_KEY));

      for (const step of [
        { step: 'setDescription', permission: 'a', description: 'A' },
        { step: 'addPermission', role: 'member', permission: 'a' },
      ] as const) {
        const error = (await port.apply(step).catch((thrown: unknown) => thrown)) as {
          status?: unknown;
          errorName?: unknown;
        };

        answers.push([step.step, body, error.status, error.errorName]);
      }
    }

    expect(answers).toEqual([
      ['setDescription', {}, 503, 'OntologyService:WorkosUnavailable'],
      ['addPermission', {}, 503, 'OntologyService:WorkosUnavailable'],
      ['setDescription', { code: 'permission_slug_conflict' }, 503, 'OntologyService:WorkosUnavailable'],
      ['addPermission', { code: 'permission_slug_conflict' }, 503, 'OntologyService:WorkosUnavailable'],
    ]);
  });
});

describe('the write of the reconcile', () => {
  const environment = { permissions: { a: null, b: null, c: null }, roles: { member: ['a', 'b', 'c'] } };
  const stubWith = (): StubWorkos => stubWorkos([], [], { roles: {}, environment });

  it('service/publish#reconcile: setPermissions writes the full list of the role with 1 PUT on the permissions of the role, and reads nothing', async () => {
    const stub = stubWith();

    await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch })).setPermissions('member', ['a', 'c']);

    expect([stub.calls, stub.writes, stub.environment().roles]).toEqual([
      ['PUT /authorization/roles/member/permissions'],
      [{ method: 'PUT', path: '/authorization/roles/member/permissions', body: { permissions: ['a', 'c'] } }],
      { member: ['a', 'c'] },
    ]);
  });

  it('each WorkOS failure of the PUT gives 503 OntologyService:WorkosUnavailable', async () => {
    const answers: unknown[] = [];

    for (const failure of ['network', '5xx', '429', 'answer lost'] as const) {
      const stub = stubWith();

      stub.failWrites(0, failure);

      const error = (await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }))
        .setPermissions('member', ['a'])
        .catch((thrown: unknown) => thrown)) as { status?: unknown; errorName?: unknown };

      answers.push([failure, error.status, error.errorName, stub.environment().roles['member']]);
    }

    expect(answers).toEqual([
      ['network', 503, 'OntologyService:WorkosUnavailable', ['a', 'b', 'c']],
      ['5xx', 503, 'OntologyService:WorkosUnavailable', ['a', 'b', 'c']],
      ['429', 503, 'OntologyService:WorkosUnavailable', ['a', 'b', 'c']],
      ['answer lost', 503, 'OntologyService:WorkosUnavailable', ['a']],
    ]);
  });

  it('a 422 invalid_permission_slug on the PUT gives 503, and the role keeps its list', async () => {
    const stub = stubWith();

    const error = (await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }))
      .setPermissions('member', ['a', 'missing'])
      .catch((thrown: unknown) => thrown)) as { status?: unknown; errorName?: unknown };

    expect([error.status, error.errorName, stub.environment().roles['member']]).toEqual([
      503,
      'OntologyService:WorkosUnavailable',
      ['a', 'b', 'c'],
    ]);
  });

  it('a role slug that the URL parser would change gets 400 before any call', async () => {
    const stub = stubWith();

    const error = (await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch }))
      .setPermissions('..', ['a'])
      .catch((thrown: unknown) => thrown)) as { status?: unknown; parameters?: unknown };

    expect([error.status, error.parameters, stub.requests]).toEqual([
      400,
      { part: 'grants', problems: ['WorkOS refuses the slug "..".'] },
      [],
    ]);
  });

  it('the write of the reconcile runs in its own span, and no span holds the API key', async () => {
    const stub = stubWith();

    await rejectingPort(workosPublish(STUB_WORKOS_KEY, { fetch: stub.fetch })).setPermissions('member', ['a']);

    expect(recorder.spans().map((span) => [span.name, span.attributes])).toEqual([
      ['workos write', { 'workos.write': 'setPermissions', 'http.status_code': 200, 'sentry.op': 'http.client' }],
    ]);

    expect(
      JSON.stringify(recorder.spans(), (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain(STUB_WORKOS_KEY);
  });
});
