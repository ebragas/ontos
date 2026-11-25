import type { Db, DbFailure, Reader, SnapshotDb } from '../db/index.ts';
import { all, ApiError, invariant, type AsyncFallible } from '../errors/index.ts';
import type {
  CompiledActionType,
  CompiledOntology,
  JsonValue,
  ObjectTypeApiName,
  ParameterId,
  PrimaryKey,
  PropertyApiName,
} from '../ontology/index.ts';
import type { Edit } from './edit.ts';
import { criteriaObjectParameters } from './pure/criteria.ts';
import { objectsSql, propertiesOf, type ObjectVersionRow } from './pure/reads.ts';
import { objectKey, objectTypeOf } from './pure/shared.ts';
import { lockedObjects, ObjectChangedError, type CheckedVersion } from './write.ts';

export interface LoadedObject {
  readonly objectType: ObjectTypeApiName;
  readonly primaryKey: PrimaryKey;
  readonly version: string;
  readonly properties: ReadonlyMap<PropertyApiName, JsonValue>;
}

export async function* loadObjectParameters(
  db: Db,
  reader: Reader,
  ontology: CompiledOntology,
  actionType: CompiledActionType,
  values: ReadonlyMap<ParameterId, JsonValue>,
): AsyncFallible<ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>, ApiError | DbFailure> {
  const rules = actionType.logic.kind === 'rules';
  const read = rules ? undefined : criteriaObjectParameters(actionType);
  const loaded = new Map<ParameterId, LoadedObject | readonly LoadedObject[]>();

  for (const parameter of actionType.parameters.values()) {
    const value = values.get(parameter.id);

    if (value === undefined || (read && !read.has(parameter.id))) continue;

    if (parameter.type.kind === 'object') {
      const [object] = yield* readObjects(db, reader, ontology, parameter.type.objectType, [value], rules);

      if (object) loaded.set(parameter.id, object);
    } else if (parameter.type.kind === 'objectList') {
      invariant(
        Array.isArray(value),
        `The parameter check let a non-array value through for Object list parameter ${parameter.id}.`,
      );

      loaded.set(parameter.id, yield* readObjects(db, reader, ontology, parameter.type.objectType, value, rules));
    }
  }

  return loaded;
}

export function checkedVersions(
  edits: readonly Edit[],
  objects: ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>,
): CheckedVersion[] {
  const loaded = [...objects.values()].flat();
  const { edited, linked } = lockedObjects(edits);

  return [...edited, ...linked].map(({ objectType, primaryKey }) => {
    const object = loaded.find(
      (candidate) => candidate.objectType === objectType && candidate.primaryKey === primaryKey,
    );

    invariant(object, `The rules edit the ${objectType} ${primaryKey}, which the apply did not load.`);

    return { object: { objectType, primaryKey }, version: object.version };
  });
}

export async function* snapshotObjects(
  snapshot: SnapshotDb,
  reader: Reader,
  ontology: CompiledOntology,
  edits: readonly Edit[],
  preloaded?: ReadonlyMap<ParameterId, LoadedObject | readonly LoadedObject[]>,
): AsyncFallible<LoadedObject[], ApiError | DbFailure> {
  const known = new Map<string, LoadedObject>();

  if (preloaded !== undefined) {
    for (const entry of preloaded.values()) {
      for (const object of Array.isArray(entry) ? entry : [entry]) known.set(objectKey(object), object);
    }
  }

  const reused: LoadedObject[] = [];
  const missing = new Map<ObjectTypeApiName, PrimaryKey[]>();
  const seen = new Set<string>();

  for (const map of [editedKeys(edits), linkedKeys(edits)]) {
    for (const [objectType, primaryKeys] of map) {
      for (const primaryKey of primaryKeys) {
        const key = objectKey({ objectType, primaryKey });

        if (seen.has(key)) continue;

        seen.add(key);

        const existing = known.get(key);

        if (existing !== undefined) {
          reused.push(existing);

          continue;
        }

        const list = missing.get(objectType);

        if (list) list.push(primaryKey);
        else missing.set(objectType, [primaryKey]);
      }
    }
  }

  if (missing.size === 0) return reused;

  const loaded = yield* readKeys(snapshot, reader, ontology, missing);

  return [...reused, ...loaded];
}

