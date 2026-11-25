import { spawn } from 'node:child_process';
import { copyFileSync, symlinkSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type TestPostgres } from '../../../../packages/service/src/postgres.test-utils.ts';
import { onNewConnection } from '../../../../packages/service/src/publish/publish.test-utils.ts';
import { buildTo } from '../../build.ts';
import { cli, FakeSignals, ROOT, stubFetch, tempFolder } from '../cli.test-utils.ts';
import { toLocal } from '../sql.test-utils.ts';

interface StartupPayload {
  readonly status: string;
  readonly url: string;
  readonly mcpUrl: string;
  readonly token: string;
  readonly database: string;
}

interface IsolatedRunResult {
  readonly missingExitCode: number | null;
  readonly missingStderr: string;
  readonly startup: StartupPayload;
  readonly wellKnownStatus: number;
  readonly wellKnownBody: unknown;
  readonly unauthorizedMcpStatus: number;
  readonly unauthorizedWwwAuthenticate: string | null;
  readonly exitCode: number | null;
}

async function serviceRoleUrl(postgres: TestPostgres, tag: string): Promise<string> {
  const roleName = `${postgres.role}_${tag}`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${roleName} LOGIN PASSWORD '${roleName}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${postgres.role} TO ${roleName}`);

  const url = new URL(postgres.url);

  url.username = roleName;
  url.password = roleName;

  return url.toString();
}

function runIsolatedDev(
  binPath: string,
  cwd: string,
  databaseUrl: string,
): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, 'dev', '--port', '0', '--database-url', databaseUrl], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);

    child.on('exit', (exitCode) => resolve({ exitCode, stderr }));
  });
}

