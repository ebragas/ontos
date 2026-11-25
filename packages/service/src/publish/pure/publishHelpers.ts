import type { Db, DbFailure } from '../../db/index.ts';
import { ApiError, invariant, type AsyncFallible, type Fallible, type Fault } from '../../errors/index.ts';
import { parseGrantsFile, type StoredOntologyVersion } from '../../ontology/index.ts';
import type { PlannedChange } from '../index.ts';
import type { CheckScope } from '../install.ts';
import type { Change } from '../plan.ts';
import type { PublishInput, PublishLog } from '../publishOntology.ts';
import { readStoredGrants } from '../workos/reconcile.ts';
import {
  droppedRoles,
  planWorkosSteps,
  refuseRoleInUse,
  type WorkosPort,
  type WorkosRoles,
  type WorkosStep,
} from '../workosSteps.ts';
import { causeOf, InstallationFailure, publishFailure } from './upgradeErrors.ts';
import { publishLimitError } from './versionLimits.ts';

export const noStoredValues: Db = {
  query: () => noRows(),
  stream: () => noRowStream(),
  transaction: (run) => run(noStoredValues),
  snapshot: () => noSnapshot(),
};

// oxlint-disable-next-line require-yield -- a read of a product with no Ontology gives no row, and it cannot fail.
async function* noRows(): AsyncFallible<never[], never> {
  return [];
}

// oxlint-disable-next-line require-yield -- the same, for a stream.
async function* noRowStream(): AsyncGenerator<never, undefined, undefined> {
  return undefined;
}

// oxlint-disable-next-line require-yield -- a snapshot is a defect when it runs, not when it is called.
async function* noSnapshot(): AsyncFallible<never, never> {
  invariant(false, 'The checks of a product with no Ontology read no snapshot.');
}

const ROLE_IN_USE_SKIPPED =
  'The RoleInUse check did not run, because only the publish workflow and a pull request check run it.';

const NO_ROLES: WorkosRoles = { permissions: new Map(), roles: new Map() };

export function* checkProductRid(
  input: PublishInput,
  current: StoredOntologyVersion | undefined,
): Fallible<void, ApiError> {
  const stored = current?.metadata.ontology.rid;

  if (stored !== undefined && stored !== input.productRid) {
    return yield new ApiError(400, 'Default:InvalidArgument', {
      product: input.product,
      productRid: input.productRid,
      storedProductRid: stored,
    });
  }
}

export async function* checkWorkos(
  db: Db,
  input: PublishInput,
  scope: CheckScope,
  port: WorkosPort,
  current: StoredOntologyVersion | undefined,
): AsyncFallible<
  { readonly steps: readonly WorkosStep[]; readonly warnings: readonly string[] },
  ApiError | DbFailure | Fault
> {
  const { grants } = input.request;
  const read = scope === 'product' ? yield* port.read() : NO_ROLES;
  const newest = current && parseGrantsFile(current.grants);
  const dropped = droppedRoles(newest && 'grants' in newest ? newest.grants : undefined, grants);

  if (scope === 'product') yield* refuseRoleInUse(port, dropped);

  const { roles } = yield* readStoredGrants(db, input.product);
  const skipped = scope !== 'product' && dropped.length > 0;

  return { steps: planWorkosSteps(grants, read, roles), warnings: skipped ? [ROLE_IN_USE_SKIPPED] : [] };
}

export function described(changes: readonly Change[]): PlannedChange[] {
  return changes.map((change) => ({
    description: change.description,
    ...(change.migration ? { migration: change.migration } : {}),
  }));
}

export function duration(value: string): string {
  invariant(/^\d+(ms|s|min|h)$/.test(value), `Not a Postgres time value: ${value}`);

  return value;
}

type PublishFailure = ApiError | DbFailure | Fault | InstallationFailure;

function unwrapped(failure: PublishFailure): PublishFailure {
  if (failure instanceof Error) return failure;

  return failure.error instanceof ApiError || failure.error instanceof InstallationFailure ? failure.error : failure;
}

function publishError(failure: PublishFailure, transactionMs: number | undefined): ApiError | DbFailure | Fault {
  if (failure instanceof InstallationFailure) return publishFailure(failure);

  if (failure instanceof ApiError) return failure;

  const limit = publishLimitError(failure.error);

  if (limit) return limit;

  if (transactionMs !== undefined)
    return Object.assign(new ApiError(500, 'Default:Internal'), { cause: failure.error });

  return failure;
}

function withTransactionMs(
  error: ApiError | DbFailure | Fault,
  transactionMs: number | undefined,
): ApiError | DbFailure | Fault {
  if (transactionMs === undefined || !(error instanceof ApiError)) return error;

  const withMs = new ApiError(error.status, error.errorName, { ...error.parameters, transactionMs }, error.headers);

  return error.cause === undefined ? withMs : Object.assign(withMs, { cause: error.cause });
}

function postgresError(error: unknown): Pick<PublishLog, 'postgresError'> {
  if (error instanceof ApiError || !(error instanceof Error)) return {};

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? { postgresError: { code, message: error.message } } : {};
}

export function formatFailure(
  raw: PublishFailure,
  transactionMs: number | undefined,
): { readonly logError: Pick<PublishLog, 'postgresError'>; readonly error: ApiError | DbFailure | Fault } {
  const failure = unwrapped(raw);
  const logError = postgresError(failure instanceof InstallationFailure ? failure.cause : causeOf(failure));
  const error = withTransactionMs(publishError(failure, transactionMs), transactionMs);

  return { logError, error };
}
