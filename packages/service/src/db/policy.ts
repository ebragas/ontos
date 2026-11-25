import { invariant } from '../errors/index.ts';
import type {
  CompiledObjectType,
  CompiledProperty,
  Policy,
  PolicyOperator,
  PropertyApiName,
} from '../ontology/index.ts';
import { personValue, type Reader, type SqlValues } from './reader.ts';
import { quoteName } from './types.ts';

const ARRAY_OPERATORS: Readonly<Record<PolicyOperator, (object: string, person: string) => string>> = {
  equal: (object, person) => `${object} @> ${person} AND ${object} <@ ${person}`,
  intersects: (object, person) => `${object} && ${person}`,
  subsetOf: (object, person) => `${object} <@ ${person}`,
  supersetOf: (object, person) => `${object} @> ${person}`,
};

type Side = { readonly kind: 'string' | 'array'; readonly sql: string };

function arraySide(sql: string): Side {
  return { kind: 'array', sql };
}

export function propertyOf(objectType: CompiledObjectType, name: PropertyApiName): CompiledProperty {
  const property = objectType.properties.get(name);

  invariant(
    property,
    `The policy of ${objectType.apiName} reads the Property ${name}, which the Object Type does not have.`,
  );

  return property;
}

function sideKindOf(objectType: CompiledObjectType, name: PropertyApiName): Side['kind'] {
  const { type } = propertyOf(objectType, name);

  if (type.kind === 'string') return 'string';

  if (type.kind === 'array' && type.element.kind === 'string') return 'array';

  invariant(
    false,
    `The policy of ${objectType.apiName} reads the Property ${name}, which is not a String or a String array.`,
  );
}

function sideOf(objectType: CompiledObjectType, name: PropertyApiName, row: string): Side {
  const column = `${row}.${quoteName(propertyOf(objectType, name).column)}`;

  return sideKindOf(objectType, name) === 'string' ? { kind: 'string', sql: column } : arraySide(arraySetSql(column));
}

function arraySetSql(column: string): string {
  return `coalesce(array_remove(${column}, NULL), '{}')`;
}

function notEmptySql(side: Side): string {
  return side.kind === 'string' ? `${side.sql} IS NOT NULL` : `cardinality(${side.sql}) > 0`;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function propertiesRead(policy: Policy): Set<PropertyApiName> {
  if (policy.kind !== 'compare')
    return new Set(policy.conditions.flatMap((condition) => [...propertiesRead(condition)]));

  return new Set(policy.object.kind === 'property' ? [policy.object.property] : []);
}

export function objectPolicySql(
  policy: Policy,
  objectType: CompiledObjectType,
  row: string,
  reader: Reader,
  values: SqlValues,
): string {
  const guard = [...propertiesRead(policy)].map((name) => notEmptySql(sideOf(objectType, name, row)));

  return [...guard, policySql(policy, objectType, row, reader, values)].join(' AND ');
}

export function policySql(
  policy: Policy,
  objectType: CompiledObjectType,
  row: string,
  reader: Reader,
  values: SqlValues,
): string {
  if (policy.kind !== 'compare') {
    if (policy.conditions.length === 0) return policy.kind === 'and' ? 'TRUE' : 'FALSE';

    const joined = policy.conditions
      .map((condition) => policySql(condition, objectType, row, reader, values))
      .join(` ${policy.kind.toUpperCase()} `);

    return `(${joined})`;
  }

  const property = policy.object.kind === 'property' ? sideOf(objectType, policy.object.property, row) : undefined;
  const personValues = distinct(personValue(reader, policy.person).filter((value: string | null) => value !== null));
  const storable = personValues.filter((value) => !value.includes('\u0000'));

  if (storable.length < personValues.length && (policy.operator === 'equal' || policy.operator === 'supersetOf'))
    return 'FALSE';

  const object =
    property ??
    arraySide(`${values.add(distinct(policy.object.kind === 'constant' ? policy.object.values : []))}::text[]`);

  const person = `${values.add(storable)}::text[]`;

  if (object.kind === 'string') {
    const column = object.sql;

    return policy.operator === 'equal' || policy.operator === 'supersetOf'
      ? `(${column} IS NOT NULL AND cardinality(${person}) = 1 AND ${column} = (${person})[1])`
      : `(${column} IS NOT NULL AND ${column} = ANY(${person}))`;
  }

  const set = object.sql;

  return `(cardinality(${set}) > 0 AND cardinality(${person}) > 0 AND ${ARRAY_OPERATORS[policy.operator](set, person)})`;
}

export function policyIndexExpression(objectType: CompiledObjectType, name: PropertyApiName): string | undefined {
  const { policy } = objectType;

  if (policy === undefined || !propertiesRead(policy).has(name) || sideKindOf(objectType, name) !== 'array')
    return undefined;

  return arraySetSql(quoteName(propertyOf(objectType, name).column));
}

export function sameFormJsonSql(objectType: CompiledObjectType, name: PropertyApiName, json: string): string {
  if (sideKindOf(objectType, name) === 'string') return `CASE WHEN jsonb_typeof(${json}) = 'string' THEN ${json} END`;

  const items = `CASE WHEN NOT jsonb_path_exists(${json}, 'strict $[*] ? (@.type() != "string" && @.type() != "null")') THEN ${json} END`;

  return `CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${items} END`;
}
