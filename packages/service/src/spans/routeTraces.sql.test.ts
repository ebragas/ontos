import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remoteKeys, type UserSource } from '../auth/index.ts';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { handle, type HandleInput, type Settings } from '../handler/index.ts';
import { isRouteKey, span, type FinishedSpan, type RouteKey } from './index.ts';
import { setupServer } from 'msw/node';
import { attempt, outsideFailure } from '../errors/index.ts';
import { stubAuthkitToken } from '../authkitToken.test-utils.ts';
import {
  account,
  insertObjects,
  ONTOLOGY_RID,
  startActions,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { NS, twinFunctions, twinIr, USE } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import {
  CANARY,
  checkRouteTraces,
  ROUTE_FIXTURES,
  routeSpans,
  routeTraceProblems,
  type FixtureInput,
} from '../routeHarness.test-utils.ts';
import { AUTHKIT_DOMAIN, createTestIssuer, PERSON, type TestIssuer } from '../tokens.test-utils.ts';
import { routeRecording, type SpanRecorder } from '../tracing.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const settings: Settings = {
  productRid: ONTOLOGY_RID,
  environment: 'test',
  auth: {
    workosClientId: 'actions',
    baseUrl: 'http://localhost',
    app: { repository: 'example/twin', environment: 'publish' },
  },
  authkitDomain: AUTHKIT_DOMAIN,
  mcp: true,
};

const users = roleUsers({ member: [USE, 'ontology:install'] });

const recorder = (): SpanRecorder => {
  if (routeRecording.recorder === undefined) throw new Error('The setup file of the sql project records the spans.');

  return routeRecording.recorder;
};

function servedKeys(issuer: TestIssuer): HandleInput['keys'] {
  const jwks = (url: string) =>
    url.endsWith('/oauth2/jwks')
      ? issuer.jwks.authkit
      : url.endsWith('/.well-known/jwks')
        ? issuer.jwks.github
        : issuer.jwks.workos;

  const urlText = (input: string | URL | Request): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  return remoteKeys(settings.auth, {
    authkitDomain: AUTHKIT_DOMAIN,
    fetch: recorder().guard((url) => Promise.resolve(Response.json(jwks(urlText(url))))),
  });
}

let service: ActionsService;
let input: HandleInput;
let fixtureInput: FixtureInput;

const network = setupServer();

