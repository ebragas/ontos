import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { applyEngineChanges, createDb, createPool } from './db/index.ts';
import { settle } from './errors/index.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresAdminUrl: string;
    postgresEngineTemplate: string;
  }
}

export interface TestPostgres {
  readonly url: string;
  readonly role: string;
  stop(waiting?: () => void): Promise<void>;
}

export interface StartPostgresOptions {
  readonly template?: 'empty' | 'engine';
}

export interface RoleCredentials {
  readonly name: string;
  readonly password: string;
}

export interface EngineTemplateOptions {
  readonly icu?: boolean;
}

const SESSION_WAIT_MS = 500;

let templates = 0;

export function engineTemplate(): string {
  return inject('postgresEngineTemplate');
}

export async function startPostgres(options?: StartPostgresOptions): Promise<TestPostgres> {
  const adminUrl = inject('postgresAdminUrl');
  const template = options?.template === 'engine' ? engineTemplate() : undefined;
  const role = `test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  await asAdmin(adminUrl, async (admin) => {
    await admin.query(`CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${role}'`);

    await admin.query(
      template ? `CREATE DATABASE ${role} OWNER ${role} TEMPLATE ${template}` : `CREATE DATABASE ${role} OWNER ${role}`,
    );
  });

  const url = new URL(adminUrl);

  url.username = role;
  url.password = role;
  url.pathname = `/${role}`;

  return {
    url: url.toString(),
    role,
    stop: (waiting) =>
      asAdmin(adminUrl, async (admin) => {
        await endSessions(admin, role, waiting);

        await dropDatabases(admin, role);
      }),
  };
}

export async function createEngineTemplate(
  adminUrl: string,
  role?: RoleCredentials,
  options?: EngineTemplateOptions,
): Promise<string> {
  const owner = new URL(adminUrl).username;
  const name = `${owner}_engine_template_${++templates}`;

  await asAdmin(adminUrl, async (admin) => {
    await admin.query(
      options?.icu
        ? `CREATE DATABASE ${name} TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und'`
        : `CREATE DATABASE ${name}`,
    );

    if (role) await admin.query(`GRANT CREATE ON DATABASE ${name} TO ${role.name}`);

    const url = new URL(adminUrl);

    url.pathname = `/${name}`;

    if (role) {
      url.username = role.name;
      url.password = role.password;
    }

    const pool = createPool(url.toString());

    try {
      const applied = await settle(applyEngineChanges(createDb(pool)));

      if (!applied.ok) throw applied.error.error;
    } finally {
      await pool.end();
    }

    await waitForDatabaseClose(admin, name);

    await admin.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS false`);
  });

  return name;
}

async function dropDatabases(admin: pg.Client, role: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string; datistemplate: boolean }>(
    'SELECT datname, datistemplate FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)',
    [role],
  );

  for (const { datname, datistemplate } of rows) {
    const quoted = `"${datname.replaceAll('"', '""')}"`;

    if (datistemplate) await admin.query(`ALTER DATABASE ${quoted} IS_TEMPLATE false`);

    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  }
}

async function waitForDatabaseClose(admin: pg.Client, database: string): Promise<void> {
  await admin.query(
    'SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [database],
  );
}

async function endSessions(admin: pg.Client, role: string, waiting?: () => void): Promise<void> {
  const signal = AbortSignal.timeout(SESSION_WAIT_MS);

  while (!signal.aborted) {
    const { rows } = await admin.query<{ open: number }>(
      'SELECT count(*)::int AS open FROM pg_stat_activity WHERE usename = $1',
      [role],
    );

    if (rows[0]?.open === 0) return;

    waiting?.();

    waiting = undefined;

    await admin.query('SELECT pg_sleep(0.05)');
  }

  await admin.query('SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename = $1', [role]);
}

async function asAdmin(adminUrl: string, run: (admin: pg.Client) => Promise<unknown>): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}
