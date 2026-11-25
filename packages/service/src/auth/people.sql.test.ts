import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SignJWT } from 'jose';
import { LOAD_ACCOUNTS, startInstalled, type Installed } from './installed.test-utils.ts';
import { remoteKeys } from './index.ts';
import { handle, routes, type HandleInput } from '../handler/index.ts';
import { testInput, testSettings, TEST_ONTOLOGY_RID } from '../service.test-utils.ts';
import { createTestIssuer, now, ORGANIZATION, PERSON, type TestIssuer } from '../tokens.test-utils.ts';
import { STUB_PERSON, stubUsers } from '../workos.test-utils.ts';

const url = `http://localhost/api/v2/ontologies/${TEST_ONTOLOGY_RID}/objectSets/loadObjects`;
const OTHER_PERSON = 'user_01TEST00000000000000000007';
const loadObjects = routes.find((route) => route.method === 'POST' && route.path.endsWith('/objectSets/loadObjects'));
let issuer: TestIssuer;
let installed: Installed;
let input: HandleInput;
let consoleLog: MockInstance<typeof console.log>;
let run: MockInstance;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, 'jobsite:read');

  const users = stubUsers([STUB_PERSON, { ...STUB_PERSON, id: OTHER_PERSON }], undefined, {
    roles: { [ORGANIZATION]: { member: ['jobsite:read'] } },
  });

  input = { ...testInput, db: installed.db, directDb: installed.db, keys: issuer.keys, users };
});

afterAll(() => installed?.stop());

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');

  if (loadObjects === undefined) throw new Error('The route table has no loadObjects route.');

  run = vi.spyOn(loadObjects, 'run');
});

afterEach(() => {
  consoleLog.mockRestore();

  run.mockRestore();
});

function send(authorization: string | undefined, handleInput: HandleInput = input): Promise<Response> {
  const headers: Record<string, string> = authorization === undefined ? {} : { authorization };

  return handle(new Request(url, { method: 'POST', headers, body: JSON.stringify(LOAD_ACCOUNTS) }), handleInput);
}

async function expectPerson(response: Response, user: string = PERSON): Promise<void> {
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 200,
    body: expect.objectContaining({ data: expect.any(Array) }),
  });

  const [routeInput, ctx] = run.mock.calls.at(-1) ?? [];

  expect({ caller: ctx?.caller, body: routeInput?.body }).toEqual({
    caller: { user, kind: 'person', organization: ORGANIZATION, permissions: ['jobsite:read'] },
    body: LOAD_ACCOUNTS,
  });
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);

  expect(await response.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName: 'Default:Unauthorized',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
}

async function expectMissingCredentials(response: Response): Promise<void> {
  expect(response.status).toBe(401);

  expect(await response.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName: 'MissingCredentials',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
}

describe('service/authentication#tokens: the bearer token in the Authorization header', () => {
  it('service/authentication#tokens: a WorkOS token as "Bearer <token>" passes', async () => {
    await expectPerson(await send(`Bearer ${await issuer.workos()}`));
  });

  it('service/authentication#tokens: a token with another scheme is no bearer token', async () => {
    await expectMissingCredentials(await send(`Basic ${await issuer.workos()}`));
  });

  it('service/authentication#tokens: a token with no scheme is no bearer token', async () => {
    await expectMissingCredentials(await send(await issuer.workos()));
  });

  it('service/authentication#tokens: "Bearer" with no token is no bearer token', async () => {
    await expectMissingCredentials(await send('Bearer '));
  });
});

describe('service/authentication#tokens: the signature by the JWKS of the issuer, iss, and exp', () => {
  it('service/authentication#tokens: a token signed by a key that is not in the JWKS gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({}, { key: 'stranger' })}`));
  });

  it('service/authentication#tokens: a token with a kid that the JWKS does not have gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({}, { kid: 'unknown-key' })}`));
  });

  it('service/authentication#tokens: a WorkOS token signed by the GitHub key gets 401', async () => {
    const github = await issuer.github({
      iss: 'https://api.workos.com/user_management/client_test',
      sub: PERSON,
      client_id: 'client_test',
      aud: undefined,
      repository: undefined,
      environment: undefined,
    });

    await expectUnauthorized(await send(`Bearer ${github}`));
  });

  it('service/authentication#tokens: an expired token gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ iat: now() - 600, exp: now() - 300 })}`));
  });

  it('service/authentication#tokens: a token with no exp gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ exp: undefined })}`));
  });

  it('service/authentication#tokens: a token from an unknown iss gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ iss: 'https://issuer.example.com' })}`));
  });

  it('service/authentication#tokens: a token with no iss gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ iss: undefined })}`));
  });

  it('service/authentication#tokens: a token signed with a shared secret (HS256), not by the JWKS, gets 401', async () => {
    const secret = new TextEncoder().encode('a-shared-secret-of-32-bytes-long');

    const token = await new SignJWT({ sub: PERSON, client_id: 'client_test' })
      .setProtectedHeader({ alg: 'HS256', kid: 'workos-key' })
      .setIssuer('https://api.workos.com/user_management/client_test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

    await expectUnauthorized(await send(`Bearer ${token}`));
  });

  it('service/authentication#tokens: a bearer token that is not a JWT gets 401', async () => {
    await expectUnauthorized(await send('Bearer not-a-jwt'));
  });
});

