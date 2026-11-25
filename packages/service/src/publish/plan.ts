import { quoteName, type Schemas, type Sql } from '../db/index.ts';
import { ApiError, VERSION_COLUMN, type Fallible } from '../errors/index.ts';
import {
  emptyOntology,
  indexName,
  type CompiledLinkType,
  type CompiledObjectType,
  type CompiledOntology,
} from '../ontology/index.ts';
import type { SchemaMigration } from './index.ts';
import { createPolicyIndex, createTextIndex, hasTextIndex } from './schema/indexes.ts';
import { changeObjectType } from './schema/objectChanges.ts';
import type { StoredRule } from './schema/storedRules.ts';
import { columnDefinition, objectTable, primaryKeyConstraint, uniqueConstraint } from './schema/tableSql.ts';

export interface Change {
  readonly description: string;
  readonly statements: readonly Sql[];
  readonly table?: string;
  readonly migration?: SchemaMigration;
  readonly storedRules?: readonly StoredRule[];
}

export function planChanges(
  schemas: Schemas,
  ontology: CompiledOntology,
  current = emptyOntology(ontology.metadata.ontology.rid),
): Change[] {
  const changes: Change[] = [];
  const usedColumns = foreignKeyColumns(ontology);
  const indexedProperties = foreignKeyProperties(current);
  const plannedColumns = new Set<string>();

  for (const type of current.objectTypes.values()) {
    if (ontology.objectTypes.has(type.apiName)) continue;

    changes.push({
      description: `Delete Object Type ${type.apiName}`,
      statements: [{ text: `DROP TABLE ${objectTable(schemas, type.table)}`, values: [] }],
      table: `${schemas.object}.${type.table}`,
    });
  }

  for (const link of current.linkTypes.values()) {
    if (sameLink(link, ontology.linkTypes.get(link.apiName))) continue;

    changes.push(deleteLinkType(schemas, link, usedColumns));
  }

  for (const type of ontology.objectTypes.values()) {
    const before = current.objectTypes.get(type.apiName);

    if (before) {
      changes.push(...changeObjectType(schemas, before, type));

      continue;
    }

    changes.push({
      description: `Create Object Type ${type.apiName}`,
      statements: createObjectTable(schemas, type),
      table: `${schemas.object}.${type.table}`,
    });
  }

  for (const link of ontology.linkTypes.values()) {
    if (sameLink(link, current.linkTypes.get(link.apiName))) continue;

    changes.push(createLinkType(schemas, link, foreignKeyIndex(schemas, link, indexedProperties, plannedColumns)));
  }

  for (const action of ontology.actionTypes.values()) {
    if (current.actionTypes.has(action.apiName)) continue;

    changes.push({ description: `Create Action Type ${action.apiName}`, statements: [] });
  }

  for (const action of current.actionTypes.values()) {
    if (!ontology.actionTypes.has(action.apiName)) {
      changes.push({ description: `Delete Action Type ${action.apiName}`, statements: [] });
    }
  }

  return changes;
}

function sameLink(link: CompiledLinkType, other: CompiledLinkType | undefined): boolean {
  return other !== undefined && storageKey(other) === storageKey(link);
}

function storageKey({ storage }: CompiledLinkType): string {
  return JSON.stringify(storage.kind === 'foreignKey' ? { ...storage, property: storage.property.apiName } : storage);
}

function createLinkType(schemas: Schemas, link: CompiledLinkType, index: Pick<Change, 'statements' | 'table'>): Change {
  const description = `Create Link Type ${link.apiName}`;
  const { storage } = link;

  if (storage.kind === 'joinTable') {
    const statements = [
      ...createTable(
        schemas,
        storage.table,
        [`${quoteName(storage.a.column)} text NOT NULL`, `${quoteName(storage.b.column)} text NOT NULL`],
        [storage.a.column, storage.b.column],
      ),
      createLinkIndex(schemas, 'join', storage.table, storage.b.column),
    ];

    return { description, statements, table: `${schemas.object}.${storage.table}` };
  }

  return { description, ...index };
}

function columnKey(table: string, column: string): string {
  return `${table}.${column}`;
}

function foreignKeyColumns(ontology: CompiledOntology): Set<string> {
  const columns = new Set<string>();

  for (const { storage } of ontology.linkTypes.values()) {
    if (storage.kind === 'foreignKey') columns.add(columnKey(storage.table, storage.property.column));
  }

  return columns;
}

function foreignKeyProperties(ontology: CompiledOntology): Set<string> {
  const properties = new Set<string>();

  for (const { storage } of ontology.linkTypes.values()) {
    if (storage.kind === 'foreignKey') properties.add(JSON.stringify([storage.manySide, storage.property.apiName]));
  }

  return properties;
}

