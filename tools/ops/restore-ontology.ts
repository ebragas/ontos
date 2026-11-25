import { createDb, createPool, quoteName, type Db, type DbFailure } from '../../packages/service/src/db/index.ts';
import { caught, settle, step, type AsyncFallible } from '../../packages/service/src/errors/index.ts';
import {
  dropSchema,
  planRestore,
  readSettledRow,
  restoreSwitch,
  stampOf,
  type RestorePlan,
  type RestoreRow,
} from '../../packages/service/src/publish/restore.ts';
import { CONFIRM_RID, exitCodeOf, failureLine, parseWriteArgs, refuse } from './args.ts';

const USAGE =
  'Usage: DATABASE_URL_DIRECT=<url> RESTORE_SOURCE_URL=<url> node tools/ops/restore-ontology.ts restore <rid> [--write --confirm-rid <rid>] | DATABASE_URL_DIRECT=<url> node tools/ops/restore-ontology.ts drop <schema> [--write --confirm-schema <schema>]';

const CONFIRMS = new Map([
  ['restore', CONFIRM_RID],
  ['drop', { flag: 'confirm-schema', noun: 'schema' }],
]);

export interface Options {
  readonly now?: Date;
  readonly lockTimeout?: string;
  readonly copyTimeout?: string;
}

