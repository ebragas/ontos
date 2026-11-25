import { jsonValueOf, quoteName, valueType } from '../../db/index.ts';
import { ApiError, each, type Fallible } from '../../errors/index.ts';
import type { CompiledObjectType, PropertyType, ScalarType } from '../../ontology/index.ts';
import type { CompiledObjectSet } from './objectSet.ts';
import { ROW } from './objects.ts';
import { invalid, isRecord, present, propertyName } from './request.ts';
import type { RowProperty } from './row.ts';
import type { Params } from './sql.ts';
import { textMatch, wordsOf } from './text.ts';

type Condition = (params: Params) => string;

interface Target {
  readonly name: string;
  readonly property: RowProperty;
  readonly type: PropertyType;
  readonly value: (params: Params) => string;
}

const MAX_WORDS = 16;
const MAX_VALUE_LENGTH = 256;

export class TextSearchBudget {
  private left = MAX_WORDS;

  *spend(words: number): Fallible<void, ApiError> {
    this.left -= words;

    if (this.left < 0) return yield overLimit(MAX_WORDS);
  }
}

const TEXT_SEARCH_QUERIES = new Set([
  'containsAnyTerm',
  'containsAllTerms',
  'containsAllTermsInOrder',
  'containsAllTermsInOrderPrefixLastTerm',
  'startsWith',
  'regex',
  'interval',
]);

const MAX_WHERE_DEPTH = 64;

export function* compileWhere(
  query: unknown,
  set: CompiledObjectSet,
  budget: TextSearchBudget,
  depth = 0,
): Fallible<Condition, ApiError> {
  if (depth >= MAX_WHERE_DEPTH) return yield invalid('where', query);

  if (!isRecord(query) || typeof query.type !== 'string') return yield invalid('where', query);

  switch (query.type) {
    case 'and':
    case 'or': {
      const parts = yield* each(yield* queryList(query), (part) => compileWhere(part, set, budget, depth + 1));
      const join = query.type === 'and' ? ' AND ' : ' OR ';
      const empty = query.type === 'and' ? 'TRUE' : 'FALSE';

      return (params) => (parts.length === 0 ? empty : `(${parts.map((part) => part(params)).join(join)})`);
    }
    case 'not': {
      if (query.value === undefined) return yield invalid('where', query);

      const part = yield* compileWhere(query.value, set, budget, depth + 1);

      return (params) => `((${part(params)}) IS NOT TRUE)`;
    }
  }

  const target = yield* targetOf(query, set);

  if (TEXT_SEARCH_QUERIES.has(query.type)) return yield* textSearch(query, target, budget);

  return yield* comparison(query, query.type, target);
}

function* textSearch(
  query: Readonly<Record<string, unknown>>,
  target: Target,
  budget: TextSearchBudget,
): Fallible<Condition, ApiError> {
  const type = String(query.type);

  if (present(query.fuzzy) && typeof query.fuzzy !== 'boolean') return yield invalid('where', query);

  const unsupported = type === 'regex' || type === 'interval' ? type : query.fuzzy === true ? 'fuzzy' : undefined;

  if (unsupported)
    return yield new ApiError(400, 'PropertyFiltersNotSupported', {
      property: target.name,
      propertyFilters: [unsupported],
    });

  if (present(query.analyzerSelection) && query.analyzerSelection !== 'BASE_ANALYZER') {
    if (query.analyzerSelection !== 'PHONETIC_ANALYZER') return yield invalid('where', query);

    return yield new ApiError(400, 'UnsupportedAnalyzerSelection', { analyzerSelection: query.analyzerSelection });
  }

  if (target.type !== target.property.type || !target.property.searchable) {
    return yield new ApiError(400, 'PropertiesNotSearchable', { propertyApiNames: [target.name] });
  }

  if (target.type.kind !== 'string') return yield wrongType(target);

  const value = (yield* checkedValue(query.value, target.type, target)) as string;

  if (Array.from(value).length > MAX_VALUE_LENGTH) return yield overLimit(MAX_VALUE_LENGTH);

  const words = wordsOf(value);

  yield* budget.spend(words.length);

  const { terms, join } = textMatch(type, words);

  if (terms.length === 0) return () => 'FALSE';

  return (params) => {
    const value = target.value(params);

    return `(${terms.map(({ filter, pattern }) => `(${value} ~ ${params.add(filter)} AND regexp_like(${value}, ${params.add(pattern)}))`).join(join === 'any' ? ' OR ' : ' AND ')})`;
  };
}