async function runIsolatedDevLifecycle(
  binPath: string,
  cwd: string,
  databaseUrl: string,
): Promise<{
  readonly startup: StartupPayload;
  readonly wellKnownStatus: number;
  readonly wellKnownBody: unknown;
  readonly unauthorizedMcpStatus: number;
  readonly unauthorizedWwwAuthenticate: string | null;
  readonly exitCode: number | null;
}> {
  const child = spawn(
    process.execPath,
    [binPath, 'dev', '--port', '0', '--host', '127.0.0.1', '--database-url', databaseUrl, '--token', 'isolated-token'],
    {
      cwd,
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const ready = Promise.withResolvers<StartupPayload>();
  const exited = Promise.withResolvers<number | null>();
  let stderr = '';
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');

    const lines = stdoutBuffer.split('\n');

    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('{')) {
        ready.resolve(JSON.parse(trimmed) as StartupPayload);
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (error) => {
    ready.reject(error);

    exited.reject(error);
  });

  child.on('exit', (code) => {
    ready.reject(new Error(`Isolated ontos dev exited early (${String(code)}): ${stderr}`));

    exited.resolve(code);
  });

  let startup: StartupPayload;

  try {
    startup = await ready.promise;

    const wellKnown = await fetch(`${startup.url}/api/oauth-protected-resource`);

    const wellKnownBody: unknown = await wellKnown.json();

    const unauthMcp = await fetch(startup.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    child.kill('SIGTERM');

    const exitCode = await exited.promise;

    return {
      startup,
      wellKnownStatus: wellKnown.status,
      wellKnownBody,
      unauthorizedMcpStatus: unauthMcp.status,
      unauthorizedWwwAuthenticate: unauthMcp.headers.get('www-authenticate'),
      exitCode,
    };
  } catch (error) {
    child.kill('SIGKILL');

    throw error;
  }
}

describe('ontos init -> ontos dev -> publish -> install -> apply -> objects end-to-end', () => {
  let postgres: TestPostgres;
  let databaseUrl: string;
  let isolated: IsolatedRunResult;

  beforeAll(async () => {
    postgres = await startPostgres();

    databaseUrl = await serviceRoleUrl(postgres, 'cli_dev_e2e');

    const binDir = tempFolder();
    const binPath = join(binDir, 'dist/ontos.js');

    await buildTo(binPath);

    copyFileSync(join(ROOT, 'packages/cli/package.json'), join(binDir, 'package.json'));

    const emptyCwd = tempFolder();
    const projectCwd = tempFolder();

    symlinkSync(join(ROOT, 'node_modules'), join(projectCwd, 'node_modules'), 'dir');

    const missing = await runIsolatedDev(binPath, emptyCwd, databaseUrl);

    const live = await runIsolatedDevLifecycle(binPath, projectCwd, databaseUrl);

    isolated = {
      missingExitCode: missing.exitCode,
      missingStderr: missing.stderr,
      ...live,
    };
  }, 60_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it('validates flags and fails fast when DATABASE_URL is missing', async () => {
    const missing = await cli(['dev'], { env: {} });

    expect(missing.code).toBe(1);
    expect(missing.error).toEqual({ message: 'No database URL: pass --database-url <url>, or set DATABASE_URL.' });

    const emptyPort = await cli(['dev', '--port', '', '--database-url', databaseUrl]);

    expect(emptyPort.code).toBe(1);
    expect(emptyPort.error).toEqual({ message: '--port must be a whole number from 0 to 65535, not an empty string.' });

    const badPort = await cli(['dev', '--port', '99999', '--database-url', databaseUrl]);

    expect(badPort.code).toBe(1);
    expect(badPort.error).toEqual({ message: '--port must be a whole number from 0 to 65535, not 99999.' });

    const badRid = await cli(['dev', '--database-url', databaseUrl, '--product-rid', 'bad-rid']);

    expect(badRid.code).toBe(1);
    expect(badRid.error).toEqual({ message: '--product-rid must have the form ri.ontology.main.ontology.<UUID>.' });
  });

  it('resolves @ericbragas/ontos-service from io.cwd when dist/ontos.js runs outside any node_modules and serves the real bound port on --port 0', () => {
    expect(isolated.missingExitCode).toBe(1);
    expect(isolated.missingStderr).toContain('Could not load @ericbragas/ontos-service');

    expect(isolated.startup.status).toBe('listening');
    expect(isolated.startup.database).toBe('connected');
    expect(Number(new URL(isolated.startup.url).port)).toBeGreaterThan(0);
    expect(isolated.startup.mcpUrl).toBe(`${isolated.startup.url}/api/mcp`);

    expect(isolated.wellKnownStatus).toBe(200);

    expect(isolated.wellKnownBody).toEqual({
      resource: isolated.startup.mcpUrl,
      authorization_servers: [isolated.startup.url],
    });

    expect(isolated.unauthorizedMcpStatus).toBe(401);

    expect(isolated.unauthorizedWwwAuthenticate).toBe(
      `Bearer resource_metadata="${isolated.startup.url}/api/oauth-protected-resource"`,
    );

    expect(isolated.exitCode).toBe(128 + constants.signals.SIGTERM);
  });

  it('scaffolds a project, boots ontos dev against Postgres, and runs publish, install, apply, objects, and clean shutdown', async () => {
    const projectDir = tempFolder();

    const init = await cli(['init'], { cwd: projectDir });

    expect(init.code).toBe(0);

    symlinkSync(join(ROOT, 'node_modules'), join(projectDir, 'node_modules'), 'dir');

    const signals = new FakeSignals();
    const ready = Promise.withResolvers<StartupPayload>();
    const token = 'e2e-dev-token';

    const devPromise = cli(
      ['dev', '--port', '0', '--host', '127.0.0.1', '--database-url', databaseUrl, '--token', token],
      {
        cwd: projectDir,
        signals,
        onStdout: (chunk) => {
          const line = chunk.trim();

          if (line.startsWith('{')) {
            ready.resolve(JSON.parse(line) as StartupPayload);
          }
        },
      },
    );

    try {
      const startup = await ready.promise;

      expect(startup.status).toBe('listening');
      expect(startup.database).toBe('connected');
      expect(startup.token).toBe(token);
      expect(Number(new URL(startup.url).port)).toBeGreaterThan(0);
      expect(startup.mcpUrl).toBe(`${startup.url}/api/mcp`);

      const wellKnown = await fetch(`${startup.url}/api/oauth-protected-resource`);

      expect(wellKnown.status).toBe(200);

      expect(await wellKnown.json()).toEqual({
        resource: startup.mcpUrl,
        authorization_servers: [startup.url],
      });

      const unauthMcp = await fetch(startup.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });

      expect(unauthMcp.status).toBe(401);

      expect(unauthMcp.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${startup.url}/api/oauth-protected-resource"`,
      );

      const env = { ONTOLOGY_TOKEN: token };
      const localFetch = stubFetch(toLocal);

      const published = await cli(['publish', '--url', startup.url, '--skip-sdk-package'], {
        cwd: projectDir,
        fetch: localFetch,
        env,
      });

      expect(published.stderr).toBe('');
      expect(published.code).toBe(0);
      expect(published.output).toMatchObject({ version: 1 });

      const product = new URL(startup.url).host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');

      const installed = await cli(
        ['install', product, '--api-name', 'tasks', '--display-name', 'Tasks', '--url', startup.url],
        {
          cwd: projectDir,
          fetch: localFetch,
          env,
        },
      );

      expect(installed.stderr).toBe('');
      expect(installed.code).toBe(0);
      expect(installed.output).toMatchObject({ apiName: 'tasks', displayName: 'Tasks' });

      const applied = await cli(
        [
          'apply',
          'com.example.tasks.create-task',
          '--parameters',
          JSON.stringify({ taskId: 'task-1', title: 'Ship Ontos V1', completed: false }),
          '--url',
          startup.url,
        ],
        {
          cwd: projectDir,
          fetch: localFetch,
          env,
        },
      );

      expect(applied.stderr).toBe('');
      expect(applied.code).toBe(0);

      const listed = await cli(['objects', 'com.example.tasks.Task', '--url', startup.url], {
        cwd: projectDir,
        fetch: localFetch,
        env,
      });

      expect(listed.stderr).toBe('');
      expect(listed.code).toBe(0);

      expect(listed.output).toMatchObject({
        data: [
          expect.objectContaining({
            taskId: 'task-1',
            title: 'Ship Ontos V1',
            completed: false,
          }),
        ],
      });
    } finally {
      await signals.send();
    }

    const devExit = await devPromise;

    expect(devExit.code).toBe(0);
    expect(devExit.stderr).toBe('');
  });
});
