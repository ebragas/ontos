import { readdirSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { context, trace, TraceFlags, type ProxyTracerProvider } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { SamplingDecision, TraceIdRatioBasedSampler, type ReadableSpan } from '@opentelemetry/sdk-trace';
import * as Sentry from '@sentry/node';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { PostHog } from 'posthog-node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import { createPool } from '../db/index.ts';
import { handle, inputFromEnv, routes } from './index.ts';
import { ONTOLOGY_RID, startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { lintProbe } from '../lintProbe.test-utils.ts';
import { grantsOf, NS, twinIr } from '../ontology/stored.test-utils.ts';
import { roleMembers } from '../people.test-utils.ts';
import { insertObjects } from '../publish/publish.test-utils.ts';
import { readerOf } from '../service.test-utils.ts';
import {
  createTestIssuer,
  now,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  PERSON,
  MCP_CLIENT,
  type TestIssuer,
} from '../tokens.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY, stubWorkos, type StubWorkos } from '../workos.test-utils.ts';
import { promiseOf } from '../db/promise.test-utils.ts';

const BASE_URL = 'https://test-app-staging.ontos.example';
const TOKEN_PATH = '/multipass/api/oauth2/token';
const ONTOLOGY_URL = `${BASE_URL}/api/v2/ontologies/x/objectSets/aggregate`;
const CURRENT_USER_URL = `${BASE_URL}/api/v2/admin/users/getCurrent`;
const MCP_URL = `${BASE_URL}/api/mcp`;
const AGGREGATE = 'POST /api/v2/ontologies/{ontology}/objectSets/aggregate';
const IR = twinIr('0.4.0');
const ENGAGEMENT = `${NS}Engagement`;

const AGGREGATE_BODY = {
  objectSet: { type: 'base', objectType: ENGAGEMENT },
  groupBy: [{ type: 'exact', field: 'engagementId' }],
  aggregation: [{ type: 'count', name: 'count' }],
};

const POOLED_URL = 'postgresql://ontology_service:pooled-secret@127.0.0.1:1/neondb';
const DIRECT_URL = 'postgresql://ontology_service:direct-secret@127.0.0.1:1/neondb';
const SENTRY_KEY = '00000000000000000000000000000000';
const APP = { repository: 'example/test-app', environment: 'publish-staging' };

const env: Record<string, string> = {
  PRODUCT_RID: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000157',
  ONTOLOGY_ENVIRONMENT: 'staging',
  ONTOLOGY_BASE_URL: BASE_URL,
  WORKOS_CLIENT_ID: 'client_01TESTADAPTER',
  AUTHKIT_DOMAIN: 'test-app-staging.authkit.app',
  TRUSTED_GITHUB_REPOSITORY: APP.repository,
  TRUSTED_GITHUB_ENVIRONMENT: APP.environment,
  DATABASE_URL: POOLED_URL,
  DATABASE_URL_DIRECT: DIRECT_URL,
  WORKOS_API_KEY: STUB_WORKOS_KEY,
  SENTRY_DSN: 'set in beforeAll',
};

interface Collected {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let exportAnswer: 'success' | 'failure' | 'hang' = 'success';
const collected: Collected[] = [];
const held: ServerResponse[] = [];
let onHeld: (() => void) | undefined;
let collector: Server;
let collectorOrigin: string;

const posthog: { readonly url: string; readonly authorization: string | null }[] = [];

interface PosthogEvent {
  readonly event?: string;
  readonly distinct_id?: string;
  readonly options?: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

const posthogEvents: {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: string;
  readonly events: PosthogEvent[];
}[] = [];

let tokenCalls = 0;
let issuer: TestIssuer;
let workos: StubWorkos;

const network = setupServer(
  http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()),
  http.post(/^https:\/\/(us|eu)\.i\.posthog\.com\/i\/v1\/traces$/, ({ request }) => {
    posthog.push({ url: request.url, authorization: request.headers.get('authorization') });

    return exportAnswer === 'failure'
      ? new HttpResponse(null, { status: 500 })
      : new HttpResponse(null, { status: 200 });
  }),
  http.post(/^https:\/\/(us|eu)\.i\.posthog\.com\/i\/v1\/analytics\/events$/, async ({ request }) => {
    const raw = Buffer.from(await request.arrayBuffer());

    const body = (request.headers.get('content-encoding') === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
    const parsed = JSON.parse(body) as { batch?: PosthogEvent[] };

    posthogEvents.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      body,
      events: parsed.batch ?? [],
    });

    return HttpResponse.json({ results: {} });
  }),
  http.post(`https://${env['AUTHKIT_DOMAIN']}/oauth2/token`, () => {
    tokenCalls += 1;

    return HttpResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'retry-after': '30',
          'x-request-id': 'workos-1',
          'set-cookie': 'session=1',
          'cache-control': 'max-age=60',
        },
      },
    );
  }),
  http.get(`https://${env['AUTHKIT_DOMAIN']}/oauth2/jwks`, () => HttpResponse.json(issuer.jwks.authkit)),
  http.get(`https://api.workos.com/sso/jwks/${env['WORKOS_CLIENT_ID']}`, () => HttpResponse.json(issuer.jwks.workos)),
  http.all('https://api.workos.com/*', ({ request }) => workos.fetch(request)),
);

beforeAll(async () => {
  issuer = await createTestIssuer(
    { workosClientId: env['WORKOS_CLIENT_ID'] ?? '', baseUrl: BASE_URL, app: APP },
    env['AUTHKIT_DOMAIN'],
  );

  collector = createServer((request, response) => {
    void readBody(request).then((body) => {
      collected.push({ path: request.url ?? '', headers: request.headers, body });

      if (!request.url?.includes('/otlp/')) return void response.writeHead(200).end('{}');

      if (exportAnswer === 'hang') {
        held.push(response);

        onHeld?.();

        return;
      }

      response.writeHead(exportAnswer === 'failure' ? 500 : 200).end();
    });
  });

  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));

  const { port } = collector.address() as AddressInfo;

  collectorOrigin = `http://127.0.0.1:${port}`;

  env['SENTRY_DSN'] = `http://${SENTRY_KEY}@127.0.0.1:${port}/157`;

  network.listen({ onUnhandledFrame: 'error' });

  syncBuiltinESMExports();
});

