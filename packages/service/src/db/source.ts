import type { VERSION_COLUMN } from '../errors/index.ts';
import type { CompiledLink, CompiledObjectType } from '../ontology/index.ts';
import { objectPolicySql, policySql, propertiesRead, propertyOf, sameFormJsonSql } from './policy.ts';
import type { Reader, SqlValues } from './reader.ts';
import { boundOf, joinTableOf } from './readerStore.ts';
import { quoteName, type Schemas } from './types.ts';
import { OPERATION_ID_SQL } from './writeTables.ts';

export * from './writeTables.ts';

export { policyIndexExpression, policySql } from './policy.ts';

const VERSION: typeof VERSION_COLUMN = '__version';

const ROW = 's';

const DELETED_ROW = 'deleted';

type LinkJoin = Extract<CompiledLink['via'], { readonly kind: 'joinTable' }>;

export function readSource(reader: Reader, objectType: CompiledObjectType, values: SqlValues): string {
  const { schemas } = boundOf(reader);
  const table = tableName(schemas, objectType.table);
  const { policy } = objectType;
  const properties = [...objectType.properties.values()];
  const masked = properties.some((property) => property.policy !== undefined);

  if (policy === undefined && !masked) return table;

  const columns = masked
    ? [
        ...properties.map((property) => {
          const column = `${ROW}.${quoteName(property.column)}`;

          return property.policy === undefined
            ? column
            : `CASE WHEN ${policySql(property.policy, objectType, ROW, reader, values)} THEN ${column} END AS ${quoteName(property.column)}`;
        }),
        `${ROW}.${quoteName(VERSION)}`,
      ].join(', ')
    : `${ROW}.*`;

  if (policy === undefined) return `(SELECT ${columns} FROM ${table} AS ${ROW})`;

  return `(SELECT ${columns} FROM ${table} AS ${ROW} WHERE ${objectPolicySql(policy, objectType, ROW, reader, values)})`;
}

export function historySource(reader: Reader, objectType: CompiledObjectType, values: SqlValues): string {
  const { schemas } = boundOf(reader);
  const history = historyName(schemas);
  const { policy } = objectType;

  const propertyPolicies = [...objectType.properties.values()].flatMap((property) =>
    property.policy === undefined ? [] : [property.policy],
  );

  if (policy === undefined && propertyPolicies.length === 0) return history;

  const table = tableName(schemas, objectType.table);
  const key = quoteName(objectType.primaryKey.column);
  const type = values.add(objectType.apiName);

  const read = new Set([
    ...(policy ? propertiesRead(policy) : []),
    ...propertyPolicies.flatMap((propertyPolicy) => [...propertiesRead(propertyPolicy)]),
  ]);

  const fields = [...read].map(
    (name) =>
      `${values.add(propertyOf(objectType, name).column)}::text, ${sameFormJsonSql(objectType, name, `d.entry -> 'edit' -> 'previousProperties' -> ${values.add(name)}::text`)}`,
  );

  const visibleOn = (row: string, primaryKey: string) => {
    const names = [...objectType.properties.values()].map((property) => {
      const name = `${values.add(property.apiName)}::text`;

      return property.policy === undefined
        ? name
        : `CASE WHEN ${policySql(property.policy, objectType, row, reader, values)} THEN ${name} END`;
    });

    return `${primaryKey} AS key, array_remove(ARRAY[${names.join(', ')}], NULL) AS names`;
  };

  const passes = (row: string) => (policy ? objectPolicySql(policy, objectType, row, reader, values) : 'TRUE');

  const latestDeletes = `SELECT DISTINCT ON (primary_key) primary_key, entry, created_at, op, prev_created_at, prev_op FROM (SELECT primary_key, entry, created_at, ${OPERATION_ID_SQL} AS op, LAG(created_at) OVER (PARTITION BY primary_key ORDER BY created_at, ${OPERATION_ID_SQL}) AS prev_created_at, LAG(${OPERATION_ID_SQL}) OVER (PARTITION BY primary_key ORDER BY created_at, ${OPERATION_ID_SQL}) AS prev_op FROM ${history} WHERE object_type = ${type} AND entry -> 'edit' ->> 'type' = 'deleteEdit') AS deletes ORDER BY primary_key, created_at DESC, op DESC`;

  const visible = `SELECT ${visibleOn('c', `c.${key}`)}, ld.created_at AS after_time, ld.op AS after_op FROM ${table} AS c LEFT JOIN (${latestDeletes}) AS ld ON ld.primary_key = c.${key} WHERE ${passes('c')}
    UNION ALL
    SELECT ${visibleOn(DELETED_ROW, 'd.primary_key')}, d.prev_created_at AS after_time, d.prev_op AS after_op FROM (${latestDeletes}) AS d CROSS JOIN LATERAL jsonb_populate_record(NULL::${table}, jsonb_build_object(${fields.join(', ')})) AS ${DELETED_ROW}
    WHERE NOT EXISTS (SELECT 1 FROM ${table} AS g WHERE g.${key} = d.primary_key) AND ${passes(DELETED_ROW)}`;

  const kept = `(SELECT coalesce(jsonb_object_agg(p.key, p.value), '{}') FROM jsonb_each(f.value) AS p WHERE p.key = ANY(v.names))`;
  const maps = `(SELECT coalesce(jsonb_object_agg(f.key, ${kept}), '{}') FROM jsonb_each(h.entry -> 'edit') AS f WHERE f.key IN ('properties', 'previousProperties'))`;
  const entry = `jsonb_set(h.entry, '{edit}', (h.entry -> 'edit') || ${maps})`;

  return `(SELECT h.object_type, h.primary_key, ${entry} AS entry, h.created_at FROM ${history} AS h JOIN (${visible}) AS v ON v.key = h.primary_key WHERE h.object_type = ${type} AND (v.after_time IS NULL OR (h.created_at, ${OPERATION_ID_SQL}) > (v.after_time, v.after_op)))`;
}

export function linkSource(reader: Reader, join: LinkJoin): string {
  return tableName(boundOf(reader).schemas, joinTableOf(join, ['link']));
}

function tableName(schemas: Schemas, table: string): string {
  return `${quoteName(schemas.object)}.${quoteName(table)}`;
}

function historyName(schemas: Schemas): string {
  return `${quoteName(schemas.engine)}.edit_history`;
}
