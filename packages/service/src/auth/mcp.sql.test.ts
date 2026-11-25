import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { LOAD_ACCOUNTS, publishBody, startInstalled, type Installed } from './installed.test-utils.ts';
import { remoteKeys, workosUsers } from './index.ts';
import { handle, routes, settingsFromEnv, type HandleInput, type Route } from '../handler/index.ts';
import { TOOLS } from '../mcp/tools.ts';
import {
  errorAnswer,
  testEnv,
  testInput,
  testMcpSettings,
  testSettings,
  TEST_ONTOLOGY_RID,
} from '../service.test-utils.ts';
import {
  AUTHKIT_DOMAIN,
  createTestIssuer,
  MCP_CLIENT,
  now,
  ORGANIZATION,
  PERSON,
  type TestIssuer,
} from '../tokens.test-utils.ts';
import { STUB_PERSON, STUB_WORKOS_KEY, stubWorkos } from '../workos.test-utils.ts';

const base = 'http://localhost';
const MCP = `${base}/api/mcp`;
const METADATA = `${base}/api/oauth-protected-resource`;
const LOAD_OBJECTS = `${base}/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectSets/loadObjects`;
const PUBLISH = `${base}/api/ontology-service/v1/publish`;
const WWW_AUTHENTICATE = 'Bearer resource_metadata="http://localhost/api/oauth-protected-resource"';
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

const LOAD_CALL = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'load_objects', arguments: LOAD_ACCOUNTS },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let issuer: TestIssuer;
let installed: Installed;
let input: HandleInput;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, 'jobsite:read');

  const workos = stubWorkos([STUB_PERSON], undefined, {
    roles: { [ORGANIZATION]: { member: ['jobsite:read', 'ontology:install'] } },
  });

  input = {
    ...testInput,
    settings: testMcpSettings,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }),
  };
});

afterAll(() => installed?.stop());

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => vi.restoreAllMocks());

function post(
  url: string,
  authorization: string | undefined,
  handleInput: HandleInput = input,
  body: object = PING,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(authorization === undefined ? {} : { authorization }),
  };

  return handle(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }), handleInput);
}

function routeAt(method: string, path: string): Route {
  const route = routes.find((candidate) => candidate.method === method && candidate.path.endsWith(path));

  if (route === undefined) throw new Error(`The route table has no ${method} ${path}.`);

  return route;
}

async function expectPerson(response: Response, user: string = PERSON): Promise<void> {
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 200,
    body: { jsonrpc: '2.0', id: 1, result: {} },
  });

  expect(JSON.parse(String(consoleLog.mock.lastCall?.[0]))).toMatchObject({ userId: user, callerKind: 'person' });
}

async function expectMcpUnauthorized(response: Response, errorName = 'Default:Unauthorized'): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE);

  expect(await response.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName,
    errorInstanceId: expect.stringMatching(UUID),
    parameters: {},
  });
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.has('www-authenticate')).toBe(false);

  expect(await response.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName: 'Default:Unauthorized',
    errorInstanceId: expect.stringMatching(UUID),
    parameters: {},
  });
}

