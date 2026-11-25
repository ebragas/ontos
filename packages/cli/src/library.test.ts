import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetAccessTokens } from './auth/provider.ts';
import { run } from './index.ts';
import { resetMetadata } from './metadataCache.ts';
import {
  cli,
  CLI_VERSION,
  stubExchange,
  replay,
  runLibraryInFolder,
  STUB,
  stubConfig,
  stubFetch,
  tempFolder,
} from './cli.test-utils.ts';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

afterAll(() => server.close());

afterEach(() => {
  server.resetHandlers();

  vi.restoreAllMocks();

  vi.unstubAllEnvs();
});

function capture(stream: NodeJS.WriteStream): () => string[] {
  const spy = vi.spyOn(stream, 'write');

  return () => spy.mock.calls.map(([text]) => String(text));
}

describe('the library entry', () => {
  it('service/cli#library-entry: with no io, run writes to process.stdout and gives the exit code, and does not set process.exitCode', async () => {
    const stdout = capture(process.stdout);
    const exitCode = process.exitCode;

    expect(await run(['--version'])).toBe(0);

    expect(stdout()).toEqual([`${JSON.stringify({ version: CLI_VERSION })}\n`]);
    expect(process.exitCode).toBe(exitCode);
  });

  it('service/cli#library-entry: with no io, run writes an error to process.stderr', async () => {
    const stderr = capture(process.stderr);

    expect(await run(['nope'])).toBe(1);

    expect(stderr()).toEqual([(await cli(['nope'])).stderr]);
  });

  it('service/cli#library-entry: with no cwd, the command runs in the current folder', () => {
    const folder = realpathSync(tempFolder());
    const { code, stderr } = runLibraryInFolder(folder, ['generate-osdk']);

    expect(code).toBe(1);

    expect(JSON.parse(stderr)).toEqual({
      message: `No ontos.yml or foundry.yml in ${folder} or a parent folder. The app needs an ontos.yml (or foundry.yml) at its root.`,
    });
  });

  it('service/cli#library-entry: with no env and no tokenStore, run reads XDG_CONFIG_HOME of process.env, and the token store uses it', async () => {
    const config = tempFolder({ 'ontos/tokens/twin/staging': 'stored-refresh' });

    vi.stubEnv('XDG_CONFIG_HOME', config);

    let stdout = '';

    expect(await run(['logout', '--app', 'twin', '--env', 'staging'], { stdout: (text) => (stdout += text) })).toBe(0);

    expect(stdout).toBe('{"loggedOut":"twin/staging"}\n');
    expect(existsSync(join(config, 'ontos/tokens/twin/staging'))).toBe(false);
  });

  it('service/cli#library-entry: the default token store reads XDG_CONFIG_HOME from io.env', async () => {
    const config = tempFolder({ 'ontos/tokens/twin/staging': 'stored-refresh' });
    let stdout = '';

    const code = await run(['logout', '--app', 'twin', '--env', 'staging'], {
      env: { XDG_CONFIG_HOME: config },
      stdout: (text) => (stdout += text),
    });

    expect(code).toBe(0);
    expect(stdout).toBe('{"loggedOut":"twin/staging"}\n');
    expect(existsSync(join(config, 'ontos/tokens/twin/staging'))).toBe(false);
  });

  it('service/cli#library-entry: with no fetch, run sends each request with the global fetch', async () => {
    const urls: string[] = [];

    server.use(
      http.get('http://127.0.0.1:4010/api/ontology-service/v1/client-config', ({ request }) => {
        urls.push(request.url);

        return HttpResponse.error();
      }),
    );

    let stderr = '';

    const code = await run(['describe', '--app', 'twin', '--url', 'http://127.0.0.1:4010'], {
      env: { ONTOLOGY_TOKEN: 't' },
      stderr: (text) => (stderr += text),
      sleep: async () => {},
    });

    expect(code).toBe(1);
    expect(new Set(urls)).toEqual(new Set(['http://127.0.0.1:4010/api/ontology-service/v1/client-config']));
    expect(JSON.parse(stderr)).toHaveProperty('message');
  });

  it('service/cli#library-entry: run prints the same JSON as the command, and never calls process.exit', async () => {
    const exit = vi.spyOn(process, 'exit');

    for (const args of [['--version'], ['nope'], ['--version', 'describe']]) {
      let stdout = '';
      let stderr = '';

      const code = await run(args, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });

      const command = await cli(args);

      expect({ code, stdout, stderr }).toEqual({ code: command.code, stdout: command.stdout, stderr: command.stderr });
    }

    expect(exit).not.toHaveBeenCalled();
  });

  it('service/cli#library-entry: when a default fails, run prints it as a JSON error and gives 1', () => {
    const { code, stderr } = runLibraryInFolder(tempFolder(), ['--version'], { remove: true });

    expect(code).toBe(1);

    expect(JSON.parse(stderr)).toEqual({
      message: expect.stringMatching(/^ENOENT: .*no such file or directory.*uv_cwd$/u),
    });
  });

  it('service/cli#library-entry: a refresh calls write of io.tokenStore with the refresh token that it read', async () => {
    resetMetadata();

    resetAccessTokens();

    const writes: (string | undefined)[][] = [];

    const tokenStore = {
      read: () => Promise.resolve('refresh-0'),
      write: (key: string, token: string, expected?: string) => {
        writes.push([key, token, expected]);

        return Promise.resolve();
      },
      remove: () => Promise.resolve(),
    };

    const workos = ({ url }: { readonly url: string }) =>
      url === 'https://api.workos.com/user_management/authenticate'
        ? Response.json({ access_token: 'access-1', refresh_token: 'refresh-1' })
        : undefined;

    const fetch = stubFetch(stubConfig, workos, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const code = await run(
      [
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
      ],
      { env: {}, fetch, tokenStore, stdout: () => undefined, stderr: () => undefined },
    );

    expect(code).toBe(0);
    expect(writes).toEqual([['twin/staging', 'refresh-1', 'refresh-0']]);
  });
});