afterAll(async () => {
  network.close();

  syncBuiltinESMExports();

  await new Promise((resolve) => collector.close(resolve));
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  const body = Buffer.concat(chunks);

  return (request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('latin1');
}

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const waited: Promise<unknown>[] = [];
const bodyWaits: Promise<unknown>[] = [];

let installed: InstalledOntology;
let installedUrls: { readonly pooled: string; readonly direct: string };

beforeAll(async () => {
  await import('../../api/index.ts');

  installed = await startInstalled(IR);

  const engagements = Array.from({ length: 2_500 }, (_, i) => ({
    engagementId: `e-${i}`,
    accountId: 'a',
    title: `t${i}`,
    amount: i,
    status: `s${i}`,
    createdAt: null,
  }));

  await insertObjects(promiseOf(installed.input.db), ENGAGEMENT, engagements);

  const named = (name: string) => {
    const url = new URL(installed.url);

    url.searchParams.set('application_name', name);

    return url.toString();
  };

  installedUrls = { pooled: named('pooled'), direct: named('direct') };
});

afterAll(async () => {
  await installed?.stop();
});

function useInstalled(): void {
  vi.stubEnv('DATABASE_URL', installedUrls.pooled);

  vi.stubEnv('DATABASE_URL_DIRECT', installedUrls.direct);

  vi.stubEnv('PRODUCT_RID', ONTOLOGY_RID);

  workos = stubWorkos(...roleMembers(grantsOf(IR).defaultRoles));
}

async function aggregate(): Promise<Request> {
  return new Request(`${BASE_URL}/api/v2/ontologies/${ONTOLOGY_RID}/objectSets/aggregate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await issuer.workos()}`, 'content-type': 'application/json' },
    body: JSON.stringify(AGGREGATE_BODY),
  });
}

let poolSpy: Mock<typeof pg.Pool>;
let connectSpy: MockInstance;
let exportSpy: MockInstance<OTLPTraceExporter['export']>;
let providerSpy: MockInstance<typeof trace.setGlobalTracerProvider>;
let setClientSpy: MockInstance;

beforeEach(() => {
  vi.resetModules();

  collected.length = 0;

  held.length = 0;

  onHeld = undefined;

  posthog.length = 0;

  posthogEvents.length = 0;

  tokenCalls = 0;

  exportAnswer = 'success';

  waited.length = 0;

  bodyWaits.length = 0;

  workos = stubWorkos();

  trace.disable();

  context.disable();

  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

  Object.assign(globalThis, {
    [REQUEST_CONTEXT]: { get: () => ({ waitUntil: (promise: Promise<unknown>) => void waited.push(promise) }) },
  });

  poolSpy = vi.spyOn(pg, 'Pool');

  connectSpy = vi.spyOn(pg.Pool.prototype, 'connect');

  exportSpy = vi.spyOn(OTLPTraceExporter.prototype, 'export');

  providerSpy = vi.spyOn(trace, 'setGlobalTracerProvider');

  setClientSpy = vi.spyOn(Object.getPrototypeOf(Sentry.getCurrentScope()) as { setClient: () => void }, 'setClient');
});

afterEach(async () => {
  exportAnswer = 'success';

  for (const response of held) response.writeHead(200).end();

  await Promise.allSettled(waited);

  const delegate = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as {
    shutdown?: () => Promise<void>;
  };

  await delegate.shutdown?.();

  await Sentry.getClient()?.flush(2000);

  vi.restoreAllMocks();

  trace.disable();

  context.disable();

  vi.unstubAllEnvs();

  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);

  await Promise.all(pools().map((pool) => pool.end()));
});

interface Adapter {
  readonly default: { readonly fetch: (request: Request) => Promise<Response> };
}

function importAdapter(): Promise<Adapter> {
  return import('../../api/index.ts');
}

async function send(adapter: Adapter, request: Request): Promise<Response> {
  const before = waited.length;

  const response = await adapter.default.fetch(request);

  const first = waited[before];

  if (first !== undefined) bodyWaits.push(first);

  return response;
}

const CLIENT_CONFIG = {
  productRid: env['PRODUCT_RID'],
  workosClientId: env['WORKOS_CLIENT_ID'],
  environment: 'staging',
};

function clientConfig(): Request {
  return new Request(`${BASE_URL}/api/ontology-service/v1/client-config`);
}

