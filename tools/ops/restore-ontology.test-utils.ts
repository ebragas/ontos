import { execFile } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { expect, vi } from 'vitest';
import type { OntologyIr } from '@osdk/client.unstable';
import { createPool, ontologyEngineChanges, type Sql } from '../../packages/service/src/db/index.ts';
import { applyEngineChanges, createDb, type Db } from '../../packages/service/src/db/promise.test-utils.ts';
import type { SchemaMigration } from '../../packages/service/src/publish/index.ts';
import { convertOrThrow, irOf } from '../../packages/service/src/ontology/stored.test-utils.ts';
import { TEST_ONTOLOGY_RID } from '../../packages/service/src/service.test-utils.ts';
import {
  createEngineTemplate,
  startPostgres,
  type TestPostgres,
} from '../../packages/service/src/postgres.test-utils.ts';
import { NO_GRANTS, OSDK_SET, sql } from '../../packages/service/src/publish/publish.test-utils.ts';
import { main, type Options } from './restore-ontology.ts';

const SCRIPT = new URL('./restore-ontology.ts', import.meta.url).pathname;
export const PASSWORD = 'restore-marker-password';
export const BEHIND = 'ri.ontology.main.ontology.1';
export const CURRENT = 'ri.ontology.main.ontology.2';
export const UNKNOWN = 'ri.ontology.main.ontology.9';
export const INSTALLED_AFTER_RESTORE = 'ri.ontology.main.ontology.7';
const NOW = new Date('2026-11-10T01:02:03.456Z');
export const STAMP = '20261110010203';
export const NEW_OBJECTS = `ontology_1_objects_${STAMP}`;
export const NEW_ENGINE = `ontology_1_engine_${STAMP}`;
export const ORPHAN = 'ontology_1_objects_20200101000000';

export const FROM_BEHIND = {
  objectSchema: 'ontology_1_objects',
  engineSchema: 'ontology_1_engine',
  version: 3,
  engineChangeCount: 3,
};

export const TO_BEHIND = { objectSchema: NEW_OBJECTS, engineSchema: NEW_ENGINE, version: 3, engineChangeCount: 3 };
export const LINE_BEHIND = { ontologyRid: BEHIND, from: FROM_BEHIND, to: TO_BEHIND, copyVersion: 1, orphans: [] };
export const WRITE = ['restore', BEHIND, '--write', '--confirm-rid', BEHIND];
export const SWITCH_UPDATE = 'UPDATE ontology_registry.ontologies SET object_schema';