export function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: Options = {},
): Promise<number> {
  const stamp = stampOf(options.now ?? new Date());
  const wait = options.lockTimeout === undefined ? {} : { lockTimeout: options.lockTimeout };

  return exitCodeOf(async () => {
    const parsed = parseWriteArgs(args, USAGE, 1, CONFIRMS);

    if (typeof parsed === 'string') return refuse(parsed.replace('\n', ' '));

    const [command, target, ...rest] = parsed.positionals;

    if (!target || rest.length > 0) return refuse(USAGE);

    const names = command === 'restore' ? ['DATABASE_URL_DIRECT', 'RESTORE_SOURCE_URL'] : ['DATABASE_URL_DIRECT'];
    const missing = names.filter((name) => !env[name]);

    if (missing.length > 0) return refuse(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`);

    if (command === 'drop') {
      const direct = createPool(env['DATABASE_URL_DIRECT'] ?? '', { max: 1 });

      try {
        const ran = await settle(runDrop(createDb(direct), { schema: target, write: parsed.write, ...wait }));

        return ran.ok ? ran.value : refuse(failureLine(ran.error.error));
      } finally {
        await caught(() => direct.end());
      }
    }

    const pools: Pool[] = [];

    try {
      const directUrl = env['DATABASE_URL_DIRECT'] ?? '';

      const direct = await settle(connect(directUrl, 'production', pools));

      if (!direct.ok) return refuse(connectionLine(direct.error.side, direct.error.cause));

      const source = await settle(connect(env['RESTORE_SOURCE_URL'] ?? '', 'source', pools));

      if (!source.ok) return refuse(connectionLine(source.error.side, source.error.cause));

      const ran = await settle(
        runRestore(direct.value, directUrl, source.value, target, parsed.write, stamp, {
          ...wait,
          copyTimeout: options.copyTimeout ?? COPY_STATEMENT_TIMEOUT,
        }),
      );

      return ran.ok ? ran.value : refuse(failureLine(ran.error.error));
    } finally {
      await caught(() => Promise.all(pools.map((pool) => pool.end())));
    }
  });
}

type Pool = ReturnType<typeof createPool>;

type ConnectionSide = 'production' | 'source';

class ConnectionFailed {
  readonly side: ConnectionSide;
  readonly cause: unknown;
  constructor(side: ConnectionSide, cause: unknown) {
    this.side = side;
    this.cause = cause;
  }
}

export function connectionLine(side: ConnectionSide, error: unknown): string {
  return `The ${side} connection failed. ${failureLine(error)}`;
}

async function* connect(url: string, side: ConnectionSide, pools: Pool[]): AsyncFallible<Db, ConnectionFailed> {
  const made = caught(() => createPool(url, { max: 1 }));

  if (!made.ok) return yield new ConnectionFailed(side, made.error);

  pools.push(made.value);

  const db = createDb(made.value);

  const probe = await settle(db.query({ text: 'SELECT 1', values: [] }));

  if (!probe.ok) return yield new ConnectionFailed(side, probe.error.error);

  return db;
}

async function* runDrop(directDb: Db, input: Parameters<typeof dropSchema>[1]): AsyncFallible<number, DbFailure> {
  const line = yield* dropSchema(directDb, input);

  if (typeof line === 'string') return refuse(line);

  console.log(JSON.stringify(line));

  return line.errorName ? 1 : 0;
}

async function* runRestore(
  directDb: Db,
  directUrl: string,
  sourceDb: Db,
  rid: string,
  write: boolean,
  stamp: string,
  limits: { lockTimeout?: string; copyTimeout: string },
): AsyncFallible<number, DbFailure> {
  const { copyTimeout, ...wait } = limits;
  const plan = yield* planRestore(directDb, sourceDb, rid, stamp);

  if (typeof plan === 'string') return refuse(plan);

  const unsupported = yield* unsupportedColumn(sourceDb, plan.source.schemas);

  if (unsupported)
    return refuse(
      `The source column ${unsupported} is a generated or identity column, which the copy does not make, so restore writes nothing.`,
    );

  const to = side({ schemas: plan.schemas, version: plan.newestVersion, engineChangeCount: plan.engineChangeCount });

  if (!write) return print(rid, plan.live, to, plan);

  const left = [plan.schemas.object, plan.schemas.engine] as const;
  const named = `the schemas ${left[0]} and ${left[1]}.`;

  const copied = await settle(copySchemas(sourceDb, directDb, plan, copyTimeout));

  if (!copied.ok) return refuse(`${failureLine(copied.error.error)} The copy may have left ${named}`);

  const switched = await settle(restoreSwitch(directDb, { rid, schemas: plan.schemas, source: plan.source, ...wait }));

  if (!switched.ok) {
    const outcome = await caught(() => switchOutcome(directUrl, rid, plan.schemas, named, wait.lockTimeout));

    return refuse(outcome.ok ? `${failureLine(switched.error.error)} ${outcome.value}` : failureLine(outcome.error));
  }

  const result = switched.value;

  if (typeof result === 'string') return refuse(`${result} The copy left ${named}`);

  if ('waitEnded' in result)
    return print(rid, result.live, side(result.live), plan, { left, errorName: 'PublishLockTimeout' });

  return print(rid, result.from, side(result.to), plan);
}

async function switchOutcome(
  directUrl: string,
  rid: string,
  schemas: RestorePlan['schemas'],
  named: string,
  lockTimeout?: string,
): Promise<string> {
  const pool = createPool(directUrl, { max: 1 });

  try {
    const read = await caught(() => settle(readSettledRow(createDb(pool), rid, lockTimeout)));

    if (!read.ok || !read.value.ok)
      return `The script could not read the registry row, so the row may have switched to ${named}`;

    const row = read.value.value;

    if (row?.schemas.object === schemas.object && row.schemas.engine === schemas.engine)
      return `The row switched to ${named}`;

    return `The row did not switch. The copy left ${named}`;
  } finally {
    await caught(() => pool.end());
  }
}

interface Side {
  readonly objectSchema: string;
  readonly engineSchema: string;
  readonly version: number;
  readonly engineChangeCount: number;
}

function side(row: Pick<RestoreRow, 'schemas' | 'version' | 'engineChangeCount'>): Side {
  return {
    objectSchema: row.schemas.object,
    engineSchema: row.schemas.engine,
    version: row.version,
    engineChangeCount: row.engineChangeCount,
  };
}

interface LockWaitFields {
  readonly left: readonly [string, string];
  readonly errorName: 'PublishLockTimeout';
}

function print(rid: string, live: RestoreRow, to: Side, plan: RestorePlan, lockWait?: LockWaitFields): number {
  console.log(
    JSON.stringify({
      ontologyRid: rid,
      from: side(live),
      to,
      copyVersion: plan.source.version,
      orphans: plan.orphans,
      ...lockWait,
    }),
  );

  return lockWait ? 1 : 0;
}

async function* unsupportedColumn(
  sourceDb: Db,
  schemas: RestorePlan['schemas'],
): AsyncFallible<string | undefined, DbFailure> {
  const [column] = yield* sourceDb.query<{ name: string }>({
    text: `SELECT c.relname || '.' || a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND (a.attidentity <> '' OR a.attgenerated <> '')
           ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", a.attnum LIMIT 1`,
    values: [[schemas.object, schemas.engine]],
  });

  return column?.name;
}

const ROWS_PER_INSERT = 1000;

const COPY_STATEMENT_TIMEOUT = '10min';

interface PostSnapshotDefinitions {
  readonly schema: string;
  readonly statements: readonly string[];
}

async function* copySchemas(
  sourceDb: Db,
  directDb: Db,
  plan: RestorePlan,
  copyTimeout: string,
): AsyncFallible<void, DbFailure> {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [plan.source.schemas.object, plan.schemas.object],
    [plan.source.schemas.engine, plan.schemas.engine],
  ];

  yield* directDb.transaction(async function* (write): AsyncFallible<void, DbFailure> {
    yield* pin(write, { statement_timeout: copyTimeout, ...PARSE_SETTINGS });

    const postSnapshot = yield* sourceDb.snapshot(async function* (read): AsyncFallible<
      PostSnapshotDefinitions[],
      DbFailure
    > {
      yield* pin(read, { statement_timeout: copyTimeout, ...PRINT_SETTINGS });

      const definitions: PostSnapshotDefinitions[] = [];

      for (const [from, to] of pairs) definitions.push(yield* copySchema(read, write, from, to));

      return definitions;
    });

    for (const { schema, statements } of postSnapshot) {
      yield* write.query({ text: "SELECT set_config('search_path', $1, true)", values: [quoteName(schema)] });

      for (const statement of statements) yield* write.query({ text: statement, values: [] });
    }
  });
}

