import { REGISTRY_SCHEMA } from '../../db/index.ts';
import { ApiError, caught, settle, type AsyncFallible } from '../../errors/index.ts';
import { CompileError } from '../../ontology/index.ts';
import { limitKind } from './versionLimits.ts';

const ONTOLOGIES = `${REGISTRY_SCHEMA}.ontologies`;

export interface ChainState {
  lockWaitMs: number;
  version: number;
  failedVersion: number;
  phase: 'registry' | 'tableChanges';
  table: string;
  change: string | undefined;
}

export function chainState(): ChainState {
  return { lockWaitMs: 0, version: 0, failedVersion: 0, phase: 'registry', table: ONTOLOGIES, change: undefined };
}

export class InstallationFailure extends Error {
  readonly ontologyRid: string;
  readonly phase: ChainState['phase'];
  readonly table: string;
  readonly change: string | undefined;

  constructor(ontologyRid: string, state: ChainState, cause: unknown) {
    super('The upgrade of 1 installation failed.', { cause });

    this.ontologyRid = ontologyRid;
    this.phase = state.phase;
    this.table = state.table;
    this.change = state.change;
  }
}

export function causeOf(failure: unknown): unknown {
  return typeof failure === 'object' && failure !== null && 'kind' in failure && 'error' in failure
    ? failure.error
    : failure;
}

export async function* onInstallation<T, E>(
  ontologyRid: string,
  state: ChainState,
  run: () => AsyncFallible<T, E>,
): AsyncFallible<T, InstallationFailure> {
  const ran = await caught(() => settle(run()));

  if (!ran.ok) return yield new InstallationFailure(ontologyRid, state, ran.error);

  if (ran.value.ok) return ran.value.value;

  if (ran.value.error instanceof InstallationFailure) return yield ran.value.error;

  return yield new InstallationFailure(ontologyRid, state, causeOf(ran.value.error));
}

export function publishFailure(failure: InstallationFailure): ApiError {
  const { cause, ontologyRid } = failure;
  const limit = limitKind(cause);
  const place = { phase: failure.phase, table: failure.table, changed: false, ontologyRid };

  if (limit === 'lock') return new ApiError(409, 'PublishLockTimeout', { ...place, change: 'lock' });

  if (limit === 'timeout') return new ApiError(400, 'PublishTimeExceededLimit', { ...place, change: 'timeout' });

  if (cause instanceof CompileError)
    return new ApiError(400, 'Default:InvalidArgument', { feature: cause.message, ontologyRid, change: 'compile' });

  if (cause instanceof ApiError) {
    const named = (cause as { change?: unknown }).change ?? cause.parameters['change'];
    const change = typeof named === 'string' ? named : (failure.change ?? 'check');

    return new ApiError(cause.status, cause.errorName, { ...cause.parameters, ontologyRid, change }, cause.headers);
  }

  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const onData = failure.change !== undefined && isDataError(code);

  const error = onData
    ? new ApiError(500, 'Default:Internal', { postgresCode: code, ontologyRid, change: failure.change })
    : new ApiError(500, 'Default:Internal');

  return Object.assign(error, { cause });
}

const DATABASE_FAULT_CLASSES: readonly string[] = ['08', '53', '57', '58'];
const DATABASE_FAULT_CODES: readonly string[] = ['XX000'];

function isDataError(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return false;

  const sqlStateClass = code.slice(0, 2);

  return !DATABASE_FAULT_CLASSES.includes(sqlStateClass) && !DATABASE_FAULT_CODES.includes(code);
}
