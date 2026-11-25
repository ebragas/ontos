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

const ACCOUNT = 'com.example.twin.Account';

const anyConfig: Handler = ({ method, url }) =>
  method === 'GET' && new URL(url).pathname === '/api/ontology-service/v1/client-config'
    ? Response.json(STUB_CONFIG)
    : undefined;

const firstOrigin = (calls: readonly Call[]): string | undefined =>
  calls[0] ? new URL(calls[0].url).origin : undefined;

async function originOf(
  args: readonly string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<string | undefined> {
  const fetch = stubFetch(anyConfig);

  await cli(['describe', ...args], { fetch, ...options });

  return firstOrigin(fetch.calls);
}

describe('the target of a command', () => {
  it('service/cli#targets: --app or ONTOLOGY_APP gives the app, which is 1 DNS label, --env gives the environment, the default is staging, and no environment variable selects it', async () => {
    expect(await originOf(['--app', 'acme'])).toBe('https://acme-staging.ontos.example');

    expect(await originOf([], { env: { ONTOLOGY_APP: 'acme' } })).toBe('https://acme-staging.ontos.example');

    expect(await originOf(['--app', 'acme', '--env', 'production'])).toBe('https://acme.ontos.example');

    expect(await originOf(['--app', 'acme'], { env: { ONTOLOGY_APP: 'other' } })).toBe(
      'https://acme-staging.ontos.example',
    );

    const env = { ONTOLOGY_APP: 'acme', ONTOLOGY_ENV: 'production', ONTOLOGY_ENVIRONMENT: 'production' };

    expect(await originOf([], { env })).toBe('https://acme-staging.ontos.example');

    const none = await cli(['describe'], { fetch: stubFetch(anyConfig) });

    expect(none.code).toBe(1);
    expect(none.error).toEqual({ message: 'No target: pass --url <url>, --app <name>, or set ONTOLOGY_APP.' });

    for (const app of ['attacker.example#', 'attacker.invalid/', 'Acme', '-acme', 'a.b']) {
      const fetch = stubFetch(anyConfig);

      const refused = await cli(['describe', `--app=${app}`], { fetch, env: { ONTOLOGY_TOKEN: 't' } });

      expect(refused.code).toBe(1);

      expect(refused.error).toEqual({
        message: `The app name is 1 DNS label of lowercase letters, digits, and hyphens, not ${app}.`,
      });

      expect(fetch.calls).toEqual([]);
    }

    const bad = await cli(['describe', '--app', 'acme', '--env', 'prod'], { fetch: stubFetch(anyConfig) });

    expect(bad.code).toBe(1);
    expect(bad.error).toEqual({ message: 'The environment is staging or production, not prod.' });
  });

  it('a staging app name of 56 characters stops before any call, so <app>-staging stays 1 DNS label', async () => {
    const app = `a${'b'.repeat(55)}`;
    const fetch = stubFetch(anyConfig);

    const refused = await cli(['describe', '--app', app], { fetch, env: { ONTOLOGY_TOKEN: 't' } });

    expect(refused.code).toBe(1);

    expect(refused.error).toEqual({
      message: `The app name has at most 55 characters in staging, so the staging host ${app}-staging is 1 DNS label of at most 63 characters. ${app} has 56.`,
    });

    expect(fetch.calls).toEqual([]);

    expect(await originOf(['--app', app, '--env', 'production'])).toBe(`https://${app}.ontos.example`);
  });

  it('service/cli#targets: the base URL is <app>.ontos.example or <app>-staging.ontos.example', async () => {
    expect(await originOf(['--app', 'gate', '--env', 'production'])).toBe('https://gate.ontos.example');

    expect(await originOf(['--app', 'gate', '--env', 'staging'])).toBe('https://gate-staging.ontos.example');
  });

  it('service/cli#targets: the CLI loads the first .env file of the current folder or a parent folder', async () => {
    const root = tempFolder({
      '.env': 'ONTOLOGY_APP=parent\n',
      'app/src/.keep': '',
      'other/.env': 'ONTOLOGY_APP=child\n',
      'other/deep/.keep': '',
    });

    expect(await originOf([], { cwd: `${root}/app/src` })).toBe('https://parent-staging.ontos.example');

    expect(await originOf([], { cwd: `${root}/other/deep` })).toBe('https://child-staging.ontos.example');
  });

  it('service/cli#targets: a variable that the shell sets keeps its value over .env', async () => {
    const cwd = tempFolder({ '.env': 'ONTOLOGY_APP=from-dotenv\n' });

    expect(await originOf([], { cwd, env: { ONTOLOGY_APP: 'from-shell' } })).toBe(
      'https://from-shell-staging.ontos.example',
    );
  });

  it('service/cli#targets: --url sends the calls to one deployment URL, and the token audience stays the base URL', async () => {
    const audiences: string[] = [];

    const github: Handler = ({ url, headers }) => {
      const request = new URL(url);

      if (request.origin !== 'https://oidc.stub' || headers['authorization'] !== 'Bearer request-token')
        return undefined;

      audiences.push(request.searchParams.get('audience') ?? '');

      return Response.json({ value: 'github-token' });
    };

    const fetch = stubFetch(github, stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.stub/token?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    };

    const run = await cli(
      [
        'objects',
        ACCOUNT,
        '--page-size',
        '2',
        '--order-by',
        '{"name":"asc"}',
        '--app',
        'acme',
        '--env',
        'production',
        '--url',
        STUB,
      ],
      { fetch, env },
    );

    expect(run.code).toBe(0);

    const service = fetch.calls.filter(({ url }) => url.startsWith(STUB));

    expect(service.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/ontology-service/v1/client-config',
      '/api/v2/ontologies',
      `/api/v2/ontologies/${STUB_CONFIG.productRid}/objectTypes/${ACCOUNT}/fullMetadata`,
      `/api/v2/ontologies/${STUB_CONFIG.productRid}/objectSets/loadObjects`,
    ]);

    expect(fetch.calls.filter(({ url }) => !url.startsWith(STUB) && !url.startsWith('https://oidc.stub'))).toEqual([]);
    expect(new Set(audiences)).toEqual(new Set(['https://acme.ontos.example']));
  });

  it('the CLI sends client-config no token, and sends the token with List Ontologies and each call of the Ontology', async () => {
    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const run = await cli(
      ['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', '--app', 'acme', '--url', STUB],
      {
        fetch,
        env: { ONTOLOGY_TOKEN: 'person-token' },
      },
    );

    expect(run.code).toBe(0);

    const [config, ...calls] = fetch.calls;

    expect(config?.headers['authorization']).toBeUndefined();

    expect(calls.map(({ url, headers }) => [new URL(url).pathname.split('/')[4], headers['authorization']])).toEqual([
      [undefined, 'Bearer person-token'],
      [STUB_CONFIG.productRid, 'Bearer person-token'],
      [STUB_CONFIG.productRid, 'Bearer person-token'],
    ]);
  });

  it('allows --url without --app, derives a clean store key from the URL origin, and rejects invalid URLs', async () => {
    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const run = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', '--url', STUB], {
      fetch,
      env: { ONTOLOGY_TOKEN: 'local-token' },
    });

    expect(run.code).toBe(0);
    expect(fetch.calls.map(({ url }) => new URL(url).origin)).toEqual([STUB, STUB, STUB, STUB]);

    const logout = await cli(['logout', '--url', 'http://127.0.0.1:8080']);

    expect(logout.code).toBe(0);
    expect(logout.output).toEqual({ loggedOut: '127.0.0.1-8080/staging' });

    const invalid = await cli(['describe', '--url', 'not-a-url']);

    expect(invalid.code).toBe(1);
    expect(invalid.error).toEqual({ message: '--url must be a valid http or https URL, not not-a-url.' });

    expect(await originOf(['--app', 'acme'], { env: { ONTOS_BASE_DOMAIN: 'custom.internal' } })).toBe(
      'https://acme-staging.custom.internal',
    );
  });

  it('ignores ONTOS_BASE_DOMAIN from .env, validates domain and --url with --app, isolates custom-domain storeKey, and prevents .. traversal', async () => {
    const cwd = tempFolder({ '.env': 'ONTOLOGY_APP=acme\nONTOS_BASE_DOMAIN=attacker.example\n' });

    expect(await originOf([], { cwd, env: {} })).toBe('https://acme-staging.ontos.example');

    const badDomain = await cli(['describe', '--app', 'acme'], {
      env: { ONTOS_BASE_DOMAIN: 'x@attacker.example' },
    });

    expect(badDomain.code).toBe(1);

    expect(badDomain.error).toEqual({
      message: 'ONTOS_BASE_DOMAIN must be a valid DNS domain, not x@attacker.example.',
    });

    const badUrlWithApp = await cli(['describe', '--app', 'acme', '--url', 'ftp://evil.example']);

    expect(badUrlWithApp.code).toBe(1);

    expect(badUrlWithApp.error).toEqual({
      message: '--url must be a valid http or https URL, not ftp://evil.example.',
    });

    const customLogout = await cli(['logout', '--app', 'acme'], {
      env: { ONTOS_BASE_DOMAIN: 'custom.internal' },
    });

    expect(customLogout.code).toBe(0);
    expect(customLogout.output).toEqual({ loggedOut: 'custom.internal/acme/staging' });

    const dotDotLogout = await cli(['logout', '--url', 'http://..']);

    expect(dotDotLogout.code).toBe(0);
    expect(dotDotLogout.output).toEqual({ loggedOut: 'local/staging' });
  });
});