async function ontologyRequest(): Promise<Request> {
  return new Request(ONTOLOGY_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${await issuer.workos()}` },
  });
}

async function currentUser(): Promise<Request> {
  return new Request(CURRENT_USER_URL, { headers: { authorization: `Bearer ${await issuer.workos()}` } });
}

function pools(): pg.Pool[] {
  return poolSpy.mock.instances as pg.Pool[];
}

function poolsOf(url: string): pg.Pool[] {
  return pools().filter((pool) => pool.options.connectionString === url);
}

function connectedUrls(): unknown[] {
  return [...new Set((connectSpy.mock.contexts as pg.Pool[]).map((pool) => pool.options.connectionString))];
}

function otherWaits(): Promise<unknown>[] {
  return waited.filter((promise) => !bodyWaits.includes(promise));
}

function events(): {
  tags?: Record<string, unknown>;
  user?: { id?: string };
  contexts?: { trace?: Record<string, unknown> };
  exception?: { values?: { value?: string }[] };
}[] {
  return collected
    .filter(({ path }) => path.includes('/envelope/'))
    .flatMap(({ body }) => {
      const lines = body.split('\n').filter((line) => line !== '');
      const found = [];

      for (let index = 1; index + 1 < lines.length; index += 2) {
        if ((JSON.parse(lines[index] ?? '{}') as { type?: string }).type === 'event')
          found.push(JSON.parse(lines[index + 1] ?? '{}'));
      }

      return found;
    });
}

function eventMessages(): (string | undefined)[] {
  return events().map((event) => event.exception?.values?.at(-1)?.value);
}

function exportedBy(): ReadableSpan[][] {
  const groups = new Map<unknown, ReadableSpan[]>();

  exportSpy.mock.calls.forEach(([spans], index) => {
    const exporter = exportSpy.mock.contexts[index];

    groups.set(exporter, [...(groups.get(exporter) ?? []), ...spans]);
  });

  return [...groups.values()];
}

function exportUrls(): string[] {
  const sentry = collected.filter(({ path }) => path.includes('/otlp/')).map(({ path }) => `${collectorOrigin}${path}`);

  return [...new Set([...sentry, ...posthog.map(({ url }) => url)])];
}

async function errorOf(response: Response): Promise<{ errorInstanceId: string; errorName: string }> {
  return (await response.json()) as { errorInstanceId: string; errorName: string };
}

describe('the Vercel adapter', () => {
  it('service/code-layout#http-entry: exports a Web standard fetch handler that calls handle', async () => {
    const adapter = await importAdapter();

    expect(Object.keys(adapter.default)).toEqual(['fetch']);

    const response = await send(adapter, clientConfig());

    expect(response).toBeInstanceOf(Response);

    const direct = inputFromEnv(process.env, (url) => createPool(url));

    const expected = await (await handle(clientConfig(), direct)).json();

    expect(await response.json()).toEqual(expected);
  });

  it('service/storage#connection: creates 1 pool from DATABASE_URL, with max: 10, at module scope and not for each request', async () => {
    const adapter = await importAdapter();

    const pooled = poolsOf(POOLED_URL);

    expect(pooled).toHaveLength(1);
    expect(pooled[0]?.options.max).toBe(10);

    await (await send(adapter, clientConfig())).text();

    await (await send(adapter, await ontologyRequest())).text();

    expect(poolsOf(POOLED_URL)).toHaveLength(1);
    expect(poolsOf(POOLED_URL)[0]).toBe(pooled[0]);
  });

  it('service/code-layout#http-entry, service/storage#connection: registers the pool of DATABASE_URL with attachDatabasePool', async () => {
    await importAdapter();

    const pooled = poolsOf(POOLED_URL);

    expect(pooled).toHaveLength(1);
    expect(pooled[0]?.listenerCount('release')).toBe(1);
  });

  it('service/storage#connection: handle gets the pool of DATABASE_URL as input.db, and the pool of DATABASE_URL_DIRECT as input.directDb', async () => {
    useInstalled();

    const adapter = await importAdapter();

    const response = await send(adapter, await aggregate());

    expect(response.status).toBe(200);

    await response.text();

    expect(connectedUrls()).toEqual([installedUrls.direct, installedUrls.pooled]);
  });

  it('service/authentication#permissions-of-a-caller: passes detached SWR background refreshes to waitUntil until WorkOS responds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      workos = stubWorkos(
        [STUB_PERSON],
        [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', organization_name: 'Acme' }],
      );

      const adapter = await importAdapter();

      const bearer = await issuer.workos({ exp: now() + 3600 });

      const askOrgs = () =>
        new Request(`${BASE_URL}/api/ontology-service/v1/organizations`, {
          headers: { authorization: `Bearer ${bearer}` },
        });

      const first = await adapter.default.fetch(askOrgs());

      expect([first.status, await first.json()]).toEqual([200, { data: [{ id: ORGANIZATION, name: 'Acme' }] }]);

      expect(waited).toHaveLength(1);

      workos.memberships.push({
        user_id: PERSON,
        organization_id: OTHER_ORGANIZATION,
        status: 'active',
        organization_name: 'Beta',
      });

      vi.advanceTimersByTime(60_000);

      workos.hold();

      const before = waited.length;

      const stale = await adapter.default.fetch(askOrgs());

      expect([stale.status, await stale.json()]).toEqual([200, { data: [{ id: ORGANIZATION, name: 'Acme' }] }]);

      const backgroundWait = waited[before];

      expect(waited.length).toBe(before + 2);

      await workos.reached(2);

      let settled = false;

      void backgroundWait?.then(() => (settled = true));

      await new Promise((resolve) => setImmediate(resolve));

      expect(settled).toBe(false);

      workos.release();

      await expect(backgroundWait).resolves.toBeUndefined();

      const refreshed = await adapter.default.fetch(askOrgs());

      expect([refreshed.status, await refreshed.json()]).toEqual([
        200,
        {
          data: [
            { id: ORGANIZATION, name: 'Acme' },
            { id: OTHER_ORGANIZATION, name: 'Beta' },
          ],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the database variables', () => {
  it('service/deployment#deployment-files: DATABASE_URL gives the connection string of 1 pool, the pool of input.db', async () => {
    useInstalled();

    const adapter = await importAdapter();

    expect(poolsOf(installedUrls.pooled)).toHaveLength(1);

    await (await send(adapter, await aggregate())).text();

    connectSpy.mockClear();

    const response = await send(adapter, await aggregate());

    expect(response.status).toBe(200);

    await response.text();

    expect(connectedUrls()).toEqual([installedUrls.pooled]);
    expect(poolsOf(installedUrls.pooled)).toHaveLength(1);
  });

  it('service/deployment#deployment-files: DATABASE_URL_DIRECT gives the connection string of 1 pool, registered with attachDatabasePool, the pool of input.directDb', async () => {
    const adapter = await importAdapter();

    const direct = poolsOf(DIRECT_URL);

    expect(direct).toHaveLength(1);
    expect(direct[0]?.listenerCount('release')).toBe(1);

    await (await send(adapter, await ontologyRequest())).text();

    expect(connectedUrls()).toEqual([DIRECT_URL]);
  });
});

describe('the token route', () => {
  it('service/authentication#the-token-route: a 429 of WorkOS with Retry-After gets the same 429 and Retry-After, no-store, and no other WorkOS header', async () => {
    const adapter = await importAdapter();

    const response = await send(
      adapter,
      new Request(`${BASE_URL}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      }),
    );

    const body: unknown = await response.json();

    await Promise.all(waited);

    expect({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
      calls: tokenCalls,
      reports: events(),
    }).toEqual({
      status: 429,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
        'content-type': 'application/json',
        'retry-after': '30',
      },
      body: { error: 'rate_limited' },
      calls: 1,
      reports: [],
    });
  });
});

describe('the WorkOS API key', () => {
  it('service/deployment#deployment-files: handle gets input.users, which reads WorkOS with WORKOS_API_KEY', async () => {
    const adapter = await importAdapter();

    const response = await send(adapter, await currentUser());

    expect(await response.json()).toMatchObject({ id: STUB_PERSON.id, email: STUB_PERSON.email });

    expect(workos.requests).toEqual([`/user_management/users/${STUB_PERSON.id}`]);
  });
});

