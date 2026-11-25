import { each, type Fallible } from '../errors/index.ts';
import type { CompiledProperty, ObjectTypeApiName, PropertyApiName, UniquenessConstraint } from './compiled/index.ts';
import { CompileError } from './compiled/stored.ts';
import { indexName } from './model/tableNames.ts';

const MAX_RULE_PROPERTIES = 5;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function* compileUniqueness(
  owner: ObjectTypeApiName,
  table: string,
  properties: ReadonlyMap<PropertyApiName, CompiledProperty>,
  primaryKey: CompiledProperty,
): Fallible<readonly UniquenessConstraint[], CompileError> {
  const byName = new Map<string, CompiledProperty[]>();

  for (const property of properties.values()) {
    for (const [field, typeClasses] of property.display.structFields) {
      const unique = typeClasses.find(({ kind }) => kind === 'unique');

      if (unique) {
        return yield new CompileError(
          `The struct field ${field} of Property ${property.apiName} of Object Type ${owner} has the Uniqueness type class ${unique.name}. A Uniqueness constraint holds no struct field.`,
        );
      }
    }

    for (const { kind, name } of property.display.typeClasses) {
      if (kind !== 'unique') continue;

      if (name === '')
        return yield new CompileError(
          `Property ${property.apiName} of Object Type ${owner} has a Uniqueness type class with an empty name. A Uniqueness constraint has a name.`,
        );

      if (property === primaryKey)
        return yield new CompileError(
          `The primary key ${property.apiName} of Object Type ${owner} has the Uniqueness type class ${name}. The primary key is unique already.`,
        );

      const { kind: type } = property.type;

      if (type === 'array' || type === 'struct') {
        return yield new CompileError(
          `Property ${property.apiName} of Object Type ${owner} is ${type === 'array' ? 'an array' : 'a struct'} and has the Uniqueness type class ${name}. A Uniqueness constraint holds no array and no struct.`,
        );
      }

      const rule = byName.get(name) ?? [];

      if (!rule.includes(property)) byName.set(name, [...rule, property]);
    }
  }

  const rules = yield* each([...byName.keys()].sort(byCodeUnit), function* (name): Fallible<
    UniquenessConstraint,
    CompileError
  > {
    const ruleProperties = (byName.get(name) ?? []).sort((a, b) => byCodeUnit(a.apiName, b.apiName));

    if (ruleProperties.length > MAX_RULE_PROPERTIES) {
      return yield new CompileError(
        `The Uniqueness constraint ${name} of Object Type ${owner} has ${ruleProperties.length} Properties. A Uniqueness constraint has at most 5 Properties.`,
      );
    }

    return { name, properties: ruleProperties, constraint: indexName('unique', table, name) };
  });

  const bySet = new Map<string, string>();

  for (const { name, properties: ruleProperties } of rules) {
    const set = ruleProperties.map(({ apiName }) => apiName).join(', ');
    const other = bySet.get(set);

    if (other !== undefined) {
      return yield new CompileError(
        `The Uniqueness constraints ${other} and ${name} of Object Type ${owner} have the same Properties: ${set}. 2 Uniqueness constraints of 1 Object Type have 2 different sets of Properties.`,
      );
    }

    bySet.set(set, name);
  }

  return rules;
}