describe('service/authentication#tokens: the MCP route accepts only a token of the AuthKit domain', () => {
  it('service/authentication#tokens service/authentication#ontology-mcp-tokens: an AuthKit token for the MCP URL passes, as the person of its sub', async () => {
    await expectPerson(await post(MCP, `Bearer ${await issuer.authkit()}`));
  });

  it('service/authentication#tokens service/authentication#ontology-mcp-tokens: a valid WorkOS token of the CLI gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.workos()}`));
  });

  it('service/authentication#tokens service/authentication#ontology-mcp-tokens: a valid WorkOS token of a web app, with an aud, gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.workos({ aud: 'https://app.example.com' })}`));
  });

  it('service/authentication#tokens service/authentication#ontology-mcp-tokens: a valid GitHub token of the publish workflow gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.github()}`));
  });

  it('service/authentication#ontology-mcp-tokens: a WorkOS token with the aud of the MCP URL still gets 401, because its iss is not the AuthKit issuer', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.workos({ aud: 'http://localhost/api/mcp' })}`));
  });
});

describe('service/authentication#ontology-mcp-tokens: the AuthKit issuer is https:// plus the AuthKit domain', () => {
  it('service/authentication#ontology-mcp-tokens: iss https://test-app.authkit.app passes', async () => {
    await expectPerson(await post(MCP, `Bearer ${await issuer.authkit({ iss: 'https://test-app.authkit.app' })}`));
  });

  it.each([
    ['the iss of another AuthKit domain', 'https://other-app.authkit.app'],
    ['the AuthKit domain with http', 'http://test-app.authkit.app'],
    ['the AuthKit domain with a path', 'https://test-app.authkit.app/'],
    ['the WorkOS iss of the app', 'https://api.workos.com/user_management/client_test'],
  ])('service/authentication#ontology-mcp-tokens: %s gets 401', async (_case, iss) => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({ iss })}`));
  });

  it('service/authentication#ontology-mcp-tokens: a token with no iss gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({ iss: undefined })}`));
  });
});

describe('service/authentication#ontology-mcp-tokens: the signature by the JWKS at the AuthKit issuer plus /oauth2/jwks', () => {
  it('service/authentication#ontology-mcp-tokens: a token signed by a key that the AuthKit JWKS does not hold gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({}, { key: 'stranger' })}`));
  });

  it('service/authentication#ontology-mcp-tokens: a token with a kid that the AuthKit JWKS does not have gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({}, { kid: 'unknown-key' })}`));
  });

  it('service/authentication#ontology-mcp-tokens: an AuthKit token signed by the WorkOS key of the app gets 401', async () => {
    const token = await issuer.workos({ iss: `https://${AUTHKIT_DOMAIN}`, aud: 'http://localhost/api/mcp' });

    await expectMcpUnauthorized(await post(MCP, `Bearer ${token}`));
  });

  it('service/authentication#ontology-mcp-tokens: the remote key source reads https://test-app.authkit.app/oauth2/jwks', async () => {
    const fetched: string[] = [];

    const keys = remoteKeys(testSettings.auth, {
      authkitDomain: AUTHKIT_DOMAIN,
      fetch: (jwksUrl: string) => {
        fetched.push(jwksUrl);

        return Promise.resolve(Response.json(issuer.jwks.authkit));
      },
    });

    await expectPerson(await post(MCP, `Bearer ${await issuer.authkit()}`, { ...input, keys }));

    expect(fetched).toEqual(['https://test-app.authkit.app/oauth2/jwks']);
  });
});

describe('service/authentication#ontology-mcp-tokens: exp in the future, and a sub', () => {
  it('service/authentication#ontology-mcp-tokens: an expired token gets 401', async () => {
    await expectMcpUnauthorized(
      await post(MCP, `Bearer ${await issuer.authkit({ iat: now() - 600, exp: now() - 300 })}`),
    );
  });

  it('service/authentication#ontology-mcp-tokens: a token with no exp gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({ exp: undefined })}`));
  });

  it('service/authentication#ontology-mcp-tokens: a token with no sub gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({ sub: undefined })}`));
  });

  it('service/authentication#ontology-mcp-tokens: the user ID of the caller is the sub, with the caller kind person', async () => {
    await expectPerson(
      await post(MCP, `Bearer ${await issuer.authkit({ sub: 'user_01TEST00000000000000000007' })}`),
      'user_01TEST00000000000000000007',
    );
  });
});