export interface Run {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface RestoreHarness {
  readonly role: string;
  readonly otherOwner: string;
  readonly postgresUrl: () => string;
  readonly directUrl: () => string;
  readonly sourceUrl: () => string;
  readonly direct: () => Db;
  readonly source: () => Db;
  readonly productions: () => Db[];
  readonly trackPool: (pool: pg.Pool) => void;
  readonly env: () => Record<string, string>;
  readonly asAdmin: (text: string) => Promise<void>;
  readonly asAdminIn: (databaseUrl: string, text: string) => Promise<void>;
  readonly newDatabase: (
    kind: string,
    options?: { readonly encoding?: 'LATIN1'; readonly empty?: boolean },
  ) => Promise<{ url: string; db: Db }>;
  readonly newProduction: (kind: string, encoding?: 'LATIN1') => Promise<{ url: string; db: Db }>;
  readonly run: (args: readonly string[], options?: Options, env?: Record<string, string>) => Promise<Run>;
  readonly beforeAll: () => Promise<void>;
  readonly afterAll: () => Promise<void>;
  readonly beforeEach: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

function taskTable(schema: string): string {
  return `CREATE TABLE ${schema}.task (
  task_id text NOT NULL, title text, done boolean NOT NULL DEFAULT false, score numeric(10,2), due timestamptz, tags text[], details jsonb, gone text,
  _version bigint NOT NULL DEFAULT 1, CONSTRAINT task_pkey PRIMARY KEY (task_id));
ALTER TABLE ${schema}.task DROP COLUMN gone;
ALTER TABLE ${schema}.task ENABLE ROW LEVEL SECURITY;
CREATE POLICY ontology_service ON ${schema}.task FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE INDEX trgm_task_title ON ${schema}.task USING gin (title ontology_registry.gin_trgm_ops);
CREATE INDEX fk_task_due ON ${schema}.task (due);`;
}

async function storeVersion(
  db: Db,
  version: number,
  ir: OntologyIr,
  migrations: readonly SchemaMigration[] = [],
): Promise<void> {
  const metadata = convertOrThrow({ ir, osdkSet: OSDK_SET, validateOnly: false }, TEST_ONTOLOGY_RID, version).metadata;

  await db.query(
    sql(
      `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
       VALUES ('twin', $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, NULL, $6::jsonb, 'test')`,
      version,
      JSON.stringify(ir),
      JSON.stringify(metadata),
      JSON.stringify({ migrations }),
      JSON.stringify(OSDK_SET),
      JSON.stringify(NO_GRANTS),
    ),
  );
}

async function buildWithNoObjectType(db: Db, needsEngineChanges = false): Promise<void> {
  if (needsEngineChanges) await applyEngineChanges(db);

  for (const version of [1, 2, 3]) await storeVersion(db, version, irOf());

  for (const [number, rid, version] of [
    [1, BEHIND, 1],
    [2, CURRENT, 3],
  ] as const) {
    const schemas = { object: `ontology_${number}_objects`, engine: `ontology_${number}_engine` };

    const changes = ontologyEngineChanges(schemas);

    for (const change of changes) await db.query({ text: change.sql, values: [] });

    await db.query({ text: taskTable(schemas.object), values: [] });

    await db.query(
      sql(
        `INSERT INTO ${schemas.object}.task (task_id, title, done, score, due, tags, details) VALUES
         ('t1', 'Fix the pump', false, 1.50, '2026-01-02T03:04:05.123456Z', ARRAY['a', 'b,c'], 'null'::jsonb),
         ('t2', $1, true, NULL, NULL, NULL, NULL),
         ('t3', 'Check the valve', false, -2.25, '2026-02-03T00:00:00Z', ARRAY[]::text[], '{"a": [1, "x"]}')`,
        'A "quoted", (odd) \\ title\nwith 2 lines',
      ),
    );

    await db.query(
      sql(
        `INSERT INTO ${schemas.engine}.edit_history (object_type, primary_key, entry) VALUES ('Task', 't1', '{"edit": 1}')`,
      ),
    );

    await db.query(
      sql(
        `INSERT INTO ontology_registry.ontologies (number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
         OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $3, $4, $5, 'twin', $6, 'org_1', $7)`,
        number,
        rid,
        `twin${number}`,
        schemas.object,
        schemas.engine,
        version,
        changes.length,
      ),
    );
  }
}

export function createRestoreHarness(tag: string, options: { readonly seedPair?: boolean } = {}): RestoreHarness {
  const role = `restore_${tag}_role`;
  const otherOwner = `restore_${tag}_other`;
  const seedPair = options.seedPair ?? true;
  let postgres: TestPostgres;
  let template: string;
  let databases = 0;
  let directUrl = '';
  let sourceUrl = '';
  let pools: pg.Pool[] = [];
  const createdDatabases: string[] = [];
  let pendingDrop: string[] = [];
  let readyToDrop: string[] = [];
  let direct: Db;
  let source: Db;
  let productions: Db[] = [];

  async function asAdmin(text: string): Promise<void> {
    const admin = new pg.Client({ connectionString: postgres.url });

    await admin.connect();

    try {
      await admin.query(text);
    } finally {
      await admin.end();
    }
  }

  async function asAdminIn(databaseUrl: string, text: string): Promise<void> {
    const admin = new pg.Client({ connectionString: changedDatabase(postgres.url, databaseUrl) });

    await admin.connect();

    try {
      await admin.query(text);
    } finally {
      await admin.end();
    }
  }

  async function newDatabase(
    kind: string,
    dbOptions?: { readonly encoding?: 'LATIN1'; readonly empty?: boolean },
  ): Promise<{ url: string; db: Db }> {
    const name = `restore_${tag}_${kind}_${++databases}`;

    const create = dbOptions?.encoding
      ? `CREATE DATABASE ${name} ENCODING '${dbOptions.encoding}' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`
      : dbOptions?.empty
        ? `CREATE DATABASE ${name}`
        : `CREATE DATABASE ${name} TEMPLATE ${template}`;

    await asAdmin(create);

    createdDatabases.push(name);

    await asAdmin(`GRANT CREATE ON DATABASE ${name} TO ${role}`);

    const address = new URL(postgres.url);

    address.username = role;
    address.password = PASSWORD;
    address.pathname = `/${name}`;

    const pool = createPool(address.toString());

    pools.push(pool);

    return { url: address.toString(), db: createDb(pool) };
  }

  async function newProduction(kind: string, encoding?: 'LATIN1'): Promise<{ url: string; db: Db }> {
    const production = await newDatabase(kind, encoding ? { encoding } : undefined);

    await buildWithNoObjectType(production.db, encoding !== undefined);

    await production.db.query(sql('UPDATE ontology_registry.ontologies SET version = 3 WHERE rid = $1', BEHIND));

    productions.push(production.db);

    return production;
  }

  const env = () => ({ DATABASE_URL_DIRECT: directUrl, RESTORE_SOURCE_URL: sourceUrl });

  async function run(
    args: readonly string[],
    runOptions: Options = {},
    runEnv: Record<string, string> = env(),
  ): Promise<Run> {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');

    try {
      const code = await main(args, runEnv, { now: NOW, ...runOptions });

      return {
        code,
        stdout: log.mock.calls.map(([text]) => String(text)),
        stderr: error.mock.calls.map(([text]) => String(text)),
      };
    } finally {
      log.mockRestore();

      error.mockRestore();
    }
  }

  return {
    role,
    otherOwner,
    postgresUrl: () => postgres.url,
    directUrl: () => directUrl,
    sourceUrl: () => sourceUrl,
    direct: () => direct,
    source: () => source,
    productions: () => productions,
    trackPool: (pool) => void pools.push(pool),
    env,
    asAdmin,
    asAdminIn,
    newDatabase,
    newProduction,
    run,
    beforeAll: async () => {
      postgres = await startPostgres();

      await asAdmin(`CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);

      await asAdmin(`CREATE ROLE ${otherOwner} NOLOGIN`);

      template = await createEngineTemplate(postgres.url, { name: role, password: PASSWORD });
    },
    afterAll: async () => {
      await postgres?.stop();
    },
    beforeEach: async () => {
      for (const name of readyToDrop) await asAdmin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);

      readyToDrop = pendingDrop;

      pendingDrop = [];

      productions = [];

      if (!seedPair) return;

      ({ url: directUrl, db: direct } = await newProduction('direct'));

      ({ url: sourceUrl, db: source } = await newDatabase('source'));

      await buildWithNoObjectType(source);

      for (const schema of ['ontology_1_objects', 'ontology_2_objects']) {
        await direct.query(
          sql(`UPDATE ${schema}.task SET title = 'Changed after the restore time', _version = 2 WHERE task_id = 't1'`),
        );

        await direct.query(sql(`DELETE FROM ${schema}.task WHERE task_id = 't3'`));
      }
    },
    cleanup: async () => {
      await Promise.all(pools.map((pool) => pool.end()));

      pools = [];

      pendingDrop.push(...createdDatabases.splice(0));
    },
  };
}

export function runScript(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', [SCRIPT, ...args], { env: { ...process.env, ...env } }, (failure, stdout, stderr) => {
      resolve({ code: failure ? Number(failure.code) : 0, stdout, stderr });
    });
  });
}

export function line(result: Run): unknown {
  expect(result.stdout).toHaveLength(1);
  expect(result.stderr).toEqual([]);

  return JSON.parse(result.stdout[0] ?? '');
}

export async function state(db: Db): Promise<unknown> {
  const registry = await db.query(
    sql('SELECT ROW(o.*)::text AS row FROM ontology_registry.ontologies o ORDER BY number'),
  );

  const schemas = await db.query<{ name: string }>(
    sql(`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'ontology%' ORDER BY nspname COLLATE "C"`),
  );

  const tables: Record<string, unknown> = {};

  for (const { name } of schemas) {
    const [open] = await db.query<{ open: boolean }>(sql("SELECT has_schema_privilege($1, 'USAGE') AS open", name));

    if (!open?.open) continue;

    for (const table of ['task', 'edit_history']) {
      const [found] = await db.query<{ found: boolean }>(
        sql('SELECT to_regclass($1) IS NOT NULL AS found', `${name}.${table}`),
      );

      if (found?.found)
        tables[`${name}.${table}`] = await db.query(
          sql(`SELECT ROW(t.*)::text AS row FROM ${name}.${table} t ORDER BY 1`),
        );
    }
  }

  return { registry, schemas: schemas.map(({ name }) => name), tables };
}

export async function columnsByRow(db: Db, schema: string): Promise<Record<string, unknown[]>> {
  const tables = await db.query<{ name: string }>(
    sql(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
      schema,
    ),
  );

  const result: Record<string, unknown[]> = {};

  for (const { name } of tables) {
    const columns = await db.query<{ name: string }>(
      sql(
        `SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
        `${quote(schema)}.${quote(name)}`,
      ),
    );

    const texts = columns.map(({ name: column }) => `${quote('x')}.${quote(column)}::text AS ${quote(column)}`);

    result[name] = await db.query(
      sql(
        `SELECT ${texts.join(', ')} FROM ${quote(schema)}.${quote(name)} AS ${quote('x')} ORDER BY ${texts.map((_, index) => index + 1).join(', ')}`,
      ),
    );
  }

  return result;
}

export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function changedDatabase(base: string, database: string): string {
  const address = new URL(base);

  address.pathname = new URL(database).pathname;

  return address.toString();
}

export async function row(db: Db, rid: string): Promise<Record<string, unknown> | undefined> {
  const [found] = await db.query(
    sql(
      'SELECT number, object_schema, engine_schema, product, version, engine_change_count FROM ontology_registry.ontologies WHERE rid = $1',
      rid,
    ),
  );

  return found;
}

export function taskRows(db: Db, schema: string): Promise<Record<string, unknown>[]> {
  return db.query(sql(`SELECT ROW(t.*)::text AS row FROM ${schema}.task t ORDER BY task_id`));
}

export async function schemaExists(db: Db, name: string): Promise<boolean> {
  const [found] = await db.query<{ found: boolean }>(
    sql('SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS found', name),
  );

  return found?.found ?? false;
}

export async function holdRowLock(url: string, rid: string): Promise<{ client: pg.Client; end(): Promise<void> }> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  await client.query('BEGIN');