describe('the error reports', () => {
  it('service/deployment#deployment-files: inits Sentry once with SENTRY_DSN, ONTOLOGY_ENVIRONMENT, and the version of the service package', async () => {
    const adapter = await importAdapter();

    const client = Sentry.getClient();

    await (await send(adapter, clientConfig())).text();

    await (await send(adapter, clientConfig())).text();

    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    expect(setClientSpy).toHaveBeenCalledTimes(1);
    expect(Sentry.getClient()).toBe(client);

    expect(client?.getOptions()).toEqual(
      expect.objectContaining({ dsn: env['SENTRY_DSN'], environment: 'staging', release: version }),
    );
  });

  it('service/observability#error-reports: turns off each kind of data collection that can hold request data, keeps no breadcrumbs, and beforeSend removes the request', async () => {
    await importAdapter();

    const options = Sentry.getClient()?.getOptions();

    expect(options?.maxBreadcrumbs).toBe(0);

    expect(options?.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });

    const event: Sentry.ErrorEvent = {
      type: undefined,
      event_id: 'e',
      request: { url: 'https://x', headers: { authorization: 'Bearer secret' }, data: '{"secret":1}' },
      tags: { route: 'r' },
    };

    expect(options?.beforeSend?.(event, {})).toEqual({ type: undefined, event_id: 'e', tags: { route: 'r' } });
  });

  it('service/observability#error-reports: removes only the Dedupe integration from the default integrations', async () => {
    await importAdapter();

    const client = Sentry.getClient();
    const defaults = Sentry.getDefaultIntegrations({}).map((integration) => integration.name);

    expect(defaults).toContain('Dedupe');
    expect(defaults.filter((name) => client?.getIntegrationByName(name) === undefined)).toEqual(['Dedupe']);
  });

  it('captures each reported fault with the fields as tags, and the user ID as the user', async () => {
    workos.fail('5xx', { reads: ['user'] });

    const adapter = await importAdapter();

    const response = await send(adapter, await currentUser());

    const { errorInstanceId, errorName } = await errorOf(response);

    await Promise.all(waited);

    expect(events().map(({ tags, user }) => ({ tags, user }))).toEqual([
      {
        tags: { errorInstanceId, errorName, route: 'GET /api/v2/admin/users/getCurrent', callerKind: 'person' },
        user: { id: PERSON },
      },
    ]);
  });

  it('service/observability#error-reports: the event of a fault holds the caller kind as the tag callerKind', async () => {
    workos.fail('5xx', { reads: ['user'] });

    const adapter = await importAdapter();

    await (await send(adapter, await currentUser())).text();

    await Promise.all(waited);

    expect(events().map(({ tags }) => tags?.['callerKind'])).toEqual(['person']);
  });

  it('service/observability#error-reports: a fault on /api/mcp gives 1 event with the method, tool, apiName, and clientId of the mcp field as tags', async () => {
    vi.stubEnv('ONTOLOGY_MCP', 'true');

    const adapter = await importAdapter();

    const response = await send(
      adapter,
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await issuer.authkit({ exp: now() + 300 })}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'describe_object_type', arguments: { objectType: 'com.example.twin.Account' } },
        }),
      }),
    );

    await response.text();

    await Promise.all(waited);

    expect(events().map(({ tags, user }) => ({ tags, user }))).toEqual([
      {
        tags: {
          errorInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          errorName: 'OntologyService:EngineChangesFailed',
          route: 'POST /api/mcp',
          'mcp.method': 'tools/call',
          'mcp.tool': 'describe_object_type',
          'mcp.apiName': 'com.example.twin.Account',
          'mcp.clientId': MCP_CLIENT,
          callerKind: 'person',
        },
        user: { id: PERSON },
      },
    ]);
  });

  it('service/observability#error-reports: passes Sentry.flush(2000) to waitUntil after a request that reported a fault before its answer, once, and nothing after a request with none', async () => {
    const adapter = await importAdapter();

    const flush = vi.spyOn(Sentry.getClient() as Sentry.NodeClient, 'flush');

    await (await send(adapter, clientConfig())).text();

    await Promise.all(waited);

    expect(otherWaits()).toEqual([]);
    expect(flush).not.toHaveBeenCalled();

    const { errorInstanceId } = await errorOf(await send(adapter, await ontologyRequest()));

    expect(otherWaits()).toHaveLength(1);
    expect(flush.mock.calls).toEqual([[2000]]);

    expect(await otherWaits()[0]).toBe(true);

    expect(events().map(({ tags }) => tags?.['errorInstanceId'])).toEqual([errorInstanceId]);
  });

  describe('a fault that ends a streamed answer after its first byte', () => {
    async function endActiveBackends(): Promise<number> {
      const ended = await promiseOf(installed.input.db).query<{ ok: boolean }>({
        text: `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
        values: [],
      });

      return ended.length;
    }

    async function failureOf(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
      try {
        for (;;) if ((await reader.read()).done) return undefined;
      } catch (error) {
        return error;
      }
    }

    it('service/observability#error-reports: passes 1 promise to waitUntil during fetch, which flushes Sentry only after the body ends', async () => {
      useInstalled();

      const adapter = await importAdapter();

      const flush = vi.spyOn(Sentry.getClient() as Sentry.NodeClient, 'flush');

      await (await send(adapter, await aggregate())).text();

      await Promise.all(waited);

      waited.length = 0;

      bodyWaits.length = 0;

      const response = await send(adapter, await aggregate());

      expect(response.status).toBe(200);
      expect(waited).toHaveLength(1);
      expect(bodyWaits).toEqual(waited);

      const reader = readerOf(response);

      expect((await reader.read()).done).toBe(false);

      expect(flush).not.toHaveBeenCalled();

      expect(await endActiveBackends()).toBeGreaterThan(0);

      const failure = await failureOf(reader);

      expect(failure).toBeInstanceOf(Error);

      await bodyWaits[0];

      expect(
        events().map((event) => ({
          message: event.exception?.values?.at(-1)?.value,
          tags: event.tags,
          user: event.user,
        })),
      ).toEqual([
        {
          message: (failure as Error).message,
          tags: { errorName: 'Default:Internal', route: AGGREGATE, ontologyVersion: 1, callerKind: 'person' },
          user: { id: PERSON },
        },
      ]);

      expect(flush.mock.calls).toEqual([[2000]]);
    });

    it('service/observability#error-reports: a body that ends with no fault gives no flush', async () => {
      const adapter = await importAdapter();

      const flush = vi.spyOn(Sentry.getClient() as Sentry.NodeClient, 'flush');

      await (await send(adapter, clientConfig())).text();

      expect(bodyWaits).toHaveLength(1);

      await Promise.all(waited);

      expect(flush).not.toHaveBeenCalled();
    });

    it('service/observability#error-reports: a body that never ends releases its waitUntil promise after 60 seconds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      try {
        const adapter = await importAdapter();

        const flush = vi.spyOn(Sentry.getClient() as Sentry.NodeClient, 'flush');

        await send(adapter, clientConfig());

        let released = false;

        void bodyWaits[0]?.then(() => (released = true));

        await vi.advanceTimersByTimeAsync(59_999);

        expect(released).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        expect(released).toBe(true);
        expect(flush).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('service/observability#error-reports: the node:http adapter imports neither @sentry/node nor posthog-node', () => {
    const node = readFileSync(new URL('../node.ts', import.meta.url), 'utf8');

    expect(node).not.toMatch(/reportFault|@sentry|posthog-node/);
  });

  it('service/observability#error-reports: reports a 5xx fault to PostHog with distinctId, tags, environment, release, and zero leaked secrets', async () => {
    stubTraces(TRACE_STATES.posthog);

    workos.fail('5xx', { reads: ['user'] });

    const adapter = await importAdapter();

    const request = await currentUser();

    const authHeader = request.headers.get('authorization') ?? '';

    const response = await send(adapter, request);

    const { errorInstanceId, errorName } = await errorOf(response);

    await Promise.all(waited);

    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    const captured = posthogEvents.flatMap((entry) => entry.events);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe('$exception');
    expect(captured[0]?.distinct_id).toBe(PERSON);

    expect(captured[0]?.properties).toMatchObject({
      errorInstanceId,
      errorName,
      route: 'GET /api/v2/admin/users/getCurrent',
      callerKind: 'person',
      userId: PERSON,
      environment: 'staging',
      release: version,
    });

    const raw = posthogEvents.map((entry) => entry.body).join('\n');

    for (const secret of [
      STUB_WORKOS_KEY,
      POOLED_URL,
      DIRECT_URL,
      authHeader,
      '$request',
      '$headers',
      '$cookies',
      '$request_body',
      '$ip',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('service/observability#error-reports: uses the PostHog region host only, never a custom host from the token', async () => {
    stubTraces({ TRACES_POSTHOG_REGION: 'eu', TRACES_POSTHOG_TOKEN: 'phc_us.i.posthog.com.attacker.test' });

    const adapter = await importAdapter();

    await (await send(adapter, await ontologyRequest())).text();

    await Promise.all(waited);

    expect(posthogEvents.map(({ url, authorization }) => ({ url, authorization }))).toEqual([
      {
        url: 'https://eu.i.posthog.com/i/v1/analytics/events',
        authorization: 'Bearer phc_us.i.posthog.com.attacker.test',
      },
    ]);
  });

  it('service/observability#error-reports: a fault on /api/mcp sends mcp.method, mcp.tool, mcp.apiName, and mcp.clientId to PostHog', async () => {
    vi.stubEnv('ONTOLOGY_MCP', 'true');

    stubTraces(TRACE_STATES.posthog);

    const adapter = await importAdapter();

    const response = await send(
      adapter,
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await issuer.authkit({ exp: now() + 300 })}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'describe_object_type', arguments: { objectType: 'com.example.twin.Account' } },
        }),
      }),
    );

    const text = await response.text();

    expect(text).toContain('OntologyService:EngineChangesFailed');

    await Promise.all(waited);

    const captured = posthogEvents.flatMap((entry) => entry.events);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.distinct_id).toBe(PERSON);

    expect(captured[0]?.properties).toMatchObject({
      errorInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      errorName: 'OntologyService:EngineChangesFailed',
      route: 'POST /api/mcp',
      'mcp.method': 'tools/call',
      'mcp.tool': 'describe_object_type',
      'mcp.apiName': 'com.example.twin.Account',
      'mcp.clientId': MCP_CLIENT,
      callerKind: 'person',
      userId: PERSON,
    });
  });

  it('service/observability#error-reports: attaches trace_id, $trace_id, and $span_id when the root span records, and omits them when TRACES_SAMPLE_RATE is 0', async () => {
    stubTraces(TRACE_STATES.both);

    const sampledAdapter = await importAdapter();

    await (await send(sampledAdapter, await ontologyRequest())).text();

    await Promise.all(waited);

    const root = exportedBy()[0]
      ?.find((span) => span.parentSpanContext === undefined)
      ?.spanContext();

    expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);

    expect(posthogEvents.flatMap((entry) => entry.events)[0]?.properties).toMatchObject({
      trace_id: root?.traceId,
      $trace_id: root?.traceId,
      $span_id: root?.spanId,
    });

    vi.resetModules();

    waited.length = 0;

    bodyWaits.length = 0;

    posthogEvents.length = 0;

    trace.disable();

    context.disable();

    stubTraces({ ...TRACE_STATES.both, TRACES_SAMPLE_RATE: '0' });

    const unsampledAdapter = await importAdapter();

    await (await send(unsampledAdapter, await ontologyRequest())).text();

    await Promise.all(waited);

    const unsampledProps = posthogEvents.flatMap((entry) => entry.events)[0]?.properties ?? {};

    expect(unsampledProps['trace_id']).toBeUndefined();
    expect(unsampledProps['$trace_id']).toBeUndefined();
    expect(unsampledProps['$span_id']).toBeUndefined();
  });

  describe('a fault that ends a streamed answer after its first byte with PostHog', () => {
    async function endActiveBackends(): Promise<number> {
      const ended = await promiseOf(installed.input.db).query<{ ok: boolean }>({
        text: `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
        values: [],
      });

      return ended.length;
    }

    async function failureOf(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
      try {
        for (;;) if ((await reader.read()).done) return undefined;
      } catch (error) {
        return error;
      }
    }

    it('service/observability#error-reports: a mid-stream fault flushes PostHog only after the body ends, with ontologyVersion, route, callerKind, distinct_id, and no errorInstanceId', async () => {
      useInstalled();

      stubTraces(TRACE_STATES.posthog);

      const posthogFlush = vi.spyOn(PostHog.prototype, 'flush');

      const adapter = await importAdapter();

      const response = await send(adapter, await aggregate());

      expect(response.status).toBe(200);

      const reader = readerOf(response);

      expect((await reader.read()).done).toBe(false);

      expect(posthogFlush).not.toHaveBeenCalled();

      expect(await endActiveBackends()).toBeGreaterThan(0);

      const failure = await failureOf(reader);

      expect(failure).toBeInstanceOf(Error);

      await Promise.all(waited);

      const captured = posthogEvents.flatMap((entry) => entry.events);

      expect(captured).toHaveLength(1);
      expect(captured[0]?.distinct_id).toBe(PERSON);

      expect(captured[0]?.properties).toMatchObject({
        errorName: 'Default:Internal',
        route: AGGREGATE,
        ontologyVersion: 1,
        callerKind: 'person',
        userId: PERSON,
        trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        $trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        $span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      });

      expect(captured[0]?.properties?.['errorInstanceId']).toBeUndefined();
      expect(posthogFlush).toHaveBeenCalledTimes(1);
    });

    it('service/observability#error-reports: a clean close or client cancel triggers no PostHog report or flush', async () => {
      useInstalled();

      stubTraces(TRACE_STATES.posthog);

      const posthogFlush = vi.spyOn(PostHog.prototype, 'flush');

      const adapter = await importAdapter();

      await (await send(adapter, clientConfig())).text();

      await Promise.all(waited);

      const streamed = await send(adapter, await aggregate());

      const reader = readerOf(streamed);

      await reader.read();

      await reader.cancel();

      await Promise.all(waited);

      expect(posthogEvents).toEqual([]);
      expect(posthogFlush).not.toHaveBeenCalled();
    });
  });
});

