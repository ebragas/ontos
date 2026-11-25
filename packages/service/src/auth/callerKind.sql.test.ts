import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { LOAD_ACCOUNTS, publishBody, startInstalled, type Installed } from './installed.test-utils.ts';
import { workosUsers } from './index.ts';
import { handle, type FaultFields, type HandleInput } from '../handler/index.ts';
import { testInput, testMcpSettings, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import {
  createTestIssuer,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PERSON,
  SERVICE_USER,
  type TestIssuer,
} from '../tokens.test-utils.ts';
import { routeRecording, settle, type SpanRecorder } from '../tracing.test-utils.ts';
import { STUB_APPLICATION, STUB_PERSON, STUB_WORKOS_KEY, stubWorkos, type StubWorkos } from '../workos.test-utils.ts';

const base = 'http://localhost';
const LOAD_OBJECTS = `/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectSets/loadObjects`;
const PUBLISH = '/api/ontology-service/v1/publish';
const CANARY = { canary: 'CANARY-claim-5d21' };
const GITHUB = 'repo:example/test-app:environment:publish-staging';

let issuer: TestIssuer;
let recorder: SpanRecorder;
let installed: Installed;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;
const faults: FaultFields[] = [];
const sent: string[] = [];

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

  sent.length = 0;

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  consoleLog.mockRestore();

  consoleError.mockRestore();
});

function workos(): StubWorkos {
  return stubWorkos([STUB_PERSON], undefined, {
    roles: { [ORGANIZATION]: { member: ['jobsite:read'] } },
    applications: { [SERVICE_USER]: { ...STUB_APPLICATION, scopes: ['jobsite:read'] } },
  });
}

function instance(stub: StubWorkos = workos(), settings = testSettings): HandleInput {
  return {
    ...testInput,
    settings,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY, { fetch: stub.fetch }),
    reportFault: (_error, fields) => void faults.push(fields),
  };
}

function send(
  input: HandleInput,
  path: string,
  bearer: string | undefined,
  body: unknown = path === PUBLISH ? publishBody('jobsite:read') : LOAD_ACCOUNTS,
): Promise<Response> {
  if (bearer !== undefined) sent.push(bearer);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
  };

  return handle(new Request(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), input);
}

async function recorded(
  response: Promise<Response>,
): Promise<{ status: number; line: Record<string, unknown>; root: Record<string, unknown> }> {
  const answer = await response;

  const { status } = answer;

  await answer.text();

  await settle();

  const lines = consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  const spans = recorder.spans();

  const text = JSON.stringify(
    [lines, spans, faults, consoleError.mock.calls.map((args) => args.map(String))],
    (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
  );

  expect(text).not.toContain(CANARY.canary);

  for (const token of sent) for (const part of token.split('.')) expect(text).not.toContain(part);

  const roots = spans.filter((span) => span.parentSpanId === undefined);

  expect({ lines: lines.length, roots: roots.length }).toEqual({ lines: 1, roots: 1 });

  return { status, line: lines[0] ?? {}, root: { ...roots[0]?.attributes } };
}

function who({ status, line, root }: Awaited<ReturnType<typeof recorded>>): unknown {
  return {
    status,
    userId: line['userId'],
    callerKind: line['callerKind'],
    'user.id': root['user.id'],
    'caller.kind': root['caller.kind'],
  };
}

describe('the caller kind of each caller', () => {
  it('service/observability#logs service/observability#traces: a person gets the caller kind person in the line and the root span', async () => {
    expect(who(await recorded(send(instance(), LOAD_OBJECTS, await issuer.workos(CANARY))))).toEqual({
      status: 200,
      userId: PERSON,
      callerKind: 'person',
      'user.id': PERSON,
      'caller.kind': 'person',
    });
  });

  it('service/observability#logs service/observability#traces: a service user gets the caller kind service in the line and the root span', async () => {
    expect(who(await recorded(send(instance(), LOAD_OBJECTS, await issuer.m2m(CANARY))))).toEqual({
      status: 200,
      userId: SERVICE_USER,
      callerKind: 'service',
      'user.id': SERVICE_USER,
      'caller.kind': 'service',
    });
  });

  it('service/observability#logs service/observability#traces: the publish caller gets the caller kind publish in the line and the root span', async () => {
    expect(who(await recorded(send(instance(), PUBLISH, await issuer.github(CANARY))))).toEqual({
      status: 200,
      userId: GITHUB,
      callerKind: 'publish',
      'user.id': GITHUB,
      'caller.kind': 'publish',
    });
  });

  it('service/observability#logs service/observability#traces: a pull request check gets the caller kind check in the line and the root span', async () => {
    const token = await issuer.github({ ...CANARY, environment: undefined, sub: 'repo:example/test-app:pull_request' });

    expect(who(await recorded(send(instance(), PUBLISH, token, publishBody('jobsite:read', true))))).toEqual({
      status: 200,
      userId: 'repo:example/test-app:pull_request',
      callerKind: 'check',
      'user.id': 'repo:example/test-app:pull_request',
      'caller.kind': 'check',
    });
  });

  it('service/observability#logs service/observability#traces: a person on the MCP route gets the caller kind person in the line and the root span', async () => {
    const token = await issuer.authkit(CANARY);

    sent.push(token);

    const request = new Request(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });

    expect(who(await recorded(handle(request, instance(workos(), testMcpSettings))))).toEqual({
      status: 200,
      userId: PERSON,
      callerKind: 'person',
      'user.id': PERSON,
      'caller.kind': 'person',
    });
  });
});

