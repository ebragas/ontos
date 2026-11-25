import {
  columnType,
  quoteName,
  REGISTRY_SCHEMA,
  WRITE_VERSION,
  writeLinkTable,
  writeTable,
  type Sql,
  type Writer,
} from '../../db/index.ts';
import { invariant, VERSION_COLUMN } from '../../errors/index.ts';
import type {
  CompiledLink,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  JsonValue,
  ObjectTypeApiName,
} from '../../ontology/index.ts';
import type { CheckedEdit, Edit, ObjectLocator } from '../edit.ts';
import { objectTypeOf, withoutNullFields } from './shared.ts';

export * from './locks.ts';

export type EditBatch =
  | { readonly kind: 'addObject'; readonly objectType: ObjectTypeApiName; readonly expected: number; readonly sql: Sql }
  | {
      readonly kind: 'modifyObject';
      readonly objectType: ObjectTypeApiName;
      readonly expected: number;
      readonly sql: Sql;
    }
  | {
      readonly kind: 'deleteObject';
      readonly objectType: ObjectTypeApiName;
      readonly expected: number;
      readonly sql: Sql;
    }
  | { readonly kind: 'link'; readonly sql: Sql };

type AddEdit = Extract<CheckedEdit, { readonly type: 'addObject' }>;

type ModifyEdit = Extract<CheckedEdit, { readonly type: 'modifyObject' }>;

type DeleteEdit = Extract<CheckedEdit, { readonly type: 'deleteObject' }>;

type LinkEdit = Extract<CheckedEdit, { readonly type: 'addLink' | 'deleteLink' }>;

type LinkJoin = Extract<CompiledLink['via'], { readonly kind: 'joinTable' }>;

export function editBatchesSql(writer: Writer, ontology: CompiledOntology, edits: readonly CheckedEdit[]): EditBatch[] {
  const adds = new Map<ObjectTypeApiName, AddEdit[]>();
  const modifies = new Map<ObjectTypeApiName, ModifyEdit[]>();
  const deletes = new Map<ObjectTypeApiName, DeleteEdit[]>();
  const links = new Map<string, { readonly via: LinkJoin; readonly edit: LinkEdit }[]>();

  for (const edit of edits) {
    switch (edit.type) {
      case 'addObject':
        pushTo(adds, edit.object.objectType, edit);

        break;
      case 'modifyObject':
        pushTo(modifies, edit.object.objectType, edit);

        break;
      case 'deleteObject':
        pushTo(deletes, edit.object.objectType, edit);

        break;
      case 'addLink':
      case 'deleteLink': {
        const via = joinOf(objectTypeOf(ontology, edit.source.objectType), edit.link);

        pushTo(links, writeLinkTable(writer, via), { via, edit });

        break;
      }
    }
  }

  const batches: EditBatch[] = [];

  for (const [objectType, group] of sortedEntries(deletes)) {
    const ordered = sortByKey(group);

    batches.push({
      kind: 'deleteObject',
      objectType,
      expected: ordered.length,
      sql: deleteObjectsSql(writer, ontology, objectType, ordered),
    });
  }

  for (const [objectType, group] of sortedEntries(modifies)) {
    const ordered = sortByKey(group);

    batches.push({
      kind: 'modifyObject',
      objectType,
      expected: ordered.length,
      sql: modifyObjectsSql(writer, ontology, objectType, ordered),
    });
  }

  for (const [objectType, group] of sortedEntries(adds)) {
    const ordered = sortByKey(group);

    batches.push({
      kind: 'addObject',
      objectType,
      expected: ordered.length,
      sql: addObjectsSql(writer, ontology, objectType, ordered),
    });
  }

  for (const [, group] of sortedEntries(links)) {
    for (const run of linkRuns(group)) {
      batches.push({ kind: 'link', sql: linkRunSql(writer, run) });
    }
  }

  return batches;
}

