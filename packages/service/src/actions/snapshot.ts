import type { AsyncFallible } from '../errors/index.ts';
import type { Db, DbFailure, SnapshotDb } from '../db/index.ts';

export function runSnapshot<T, E>(
  db: Db,
  run: (snapshot: SnapshotDb) => AsyncFallible<T, E>,
): AsyncFallible<T, E | DbFailure> {
  return db.snapshot(run);
}
