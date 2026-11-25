import { REGISTRY_SCHEMA, type Db, type DbFailure, type Schemas } from '../db/index.ts';
import { ApiError, caught, settle, type AsyncFallible, type Fault } from '../errors/index.ts';
import { readOsdkSets, type CompiledOntology, type StoredOntologyVersion } from '../ontology/index.ts';
import { withoutFunctionParameters } from './convert.ts';
import { inSpan, type CheckedRequest, type PublishResponse } from './index.ts';
import {
  compiledOrDefect,
  insertProductVersion,
  lockInstallation,
  lockProductVersions,
  readInstallations,
  type CheckScope,
  type Installation,
  type LockedInstallation,
} from './install.ts';
import type { Change } from './plan.ts';
import { checkOsdkSet } from './pure/osdkSets.ts';
import {
  checkProductRid,
  checkWorkos,
  described,
  duration,
  formatFailure,
  noStoredValues,
} from './pure/publishHelpers.ts';
import { chainState, onInstallation, type ChainState, type InstallationFailure } from './pure/upgradeErrors.ts';
import { sameParts, STORE_LIMIT } from './pure/versionLimits.ts';
import { checkStoredRules } from './schema/storedRules.ts';
import { planStep, runChain, waited } from './upgrade.ts';
import { checkReservedNames, readNewestNumber, readNewestVersion } from './versions.ts';
import { reconcile } from './workos/reconcile.ts';
import type { WorkosPort } from './workosSteps.ts';

export interface RoleDefaults {
  readonly statementTimeout: string;
  readonly idleInTransactionSessionTimeout: string;
}

const RELEASE_ROLE_DEFAULTS: RoleDefaults = {
  statementTimeout: '60s',
  idleInTransactionSessionTimeout: '90s',
};

export type PublishMode =
  { readonly kind: 'check'; readonly scope: CheckScope } | { readonly kind: 'apply'; readonly scope?: never };

export interface PublishInput {
  readonly product: string;
  readonly productRid: string;
  readonly ontology: CompiledOntology;
  readonly request: CheckedRequest;
  readonly publisher: string;
  readonly mode: PublishMode;
  readonly roleDefaults?: RoleDefaults;
  readonly transactionTimeout?: string;
  readonly log?: (log: PublishLog) => void;
  readonly workos?: WorkosPort;
}

export interface PublishLog {
  readonly outcome: 'applied' | 'validated' | 'failed';
  readonly lockWaitMs: number;
  readonly transactionMs?: number;
  readonly changes: readonly string[];
  readonly versionBefore: number;
  readonly versionAfter: number;
  readonly postgresError?: { readonly code: string; readonly message: string };
}

const LOCK_TIMEOUT = '5s';
const RELEASE_TRANSACTION_TIMEOUT = '60s';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

const NO_SCHEMAS: Schemas = { object: 'no_ontology_objects', engine: 'no_ontology_engine' };

type PublishFailure = ApiError | DbFailure | Fault | InstallationFailure;

interface PublishState {
  lockWaitMs: number;
  transactionMs?: number;
  changes: readonly string[];
  versionBefore: number;
  stored?: number;
}

interface Published {
  readonly response: PublishResponse;
  readonly log: Pick<PublishLog, 'outcome' | 'versionAfter'>;
}

export async function* publishOntology(
  directDb: Db,
  input: PublishInput,
): AsyncFallible<PublishResponse, ApiError | DbFailure | Fault> {
  const state: PublishState = { lockWaitMs: 0, changes: [], versionBefore: 0 };

  const log = (fields: Pick<PublishLog, 'outcome' | 'versionAfter' | 'postgresError'>) =>
    input.log?.({
      lockWaitMs: Math.round(state.lockWaitMs),
      ...(state.transactionMs === undefined ? {} : { transactionMs: state.transactionMs }),
      changes: state.changes,
      versionBefore: state.versionBefore,
      ...fields,
    });

  let ended = false;

  try {
    const ran = await settle(publishing(directDb, input, state));

    ended = true;

    if (ran.ok) {
      log(ran.value.log);

      return ran.value.response;
    }

    const { logError, error } = formatFailure(ran.error, state.transactionMs);

    log({ outcome: 'failed', versionAfter: state.stored ?? state.versionBefore, ...logError });

    return yield error;
  } finally {
    if (!ended) log({ outcome: 'failed', versionAfter: state.stored ?? state.versionBefore });
  }
}

