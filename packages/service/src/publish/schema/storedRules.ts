import { jsonForm, quoteName, type Db, type DbFailure, type Schemas } from '../../db/index.ts';
import { ApiError, caught, step, type AsyncFallible } from '../../errors/index.ts';
import {
  UNIQUE_STRING_BYTES,
  type CompiledObjectType,
  type CompiledProperty,
  type CompiledValueType,
  type JsonValue,
} from '../../ontology/index.ts';
import { valueTypeCheck } from '../../valueTypes/index.ts';
import type { Change } from '../plan.ts';
import { objectTable } from './tableSql.ts';

const KEY_LIMIT = 10;

export interface StoredRule {
  readonly objectType: CompiledObjectType;
  readonly property?: CompiledProperty;
  readonly find: FindBad;
}

type FindBad =
  | { readonly kind: 'sql'; readonly where: string }
  | { readonly kind: 'valueType'; readonly stored: CompiledProperty; readonly valueType: CompiledValueType };

interface BadObjects {
  readonly count: number;
  readonly primaryKeys: readonly string[];
}

declare const storedChecked: unique symbol;

export type CheckedChange = Change & { readonly [storedChecked]: true };

export async function* checkStoredRules(
  db: Db,
  schemas: Schemas,
  changes: readonly Change[],
): AsyncFallible<readonly CheckedChange[], ApiError | DbFailure> {
  for (const change of changes) {
    for (const rule of change.storedRules ?? []) {
      const bad = yield* findBad(db, schemas, rule);

      if (bad.count > 0) return yield badObjectsError(change.description, rule, bad);
    }
  }

  return changes as readonly CheckedChange[];
}

function findBad(db: Db, schemas: Schemas, rule: StoredRule): AsyncFallible<BadObjects, DbFailure> {
  const { find } = rule;

  return find.kind === 'sql'
    ? findBadRows(db, schemas, rule.objectType, find.where)
    : findBadValues(db, schemas, rule.objectType, find.stored, find.valueType);
}

async function* findBadRows(
  db: Db,
  schemas: Schemas,
  objectType: CompiledObjectType,
  where: string,
): AsyncFallible<BadObjects, DbFailure> {
  const key = quoteName(objectType.primaryKey.column);

  const rows = yield* db.query<{ count: number; key: string }>({
    text: `SELECT count(*) OVER ()::int AS count, ${key}::text AS key FROM ${objectTable(schemas, objectType.table)} WHERE (${where}) ORDER BY ${key} LIMIT ${KEY_LIMIT}`,
    values: [],
  });

  return { count: rows[0]?.count ?? 0, primaryKeys: rows.map((row) => row.key) };
}

async function* findBadValues(
  db: Db,
  schemas: Schemas,
  objectType: CompiledObjectType,
  property: CompiledProperty,
  valueType: CompiledValueType,
): AsyncFallible<BadObjects, DbFailure> {
  const fails = valueTypeCheck(valueType);
  const key = quoteName(objectType.primaryKey.column);
  const column = quoteName(property.column);

  const rows = db.stream<{ key: string; value: JsonValue }>({
    text: `SELECT ${key}::text AS key, ${jsonForm(property.type, column)} AS value FROM ${objectTable(schemas, objectType.table)} WHERE ${column} IS NOT NULL ORDER BY ${key}`,
    values: [],
  });

  let count = 0;
  const primaryKeys: string[] = [];

  try {
    for (let next = yield* step(rows); !next.done; next = yield* step(rows)) {
      const { value } = next.value;

      if ((Array.isArray(value) && value.length === 0) || !fails(value)) continue;

      count += 1;

      if (primaryKeys.length < KEY_LIMIT) primaryKeys.push(next.value.key);
    }
  } finally {
    await caught(() => rows.return(undefined));
  }

  return { count, primaryKeys };
}

function badObjectsError(change: string, rule: StoredRule, bad: BadObjects): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', {
    change,
    objectType: rule.objectType.apiName,
    ...(rule.property ? { property: rule.property.apiName } : {}),
    ...(rule.find.kind === 'valueType' ? { valueType: rule.find.valueType.apiName } : {}),
    badObjects: bad.count,
    primaryKeys: bad.primaryKeys,
  });
}

export function requiredRule(
  objectType: CompiledObjectType,
  property: CompiledProperty,
  columnIsNew = false,
): StoredRule {
  return {
    objectType,
    property,
    find: { kind: 'sql', where: columnIsNew ? 'TRUE' : `${quoteName(property.column)} IS NULL` },
  };
}

export function uniqueRules(
  schemas: Schemas,
  objectType: CompiledObjectType,
  stored: readonly CompiledProperty[],
): readonly StoredRule[] {
  const columns = stored.map((p) => quoteName(p.column));
  const key = quoteName(objectType.primaryKey.column);
  const [property] = stored;
  const named = stored.length === 1 && property ? { property } : {};

  const strings = stored
    .filter((p) => p.type.kind === 'string')
    .map((p) => `octet_length(${quoteName(p.column)}) > ${UNIQUE_STRING_BYTES}`);

  const tooLong: StoredRule[] =
    strings.length > 0 ? [{ objectType, ...named, find: { kind: 'sql', where: strings.join(' OR ') } }] : [];

  const groups = `SELECT ${key}, count(*) OVER (PARTITION BY ${columns.join(', ')}) AS n FROM ${objectTable(schemas, objectType.table)} WHERE ${columns.map((c) => `${c} IS NOT NULL`).join(' AND ')}`;

  return [
    ...tooLong,
    {
      objectType,
      ...named,
      find: { kind: 'sql', where: `${key} IN (SELECT ${key} FROM (${groups}) AS g WHERE n > 1)` },
    },
  ];
}

export function valueTypeRule(
  objectType: CompiledObjectType,
  stored: CompiledProperty,
  valueType: CompiledValueType,
): StoredRule {
  return { objectType, property: stored, find: { kind: 'valueType', stored, valueType } };
}
