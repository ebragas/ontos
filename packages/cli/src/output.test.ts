import { describe, expect, it } from 'vitest';
import { twinApp } from './apps.test-utils.ts';
import {
  cli,
  CLI_VERSION,
  stubExchange,
  stubMetadata,
  replay,
  STUB,
  stubConfig,
  stubFetch,
  tempFolder,
  withRequest,
  type Handler,
} from './cli.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const CREATE_ACCOUNT = 'com.example.twin.create-account';
const flags = ['--app', 'twin', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };

const createAccountType: Handler = ({ method, url }) => {
  if (method !== 'GET' || !url.endsWith(`/actionTypes/${CREATE_ACCOUNT}`)) return undefined;

  return Response.json((stubMetadata()['actionTypes'] as Record<string, unknown>)[CREATE_ACCOUNT]);
};

describe('the output of a command', () => {
  it('service/cli#output: a command prints 1 JSON value on stdout', async () => {
    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const run = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', ...flags], {
      fetch,
      env,
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout.endsWith('}\n')).toBe(true);
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
    expect((run.output as { data: unknown[] }).data).toHaveLength(2);
  });

  it('service/cli#output: an error from the service prints the OSDK error body as JSON on stderr', async () => {
    const fetch = stubFetch(
      stubConfig,
      replay(stubExchange('client', 4), withRequest(stubExchange('client', 22), { pageSize: 100 })),
    );

    const run = await cli(['objects', ENGAGEMENT, '--where', '{"nope":{"$eq":"x"}}', ...flags], { fetch, env });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');

    expect(run.error).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'PropertiesNotFound',
      errorInstanceId: 'ebe8005d-11d9-4f56-b2fe-615635d6689d',
      parameters: { objectType: ENGAGEMENT, properties: ['nope'] },
    });
  });

  it('service/cli#output: an error answer that is not an OSDK error body prints its message and status', async () => {
    const crash: Handler = ({ url }) =>
      url.includes('/api/v2/')
        ? Response.json({ error: 'crash' }, { status: 500, statusText: 'Internal Server Error' })
        : undefined;

    const fetch = stubFetch(stubConfig, crash);

    const run = await cli(['objects', ACCOUNT, ...flags], { fetch, env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual({ message: 'Failed to fetch 500 Internal Server Error', status: 500 });

    const sent = fetch.calls.map(({ method, url }) => `${method} ${url}`);

    expect(sent).toEqual([...new Set(sent)]);
  });

  it('service/cli#output: an error of the CLI itself prints JSON on stderr', async () => {
    const run = await cli(['nope'], { cwd: tempFolder() });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');

    expect(run.error).toEqual({
      message:
        'Usage: ontos <init | dev | login | logout | install | describe | objects | aggregate | apply | history | validate | publish | generate-osdk> [options], or ontos --version',
    });

    const unknownFlag = await cli(['objects', ACCOUNT, '--nope']);

    expect(unknownFlag.code).toBe(1);

    expect(unknownFlag.error).toEqual({
      message:
        "Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\"",
    });
  });

  it('service/cli#output: a first request to the service that gets no answer names the URL and the cause', async () => {
    const unreachable = (async (input: Request) => {
      throw new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND ${new URL(input.url).hostname}`) });
    }) as typeof fetch;

    const byApp = await cli(['describe', '--app', 'example-app'], { fetch: unreachable, env });

    expect(byApp.code).toBe(1);

    expect(byApp.error).toMatchObject({
      message:
        'Cannot reach https://example-app-staging.ontos.example: getaddrinfo ENOTFOUND example-app-staging.ontos.example.',
    });

    const byUrl = await cli(['describe', '--app', 'twin', '--url', 'https://nope.example'], {
      fetch: unreachable,
      env,
    });

    expect(byUrl.code).toBe(1);

    expect(byUrl.error).toMatchObject({
      message: 'Cannot reach https://nope.example: getaddrinfo ENOTFOUND nope.example.',
    });
  });

  it('service/cli#output: client-config of an environment with no deployment names the environment and the first deploy', async () => {
    const vercel =
      'The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n\nsfo1::4pz8d-1793375966194-61f096e705e0\n';

    const notDeployed: Handler = ({ url }) =>
      url.endsWith('/client-config')
        ? new Response(vercel, { status: 404, headers: { 'content-type': 'text/plain' } })
        : undefined;

    const url = 'https://twin.ontos.example';

    for (const command of [['validate'], ['objects', ACCOUNT], ['apply', CREATE_ACCOUNT, '--parameters', '{}']]) {
      const run = await cli([...command, '--app', 'twin', '--env', 'production'], {
        fetch: stubFetch(notDeployed),
        env,
        cwd: twinApp(),
      });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        errorName: 'EnvironmentNotDeployed',
        message: `${url} has no deployment yet. Deploy the production environment of twin first. Until then, ontos validate and the other commands fail on it.`,
        url,
      });
    }

    const other = await cli(['describe', ...flags], {
      fetch: stubFetch(({ url }) =>
        url.endsWith('/client-config') ? new Response('Not Found', { status: 404 }) : undefined,
      ),
      env,
    });

    expect(other.code).toBe(1);
    expect(other.error).toEqual({ status: 404, message: 'Not Found' });
    expect(other.stderr).not.toContain('EnvironmentNotDeployed');
  });

  it('service/cli#output: the exit code is 0 on success, 1 on an error, and 1 on an apply with validation.result INVALID', async () => {
    const ok = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', ...flags], {
      fetch: stubFetch(stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2))),
      env,
    });

    expect(ok.code).toBe(0);

    const error = await cli(['objects', ENGAGEMENT, '--where', '{"nope":{"$eq":"x"}}', ...flags], {
      fetch: stubFetch(
        stubConfig,
        replay(stubExchange('client', 4), withRequest(stubExchange('client', 22), { pageSize: 100 })),
      ),
      env,
    });

    expect(error.code).toBe(1);

    const invalid = withRequest(stubExchange('probe', 22), {
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

    const apply = await cli(['apply', CREATE_ACCOUNT, '--parameters', '{"accountId":"p-noname"}', ...flags], {
      fetch: stubFetch(stubConfig, createAccountType, replay(invalid)),
      env,
    });

    expect(apply.code).toBe(1);

    expect(apply.output).toEqual({
      result: 'INVALID',
      submissionCriteria: [],
      parameters: {
        phase: { result: 'VALID', evaluatedConstraints: [], required: false },
        accountId: { result: 'VALID', evaluatedConstraints: [], required: false },
        name: { result: 'INVALID', evaluatedConstraints: [], required: true },
        note: { result: 'VALID', evaluatedConstraints: [], required: false },
        active: { result: 'VALID', evaluatedConstraints: [], required: false },
      },
    });

    const validateOnlyInvalid = withRequest(stubExchange('probe', 27), {
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    const validateOnly = await cli(
      ['apply', CREATE_ACCOUNT, '--parameters', '{"accountId":"p-noname-v"}', '--validate-only', ...flags],
      {
        fetch: stubFetch(stubConfig, createAccountType, replay(validateOnlyInvalid)),
        env,
      },
    );

    expect(validateOnly.code).toBe(1);

    expect(validateOnly.output).toEqual({
      result: 'INVALID',
      submissionCriteria: [],
      parameters: {
        phase: { result: 'VALID', evaluatedConstraints: [], required: false },
        accountId: { result: 'VALID', evaluatedConstraints: [], required: false },
        name: { result: 'INVALID', evaluatedConstraints: [], required: true },
        note: { result: 'VALID', evaluatedConstraints: [], required: false },
        active: { result: 'VALID', evaluatedConstraints: [], required: false },
      },
    });
  });

  it('each command refuses a flag that it does not take, and sends no call', async () => {
    const cases: [string[], string][] = [
      [['publish', '--parameters', '{}'], 'ontos publish does not take --parameters.'],
      [['validate', '--parameters', '{}'], 'ontos validate does not take --parameters.'],
      [['describe', '--page-size', '5'], 'ontos describe does not take --page-size.'],
      [['history', ACCOUNT, '--where', '{}'], 'ontos history does not take --where.'],
      [['login', '--link', 'x'], 'ontos login does not take --link.'],
    ];

    for (const [args, message] of cases) {
      const fetch = stubFetch(stubConfig);

      const run = await cli([...args, ...flags], { cwd: tempFolder(), fetch, env });

      expect(run.code).toBe(1);
      expect(run.error).toEqual({ message });
      expect(fetch.calls).toEqual([]);
    }

    const extra = await cli(['describe', ACCOUNT, 'more', ...flags], { fetch: stubFetch(stubConfig), env });

    expect(extra.error).toEqual({ message: 'Usage: ontos describe [name] [--ontology <apiName>]' });

    const missing = await cli(['apply', ...flags], { fetch: stubFetch(stubConfig), env });

    expect(missing.error).toEqual({
      message: 'Usage: ontos apply <ActionType> --parameters <JSON> [--ontology <apiName>]',
    });

    for (const flag of [
      ['--where', '{}'],
      ['--order-by', '{"name":"asc"}'],
      ['--page-size', '5'],
      ['--page-token', 't'],
    ]) {
      const fetch = stubFetch(stubConfig);

      const one = await cli(['objects', ACCOUNT, 'acc-1', ...flag, ...flags], { fetch, env });

      expect(one.code).toBe(1);

      expect(one.error).toEqual({
        message: `ontos objects <ObjectType> <primary key> reads 1 Object, so it does not take ${flag[0]}.`,
      });

      expect(fetch.calls.map(({ url }) => new URL(url).pathname)).toEqual([
        '/api/ontology-service/v1/client-config',
        '/api/v2/ontologies',
      ]);
    }

    const version = await cli(['describe', '--version', '--page-size', '3']);

    expect(version.code).toBe(1);
    expect(version.error).toEqual({ message: 'Usage: ontos --version, with no command or other flag.' });
  });

  it('prints human-readable output in a TTY and compact JSON when --json is passed or stdout is not a TTY', async () => {
    const ttyVersion = await cli(['--version'], { isTty: true });

    expect(ttyVersion.code).toBe(0);
    expect(ttyVersion.stdout).toBe(`ontos ${CLI_VERSION}\n`);

    const jsonVersion = await cli(['--version', '--json'], { isTty: true });

    expect(jsonVersion.code).toBe(0);
    expect(jsonVersion.output).toEqual({ version: CLI_VERSION });

    const ttyError = await cli(['nope'], { isTty: true });

    expect(ttyError.code).toBe(1);
    expect(ttyError.stderr).toMatch(/^Error: Usage: ontos /);

    const jsonError = await cli(['nope', '--json'], { isTty: true });

    expect(jsonError.code).toBe(1);
    expect(jsonError.error).toMatchObject({ message: expect.stringContaining('Usage: ontos ') });

    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const ttyObjects = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', ...flags], {
      fetch,
      env,
      isTty: true,
    });

    expect(ttyObjects.code).toBe(0);
    expect(ttyObjects.stdout).toContain('2 objects:');
  });
});
