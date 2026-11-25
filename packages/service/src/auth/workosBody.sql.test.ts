import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { LOAD_ACCOUNTS, startInstalled, type Installed } from './installed.test-utils.ts';
import { workosUsers } from './index.ts';
import { workosPublish } from './workosPublish.ts';
import { handle, type HandleInput } from '../handler/index.ts';
import type { StartAttributes } from '../spans/index.ts';
import { testInput, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import {
  createTestIssuer,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PERSON,
  SERVICE_USER,
  type TestIssuer,
} from '../tokens.test-utils.ts';
import { routeRecording, settle, type SpanRecorder } from '../tracing.test-utils.ts';
import { STUB_APPLICATION, STUB_PERSON, STUB_WORKOS_KEY, rejectingPort, stubWorkos } from '../workos.test-utils.ts';
import { workosServer } from './workosServer.test-utils.ts';

type ReadKind = NonNullable<StartAttributes<'workos read'>['workos.read']>;

type PublishKind = 'permissions' | 'roles' | 'organizations page';

const CANARY = 'CANARY';

const BODIES = {
  'first letter': `${CANARY}-workos-body <p>ada@example.com</p>`,
  'after a valid start': `{"data":[${CANARY}-ada@example.com]}`,
} as const;

interface RouteCase {
  readonly caller: 'person' | 'service';
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly read: (url: URL) => boolean;
  readonly status: number;
}

const LOAD_OBJECTS = `/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectSets/loadObjects`;
const OBJECT_TYPES = `/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectTypes`;
const MEMBERSHIPS = '/user_management/organization_memberships';
const query = (url: URL): Record<string, string> => Object.fromEntries(url.searchParams);

const ROUTE_CASES: Record<Exclude<ReadKind, PublishKind>, RouteCase> = {
  membership: {
    caller: 'person',
    method: 'POST',
    path: LOAD_OBJECTS,
    body: LOAD_ACCOUNTS,
    read: (url) => url.pathname === MEMBERSHIPS && query(url)['statuses'] === undefined,
    status: 500,
  },
  role: {
    caller: 'person',
    method: 'GET',
    path: OBJECT_TYPES,
    read: (url) => url.pathname.startsWith('/authorization/organizations/'),
    status: 500,
  },
  'members page': {
    caller: 'person',
    method: 'POST',
    path: '/api/v2/admin/users/getBatch',
    body: [{ userId: PERSON }],
    read: (url) =>
      url.pathname === MEMBERSHIPS &&
      query(url)['organization_id'] !== undefined &&
      query(url)['statuses'] !== undefined,
    status: 500,
  },
  user: {
    caller: 'person',
    method: 'GET',
    path: '/api/v2/admin/users/getCurrent',
    read: (url) => url.pathname.startsWith('/user_management/users/'),
    status: 500,
  },
  'memberships page': {
    caller: 'person',
    method: 'GET',
    path: '/api/ontology-service/v1/organizations',
    read: (url) => url.pathname === MEMBERSHIPS && query(url)['organization_id'] === undefined,
    status: 500,
  },
  application: {
    caller: 'service',
    method: 'POST',
    path: LOAD_OBJECTS,
    body: LOAD_ACCOUNTS,
    read: (url) => url.pathname.startsWith('/connect/applications/'),
    status: 500,
  },
  'applications page': {
    caller: 'service',
    method: 'GET',
    path: '/api/v2/admin/users/getCurrent',
    read: (url) => url.pathname === '/connect/applications',
    status: 500,
  },
  organization: {
    caller: 'service',
    method: 'GET',
    path: '/api/ontology-service/v1/organizations',
    read: (url) => url.pathname.startsWith('/organizations/'),
    status: 500,
  },
};

let issuer: TestIssuer;
let recorder: SpanRecorder;
let installed: Installed;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;
const faults: string[] = [];
const answerWorkos = workosServer();

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, 'jobsite:read');

  if (routeRecording.recorder === undefined) throw new Error('The sql project setup records the spans.');

  recorder = routeRecording.recorder;
});

afterAll(() => installed?.stop());

beforeEach(() => {
  recorder.reset();

  faults.length = 0;

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  consoleLog.mockRestore();

  consoleError.mockRestore();

  vi.useRealTimers();
});