function foreignKeyIndex(
  schemas: Schemas,
  link: CompiledLinkType,
  indexed: ReadonlySet<string>,
  planned: Set<string>,
): Pick<Change, 'statements' | 'table'> {
  const { storage } = link;

  if (storage.kind !== 'foreignKey') return { statements: [] };

  const key = columnKey(storage.table, storage.property.column);

  if (planned.has(key) || indexed.has(JSON.stringify([storage.manySide, storage.property.apiName])))
    return { statements: [] };

  planned.add(key);

  return {
    statements: [createLinkIndex(schemas, 'fk', storage.table, storage.property.column)],
    table: `${schemas.object}.${storage.table}`,
  };
}

function deleteLinkType(schemas: Schemas, link: CompiledLinkType, used: ReadonlySet<string>): Change {
  const description = `Delete Link Type ${link.apiName}`;
  const { storage } = link;

  if (storage.kind === 'joinTable') {
    return {
      description,
      statements: [{ text: `DROP TABLE ${objectTable(schemas, storage.table)}`, values: [] }],
      table: `${schemas.object}.${storage.table}`,
    };
  }

  if (used.has(columnKey(storage.table, storage.property.column))) return { description, statements: [] };

  return {
    description,
    statements: [dropForeignKeyIndex(schemas, storage.table, storage.property.column)],
    table: `${schemas.object}.${storage.table}`,
  };
}

function createLinkIndex(schemas: Schemas, kind: 'fk' | 'join', table: string, column: string): Sql {
  return {
    text: `CREATE INDEX ${quoteName(indexName(kind, table, column))} ON ${objectTable(schemas, table)} (${quoteName(column)})`,
    values: [],
  };
}

function dropForeignKeyIndex(schemas: Schemas, table: string, column: string): Sql {
  return {
    text: `DROP INDEX IF EXISTS ${quoteName(schemas.object)}.${quoteName(indexName('fk', table, column))}`,
    values: [],
  };
}

function createObjectTable(schemas: Schemas, type: CompiledObjectType): Sql[] {
  const columns = [...type.properties.values()].map((p) => columnDefinition(p, type.primaryKey.apiName));

  columns.push(`${quoteName(VERSION_COLUMN)} bigint NOT NULL DEFAULT 1`, ...type.uniqueness.map(uniqueConstraint));

  const textIndexes = [...type.properties.values()]
    .filter(hasTextIndex)
    .map((p) => createTextIndex(schemas, type.table, p.column));

  const policyIndexes = [...type.properties.values()].flatMap((p) => createPolicyIndex(schemas, type, p));

  return [...createTable(schemas, type.table, columns, [type.primaryKey.column]), ...textIndexes, ...policyIndexes];
}

function createTable(schemas: Schemas, table: string, columns: readonly string[], key: readonly string[]): Sql[] {
  const name = objectTable(schemas, table);

  return [
    { text: `CREATE TABLE ${name} (${[...columns, primaryKeyConstraint(table, key)].join(', ')})`, values: [] },
    { text: `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`, values: [] },
    {
      text: `CREATE POLICY ontology_service ON ${name} FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)`,
      values: [],
    },
  ];
}

const RESERVED_COLUMNS: ReadonlySet<string> = new Set([
  VERSION_COLUMN,
  'tableoid',
  'xmin',
  'cmin',
  'xmax',
  'cmax',
  'ctid',
]);

export function* checkNames(ontology: CompiledOntology): Fallible<void, ApiError> {
  const tables = new Map<string, string>();

  const claim = (
    scope: Map<string, string>,
    name: string,
    apiName: string,
    where: Record<string, string>,
  ): ApiError | undefined => {
    const other = scope.get(name);

    if (other !== undefined)
      return new ApiError(400, 'Default:InvalidArgument', { ...where, name, apiNames: [other, apiName] });

    scope.set(name, apiName);

    return undefined;
  };

  for (const type of ontology.objectTypes.values()) {
    const taken = claim(tables, type.table, type.apiName, {});

    if (taken) return yield taken;

    const columns = new Map<string, string>();

    for (const property of type.properties.values()) {
      if (RESERVED_COLUMNS.has(property.column)) {
        return yield new ApiError(400, 'Default:InvalidArgument', {
          objectType: type.apiName,
          property: property.apiName,
          reserved: property.column,
        });
      }

      const clash = claim(columns, property.column, property.apiName, { objectType: type.apiName });

      if (clash) return yield clash;
    }
  }

  for (const link of ontology.linkTypes.values()) {
    if (link.storage.kind !== 'joinTable') continue;

    const clash = claim(tables, link.storage.table, link.apiName, {});

    if (clash) return yield clash;
  }
}