function addObjectsSql(
  writer: Writer,
  ontology: CompiledOntology,
  apiName: ObjectTypeApiName,
  edits: readonly AddEdit[],
): Sql {
  const objectType = objectTypeOf(ontology, apiName);
  const pk = keyColumn(objectType);

  const present = [...objectType.properties.values()].filter(
    (property) =>
      property.apiName !== objectType.primaryKey.apiName && edits.some((edit) => edit.properties.has(property.apiName)),
  );

  const columns = [quoteName(VERSION_COLUMN), pk];
  const selectExprs = [WRITE_VERSION, 'u.__pk'];
  const unnestArgs = ['$1::text[]'];
  const unnestAliases = ['__pk'];
  const values: unknown[] = [edits.map((edit) => edit.object.primaryKey)];

  present.forEach((property, index) => {
    const alias = `__c${index}`;

    columns.push(quoteName(property.column));

    values.push(
      edits.map((edit) => {
        if (!edit.properties.has(property.apiName)) return property.type.kind === 'struct' ? '{}' : null;

        return unnestValue(property, edit.properties.get(property.apiName) ?? null);
      }),
    );

    unnestArgs.push(`$${values.length}::${unnestType(property)}`);

    unnestAliases.push(alias);

    selectExprs.push(unnestExpr(property, `u.${alias}`));
  });

  return {
    text: `INSERT INTO ${writeTable(writer, objectType)} (${columns.join(', ')}) SELECT ${selectExprs.join(', ')} FROM unnest(${unnestArgs.join(', ')}) AS u(${unnestAliases.join(', ')}) ON CONFLICT (${pk}) DO NOTHING RETURNING 1 AS created`,
    values,
  };
}

function modifyObjectsSql(
  writer: Writer,
  ontology: CompiledOntology,
  apiName: ObjectTypeApiName,
  edits: readonly ModifyEdit[],
): Sql {
  const objectType = objectTypeOf(ontology, apiName);
  const pk = keyColumn(objectType);

  const present = [...objectType.properties.values()].filter(
    (property) =>
      property.apiName !== objectType.primaryKey.apiName && edits.some((edit) => edit.properties.has(property.apiName)),
  );

  const assignments = [`${quoteName(VERSION_COLUMN)} = ${WRITE_VERSION}`];
  const unnestArgs = ['$1::text[]'];
  const unnestAliases = ['__pk'];
  const values: unknown[] = [edits.map((edit) => edit.object.primaryKey)];

  present.forEach((property, index) => {
    const valueAlias = `__c${index}`;
    const allSet = edits.every((edit) => edit.properties.has(property.apiName));

    values.push(
      edits.map((edit) =>
        edit.properties.has(property.apiName)
          ? unnestValue(property, edit.properties.get(property.apiName) ?? null)
          : null,
      ),
    );

    unnestArgs.push(`$${values.length}::${unnestType(property)}`);

    unnestAliases.push(valueAlias);

    const expr = unnestExpr(property, `u.${valueAlias}`);
    const column = quoteName(property.column);

    if (allSet) {
      assignments.push(`${column} = ${expr}`);
    } else {
      const setAlias = `__s${index}`;

      values.push(edits.map((edit) => edit.properties.has(property.apiName)));

      unnestArgs.push(`$${values.length}::boolean[]`);

      unnestAliases.push(setAlias);

      assignments.push(`${column} = CASE WHEN u.${setAlias} THEN ${expr} ELSE t.${column} END`);
    }
  });

  return {
    text: `UPDATE ${writeTable(writer, objectType)} AS t SET ${assignments.join(', ')} FROM unnest(${unnestArgs.join(', ')}) AS u(${unnestAliases.join(', ')}) WHERE t.${pk} = u.__pk RETURNING 1 AS edited`,
    values,
  };
}

function deleteObjectsSql(
  writer: Writer,
  ontology: CompiledOntology,
  apiName: ObjectTypeApiName,
  edits: readonly DeleteEdit[],
): Sql {
  const objectType = objectTypeOf(ontology, apiName);
  const keys = edits.map((edit) => edit.object.primaryKey);

  const links = objectType.joinTables.map(
    (join, index) =>
      `link${index} AS (DELETE FROM ${writeLinkTable(writer, join)} WHERE ${join.columns.map((column) => `${quoteName(column)} = ANY($1::text[])`).join(' OR ')})`,
  );

  const deleted = `deleted AS (DELETE FROM ${writeTable(writer, objectType)} WHERE ${keyColumn(objectType)} = ANY($1::text[]) RETURNING 1 AS edited)`;

  return { text: `WITH ${[deleted, ...links].join(', ')} SELECT edited FROM deleted`, values: [keys] };
}

