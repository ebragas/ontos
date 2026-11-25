import { invariant, settle, type AsyncFallible } from '../errors/index.ts';
import type { Db, DbFailure, Schemas } from './types.ts';

interface EngineChange {
  readonly id: string;
  readonly sql: string;
}

export const REGISTRY_SCHEMA = 'ontology_registry';

function rowSecurity(table: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
CREATE POLICY ontology_service ON ${table} FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);`;
}

export const sharedEngineChanges: readonly EngineChange[] = [
  {
    id: '0001-registry-schema',
    sql: `CREATE SCHEMA ${REGISTRY_SCHEMA};
REVOKE ALL ON SCHEMA ${REGISTRY_SCHEMA} FROM PUBLIC;
CREATE TABLE ${REGISTRY_SCHEMA}.engine_changes (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
${rowSecurity(`${REGISTRY_SCHEMA}.engine_changes`)}`,
  },
  {
    id: '0002-product-versions',
    sql: `CREATE TABLE ${REGISTRY_SCHEMA}.product_versions (
  product text NOT NULL,
  version integer NOT NULL,
  ir jsonb NOT NULL,
  metadata jsonb NOT NULL,
  schema_migrations jsonb NOT NULL,
  osdk_set jsonb NOT NULL,
  functions jsonb,
  publisher text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product, version)
);
${rowSecurity(`${REGISTRY_SCHEMA}.product_versions`)}`,
  },
  {
    id: '0003-pg-trgm',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA ${REGISTRY_SCHEMA};`,
  },
  {
    id: '0004-ontologies',
    sql: `CREATE TABLE ${REGISTRY_SCHEMA}.ontologies (
  rid text PRIMARY KEY,
  number integer NOT NULL GENERATED ALWAYS AS IDENTITY,
  api_name text NOT NULL,
  display_name text NOT NULL,
  object_schema text NOT NULL,
  engine_schema text NOT NULL,
  product text NOT NULL,
  version integer NOT NULL,
  organization text,
  engine_change_count integer NOT NULL
);
${rowSecurity(`${REGISTRY_SCHEMA}.ontologies`)}`,
  },
  {
    id: '0005-product-version-grants',
    sql: `ALTER TABLE ${REGISTRY_SCHEMA}.product_versions ADD COLUMN grants jsonb;`,
  },
  {
    id: '0006-installation-hold',
    sql: `ALTER TABLE ${REGISTRY_SCHEMA}.ontologies ADD COLUMN held boolean NOT NULL DEFAULT false;`,
  },
];

const SAFE_SCHEMA_NAME = /^[a-z0-9_]+$/;

export function ontologyEngineChanges({ object, engine }: Schemas): readonly EngineChange[] {
  invariant(
    (object === '' && engine === '') || (SAFE_SCHEMA_NAME.test(object) && SAFE_SCHEMA_NAME.test(engine)),
    'Ontology schema names must contain only lowercase ASCII letters, digits, and underscores.',
  );

  return [
    {
      id: '0001-schemas',
      sql: `CREATE SCHEMA ${object};
CREATE SCHEMA ${engine};
REVOKE ALL ON SCHEMA ${object}, ${engine} FROM PUBLIC;`,
    },
    {
      id: '0002-edit-history',
      sql: `CREATE TABLE ${engine}.edit_history (
  object_type text NOT NULL,
  primary_key text NOT NULL,
  entry jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
${rowSecurity(`${engine}.edit_history`)}`,
    },
    {
      id: '0003-edit-history-indexes',
      sql: `CREATE INDEX IF NOT EXISTS edit_history_type_created_pk_idx ON ${engine}.edit_history (object_type, created_at DESC, primary_key COLLATE "C" DESC);
CREATE INDEX IF NOT EXISTS edit_history_type_pk_created_idx ON ${engine}.edit_history (object_type, primary_key, created_at DESC);`,
    },
  ];
}

export const ENGINE_CHANGES_LOCK = 7_234_501;

