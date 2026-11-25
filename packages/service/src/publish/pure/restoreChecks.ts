import {
  ontologyEngineChanges,
  REGISTRY_SCHEMA,
  sharedEngineChanges,
  type Db,
  type DbFailure,
  type Schemas,
} from '../../db/index.ts';
import type { AsyncFallible } from '../../errors/index.ts';
import { PRODUCT_VERSIONS } from '../versions.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

const LOCK_TIMEOUT = '90s';

const ONTOLOGY_CHANGES = ontologyEngineChanges({ object: '', engine: '' }).length;

export interface RestoreRow {
  readonly number: number;
  readonly product: string;
  readonly schemas: Schemas;
  readonly version: number;
  readonly engineChangeCount: number;
}

export async function* switchRefusal(
  db: Db,
  live: RestoreRow,
  source: Pick<RestoreRow, 'number' | 'version'>,
): AsyncFallible<string | undefined, DbFailure> {
  if (source.number !== live.number)
    return `The source row has the number ${source.number}, and the live row has the number ${live.number}, so restore switches nothing.`;

  const [version] = yield* db.query({
    text: `SELECT 1 FROM ${PRODUCT_VERSIONS} WHERE product = $1 AND version = $2`,
    values: [live.product, source.version],
  });

  if (!version)
    return `Production has no version ${source.version} of the product ${live.product}, so restore switches nothing.`;

  const [owner] = yield* db.query<{ role: string; owner: string }>({
    text: 'SELECT current_user::text AS role, pg_get_userbyid(nspowner)::text AS owner FROM pg_namespace WHERE nspname = $1',
    values: [live.schemas.object],
  });

  if (owner && owner.owner !== owner.role) {
    return `The role ${owner.role} of the production connection does not own the Object schema ${live.schemas.object} of the live row, which ${owner.owner} owns, so restore switches nothing.`;
  }

  return undefined;
}

export async function* liveEngineDifferences(db: Db, liveCount: number): AsyncFallible<string[], DbFailure> {
  const shared = yield* sharedChanges(db);
  const listed = sharedEngineChanges.map((change) => change.id);

  return [
    ...shared
      .filter((id) => !listed.includes(id))
      .map((id) => `Production has the shared engine change ${id}, which this checkout does not list.`),
    ...listed
      .filter((id) => !shared.includes(id))
      .map((id) => `Production does not have the shared engine change ${id} of this checkout.`),
    ...(liveCount === ONTOLOGY_CHANGES
      ? []
      : [
          `The production row has ${liveCount} per-Ontology engine changes, and this checkout lists ${ONTOLOGY_CHANGES}.`,
        ]),
  ];
}

async function* sharedChanges(db: Db): AsyncFallible<string[], DbFailure> {
  const rows = yield* db.query<{ id: string }>({
    text: `SELECT id FROM ${REGISTRY_SCHEMA}.engine_changes ORDER BY id COLLATE "C"`,
    values: [],
  });

  return rows.map((row) => row.id);
}

export async function* readRow(db: Db, rid: string): AsyncFallible<RestoreRow | undefined, DbFailure> {
  const [row] = yield* db.query<{
    number: number;
    product: string;
    object_schema: string;
    engine_schema: string;
    version: number;
    engine_change_count: number;
  }>({
    text: `SELECT number, product, object_schema, engine_schema, version, engine_change_count FROM ${ONTOLOGIES} WHERE rid = $1`,
    values: [rid],
  });

  return (
    row && {
      number: row.number,
      product: row.product,
      schemas: { object: row.object_schema, engine: row.engine_schema },
      version: row.version,
      engineChangeCount: row.engine_change_count,
    }
  );
}

export async function* missingSchemas(db: Db, names: readonly string[]): AsyncFallible<string[], DbFailure> {
  const rows = yield* db.query<{ name: string }>({
    text: 'SELECT name FROM unnest($1::text[]) WITH ORDINALITY AS u(name, at) WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = name) ORDER BY at',
    values: [names],
  });

  return rows.map((row) => row.name);
}

export async function* setTimeLimits(tx: Db, lockTimeout = LOCK_TIMEOUT): AsyncFallible<void, DbFailure> {
  yield* tx.query({ text: "SELECT set_config('lock_timeout', $1, true)", values: [lockTimeout] });

  yield* tx.query({ text: "SELECT set_config('statement_timeout', '120s', true)", values: [] });
}