function* comparison(
  query: Readonly<Record<string, unknown>>,
  type: string,
  target: Target,
): Fallible<Condition, ApiError> {
  switch (type) {
    case 'isNull': {
      if (typeof query.value !== 'boolean') return yield invalid('where', query);

      const test = query.value ? 'IS NULL' : 'IS NOT NULL';

      return (params) => `${target.value(params)} ${test}`;
    }
    case 'eq': {
      if (target.type.kind === 'struct') return () => 'FALSE';

      const scalar = yield* scalarOf(target);
      const value = yield* checkedValue(query.value, scalar, target);

      return (params) => `${target.value(params)} = ${params.add(value)}::${valueType(scalar)}`;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const scalar = yield* scalarOf(target);

      if (scalar.kind === 'boolean') return yield wrongType(target);

      const value = yield* checkedValue(query.value, scalar, target);
      const collate = scalar.kind === 'string' ? ' COLLATE "C"' : '';

      return (params) =>
        `${target.value(params)}${collate} ${OPERATORS[type]} ${params.add(value)}::${valueType(scalar)}`;
    }
    case 'in': {
      const scalar = yield* scalarOf(target);

      if (!Array.isArray(query.value)) return yield invalid('where', query);

      if (query.value.length === 0) return () => 'TRUE';

      const values = yield* each(query.value, (value: unknown) => checkedValue(value, scalar, target));

      return (params) => `${target.value(params)} = ANY(${params.add(values)}::${valueType(scalar)}[])`;
    }
    case 'contains': {
      if (target.type.kind !== 'array') return yield wrongType(target);

      const element = target.type.element;
      const value = yield* checkedValue(query.value, element, target);

      return (params) => `${params.add(value)}::${valueType(element)} = ANY(${target.value(params)})`;
    }
    default:
      return yield new ApiError(400, 'PropertyFiltersNotSupported', { property: target.name, propertyFilters: [type] });
  }
}

const OPERATORS: Readonly<Record<string, string>> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

function* scalarOf(target: Target): Fallible<ScalarType, ApiError> {
  if (target.type.kind === 'array' || target.type.kind === 'struct') return yield wrongType(target);

  return target.type;
}

function* targetOf(query: Readonly<Record<string, unknown>>, set: CompiledObjectSet): Fallible<Target, ApiError> {
  const name = yield* propertyName(query, set.objectType, 'where', query);

  if (typeof name === 'string') return yield* propertyTarget(set, name);

  return yield* structFieldTarget(set, name.propertyApiName, name.structFieldApiName, query);
}

function* propertyTarget(set: CompiledObjectSet, apiName: string): Fallible<Target, ApiError> {
  const property = set.row.compute(apiName);

  if (!property) return yield propertiesNotFound(set.objectType, apiName);

  const column = `${ROW}.${quoteName(property.column)}`;

  return { name: apiName, property, type: property.type, value: () => column };
}

function* structFieldTarget(
  set: CompiledObjectSet,
  propertyApiName: unknown,
  fieldApiName: unknown,
  query: unknown,
): Fallible<Target, ApiError> {
  if (typeof propertyApiName !== 'string' || typeof fieldApiName !== 'string') return yield invalid('where', query);

  const name = `${propertyApiName}.${fieldApiName}`;
  const property = set.row.compute(propertyApiName);
  const type = property?.type.kind === 'struct' ? property.type.fields.get(fieldApiName) : undefined;

  if (!property || !type) return yield propertiesNotFound(set.objectType, name);

  const column = `${ROW}.${quoteName(property.column)}`;
  const cast = type.kind === 'string' ? '' : `::${valueType(type)}`;

  return { name, property, type, value: (params) => `(${column} ->> ${params.add(fieldApiName)}::text)${cast}` };
}

function* checkedValue(value: unknown, type: ScalarType, target: Target): Fallible<unknown, ApiError> {
  const json = jsonValueOf(value, type);

  if (json === undefined) {
    return yield new ApiError(400, 'InvalidPropertyValue', {
      property: target.name,
      propertyBaseType: baseTypeName(type),
      propertyValue: value,
    });
  }

  return json;
}

export function baseTypeName(type: PropertyType): string {
  switch (type.kind) {
    case 'array':
      return `Array<${baseTypeName(type.element)}>`;
    case 'struct':
      return 'Struct';
    case 'date':
      return 'LocalDate';
    default:
      return BASE_TYPE_NAMES[type.kind];
  }
}

const BASE_TYPE_NAMES = {
  string: 'String',
  boolean: 'Boolean',
  integer: 'Integer',
  double: 'Double',
  decimal: 'Decimal',
  timestamp: 'Timestamp',
} as const;

function wrongType(target: Target): ApiError {
  return new ApiError(400, 'InvalidPropertyType', {
    property: target.name,
    propertyBaseType: baseTypeName(target.type),
  });
}

function overLimit(maximum: number): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', { field: 'where', maximum });
}

function propertiesNotFound(objectType: CompiledObjectType, name: string): ApiError {
  return new ApiError(404, 'PropertiesNotFound', { objectType: objectType.apiName, properties: [name] });
}

function* queryList(query: Readonly<Record<string, unknown>>): Fallible<readonly unknown[], ApiError> {
  if (!Array.isArray(query.value)) return yield invalid('where', query);

  return query.value;
}
