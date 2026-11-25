import {
  ontologyEngineChanges,
  quoteName,
  REGISTRY_SCHEMA,
  type Db,
  type DbFailure,
  type Schemas,
} from '../db/index.ts';
import { invariant, settle, type AsyncFallible } from '../errors/index.ts';
import { lockInstallation, switchToCopy } from './install.ts';
import {
  liveEngineDifferences,
  missingSchemas,
  readRow,
  setTimeLimits,
  switchRefusal,
  type RestoreRow,
} from './pure/restoreChecks.ts';
import {
  chainState,
  onInstallation,
  publishFailure,
  type ChainState,
  type InstallationFailure,
} from './pure/upgradeErrors.ts';
import { limitKind } from './pure/versionLimits.ts';
import { runChain } from './upgrade.ts';

export * from './pure/restorePlan.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

interface SwitchInput {
  readonly rid: string;
  readonly schemas: Schemas;
  readonly source: Pick<RestoreRow, 'number' | 'version' | 'engineChangeCount'>;
  readonly lockTimeout?: string;
}

interface Switched {
  readonly from: RestoreRow;
  readonly to: RestoreRow;
}

type SwitchResult = Switched | string;

export async function* switchInstallation(tx: Db, input: SwitchInput): AsyncFallible<SwitchResult, DbFailure> {
  if (!SCHEMA_FORM.test(input.schemas.object) || !SCHEMA_FORM.test(input.schemas.engine)) {
    return `The schema ${input.schemas.object} or ${input.schemas.engine} is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so restore switches nothing.`;
  }

  yield* setTimeLimits(tx, input.lockTimeout);

  const locked = yield* lockInstallation(tx, input.rid);

  if (!locked) return `No installation has the RID ${input.rid} in production.`;

  const live = yield* readRow(tx, input.rid);

  if (!live) return `No installation has the RID ${input.rid} in production.`;

  const differences = yield* liveEngineDifferences(tx, live.engineChangeCount);

  if (differences.length > 0) {
    return `The engine changes differ from this checkout, so restore switches nothing. ${differences.join(' ')} Run restore again with the checkout of the release that made the change.`;
  }

  const refusal = yield* switchRefusal(tx, live, input.source);

  if (refusal) return refusal;

  const missing = yield* missingSchemas(tx, [input.schemas.object, input.schemas.engine]);

  if (missing.length > 0)
    return `The new schema ${missing.join(' and ')} does not exist, so the switch changed nothing.`;

  for (const change of ontologyEngineChanges(input.schemas).slice(input.source.engineChangeCount))
    yield* tx.query({ text: change.sql, values: [] });

  const state = chainState();

  const chain = await settle(
    onInstallation(input.rid, state, () =>
      runChain(tx, locked, state, { schemas: input.schemas, version: input.source.version }),
    ),
  );

  if (!chain.ok) return yield* stepRefusal(chain.error, state);

  yield* switchToCopy(tx, locked, input.schemas);

  const to = yield* readRow(tx, input.rid);

  invariant(to, `The registry row of ${input.rid} was not read after the switch.`);

  return { from: live, to };
}

async function* stepRefusal(error: InstallationFailure, state: ChainState): AsyncFallible<string, DbFailure> {
  if (limitKind(error.cause) === 'lock') return yield { kind: 'refused', error: error.cause };

  const failure = publishFailure(error);
  const change = failure.parameters['change'];

  if (typeof change !== 'string') return yield { kind: 'refused', error: error.cause };

  return `The upgrade from version ${state.version} failed at version ${state.failedVersion} on "${change}" with ${failure.errorName}, so the row did not switch.`;
}

class Refused extends Error {}

export async function* restoreSwitch(
  directDb: Db,
  input: SwitchInput,
): AsyncFallible<SwitchResult | { readonly waitEnded: true; readonly live: RestoreRow }, DbFailure> {
  const ran = await settle(
    directDb.transaction(async function* (tx): AsyncFallible<Switched, DbFailure> {
      const result = yield* switchInstallation(tx, input);

      if (typeof result === 'string') return yield { kind: 'refused', error: new Refused(result) };

      return result;
    }),
  );

  if (ran.ok) return ran.value;

  const failure = ran.error;

  if (failure.error instanceof Refused) return failure.error.message;

  if (limitKind(failure.error) !== 'lock') return yield failure;

  const row = yield* readRow(directDb, input.rid);

  if (!row) return yield failure;

  return { waitEnded: true, live: row };
}

export function readSettledRow(
  directDb: Db,
  rid: string,
  lockTimeout?: string,
): AsyncFallible<RestoreRow | undefined, DbFailure> {
  return directDb.transaction(async function* (tx): AsyncFallible<RestoreRow | undefined, DbFailure> {
    yield* setTimeLimits(tx, lockTimeout);

    yield* lockInstallation(tx, rid);

    return yield* readRow(tx, rid);
  });
}

interface DropInput {
  readonly schema: string;
  readonly write: boolean;
  readonly lockTimeout?: string;
}

interface DropLine {
  readonly schema: string;
  readonly dropped: boolean;
  readonly errorName?: 'PublishLockTimeout';
}

const SCHEMA_FORM = /^ontology_([1-9][0-9]*)_(objects|engine)(_[0-9]{14})?$/;

export async function* dropSchema(directDb: Db, input: DropInput): AsyncFallible<DropLine | string, DbFailure> {
  const number = SCHEMA_FORM.exec(input.schema)?.[1];

  if (number === undefined) {
    return `The schema ${input.schema} is not of the form ontology_<n>_objects or ontology_<n>_engine, with or without _<stamp>, so drop drops nothing.`;
  }

  const ran = await settle(
    directDb.transaction(async function* (tx): AsyncFallible<DropLine | string, DbFailure> {
      yield* setTimeLimits(tx, input.lockTimeout);

      yield* tx.query({ text: `SELECT 1 FROM ${ONTOLOGIES} WHERE number = $1 FOR UPDATE`, values: [Number(number)] });

      const [named] = yield* tx.query<{ rid: string }>({
        text: `SELECT rid FROM ${ONTOLOGIES} WHERE $1 IN (object_schema, engine_schema)`,
        values: [input.schema],
      });

      if (named) return `The registry row of ${named.rid} names the schema ${input.schema}, so drop drops nothing.`;

      if ((yield* missingSchemas(tx, [input.schema])).length > 0)
        return `The schema ${input.schema} does not exist, so drop drops nothing.`;

      if (input.write) yield* tx.query({ text: `DROP SCHEMA ${quoteName(input.schema)} CASCADE`, values: [] });

      return { schema: input.schema, dropped: input.write };
    }),
  );

  if (ran.ok) return ran.value;

  if (limitKind(ran.error.error) !== 'lock') return yield ran.error;

  return { schema: input.schema, dropped: false, errorName: 'PublishLockTimeout' };
}