beforeAll(async () => {
  network.resetHandlers(stubAuthkitToken().handler);

  network.listen({ onUnhandledRequest: 'error' });

  service = await startActions(twinIr('0.6.3'), twinFunctions('0.6.3'));

  const issuer = await createTestIssuer(settings.auth);

  input = {
    db: fallibleOf(service.db),
    directDb: fallibleOf(service.db),
    settings,
    keys: servedKeys(issuer),
    users,
    workos: stubPublish(),
  };

  const person = await issuer.workos({ sid: CANARY });

  const described = await handle(
    new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/actionTypes/${NS}create-account`, {
      headers: { authorization: `Bearer ${person}` },
    }),
    input,
  );

  const { rid } = (await described.json()) as { rid: string };

  fixtureInput = {
    person,
    publish: await issuer.github({ sid: CANARY }),
    mcp: await issuer.authkit({ sid: CANARY }),
    actionTypeRid: rid,
  };
});

afterAll(async () => {
  network.close();

  await service.stop();
});

const roots = (spans: readonly FinishedSpan[]) =>
  spans.filter((span) => span.parentSpanId === undefined || isRouteKey(span.name));

describe('the trace of each route', () => {
  it.each(Object.entries(ROUTE_FIXTURES) as [RouteKey, (typeof ROUTE_FIXTURES)[RouteKey]][])(
    'service/observability#traces: %s records 1 trace with 1 root named by its route key, only spans of the catalog, and no CANARY value',
    async (key, fixture) => {
      const response = await handle(fixture.request(fixtureInput), input);

      const text = await response.text();

      expect({ status: response.status, text }).toEqual({ status: fixture.status, text: expect.any(String) });

      const spans = await routeSpans();

      expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
      expect(roots(spans).map((span) => span.name)).toEqual([key]);
      expect(routeTraceProblems(spans)).toEqual([]);
    },
  );

  it('service/observability#traces: a request with traceparent adopts the trace and passes routeTraceProblems with zero CANARY leaks', async () => {
    const key: RouteKey = 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply';
    const request = ROUTE_FIXTURES[key].request(fixtureInput);

    request.headers.set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');

    const response = await handle(request, input);

    await response.text();

    const spans = await routeSpans();

    const [root] = spans.filter((span) => span.name === key);

    expect(root?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(root?.parentSpanId).toBe('b7ad6b7169203331');
    expect(root?.attributes['action.api_name']).toBe(`${NS}create-account`);
    expect(routeTraceProblems(spans)).toEqual([]);
  });
});

function recordingDb(db: Db, texts: string[]): Db {
  const record = (inner: Db): Db => ({
    query: (statement: Sql) => (texts.push(statement.text), inner.query(statement)),
    stream: (statement: Sql) => (texts.push(statement.text), inner.stream(statement)),
    transaction: (run) => inner.transaction((tx) => run(record(tx))),
    snapshot: (run) => (texts.push('snapshot'), inner.snapshot(run)),
  });

  return record(db);
}

describe('the direct connection', () => {
  it('service/code-layout#seams: of the requests of each route, only the publish route runs a statement on the direct connection', async () => {
    const used: string[] = [];

    for (const [key, fixture] of Object.entries(ROUTE_FIXTURES) as [RouteKey, (typeof ROUTE_FIXTURES)[RouteKey]][]) {
      const texts: string[] = [];

      const response = await handle(fixture.request(fixtureInput), {
        ...input,
        directDb: fallibleOf(recordingDb(service.db, texts)),
      });

      await response.text();

      expect({ key, refused: [401, 403].includes(response.status) || response.status >= 500 }).toEqual({
        key,
        refused: false,
      });

      if (texts.length > 0) used.push(key);
    }

    await routeSpans();

    expect(used).toEqual(['POST /api/ontology-service/v1/publish']);
  });
});

describe('the attributes of the root span', () => {
  const rootOf = async (key: RouteKey) => {
    const response = await handle(ROUTE_FIXTURES[key].request(fixtureInput), input);

    await response.text();

    return roots(await routeSpans())[0]?.attributes;
  };

  it('the root of an ontology route holds the route key, the access kind, the status, the Ontology version, and the user ID', async () => {
    expect(await rootOf('GET /api/v2/ontologies/{ontology}/objectTypes')).toEqual({
      'route.key': 'GET /api/v2/ontologies/{ontology}/objectTypes',
      'route.access': 'ontology',
      'sentry.op': 'http.server',
      'user.id': PERSON,
      'caller.kind': 'person',
      'ontology.version': 1,
      'http.status_code': 200,
    });
  });

  it('the root of a users route holds the route key, the access kind, the status, and the user ID', async () => {
    expect(await rootOf('GET /api/v2/admin/users/getCurrent')).toEqual({
      'route.key': 'GET /api/v2/admin/users/getCurrent',
      'route.access': 'users',
      'sentry.op': 'http.server',
      'user.id': PERSON,
      'caller.kind': 'person',
      'http.status_code': 200,
    });
  });

  it('the root of an MCP tools/call also holds the JSON-RPC method and the tool', async () => {
    expect(await rootOf('POST /api/mcp')).toEqual({
      'route.key': 'POST /api/mcp',
      'route.access': 'mcp',
      'sentry.op': 'http.server',
      'user.id': PERSON,
      'caller.kind': 'person',
      'mcp.method.name': 'tools/call',
      'mcp.tool.name': 'load_objects',
      'ontology.version': 1,
      'http.status_code': 200,
    });
  });
});

describe('the root span of an answer with no body', () => {
  it('service/observability#traces: an MCP notification gets 202 with no body, and its root ends when handle returns, with no response.body child', async () => {
    const response = await handle(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${fixtureInput.mcp}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
      input,
    );

    expect({ status: response.status, body: response.body }).toEqual({ status: 202, body: null });

    const spans = await routeSpans();

    expect(spans.map((span) => [span.name, span.attributes['mcp.method.name']])).toEqual([
      ['token check', undefined],
      ['POST /api/mcp', 'notifications/initialized'],
    ]);
  });
});

describe('the root span of a streamed loadObjects body', () => {
  beforeAll(async () => {
    await service.clear();

    await insertObjects(service.db, ACCOUNT, [
      account('acc-1', 'Acme', 'customer'),
      account('acc-2', 'Globex', 'prospect'),
      account('acc-3', 'Initech', 'customer'),
    ]);
  });

  const loadAll = (db: Db = service.db) =>
    handle(
      new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/objectSets/loadObjects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fixtureInput.person}`, 'content-type': 'application/json' },
        body: JSON.stringify({ objectSet: { type: 'base', objectType: ACCOUNT } }),
      }),
      { ...input, db: fallibleOf(db) },
    );

  const lifetime = async () => {
    const spans = await routeSpans();

    const [root] = roots(spans);
    const body = spans.find((span) => span.name === 'response.body');

    return {
      parent: body?.parentSpanId === root?.spanId,
      rootEndsAfterBody: root !== undefined && body !== undefined && root.end >= body.end,
      bodyStatus: body?.status.code,
    };
  };

  it('service/observability#traces: a body that ends ends the root after its response.body child', async () => {
    const response = await loadAll();

    expect((JSON.parse(await response.text()) as { data: unknown[] }).data).toHaveLength(3);

    expect(await lifetime()).toEqual({ parent: true, rootEndsAfterBody: true, bodyStatus: SpanStatusCode.UNSET });
  });

  it('service/observability#traces: a body that errors ends the root after its response.body child', async () => {
    const failing: Db = {
      ...service.db,
      stream: <Row extends object>(statement: Sql) => failAfterFirst(service.db.stream<Row>(statement)),
    };

    const response = await loadAll(failing);

    expect(response.status).toBe(200);

    await expect(response.text()).rejects.toThrow();

    expect(await lifetime()).toEqual({ parent: true, rootEndsAfterBody: true, bodyStatus: SpanStatusCode.ERROR });
  });

  it('service/observability#traces: a body that the caller cancels ends the root after its response.body child', async () => {
    await bodyOf(await loadAll()).cancel();

    expect(await lifetime()).toEqual({ parent: true, rootEndsAfterBody: true, bodyStatus: SpanStatusCode.UNSET });
  });

  it('service/observability#traces: a body that the caller cancels during a pending read ends the root after its children, in each of 50 runs', async () => {
    const RUNS = 50;

    for (let run = 0; run < RUNS; run += 1) {
      const reader = bodyOf(await loadAll()).getReader();

      const pending = reader.read();

      await reader.cancel();

      await pending;
    }

    const spans = await routeSpans();

    expect({ roots: roots(spans).length, problems: routeTraceProblems(spans) }).toEqual({ roots: RUNS, problems: [] });
  });
});