async function* publishing(
  directDb: Db,
  input: PublishInput,
  state: PublishState,
): AsyncFallible<Published, PublishFailure> {
  const { ontology, request, mode } = input;
  const scope = mode.kind === 'check' ? mode.scope : 'product';

  const { current, installations } = yield* inSpan('publish read', {}, async function* (): AsyncFallible<
    { current: StoredOntologyVersion | undefined; installations: Installation[] },
    ApiError | DbFailure
  > {
    const newest = yield* readNewestVersion(directDb, input.product);

    state.versionBefore = newest?.version ?? 0;

    yield* checkProductRid(input, newest);

    yield* checkOsdkSet(readOsdkSets(), request.osdkSet);

    return { current: newest, installations: yield* readInstallations(directDb, input.product, scope) };
  });

  const same = current !== undefined && sameParts(current, request, ontology.metadata);

  const planned = yield* inSpan('publish plan', {}, async function* (): AsyncFallible<
    Change[],
    ApiError | DbFailure | Fault | InstallationFailure
  > {
    const compiled = current && (yield* compiledOrDefect(current));

    return yield* plan(directDb, input, compiled, installations);
  });

  const changes = same ? [] : planned;

  state.changes = changes.map((change) => change.description);

  const port = input.workos;

  const workos = port
    ? yield* inSpan('publish workos', {}, () => checkWorkos(directDb, input, scope, port, current))
    : undefined;

  const checked = {
    changes: described(changes),
    ...(workos && workos.warnings.length > 0 ? { warnings: workos.warnings } : {}),
  };

  if (mode.kind === 'check') {
    const metadata = request.functions ? ontology.metadata : withoutFunctionParameters(ontology);

    return {
      response: { ...checked, metadata, ...(workos && scope === 'product' ? { workosSteps: workos.steps } : {}) },
      log: { outcome: 'validated', versionAfter: state.versionBefore },
    };
  }

  const version = yield* thenReconcile(directDb, input.product, port, state, async function* (): AsyncFallible<
    number,
    PublishFailure
  > {
    if (port && workos) {
      yield* inSpan('publish workos steps', {}, async function* (): AsyncFallible<void, ApiError | Fault> {
        for (const step of workos.steps) yield* port.apply(step);
      });
    }

    return yield* inSpan('publish store', {}, () => transact(directDb, input, state, same));
  });

  return {
    response: { ...checked, metadata: ontology.metadata, version, transactionMs: state.transactionMs ?? 0 },
    log: { outcome: 'applied', versionAfter: version },
  };
}

async function* thenReconcile(
  db: Db,
  product: string,
  port: WorkosPort | undefined,
  state: PublishState,
  apply: () => AsyncFallible<number, PublishFailure>,
): AsyncFallible<number, PublishFailure> {
  if (!port) return yield* apply();

  const run = () => inSpan('publish reconcile', {}, () => reconcile(db, product, port));

  const applied = await settle(apply());

  if (!applied.ok) {
    await caught(() => settle(run()));

    return yield applied.error;
  }

  const version = applied.value;

  state.stored = version;

  const reconciled = await settle(run());

  if (reconciled.ok) return version;

  const { error } = reconciled;

  if (!(error instanceof ApiError && error.errorName === 'OntologyService:WorkosUnavailable')) return yield error;

  return yield new ApiError(error.status, error.errorName, { version, reconciled: false }, error.headers);
}