const UNDEFINED_TABLE = '42P01';

async function* missingSharedChanges(directDb: Db, changes: string): AsyncFallible<readonly EngineChange[], DbFailure> {
  const read = await settle(directDb.query<{ id: string }>({ text: `SELECT id FROM ${changes}`, values: [] }));

  if (!read.ok) {
    if (read.error.kind === 'refused' && postgresCode(read.error.error) === UNDEFINED_TABLE) return sharedEngineChanges;

    return yield read.error;
  }

  const applied = new Set(read.value.map((row) => row.id));

  return sharedEngineChanges.filter((change) => !applied.has(change.id));
}

function postgresCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

export async function* applyEngineChanges(directDb: Db): AsyncFallible<void, DbFailure> {
  const changes = `${REGISTRY_SCHEMA}.engine_changes`;
  const missing = yield* missingSharedChanges(directDb, changes);

  for (const change of missing) {
    yield* directDb.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
      yield* tx.query({ text: 'SELECT pg_advisory_xact_lock($1)', values: [ENGINE_CHANGES_LOCK] });

      const [found] = yield* tx.query<{ table: string | null }>({
        text: `SELECT to_regclass('${changes}')::text AS table`,
        values: [],
      });

      if (found?.table) {
        const applied = yield* tx.query({ text: `SELECT 1 FROM ${changes} WHERE id = $1`, values: [change.id] });

        if (applied.length > 0) return;
      }

      yield* tx.query({ text: change.sql, values: [] });

      yield* tx.query({ text: `INSERT INTO ${changes} (id) VALUES ($1)`, values: [change.id] });
    });
  }

  yield* applyOntologyEngineChanges(directDb);
}

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

async function* applyOntologyEngineChanges(directDb: Db): AsyncFallible<void, DbFailure> {
  const length = ontologyEngineChanges({ object: '', engine: '' }).length;

  const pending = yield* directDb.query<{ rid: string }>({
    text: `SELECT rid FROM ${ONTOLOGIES} WHERE engine_change_count < $1 ORDER BY number`,
    values: [length],
  });

  const failures: { readonly rid: string; readonly failure: DbFailure }[] = [];

  for (const { rid } of pending) {
    const applied = await settle(applyMissingChanges(directDb, rid, length));

    if (!applied.ok) failures.push({ rid, failure: applied.error });
  }

  const [first] = failures;

  if (first === undefined) return;

  const named = failures.map(
    ({ rid, failure: { error } }) => `${rid} (${error instanceof Error ? error.message : String(error)})`,
  );

  return yield {
    kind: first.failure.kind,
    error: new Error(`The per-Ontology engine changes failed for ${named.join(', ')}.`, { cause: first.failure.error }),
  };
}

function applyMissingChanges(directDb: Db, rid: string, length: number): AsyncFallible<void, DbFailure> {
  return directDb.transaction(async function* (tx): AsyncFallible<void, DbFailure> {
    const [row] = yield* tx.query<{ object_schema: string; engine_schema: string; engine_change_count: number }>({
      text: `SELECT object_schema, engine_schema, engine_change_count FROM ${ONTOLOGIES} WHERE rid = $1 FOR UPDATE`,
      values: [rid],
    });

    if (!row || row.engine_change_count >= length) return;

    invariant(
      SAFE_SCHEMA_NAME.test(row.object_schema) && SAFE_SCHEMA_NAME.test(row.engine_schema),
      'Ontology schema names must contain only lowercase ASCII letters, digits, and underscores.',
    );

    const missing = ontologyEngineChanges({ object: row.object_schema, engine: row.engine_schema }).slice(
      row.engine_change_count,
    );

    for (const change of missing) yield* tx.query({ text: change.sql, values: [] });

    yield* tx.query({
      text: `UPDATE ${ONTOLOGIES} SET engine_change_count = $1 WHERE rid = $2`,
      values: [length, rid],
    });
  });
}
