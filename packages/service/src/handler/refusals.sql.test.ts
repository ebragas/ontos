import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import pg from 'pg';
import type { OntologyIr } from '@osdk/client.unstable';
import { handle, handleTrusted, routes, type HandleInput, type RouteAnswer } from './index.ts';
import { startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { createPool, quoteName } from '../db/index.ts';
import { ENGINE_CHANGES_LOCK } from '../db/engineChanges.ts';
import { tableName, type CompiledOntology } from '../ontology/index.ts';
import {
  compileOrThrow,
  irOf,
  NS,
  ONTOLOGY_RID,
  stored,
  twinBlock,
  twinFunctions,
} from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { newDatabase, waitForLockWaits, type TestDatabase } from '../publish/publish.test-utils.ts';
import {
  handlerDb,
  TEST_ONTOLOGY_RID,
  TEST_READER,
  testMcpSettings,
  testSettings,
  timeLeft,
  trustedSnapshot,
} from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, PERSON } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { workosUsers } from '../auth/index.ts';
import { WORKOS_API } from '../auth/users.ts';
import { actionType, addRule, parameterValue, staticString } from '../actions/actions.test-utils.ts';
import { fallibleOf, promiseOf } from '../db/promise.test-utils.ts';
import { INTERFACE_IR, LATER_SET, LISTED_SET, storeVersion } from '../publish/releasesSupport.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const deadPool = createPool('postgresql://ontology_service:direct@127.0.0.1:1/neondb');
const deadDb = handlerDb(deadPool);

function probeIr(): OntologyIr {
  const ir = irOf(twinBlock('0.6.3', ACCOUNT));

  const probe = actionType(
    `${NS}probe`,
    {
      id: {
        type: { type: 'string', string: {} },
        allowedValues: { type: 'text', text: { type: 'text', text: {} } },
        required: { type: 'required', required: {} },
      },
    },
    [addRule(ACCOUNT, { accountId: parameterValue('id'), name: staticString('Probe') })],
  );

  ir.ontology.actionTypes = { [`${NS}probe`]: probe };

  return ir;
}

let postgres: TestPostgres;
let empty: TestDatabase;
let installed: InstalledOntology | undefined;
let ontology: CompiledOntology;
let input: HandleInput;
let workos: string;
let authkit: string;

const network = setupServer(
  http.post(`https://${testMcpSettings.authkitDomain}/oauth2/token`, () =>
    HttpResponse.json({ error: 'invalid_client' }, { status: 401 }),
  ),
);

beforeAll(async () => {
  network.listen({ onUnhandledRequest: 'error' });

  postgres = await startPostgres();

  empty = await newDatabase(postgres.url, { empty: true });

  const issuer = await createTestIssuer(testSettings.auth);

  input = {
    db: fallibleOf(empty.db),
    directDb: fallibleOf(empty.db),
    settings: testMcpSettings,
    keys: issuer.keys,
    users: roleUsers({}),
    workos: stubPublish(),
    reportFault: (error, fields) =>
      void faults.push({ message: error instanceof Error ? error.message : String(error), ...stable({ ...fields }) }),
  };

  workos = await issuer.workos();

  authkit = await issuer.authkit();
});

afterAll(async () => {
  network.close();

  await deadPool.end();

  await installed?.stop();

  await empty?.end();

  await postgres?.stop();
});

async function install(): Promise<void> {
  const ir = probeIr();

  installed = await startInstalled(ir, { ...twinFunctions('0.4.0'), discovered: [] });

  ontology = compileOrThrow(stored(ir));

  input = {
    ...input,
    db: installed.input.db,
    directDb: installed.input.directDb,
    users: installed.input.users,
    workos: installed.input.workos,
  };
}

const faults: unknown[] = [];

function stable(fields: Record<string, unknown>): Record<string, unknown> {
  const { errorInstanceId, traceId, rootSpanId, stack, ...rest } = fields;

  void [errorInstanceId, traceId, rootSpanId];

  return { ...rest, ...(typeof stack === 'string' ? { stack: stack.split('\n')[0] } : {}) };
}

