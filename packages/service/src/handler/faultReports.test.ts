import { createServer, type IncomingMessage, type Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { context, trace, type ProxyTracerProvider } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { PostHog } from 'posthog-node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTracing } from '../../api/_tracing.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { STUB_WORKOS_KEY } from '../workos.test-utils.ts';

const waited: Promise<unknown>[] = [];
const bodyWaits: Promise<unknown>[] = [];
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

const envelopes: string[] = [];

const collectorRequests: { readonly url: string; readonly headers: Record<string, string | string[] | undefined> }[] =
  [];

let collector: Server;
let collectorPort: number;
let sentryDsn: string;

interface CapturedPosthogEvent {
  readonly event?: string;
  readonly distinct_id?: string;
  readonly options?: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

interface CapturedPosthogRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly rawBody: string;
  readonly batch: CapturedPosthogEvent[];
}

const posthogRequests: CapturedPosthogRequest[] = [];
const posthogTraceRequests: { readonly url: string; readonly headers: Record<string, string> }[] = [];
let posthogAnswer: () => Response | Promise<Response> = () => HttpResponse.json({ results: {} });
let issuer: TestIssuer;

const network = setupServer(
  http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()),
  http.get('https://api.workos.com/sso/jwks/client_01TESTADAPTER', () => HttpResponse.json(issuer.jwks.workos)),
  http.post(/^https:\/\/(us|eu)\.i\.posthog\.com\/i\/v1\/traces$/, ({ request }) => {
    posthogTraceRequests.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()) });

    return new HttpResponse(null, { status: 200 });
  }),
  http.post(/^https:\/\/(us|eu)\.i\.posthog\.com\/i\/v1\/analytics\/events$/, async ({ request }) => {
    const raw = Buffer.from(await request.arrayBuffer());

    const rawBody = (request.headers.get('content-encoding') === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
    const parsed = JSON.parse(rawBody) as { batch?: CapturedPosthogEvent[] };

    posthogRequests.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      rawBody,
      batch: parsed.batch ?? [],
    });

    return posthogAnswer();
  }),
);

const baseEnv = {
  PRODUCT_RID: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000888',
  ONTOLOGY_ENVIRONMENT: 'staging',
  ONTOLOGY_BASE_URL: 'https://test-app-staging.ontos.example',
  WORKOS_CLIENT_ID: 'client_01TESTADAPTER',
  AUTHKIT_DOMAIN: 'test-app-staging.authkit.app',
  TRUSTED_GITHUB_REPOSITORY: 'example/test-app',
  TRUSTED_GITHUB_ENVIRONMENT: 'publish-staging',
  DATABASE_URL: 'postgresql://ontology_service:pooled@127.0.0.1:1/neondb',
  DATABASE_URL_DIRECT: 'postgresql://ontology_service:direct@127.0.0.1:1/neondb',
  WORKOS_API_KEY: STUB_WORKOS_KEY,
};

beforeAll(async () => {
  issuer = await createTestIssuer(
    {
      workosClientId: baseEnv.WORKOS_CLIENT_ID,
      baseUrl: baseEnv.ONTOLOGY_BASE_URL,
      app: { repository: baseEnv.TRUSTED_GITHUB_REPOSITORY, environment: baseEnv.TRUSTED_GITHUB_ENVIRONMENT },
    },
    baseEnv.AUTHKIT_DOMAIN,
  );

  await import('../../api/index.ts');

  collector = createServer((request, response) => {
    collectorRequests.push({ url: request.url ?? '', headers: request.headers });

    void readBody(request).then((body) => {
      envelopes.push(body);

      response.writeHead(200).end('{}');
    });
  });

  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));

  const { port } = collector.address() as AddressInfo;

  collectorPort = port;

  sentryDsn = `http://0000000000000000000000000000088a@127.0.0.1:${port}/888`;

  network.listen({ onUnhandledFrame: 'error' });

  syncBuiltinESMExports();
});

afterAll(async () => {
  network.close();

  syncBuiltinESMExports();

  await new Promise((resolve) => collector.close(resolve));
});

beforeEach(() => {
  vi.resetModules();

  waited.length = 0;

  bodyWaits.length = 0;

  envelopes.length = 0;

  collectorRequests.length = 0;

  posthogRequests.length = 0;

  posthogTraceRequests.length = 0;

  posthogAnswer = () => HttpResponse.json({ results: {} });

  trace.disable();

  context.disable();

  for (const [name, value] of Object.entries({ ...baseEnv, SENTRY_DSN: sentryDsn })) vi.stubEnv(name, value);

  Object.assign(globalThis, {
    [REQUEST_CONTEXT]: { get: () => ({ waitUntil: (promise: Promise<unknown>) => void waited.push(promise) }) },
  });
});