export async function* checkMissing(
  db: Db,
  reader: Reader,
  ontology: CompiledOntology,
  edits: readonly Edit[],
  found: readonly LoadedObject[],
): AsyncFallible<void, ApiError | DbFailure> {
  const absent = (keys: ReadonlyMap<ObjectTypeApiName, readonly PrimaryKey[]>) =>
    [...keys].flatMap(([objectType, primaryKeys]): [ObjectTypeApiName, PrimaryKey[]][] => {
      const missing = primaryKeys.filter(
        (primaryKey) => !found.some((object) => object.objectType === objectType && object.primaryKey === primaryKey),
      );

      return missing.length > 0 ? [[objectType, missing]] : [];
    });

  const required = [...absent(editedKeys(edits, 'modifyObject')), ...absent(linkedKeys(edits))];

  for (const [objectType, primaryKeys] of [...required, ...absent(editedKeys(edits, 'deleteObject'))]) {
    if ((yield* readObjects(db, reader, ontology, objectType, primaryKeys, false)).length > 0)
      return yield new ObjectChangedError();
  }

  if (required.length > 0) return yield new ApiError(404, 'ObjectNotFound', { primaryKey: {} });
}

function editedKeys(
  edits: readonly Edit[],
  kind?: 'modifyObject' | 'deleteObject',
): Map<ObjectTypeApiName, PrimaryKey[]> {
  const keys = new Map<ObjectTypeApiName, PrimaryKey[]>();

  for (const edit of edits) {
    if ((edit.type !== 'modifyObject' && edit.type !== 'deleteObject') || (kind && edit.type !== kind)) continue;

    keys.set(edit.object.objectType, [...(keys.get(edit.object.objectType) ?? []), edit.object.primaryKey]);
  }

  return keys;
}

function linkedKeys(edits: readonly Edit[]): Map<ObjectTypeApiName, PrimaryKey[]> {
  const created = edits.flatMap((edit) => (edit.type === 'addObject' ? [edit.object] : []));
  const keys = new Map<ObjectTypeApiName, PrimaryKey[]>();

  for (const edit of edits) {
    if (edit.type !== 'addLink' && edit.type !== 'deleteLink') continue;

    for (const { objectType, primaryKey } of [edit.source, edit.target]) {
      if (created.some((object) => object.objectType === objectType && object.primaryKey === primaryKey)) continue;

      keys.set(objectType, [...(keys.get(objectType) ?? []), primaryKey]);
    }
  }

  return keys;
}

async function* readKeys(
  snapshot: SnapshotDb,
  reader: Reader,
  ontology: CompiledOntology,
  keys: ReadonlyMap<ObjectTypeApiName, readonly PrimaryKey[]>,
): AsyncFallible<LoadedObject[], ApiError | DbFailure> {
  if (keys.size === 0) return [];

  if (keys.size === 1) {
    const first = [...keys][0];

    return first === undefined ? [] : yield* readObjects(snapshot, reader, ontology, first[0], first[1], false);
  }

  const groups = yield* all(
    [...keys].map(([objectType, primaryKeys]) =>
      readObjects(snapshot, reader, ontology, objectType, primaryKeys, false),
    ),
  );

  return groups.flat();
}

async function* readObjects(
  db: Db,
  reader: Reader,
  ontology: CompiledOntology,
  apiName: ObjectTypeApiName,
  keys: readonly JsonValue[],
  required: boolean,
): AsyncFallible<LoadedObject[], ApiError | DbFailure> {
  const objectType = objectTypeOf(ontology, apiName);

  const primaryKeys = keys.map((key) => {
    invariant(
      typeof key === 'string',
      `The parameter check let the primary key ${JSON.stringify(key)} of ${apiName} through.`,
    );

    return key;
  });

  const rows = yield* db.query<ObjectVersionRow>(objectsSql(reader, objectType, primaryKeys));
  const found = new Map(rows.map((row) => [row.primaryKey, row]));
  const objects: LoadedObject[] = [];

  for (const primaryKey of primaryKeys) {
    const row = found.get(primaryKey);

    if (row === undefined) {
      if (required) return yield new ApiError(404, 'ObjectNotFound', { primaryKey: {} });

      continue;
    }

    objects.push({ objectType: apiName, primaryKey, version: row.version, properties: propertiesOf(objectType, row) });
  }

  return objects;
}
