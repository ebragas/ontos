import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cli,
  STUB,
  STUB_CONFIG,
  STUB_ONTOLOGY,
  stubConfig,
  stubFetch,
  tempFolder,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const WORKOS = 'https://api.workos.com/user_management';
const ACME = 'org_01TEST0RG00000000000000001';
const GLOBEX = 'org_01TEST0RG00000000000000002';

const accessToken = (claims: Readonly<Record<string, string>>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

const AUTHENTICATE = `${WORKOS}/authenticate`;
const form = (call: Call): Record<string, string> => Object.fromEntries(new URLSearchParams(call.body ?? ''));

interface SignIn {
  readonly claims: Readonly<Record<string, string>>;
  readonly refresh: string;
}

function workos(signIns: readonly SignIn[], organizations: Readonly<Record<string, SignIn>> = {}): Handler {
  const left = [...signIns];

  return (call) => {
    if (call.url === `${WORKOS}/authorize/device`) {
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

    if (fields['grant_type'] === 'refresh_token') {
      if (fields['organization_id'] === undefined)
        return Response.json({ access_token: accessToken(IN_ACME.claims), refresh_token: 'refresh-later' });

      const scoped = organizations[fields['organization_id']];

      if (!scoped)
        return Response.json(
          { error: 'invalid_grant', error_description: 'The session cannot access the organization.' },
          { status: 400 },
        );

      return Response.json({
        user: { id: 'user_1' },
        access_token: accessToken(scoped.claims),
        refresh_token: scoped.refresh,
      });
    }

    const signIn = left.shift();

    return signIn
      ? Response.json({
          user: { id: 'user_1' },
          access_token: accessToken(signIn.claims),
          refresh_token: signIn.refresh,
        })
      : Response.json({ error: 'invalid_grant' }, { status: 400 });
  };
}

const LOGIN = ['login', '--app', 'twin', '--url', STUB];
const NO_CLAIMS: SignIn = { claims: {}, refresh: 'refresh-unscoped' };
const IN_ACME: SignIn = { claims: { org_id: ACME, role: 'admin' }, refresh: 'refresh-acme' };
const IN_GLOBEX: SignIn = { claims: { org_id: GLOBEX, role: 'member' }, refresh: 'refresh-globex' };
const ORGANIZATIONS_URL = `${STUB}/api/ontology-service/v1/organizations`;

const organizationList =
  (...data: readonly { readonly id: string; readonly name: string }[]): Handler =>
  ({ method, url }) =>
    method === 'GET' && url === ORGANIZATIONS_URL ? Response.json({ data }) : undefined;

const warnings = (stderr: string): unknown[] =>
  stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .flatMap((line) => (line['warning'] === undefined ? [] : [line['warning']]));

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const grants = (fetch: ReturnType<typeof stubFetch>): (string | undefined)[] =>
  fetch.calls.filter(({ url }) => url === AUTHENTICATE).map((call) => form(call)['grant_type']);

describe('the Organization of ontology login', () => {
  it('service/cli#sign-in: --org refreshes the new token with organization_id, and stores the refreshed token', async () => {
    const tokens = tempFolder();
    const fetch = stubFetch(stubConfig, workos([NO_CLAIMS], { [ACME]: IN_ACME }));

    const login = await cli([...LOGIN, '--org', ACME], { fetch, tokens });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');

    expect(
      fetch.calls
        .filter(({ url }) => url === AUTHENTICATE)
        .map(form)
        .at(-1),
    ).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-unscoped',
      client_id: STUB_CONFIG.workosClientId,
      organization_id: ACME,
    });
  });

  it('service/authentication#organizations, service/cli#sign-in: a new ontology login --org switches the Organization, and replaces the 1 token of the app and environment', async () => {
    const tokens = tempFolder();
    const fetch = stubFetch(stubConfig, workos([NO_CLAIMS, NO_CLAIMS], { [ACME]: IN_ACME, [GLOBEX]: IN_GLOBEX }));

    const first = await cli([...LOGIN, '--org', ACME], { fetch, tokens });

    expect(first.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');

    const second = await cli([...LOGIN, '--org', GLOBEX], { fetch, tokens });

    expect(second.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: GLOBEX, role: 'member' });
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-globex');
    expect(readdirSync(join(tokens, 'twin'))).toEqual(['staging']);
  });

  it('service/cli#commands: login signs in as a person or as the test user after client-config, and logout removes each stored token', async () => {
    const tokens = tempFolder();

    const fetch = stubFetch(
      stubConfig,
      workos([
        { claims: { org_id: ACME, role: 'admin' }, refresh: 'refresh-person' },
        { claims: { org_id: ACME, role: 'member' }, refresh: 'refresh-test-user' },
      ]),
    );

    const person = await cli(LOGIN, { fetch, tokens });

    expect(person.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });

    const testUser = await cli([...LOGIN, '--test-user'], {
      fetch,
      tokens,
      env: {
        ONTOLOGY_TEST_USER_EMAIL: 'ci+twin@example.com',
        ONTOLOGY_TEST_USER_PASSWORD: 'pw',
        WORKOS_API_KEY: 'sk_test',
      },
    });

    expect(testUser.output).toEqual({
      loggedIn: 'twin/staging-test-user',
      user: 'user_1',
      organization: ACME,
      role: 'member',
    });

    expect(fetch.calls.filter(({ url }) => url.startsWith(STUB)).map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/ontology-service/v1/client-config',
      '/api/ontology-service/v1/client-config',
    ]);

    expect(readdirSync(join(tokens, 'twin')).sort()).toEqual(['staging', 'staging-test-user']);

    const logout = await cli(['logout', '--app', 'twin'], { tokens });

    expect(logout.output).toEqual({ loggedOut: 'twin/staging' });
    expect(readdirSync(join(tokens, 'twin'))).toEqual(['staging-test-user']);

    const logoutTestUser = await cli(['logout', '--app', 'twin', '--test-user'], { tokens });

    expect(logoutTestUser.output).toEqual({ loggedOut: 'twin/staging-test-user' });
    expect(readdirSync(join(tokens, 'twin'))).toEqual([]);
  });

  it('service/cli#sign-in: --test-user with --org refreshes the password sign-in into the Organization', async () => {
    const tokens = tempFolder();

    const env = {
      ONTOLOGY_TEST_USER_EMAIL: 'ci+twin@example.com',
      ONTOLOGY_TEST_USER_PASSWORD: 'pw-literal-123',
      WORKOS_API_KEY: 'sk_test_literal_456',
    };

    const login = await cli([...LOGIN, '--test-user', '--org', ACME], {
      fetch: stubFetch(stubConfig, workos([NO_CLAIMS], { [ACME]: IN_ACME })),
      tokens,
      env,
    });

    expect(login.output).toEqual({
      loggedIn: 'twin/staging-test-user',
      user: 'user_1',
      organization: ACME,
      role: 'admin',
    });

    expect(readFileSync(join(tokens, 'twin/staging-test-user'), 'utf8')).toBe('refresh-acme');
  });

  it('service/cli#sign-in: with no --org, login keeps the token that carries an Organization, and prints its Organization and role', async () => {
    const tokens = tempFolder();
    const fetch = stubFetch(stubConfig, workos([IN_ACME]));

    const login = await cli(LOGIN, { fetch, tokens });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });
    expect(login.stderr).not.toContain('warning');

    expect(
      fetch.calls
        .filter(({ url }) => url === AUTHENTICATE)
        .map(form)
        .map(({ grant_type }) => grant_type),
    ).toEqual(['urn:ietf:params:oauth:grant-type:device_code']);
  });

  it('service/cli#sign-in: a service with no Organizations route gets the warning that names --org, and login exits 0', async () => {
    const tokens = tempFolder();

    const login = await cli(LOGIN, { fetch: stubFetch(stubConfig, workos([NO_CLAIMS])), tokens });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1' });

    expect(warnings(login.stderr)).toEqual([
      'This token has no Organization. If you belong to an Organization, run ontos login --app twin --env staging --org <id>. If not, join or create an Organization.',
    ]);

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
  });

  it('service/cli#sign-in: with 1 Organization, login refreshes into it with no second sign-in', async () => {
    const tokens = tempFolder();

    const fetch = stubFetch(
      organizationList({ id: ACME, name: 'Acme' }),
      stubConfig,
      workos([NO_CLAIMS], { [ACME]: IN_ACME }),
    );

    const login = await cli(LOGIN, { fetch, tokens });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });
    expect(warnings(login.stderr)).toEqual([]);
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');
    expect(fetch.calls.filter(({ url }) => url === `${WORKOS}/authorize/device`).length).toBe(1);
    expect(grants(fetch)).toEqual([DEVICE_GRANT, 'refresh_token']);

    expect(fetch.calls.find(({ url }) => url === ORGANIZATIONS_URL)?.headers['authorization']).toBe(
      `Bearer ${accessToken(NO_CLAIMS.claims)}`,
    );
  });

  it('service/cli#sign-in: with several Organizations, login prints each name and ID, names the next step, and exits 0', async () => {
    const tokens = tempFolder();

    const fetch = stubFetch(
      organizationList({ id: ACME, name: 'Acme' }, { id: GLOBEX, name: 'Globex' }),
      stubConfig,
      workos([NO_CLAIMS]),
    );

    const login = await cli(LOGIN, { fetch, tokens });

    expect(login.code).toBe(0);

    expect(login.output).toEqual({
      loggedIn: 'twin/staging',
      user: 'user_1',
      organizations: [
        { id: ACME, name: 'Acme' },
        { id: GLOBEX, name: 'Globex' },
      ],
    });

    expect(warnings(login.stderr)).toEqual([
      'You belong to more than 1 Organization. Run ontos login --app twin --env staging --org <id> with 1 of the listed IDs.',
    ]);

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
  });

  it('service/cli#sign-in: with no Organization, login says to join or create one, and exits 0', async () => {
    const login = await cli(LOGIN, { fetch: stubFetch(organizationList(), stubConfig, workos([NO_CLAIMS])) });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1' });

    expect(warnings(login.stderr)).toEqual([
      'You belong to no Organization of this environment. Join or create an Organization.',
    ]);
  });

  const FAILED_STEP =
    'The sign-in worked, and the token is stored. If you belong to an Organization, run ontos login --app twin --env staging --org <id>. If not, join or create an Organization.';

  it.each([
    [503, 'HTTP 503'],
    [500, 'HTTP 500'],
    [429, 'HTTP 429'],
  ] as const)(
    'service/cli#sign-in: a %i from the list warns what failed, with 1 try, and login exits 0',
    async (status, reason) => {
      const tokens = tempFolder();

      const failing: Handler = ({ method, url }) =>
        method === 'GET' && url === ORGANIZATIONS_URL ? new Response('<html>down</html>', { status }) : undefined;

      const fetch = stubFetch(failing, stubConfig, workos([NO_CLAIMS]));

      const login = await cli(LOGIN, { fetch, tokens });

      expect(login.code).toBe(0);
      expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1' });
      expect(warnings(login.stderr)).toEqual([`The list of your Organizations failed: ${reason}. ${FAILED_STEP}`]);
      expect(login.stderr).not.toContain('<html>');
      expect(fetch.calls.filter(({ url }) => url === ORGANIZATIONS_URL).length).toBe(1);
      expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
    },
  );

  const requestUrl = (input: string | URL | Request): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  it('service/cli#sign-in: a network error from the list warns what failed, and login exits 0', async () => {
    const stub = stubFetch(stubConfig, workos([NO_CLAIMS]));

    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      requestUrl(input) === ORGANIZATIONS_URL
        ? Promise.reject(new TypeError('fetch failed'))
        : stub(input, init)) as typeof globalThis.fetch;

    const login = await cli(LOGIN, { fetch });

    expect(login.code).toBe(0);
    expect(warnings(login.stderr)).toEqual([`The list of your Organizations failed: fetch failed. ${FAILED_STEP}`]);
  });

  it('service/cli#sign-in: a route that hangs stops after 10 seconds, warns what failed, and keeps the token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const tokens = tempFolder();
      const stub = stubFetch(stubConfig, workos([NO_CLAIMS]));

      const fetch = ((input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input) !== ORGANIZATIONS_URL) return stub(input, init);

        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
      }) as typeof globalThis.fetch;

      const running = cli(LOGIN, { fetch, tokens });

      await vi.advanceTimersByTimeAsync(10_000);

      const login = await running;

      expect(login.code).toBe(0);

      expect(warnings(login.stderr)).toEqual([
        `The list of your Organizations failed: no answer in 10 seconds. ${FAILED_STEP}`,
      ]);

      expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a string as data', { data: 'nope' }],
    ['an item with no name', { data: [{ id: ACME }] }],
    ['no data', {}],
  ] as const)('service/cli#sign-in: %s is an answer that the CLI cannot read', async (_, body) => {
    const malformed: Handler = ({ method, url }) =>
      method === 'GET' && url === ORGANIZATIONS_URL ? Response.json(body) : undefined;

    const login = await cli(LOGIN, { fetch: stubFetch(malformed, stubConfig, workos([NO_CLAIMS])) });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1' });

    expect(warnings(login.stderr)).toEqual([
      `The list of your Organizations failed: an answer that the CLI cannot read. ${FAILED_STEP}`,
    ]);
  });

  it('service/cli#sign-in: a 200 with an HTML body is an answer that the CLI cannot read, and the warning quotes no HTML', async () => {
    const html: Handler = ({ method, url }) =>
      method === 'GET' && url === ORGANIZATIONS_URL ? new Response('<html>sign in</html>', { status: 200 }) : undefined;

    const login = await cli(LOGIN, { fetch: stubFetch(html, stubConfig, workos([NO_CLAIMS])) });

    expect(login.code).toBe(0);

    expect(warnings(login.stderr)).toEqual([
      `The list of your Organizations failed: an answer that the CLI cannot read. ${FAILED_STEP}`,
    ]);

    expect(login.stderr).not.toContain('<html>');
  });

  it.each([
    ['null', 'null'],
    ['HTML', '<html>denied</html>'],
  ] as const)(
    'service/cli#sign-in: a 403 with the body %s names the status and the next step, and login exits 1',
    async (_, body) => {
      const tokens = tempFolder();

      const refused: Handler = ({ method, url }) =>
        method === 'GET' && url === ORGANIZATIONS_URL ? new Response(body, { status: 403 }) : undefined;

      const login = await cli(LOGIN, { fetch: stubFetch(refused, stubConfig, workos([NO_CLAIMS])), tokens });

      expect(login.code).toBe(1);

      const message =
        'The list of your Organizations gave 403. The token is stored. If you belong to an Organization, run ontos login --app twin --env staging --org <id>. If not, join or create an Organization.';

      expect(login.stderr.trim().split('\n').at(-1)).toBe(JSON.stringify({ message, status: 403 }));
      expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
    },
  );

  it('service/cli#sign-in: another status names the status and the next step, keeps the token, and login exits 1', async () => {
    const tokens = tempFolder();

    const refused: Handler = ({ method, url }) =>
      method === 'GET' && url === ORGANIZATIONS_URL
        ? Response.json({ errorName: 'Default:PermissionDenied' }, { status: 403 })
        : undefined;

    const login = await cli(LOGIN, { fetch: stubFetch(refused, stubConfig, workos([NO_CLAIMS])), tokens });

    expect(login.code).toBe(1);

    const message =
      'The list of your Organizations gave 403. The token is stored. If you belong to an Organization, run ontos login --app twin --env staging --org <id>. If not, join or create an Organization.';

    expect(login.stderr.trim().split('\n').at(-1)).toBe(
      JSON.stringify({ message, status: 403, errorName: 'Default:PermissionDenied' }),
    );

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
  });

  it('service/cli#sign-in: when WorkOS refuses the Organization that the list named, the token stays stored, and login exits 1', async () => {
    const tokens = tempFolder();

    const login = await cli(LOGIN, {
      fetch: stubFetch(
        organizationList({ id: GLOBEX, name: 'Globex' }),
        stubConfig,
        workos([NO_CLAIMS], { [ACME]: IN_ACME }),
      ),
      tokens,
    });

    expect(login.code).toBe(1);

    expect(login.stderr.trim().split('\n').at(-1)).toBe(
      JSON.stringify({ error: 'invalid_grant', error_description: 'The session cannot access the organization.' }),
    );

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
  });

  it('service/cli#sign-in: --org refreshes a stored token, with no new sign-in', async () => {
    const tokens = tempFolder();

    mkdirSync(join(tokens, 'twin'), { recursive: true });

    writeFileSync(join(tokens, 'twin/staging'), 'refresh-unscoped');

    const fetch = stubFetch(stubConfig, workos([], { [ACME]: IN_ACME }));

    const login = await cli([...LOGIN, '--org', ACME], { fetch, tokens });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });
    expect(fetch.calls.filter(({ url }) => url === `${WORKOS}/authorize/device`)).toEqual([]);

    expect(fetch.calls.filter(({ url }) => url === AUTHENTICATE).map(form)).toEqual([
      {
        grant_type: 'refresh_token',
        refresh_token: 'refresh-unscoped',
        client_id: STUB_CONFIG.workosClientId,
        organization_id: ACME,
      },
    ]);

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');
  });

  it('service/cli#sign-in: when the stored token cannot take the Organization, --org signs the person in', async () => {
    const tokens = tempFolder();

    mkdirSync(join(tokens, 'twin'), { recursive: true });

    writeFileSync(join(tokens, 'twin/staging'), 'refresh-expired');

    let refreshes = 0;

    const expired: Handler = (call) => {
      if (call.url !== AUTHENTICATE || form(call)['refresh_token'] !== 'refresh-expired') return undefined;

      refreshes += 1;

      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    };

    const fetch = stubFetch(expired, stubConfig, workos([NO_CLAIMS], { [ACME]: IN_ACME }));

    const login = await cli([...LOGIN, '--org', ACME], { fetch, tokens });

    expect(login.code).toBe(0);
    expect(refreshes).toBe(1);
    expect(login.output).toEqual({ loggedIn: 'twin/staging', user: 'user_1', organization: ACME, role: 'admin' });
    expect(fetch.calls.filter(({ url }) => url === `${WORKOS}/authorize/device`).length).toBe(1);
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');
  });

  it('service/cli#sign-in: when WorkOS refuses the Organization of --org, login shows the WorkOS error, and the stored token does not change', async () => {
    const tokens = tempFolder();

    mkdirSync(join(tokens, 'twin'), { recursive: true });

    writeFileSync(join(tokens, 'twin/staging'), 'refresh-before');

    const login = await cli([...LOGIN, '--org', GLOBEX], {
      fetch: stubFetch(stubConfig, workos([NO_CLAIMS], { [ACME]: IN_ACME })),
      tokens,
    });

    expect(login.code).toBe(1);

    expect(login.stderr.trim().split('\n').at(-1)).toBe(
      JSON.stringify({ error: 'invalid_grant', error_description: 'The session cannot access the organization.' }),
    );

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-before');
  });

  it('service/cli#sign-in: when WorkOS refuses the Organization of a first sign-in, login stores nothing', async () => {
    const tokens = tempFolder();

    const login = await cli([...LOGIN, '--org', GLOBEX], {
      fetch: stubFetch(stubConfig, workos([NO_CLAIMS], { [ACME]: IN_ACME })),
      tokens,
    });

    expect(login.code).toBe(1);
    expect(existsSync(join(tokens, 'twin/staging'))).toBe(false);
  });

  const MISMATCH = JSON.stringify({
    message: `WorkOS answered for the Organization ${ACME}, not ${GLOBEX}. The new token is stored. Run ontos login --app twin --env staging --org ${GLOBEX} again.`,
  });

  it('service/cli#sign-in: when the refresh for --org answers another Organization, login stores the new token, names both, and exits 1', async () => {
    const tokens = tempFolder();

    const login = await cli([...LOGIN, '--org', GLOBEX], {
      fetch: stubFetch(stubConfig, workos([NO_CLAIMS], { [GLOBEX]: IN_ACME })),
      tokens,
    });

    expect(login.code).toBe(1);
    expect(login.stderr.trim().split('\n').at(-1)).toBe(MISMATCH);
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');
  });

  it('service/cli#sign-in: when the refresh of a stored token for --org answers another Organization, login stores the new token, and exits 1 with no new sign-in', async () => {
    const tokens = tempFolder();

    mkdirSync(join(tokens, 'twin'), { recursive: true });

    writeFileSync(join(tokens, 'twin/staging'), 'refresh-unscoped');

    const fetch = stubFetch(stubConfig, workos([NO_CLAIMS], { [GLOBEX]: IN_ACME }));

    const login = await cli([...LOGIN, '--org', GLOBEX], { fetch, tokens });

    expect(login.code).toBe(1);
    expect(login.stderr.trim().split('\n').at(-1)).toBe(MISMATCH);
    expect(fetch.calls.filter(({ url }) => url === `${WORKOS}/authorize/device`)).toEqual([]);
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');
  });

  it('service/cli#sign-in: when the refresh into the 1 listed Organization answers another Organization, login stores the new token, and exits 1', async () => {
    const tokens = tempFolder();

    const fetch = stubFetch(
      organizationList({ id: GLOBEX, name: 'Globex' }),
      stubConfig,
      workos([NO_CLAIMS], { [GLOBEX]: IN_ACME }),
    );

    const login = await cli(LOGIN, { fetch, tokens });

    expect(login.code).toBe(1);
    expect(login.stderr.trim().split('\n').at(-1)).toBe(MISMATCH);
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-acme');
  });

  it('service/cli#sign-in: when the refresh for --org answers no Organization, login stores the new token, says so, and exits 1', async () => {
    const tokens = tempFolder();

    const login = await cli([...LOGIN, '--org', GLOBEX], {
      fetch: stubFetch(stubConfig, workos([NO_CLAIMS], { [GLOBEX]: NO_CLAIMS })),
      tokens,
    });

    expect(login.code).toBe(1);

    expect(login.stderr.trim().split('\n').at(-1)).toBe(
      JSON.stringify({
        message: `WorkOS answered for no Organization, not ${GLOBEX}. The new token is stored. Run ontos login --app twin --env staging --org ${GLOBEX} again.`,
      }),
    );

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-unscoped');
  });

  it('service/cli#sign-in: a later command refreshes the stored token with no organization_id', async () => {
    const tokens = tempFolder();

    const metadata = {
      ontology: { rid: STUB_ONTOLOGY.rid, apiName: 'ontology', displayName: 'Ontology', description: '' },
      objectTypes: {},
      actionTypes: {},
      queryTypes: {},
      interfaceTypes: {},
      sharedPropertyTypes: {},
      valueTypes: {},
    };

    const fullMetadata: Handler = ({ url }) =>
      new URL(url).pathname === `/api/v2/ontologies/${STUB_ONTOLOGY.rid}/fullMetadata`
        ? Response.json(metadata)
        : undefined;

    const fetch = stubFetch(stubConfig, fullMetadata, workos([NO_CLAIMS], { [ACME]: IN_ACME }));

    await cli([...LOGIN, '--org', ACME], { fetch, tokens });

    const describe = await cli(['describe', '--app', 'twin', '--url', STUB], { fetch, tokens });

    expect(describe.code).toBe(0);

    expect(
      fetch.calls
        .filter(({ url }) => url === AUTHENTICATE)
        .map(form)
        .at(-1),
    ).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-acme', client_id: STUB_CONFIG.workosClientId });

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-later');
  });

  it('service/cli#sign-in: an empty --org stops before any call', async () => {
    const fetch = stubFetch(stubConfig);

    const login = await cli([...LOGIN, '--org', ''], { fetch });

    expect(login.code).toBe(1);
    expect(login.error).toEqual({ message: '--org needs an Organization ID: ontos login --org <id>' });
    expect(fetch.calls).toEqual([]);
  });
});
