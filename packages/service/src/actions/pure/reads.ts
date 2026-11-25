import { jsonForm, quoteName, readSource, type Reader, type Sql } from '../../db/index.ts';
import type { CompiledObjectType, JsonValue, PrimaryKey, PropertyApiName } from '../../ontology/index.ts';
import { VERSION_COLUMN } from '../../errors/index.ts';

export interface ObjectVersionRow {
  readonly primaryKey: PrimaryKey;
  readonly version: string;
  readonly [property: `p${number}`]: unknown;
}

export function objectsSql(reader: Reader, objectType: CompiledObjectType, primaryKeys: readonly PrimaryKey[]): Sql {
  const values: unknown[] = [primaryKeys];
  const from = readSource(reader, objectType, { add: (value) => `$${values.push(value)}` });
  const column = quoteName(objectType.primaryKey.column);

  return {
    text: `SELECT ${[`${column} AS "primaryKey"`, `${quoteName(VERSION_COLUMN)} AS "version"`, propertyColumns(objectType)].join(', ')} FROM ${from} AS o WHERE ${column} = ANY($1)`,
    values,
  };
}

export function propertyColumns(objectType: CompiledObjectType): string {
  return [...objectType.properties.values()]
    .map((property, index) => `${jsonForm(property.type, quoteName(property.column))} AS "p${index}"`)
    .join(', ');
}

export function propertiesOf(
  objectType: CompiledObjectType,
  row: Readonly<Record<`p${number}`, unknown>>,
): ReadonlyMap<PropertyApiName, JsonValue> {
  const values = [...objectType.properties.keys()].map((property, index): [PropertyApiName, unknown] => [
    property,
    row[`p${index}`],
  ]);

  return new Map(values.filter(([, value]) => value !== null) as [PropertyApiName, JsonValue][]);
}