const SENTRY_OTLP_PATH = '/api/157/integration/otlp/v1/traces/';
const SENTRY_OTLP_AUTH = `Sentry sentry_version=7, sentry_key=${SENTRY_KEY}`;

const TRACE_STATES = {
  none: {},
  sentry: { TRACES_SENTRY: 'true' },
  posthog: { TRACES_POSTHOG_REGION: 'us', TRACES_POSTHOG_TOKEN: 'phc_test' },
  both: { TRACES_SENTRY: 'true', TRACES_POSTHOG_REGION: 'us', TRACES_POSTHOG_TOKEN: 'phc_test' },
} as const satisfies Record<string, Readonly<Record<string, string>>>;

function stubTraces(variables: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(variables)) vi.stubEnv(name, value);
}

const exportedNames = (): string[][] => exportedBy().map((spans) => spans.map((span) => span.name).sort());

const exportedIds = (): string[][] => exportedBy().map((spans) => spans.map((span) => span.spanContext().spanId));

function globalProvider(): unknown {
  const delegate = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();

  return delegate.constructor.name === 'NoopTracerProvider' ? undefined : delegate;
}

describe('the trace export', () => {
  it.each([
    ['none', 0],
    ['sentry', 1],
    ['posthog', 1],
    ['both', 2],
  ] as const)('service/observability#trace-export: the state %s gives %i exporters', async (name, count) => {
    stubTraces(TRACE_STATES[name]);

    const adapter = await importAdapter();

    await (await send(adapter, clientConfig())).text();

    await Promise.all(waited);

    expect(exportedBy()).toHaveLength(count);
    expect(exportUrls()).toHaveLength(count);
  });

  it('service/observability#trace-export: with both destinations, each exporter gets the same spans', async () => {
    stubTraces(TRACE_STATES.both);

    const adapter = await importAdapter();

    expect(await (await send(adapter, clientConfig())).json()).toEqual(CLIENT_CONFIG);

    expect(otherWaits()).toHaveLength(1);

    await otherWaits()[0];

    const [sentry, posthogIds] = exportedIds();

    expect(sentry).toHaveLength(2);
    expect(posthogIds).toEqual(sentry);
  });

  it('service/observability#trace-export service/deployment#deployment-files: with none of the 4 trace variables, no tracer provider is registered and a request gives no waitUntil for traces', async () => {
    const adapter = await importAdapter();

    expect(providerSpy).not.toHaveBeenCalled();
    expect(globalProvider()).toBeUndefined();

    await (await send(adapter, clientConfig())).text();

    expect(otherWaits()).toEqual([]);
  });

  it('service/observability#trace-export service/observability#error-reports: with TRACES_SAMPLE_RATE 0, a request gives no waitUntil for traces, and a fault gives only Sentry.flush(2000)', async () => {
    stubTraces({ ...TRACE_STATES.both, TRACES_SAMPLE_RATE: '0' });

    const adapter = await importAdapter();

    const flush = vi.spyOn(Sentry.getClient() as Sentry.NodeClient, 'flush');

    await (await send(adapter, clientConfig())).text();

    expect(otherWaits()).toEqual([]);

    await (await send(adapter, await ontologyRequest())).text();

    expect(otherWaits()).toHaveLength(1);
    expect(flush.mock.calls).toEqual([[2000]]);

    await Promise.all(waited);

    expect(exportSpy).not.toHaveBeenCalled();
  });

  it('service/observability#trace-export service/deployment#deployment-files: TRACES_SENTRY true adds the Sentry exporter with the URL and X-Sentry-Auth header of getOtlpTracesEndpoint(SENTRY_DSN)', async () => {
    stubTraces(TRACE_STATES.sentry);

    const adapter = await importAdapter();

    await (await send(adapter, clientConfig())).text();

    await Promise.all(waited);

    expect(
      collected
        .filter(({ path }) => path.includes('/otlp/'))
        .map(({ path, headers }) => ({ path, auth: headers['x-sentry-auth'] })),
    ).toEqual([{ path: SENTRY_OTLP_PATH, auth: SENTRY_OTLP_AUTH }]);

    expect(posthog).toEqual([]);
  });

  it('service/observability#trace-export: with TRACES_SENTRY unset, no exporter goes to Sentry', async () => {
    stubTraces(TRACE_STATES.posthog);

    const adapter = await importAdapter();

    await (await send(adapter, clientConfig())).text();

    await Promise.all(waited);

    expect(exportUrls()).toEqual(['https://us.i.posthog.com/i/v1/traces']);
  });

  it.each([
    ['us', 'https://us.i.posthog.com/i/v1/traces'],
    ['eu', 'https://eu.i.posthog.com/i/v1/traces'],
  ])(
    'service/observability#trace-export service/deployment#deployment-files: the region %s and a token add the PostHog exporter at %s',
    async (region, url) => {
      stubTraces({ TRACES_POSTHOG_REGION: region, TRACES_POSTHOG_TOKEN: 'phc_test' });

      const adapter = await importAdapter();

      await (await send(adapter, clientConfig())).text();

      await Promise.all(waited);

      expect(posthog).toEqual([{ url, authorization: 'Bearer phc_test' }]);
      expect(exportUrls()).toEqual([url]);
    },
  );

  it('service/observability#trace-export: the PostHog host comes from the region, never from the token', async () => {
    stubTraces({ TRACES_POSTHOG_REGION: 'eu', TRACES_POSTHOG_TOKEN: 'phc_us.i.posthog.com.attacker.test' });

    const adapter = await importAdapter();

    await (await send(adapter, clientConfig())).text();

    await Promise.all(waited);

    expect(exportUrls()).toEqual(['https://eu.i.posthog.com/i/v1/traces']);
  });

  it('service/observability#trace-export: the resource holds service.version, deployment.environment.name, and ontology.deployment', async () => {
    stubTraces(TRACE_STATES.posthog);

    const adapter = await importAdapter();

    await (await send(adapter, clientConfig())).text();

    await Promise.all(waited);

    const SERVICE_VERSION = (
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    ).version;

    expect(exportSpy.mock.calls[0]?.[0][0]?.resource.attributes).toMatchObject({
      'service.version': SERVICE_VERSION,
      'deployment.environment.name': 'staging',
      'ontology.deployment': 'test-app-staging.ontos.example',
    });
  });

  it.each([
    ['0', 0],
    ['1', 100],
    [undefined, 100],
  ])(
    'service/observability#trace-export service/deployment#deployment-files: TRACES_SAMPLE_RATE %s records %i of 100 root spans',
    async (rate, recorded) => {
      stubTraces({ ...TRACE_STATES.sentry, ...(rate === undefined ? {} : { TRACES_SAMPLE_RATE: rate }) });

      await importAdapter();

      const roots = Array.from({ length: 100 }, () => trace.getTracer('test').startSpan('root'));

      expect(roots.filter((root) => root.isRecording())).toHaveLength(recorded);

      for (const root of roots) root.end();
    },
  );

  it('service/observability#trace-export: TRACES_SAMPLE_RATE 0.5 overrides remote traceparent flags with TraceIdRatioBased(0.5)', async () => {
    stubTraces({ ...TRACE_STATES.sentry, TRACES_SAMPLE_RATE: '0.5' });

    await importAdapter();

    const tracer = trace.getTracer('test');
    const ratio = new TraceIdRatioBasedSampler(0.5);

    const kept = (traceId: string) =>
      ratio.shouldSample(context.active(), traceId).decision === SamplingDecision.RECORD_AND_SAMPLED;

    const roots = Array.from({ length: 1000 }, () => tracer.startSpan('root'));

    expect(roots.filter((root) => root.isRecording() !== kept(root.spanContext().traceId))).toEqual([]);

    const children = roots.map((root, index) => {
      const traceFlags = index % 2 === 0 ? TraceFlags.SAMPLED : TraceFlags.NONE;
      const parent = trace.setSpanContext(context.active(), { ...root.spanContext(), traceFlags, isRemote: true });
      const child = tracer.startSpan('child', {}, parent);
      const result = { expected: kept(root.spanContext().traceId), recording: child.isRecording() };

      child.end();

      return result;
    });

    expect(children.filter(({ expected, recording }) => expected !== recording)).toEqual([]);

    for (const root of roots) root.end();
  });

  it('service/observability#trace-export: the provider is registered before Sentry.init, which gets no enableOpenTelemetrySetup true and no tracesSampleRate', async () => {
    stubTraces(TRACE_STATES.both);

    await importAdapter();

    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(setClientSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy.mock.invocationCallOrder[0]).toBeLessThan(setClientSpy.mock.invocationCallOrder[0] ?? 0);
    expect(globalProvider()).toBe(providerSpy.mock.calls[0]?.[0]);

    const options = Sentry.getClient()?.getOptions();

    expect(options).not.toMatchObject({ enableOpenTelemetrySetup: true });
    expect(options?.tracesSampleRate).toBeUndefined();
  });

  it('service/observability#error-reports service/code-layout#modules: a fault with a recording root gives 1 captureException with the tag trace_id and the trace context of the root', async () => {
    stubTraces(TRACE_STATES.sentry);

    const adapter = await importAdapter();

    const { errorInstanceId, errorName } = await errorOf(await send(adapter, await ontologyRequest()));

    await Promise.all(waited);

    const root = exportedBy()[0]
      ?.find((span) => span.attributes['route.key'] !== undefined)
      ?.spanContext();

    expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);

    expect(
      events().map(({ tags, contexts }) => ({
        tags,
        trace: { trace_id: contexts?.trace?.['trace_id'], span_id: contexts?.trace?.['span_id'] },
      })),
    ).toEqual([
      {
        tags: {
          errorInstanceId,
          errorName,
          route: 'POST /api/v2/ontologies/{ontology}/objectSets/aggregate',
          callerKind: 'person',
          trace_id: root?.traceId,
        },
        trace: { trace_id: root?.traceId, span_id: root?.spanId },
      },
    ]);
  });

  describe('the flush', () => {
    let consoleLog: MockInstance<typeof console.log>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      consoleLog = vi.spyOn(console, 'log');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function exportLines(): unknown[][] {
      return consoleLog.mock.calls.filter(([line]) => String(line).includes('traceExportFailed'));
    }

    async function flushSettled(): Promise<() => boolean> {
      expect(otherWaits()).toHaveLength(1);

      let settled = false;

      void otherWaits()[0]?.then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(0);

      return () => settled;
    }

    it('service/observability#trace-export service/code-layout#modules: 1 waitUntil promise settles after the body ends, and then the root span has left', async () => {
      stubTraces(TRACE_STATES.sentry);

      const adapter = await importAdapter();

      const response = await send(adapter, await currentUser());

      const settled = await flushSettled();

      await vi.advanceTimersByTimeAsync(59_000);

      expect(settled()).toBe(false);

      expect(await response.json()).toMatchObject({ id: STUB_PERSON.id });

      await otherWaits()[0];

      expect(settled()).toBe(true);

      expect(exportedNames()).toEqual([
        ['GET /api/v2/admin/users/getCurrent', 'jwks fetch', 'response.body', 'token check', 'workos read'],
      ]);
    });

    it('service/observability#trace-export: no flush runs before the root ends, also when a child span has ended', async () => {
      stubTraces(TRACE_STATES.sentry);

      const adapter = await importAdapter();

      const response = await send(adapter, await currentUser());

      const settled = await flushSettled();

      await vi.advanceTimersByTimeAsync(4_000);

      expect(exportedNames()).toEqual([]);

      await response.text();

      await otherWaits()[0];

      expect(settled()).toBe(true);

      expect(exportedNames()).toEqual([
        ['GET /api/v2/admin/users/getCurrent', 'jwks fetch', 'response.body', 'token check', 'workos read'],
      ]);
    });

    it('service/observability#trace-export: a body that stays open settles the promise after 60 seconds', async () => {
      stubTraces(TRACE_STATES.sentry);

      const adapter = await importAdapter();

      await send(adapter, clientConfig());

      const settled = await flushSettled();

      await vi.advanceTimersByTimeAsync(59_999);

      expect(settled()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      await otherWaits()[0];

      expect(settled()).toBe(true);
    });

    it('service/observability#trace-export: a flush that hangs settles the promise after 3 seconds, and logs only the kind of its destination', async () => {
      stubTraces(TRACE_STATES.sentry);

      exportAnswer = 'hang';

      const adapter = await importAdapter();

      await (await send(adapter, clientConfig())).text();

      const settled = await flushSettled();

      await new Promise<void>((resolve) => (held.length > 0 ? resolve() : (onHeld = resolve)));

      await vi.advanceTimersByTimeAsync(2_999);

      expect(settled()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      expect(settled()).toBe(true);
      expect(exportLines()).toEqual([[JSON.stringify({ traceExportFailed: 'sentry' })]]);
    });

    it.each(['sentry', 'posthog'] as const)(
      'service/observability#trace-export: a failed export to %s is caught, and logs only the kind of its destination',
      async (name) => {
        stubTraces(TRACE_STATES[name]);

        exportAnswer = 'failure';

        const adapter = await importAdapter();

        await (await send(adapter, clientConfig())).text();

        const settled = await flushSettled();

        await otherWaits()[0];

        expect(settled()).toBe(true);
        expect(exportLines()).toEqual([[JSON.stringify({ traceExportFailed: name })]]);
      },
    );

    it.each(['00', '01'] as const)(
      'service/observability#trace-export: a request with a valid traceparent (-%s) returns a flush promise in waitUntil and exports the trace',
      async (flags) => {
        stubTraces(TRACE_STATES.sentry);

        const adapter = await importAdapter();

        const traceId = '0af7651916cd43dd8448eb211c80319c';
        const parentSpanId = 'b7ad6b7169203331';
        const req = clientConfig();

        req.headers.set('traceparent', `00-${traceId}-${parentSpanId}-${flags}`);

        const response = await send(adapter, req);

        const settled = await flushSettled();

        expect(await response.text()).toBeTruthy();

        await otherWaits()[0];

        expect(settled()).toBe(true);

        const exported = exportedBy()[0] ?? [];
        const root = exported.find((span) => span.attributes['route.key'] !== undefined);

        expect(root?.spanContext().traceId).toBe(traceId);
        expect(root?.parentSpanContext?.spanId).toBe(parentSpanId);
        expect(root?.parentSpanContext?.isRemote).toBe(true);
        expect(exportedNames()).toEqual([['GET /api/ontology-service/v1/client-config', 'response.body']]);
      },
    );
  });

  describe('a bad or missing trace variable', () => {
    let consoleLog: MockInstance<typeof console.log>;

    beforeEach(() => {
      consoleLog = vi.spyOn(console, 'log');
    });

    it.each([
      ['TRACES_SENTRY', 'yes', ['https://us.i.posthog.com/i/v1/traces']],
      ['TRACES_POSTHOG_REGION', 'ap', [SENTRY_OTLP_PATH]],
      ['TRACES_POSTHOG_TOKEN', 'abc', [SENTRY_OTLP_PATH]],
      ['TRACES_SAMPLE_RATE', '2', []],
    ])(
      'service/observability#trace-export: %s=%s turns its destination off, a request answers 200, and 1 report names the variable and not its value',
      async (name, value, urls) => {
        stubTraces({ ...TRACE_STATES.both, [name]: value });

        const adapter = await importAdapter();

        const flush = vi.spyOn(Sentry.getClient() as Sentry.NodeClient, 'flush');

        const response = await send(adapter, clientConfig());

        expect(response.status).toBe(200);

        await response.text();

        expect(flush.mock.calls).toEqual([[2000]]);

        await Promise.all(waited);

        expect(exportUrls().map((url) => url.replace(collectorOrigin, ''))).toEqual(urls);

        const messages = eventMessages();

        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(name);
        expect(messages[0]?.replace(name, '')).not.toContain(value);

        await (await send(adapter, clientConfig())).text();

        await Promise.all(waited);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(eventMessages()).toHaveLength(1);
      },
    );

    it.each(Object.keys(TRACE_STATES.both).concat('TRACES_SAMPLE_RATE'))(
      'service/deployment#deployment-files: with %s missing, the service answers 200 and logs no SettingMissing',
      async (name) => {
        stubTraces({ ...TRACE_STATES.both, TRACES_SAMPLE_RATE: '1' });

        vi.stubEnv(name, undefined);

        const adapter = await importAdapter();

        const response = await send(adapter, clientConfig());

        expect(response.status).toBe(200);

        expect(await response.json()).toEqual(CLIENT_CONFIG);

        await Promise.all(waited);

        expect(
          consoleLog.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('SettingMissing')),
        ).toEqual([]);

        expect(events()).toEqual([]);
      },
    );
  });
});

