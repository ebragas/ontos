import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { JWTVerifyGetKey } from 'jose';
import {
  ACCOUNT,
  CREATE_ACCOUNT,
  LOAD_ACCOUNTS,
  publishBody,
  startInstalled,
  type Installed,
} from './installed.test-utils.ts';
import { remoteKeys } from './index.ts';
import { workosServer } from './workosServer.test-utils.ts';
import { createPool } from '../db/index.ts';
import { handle, routes, type HandleInput } from '../handler/index.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { newDatabase, type TestDatabase } from '../publish/publish.test-utils.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import { handlerDb, testInput, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { routeRecording, settle, type SpanRecorder } from '../tracing.test-utils.ts';
import { stubUsers } from '../workos.test-utils.ts';
import { fallibleOf, promiseOf } from '../db/promise.test-utils.ts';

const answerWorkos = workosServer();
const base = 'http://localhost';
const rid = TEST_ONTOLOGY_RID;
const tokenRoutes = routes.filter((route) => route.access !== 'public');
const foundryRoutes = routes.filter((route) => route.access === 'ontology' || route.access === 'publish');
let issuer: TestIssuer;
let installed: Installed;
let postgres: TestPostgres;
let empty: TestDatabase;
let closed: TestDatabase;
let wrongPassword: ReturnType<typeof createPool>;
let input: HandleInput;
let personToken: string;
let publishToken: string;
let recorder: SpanRecorder;
let consoleLog: MockInstance<typeof console.log>;
const faults: unknown[] = [];

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, 'jobsite:read');

  if (routeRecording.recorder === undefined) throw new Error('The sql project setup records the spans.');

  recorder = routeRecording.recorder;

  input = {
    ...testInput,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: stubUsers(undefined, undefined, { roles: { [ORGANIZATION]: { member: ['jobsite:read'] } } }),
    reportFault: (error) => void faults.push(error),
  };

  personToken = await issuer.workos();

  publishToken = await issuer.github();

  postgres = await startPostgres();

  empty = await newDatabase(postgres.url, { empty: true });

  closed = await newDatabase(postgres.url);

  await closed.end();

  const url = new URL(postgres.url);

  url.password = 'a-wrong-password';

  wrongPassword = createPool(url.toString());

  for (const accountId of ['acc-1', 'acc-2', 'acc-3']) {
    const created = await send('POST', `/api/v2/ontologies/{ontology}/actions/${CREATE_ACCOUNT}/apply`, undefined, {
      parameters: { accountId, name: accountId, phase: 'prospect' },
    });

    if (created.status !== 200)
      throw new Error(`The create-account Action gave ${created.status}: ${await created.text()}`);
  }
});

afterAll(async () => {
  await wrongPassword?.end();

  await empty?.end();

  await postgres?.stop();

  await installed?.stop();
});

beforeEach(() => {
  faults.length = 0;

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

function pathOf(template: string): string {
  const params: Readonly<Record<string, string>> = {
    ontology: rid,
    objectType: ACCOUNT,
    actionType: CREATE_ACCOUNT,
    action: CREATE_ACCOUNT,
  };

  return template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? 'x'));
}