const PRINT_SETTINGS: Readonly<Record<string, string>> = {
  DateStyle: 'ISO, YMD',
  extra_float_digits: '3',
  IntervalStyle: 'iso_8601',
  standard_conforming_strings: 'on',
};

const PARSE_SETTINGS: Readonly<Record<string, string>> = {
  array_nulls: 'on',
  standard_conforming_strings: 'on',
  xmloption: 'content',
};

async function* pin(db: Db, settings: Readonly<Record<string, string>>): AsyncFallible<void, DbFailure> {
  for (const [name, value] of Object.entries(settings))
    yield* db.query({ text: 'SELECT set_config($1, $2, true)', values: [name, value] });
}

async function* copySchema(
  read: Db,
  write: Db,
  from: string,
  to: string,
): AsyncFallible<PostSnapshotDefinitions, DbFailure> {
  yield* read.query({ text: "SELECT set_config('search_path', $1, true)", values: [quoteName(from)] });

  yield* write.query({ text: `CREATE SCHEMA ${quoteName(to)}`, values: [] });

  yield* write.query({ text: `REVOKE ALL ON SCHEMA ${quoteName(to)} FROM PUBLIC`, values: [] });

  yield* write.query({ text: "SELECT set_config('search_path', $1, true)", values: [quoteName(to)] });

  const tables = yield* read.query<{ oid: string; name: string; security: boolean; forced: boolean }>({
    text: `SELECT c.oid::text AS oid, c.relname AS name, c.relrowsecurity AS security, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname COLLATE "C"`,
    values: [from],
  });

  for (const table of tables) yield* copyTable(read, write, from, to, table);

  const statements: string[] = [];

  for (const { oid, name } of tables) {
    const constraints = yield* read.query<{ name: string; definition: string }>({
      text: `SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
             WHERE conrelid = $1::oid AND contype IN ('p', 'u', 'c', 'x', 'f') ORDER BY contype = 'f', conname COLLATE "C"`,
      values: [oid],
    });

    for (const constraint of constraints)
      statements.push(
        `ALTER TABLE ${quoteName(name)} ADD CONSTRAINT ${quoteName(constraint.name)} ${constraint.definition}`,
      );
  }

  for (const { oid } of tables) {
    const indexes = yield* read.query<{ definition: string }>({
      text: `SELECT pg_get_indexdef(i.indexrelid, 0, true) AS definition FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE i.indrelid = $1::oid AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid)
             ORDER BY c.relname COLLATE "C"`,
      values: [oid],
    });

    for (const index of indexes) statements.push(index.definition);
  }

  for (const { oid, name, security, forced } of tables) {
    if (security) statements.push(`ALTER TABLE ${quoteName(name)} ENABLE ROW LEVEL SECURITY`);

    if (forced) statements.push(`ALTER TABLE ${quoteName(name)} FORCE ROW LEVEL SECURITY`);

    const policies = yield* read.query<{
      name: string;
      permissive: boolean;
      command: string;
      roles: string;
      using: string | null;
      check: string | null;
    }>({
      text: `SELECT polname AS name, polpermissive AS permissive, polcmd AS command,
                    (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r)) END, ', ') FROM unnest(polroles) AS r) AS roles,
                    pg_get_expr(polqual, polrelid, true) AS using, pg_get_expr(polwithcheck, polrelid, true) AS check
             FROM pg_policy WHERE polrelid = $1::oid ORDER BY polname COLLATE "C"`,
      values: [oid],
    });

    for (const policy of policies) {
      const clauses = [
        `CREATE POLICY ${quoteName(policy.name)} ON ${quoteName(name)} AS ${policy.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`,
        `FOR ${COMMANDS[policy.command] ?? 'ALL'} TO ${policy.roles}`,
        ...(policy.using === null ? [] : [`USING (${policy.using})`]),
        ...(policy.check === null ? [] : [`WITH CHECK (${policy.check})`]),
      ];

      statements.push(clauses.join(' '));
    }
  }

  return { schema: to, statements };
}

