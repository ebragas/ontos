import type { Db, DbFailure, Writer } from '../db/index.ts';
import { ApiError, invariant, settle, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { CompiledOntology, JsonValue, PrimaryKey } from '../ontology/index.ts';
import type { CheckedEdit, Edit, ObjectLocator } from './edit.ts';
import { entriesSql, type HistoryEntry, type PreviousValues } from './pure/entries.ts';
import { propertiesOf } from './pure/reads.ts';
import {
  editBatchesSql,
  lockBatches,
  lockBatchSql,
  ontologyVersionSql,
  uniqueCheckSql,
  writeLimitSql,
  type LockTarget,
} from './pure/sql.ts';
import { objectKey, objectTypeOf } from './pure/shared.ts';

export interface CheckedVersion {
  readonly object: ObjectLocator;
  readonly version: string;
}

interface LockedRow {
  readonly primaryKey: PrimaryKey;
  readonly [property: `p${number}`]: unknown;
}

export class ObjectChangedError extends ApiError {
  constructor() {
    super(409, 'ObjectChanged');
  }
}

class OntologyChangedError extends ApiError {
  constructor() {
    super(409, 'ObjectChanged');
  }
}

const DEADLOCK_DETECTED = '40P01';
const TRANSACTION_TIMEOUT = '25P04';
const UNIQUE_VIOLATION = '23505';

export async function* writeEdits(
  db: Db,
  writer: Writer,
  ontology: CompiledOntology,
  edits: readonly CheckedEdit[],
  checked: readonly CheckedVersion[],
  checkWrite: () => Fallible<number, ApiError>,
  entriesOf: (previous: PreviousValues) => readonly HistoryEntry[],
): AsyncFallible<void, ApiError | DbFailure> {
  const { edited, linked } = lockedObjects(edits);
  const versions = new Map<string, string>();

  for (const { object, version } of checked) {
    const key = objectKey(object);

    if (!versions.has(key)) versions.set(key, version);
  }

  const target = (object: ObjectLocator, stored: boolean): LockTarget => {
    const version = versions.get(objectKey(object));

    invariant(
      version !== undefined,
      `The Action edits the ${object.objectType} ${object.primaryKey}, and gave no version that its load saw.`,
    );

    return { object, version, stored };
  };

  const locks = lockBatches([
    ...edited.map((object) => target(object, true)),
    ...linked.map((object) => target(object, false)),
  ]);

  const batches = editBatchesSql(writer, ontology, edits);

  yield* checkWrite();

  let runResolved = false;

  const written = await settle(
    db.transaction(async function* (tx): AsyncFallible<void, ApiError | DbFailure> {
      yield* tx.query(writeLimitSql(yield* checkWrite()));

      const stored = new Map<string, ReadonlyMap<string, JsonValue>>();

      for (const batch of locks) {
        const rows = yield* tx.query<LockedRow>(lockBatchSql(writer, ontology, batch));

        if (rows.length !== batch.targets.length) return yield new ObjectChangedError();

        if (batch.stored) {
          const objectType = objectTypeOf(ontology, batch.objectType);

          for (const row of rows) {
            stored.set(
              objectKey({ objectType: batch.objectType, primaryKey: row.primaryKey }),
              propertiesOf(objectType, row),
            );
          }
        }
      }

      for (const batch of batches) {
        const rows = yield* tx.query(batch.sql);

        if (batch.kind === 'link' || rows.length === batch.expected) continue;

        if (batch.kind === 'addObject') return yield new ApiError(409, 'ObjectAlreadyExists');

        invariant(
          false,
          `The ${batch.kind} batch of ${batch.objectType} affected ${rows.length} of ${batch.expected} rows after its version check.`,
        );
      }

      const entries = entriesOf((object) => {
        const values = stored.get(objectKey(object));

        invariant(
          values,
          `The Action edits the ${object.objectType} ${object.primaryKey}, which the write did not lock.`,
        );

        return values;
      });

      if (entries.length > 0) yield* tx.query(entriesSql(writer, entries));

      const [served] = yield* tx.query<{ version: number }>(ontologyVersionSql(ontology));

      if (served?.version !== ontology.version) return yield new OntologyChangedError();

      const check = uniqueCheckSql(ontology, edits);

      if (check) yield* tx.query(check);

      runResolved = true;
    }),
  );

  if (written.ok) return;

  const failure = written.error;
  const error = failure instanceof ApiError ? failure : failure.error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  if (code === DEADLOCK_DETECTED) return yield new ObjectChangedError();

  if (code === TRANSACTION_TIMEOUT) return yield withCause(new ApiError(400, 'ActionDeadlineExceeded'), error);

  if (error instanceof ApiError) return yield error;

  if (runResolved) return yield failure;

  const clash = uniquenessFailure(ontology, error);

  if (clash) return yield clash;

  const check = settle(checkWrite());

  if (!check.ok) return yield withCause(check.error, error);

  return yield failure;
}

function uniquenessFailure(ontology: CompiledOntology, error: unknown): ApiError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  if (code !== UNIQUE_VIOLATION || typeof constraint !== 'string') return undefined;

  for (const objectType of ontology.objectTypes.values()) {
    const rule = objectType.uniqueness.find((candidate) => candidate.constraint === constraint);

    if (rule)
      return new ApiError(409, 'PropertyValueAlreadyExists', {
        objectType: objectType.apiName,
        constraint: rule.name,
        properties: rule.properties.map((property) => property.apiName),
      });
  }

  return constraint.startsWith('unique_') ? new OntologyChangedError() : undefined;
}

function withCause(error: ApiError, cause: unknown): ApiError {
  return Object.assign(error, { cause });
}

export function lockedObjects(edits: readonly Edit[]): {
  readonly edited: readonly ObjectLocator[];
  readonly linked: readonly ObjectLocator[];
} {
  const edited: ObjectLocator[] = [];
  const seen = new Set<string>();

  for (const edit of edits) {
    if (edit.type !== 'modifyObject' && edit.type !== 'deleteObject') continue;

    const key = objectKey(edit.object);

    if (seen.has(key)) continue;

    seen.add(key);

    edited.push(edit.object);
  }

  for (const edit of edits) {
    if (edit.type === 'addObject') seen.add(objectKey(edit.object));
  }

  const linked: ObjectLocator[] = [];

  for (const edit of edits) {
    if (edit.type !== 'addLink' && edit.type !== 'deleteLink') continue;

    for (const object of [edit.source, edit.target]) {
      const key = objectKey(object);

      if (seen.has(key)) continue;

      seen.add(key);

      linked.push(object);
    }
  }

  return { edited, linked };
}