describe('a missing setting', () => {
  let consoleLog: MockInstance<typeof console.log>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log');
  });

  function logLines(): Record<string, unknown>[] {
    return consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  }

  it('service/deployment#deployment-files: with PRODUCT_RID and DATABASE_URL missing, it makes no pool, answers 503 SettingMissing, and logs 1 line that names both', async () => {
    vi.stubEnv('PRODUCT_RID', undefined);

    vi.stubEnv('DATABASE_URL', undefined);

    const adapter = await importAdapter();

    const response = await send(adapter, clientConfig());

    expect(response.status).toBe(503);

    const body = (await response.json()) as { errorInstanceId: string };

    expect(body).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'OntologyService:SettingMissing',
      errorInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      parameters: {},
    });

    expect(logLines()).toEqual([
      {
        errorInstanceId: body.errorInstanceId,
        route: 'GET /api/ontology-service/v1/client-config',
        routeParams: {},
        errorName: 'OntologyService:SettingMissing',
        parameters: {},
        stack: expect.stringMatching(
          /^Error: These environment variables are missing or not valid: PRODUCT_RID, DATABASE_URL\.\n/,
        ),
      },
    ]);

    expect(pools()).toEqual([]);
  });

  it.each(Object.keys(env).filter((name) => name !== 'DATABASE_URL_DIRECT' && name !== 'SENTRY_DSN'))(
    'service/deployment#deployment-files: with %s missing or empty, each request gets 503 SettingMissing and a log line that names it, with no pool',
    async (name) => {
      for (const value of [undefined, '']) {
        vi.resetModules();

        consoleLog.mockClear();

        vi.stubEnv(name, value);

        const adapter = await importAdapter();

        for (let request = 0; request < 2; request++) {
          const response = await send(adapter, clientConfig());

          expect(response.status).toBe(503);

          expect(await response.json()).toMatchObject({ errorName: 'OntologyService:SettingMissing' });
        }

        expect(logLines().map((line) => String(line['stack']).split('\n')[0])).toEqual(
          Array(2).fill(`Error: These environment variables are missing or not valid: ${name}.`),
        );

        expect(pools()).toEqual([]);
      }
    },
  );

  it.each([
    ['2 repositories and 1 environment', 'example/acme-ontology,example/acme-web-app', 'ontology-staging'],
    ['an empty item', 'example/acme-ontology,', 'ontology-staging,ontology-staging'],
    ['a space after a comma', 'example/acme-ontology, example/acme-web-app', 'ontology-staging,ontology-staging'],
  ])(
    'service/deployment#deployment-files: trusted lists with %s give 503 SettingMissing, and the log line names both variables',
    async (_case, repositories, environments) => {
      vi.stubEnv('TRUSTED_GITHUB_REPOSITORY', repositories);

      vi.stubEnv('TRUSTED_GITHUB_ENVIRONMENT', environments);

      const adapter = await importAdapter();

      const response = await send(adapter, clientConfig());

      expect(response.status).toBe(503);

      expect(logLines().map((line) => String(line['stack']).split('\n')[0])).toEqual([
        'Error: These environment variables are missing or not valid: TRUSTED_GITHUB_REPOSITORY, TRUSTED_GITHUB_ENVIRONMENT.',
      ]);

      expect(pools()).toEqual([]);
    },
  );

  it('service/deployment#deployment-files serves client-config with 200 and skips Sentry initialization when SENTRY_DSN is missing', async () => {
    vi.stubEnv('SENTRY_DSN', undefined);

    const before = Sentry.getClient();

    const adapter = await importAdapter();

    const response = await send(adapter, clientConfig());

    expect(response.status).toBe(200);

    await response.text();

    expect(Sentry.getClient()).toBe(before);
  });
});

