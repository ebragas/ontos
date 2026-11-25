import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { STUB_ACCESS_TOKEN } from '../authkitToken.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY } from '../workos.test-utils.ts';

const TOKEN_PATH = '/multipass/api/oauth2/token';
const AUTHKIT_DOMAIN = 'test-app-staging.authkit.app';
const BASE_URL = 'https://test-app-staging.ontos.example';
const WORKOS_CLIENT_ID = 'client_01TESTADAPTER';
const APP = { repository: 'example/test-app', environment: 'publish-staging' };
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

const outbound: { readonly host: string; readonly path: string; readonly headers: IncomingHttpHeaders }[] = [];
let server: Server;
let issuer: TestIssuer;
let adapter: typeof import('../../api/index.ts');

beforeAll(async () => {
  issuer = await createTestIssuer({ workosClientId: WORKOS_CLIENT_ID, baseUrl: BASE_URL, app: APP }, AUTHKIT_DOMAIN);

  server = createServer((request, response) => {
    const host = request.headers['x-original-host'];

    if (typeof host === 'string') outbound.push({ host, path: request.url ?? '', headers: request.headers });

    const json = (body: unknown) =>
      void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (request.url === '/oauth2/token') return json(STUB_ACCESS_TOKEN);

    if (request.url === `/sso/jwks/${WORKOS_CLIENT_ID}`) return json(issuer.jwks.workos);

    if (request.url === `/user_management/users/${STUB_PERSON.id}`) return json(STUB_PERSON);

    response.writeHead(200).end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  const env: Record<string, string> = {
    PRODUCT_RID: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000926',
    ONTOLOGY_ENVIRONMENT: 'staging',
    ONTOLOGY_BASE_URL: BASE_URL,
    WORKOS_CLIENT_ID,
    AUTHKIT_DOMAIN,
    TRUSTED_GITHUB_REPOSITORY: APP.repository,
    TRUSTED_GITHUB_ENVIRONMENT: APP.environment,
    DATABASE_URL: 'postgresql://ontology_service:pooled@127.0.0.1:1/neondb',
    DATABASE_URL_DIRECT: 'postgresql://ontology_service:direct@127.0.0.1:1/neondb',
    WORKOS_API_KEY: STUB_WORKOS_KEY,
    SENTRY_DSN: `http://0000000000000000000000000000926a@127.0.0.1:${port}/926`,
  };

  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

  Object.assign(globalThis, { [REQUEST_CONTEXT]: { get: () => ({ waitUntil: () => undefined }) } });

  const realFetch = globalThis.fetch;

  // oxlint-disable-next-line landmines/no-test-doubles -- MSW answers before the fetch instrumentation of Sentry adds headers, so only a local server shows them. The WorkOS URL is a constant.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.host !== AUTHKIT_DOMAIN && url.host !== 'api.workos.com') return realFetch(request);

    const headers = new Headers(request.headers);

    headers.set('x-original-host', url.host);

    return realFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      duplex: 'half',
      signal: request.signal,
    } as RequestInit);
  });

  adapter = await import('../../api/index.ts');
});

afterAll(async () => {
  vi.unstubAllGlobals();

  vi.unstubAllEnvs();

  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);

  await new Promise((resolve) => server.close(resolve));
});

it('service/observability#error-reports: an outbound token request and a WorkOS read carry no sentry-trace and no baggage header', async () => {
  const token = await adapter.default.fetch(
    new Request(`${BASE_URL}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }),
  );

  const read = await adapter.default.fetch(
    new Request(`${BASE_URL}/api/v2/admin/users/getCurrent`, {
      headers: { authorization: `Bearer ${await issuer.workos()}` },
    }),
  );

  expect({ token: token.status, read: read.status }).toEqual({ token: 200, read: 200 });

  expect(
    outbound.map(({ host, path, headers }) => ({
      host,
      path,
      sentryTrace: headers['sentry-trace'],
      baggage: headers['baggage'],
    })),
  ).toEqual([
    { host: AUTHKIT_DOMAIN, path: '/oauth2/token', sentryTrace: undefined, baggage: undefined },
    { host: 'api.workos.com', path: `/sso/jwks/${WORKOS_CLIENT_ID}`, sentryTrace: undefined, baggage: undefined },
    {
      host: 'api.workos.com',
      path: `/user_management/users/${STUB_PERSON.id}`,
      sentryTrace: undefined,
      baggage: undefined,
    },
  ]);
});
