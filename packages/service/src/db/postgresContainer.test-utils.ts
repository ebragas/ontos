import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { settle } from '../errors/index.ts';
import type {} from '../postgres.test-utils.ts';
import { applyEngineChanges, createDb, createPool } from './index.ts';

const POSTGRES_IMAGE = 'postgres:17-alpine';

const ENGINE_TEMPLATE = 'ontology_template';

const SESSION_WAIT_MS = 5_000;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  process.env['TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX'] ??= 'mirror.gcr.io';

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand(['postgres', '-c', 'max_connections=500', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();

  const adminUrl = container.getConnectionUri();

  try {
    await buildEngineTemplate(adminUrl);
  } catch (error) {
    await container.stop();

    throw error;
  }

  project.provide('postgresAdminUrl', adminUrl);

  project.provide('postgresEngineTemplate', ENGINE_TEMPLATE);

  return async () => {
    await container.stop();
  };
}

async function buildEngineTemplate(adminUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  try {
    await admin.query(`CREATE DATABASE ${ENGINE_TEMPLATE} TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und'`);

    const templateUrl = new URL(adminUrl);

    templateUrl.pathname = `/${ENGINE_TEMPLATE}`;

    const pool = createPool(templateUrl.toString());

    try {
      const applied = await settle(applyEngineChanges(createDb(pool)));

      if (!applied.ok) throw applied.error.error;
    } finally {
      await pool.end();
    }

    await waitForDatabaseClose(admin, ENGINE_TEMPLATE);

    await admin.query(`ALTER DATABASE ${ENGINE_TEMPLATE} IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  } finally {
    await admin.end();
  }
}

async function waitForDatabaseClose(admin: pg.Client, database: string): Promise<void> {
  await admin.query(
    'SELECT pg_terminate_backend(pid, $2::bigint) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [database, SESSION_WAIT_MS],
  );
}
