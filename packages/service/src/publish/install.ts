import { ontologyEngineChanges, REGISTRY_SCHEMA, type Db, type DbFailure, type Schemas } from '../db/index.ts';
import { invariant, type ApiError, type AsyncFallible } from '../errors/index.ts';
import type { CompiledOntology } from '../ontology/index.ts';
import { checkNames, planChanges } from './plan.ts';
import type {
  Installation,
  InstallInput,
  LockedInstallation,
  NewProductVersion,
  VersionsLock,
} from './pure/installTypes.ts';
import { PRODUCT_VERSIONS } from './versions.ts';

export * from './pure/installTypes.ts';

export * from './pure/installReads.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

export async function* insertProductVersion(
  tx: Db,
  lock: VersionsLock,
  next: NewProductVersion,
): AsyncFallible<number, DbFailure> {
  void lock;

  const { request } = next;

  const [row] = yield* tx.query<{ version: number }>({
    text: `INSERT INTO ${PRODUCT_VERSIONS} (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
           SELECT $1, coalesce(max(version), 0) + 1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8
           FROM ${PRODUCT_VERSIONS} WHERE product = $1
           RETURNING version`,
    values: [
      next.product,
      JSON.stringify(request.ir),
      JSON.stringify(next.metadata),
      JSON.stringify(request.schemaMigrations),
      JSON.stringify(request.osdkSet),
      request.functions ? JSON.stringify(request.functions) : null,
      JSON.stringify(request.grants),
      next.publisher,
    ],
  });

  invariant(row, 'The product version was not written.');

  return row.version;
}

export async function* moveToNewest(tx: Db, row: LockedInstallation): AsyncFallible<void, DbFailure> {
  yield* tx.query({
    text: `UPDATE ${ONTOLOGIES} o SET version = (SELECT max(v.version) FROM ${PRODUCT_VERSIONS} v WHERE v.product = o.product) WHERE o.rid = $1`,
    values: [row.rid],
  });
}

export async function* switchToCopy(tx: Db, row: LockedInstallation, schemas: Schemas): AsyncFallible<void, DbFailure> {
  yield* tx.query({
    text: `UPDATE ${ONTOLOGIES} SET object_schema = $2, engine_schema = $3, engine_change_count = $4 WHERE rid = $1`,
    values: [row.rid, schemas.object, schemas.engine, ontologyEngineChanges(schemas).length],
  });
}

export async function* installIn(
  tx: Db,
  lock: VersionsLock,
  input: InstallInput,
  newest: CompiledOntology,
): AsyncFallible<Installation, ApiError | DbFailure> {
  void lock;

  const [row] = yield* tx.query<{ object_schema: string; engine_schema: string; version: number }>({
    text: `WITH next AS (SELECT nextval(pg_get_serial_sequence('${ONTOLOGIES}', 'number')) AS number)
      INSERT INTO ${ONTOLOGIES} (number, rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
      OVERRIDING SYSTEM VALUE
      SELECT number, $1, $2, $3, 'ontology_' || number || '_objects', 'ontology_' || number || '_engine', $4,
        (SELECT max(v.version) FROM ${PRODUCT_VERSIONS} v WHERE v.product = $4), $5, $6 FROM next
      RETURNING object_schema, engine_schema, version`,
    values: [input.rid, input.apiName, input.displayName, input.product, input.organization, 0],
  });

  invariant(row, 'The registry row of the new Ontology was not written.');

  const schemas: Schemas = { object: row.object_schema, engine: row.engine_schema };
  const changes = ontologyEngineChanges(schemas);

  for (const change of changes) yield* tx.query({ text: change.sql, values: [] });

  yield* tx.query({
    text: `UPDATE ${ONTOLOGIES} SET engine_change_count = $1 WHERE rid = $2`,
    values: [changes.length, input.rid],
  });

  yield* checkNames(newest);

  for (const change of planChanges(schemas, newest)) {
    for (const statement of change.statements) yield* tx.query(statement);
  }

  return { rid: input.rid, schemas, version: row.version };
}