describe('service/authentication#ontology-mcp-tokens: aud is the MCP URL of the environment', () => {
  it('service/authentication#ontology-mcp-tokens: aud http://localhost/api/mcp, the base URL plus /api/mcp, passes', async () => {
    await expectPerson(await post(MCP, `Bearer ${await issuer.authkit({ aud: 'http://localhost/api/mcp' })}`));
  });

  it.each([
    ['the base URL', 'http://localhost'],
    ['the MCP URL of a Vercel deployment URL', 'https://ontology-abc123.vercel.app/api/mcp'],
    ['the MCP URL of a customer domain', 'https://app.example.com/api/mcp'],
    ['another path of the base URL', 'http://localhost/api/v2'],
  ])('service/authentication#ontology-mcp-tokens: aud %s gets 401', async (_case, aud) => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({ aud })}`));
  });

  it('service/authentication#ontology-mcp-tokens: a token with no aud gets 401', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.authkit({ aud: undefined })}`));
  });

  it('service/ontology-mcp#route: the MCP URL comes from ONTOLOGY_BASE_URL, not from the host of the request', async () => {
    const onCustomerDomain = 'https://app.example.com/api/mcp';

    await expectMcpUnauthorized(
      await post(onCustomerDomain, `Bearer ${await issuer.authkit({ aud: onCustomerDomain })}`),
    );

    await expectPerson(
      await post(onCustomerDomain, `Bearer ${await issuer.authkit({ aud: 'http://localhost/api/mcp' })}`),
    );
  });

  it('service/authentication#ontology-mcp-tokens: the MCP route does not check client_id', async () => {
    await expectPerson(await post(MCP, `Bearer ${await issuer.authkit({ client_id: undefined })}`));
  });
});

describe('service/authentication#ontology-mcp-tokens: a 401 of the MCP route has the WWW-Authenticate header', () => {
  it('service/authentication#ontology-mcp-tokens service/authentication#errors service/code-layout#seams: no token gets 401 MissingCredentials with the header', async () => {
    await expectMcpUnauthorized(await post(MCP, undefined), 'MissingCredentials');
  });

  it('service/authentication#ontology-mcp-tokens service/authentication#errors: a refused token gets 401 Default:Unauthorized with the header', async () => {
    await expectMcpUnauthorized(await post(MCP, 'Bearer not-a-jwt'));
  });

  it('service/authentication#ontology-mcp-tokens: GET /api/mcp with no token gets the same 401', async () => {
    const response = await handle(new Request(MCP), input);

    await expectMcpUnauthorized(response, 'MissingCredentials');
  });

  it('service/authentication#errors service/code-layout#seams: a 401 of an OSDK route has no WWW-Authenticate header', async () => {
    const response = await handle(new Request(LOAD_OBJECTS, { method: 'POST', body: '{}' }), input);

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 401,
      body: expect.objectContaining({ errorName: 'MissingCredentials' }),
    });

    expect(response.headers.has('www-authenticate')).toBe(false);
  });
});

describe('service/authentication#ontology-mcp-tokens: GET /api/oauth-protected-resource needs no token', () => {
  const metadata = { resource: 'http://localhost/api/mcp', authorization_servers: ['https://test-app.authkit.app'] };

  it('service/authentication#ontology-mcp-tokens: gives resource, the MCP URL, and authorization_servers, the AuthKit issuer', async () => {
    const response = await handle(new Request(METADATA), input);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);

    expect(await response.json()).toEqual(metadata);
  });

  it('service/authentication#ontology-mcp-tokens: answers with a token that fails its checks too', async () => {
    const response = await handle(new Request(METADATA, { headers: { authorization: 'Bearer not-a-jwt' } }), input);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual(metadata);
  });

  it.each([
    ['a customer domain', 'https://app.example.com/api/oauth-protected-resource'],
    ['a Vercel deployment URL', 'https://ontology-abc123.vercel.app/api/oauth-protected-resource'],
  ])('service/ontology-mcp#route: on %s, resource is still the MCP URL of the base URL', async (_case, url) => {
    const response = await handle(new Request(url), input);

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual(metadata);
  });
});