const COMMANDS: Readonly<Record<string, string>> = { '*': 'ALL', r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE' };

async function* copyTable(
  read: Db,
  write: Db,
  from: string,
  to: string,
  table: { oid: string; name: string },
): AsyncFallible<void, DbFailure> {
  const columns = yield* read.query<{
    name: string;
    type: string;
    collation: string | null;
    default: string | null;
    notNull: boolean;
  }>({
    text: `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                  CASE WHEN a.attcollation <> t.typcollation THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END AS collation,
                  pg_get_expr(d.adbin, d.adrelid, true) AS default, a.attnotnull AS "notNull"
           FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    values: [table.oid],
  });

  const definitions = columns.map((column) =>
    [
      quoteName(column.name),
      column.type,
      column.collation && `COLLATE ${column.collation}`,
      column.default && `DEFAULT ${column.default}`,
      column.notNull && 'NOT NULL',
    ]
      .filter(Boolean)
      .join(' '),
  );

  const target = `${quoteName(to)}.${quoteName(table.name)}`;

  yield* write.query({ text: `CREATE TABLE ${target} (${definitions.join(', ')})`, values: [] });

  const insert = (rows: readonly string[]) =>
    write.query({
      text: `INSERT INTO ${target} SELECT (r).* FROM (SELECT v::${target} AS r FROM unnest($1::text[]) AS u(v)) AS s`,
      values: [rows],
    });

  let rows: string[] = [];

  const source = read.stream<{ row: string }>({
    text: `SELECT ROW(source_row.*)::text AS row FROM ${quoteName(from)}.${quoteName(table.name)} AS source_row`,
    values: [],
  });

  for (;;) {
    const next = yield* step(source);

    if (next.done) break;

    rows.push(next.value.row);

    if (rows.length < ROWS_PER_INSERT) continue;

    yield* insert(rows);

    rows = [];
  }

  if (rows.length > 0) yield* insert(rows);
}

if (import.meta.main) {
  const ran = await caught(() => main(process.argv.slice(2), process.env));

  if (!ran.ok) console.error(ran.error);

  process.exitCode = ran.ok ? ran.value : 1;
}
