import { columnType, quoteName, type Schemas, type Sql } from '../../db/index.ts';
import type {
  CompiledObjectType,
  CompiledProperty,
  CompiledValueType,
  UniquenessConstraint,
} from '../../ontology/index.ts';
import type { Change } from '../plan.ts';
import {
  createPolicyIndex,
  createTextIndex,
  dropPolicyIndex,
  dropTextIndex,
  hasPolicyIndex,
  hasTextIndex,
} from './indexes.ts';
import { uniqueRules } from './storedRules.ts';
import { canonical, columnDefinition, isNewColumn, objectTable, uniqueConstraint } from './tableSql.ts';

function checkedPart(valueType: CompiledValueType | undefined): string | undefined {
  return (
    valueType &&
    canonical({
      apiName: valueType.apiName,
      baseType: valueType.baseType,
      rules: valueType.constraints.map((c) => c.rule),
    })
  );
}

export function valueTypeChange(
  before: CompiledProperty,
  after: CompiledProperty,
  objectType: string,
): { readonly description: string; readonly checksStoredValues: boolean } | undefined {
  const old = before.valueType;
  const next = after.valueType;

  if (checkedPart(old) === checkedPart(next)) return undefined;

  const of = `Property ${after.apiName} of Object Type ${objectType}`;

  if (!next)
    return old && { description: `Remove the value type ${old.apiName} from ${of}`, checksStoredValues: false };

  return {
    description: old ? `Change the value type ${next.apiName} of ${of}` : `Set the value type ${next.apiName} on ${of}`,
    checksStoredValues: true,
  };
}

export function changeObjectType(schemas: Schemas, before: CompiledObjectType, after: CompiledObjectType): Change[] {
  const changes: Change[] = [];
  const table = `${schemas.object}.${after.table}`;
  const name = objectTable(schemas, after.table);
  const editHistory = `${schemas.engine}.edit_history`;
  const editHistorySql = `${quoteName(schemas.engine)}.edit_history`;

  const change = (description: string, statements: Sql[]) =>
    changes.push({ description: `${description} of Object Type ${after.apiName}`, statements, table });

  for (const old of before.properties.values()) {
    if (!after.properties.has(old.apiName)) {
      change(`Delete Property ${old.apiName}`, [
        { text: `ALTER TABLE ${name} DROP COLUMN ${quoteName(old.column)}`, values: [] },
      ]);
    }
  }

  for (const property of after.properties.values()) {
    const old = before.properties.get(property.apiName);

    const add: Sql = {
      text: `ALTER TABLE ${name} ADD COLUMN ${columnDefinition(property, after.primaryKey.apiName)}`,
      values: [],
    };

    const textIndex = hasTextIndex(property) ? [createTextIndex(schemas, after.table, property.column)] : [];
    const policyIndex = createPolicyIndex(schemas, after, property);

    if (!old) {
      change(`Create Property ${property.apiName}`, [add, ...textIndex, ...policyIndex]);
    } else if (isNewColumn(before, property)) {
      const drop: Sql = { text: `ALTER TABLE ${name} DROP COLUMN ${quoteName(old.column)}`, values: [] };

      change(`Change the base type of Property ${property.apiName}`, [drop, add, ...textIndex, ...policyIndex]);
    } else {
      const required = property.required || property.apiName === after.primaryKey.apiName;
      const wasRequired = old.required || old.apiName === before.primaryKey.apiName;

      if (required !== wasRequired) {
        const rule = required ? 'SET NOT NULL' : 'DROP NOT NULL';

        change(`Make Property ${property.apiName} ${required ? 'required' : 'optional'}`, [
          { text: `ALTER TABLE ${name} ALTER COLUMN ${quoteName(property.column)} ${rule}`, values: [] },
        ]);
      }

      if (hasTextIndex(property) && !hasTextIndex(old)) {
        change(`Create the text search index of Property ${property.apiName}`, textIndex);
      } else if (!hasTextIndex(property) && hasTextIndex(old)) {
        change(`Drop the text search index of Property ${property.apiName}`, [
          dropTextIndex(schemas, after.table, property.column),
        ]);
      }

      if (hasPolicyIndex(after, property) && !hasPolicyIndex(before, old)) {
        change(`Create the policy index of Property ${property.apiName}`, policyIndex);
      } else if (!hasPolicyIndex(after, property) && hasPolicyIndex(before, old)) {
        change(`Drop the policy index of Property ${property.apiName}`, [
          dropPolicyIndex(schemas, after.table, property.column),
        ]);
      }

      const valueType = valueTypeChange(old, property, after.apiName);

      if (valueType)
        changes.push({
          description: valueType.description,
          statements: [],
          ...(valueType.checksStoredValues ? { table } : {}),
        });
    }
  }

  if (before.editsHistory && !after.editsHistory) {
    changes.push({
      description: `Turn off Object Edit History of Object Type ${after.apiName}`,
      statements: [{ text: `DELETE FROM ${editHistorySql} WHERE object_type = $1`, values: [after.apiName] }],
      table: editHistory,
    });
  } else if (!before.editsHistory && after.editsHistory) {
    changes.push({ description: `Turn on Object Edit History of Object Type ${after.apiName}`, statements: [] });
  }

  return changes;
}

export function uniquenessChanges(
  schemas: Schemas,
  before: CompiledObjectType,
  after: CompiledObjectType,
  moved: ReadonlyMap<string, string>,
  emptied: boolean,
  existing: ReadonlySet<string>,
): Change[] {
  const table = `${schemas.object}.${after.table}`;
  const name = objectTable(schemas, after.table);
  const of = `of Object Type ${after.apiName}`;
  const sources = new Map([...moved].map(([source, target]) => [target, source]));

  const storedOf = (property: CompiledProperty): CompiledProperty | undefined => {
    const old = before.properties.get(sources.get(property.apiName) ?? property.apiName);

    return old && columnType(old.type) === columnType(property.type) ? old : undefined;
  };

  const kept = (rule: UniquenessConstraint): boolean => {
    const old = before.uniqueness.find((r) => r.name === rule.name);

    if (!old || !existing.has(old.constraint) || old.properties.length !== rule.properties.length) return false;

    return rule.properties.every((p) => old.properties.some((o) => o.apiName === storedOf(p)?.apiName));
  };

  const keptNames = new Set(after.uniqueness.filter(kept).map((rule) => rule.name));

  const deletes = before.uniqueness
    .filter((rule) => !keptNames.has(rule.name))
    .map((rule) => ({
      description: `Delete Uniqueness constraint ${rule.name} ${of}`,
      statements: [{ text: `ALTER TABLE ${name} DROP CONSTRAINT IF EXISTS ${quoteName(rule.constraint)}`, values: [] }],
      table,
    }));

  const creates = after.uniqueness
    .filter((rule) => !keptNames.has(rule.name))
    .map((rule): Change => {
      const stored = rule.properties.map(storedOf);
      const checked = !emptied && stored.every((p) => p !== undefined);

      return {
        description: `Create Uniqueness constraint ${rule.name} ${of}`,
        statements: [{ text: `ALTER TABLE ${name} ADD ${uniqueConstraint(rule)}`, values: [] }],
        table,
        ...(checked
          ? {
              storedRules: uniqueRules(
                schemas,
                before,
                stored.filter((p) => p !== undefined),
              ),
            }
          : {}),
      };
    });

  return [...deletes, ...creates];
}