async function* plan(
  db: Db,
  input: PublishInput,
  compiled: CompiledOntology | undefined,
  installations: readonly Installation[],
): AsyncFallible<Change[], ApiError | DbFailure | Fault | InstallationFailure> {
  yield* checkReservedNames(db, input.product, input.ontology);

  const { ontology, request, mode } = input;
  const migrations = request.schemaMigrations.migrations;
  const standIns = mode.kind === 'check' && !request.functions;

  const withoutData = yield* planStep(noStoredValues, NO_SCHEMAS, compiled, ontology, migrations, {
    standIns,
    hasStoredValues: false,
  });

  const planned = [];

  for (const installation of installations) {
    const state: ChainState = { ...chainState(), phase: 'tableChanges', change: 'check' };

    planned.push(
      yield* onInstallation(installation.rid, state, async function* (): AsyncFallible<Change[], ApiError | DbFailure> {
        const changes = yield* planStep(db, installation.schemas, compiled, ontology, migrations, {
          standIns,
          hasStoredValues: true,
        });

        yield* checkStoredRules(db, installation.schemas, changes);

        return changes;
      }),
    );
  }

  return planned[0] ?? withoutData;
}

async function* transact(
  directDb: Db,
  input: PublishInput,
  state: PublishState,
  same: boolean,
): AsyncFallible<number, PublishFailure> {
  const start = performance.now();

  try {
    return yield* directDb.transaction((tx) => upgradeEach(tx, input, state, same));
  } finally {
    state.transactionMs = Math.round(performance.now() - start);
  }
}

async function* upgradeEach(
  tx: Db,
  input: PublishInput,
  state: PublishState,
  same: boolean,
): AsyncFallible<number, PublishFailure> {
  const defaults = input.roleDefaults ?? RELEASE_ROLE_DEFAULTS;

  yield* tx.query({
    text: "SELECT set_config('lock_timeout', $1, true), set_config('transaction_timeout', $2, true)",
    values: [LOCK_TIMEOUT, duration(input.transactionTimeout ?? RELEASE_TRANSACTION_TIMEOUT)],
  });

  const lock = yield* waited(state, () => lockProductVersions(tx));

  if ((yield* readNewestNumber(tx, input.product)) !== state.versionBefore)
    return yield new ApiError(409, 'PublishLockTimeout', STORE_LIMIT);

  yield* tx.query({
    text: `ALTER ROLE CURRENT_USER SET statement_timeout = '${duration(defaults.statementTimeout)}'`,
    values: [],
  });

  yield* tx.query({
    text: `ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '${duration(defaults.idleInTransactionSessionTimeout)}'`,
    values: [],
  });

  yield* tx.query({ text: 'ALTER ROLE CURRENT_USER SET jit = off', values: [] });

  yield* tx.query({ text: 'ALTER ROLE CURRENT_USER RESET transaction_timeout', values: [] });

  if (same) return state.versionBefore;

  const locked = yield* lockRows(tx, input.product, state);

  const version = yield* insertProductVersion(tx, lock, {
    product: input.product,
    request: input.request,
    metadata: input.ontology.metadata,
    publisher: input.publisher,
  });

  for (const row of locked) {
    const chain = chainState();

    try {
      yield* inSpan('upgrade installation', {}, () => onInstallation(row.rid, chain, () => runChain(tx, row, chain)));
    } finally {
      state.lockWaitMs += chain.lockWaitMs;
    }
  }

  return version;
}

async function* lockRows(
  tx: Db,
  product: string,
  state: PublishState,
): AsyncFallible<LockedInstallation[], PublishFailure> {
  const rows = yield* tx.query<{ rid: string; number: number }>({
    text: `SELECT rid, number FROM ${ONTOLOGIES} WHERE product = $1 ORDER BY number`,
    values: [product],
  });

  const locked: LockedInstallation[] = [];

  for (const { rid, number } of rows) {
    const row = yield* onInstallation(rid, chainState(), () => waited(state, () => lockInstallation(tx, rid), number));

    if (!row) continue;

    if (row.version !== state.versionBefore) return yield new ApiError(500, 'Default:Internal', { ontologyRid: rid });

    locked.push(row);
  }

  return locked;
}