describe('the caller kind of a request that fails after the token check', () => {
  it('service/observability#logs service/observability#traces: a person gets 503 at the permission read, and the line and the root span still hold the person', async () => {
    const stub = workos();

    stub.fail('network');

    expect(who(await recorded(send(instance(stub), LOAD_OBJECTS, await issuer.workos(CANARY))))).toEqual({
      status: 503,
      userId: PERSON,
      callerKind: 'person',
      'user.id': PERSON,
      'caller.kind': 'person',
    });
  });

  it('service/observability#error-reports: the fault report of a 503 at the permission read of a person holds the user ID and the caller kind', async () => {
    const stub = workos();

    stub.fail('network');

    const { status } = await recorded(send(instance(stub), LOAD_OBJECTS, await issuer.workos(CANARY)));

    expect({
      status,
      faults: faults.map(({ errorName, userId, callerKind }) => ({ errorName, userId, callerKind })),
    }).toEqual({
      status: 503,
      faults: [{ errorName: 'OntologyService:WorkosUnavailable', userId: PERSON, callerKind: 'person' }],
    });
  });

  it('service/observability#logs service/observability#traces service/observability#error-reports: a service user gets 503 at the application read, and the line, the root span, and the report still hold the service user', async () => {
    const stub = workos();

    stub.fail('network');

    expect(who(await recorded(send(instance(stub), LOAD_OBJECTS, await issuer.m2m(CANARY))))).toEqual({
      status: 503,
      userId: SERVICE_USER,
      callerKind: 'service',
      'user.id': SERVICE_USER,
      'caller.kind': 'service',
    });

    expect(faults.map(({ errorName, userId, callerKind }) => ({ errorName, userId, callerKind }))).toEqual([
      { errorName: 'OntologyService:WorkosUnavailable', userId: SERVICE_USER, callerKind: 'service' },
    ]);
  });

  it('service/observability#logs service/observability#traces: a service user whose application is gone gets 401, and the line and the root span still hold the service user', async () => {
    const stub = workos();

    stub.setApplication(SERVICE_USER, undefined);

    expect(who(await recorded(send(instance(stub), LOAD_OBJECTS, await issuer.m2m(CANARY))))).toEqual({
      status: 401,
      userId: SERVICE_USER,
      callerKind: 'service',
      'user.id': SERVICE_USER,
      'caller.kind': 'service',
    });
  });

  it('service/observability#logs service/observability#traces: a service user whose application belongs to another Organization gets 401, and the line and the root span still hold the service user', async () => {
    const stub = workos();

    stub.setApplication(SERVICE_USER, { ...STUB_APPLICATION, organization_id: OTHER_ORGANIZATION });

    expect(who(await recorded(send(instance(stub), LOAD_OBJECTS, await issuer.m2m(CANARY))))).toEqual({
      status: 401,
      userId: SERVICE_USER,
      callerKind: 'service',
      'user.id': SERVICE_USER,
      'caller.kind': 'service',
    });
  });

  it('service/observability#logs service/observability#traces: a pull request check that applies a publish gets 403, and the line and the root span hold the check', async () => {
    const token = await issuer.github({ ...CANARY, environment: undefined, sub: 'repo:example/test-app:pull_request' });

    expect(who(await recorded(send(instance(), PUBLISH, token)))).toEqual({
      status: 403,
      userId: 'repo:example/test-app:pull_request',
      callerKind: 'check',
      'user.id': 'repo:example/test-app:pull_request',
      'caller.kind': 'check',
    });
  });

  it('service/observability#logs service/observability#traces: a service user that asks for an unknown Ontology gets 404, and the line and the root span hold the service user', async () => {
    const path = '/api/v2/ontologies/ri.ontology.main.ontology.unknown/objectSets/loadObjects';

    expect(who(await recorded(send(instance(), path, await issuer.m2m(CANARY))))).toEqual({
      status: 404,
      userId: SERVICE_USER,
      callerKind: 'service',
      'user.id': SERVICE_USER,
      'caller.kind': 'service',
    });
  });
});