function instance(read: (url: URL) => boolean, body: string, poisoned: () => boolean = () => true): HandleInput {
  const stub = stubWorkos([STUB_PERSON], undefined, {
    roles: { [ORGANIZATION]: { member: ['jobsite:read'] } },
    applications: { [SERVICE_USER]: STUB_APPLICATION },
  });

  answerWorkos((request) =>
    poisoned() && read(new URL(request.url))
      ? new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      : stub.fetch(request),
  );

  const reportFault: HandleInput['reportFault'] = (error, fields) =>
    void faults.push(
      String(error instanceof Error ? `${error.stack} ${String(error.cause)}` : error),
      JSON.stringify(fields),
    );

  return {
    ...testInput,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY),
    reportFault,
  };
}

async function send(input: HandleInput, route: RouteCase): Promise<{ readonly status: number; readonly text: string }> {
  const bearer = route.caller === 'person' ? await issuer.workos() : await issuer.m2m();

  const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };

  const answer = await handle(
    new Request(`http://localhost${route.path}`, {
      method: route.method,
      headers,
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    }),
    input,
  );

  const text = await answer.text();

  await settle();

  return { status: answer.status, text };
}

function outputs(): string {
  const spans = recorder.spans();

  return JSON.stringify(
    [
      consoleLog.mock.calls,
      consoleError.mock.calls.map((args) => args.map((arg) => (arg instanceof Error ? arg.stack : String(arg)))),
      faults,
      spans,
    ],
    (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
  );
}

describe('service/observability#logs: a WorkOS body that is not JSON reaches no log, fault report, span, or response', () => {
  for (const [kind, route] of Object.entries(ROUTE_CASES)) {
    for (const [where, body] of Object.entries(BODIES)) {
      it(`the ${kind} read, with a body that is not JSON from its ${where}, keeps its status ${route.status} and shows no part of the body`, async () => {
        const answer = await send(instance(route.read, body), route);

        expect(answer.status).toBe(route.status);
        expect(answer.text).not.toContain(CANARY);

        const shown = outputs();

        expect(shown).toContain(`"workos.read":"${kind}"`);
        expect(faults.length).toBeGreaterThan(0);
        expect(shown).not.toContain(CANARY);
      });
    }
  }

  it('a membership read with a body that is not JSON serves the kept answer at 61 seconds without leaking the body, and keeps status 500 past 300 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    let poisoned = false;
    const route = ROUTE_CASES.membership;
    const input = instance(route.read, BODIES['first letter'], () => poisoned);

    expect((await send(input, route)).status).toBe(200);

    vi.advanceTimersByTime(61_000);

    poisoned = true;

    const stale = await send(input, route);

    expect(stale.status).toBe(200);
    expect(stale.text + outputs()).not.toContain(CANARY);

    vi.advanceTimersByTime(240_000);

    const answer = await send(input, route);

    expect(answer.status).toBe(500);
    expect(answer.text + outputs()).not.toContain(CANARY);
  });
});

describe('service/observability#logs: a WorkOS body that is not JSON on a read of the publish port is a failure of WorkOS with no part of the body', () => {
  const PUBLISH_CASES: Record<
    PublishKind,
    { readonly read: (url: URL) => boolean; readonly run: (port: ReturnType<typeof rejectingPort>) => Promise<unknown> }
  > = {
    permissions: { read: (url) => url.pathname === '/authorization/permissions', run: (port) => port.read() },
    roles: { read: (url) => url.pathname === '/authorization/roles', run: (port) => port.read() },
    'organizations page': {
      read: (url) => url.pathname === '/organizations',
      run: async (port) => {
        for await (const _ of port.memberRoles()) void _;
      },
    },
  };

  it.each([
    { role: 'member', roles: [{ slug: 'member' }] },
    { role: { slug: 'member' }, roles: 'member' },
  ])('a membership %j throws 503 OntologyService:WorkosUnavailable', async (fields) => {
    const stub = stubWorkos([STUB_PERSON], [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active' }]);

    answerWorkos((request) =>
      new URL(request.url).pathname === MEMBERSHIPS ? Response.json(page([member(fields)])) : stub.fetch(request),
    );

    await expect(
      PUBLISH_CASES['organizations page'].run(rejectingPort(workosPublish(STUB_WORKOS_KEY))),
    ).rejects.toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });
  });

  for (const [kind, { read, run }] of Object.entries(PUBLISH_CASES)) {
    for (const [where, body] of Object.entries(BODIES)) {
      it(`the ${kind} read, with a body that is not JSON from its ${where}, throws 503 OntologyService:WorkosUnavailable`, async () => {
        const stub = stubWorkos([STUB_PERSON]);

        answerWorkos((request) =>
          read(new URL(request.url)) ? new Response(body, { status: 200 }) : stub.fetch(request),
        );

        const error: unknown = await run(rejectingPort(workosPublish(STUB_WORKOS_KEY))).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );

        expect(error).toMatchObject({ status: 503, errorName: 'OntologyService:WorkosUnavailable' });
        expect(String((error as Error).stack) + JSON.stringify(error) + outputs()).not.toContain(CANARY);
      });
    }
  }
});

