import { writeHistoryTable, type Sql, type Writer } from '../../db/index.ts';
import type { CompiledOntology, JsonValue, PrimaryKey, PropertyApiName } from '../../ontology/index.ts';
import type { CheckedEdit, Edit, ObjectLocator } from '../edit.ts';
import { objectTypeOf, withoutNullFields } from './shared.ts';

interface ActionOfEntries {
  readonly operationId: string;
  readonly actionTypeRid: string;
  readonly userId: string;
}

export interface HistoryEntry {
  readonly objectType: string;
  readonly primaryKey: PrimaryKey;
  readonly entry: JsonValue;
}

export type PreviousValues = (object: ObjectLocator) => ReadonlyMap<PropertyApiName, JsonValue>;

export function historyEntries(
  edits: readonly CheckedEdit[],
  ontology: CompiledOntology,
  action: ActionOfEntries,
  previous: PreviousValues,
): HistoryEntry[] {
  return edits.flatMap((edit): HistoryEntry[] => {
    if (edit.type !== 'addObject' && edit.type !== 'modifyObject' && edit.type !== 'deleteObject') return [];

    const objectType = objectTypeOf(ontology, edit.object.objectType);
    const history = objectType.editsHistory;

    if (!history) return [];

    const { primaryKey } = edit.object;

    const entry = {
      objectPrimaryKey: { [objectType.primaryKey.apiName]: primaryKey },
      operationId: action.operationId,
      actionTypeRid: action.actionTypeRid,
      userId: action.userId,
      edit: historyEdit(edit, objectType.primaryKey.apiName, history.storeAllPreviousProperties, previous),
    };

    return [{ objectType: objectType.apiName, primaryKey, entry }];
  });
}

function historyEdit(
  edit: Extract<Edit, { type: 'addObject' | 'modifyObject' | 'deleteObject' }>,
  primaryKeyProperty: PropertyApiName,
  storeAll: boolean,
  previous: PreviousValues,
): JsonValue {
  switch (edit.type) {
    case 'addObject':
      return {
        type: 'createEdit',
        properties: withValues(new Map([[primaryKeyProperty, edit.object.primaryKey], ...edit.properties])),
      };
    case 'modifyObject': {
      const before = previous(edit.object);
      const changed = new Map([...before].filter(([property]) => storeAll || edit.properties.has(property)));

      const properties = Object.fromEntries(
        [...edit.properties].map(([property, value]) => [property, withoutNullFields(value)]),
      );

      return {
        type: 'modifyEdit',
        properties,
        previousProperties: withValues(changed),
        includesAllPreviousValues: storeAll,
      };
    }
    case 'deleteObject':
      return { type: 'deleteEdit', previousProperties: withValues(previous(edit.object)) };
  }
}

function withValues(values: ReadonlyMap<PropertyApiName, JsonValue>): JsonValue {
  return Object.fromEntries(
    [...values].filter(([, value]) => value !== null).map(([property, value]) => [property, withoutNullFields(value)]),
  );
}

export function entriesSql(writer: Writer, entries: readonly HistoryEntry[]): Sql {
  return {
    text: `INSERT INTO ${writeHistoryTable(writer)} (object_type, primary_key, entry, created_at) SELECT *, statement_timestamp() FROM unnest($1::text[], $2::text[], $3::jsonb[])`,
    values: [
      entries.map((entry) => entry.objectType),
      entries.map((entry) => entry.primaryKey),
      entries.map((entry) => JSON.stringify(entry.entry)),
    ],
  };
}
