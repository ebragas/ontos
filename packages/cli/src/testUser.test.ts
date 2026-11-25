import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cli,
  stubExchange,
  replay,
  STUB,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  tempFolder,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const AUTHENTICATE = 'https://api.workos.com/user_management/authenticate';
const PASSWORD = 'pw-literal-123';
const API_KEY = 'sk_test_literal_456';

const SHELL = {
  ONTOLOGY_TEST_USER_EMAIL: 'ci+twin@example.com',
  ONTOLOGY_TEST_USER_PASSWORD: PASSWORD,
  WORKOS_API_KEY: API_KEY,
};

const TEST_USER_ACCESS = `header.${Buffer.from(JSON.stringify({ org_id: 'org_01TEST0RG00000000000000001', role: 'admin' })).toString('base64url')}.signature`;

const form = (call: Call): Record<string, string> => Object.fromEntries(new URLSearchParams(call.body ?? ''));

function workos(): Handler {
  let issued = 0;

  return (call) => {
    if (call.url !== AUTHENTICATE) return undefined;

    const fields = form(call);

    if (fields['grant_type'] === 'password')
      return Response.json({ user: { id: 'user_test' }, access_token: TEST_USER_ACCESS, refresh_token: 'refresh-0' });

    if (fields['grant_type'] === 'refresh_token' && fields['refresh_token'] === `refresh-${issued}`) {
      issued += 1;

      return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}` });
    }

    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  };
}

const ACCOUNT = 'com.example.twin.Account';

const READ = [
  'objects',
  ACCOUNT,
  '--page-size',
  '2',
  '--order-by',
  '{"name":"asc"}',
  '--app',
  'twin',
  '--url',
  STUB,
  '--test-user',
];

const files = (folder: string): string =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');

describe('ontology login --test-user', () => {
  it('service/cli#sign-in: 1 password sign-in, then 2 reads with refreshed access tokens and no new password sign-in', async () => {
    const fetch = stubFetch(stubConfig, workos(), replay(stubExchange('client', 1), stubExchange('client', 2)));
    const tokens = tempFolder();

    const login = await cli(['login', '--app', 'twin', '--url', STUB, '--test-user'], { fetch, tokens, env: SHELL });

    expect(login.error).toBeUndefined();

    expect(login.output).toEqual({
      loggedIn: 'twin/staging-test-user',
      user: 'user_test',
      organization: 'org_01TEST0RG00000000000000001',
      role: 'admin',
    });

    for (let read = 0; read < 2; read += 1) {
      const run = await cli(READ, { fetch, tokens });

      expect(run.error).toBeUndefined();
      expect(run.code).toBe(0);
    }

    const workosCalls = fetch.calls.filter(({ url }) => url === AUTHENTICATE).map(form);

    expect(workosCalls).toEqual([
      {
        grant_type: 'password',
        client_id: STUB_CONFIG.workosClientId,
        client_secret: API_KEY,
        email: SHELL.ONTOLOGY_TEST_USER_EMAIL,
        password: PASSWORD,
      },
      { grant_type: 'refresh_token', refresh_token: 'refresh-0', client_id: STUB_CONFIG.workosClientId },
      { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: STUB_CONFIG.workosClientId },
    ]);

    const reads = fetch.calls
      .filter(({ url }) => url.startsWith(STUB) && !url.endsWith('/client-config'))
      .map(({ headers }) => headers['authorization']);

    expect(new Set(reads)).toEqual(new Set(['Bearer access-1', 'Bearer access-2']));
    expect(readFileSync(join(tokens, 'twin/staging-test-user'), 'utf8')).toBe('refresh-2');
  });

  it('service/cli#sign-in: the test user sign-in has its own file, and never replaces the token of a person', async () => {
    const tokens = tempFolder({ 'twin/staging': 'person-refresh' });

    const run = await cli(['login', '--app', 'twin', '--url', STUB, '--test-user'], {
      fetch: stubFetch(stubConfig, workos()),
      tokens,
      env: SHELL,
    });

    expect(run.code).toBe(0);
    expect(readdirSync(join(tokens, 'twin')).sort()).toEqual(['staging', 'staging-test-user']);
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('person-refresh');

    const person = await cli(['describe', '--app', 'twin', '--url', STUB], {
      fetch: stubFetch(stubConfig, workos()),
      tokens,
    });

    expect(person.error).toMatchObject({
      message: expect.stringContaining('WorkOS no longer accepts the stored token of twin/staging:'),
    });

    const logout = await cli(['logout', '--app', 'twin', '--test-user'], { tokens });

    expect(logout.output).toEqual({ loggedOut: 'twin/staging-test-user' });
    expect(readdirSync(join(tokens, 'twin'))).toEqual(['staging']);
  });

  it('with no stored test user token, the error names ontology login --test-user', async () => {
    const run = await cli(READ, {
      fetch: stubFetch(stubConfig),
      tokens: tempFolder({ 'twin/staging': 'person-refresh' }),
    });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message: 'No stored token for twin/staging-test-user: run ontos login --app twin --env staging --test-user.',
    });
  });

  it('service/cli#sign-in: each command that the rule lists takes --test-user, so it reaches the check of the preset token', async () => {
    const commands = [
      ['login'],
      ['logout'],
      ['describe'],
      ['objects', ACCOUNT],
      ['aggregate', ACCOUNT, '--select', '{"$count":"unordered"}'],
      ['apply', ACCOUNT],
      ['history', ACCOUNT],
      ['validate'],
      ['publish'],
    ];

    for (const command of commands) {
      const fetch = stubFetch();

      const run = await cli([...command, '--app', 'twin', '--url', STUB, '--test-user'], {
        fetch,
        env: { ONTOLOGY_TOKEN: 't' },
      });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message:
          '--test-user calls as the stored test user, so it does not take ONTOLOGY_TOKEN: unset ONTOLOGY_TOKEN, or remove --test-user.',
      });

      expect(fetch.calls).toEqual([]);
    }
  });

  it('service/cli#sign-in: each other command refuses --test-user', async () => {
    for (const command of [['generate-osdk'], ['install', 'twin', '--api-name', 'acme', '--display-name', 'Acme']]) {
      const fetch = stubFetch();

      const run = await cli([...command, '--test-user'], { fetch, env: SHELL });

      expect(run.code).toBe(1);

      expect(run.error).toMatchObject({
        message: expect.stringContaining(`ontos ${command[0]} does not take --test-user.`),
      });

      expect(fetch.calls).toEqual([]);
    }
  });

  it('service/cli#sign-in: a preset token variable in the shell or in .env stops a --test-user command before any call, and the error names it', async () => {
    const cases = [
      { variable: 'ONTOLOGY_TOKEN', env: { ONTOLOGY_TOKEN: 'other-identity-token' }, files: {} },
      { variable: 'ONTOLOGY_TOKEN', env: {}, files: { '.env': 'ONTOLOGY_TOKEN=other-identity-token' } },
      {
        variable: 'ACTIONS_ID_TOKEN_REQUEST_URL',
        env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.test', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' },
        files: {},
      },
    ];

    for (const { variable, env, files } of cases) {
      for (const command of [['login'], ['objects', 'com.example.twin.Account']]) {
        const fetch = stubFetch(stubConfig, workos());

        const run = await cli([...command, '--app', 'twin', '--url', STUB, '--test-user'], {
          fetch,
          env: { ...SHELL, ...env },
          cwd: tempFolder(files),
          tokens: tempFolder({ 'twin/staging-test-user': 'refresh-0' }),
        });

        expect(run.code).toBe(1);

        expect(run.error).toEqual({
          message: `--test-user calls as the stored test user, so it does not take ${variable}: unset ${variable}, or remove --test-user.`,
        });

        expect(fetch.calls).toEqual([]);
      }
    }
  });

  it('service/cli#sign-in: --env production stops login --test-user and a read before any call', async () => {
    for (const command of [['login'], ['objects', ACCOUNT]]) {
      const fetch = stubFetch(stubConfig, workos());

      const run = await cli([...command, '--app', 'twin', '--env', 'production', '--test-user'], { fetch, env: SHELL });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message: '--test-user acts on staging only. The production environment of twin has no test user.',
      });

      expect(fetch.calls).toEqual([]);
    }
  });

  it('service/cli#sign-in: the 3 values only in .env stop the sign-in before any call, and the error names the 3 shell variables', async () => {
    const env = Object.entries(SHELL)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n');

    const fetch = stubFetch(stubConfig, workos());

    const run = await cli(['login', '--app', 'twin', '--url', STUB, '--test-user'], {
      fetch,
      cwd: tempFolder({ '.env': env }),
    });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message:
        'ontos login --test-user reads ONTOLOGY_TEST_USER_EMAIL, ONTOLOGY_TEST_USER_PASSWORD, WORKOS_API_KEY from the shell, not from .env. Set each of them.',
    });

    expect(fetch.calls).toEqual([]);
  });

  it('no output and no token file holds the password or the API key, on success and on a refused sign-in', async () => {
    const tokens = tempFolder();

    const ok = await cli(['login', '--app', 'twin', '--url', STUB, '--test-user'], {
      fetch: stubFetch(stubConfig, workos()),
      tokens,
      env: SHELL,
    });

    const refusing: Handler = ({ url }) =>
      url === AUTHENTICATE
        ? Response.json({ code: 'invalid_credentials', message: 'Invalid credentials.' }, { status: 400 })
        : undefined;

    const refused = await cli(['login', '--app', 'twin', '--url', STUB, '--test-user'], {
      fetch: stubFetch(stubConfig, refusing),
      tokens: tempFolder(),
      env: SHELL,
    });

    expect(ok.code).toBe(0);
    expect(refused.code).toBe(1);
    expect(refused.error).toEqual({ code: 'invalid_credentials', message: 'Invalid credentials.' });

    const seen = [ok.stdout, ok.stderr, refused.stdout, refused.stderr, files(tokens)].join('\n');

    expect(seen).not.toContain(PASSWORD);
    expect(seen).not.toContain(API_KEY);
  });
});
