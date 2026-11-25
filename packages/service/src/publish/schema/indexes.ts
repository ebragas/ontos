import { policyIndexExpression, quoteName, REGISTRY_SCHEMA, type Schemas, type Sql } from '../../db/index.ts';
import { indexName, type CompiledObjectType, type CompiledProperty } from '../../ontology/index.ts';
import { objectTable } from './tableSql.ts';

export function hasTextIndex(property: CompiledProperty): boolean {
  return property.searchable && property.type.kind === 'string';
}

export function createTextIndex(schemas: Schemas, table: string, column: string): Sql {
  return {
    text: `CREATE INDEX ${quoteName(indexName('trgm', table, column))} ON ${objectTable(schemas, table)} USING gin (${quoteName(column)} ${REGISTRY_SCHEMA}.gin_trgm_ops)`,
    values: [],
  };
}

export function dropTextIndex(schemas: Schemas, table: string, column: string): Sql {
  return { text: `DROP INDEX ${quoteName(schemas.object)}.${quoteName(indexName('trgm', table, column))}`, values: [] };
}

export function hasPolicyIndex(type: CompiledObjectType, property: CompiledProperty): boolean {
  return policyIndexExpression(type, property.apiName) !== undefined;
}

export function createPolicyIndex(schemas: Schemas, type: CompiledObjectType, property: CompiledProperty): Sql[] {
  const expression = policyIndexExpression(type, property.apiName);

  if (expression === undefined) return [];

  return [
    {
      text: `CREATE INDEX ${quoteName(indexName('policy', type.table, property.column))} ON ${objectTable(schemas, type.table)} USING gin ((${expression}))`,
      values: [],
    },
  ];
}

export function dropPolicyIndex(schemas: Schemas, table: string, column: string): Sql {
  return {
    text: `DROP INDEX IF EXISTS ${quoteName(schemas.object)}.${quoteName(indexName('policy', table, column))}`,
    values: [],
  };
}