describe('a request with no known caller kind', () => {
  const NONE = { userId: undefined, callerKind: undefined, 'user.id': undefined, 'caller.kind': undefined };

  it('service/observability#logs service/observability#traces: a request with no token gets 401 with no caller kind', async () => {
    expect(who(await recorded(send(instance(), LOAD_OBJECTS, undefined)))).toEqual({ status: 401, ...NONE });
  });

  it('service/observability#logs service/observability#traces: a person token signed by another key gets 401 with no caller kind', async () => {
    expect(
      who(await recorded(send(instance(), LOAD_OBJECTS, await issuer.workos(CANARY, { key: 'stranger' })))),
    ).toEqual({ status: 401, ...NONE });
  });

  it('service/observability#logs service/observability#traces: a signed person token of another client ID gets 401 with no caller kind', async () => {
    expect(
      who(
        await recorded(send(instance(), LOAD_OBJECTS, await issuer.workos({ ...CANARY, client_id: 'client_other' }))),
      ),
    ).toEqual({ status: 401, ...NONE });
  });

  it('service/observability#logs service/observability#traces: an M2M token signed by another key gets 401 with no caller kind, and reads no WorkOS', async () => {
    const stub = workos();

    expect(
      who(await recorded(send(instance(stub), LOAD_OBJECTS, await issuer.m2m(CANARY, { key: 'stranger' })))),
    ).toEqual({ status: 401, ...NONE });

    expect(stub.requests).toEqual([]);
  });

  it('service/observability#logs service/observability#traces: a signed M2M token whose claims fail part 1 gets 401 with no caller kind', async () => {
    expect(
      who(await recorded(send(instance(), LOAD_OBJECTS, await issuer.m2m({ ...CANARY, sid: 'session_01' })))),
    ).toEqual({ status: 401, ...NONE });
  });

  it('service/observability#logs service/observability#traces: a signed GitHub token of another repository gets 401 with no caller kind', async () => {
    expect(
      who(
        await recorded(send(instance(), PUBLISH, await issuer.github({ ...CANARY, repository: 'example/other-app' }))),
      ),
    ).toEqual({ status: 401, ...NONE });
  });
});