describe('service/authentication#people: a WorkOS token passes only with the client ID of the app', () => {
  it('service/authentication#people: a token with iss, sub, client_id, and no aud passes', async () => {
    await expectPerson(await send(`Bearer ${await issuer.workos({ client_id: 'client_test' })}`));
  });

  it('service/authentication#people: a token with the client ID of another WorkOS environment gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ client_id: 'client_other' })}`));
  });

  it('service/authentication#people: a token with no client_id gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ client_id: undefined })}`));
  });
});

describe('service/authentication#people: the iss of a WorkOS token', () => {
  it('service/authentication#people: iss https://api.workos.com/user_management/<client ID> passes', async () => {
    await expectPerson(
      await send(`Bearer ${await issuer.workos({ iss: 'https://api.workos.com/user_management/client_test' })}`),
    );
  });

  it('service/authentication#people: the legacy iss https://api.workos.com gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ iss: 'https://api.workos.com' })}`));
  });

  it('service/authentication#people: the user_management iss of another client ID gets 401', async () => {
    await expectUnauthorized(
      await send(`Bearer ${await issuer.workos({ iss: 'https://api.workos.com/user_management/client_other' })}`),
    );
  });

  it('service/authentication#people: the iss of a custom sign-in domain gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ iss: 'https://auth.example.com' })}`));
  });
});

describe('service/authentication#people: the JWKS URL of the WorkOS environment', () => {
  it('service/authentication#people: the remote key source reads https://api.workos.com/sso/jwks/<client ID>', async () => {
    const fetched: string[] = [];

    const keys = remoteKeys(testSettings.auth, {
      fetch: (jwksUrl: string) => {
        fetched.push(jwksUrl);

        return Promise.resolve(Response.json(issuer.jwks.workos));
      },
    });

    await expectPerson(await send(`Bearer ${await issuer.workos()}`, { ...input, keys }));

    expect(fetched).toEqual(['https://api.workos.com/sso/jwks/client_test']);
  });
});

describe('the user ID is the sub of the token', () => {
  it('a person gets the WorkOS user ID of the sub', async () => {
    await expectPerson(await send(`Bearer ${await issuer.workos({ sub: OTHER_PERSON })}`), OTHER_PERSON);
  });

  it('a token with no sub gets 401', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ sub: undefined })}`));
  });
});

describe('service/authentication#errors: MissingCredentials and Default:Unauthorized', () => {
  it('service/authentication#errors: a request with no Authorization header gets 401 MissingCredentials', async () => {
    await expectMissingCredentials(await send(undefined));
  });

  it('service/authentication#errors: a token that fails a check gets 401 Default:Unauthorized', async () => {
    await expectUnauthorized(await send(`Bearer ${await issuer.workos({ client_id: 'client_other' })}`));
  });
});

describe('service/code-layout#libraries: the auth module checks tokens with jose', () => {
  it('service/code-layout#libraries: the auth module imports jose, and the service depends on it', () => {
    const folder = new URL('./', import.meta.url);

    const sources = readdirSync(folder)
      .filter((name) => name.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(name))
      .map((name) => readFileSync(new URL(name, folder), 'utf8'));

    expect(sources.some((source) => /from 'jose';/.test(source))).toBe(true);

    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(pkg.dependencies).toHaveProperty('jose');
  });
});

describe('service/observability#logs: the userId of the request log', () => {
  function line(): Record<string, unknown> {
    expect(consoleLog).toHaveBeenCalledTimes(1);

    return JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as Record<string, unknown>;
  }

  it('service/observability#logs: a token that passes gives the userId of its sub', async () => {
    await (await send(`Bearer ${await issuer.workos()}`)).text();

    expect(line().userId).toBe(PERSON);
  });

  it('service/observability#logs: a token that fails gives no userId', async () => {
    await (await send(`Bearer ${await issuer.workos({ exp: now() - 300 })}`)).text();

    expect(line()).not.toHaveProperty('userId');
  });
});