afterEach(async () => {
  posthogAnswer = () => HttpResponse.json({ results: {} });

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
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  const body = Buffer.concat(chunks);

  return (request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString('utf8');
}

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

function otherWaits(): Promise<unknown>[] {
  return waited.filter((promise) => !bodyWaits.includes(promise));
}

const ONTOLOGY_URL = 'https://test-app-staging.ontos.example/api/v2/ontologies/x/objectSets/aggregate';
const CLIENT_CONFIG_URL = 'https://test-app-staging.ontos.example/api/ontology-service/v1/client-config';

async function ontologyPost(init: RequestInit = {}): Promise<Request> {
  const headers = new Headers(init.headers);

  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${await issuer.workos()}`);

  return new Request(ONTOLOGY_URL, { method: 'POST', ...init, headers });
}

interface SentryEvent {
  readonly tags?: Record<string, unknown>;
  readonly exception?: { readonly values?: { readonly value?: string }[] };
}

function sentryEvents(): SentryEvent[] {
  return envelopes.flatMap((envelope) => {
    const lines = envelope.split('\n').filter((line) => line !== '');
    const found: SentryEvent[] = [];

    for (let index = 1; index + 1 < lines.length; index += 2) {
      const header = JSON.parse(lines[index] ?? '{}') as { type?: string };

      if (header.type === 'event') found.push(JSON.parse(lines[index + 1] ?? '{}') as SentryEvent);
    }

    return found;
  });
}

function reportedIds(): unknown[] {
  return sentryEvents().map((event) => event.tags?.['errorInstanceId']);
}

function posthogEvents(): CapturedPosthogEvent[] {
  return posthogRequests.flatMap((request) => request.batch);
}

describe('fault reports', () => {
  it('service/observability#error-reports: 2 equal faults in a row give 2 error reports at Sentry and PostHog', async () => {
    vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

    vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

    const adapter = await importAdapter();

    const answered: unknown[] = [];

    for (let request = 0; request < 2; request += 1) {
      const response = await send(adapter, await ontologyPost());

      expect(response.status).toBe(503);

      answered.push(((await response.json()) as { errorInstanceId: string }).errorInstanceId);

      await Promise.all(waited);
    }

    expect(answered).toHaveLength(2);
    expect(reportedIds()).toEqual(answered);

    expect(
      posthogEvents().map((event) => ({
        event: event.event,
        id: event.properties?.['errorInstanceId'],
        name: event.properties?.['errorName'],
      })),
    ).toEqual(answered.map((id) => ({ event: '$exception', id, name: 'OntologyService:EngineChangesFailed' })));
  });

  it('service/observability#error-reports: a 4xx response reports to neither Sentry nor PostHog', async () => {
    vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

    vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

    const adapter = await importAdapter();

    const badTokenRequest = await send(
      adapter,
      new Request('https://test-app-staging.ontos.example/multipass/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=unknown',
      }),
    );

    expect(badTokenRequest.status).toBe(400);

    await badTokenRequest.text();

    const missing = await send(adapter, new Request('https://test-app-staging.ontos.example/unknown'));

    expect(missing.status).toBe(404);

    await missing.text();

    await Promise.all(waited);

    expect(sentryEvents()).toEqual([]);
    expect(posthogEvents()).toEqual([]);
  });

  it('service/observability#error-reports: invalid trace variables report at cold start to Sentry only and disable PostHog error reporting', async () => {
    vi.stubEnv('TRACES_POSTHOG_REGION', 'ap');

    vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

    const adapter = await importAdapter();

    const response = await send(adapter, await ontologyPost());

    expect(response.status).toBe(503);

    const { errorInstanceId } = (await response.json()) as { errorInstanceId: string };

    await Promise.all(waited);

    expect(
      sentryEvents().map((event) => ({
        message: event.exception?.values?.at(-1)?.value,
        id: event.tags?.['errorInstanceId'],
      })),
    ).toEqual([
      { message: expect.stringContaining('TRACES_POSTHOG_REGION'), id: undefined },
      { message: expect.any(String), id: errorInstanceId },
    ]);

    expect(posthogRequests).toEqual([]);
  });

  it('service/observability#error-reports: invalid TRACES_SAMPLE_RATE reports to Sentry only while valid PostHog error reporting stays on', async () => {
    vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

    vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

    vi.stubEnv('TRACES_SAMPLE_RATE', '2');

    const posthogFlush = vi.spyOn(PostHog.prototype, 'flush');

    const adapter = await importAdapter();

    const ok = await send(adapter, new Request(CLIENT_CONFIG_URL));

    expect(ok.status).toBe(200);

    await ok.text();

    await Promise.all(waited);

    expect(posthogFlush).not.toHaveBeenCalled();
    expect(posthogEvents()).toEqual([]);
    expect(sentryEvents()).toHaveLength(1);
    expect(sentryEvents()[0]?.exception?.values?.at(-1)?.value).toContain('TRACES_SAMPLE_RATE');

    const fault = await send(adapter, await ontologyPost());

    expect(fault.status).toBe(503);

    const { errorInstanceId } = (await fault.json()) as { errorInstanceId: string };

    await Promise.all(waited);

    expect(posthogFlush).toHaveBeenCalledTimes(1);
    expect(posthogEvents()).toHaveLength(1);
    expect(posthogEvents()[0]?.properties?.['errorInstanceId']).toBe(errorInstanceId);
    expect(posthogEvents()[0]?.properties?.['$trace_id']).toBeUndefined();
    expect(posthogEvents()[0]?.properties?.['$span_id']).toBeUndefined();
  });

  it('service/observability#error-reports: strips authorization headers, cookies, and request bodies from PostHog error reports', async () => {
    vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

    vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

    const authCanary = ['CANARY', 'AUTH', 'TOKEN'].join('_');
    const cookieCanary = ['CANARY', 'COOKIE'].join('_');
    const headerCanary = ['CANARY', 'HEADER', 'SECRET'].join('_');
    const bodyCanary = ['CANARY', 'BODY', 'VALUE'].join('_');

    vi.stubEnv('ONTOS_AUTH_MODE', 'dev');

    vi.stubEnv('ONTOS_DEV_TOKEN', authCanary);

    const adapter = await importAdapter();

    const response = await send(
      adapter,
      new Request(ONTOLOGY_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authCanary}`,
          cookie: `session=${cookieCanary}`,
          'x-custom-secret': headerCanary,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ secret: bodyCanary }),
      }),
    );

    expect(response.status).toBe(503);

    await response.text();

    await Promise.all(waited);

    expect(posthogRequests).toHaveLength(1);

    const raw = posthogRequests[0]?.rawBody ?? '';

    for (const secret of [
      authCanary,
      cookieCanary,
      headerCanary,
      bodyCanary,
      '$request',
      '$headers',
      '$cookies',
      '$request_body',
      '$ip',
    ]) {
      expect(raw).not.toContain(secret);
    }

    const properties = posthogEvents()[0]?.properties ?? {};

    for (const forbidden of [
      'request',
      '$request',
      'headers',
      '$headers',
      'cookies',
      '$cookies',
      'body',
      '$body',
      'requestBody',
      '$request_body',
      '$ip',
    ]) {
      expect(properties).not.toHaveProperty(forbidden);
    }
  });

  it('service/observability#error-reports: a PostHog 500 or network error never breaks the 5xx response or Sentry reporting', async () => {
    for (const answer of [() => new HttpResponse(null, { status: 500 }), () => HttpResponse.error()]) {
      vi.resetModules();

      waited.length = 0;

      bodyWaits.length = 0;

      envelopes.length = 0;

      posthogRequests.length = 0;

      vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

      vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

      posthogAnswer = answer;

      const sentryFlush = vi.spyOn(Sentry.NodeClient.prototype, 'flush');

      const adapter = await importAdapter();

      const response = await send(adapter, await ontologyPost());

      expect(response.status).toBe(503);

      const { errorInstanceId } = (await response.json()) as { errorInstanceId: string };

      await Promise.all(waited);

      expect(sentryFlush.mock.calls).toEqual([[2000]]);
      expect(reportedIds()).toEqual([errorInstanceId]);

      sentryFlush.mockRestore();
    }
  });

  it('service/observability#error-reports: a hung PostHog flush is bounded to 2000 ms and never breaks the 5xx response or Sentry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

      vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

      vi.stubEnv('TRACES_SAMPLE_RATE', '0');

      posthogAnswer = () => new Promise(() => undefined);

      const adapter = await importAdapter();

      const response = await send(adapter, await ontologyPost());

      expect(response.status).toBe(503);

      const { errorInstanceId } = (await response.json()) as { errorInstanceId: string };

      expect(otherWaits()).toHaveLength(1);

      let settled = false;

      void otherWaits()[0]?.then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(1_999);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      await otherWaits()[0];

      expect(settled).toBe(true);
      expect(reportedIds()).toEqual([errorInstanceId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['both', 'sentry', 'posthog', 'neither'] as const)(
    'service/observability#error-reports: bounded waitUntil flush handles destination state %s',
    async (state) => {
      const sentryOn = state === 'both' || state === 'sentry';
      const posthogOn = state === 'both' || state === 'posthog';

      vi.stubEnv('SENTRY_DSN', sentryOn ? sentryDsn : undefined);

      if (posthogOn) {
        vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

        vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

        vi.stubEnv('TRACES_SAMPLE_RATE', '0');
      }

      const sentryFlush = vi.spyOn(Sentry.NodeClient.prototype, 'flush');
      const posthogFlush = vi.spyOn(PostHog.prototype, 'flush');

      const adapter = await importAdapter();

      const request = await ontologyPost();

      const response = await send(adapter, request);

      expect(response.status).toBe(503);

      await response.text();

      const flushes = otherWaits();
      const expectedFlushes = { both: [undefined], sentry: [true], posthog: [undefined], neither: [] }[state];

      expect(await Promise.all(flushes)).toEqual(expectedFlushes);

      await Promise.all(waited);

      expect(sentryFlush).toHaveBeenCalledTimes(sentryOn ? 1 : 0);
      expect(posthogFlush).toHaveBeenCalledTimes(posthogOn ? 1 : 0);
    },
  );

  it('exports spans to OTEL_EXPORTER_OTLP_ENDPOINT with OTEL_EXPORTER_OTLP_HEADERS even when SENTRY_DSN is unset', async () => {
    vi.stubEnv('SENTRY_DSN', undefined);

    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${collectorPort}/otel`);

    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'x-otlp-token=secret%20value,x-tenant=ontos');

    const adapter = await importAdapter();

    const response = await send(adapter, new Request(CLIENT_CONFIG_URL));

    expect(response.status).toBe(200);

    await response.text();

    await Promise.all(waited);

    expect(collectorRequests).toContainEqual(
      expect.objectContaining({
        url: '/otel/v1/traces',
        headers: expect.objectContaining({
          'x-otlp-token': 'secret value',
          'x-tenant': 'ontos',
        }),
      }),
    );
  });

  it('records invalid OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS in badVariables without crashing', () => {
    const result = startTracing(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url',
        OTEL_EXPORTER_OTLP_HEADERS: 'malformed-header',
      },
      '0.0.0',
    );

    expect(result.badVariables).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS']);
  });

  it('does not leak OTEL_EXPORTER_OTLP_HEADERS or OTEL_EXPORTER_OTLP_TRACES_HEADERS to Sentry or PostHog exporters', async () => {
    vi.stubEnv('TRACES_SENTRY', 'true');

    vi.stubEnv('TRACES_POSTHOG_REGION', 'us');

    vi.stubEnv('TRACES_POSTHOG_TOKEN', 'phc_test');

    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${collectorPort}/otel`);

    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'x-otlp-token=secret%20value,x-tenant=ontos');

    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'x-traces-secret=trace-only-secret');

    const adapter = await importAdapter();

    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('x-otlp-token=secret%20value,x-tenant=ontos');
    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS).toBe('x-traces-secret=trace-only-secret');

    const response = await send(adapter, new Request(CLIENT_CONFIG_URL));

    expect(response.status).toBe(200);

    await response.text();

    await Promise.all(waited);

    const otlpRequest = collectorRequests.find((entry) => entry.url === '/otel/v1/traces');
    const sentryRequest = collectorRequests.find((entry) => entry.url.includes('/integration/otlp/v1/traces'));
    const posthogRequest = posthogTraceRequests.find((entry) => entry.url === 'https://us.i.posthog.com/i/v1/traces');

    expect(otlpRequest?.headers['x-otlp-token']).toBe('secret value');
    expect(otlpRequest?.headers['x-tenant']).toBe('ontos');
    expect(otlpRequest?.headers['x-traces-secret']).toBeUndefined();

    expect(sentryRequest?.headers['x-sentry-auth']).toEqual(expect.any(String));
    expect(sentryRequest?.headers['x-otlp-token']).toBeUndefined();
    expect(sentryRequest?.headers['x-tenant']).toBeUndefined();
    expect(sentryRequest?.headers['x-traces-secret']).toBeUndefined();

    expect(posthogRequest?.headers['authorization']).toBe('Bearer phc_test');
    expect(posthogRequest?.headers['x-otlp-token']).toBeUndefined();
    expect(posthogRequest?.headers['x-tenant']).toBeUndefined();
    expect(posthogRequest?.headers['x-traces-secret']).toBeUndefined();
  });
});
