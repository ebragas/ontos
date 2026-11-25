import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { quoteName, REGISTRY_SCHEMA, type Db, type DbFailure, type Schemas } from '../db/index.ts';
import { ApiError, caught, invariant, settle, type AsyncFallible, type Fault } from '../errors/index.ts';
import {
  CompileError,
  compileOntology,
  readOsdkSets,
  sameOsdkSet,
  type CompiledOntology,
  type StoredOntologyVersion,
} from '../ontology/index.ts';
import { checkColumnLimit, readUsedColumns } from './columnLimit.ts';
import { inSpan, type SchemaMigration, type SchemaMigrationsFile } from './index.ts';
import { moveToNewest, type LockedInstallation } from './install.ts';
import { checkNames, planChanges, type Change } from './plan.ts';
import type { ChainState } from './pure/upgradeErrors.ts';
import { checkStoredRules } from './schema/storedRules.ts';
import { useSchemaMigrations } from './schemaMigrations.ts';
import { PRODUCT_VERSIONS, readNewestNumber } from './versions.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

interface StoredProductVersion extends StoredOntologyVersion {
  readonly schemaMigrations: readonly SchemaMigration[];
}

export async function* readProductVersion(
  db: Db,
  product: string,
  version: number,
): AsyncFallible<StoredProductVersion | undefined, DbFailure> {
  const [row] = yield* db.query<{
    ir: StoredOntologyVersion['ir'];
    metadata: OntologyFullMetadata;
    schema_migrations: SchemaMigrationsFile;
    osdk_set: StoredOntologyVersion['osdkSet'];
    functions: StoredOntologyVersion['functions'] | null;
    grants: StoredOntologyVersion['grants'];
  }>({
    text: `SELECT ir, metadata, schema_migrations, osdk_set, functions, grants FROM ${PRODUCT_VERSIONS} WHERE product = $1 AND version = $2`,
    values: [product, version],
  });

  if (!row) return undefined;

  return {
    version,
    ir: row.ir,
    metadata: row.metadata,
    osdkSet: row.osdk_set,
    ...(row.functions ? { functions: row.functions } : {}),
    grants: row.grants,
    schemaMigrations: row.schema_migrations.migrations,
  };
}

export async function* planStep(
  db: Db,
  schemas: Schemas,
  from: CompiledOntology | undefined,
  to: CompiledOntology,
  migrations: readonly SchemaMigration[],
  options: { readonly standIns: boolean; readonly hasStoredValues: boolean },
): AsyncFallible<Change[], ApiError | DbFailure> {
  yield* checkNames(to);

  const planned = async function* (): AsyncFallible<Change[], ApiError | DbFailure> {
    const changes = yield* useSchemaMigrations(
      db,
      schemas,
      to,
      from,
      planChanges(schemas, to, from),
      migrations,
      options,
    );

    yield* checkColumnLimit(to, from, changes, yield* readUsedColumns(db, schemas));

    return changes;
  };

  const ran = await settle(planned());

  if (ran.ok) return ran.value;

  const failure = ran.error;

  if (!(failure instanceof ApiError) || failure.parameters['change'] !== undefined) return yield failure;

  const objectType = failure.parameters['objectType'];
  const type = typeof objectType === 'string' ? to.objectTypes.get(objectType) : undefined;

  if (!type) return yield failure;

  const change = planChanges(schemas, to, from).find(
    (candidate) => candidate.table === `${schemas.object}.${type.table}`,
  );

  return yield Object.assign(failure, { change: change?.description });
}

async function* lockTables(tx: Db, changes: readonly Change[], state: ChainState): AsyncFallible<void, DbFailure> {
  const tables = [...new Set(changes.flatMap((change) => (change.table ? [change.table] : [])))].sort();

  for (const table of tables) {
    const [schema = '', name = ''] = table.split('.');
    const quoted = `${quoteName(schema)}.${quoteName(name)}`;

    const [row] = yield* tx.query<{ found: boolean }>({
      text: 'SELECT to_regclass($1) IS NOT NULL AS found',
      values: [quoted],
    });

    if (!row?.found) continue;

    state.table = table;

    yield* tx.query({ text: `LOCK TABLE ${quoted} IN SHARE MODE`, values: [] });
  }
}

interface ChainStart {
  readonly schemas: Schemas;
  readonly version: number;
}

type StepFailure = ApiError | DbFailure | CompileError | Fault;

export async function* runChain(
  tx: Db,
  locked: LockedInstallation,
  state: ChainState,
  start: ChainStart = locked,
): AsyncFallible<void, StepFailure> {
  state.phase = 'tableChanges';
  state.version = start.version;

  const newestVersion = yield* readNewestNumber(tx, locked.product);

  state.failedVersion = newestVersion;

  const { osdkSet } = yield* readStored(tx, locked.product, newestVersion);

  if (!readOsdkSets().some((entry) => sameOsdkSet(entry.packages, osdkSet)))
    return yield new ApiError(503, 'OntologyService:OntologyVersionNotSupported');

  state.failedVersion = start.version;

  let from = yield* readCompiled(tx, locked.product, start.version);

  for (let version = start.version + 1; version <= newestVersion; version++) {
    from = yield* inSpan('upgrade step', { 'product.version': version }, () =>
      runStep(tx, locked, start.schemas, from, version, state),
    );
  }

  state.table = ONTOLOGIES;

  yield* moveToNewest(tx, locked);
}

function* compiled(stored: StoredOntologyVersion): Generator<CompileError | Fault, CompiledOntology, never> {
  const ran = caught(() => settle(compileOntology(stored)));

  if (!ran.ok) return yield { kind: 'fault', error: ran.error };

  if (!ran.value.ok) return yield ran.value.error;

  return ran.value.value;
}

async function* runStep(
  tx: Db,
  locked: LockedInstallation,
  schemas: Schemas,
  from: CompiledOntology,
  version: number,
  state: ChainState,
): AsyncFallible<CompiledOntology, StepFailure> {
  state.failedVersion = version;
  state.change = undefined;

  const stored = yield* readStored(tx, locked.product, version);
  const to = yield* compiled(stored);

  const plan = (): AsyncFallible<Change[], ApiError | DbFailure> => {
    state.change = 'check';

    return planStep(tx, schemas, from, to, stored.schemaMigrations, { standIns: false, hasStoredValues: true });
  };

  const planned = yield* plan();

  state.change = undefined;

  yield* waited(state, () => lockTables(tx, planned, state), locked.number);

  for (const change of yield* checkStoredRules(tx, schemas, yield* plan())) {
    state.change = change.description;
    state.table = change.table ?? state.table;

    for (const statement of change.statements) yield* tx.query(statement);
  }

  state.change = undefined;

  return to;
}

export async function* waited<T, E>(
  state: Pick<ChainState, 'lockWaitMs'>,
  run: () => AsyncFallible<T, E>,
  installation?: number,
): AsyncFallible<T, E> {
  const start = performance.now();

  try {
    return yield* inSpan('lock wait', {}, (live) => {
      if (installation !== undefined) live.set('ontology.number', installation);

      return run();
    });
  } finally {
    state.lockWaitMs += performance.now() - start;
  }
}

async function* readCompiled(
  tx: Db,
  product: string,
  version: number,
): AsyncFallible<CompiledOntology, DbFailure | CompileError | Fault> {
  return yield* compiled(yield* readStored(tx, product, version));
}

async function* readStored(tx: Db, product: string, version: number): AsyncFallible<StoredProductVersion, DbFailure> {
  const stored = yield* readProductVersion(tx, product, version);

  invariant(stored, `Product ${product} has no version ${version}.`);

  return stored;
}