interface LinkRun {
  readonly type: 'addLink' | 'deleteLink';
  readonly via: LinkJoin;
  readonly edits: LinkEdit[];
}

function linkRuns(items: readonly { readonly via: LinkJoin; readonly edit: LinkEdit }[]): LinkRun[] {
  const runs: LinkRun[] = [];

  for (const { via, edit } of items) {
    const last = runs.at(-1);

    if (
      last &&
      last.type === edit.type &&
      last.via.sourceColumn === via.sourceColumn &&
      last.via.targetColumn === via.targetColumn
    ) {
      last.edits.push(edit);
    } else {
      runs.push({ type: edit.type, via, edits: [edit] });
    }
  }

  return runs;
}

function linkRunSql(writer: Writer, run: LinkRun): Sql {
  const table = writeLinkTable(writer, run.via);
  const [source, target] = [quoteName(run.via.sourceColumn), quoteName(run.via.targetColumn)];
  const values = [run.edits.map((edit) => edit.source.primaryKey), run.edits.map((edit) => edit.target.primaryKey)];

  return run.type === 'addLink'
    ? {
        text: `INSERT INTO ${table} (${source}, ${target}) SELECT u.__source, u.__target FROM unnest($1::text[], $2::text[]) AS u(__source, __target) ON CONFLICT DO NOTHING`,
        values,
      }
    : {
        text: `DELETE FROM ${table} AS l USING unnest($1::text[], $2::text[]) AS u(__source, __target) WHERE l.${source} = u.__source AND l.${target} = u.__target`,
        values,
      };
}

function joinOf(objectType: CompiledObjectType, apiName: string): LinkJoin {
  const via = objectType.links.get(apiName)?.via;

  invariant(
    via?.kind === 'joinTable',
    `The Object Type ${objectType.apiName} has no many-to-many Link side ${apiName}.`,
  );

  return via;
}

export function ontologyVersionSql(ontology: CompiledOntology): Sql {
  return {
    text: `SELECT version FROM ${REGISTRY_SCHEMA}.ontologies WHERE rid = $1`,
    values: [ontology.metadata.ontology.rid],
  };
}

export function uniqueCheckSql(ontology: CompiledOntology, edits: readonly Edit[]): Sql | undefined {
  const checks = edits.some(
    (edit) =>
      (edit.type === 'addObject' || edit.type === 'modifyObject') &&
      objectTypeOf(ontology, edit.object.objectType).uniqueness.length > 0,
  );

  return checks ? { text: 'SET CONSTRAINTS ALL IMMEDIATE', values: [] } : undefined;
}

export function writeLimitSql(remainingMs: number): Sql {
  invariant(
    Number.isInteger(remainingMs) && remainingMs >= 1,
    `The limit of a write transaction is a whole number of ms, at least 1, not ${remainingMs}.`,
  );

  return {
    text: "SELECT set_config('transaction_timeout', $1, true), set_config('statement_timeout', '0', true)",
    values: [`${remainingMs}ms`],
  };
}

function keyColumn(objectType: CompiledObjectType): string {
  return quoteName(objectType.primaryKey.column);
}

function unnestType(property: CompiledProperty): string {
  return property.type.kind === 'array' || property.type.kind === 'struct'
    ? 'jsonb[]'
    : `${columnType(property.type)}[]`;
}

function unnestValue(property: CompiledProperty, value: JsonValue): unknown {
  if (value === null) return null;

  if (property.type.kind === 'struct') return JSON.stringify(withoutNullFields(value));

  if (property.type.kind === 'array') return JSON.stringify(value);

  return value;
}

function unnestExpr(property: CompiledProperty, ref: string): string {
  if (property.type.kind !== 'array') return ref;

  const element = columnType(property.type.element);

  return `CASE WHEN ${ref} IS NULL THEN NULL ELSE ARRAY(SELECT e::${element} FROM jsonb_array_elements_text(${ref}) AS e) END`;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);

  if (list) list.push(value);
  else map.set(key, [value]);
}

function sortedEntries<V>(map: ReadonlyMap<string, V>): [string, V][] {
  return [...map.entries()].sort(([a], [b]) => compare(a, b));
}

function sortByKey<T extends { readonly object: ObjectLocator }>(edits: readonly T[]): T[] {
  return [...edits].sort((a, b) => compare(a.object.primaryKey, b.object.primaryKey));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
