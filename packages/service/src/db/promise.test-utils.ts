import {
  applyEngineChanges as applyChanges,
  createDb as createFallibleDb,
  openReader as openFallibleReader,
} from './index.ts';
import type { Db as FallibleDb, DbFailure, SnapshotDb as FallibleSnapshotDb, Sql } from './index.ts';
import { attempt, caught, settle, type AsyncFallible } from '../errors/index.ts';
import { orThrow } from '../errors/fallible.ts';

export interface Db {
  query<Row extends object = Record<string, unknown>>(sql: Sql): Promise<Row[]>;
  stream<Row extends object = Record<string, unknown>>(sql: Sql): AsyncIterable<Row>;
  transaction<T>(run: (tx: Db) => Promise<T>): Promise<T>;
  snapshot<T>(run: (tx: SnapshotDb) => Promise<T>): Promise<T>;
}

declare const snapshotBrand: unique symbol;

export interface SnapshotDb extends Db {
  readonly [snapshotBrand]: true;
}

type SnapshotBrand = Exclude<keyof SnapshotDb, keyof Db>;

const branded = (tx: Db): SnapshotDb => Object.assign(tx, {} as Record<SnapshotBrand, true>);

export { createPool } from './index.ts';

export const createDb = (pool: Parameters<typeof createFallibleDb>[0]): Db => promiseOf(createFallibleDb(pool));

export const openReader = (
  db: Db,
  ...rest: Parameters<typeof openFallibleReader> extends [unknown, ...infer R] ? R : never
) => rejecting(openFallibleReader(fallibleOf(db), ...rest));

export const applyEngineChanges = (directDb: Db): Promise<void> => rejecting(applyChanges(fallibleOf(directDb)));

export const transact = <T>(db: Db, run: (tx: FallibleDb, bridged: Db) => AsyncFallible<T, unknown>): Promise<T> =>
  db.transaction((tx) => rejecting(run(fallibleOf(tx), tx)));

export function promiseOf(db: FallibleDb): Db {
  return {
    query: (sql) => rejecting(db.query(sql)),
    stream: (sql) => thrownRows(db.stream(sql)),
    transaction: (run) => rejecting(db.transaction((tx) => carried(() => run(promiseOf(tx))))),
    snapshot: (run) => rejecting(db.snapshot((tx) => carried(() => run(branded(promiseOf(tx)))))),
  };
}

export function fallibleOf(db: Db): FallibleDb {
  return {
    query: (sql) => attempt(() => db.query(sql), kept),
    stream: (sql) => failureRows(db.stream(sql)),
    transaction: (run) => attempt(() => db.transaction((tx) => rejecting(run(fallibleOf(tx)))), kept),
    snapshot: (run) => attempt(() => db.snapshot((tx) => rejecting(run(fallibleOf(tx) as FallibleSnapshotDb))), kept),
  };
}

const refused = (error: unknown): DbFailure => ({ kind: 'refused', error });

const kinds = new WeakMap<object, DbFailure['kind']>();

const kept = (error: unknown): DbFailure => ({
  kind: (typeof error === 'object' && error !== null && kinds.get(error)) || 'refused',
  error,
});

async function* carried<T>(run: () => Promise<T>): AsyncFallible<T, DbFailure> {
  const ran = await caught(run);

  if (!ran.ok) return yield refused(ran.error);

  return ran.value;
}

export function rejecting<T>(run: AsyncFallible<T, unknown>): Promise<T> {
  return orThrow(errorOf(run));
}

async function* errorOf<T>(run: AsyncFallible<T, unknown>): AsyncFallible<T, unknown> {
  const ran = await settle(run);

  if (ran.ok) return ran.value;

  const failure = ran.error;

  if (typeof failure !== 'object' || failure === null || !('kind' in failure) || !('error' in failure))
    return yield failure;

  const { error } = failure as DbFailure;

  if (typeof error === 'object' && error !== null) kinds.set(error, (failure as DbFailure).kind);

  return yield error;
}

async function* thrownRows<Row>(rows: AsyncGenerator<Row, DbFailure | undefined, undefined>): AsyncGenerator<Row> {
  const failure = yield* rows;

  if (failure) throw failure.error;
}

async function* failureRows<Row>(rows: AsyncIterable<Row>): AsyncGenerator<Row, DbFailure | undefined, undefined> {
  const read = rows[Symbol.asyncIterator]();
  let ended = false;

  try {
    for (;;) {
      const step = await caught(() => read.next());

      ended = !step.ok || step.value.done === true;

      if (!step.ok) return kept(step.error);

      if (step.value.done) return undefined;

      yield step.value.value;
    }
  } finally {
    if (!ended) await caught(async () => read.return?.());
  }
}
