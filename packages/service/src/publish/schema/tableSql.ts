import { columnType, quoteName, type Schemas } from '../../db/index.ts';
import {
  indexName,
  type CompiledObjectType,
  type CompiledProperty,
  type UniquenessConstraint,
} from '../../ontology/index.ts';

export function objectTable(schemas: Schemas, table: string): string {
  return `${quoteName(schemas.object)}.${quoteName(table)}`;
}

export function columnDefinition(property: CompiledProperty, primaryKey: string): string {
  const required = property.required || property.apiName === primaryKey;
  const structDefault = property.type.kind === 'struct' ? ` DEFAULT '{}'::jsonb` : '';

  return `${quoteName(property.column)} ${columnType(property.type)}${structDefault}${required ? ' NOT NULL' : ''}`;
}

export function primaryKeyConstraint(table: string, columns: readonly string[]): string {
  return `CONSTRAINT ${quoteName(indexName('pk', table))} PRIMARY KEY (${columns.map(quoteName).join(', ')})`;
}

export function uniqueConstraint(rule: UniquenessConstraint): string {
  return `CONSTRAINT ${quoteName(rule.constraint)} UNIQUE (${rule.properties.map((p) => quoteName(p.column)).join(', ')}) DEFERRABLE INITIALLY DEFERRED`;
}

export function isNewColumn(before: CompiledObjectType | undefined, after: CompiledProperty): boolean {
  const old = before?.properties.get(after.apiName);

  return !old || columnType(old.type) !== columnType(after.type);
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    const entries =
      item instanceof Map
        ? [...item]
        : typeof item === 'object' && item !== null && !Array.isArray(item)
          ? Object.entries(item)
          : undefined;

    return entries ? Object.fromEntries(entries.sort(([x], [y]) => String(x).localeCompare(String(y)))) : item;
  });
}
