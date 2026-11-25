import { invariant, type AsyncFallible } from '../errors/index.ts';

export interface Sql {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface DbFailure {
  readonly kind: 'unavailable' | 'refused' | 'outcomeUnknown';
  readonly error: unknown;
}

export interface Db {
  query<Row extends object = Record<string, unknown>>(sql: Sql): AsyncFallible<Row[], DbFailure>;
  stream<Row extends object = Record<string, unknown>>(sql: Sql): AsyncGenerator<Row, DbFailure | undefined, undefined>;
  transaction<T, E>(run: (tx: Db) => AsyncFallible<T, E>): AsyncFallible<T, E | DbFailure>;
  snapshot<T, E>(run: (tx: SnapshotDb) => AsyncFallible<T, E>): AsyncFallible<T, E | DbFailure>;
}

declare const snapshotBrand: unique symbol;

export interface SnapshotDb extends Db {
  readonly [snapshotBrand]: true;
}

export interface Schemas {
  readonly object: string;
  readonly engine: string;
}

export function quoteName(name: string): string {
  invariant(!name.includes('\0'), 'A Postgres identifier cannot hold a NUL byte.');

  return `"${name.replaceAll('"', '""')}"`;
}
