import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../../cli/src/index.ts';
import { startLocalService, type CliRun } from '../../testing/index.ts';
import { LOCAL_APP, localTwin } from '../localTwin.test-utils.ts';

const SLOW = { timeout: 120_000 };

async function detail(attempt: () => Promise<unknown>): Promise<unknown> {
  const text = (value: unknown): string =>
    (value instanceof Error ? value.message : String(value))
      .replace(/local_[0-9a-f]{12}/g, '<role>')
      .replace(/"errorInstanceId":"[0-9a-f-]{36}"/g, '"errorInstanceId":"<id>"');

  const named = (value: unknown): string => (value instanceof Error ? value.constructor.name : typeof value);

  try {
    await attempt();

    return { rejected: false };
  } catch (error) {
    return {
      rejected: true,
      name: named(error),
      message: text(error),
      ...(error instanceof Error && error.cause !== undefined
        ? { cause: { name: named(error.cause), message: text(error.cause) } }
        : {}),
      ...(error instanceof AggregateError
        ? { members: error.errors.map((member) => ({ name: named(member), message: text(member) })) }
        : {}),
    };
  }
}

let container: StartedPostgreSqlContainer;
const adminUrl = (): string => container.getConnectionUri();

async function asAdmin(text: string): Promise<pg.QueryResultRow[]> {
  const admin = new pg.Client({ connectionString: adminUrl() });

  await admin.connect();

  try {
    return (await admin.query(text)).rows;
  } finally {
    await admin.end();
  }
}

async function localDatabases(): Promise<string[]> {
  const rows = await asAdmin("SELECT datname FROM pg_database WHERE datname LIKE 'local\\_%' ORDER BY datname");

  return rows.map((row) => String(row['datname']));
}

describe('service/testing#local-service: the refusals on the test Postgres', () => {
  const folders: string[] = [];

  beforeAll(async () => {
    process.env['TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX'] ??= 'mirror.gcr.io';

    container = await new PostgreSqlContainer('postgres:17-alpine').start();
  }, 120_000);

  afterAll(async () => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });

    await container.stop();
  }, 120_000);

  const stagingFolder = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'service-border-'));

    folders.push(folder);

    mkdirSync(join(folder, '.ontology'));

    const staging = {
      baseUrl: 'https://probe.example.com',
      workosClientId: 'client_probe',
      trustedGithubRepository: 'example/probe',
      trustedGithubEnvironment: 'staging',
      authkitDomain: 'probe.authkit.app',
    };

    writeFileSync(
      join(folder, '.ontology/deployment.json'),
      JSON.stringify({ productRid: 'ri.ontology.main.ontology.probe', staging }),
    );

    return folder;
  };

  const start = (cli: CliRun, options: { role?: string; folder?: string } = {}) =>
    startLocalService({
      app: options.folder === undefined ? 'probe' : LOCAL_APP,
      cli,
      folder: stagingFolder(),
      postgres: adminUrl(),
      ...options,
    });

  it('a publish that exits with a code other than 0', SLOW, async () => {
    const fetchBefore = globalThis.fetch;

    const answer = await detail(() =>
      start((_args, io) => {
        io.stdout('CANARY-out\n');

        io.stderr('CANARY-err\n');

        return Promise.resolve(1);
      }),
    );

    expect({
      answer,
      fetchRestored: globalThis.fetch === fetchBefore,
      databases: await localDatabases(),
    }).toMatchSnapshot();
  });

  it('a publish that exits with 0 and writes no role', SLOW, async () => {
    const fetchBefore = globalThis.fetch;

    const answer = await detail(() => start(() => Promise.resolve(0), { role: 'owner' }));

    expect({
      answer,
      fetchRestored: globalThis.fetch === fetchBefore,
      databases: await localDatabases(),
    }).toMatchSnapshot();
  });

  it('the twin app with a role that its grants file does not hold', SLOW, async () => {
    const answer = await detail(() => start(run, { role: 'owner', folder: localTwin() }));

    expect({ answer, databases: await localDatabases() }).toMatchSnapshot();
  });

  it(
    'a stop with 1 failed step, a second stop, and a call off this computer while the service runs',
    SLOW,
    async () => {
      const network = globalThis.fetch;

      const local = await start(run, { folder: localTwin() });

      const [name = ''] = await localDatabases();

      await asAdmin(`CREATE DATABASE ${name}_kept OWNER ${name}`);

      try {
        const offComputer = await detail(() => fetch('https://example.com/'));

        const first = await detail(() => local.stop());

        const second = await detail(() => local.stop());

        expect({ offComputer, first, second, fetchRestored: globalThis.fetch === network }).toMatchSnapshot();
      } finally {
        await asAdmin(`DROP DATABASE ${name}_kept`);

        await asAdmin(`DROP ROLE ${name}`);
      }
    },
  );

  it('an engine change that fails, because the template database holds its schema', SLOW, async () => {
    const template = new pg.Client({
      connectionString: Object.assign(new URL(adminUrl()), { pathname: '/template1' }).toString(),
    });

    await template.connect();

    await template.query('CREATE SCHEMA ontology_registry');

    await template.end();

    try {
      const answer = await detail(() => start(run, { folder: localTwin() }));

      expect({ answer, databases: await localDatabases() }).toMatchSnapshot();
    } finally {
      const cleanup = new pg.Client({
        connectionString: Object.assign(new URL(adminUrl()), { pathname: '/template1' }).toString(),
      });

      await cleanup.connect();

      await cleanup.query('DROP SCHEMA ontology_registry');

      await cleanup.end();
    }
  });

  it('an install that the service refuses, because the published product is gone', SLOW, async () => {
    const publishThenDrop: CliRun = async (args, io) => {
      const code = await run(args, io);

      const [name = ''] = await localDatabases();

      const local = new pg.Client({
        connectionString: Object.assign(new URL(adminUrl()), { pathname: `/${name}` }).toString(),
      });

      await local.connect();

      await local.query('DELETE FROM ontology_registry.product_versions');

      await local.end();

      return code;
    };

    const fetchBefore = globalThis.fetch;

    const answer = await detail(() => start(publishThenDrop, { folder: localTwin() }));

    expect({
      answer,
      fetchRestored: globalThis.fetch === fetchBefore,
      databases: await localDatabases(),
    }).toMatchSnapshot();
  });

  it('a stop that succeeds', SLOW, async () => {
    const local = await start(run, { folder: localTwin() });

    expect({
      first: await detail(() => local.stop()),
      second: await detail(() => local.stop()),
      databases: await localDatabases(),
    }).toMatchSnapshot();
  });
});