describe('vercel.json', () => {
  const vercelJson = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
    readonly rewrites: unknown;
    readonly headers: unknown;
    readonly functions: Readonly<Record<string, { readonly maxDuration?: unknown; readonly includeFiles?: unknown }>>;
  };

  it('service/code-layout#http-entry: api/index.ts is the one Vercel Function', () => {
    expect(
      readdirSync(new URL('../../api/', import.meta.url)).filter(
        (name) => !name.startsWith('.') && !name.startsWith('_'),
      ),
    ).toEqual(['index.ts']);

    expect(Object.keys(vercelJson.functions)).toEqual(['api/index.ts']);
  });

  it('service/code-layout#http-entry: rewrites each path under /api/ to the Vercel Function', () => {
    expect(vercelJson.rewrites).toContainEqual({ source: '/api/:path*', destination: '/api' });
  });

  it('service/authentication#the-token-route: the token route is the one route outside /api/, and its own rewrite sends it to the Vercel Function', () => {
    expect(vercelJson.rewrites).toEqual([
      { source: '/api/:path*', destination: '/api' },
      { source: '/multipass/api/oauth2/token', destination: '/api' },
    ]);

    expect(routes.filter((route) => !route.path.startsWith('/api/')).map((route) => route.path)).toEqual([
      '/multipass/api/oauth2/token',
    ]);
  });

  it('serves the well-known file of the protected resource metadata as application/json', () => {
    expect(vercelJson.headers).toEqual([
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        headers: [{ key: 'content-type', value: 'application/json' }],
      },
    ]);
  });

  it('service/deployment#projects-and-environments: sets maxDuration to 800 seconds for the Vercel Function', () => {
    expect(vercelJson.functions['api/index.ts']?.maxDuration).toBe(800);
  });

  it('service/code-layout#http-entry: includeFiles adds the worker script of the functions module, which imports only node: modules', () => {
    const includeFiles = vercelJson.functions['api/index.ts']?.includeFiles;

    expect(includeFiles).toBe('src/functions/worker.ts');

    const worker = readFileSync(new URL(`../../${String(includeFiles)}`, import.meta.url), 'utf8');

    const imports = [...worker.matchAll(/^import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
      ([, source]) => source,
    );

    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((source) => !source?.startsWith('node:'))).toEqual([]);
  });
});

describe('the @vercel/functions border', () => {
  const lintText = lintProbe();
  const code = "import { attachDatabasePool } from '@vercel/functions';\nexport const a = attachDatabasePool;\n";

  const refused =
    "'@vercel/functions' import is restricted from being used. Only the Vercel adapter in api/ imports @vercel/functions.";

  async function messages(file: string): Promise<string[]> {
    return (await lintText(file, code)).filter((f) => f.rule === 'no-restricted-imports').map((f) => f.message);
  }

  it('service/code-layout#http-entry: lets only the Vercel adapter import @vercel/functions', async () => {
    const src = new URL('../', import.meta.url);

    const modules = readdirSync(src, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(modules.length).toBeGreaterThan(0);

    for (const name of modules) expect(await messages(`packages/service/src/${name}/x.ts`)).toEqual([refused]);

    expect(await messages('packages/service/src/node.ts')).toEqual([refused]);

    expect(await messages('packages/service/api/index.ts')).toEqual([]);
  });
});