async function seen(send: () => Promise<Response>): Promise<unknown> {
  faults.length = 0;

  const log = vi.spyOn(console, 'log');

  try {
    const response = await send();

    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));

    const body = (await response.text())
      .replace(/"errorInstanceId":"[^"]*"/g, '"errorInstanceId":"?"')
      .replace(/\\"errorInstanceId\\":\\"[^"\\]*\\"/g, '\\"errorInstanceId\\":\\"?\\"');

    const lines = log.mock.calls.map(([line]) => stable(JSON.parse(String(line)) as Record<string, unknown>));

    return { status: response.status, headers, body, lines, faults: [...faults] };
  } finally {
    log.mockRestore();
  }
}

const FOUNDRY = `/api/v2/ontologies/${ONTOLOGY_RID}`;

function request(
  method: string,
  path: string,
  {
    token,
    body,
    signal,
  }: { readonly token?: string; readonly body?: string; readonly signal?: AbortSignal | undefined } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(signal === undefined ? {} : { signal }),
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    ...(body === undefined ? {} : { body }),
  });
}

const toolCall = (name: string, args: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function trusted(request: Request): Promise<Response> {
  return promiseOf(input.db).snapshot((db) =>
    handleTrusted(request, {
      db: trustedSnapshot(db),
      reader: TEST_READER,
      ontology,
      caller: { user: PERSON, kind: 'person', organization: ORGANIZATION, permissions: [] },
      checkWrite: timeLeft,
    }),
  );
}

async function checkWriteAnswer(during: () => void, signal?: AbortSignal): Promise<unknown> {
  const users: HandleInput['users'] = {
    ...input.users,
    permissions: (...args) => {
      during();

      return input.users.permissions(...args);
    },
  };

  return await seen(() =>
    handle(
      request('POST', `${FOUNDRY}/actions/${NS}probe/apply`, {
        token: workos,
        body: '{"parameters":{"id":"a-1"}}',
        signal,
      }),
      { ...input, users },
    ),
  );
}

async function withAccountsMoved<T>(run: () => Promise<T>): Promise<T> {
  const name = tableName(ACCOUNT);
  const sql = (text: string) => promiseOf(input.db).query({ text, values: [] });

  await sql(`ALTER TABLE ontology_1_objects.${quoteName(name)} RENAME TO ${quoteName(`${name}_moved`)}`);

  try {
    return await run();
  } finally {
    await sql(`ALTER TABLE ontology_1_objects.${quoteName(`${name}_moved`)} RENAME TO ${quoteName(name)}`);
  }
}

async function whenItYields(
  failure: undefined | null,
  method: string,
  path: string,
  send: () => Promise<Response>,
): Promise<unknown> {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);

  if (!route) throw new Error(`The route table has no route ${method} ${path}.`);

  // oxlint-disable-next-line landmines/no-test-doubles -- A route that yields null or undefined, which the types forbid: no real route does.
  const spy = vi
    .spyOn(route as { run: (...args: never[]) => RouteAnswer }, 'run')
    .mockImplementation(async function* (): AsyncGenerator<never, never, never> {
      return yield failure as never;
    });

  try {
    return await seen(send);
  } finally {
    spy.mockRestore();
  }
}