describe('service/ontology-mcp#route: the Ontology MCP is on when ONTOLOGY_MCP is true', () => {
  async function expectEmpty404(response: Response): Promise<void> {
    expect(response.status).toBe(404);

    expect(await response.text()).toBe('');
  }

  const off = (value: string | undefined): HandleInput => ({
    ...input,
    settings: settingsFromEnv({ ...testEnv, ...(value === undefined ? {} : { ONTOLOGY_MCP: value }) }),
  });

  for (const value of ['false', undefined, 'TRUE', '1']) {
    it(`service/ontology-mcp#route: with ONTOLOGY_MCP ${String(value)}, POST /api/mcp with a valid AuthKit token, with no token, GET /api/mcp, and the metadata route each get 404 with an empty body`, async () => {
      await expectEmpty404(await post(MCP, `Bearer ${await issuer.authkit()}`, off(value)));

      await expectEmpty404(await post(MCP, undefined, off(value)));

      await expectEmpty404(await handle(new Request(MCP), off(value)));

      await expectEmpty404(await handle(new Request(METADATA), off(value)));
    });
  }

  it('service/ontology-mcp#route: with ONTOLOGY_MCP true, both routes answer', async () => {
    const on: HandleInput = { ...input, settings: settingsFromEnv({ ...testEnv, ONTOLOGY_MCP: 'true' }) };

    const mcp = await post(MCP, `Bearer ${await issuer.authkit()}`, on);

    expect({ status: mcp.status, body: await mcp.json() }).toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: {} },
    });

    const metadata = await handle(new Request(METADATA), on);

    expect({ status: metadata.status, body: await metadata.json() }).toEqual({
      status: 200,
      body: expect.objectContaining({ resource: 'http://localhost/api/mcp' }),
    });
  });
});

describe('service/authentication#ontology-mcp-tokens: the MCP route refuses the token of a service user', () => {
  it('service/authentication#ontology-mcp-tokens service/ontology-mcp#route: a service user token gets 401 with the WWW-Authenticate header', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.m2m()}`));
  });

  it('service/ontology-mcp#route: a service user token whose aud is the MCP URL still gets 401, because its sub is no person of the MCP route', async () => {
    await expectMcpUnauthorized(await post(MCP, `Bearer ${await issuer.m2m({ aud: 'http://localhost/api/mcp' })}`));
  });
});

describe('service/authentication#people: the OSDK routes and the publish route have no rule on aud', () => {
  it('service/authentication#people: a WorkOS token with an aud passes on loadObjects', async () => {
    const route = routeAt('POST', '/objectSets/loadObjects');

    if (route.access !== 'ontology') throw new Error('loadObjects is not an ontology route.');

    const run = vi.spyOn(route, 'run');

    const headers = {
      authorization: `Bearer ${await issuer.workos({ aud: 'https://app.example.com' })}`,
      'content-type': 'application/json',
    };

    const response = await handle(
      new Request(LOAD_OBJECTS, { method: 'POST', headers, body: JSON.stringify(LOAD_ACCOUNTS) }),
      input,
    );

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: expect.objectContaining({ data: expect.any(Array) }),
    });

    expect(run.mock.lastCall?.[1].caller).toMatchObject({ user: PERSON, kind: 'person' });
  });

  it('service/authentication#people: a WorkOS token with an aud passes on the publish route, with validateOnly', async () => {
    const route = routeAt('POST', '/v1/publish');

    if (route.access !== 'publish') throw new Error('The publish route is not a publish route.');

    const run = vi.spyOn(route, 'run');

    const headers = {
      authorization: `Bearer ${await issuer.workos({ aud: 'https://app.example.com' })}`,
      'content-type': 'application/json',
    };

    const response = await handle(
      new Request(PUBLISH, { method: 'POST', headers, body: JSON.stringify(publishBody('jobsite:read', true)) }),
      input,
    );

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: expect.objectContaining({ changes: expect.any(Array) }),
    });

    expect(run.mock.lastCall?.[1].caller).toMatchObject({ user: PERSON, kind: 'person' });
  });
});

describe('the OSDK routes and the publish route refuse an AuthKit token', () => {
  it('loadObjects with a valid AuthKit token gets 401 Default:Unauthorized', async () => {
    const response = await handle(
      new Request(LOAD_OBJECTS, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.authkit()}` },
        body: '{}',
      }),
      input,
    );

    await expectUnauthorized(response);
  });

  it('the publish route with a valid AuthKit token gets 401 Default:Unauthorized', async () => {
    const response = await handle(
      new Request(PUBLISH, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.authkit()}` },
        body: '{"validateOnly":true}',
      }),
      input,
    );

    await expectUnauthorized(response);
  });

  it('the refusal holds with the MCP off too', async () => {
    const response = await handle(
      new Request(LOAD_OBJECTS, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.authkit()}` },
        body: '{}',
      }),
      { ...input, settings: testSettings },
    );

    await expectUnauthorized(response);
  });
});

