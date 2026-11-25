import type pg from 'pg';
import type { DbFailure } from './types.ts';

export interface Connection {
  readonly client: pg.PoolClient;
  readonly broken: () => Error | undefined;
  readonly release: (drop: boolean) => void;
}

export const ENDED = 'This transaction has ended. Use its Db only inside the run of transaction or snapshot.';

const answered = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { severity?: unknown }).severity === 'ERROR';

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

export function causeOf(connection: Connection, error: unknown): unknown {
  const broken = connection.broken();

  return codeOf(error) === undefined && codeOf(broken) !== undefined ? broken : error;
}

export const inside =
  (connection?: Connection) =>
  (error: unknown): DbFailure => ({
    kind: 'refused',
    error: connection === undefined ? error : causeOf(connection, error),
  });

const KINDS: readonly unknown[] = ['unavailable', 'refused', 'outcomeUnknown'] satisfies DbFailure['kind'][];

export function withCause<E>(connection: Connection, failure: E): E {
  if (
    typeof failure !== 'object' ||
    failure === null ||
    !('kind' in failure) ||
    !KINDS.includes(failure.kind) ||
    !('error' in failure)
  )
    return failure;

  return { ...failure, error: causeOf(connection, failure.error) };
}

export function commitFailure(connection: Connection | undefined, ended: boolean, error: unknown): DbFailure {
  return {
    kind: ended || answered(error) ? 'refused' : 'outcomeUnknown',
    error: connection === undefined ? error : causeOf(connection, error),
  };
}