const member = (fields: object = {}): object => ({
  user_id: PERSON,
  organization_id: ORGANIZATION,
  status: 'active',
  ...fields,
});

const page = (data: unknown): object => ({ data, list_metadata: { after: null } });

const SHAPES: Record<
  Exclude<ReadKind, PublishKind>,
  {
    readonly found: readonly (readonly [body: unknown, status: number, errorName?: string])[];
    readonly faults: readonly unknown[];
  }
> = {
  membership: {
    found: [
      [null, 403, 'Default:PermissionDenied'],
      [page([member({ user_id: 'user_other', roles: [] })]), 403, 'Default:PermissionDenied'],
    ],
    faults: [
      0,
      {},
      page({}),
      page([null]),
      page([member()]),
      page([member({ roles: [{ slug: 5 }] })]),
      page([member({ user_id: 5, roles: [] })]),
      page([member({ roles: [] }), member({ user_id: 'user_other' })]),
    ],
  },
  role: { found: [[null, 200]], faults: [0, false, '', {}, [], { permissions: [5] }] },
  'members page': {
    found: [
      [{ data: [], list_metadata: null }, 200],
      [page([member()]), 200],
    ],
    faults: [
      null,
      {},
      page({}),
      page([null]),
      page([member({ user: { id: PERSON, first_name: null, last_name: null } })]),
      page([member({ user: null })]),
      page([member({ user_id: 'user_other', status: 5 })]),
    ],
  },
  user: {
    found: [[null, 404, 'UserNotFound']],
    faults: [0, false, '', [], {}, 5, { ...STUB_PERSON, first_name: undefined }],
  },
  'memberships page': {
    found: [
      [null, 200],
      [page([member()]), 200],
    ],
    faults: [
      0,
      {},
      [],
      page({}),
      page(null),
      page([{ user_id: PERSON, status: 'active' }]),
      page([member({ organization_name: null })]),
    ],
  },
  application: {
    found: [[null, 401, 'Default:Unauthorized']],
    faults: [
      0,
      false,
      '',
      {},
      { client_id: SERVICE_USER, application_type: 'm2m', organization_id: ORGANIZATION, scopes: [5] },
    ],
  },
  'applications page': {
    found: [[page([{ client_id: 'client_other', application_type: 'oauth', name: 'Other' }]), 404, 'UserNotFound']],
    faults: [
      null,
      {},
      page([{ client_id: 5 }]),
      page([{ client_id: SERVICE_USER, application_type: 'm2m', organization_id: ORGANIZATION }]),
      page([{ client_id: 'client_other', name: 'Other' }]),
    ],
  },
  organization: { found: [], faults: [null, {}, { id: OTHER_ORGANIZATION, name: 'OtherCo' }] },
};

describe('service/code-layout#libraries: a WorkOS answer of another shape gets the status of its read', () => {
  for (const [kind, { found, faults }] of Object.entries(SHAPES)) {
    const route = ROUTE_CASES[kind as keyof typeof SHAPES];

    it.each([...found, ...faults.map((body) => [body, 500, 'Default:Internal'] as const)])(
      `the ${kind} read, with the body %j, gets %i %s`,
      async (body, status, errorName) => {
        const answer = await send(instance(route.read, JSON.stringify(body)), route);

        expect(answer.status).toBe(status);
        expect((JSON.parse(answer.text) as { errorName?: string }).errorName).toBe(errorName);
      },
    );
  }
});