function bodyOf(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new Error('The answer has no body.');

  return response.body;
}

describe('the fetch stub of the route tests', () => {
  const answer = () => Promise.resolve(Response.json({}));

  it('service/observability#traces: a fetch during a request with no active span other than the root fails the trace check after the test', async () => {
    const bare = recorder().guard(answer);

    const unspanned: UserSource = {
      ...users,
      get: () =>
        attempt(async () => void (await bare('https://api.workos.com/user_management/users/user_1')), outsideFailure),
    };

    const response = await handle(ROUTE_FIXTURES['GET /api/v2/admin/users/getCurrent'].request(fixtureInput), {
      ...input,
      users: unspanned,
    });

    expect({ status: response.status, text: await response.text() }).toEqual({ status: 500, text: expect.any(String) });

    expect(recorder().strayFetches()).toEqual([
      'GET /api/v2/admin/users/getCurrent: a fetch ran with no active span other than the root',
    ]);

    await expect(checkRouteTraces(recorder())).rejects.toThrow('to deeply equal []');
  });

  it('service/observability#traces: a fetch outside a request passes', async () => {
    expect((await recorder().guard(answer)('https://api.workos.com/user_management/users/user_1')).status).toBe(200);

    expect(recorder().strayFetches()).toEqual([]);
  });

  it('service/observability#traces: a fetch in a span with no parent that is not the root of a request passes, as a WorkOS read outside a request', async () => {
    const read = () => recorder().guard(answer)('https://api.workos.com/user_management/users/user_1');

    expect((await span('workos read', { 'workos.read': 'user' }, read)).status).toBe(200);

    expect(recorder().strayFetches()).toEqual([]);
  });
});

async function* failAfterFirst<Row>(rows: AsyncIterable<Row>): AsyncGenerator<Row> {
  for await (const row of rows) {
    yield row;

    throw new Error('the stream failed');
  }
}
