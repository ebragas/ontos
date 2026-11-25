import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAccessTokens } from './auth/provider.ts';
import { fileTokenStore } from './auth/store.ts';
import { run, type TokenStore } from './index.ts';
import { orThrow } from './fallible.ts';
import { resetMetadata } from './metadataCache.ts';
import { stubExchange, replay, STUB, stubConfig, stubFetch, type Call, type Handler } from './cli.test-utils.ts';

const AUTHENTICATE = 'https://api.workos.com/user_management/authenticate';
const DEVICE = 'https://api.workos.com/user_management/authorize/device';

const READ = [
  'objects',
  'com.example.twin.Account',
  '--page-size',
  '2',
  '--order-by',
  '{"name":"asc"}',
  '--app',
  'twin',
  '--url',
  STUB,
];

const TEST_USER_SHELL = {
  ONTOLOGY_TEST_USER_EMAIL: 'ci+twin@example.com',
  ONTOLOGY_TEST_USER_PASSWORD: 'pw',
  WORKOS_API_KEY: 'sk_test_key',
};

beforeEach(() => {
  resetMetadata();

  resetAccessTokens();
});

const form = (call: Call): Record<string, string> => Object.fromEntries(new URLSearchParams(call.body ?? ''));

const jwt = (claims: Readonly<Record<string, unknown>>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

const claims = (header: string | undefined): unknown =>
  JSON.parse(Buffer.from(header?.split('.')[1] ?? '', 'base64url').toString('utf8'));

function workos() {
  let issued = 0;
  const organizations = new Map<string, string>();
  const state = { lifetime: 300 as number | undefined };

  const tokens = (organization: string) => {
    issued += 1;

    const exp = state.lifetime === undefined ? {} : { exp: Math.floor(Date.now() / 1000) + state.lifetime };

    organizations.set(`refresh-${issued}`, organization);

    return Response.json({
      user: { id: 'user_1' },
      access_token: jwt({ sid: `access-${issued}`, org_id: organization, ...exp }),
      refresh_token: `refresh-${issued}`,
    });
  };

  const handler: Handler = (call) => {
    if (call.url === DEVICE) {
      return Response.json({
        device_code: 'd',
        user_code: 'RRGQ-BJVS',
        verification_uri: 'https://auth.example/device',
        verification_uri_complete: 'https://auth.example/device?user_code=RRGQ-BJVS',
        expires_in: 300,
        interval: 5,
      });
    }

    if (call.url !== AUTHENTICATE) return undefined;

    const fields = form(call);

    if (fields['grant_type'] !== 'refresh_token') return tokens('org_A');

    const organization = organizations.get(fields['refresh_token'] ?? '');

    if (organization === undefined) return Response.json({ error: 'invalid_grant' }, { status: 400 });

    organizations.delete(fields['refresh_token'] ?? '');

    return tokens(fields['organization_id'] ?? organization);
  };

  return {
    handler,
    state,
    seed: (refreshToken: string, organization = 'org_A') => organizations.set(refreshToken, organization),
  };
}

function memoryStore(entries: Readonly<Record<string, string>>): TokenStore & { readonly tokens: Map<string, string> } {
  const tokens = new Map(Object.entries(entries));

  return {
    tokens,
    read: (key) => Promise.resolve(tokens.get(key)),
    write: (key, token, expected) => {
      if (expected === undefined || tokens.get(key) === expected) tokens.set(key, token);

      return Promise.resolve();
    },
    remove: (key) => {
      tokens.delete(key);

      return Promise.resolve();
    },
  };
}

function oneProcess() {
  const auth = workos();

  auth.seed('refresh-0');

  auth.seed('refresh-test-0');

  const fetch = stubFetch(stubConfig, auth.handler, replay(stubExchange('client', 1), stubExchange('client', 2)));
  const tokenStore = memoryStore({ 'twin/staging': 'refresh-0', 'twin/staging-test-user': 'refresh-test-0' });

  const ontology = async (args: readonly string[], env: Readonly<Record<string, string>> = {}) => {
    const before = fetch.calls.length;
    let stderr = '';

    const code = await run(args, {
      env,
      fetch,
      tokenStore,
      sleep: () => Promise.resolve(),
      stdout: () => undefined,
      stderr: (text) => (stderr += text),
    });

    const sent = fetch.calls
      .slice(before)
      .filter(({ url }) => url.startsWith(`${STUB}/api/v2/`))
      .map(({ headers }) => headers['authorization']);

    return { code, stderr, sent };
  };

  const refreshes = () =>
    fetch.calls.filter((call) => call.url === AUTHENTICATE && form(call)['grant_type'] === 'refresh_token').length;

  const lists = () =>
    fetch.calls
      .filter(({ method, url }) => method === 'GET' && url === `${STUB}/api/v2/ontologies`)
      .map(({ headers }) => headers['authorization']);

  return { auth, fetch, tokenStore, ontology, refreshes, lists };
}

describe('the access token of a stored sign-in in 1 process', () => {
  it('service/cli#sign-in: a config folder and a link to it are 1 token store, so a logout through the link ends the kept token', async () => {
    const { auth, fetch } = oneProcess();

    auth.seed('refresh-file');

    const real = mkdtempSync(join(tmpdir(), 'ontology-config-'));
    const link = `${real}-link`;

    symlinkSync(real, link);

    await orThrow(fileTokenStore(join(real, 'ontos', 'tokens'))).write('twin/staging', 'refresh-file');

    const command = (args: readonly string[], folder: string) =>
      run(args, {
        env: { XDG_CONFIG_HOME: folder },
        fetch,
        sleep: () => Promise.resolve(),
        stdout: () => undefined,
        stderr: () => undefined,
      });

    expect(await command(READ, real)).toBe(0);

    expect(await command(['logout', '--app', 'twin', '--url', STUB], link)).toBe(0);

    expect(await command(READ, real)).toBe(1);
  });

  it('service/cli#sign-in: a refresh that fails is not kept, so the next command refreshes again', async () => {
    const { auth, fetch, refreshes } = oneProcess();
    const tokenStore = memoryStore({ 'twin/staging': 'refresh-late' });

    const command = () =>
      run(READ, {
        env: {},
        fetch,
        tokenStore,
        sleep: () => Promise.resolve(),
        stdout: () => undefined,
        stderr: () => undefined,
      });

    expect(await command()).toBe(1);

    auth.seed('refresh-late');

    expect(await command()).toBe(0);

    expect(refreshes()).toBe(2);
  });

  it('service/cli#sign-in: 2 token stores with a token for the same app and environment never share an access token', async () => {
    const { auth, fetch, lists, refreshes } = oneProcess();

    auth.seed('refresh-other', 'org_B');

    const command = (tokenStore: TokenStore) =>
      run(READ, {
        env: {},
        fetch,
        tokenStore,
        sleep: () => Promise.resolve(),
        stdout: () => undefined,
        stderr: () => undefined,
      });

    expect(await command(memoryStore({ 'twin/staging': 'refresh-0' }))).toBe(0);

    expect(await command(memoryStore({ 'twin/staging': 'refresh-other' }))).toBe(0);

    expect(refreshes()).toBe(2);
    expect(lists().map(claims)).toMatchObject([{ org_id: 'org_A' }, { org_id: 'org_B' }]);
  });

  it('service/cli#sign-in: 2 commands with no token store share the file store of 1 config folder, and make 1 refresh', async () => {
    const { auth, fetch, refreshes } = oneProcess();

    auth.seed('refresh-file');

    const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'ontology-config-')) };

    await orThrow(fileTokenStore(join(env.XDG_CONFIG_HOME, 'ontos', 'tokens'))).write('twin/staging', 'refresh-file');

    const command = () =>
      run(READ, { env, fetch, sleep: () => Promise.resolve(), stdout: () => undefined, stderr: () => undefined });

    expect([await command(), await command()]).toEqual([0, 0]);

    expect(refreshes()).toBe(1);
  });

  it('service/cli#sign-in, service/cli#package: 2 commands make 1 refresh and 1 Ontology list, and send the same access token', async () => {
    const { ontology, refreshes, lists } = oneProcess();

    const first = await ontology(READ);

    const second = await ontology(READ);

    expect([first.code, second.code]).toEqual([0, 0]);
    expect(refreshes()).toBe(1);
    expect(lists()).toHaveLength(1);
    expect(new Set([...first.sent, ...second.sent]).size).toBe(1);
  });

  it.each([
    ['expires in 119 seconds', 119],
    ['has expired', -10],
    ['has no exp', undefined],
  ])('service/cli#sign-in: a token that %s is not sent again by the next command', async (_, lifetime) => {
    const { auth, ontology, refreshes } = oneProcess();

    auth.state.lifetime = lifetime;

    const first = await ontology(READ);

    auth.state.lifetime = 300;

    const second = await ontology(READ);

    const third = await ontology(READ);

    expect([first.code, second.code, third.code]).toEqual([0, 0, 0]);
    expect(refreshes()).toBe(2);
    expect(first.sent[0]).not.toBe(second.sent[0]);
    expect(third.sent[0]).toBe(second.sent[0]);
  });

  it('service/cli#sign-in, service/cli#package: a person and the test user of 1 target each get their own token and their own Ontology list', async () => {
    const { ontology, refreshes, lists } = oneProcess();
    const runs = [];

    for (const flags of [[], [], ['--test-user'], ['--test-user']]) runs.push(await ontology([...READ, ...flags]));

    expect(runs.map(({ code }) => code)).toEqual([0, 0, 0, 0]);
    expect(refreshes()).toBe(2);

    const [person, , testUser] = runs.map(({ sent }) => sent[0]);

    expect(person).not.toBe(testUser);
    expect(runs.map(({ sent }) => sent[0])).toEqual([person, person, testUser, testUser]);
    expect(lists()).toEqual([person, testUser]);
  });

  it('service/cli#sign-in, service/cli#package: 2 commands at the same time share 1 refresh and 1 Ontology list', async () => {
    const { ontology, refreshes, lists } = oneProcess();

    const runs = await Promise.all([ontology(READ), ontology(READ)]);

    expect(runs.map(({ code }) => code)).toEqual([0, 0]);
    expect(refreshes()).toBe(1);
    expect(lists()).toHaveLength(1);
    expect(new Set(runs.flatMap(({ sent }) => sent)).size).toBe(1);
  });

  it.each([[[]], [['--test-user']]])(
    'service/cli#sign-in: after logout %j, the next command sends no kept token',
    async (flags) => {
      const { ontology } = oneProcess();

      expect((await ontology([...READ, ...flags])).code).toBe(0);

      expect((await ontology(['logout', '--app', 'twin', ...flags])).code).toBe(0);

      const after = await ontology([...READ, ...flags]);

      expect(after.code).toBe(1);
      expect(JSON.parse(after.stderr)).toMatchObject({ message: expect.stringContaining('No stored token') });
      expect(after.sent).toEqual([]);
    },
  );

  it.each([
    ['login', [], {}, 'org_A'],
    ['login --org', ['--org', 'org_B'], {}, 'org_B'],
    ['login --test-user', ['--test-user'], TEST_USER_SHELL, 'org_A'],
  ])(
    'service/cli#sign-in: after %s, the next command sends a token of the new sign-in',
    async (_, flags, shell, organization) => {
      const { ontology } = oneProcess();
      const read = [...READ, ...flags.filter((flag) => flag === '--test-user')];

      const before = await ontology(read);

      expect((await ontology(['login', '--app', 'twin', '--url', STUB, ...flags], shell)).code).toBe(0);

      const after = await ontology(read);

      expect([before.code, after.code]).toEqual([0, 0]);
      expect(after.sent[0]).not.toBe(before.sent[0]);
      expect(claims(after.sent[0])).toMatchObject({ org_id: organization });
    },
  );
});