function request(
  method: string,
  template: string,
  authorization: string | null = `Bearer ${personToken}`,
  body: unknown = {},
): Request {
  const headers: Record<string, string> = authorization === null ? {} : { authorization };

  return new Request(base + pathOf(template), {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

function send(
  method: string,
  template: string,
  authorization: string | null = `Bearer ${personToken}`,
  body: unknown = {},
  db: HandleInput['db'] = installed.db,
): Promise<Response> {
  return buffered(handle(request(method, template, authorization, body), { ...input, db, directDb: db }));
}

const CLOSE_ACCOUNT = 'com.example.twin.close-account-action';
const loadObjects = '/api/v2/ontologies/{ontology}/objectSets/loadObjects';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const internal = {
  errorCode: 'INTERNAL',
  errorName: 'Default:Internal',
  errorInstanceId: expect.stringMatching(UUID),
  parameters: {},
};

describe('service/http-api#errors: a fault of the Ontology service gets 500 Default:Internal', () => {
  it.each(foundryRoutes.map((route) => [route.method, route.path] as const))(
    'service/http-api#errors: a fault in %s %s gets 500 Default:Internal',
    async (method, path) => {
      const publishing = /\/publish$/.test(path);

      const response = await send(
        method,
        path,
        publishing ? `Bearer ${publishToken}` : undefined,
        publishing ? publishBody('jobsite:read') : {},
        fallibleOf(closed.db),
      );

      expect(response.status).toBe(500);

      expect(await response.json()).toEqual(internal);

      expect(faults.map(String)).toEqual(['Error: Cannot use a pool after calling end on the pool']);
    },
  );

  it('service/http-api#errors: the error body holds no text of the fault', async () => {
    const text = await (
      await send('POST', loadObjects, undefined, LOAD_ACCOUNTS, fallibleOf(promiseOf(handlerDb(wrongPassword))))
    ).text();

    expect(faults.map(String)).toEqual([`error: password authentication failed for user "${postgres.role}"`]);
    expect(text).not.toMatch(/password|ontology"/);
    expect(text).not.toContain(postgres.role);
  });
});

describe('service/observability#alerts: a fault gets 5xx, and an error of the caller gets 4xx', () => {
  it('service/observability#alerts: a database error gets 500 Default:Internal', async () => {
    const response = await send('POST', loadObjects, undefined, LOAD_ACCOUNTS, fallibleOf(empty.db));

    expect(response.status).toBe(500);

    expect(await response.json()).toEqual(internal);

    expect(faults).toEqual([expect.objectContaining({ code: '42P01' })]);
  });

  it('service/observability#alerts: a thrown value that is not an Error gets 500 Default:Internal', async () => {
    const response = await buffered(
      handle(request('POST', loadObjects, undefined, LOAD_ACCOUNTS), {
        ...input,
        keys: { ...issuer.keys, workos: () => Promise.reject('a string') },
      }),
    );

    expect(response.status).toBe(500);
    expect(faults).toEqual(['a string']);
  });

  it('service/observability#alerts: an OSDK error of the caller, such as a failed Function, keeps its 4xx', async () => {
    const response = await send('POST', `/api/v2/ontologies/{ontology}/actions/${CLOSE_ACCOUNT}/apply`, undefined, {
      parameters: { account: 'no-such-account' },
    });

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'FunctionExecutionFailed',
      errorInstanceId: expect.stringMatching(UUID),
      parameters: {
        functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
        functionVersion: '1.0.0',
        message: 'Object not found',
      },
    });
  });

  function jwks(response: () => Response): JWTVerifyGetKey {
    answerWorkos(response);

    return remoteKeys(testSettings.auth).workos;
  }

  it.each([
    ['a key source that rejects', (): JWTVerifyGetKey => () => Promise.reject(new TypeError('fetch failed'))],
    ['a JWKS URL that answers 503', () => jwks(() => new Response('', { status: 503 }))],
    ['a JWKS URL that answers with no JSON', () => jwks(() => new Response('<html>'))],
  ] as const)('service/observability#alerts: %s gets 500 Default:Internal, not 401', async (_case, workos) => {
    const response = await handle(
      new Request(base + loadObjects.replace('{ontology}', rid), {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.workos()}` },
        body: '{}',
      }),
      { ...input, keys: { ...issuer.keys, workos: workos() } },
    );

    expect(response.status).toBe(500);

    expect(await response.json()).toEqual(internal);
  });

  it.each([
    ['no token', null, 'MissingCredentials'],
    ['a token that fails a check', 'Bearer not-a-jwt', 'Default:Unauthorized'],
  ] as const)('service/observability#alerts: %s gets a 4xx, not a 5xx', async (_case, authorization, errorName) => {
    const response = await send('POST', loadObjects, authorization);

    expect(response.status).toBe(401);

    expect(await response.json()).toMatchObject({ errorName });
  });
});

describe('service/http-api#requests: the handler streams loadObjects, aggregate, and editsHistory', () => {
  it.each([
    ['POST', loadObjects, { ...LOAD_ACCOUNTS, pageSize: 3 }],
    [
      'POST',
      '/api/v2/ontologies/{ontology}/objectSets/aggregate',
      {
        objectSet: LOAD_ACCOUNTS.objectSet,
        groupBy: [{ type: 'exact', field: 'accountId' }],
        aggregation: [{ type: 'count', name: 'count' }],
      },
    ],
    ['POST', '/api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory', {}],
  ] as const)(
    'service/http-api#requests: %s %s gives its first bytes before the route ends the body',
    async (method, path, body) => {
      const response = await handle(request(method, path, undefined, body), input);

      expect(response.status).toBe(200);

      const reader = (response.body as ReadableStream<Uint8Array>).getReader();

      const first = new TextDecoder().decode((await reader.read()).value);

      await settle();

      const openRoots = () =>
        recorder.open().filter((span) => span.parentSpanId === undefined && span.name === `${method} ${path}`);

      expect({ first: /"data":\[/.test(first), open: openRoots().length }).toEqual({ first: true, open: 1 });

      let rest = '';

      for (let read = await reader.read(); !read.done; read = await reader.read())
        rest += new TextDecoder().decode(read.value);

      await settle();

      expect({ rest: rest.length > 0, open: openRoots().length }).toEqual({ rest: true, open: 0 });
      expect(JSON.parse(first + rest)).toMatchObject({ data: expect.arrayContaining([expect.anything()]) });
    },
  );
});

describe('service/ontology-service#contract: no response has a CORS header', () => {
  function corsHeaders(response: Response): string[] {
    return [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));
  }

  it.each(tokenRoutes.map((route) => [route.method, route.path] as const))(
    'service/ontology-service#contract: %s %s has no CORS header, from a browser origin',
    async (method, path) => {
      const template = path.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x');
      const init = method === 'POST' ? { body: '{}' } : {};

      const response = await buffered(
        handle(
          new Request(base + template, {
            method,
            headers: { authorization: `Bearer ${personToken}`, origin: 'https://app.example.com' },
            ...init,
          }),
          input,
        ),
      );

      expect(corsHeaders(response)).toEqual([]);
    },
  );

  it.each([
    ['an error', null],
    ['client-config', 'client-config'],
  ] as const)('service/ontology-service#contract: %s has no CORS header', async (_case, kind) => {
    const response =
      kind === 'client-config'
        ? await buffered(
            handle(
              new Request(`${base}/api/ontology-service/v1/client-config`, {
                headers: { origin: 'https://app.example.com' },
              }),
              input,
            ),
          )
        : await send('POST', loadObjects, null);

    expect(corsHeaders(response)).toEqual([]);
  });

  it('service/ontology-service#contract: a CORS preflight gets no CORS header', async () => {
    const response = await buffered(
      handle(
        new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
          method: 'OPTIONS',
          headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
        }),
        input,
      ),
    );

    expect(corsHeaders(response)).toEqual([]);
  });
});

describe('client-config needs no token, and gives the settings of the CLI', () => {
  it('service/cli#targets: GET client-config with no token gives the product RID, the WorkOS client ID, and the environment, and no Ontology RID', async () => {
    const response = await handle(new Request(`${base}/api/ontology-service/v1/client-config`), input);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);

    expect(await response.json()).toEqual({
      productRid: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000',
      workosClientId: 'client_test',
      environment: 'staging',
    });
  });

  it('client-config with a token that fails its checks still answers', async () => {
    const response = await buffered(
      handle(
        new Request(`${base}/api/ontology-service/v1/client-config`, {
          headers: { authorization: 'Bearer not-a-jwt' },
        }),
        input,
      ),
    );

    expect(response.status).toBe(200);
  });
});