describe('service/storage#engine-changes: a failed cold start', () => {
  it('in an MCP tool call', async () => {
    expect(
      await seen(() =>
        handle(
          request('POST', '/api/mcp', { token: authkit, body: toolCall('load_objects', { objectType: ACCOUNT }) }),
          { ...input, directDb: fallibleOf(promiseOf(deadDb)) },
        ),
      ),
    ).toMatchSnapshot();
  });

  it('before an ontology route', async () => {
    expect(
      await seen(() =>
        handle(request('GET', `${FOUNDRY}/fullMetadata`, { token: workos }), {
          ...input,
          directDb: fallibleOf(promiseOf(deadDb)),
        }),
      ),
    ).toMatchSnapshot();
  });

  it('2 tool calls at the same time: the second joins the run of the first, and 1 line names the failure', async () => {
    const holder = new pg.Client({ connectionString: empty.url });

    await holder.connect();

    await holder.query('SELECT pg_advisory_lock($1)', [ENGINE_CHANGES_LOCK]);

    const pool = createPool(empty.url);
    let reads = 0;

    const users: HandleInput['users'] = {
      ...input.users,
      permissions: (...args) => {
        reads += 1;

        return input.users.permissions(...args);
      },
    };

    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');

    try {
      const send = () =>
        handle(
          request('POST', '/api/mcp', { token: authkit, body: toolCall('load_objects', { objectType: ACCOUNT }) }),
          { ...input, directDb: fallibleOf(promiseOf(handlerDb(pool))), users },
        );

      const answers = Promise.all([send(), send()]);

      await vi.waitFor(() => expect(reads).toBe(2));

      await waitForLockWaits(empty.db, 1);

      await holder.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );

      const errorNames = await Promise.all(
        (await answers).map(
          async (answer) =>
            ((await answer.json()) as { result: { structuredContent: { errorName: string } } }).result.structuredContent
              .errorName,
        ),
      );

      const errors = error.mock.calls.map(([message, failure]: unknown[]) => [
        message,
        failure instanceof Error ? failure.message : failure,
      ]);

      expect({ errorNames, errors }).toEqual({
        errorNames: ['OntologyService:EngineChangesFailed', 'OntologyService:EngineChangesFailed'],
        errors: [
          [
            'The cold start failed, so this request gets 503. The next request tries again.',
            'terminating connection due to administrator command',
          ],
        ],
      });
    } finally {
      error.mockRestore();

      log.mockRestore();

      await holder.end();

      await pool.end();
    }
  });
});