  await client.query('SELECT 1 FROM ontology_registry.ontologies WHERE rid = $1 FOR UPDATE', [rid]);

  return {
    client,
    end: async () => {
      await client.query('COMMIT');

      await client.end();
    },
  };
}

export async function holdTableLock(url: string, table: string): Promise<{ end(): Promise<void> }> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  await client.query('BEGIN');

  await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);

  return {
    end: async () => {
      await client.query('COMMIT');

      await client.end();
    },
  };
}

export async function dropCommitReply(
  url: string,
  marker: string,
  refuseAfter = false,
): Promise<{ url: string; close(): Promise<void> }> {
  const { hostname, port } = new URL(url);
  let fired = false;

  const server = net.createServer((client) => {
    if (fired && refuseAfter) {
      client.destroy();

      return;
    }

    const upstream = net.connect(Number(port), hostname);
    let armed = false;
    let pending = Buffer.alloc(0);

    client.on('data', (chunk) => {
      if (chunk.includes(marker)) armed = true;

      upstream.write(chunk);
    });

    upstream.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 5) {
        const size = 1 + pending.readInt32BE(1);

        if (pending.length < size) return;

        const message = pending.subarray(0, size);

        pending = pending.subarray(size);

        if (armed && message[0] === 0x43 && message.subarray(5).toString() === 'COMMIT\0') {
          fired = true;

          client.destroy();

          upstream.destroy();

          return;
        }

        client.write(message);
      }
    });

    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      from.on('error', () => to.destroy());

      from.on('close', () => to.destroy());
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = new URL(url);

  address.hostname = '127.0.0.1';
  address.port = String((server.address() as net.AddressInfo).port);

  return { url: address.toString(), close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export async function catalog(db: Db, schema: string): Promise<unknown> {
  const s = (text: string) => sql(text, schema);

  return {
    tables: await db.query(
      s(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
      ),
    ),
    columns: await db.query(
      s(`SELECT table_name, row_number() OVER (PARTITION BY table_name ORDER BY ordinal_position)::int AS position, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default, collation_name
         FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`),
    ),
    constraints: await db.query(
      s(`SELECT c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY 1, 2`),
    ),
    indexes: await db.query(
      s(
        `SELECT tablename, indexname, replace(indexdef, $1 || '.', '<schema>.') AS indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1, 2`,
      ),
    ),
    policies: await db.query(
      s(
        `SELECT tablename, policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = $1 ORDER BY 1, 2`,
      ),
    ),
    access: await db.query(s('SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = $1')),
  };
}

export function recording(inner: Db): { statements: Sql[]; settings: unknown[]; db: Db } {
  const statements: Sql[] = [];
  const settings: unknown[] = [];

  const wrap = (db: Db, top: boolean): Db => ({
    query: (statement) => (statements.push(statement), db.query(statement)),
    stream: (statement) => db.stream(statement),
    transaction: (run) =>
      db.transaction(async (tx) => {
        const result = await run(wrap(tx, false));

        if (top)
          settings.push(
            ...(await tx.query(
              sql(
                "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
              ),
            )),
          );

        return result;
      }),
    snapshot: (run) => db.snapshot(run),
  });

  return { statements, settings, db: wrap(inner, true) };
}