describe('service/ontology-mcp#route: the MCP route does what each OSDK route does around the engine', () => {
  it('service/ontology-mcp#route service/code-layout#seams: the route gets the Web Request, the parsed body, and a ctx with the caller and the current Ontology', async () => {
    const route = routeAt('POST', '/api/mcp');

    if (route.access !== 'mcp') throw new Error('The MCP route is not an mcp route.');

    const run = vi.spyOn(route, 'run');
    const tool = TOOLS.find(({ name }) => name === 'load_objects');

    if (tool === undefined) throw new Error('The MCP has no load_objects tool.');

    const call = vi.spyOn(tool, 'call');

    const response = await post(MCP, `Bearer ${await issuer.authkit()}`, input, LOAD_CALL);

    const answer = (await response.json()) as { result?: { isError?: boolean; structuredContent?: unknown } };

    expect({
      status: response.status,
      isError: answer.result?.isError,
      content: answer.result?.structuredContent,
    }).toEqual({ status: 200, isError: undefined, content: expect.objectContaining({ data: expect.any(Array) }) });

    const [routeInput] = run.mock.lastCall ?? [];

    expect({ method: routeInput?.request.method, url: routeInput?.request.url, body: routeInput?.body }).toEqual({
      method: 'POST',
      url: 'http://localhost/api/mcp',
      body: LOAD_CALL,
    });

    const ctx = call.mock.lastCall?.[1];

    expect({ caller: ctx?.caller, ontologyVersion: ctx?.ontology.version }).toEqual({
      caller: {
        user: PERSON,
        kind: 'person',
        organization: 'org_01TEST0RG00000000000000001',
        permissions: ['jobsite:read', 'ontology:install'],
      },
      ontologyVersion: 1,
    });
  });

  it('service/ontology-mcp#route: writes 1 request log line, with the userId, the ontologyVersion, and the mcp field', async () => {
    const response = await post(MCP, `Bearer ${await issuer.authkit()}`, input, LOAD_CALL);

    expect(response.status).toBe(200);

    await response.json();

    expect(consoleLog).toHaveBeenCalledTimes(1);

    expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toEqual({
      userId: PERSON,
      callerKind: 'person',
      ontologyVersion: 1,
      mcp: { method: 'tools/call', tool: 'load_objects', clientId: MCP_CLIENT },
      traceId: expect.any(String),
    });
  });

  it('service/ontology-mcp#route: a body that is not JSON gets 400 Default:InvalidArgument', async () => {
    const request = new Request(MCP, {
      method: 'POST',
      headers: { authorization: `Bearer ${await issuer.authkit()}` },
      body: 'not json',
    });

    const response = await handle(request, input);

    expect(errorAnswer({ status: response.status, body: await response.json() })).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: {} },
    });
  });

  it('service/ontology-mcp#route: a query parameter outside V1 gets 400 Default:InvalidArgument, before the MCP route runs', async () => {
    const response = await post(`${MCP}?branch=main`, `Bearer ${await issuer.authkit()}`);

    expect(errorAnswer({ status: response.status, body: await response.json() })).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { feature: 'branch' } },
    });
  });
});

describe('service/ontology-mcp#errors: a fault before the route reads the message keeps its HTTP status', () => {
  it('service/ontology-mcp#errors: a JWKS fetch that fails gives 500 Default:Internal, not 401', async () => {
    const authkit = () => Promise.reject(new TypeError('fetch failed'));

    const response = await post(MCP, `Bearer ${await issuer.authkit()}`, {
      ...input,
      keys: { ...issuer.keys, authkit },
    });

    expect(response.headers.has('www-authenticate')).toBe(false);

    expect(errorAnswer({ status: response.status, body: await response.json() })).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });
  });
});