describe('service/code-layout#errors: the refusals of handle', () => {
  beforeAll(install);

  it('a body that is not JSON', async () => {
    expect(
      await seen(() =>
        handle(request('POST', `${FOUNDRY}/objectSets/loadObjects`, { token: workos, body: '{' }), input),
      ),
    ).toMatchSnapshot();
  });

  it('a query parameter outside V1', async () => {
    expect(
      await seen(() => handle(request('GET', `${FOUNDRY}/fullMetadata?branch=main`, { token: workos }), input)),
    ).toMatchSnapshot();
  });

  it('a publish by a person with no validateOnly', async () => {
    expect(
      await seen(() =>
        handle(request('POST', '/api/ontology-service/v1/publish', { token: workos, body: '{}' }), input),
      ),
    ).toMatchSnapshot();
  });

  it('a converted route that yields its ApiError', async () => {
    expect(
      await seen(() =>
        handle(request('POST', `${FOUNDRY}/objectSets/loadObjects`, { token: workos, body: '{"objectSet":5}' }), input),
      ),
    ).toMatchSnapshot();
  });

  it('a converted route that yields its DbFailure', async () => {
    const body = JSON.stringify({ objectSet: { type: 'base', objectType: ACCOUNT } });

    expect(
      await withAccountsMoved(() =>
        seen(() => handle(request('POST', `${FOUNDRY}/objectSets/loadObjects`, { token: workos, body }), input)),
      ),
    ).toMatchSnapshot();
  });

  it('an MCP tool call whose route yields its ApiError', async () => {
    expect(
      await seen(() =>
        handle(
          request('POST', '/api/mcp', { token: authkit, body: toolCall('load_objects', { objectType: 'missing' }) }),
          input,
        ),
      ),
    ).toMatchSnapshot();
  });

  it('an MCP request with no token', async () => {
    expect(
      await seen(() =>
        handle(request('POST', '/api/mcp', { body: toolCall('load_objects', { objectType: ACCOUNT }) }), input),
      ),
    ).toMatchSnapshot();
  });

  it('a token request with no client', async () => {
    const send = () =>
      handle(
        new Request('http://localhost/multipass/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        }),
        input,
      );

    expect(await seen(send)).toMatchSnapshot();
  });

  it('a write of a request that the client aborted', async () => {
    const controller = new AbortController();

    expect(await checkWriteAnswer(() => controller.abort(), controller.signal)).toMatchSnapshot();
  });

  it('a write with no time left before its deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      expect(await checkWriteAnswer(() => vi.setSystemTime(Date.now() + 120_000))).toMatchSnapshot();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an MCP tool call whose permissions read rejects', async () => {
    let reads = 0;

    network.use(
      http.all(`${WORKOS_API}/*`, () => {
        reads += 1;

        return new HttpResponse(null, { status: 401 });
      }),
    );

    try {
      const users = workosUsers('sk_test_refusals');

      expect(
        await seen(() =>
          handle(
            request('POST', '/api/mcp', { token: authkit, body: toolCall('load_objects', { objectType: ACCOUNT }) }),
            { ...input, users },
          ),
        ),
      ).toMatchInlineSnapshot(`
        {
          "body": "{"result":{"content":[{"type":"text","text":"{\\"errorCode\\":\\"INTERNAL\\",\\"errorName\\":\\"Default:Internal\\",\\"errorInstanceId\\":\\"?\\",\\"parameters\\":{}}"}],"structuredContent":{"errorCode":"INTERNAL","errorName":"Default:Internal","errorInstanceId":"?","parameters":{}},"isError":true},"jsonrpc":"2.0","id":1}",
          "faults": [
            {
              "callerKind": "person",
              "errorName": "Default:Internal",
              "mcp": {
                "clientId": "https://claude.ai/.well-known/oauth-client-metadata.json",
                "method": "tools/call",
                "tool": "load_objects",
              },
              "message": "WorkOS answered 401 to the membership read.",
              "route": "POST /api/mcp",
              "userId": "user_01TEST00000000000000000001",
            },
          ],
          "headers": {
            "content-type": "application/json",
          },
          "lines": [
            {
              "callerKind": "person",
              "errorName": "Default:Internal",
              "mcp": {
                "clientId": "https://claude.ai/.well-known/oauth-client-metadata.json",
                "method": "tools/call",
                "protocolVersion": "2025-11-25",
                "tool": "load_objects",
              },
              "parameters": {},
              "route": "POST /api/mcp",
              "routeParams": {},
              "stack": "Error: WorkOS answered 401 to the membership read.",
              "userId": "user_01TEST00000000000000000001",
            },
          ],
          "status": 200,
        }
      `);

      expect(reads).toBeGreaterThan(0);
    } finally {
      network.resetHandlers();
    }
  });

  it('a path with a segment that does not decode', async () => {
    expect(
      await seen(() => handle(request('GET', '/api/v2/ontologies/%E0%A4%A/fullMetadata', { token: workos }), input)),
    ).toMatchInlineSnapshot(`
      {
        "body": "",
        "faults": [],
        "headers": {},
        "lines": [
          {},
        ],
        "status": 404,
      }
    `);
  });
});

describe('service/code-layout#errors: a route that yields a value that is not a failure, a defect', () => {
  it('an ontology route', async () => {
    const path = '/api/v2/ontologies/{ontology}/fullMetadata';

    expect(
      await whenItYields(undefined, 'GET', path, () =>
        handle(request('GET', `${FOUNDRY}/fullMetadata`, { token: workos }), input),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": "{"errorCode":"INTERNAL","errorName":"Default:Internal","errorInstanceId":"?","parameters":{}}",
        "faults": [
          {
            "callerKind": "person",
            "errorName": "Default:Internal",
            "message": "Cannot read properties of undefined (reading 'error')",
            "ontologyVersion": 1,
            "route": "GET /api/v2/ontologies/{ontology}/fullMetadata",
            "userId": "user_01TEST00000000000000000001",
          },
        ],
        "headers": {
          "content-type": "application/json",
        },
        "lines": [
          {
            "callerKind": "person",
            "errorName": "Default:Internal",
            "ontologyVersion": 1,
            "parameters": {},
            "route": "GET /api/v2/ontologies/{ontology}/fullMetadata",
            "routeParams": {
              "ontology": "ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01",
            },
            "stack": "TypeError: Cannot read properties of undefined (reading 'error')",
            "userId": "user_01TEST00000000000000000001",
          },
        ],
        "status": 500,
      }
    `);
  });

  it('the token route', async () => {
    const send = () =>
      handle(
        new Request('http://localhost/multipass/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        }),
        input,
      );

    expect(await whenItYields(null, 'POST', '/multipass/api/oauth2/token', send)).toMatchInlineSnapshot(`
      {
        "body": "{"error":"server_error"}",
        "faults": [
          {
            "errorName": "Default:Internal",
            "message": "Cannot read properties of null (reading 'error')",
            "route": "POST /multipass/api/oauth2/token",
          },
        ],
        "headers": {
          "cache-control": "no-store",
          "content-type": "application/json",
          "pragma": "no-cache",
        },
        "lines": [
          {
            "errorName": "Default:Internal",
            "parameters": {},
            "route": "POST /multipass/api/oauth2/token",
            "routeParams": {},
            "stack": "TypeError: Cannot read properties of null (reading 'error')",
          },
        ],
        "status": 500,
      }
    `);
  });

  it('the route of an MCP tool call', async () => {
    const path = '/api/v2/ontologies/{ontology}/objectSets/loadObjects';

    expect(
      await whenItYields(undefined, 'POST', path, () =>
        handle(
          request('POST', '/api/mcp', { token: authkit, body: toolCall('load_objects', { objectType: ACCOUNT }) }),
          input,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": "{"result":{"content":[{"type":"text","text":"{\\"errorCode\\":\\"INTERNAL\\",\\"errorName\\":\\"Default:Internal\\",\\"errorInstanceId\\":\\"?\\",\\"parameters\\":{}}"}],"structuredContent":{"errorCode":"INTERNAL","errorName":"Default:Internal","errorInstanceId":"?","parameters":{}},"isError":true},"jsonrpc":"2.0","id":1}",
        "faults": [
          {
            "callerKind": "person",
            "errorName": "Default:Internal",
            "mcp": {
              "clientId": "https://claude.ai/.well-known/oauth-client-metadata.json",
              "method": "tools/call",
              "tool": "load_objects",
            },
            "message": "Cannot read properties of undefined (reading 'error')",
            "ontologyVersion": 1,
            "route": "POST /api/v2/ontologies/{ontology}/objectSets/loadObjects",
            "userId": "user_01TEST00000000000000000001",
          },
        ],
        "headers": {
          "content-type": "application/json",
        },
        "lines": [
          {
            "callerKind": "person",
            "errorName": "Default:Internal",
            "mcp": {
              "clientId": "https://claude.ai/.well-known/oauth-client-metadata.json",
              "method": "tools/call",
              "protocolVersion": "2025-11-25",
              "tool": "load_objects",
            },
            "ontologyVersion": 1,
            "parameters": {},
            "route": "POST /api/v2/ontologies/{ontology}/objectSets/loadObjects",
            "routeParams": {
              "ontology": "ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01",
            },
            "stack": "TypeError: Cannot read properties of undefined (reading 'error')",
            "userId": "user_01TEST00000000000000000001",
          },
        ],
        "status": 200,
      }
    `);
  });

  it('a route of handleTrusted', async () => {
    const path = '/api/v2/ontologies/{ontology}/objectSets/loadObjects';

    const send = () =>
      trusted(
        new Request(`https://ontology-service.invalid${FOUNDRY}/objectSets/loadObjects`, {
          method: 'POST',
          body: '{}',
        }),
      );

    expect(await whenItYields(null, 'POST', path, send)).toMatchInlineSnapshot(`
      {
        "body": "{"errorCode":"INTERNAL","errorName":"Default:Internal","errorInstanceId":"?","parameters":{}}",
        "faults": [],
        "headers": {
          "content-type": "application/json",
        },
        "lines": [
          {
            "errorName": "Default:Internal",
            "parameters": {},
            "route": "POST /api/v2/ontologies/{ontology}/objectSets/loadObjects",
            "routeParams": {
              "ontology": "ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01",
            },
            "stack": "TypeError: Cannot read properties of null (reading 'error')",
          },
        ],
        "status": 500,
      }
    `);
  });

  it('an ontology route whose run returns neither a Promise nor a generator', async () => {
    const route = routes.find(
      (candidate) => candidate.method === 'GET' && candidate.path === '/api/v2/ontologies/{ontology}/fullMetadata',
    );

    if (!route) throw new Error('The route table has no route GET /api/v2/ontologies/{ontology}/fullMetadata.');

    // oxlint-disable-next-line landmines/no-test-doubles -- A route answer of unknown shape: no real route returns one.
    const spy = vi.spyOn(route as { run: (...args: never[]) => unknown }, 'run').mockImplementation(() => ({}));

    try {
      const answer = (await seen(() =>
        handle(request('GET', `${FOUNDRY}/fullMetadata`, { token: workos }), input),
      )) as {
        status: number;
        body: string;
        lines: { errorName: string; stack: string }[];
        faults: { errorName: string }[];
      };

      expect(answer.status).toBe(500);
      expect(answer.body).toContain('Default:Internal');

      expect(answer.lines.map((line) => [line.errorName, line.stack.startsWith('TypeError: ')])).toEqual([
        ['Default:Internal', true],
      ]);

      expect(answer.lines[0]?.stack).toContain('run.next');
      expect(answer.faults.map((fault) => fault.errorName)).toEqual(['Default:Internal']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('service/code-layout#errors: the refusals of handleTrusted', () => {
  it('a route with writes', async () => {
    expect(
      await seen(() =>
        trusted(
          new Request(`https://ontology-service.invalid${FOUNDRY}/actions/probe/apply`, { method: 'POST', body: '{}' }),
        ),
      ),
    ).toMatchSnapshot();
  });

  it('a route that is not an ontology route', async () => {
    expect(
      await seen(() => trusted(new Request('https://ontology-service.invalid/api/v2/ontologies'))),
    ).toMatchSnapshot();
  });

  it('another Ontology', async () => {
    expect(
      await seen(() =>
        trusted(
          new Request(
            'https://ontology-service.invalid/api/v2/ontologies/ri.ontology.main.ontology.other/fullMetadata',
          ),
        ),
      ),
    ).toMatchSnapshot();
  });

  it('a query parameter outside V1', async () => {
    expect(
      await seen(() => trusted(new Request(`https://ontology-service.invalid${FOUNDRY}/fullMetadata?scenarioRid=s`))),
    ).toMatchSnapshot();
  });

  it('a body that is not JSON', async () => {
    expect(
      await seen(() =>
        trusted(
          new Request(`https://ontology-service.invalid${FOUNDRY}/objectSets/loadObjects`, {
            method: 'POST',
            body: '{',
          }),
        ),
      ),
    ).toMatchSnapshot();
  });

  it('a converted route that yields its ApiError', async () => {
    expect(
      await seen(() =>
        trusted(
          new Request(`https://ontology-service.invalid${FOUNDRY}/objectSets/loadObjects`, {
            method: 'POST',
            body: '{"objectSet":5}',
          }),
        ),
      ),
    ).toMatchSnapshot();
  });
});

describe('service/releases#compatibility-with-earlier-releases: a stored version that this release does not support', () => {
  let stale: TestDatabase;

  beforeAll(async () => {
    stale = await newDatabase(postgres.url);
  });

  afterAll(() => stale?.end());

  const staleInput = (): HandleInput => ({ ...input, db: fallibleOf(stale.db), directDb: fallibleOf(stale.db) });

  it('an OSDK set that the release does not list, on an ontology route', async () => {
    await storeVersion(stale.db, 1, LATER_SET);

    expect(
      await seen(() =>
        handle(request('GET', `/api/v2/ontologies/${TEST_ONTOLOGY_RID}/fullMetadata`, { token: workos }), staleInput()),
      ),
    ).toMatchSnapshot();
  });

  it('an IR that does not compile, on an ontology route', async () => {
    await storeVersion(stale.db, 2, LISTED_SET, INTERFACE_IR);

    expect(
      await seen(() =>
        handle(request('GET', `/api/v2/ontologies/${TEST_ONTOLOGY_RID}/fullMetadata`, { token: workos }), staleInput()),
      ),
    ).toMatchSnapshot();
  });

  it('an IR that does not compile, on the permission catalog', async () => {
    expect(
      await seen(() =>
        handle(
          request('GET', `/api/ontology-service/v1/ontologies/${TEST_ONTOLOGY_RID}/permissions`, { token: workos }),
          staleInput(),
        ),
      ),
    ).toMatchSnapshot();
  });

  it('an Ontology that the Organization does not have, on the permission catalog', async () => {
    expect(
      await seen(() =>
        handle(
          request('GET', '/api/ontology-service/v1/ontologies/ri.ontology.main.ontology.other/permissions', {
            token: workos,
          }),
          staleInput(),
        ),
      ),
    ).toMatchSnapshot();
  });
});
