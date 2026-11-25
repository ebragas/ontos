import { jsonForm, quoteName } from '../../db/index.ts';
import { ApiError, each, invariant, unsupportedFeature, type Fallible } from '../../errors/index.ts';
import type { ScalarType } from '../../ontology/index.ts';
import type { CompiledObjectSet } from './objectSet.ts';
import { ROW } from './objects.ts';
import type { OrderField } from './request.ts';
import type { RowProperty } from './row.ts';

export interface SortKey {
  readonly sql: string;
  readonly value: string;
  readonly direction: 'asc' | 'desc';
  readonly type: ScalarType;
}

export function* sortKeys(set: CompiledObjectSet, fields: readonly OrderField[]): Fallible<SortKey[], ApiError> {
  const { objectType, row } = set;
  const missing = fields.map((field) => field.apiName).filter((apiName) => !row.compute(apiName));

  if (missing.length > 0)
    return yield new ApiError(404, 'PropertiesNotFound', { objectType: objectType.apiName, properties: missing });

  const names = fields.map((field) => field.apiName);
  const duplicates = [...new Set(names.filter((apiName, index) => names.indexOf(apiName) !== index))];

  if (duplicates.length > 0) return yield new ApiError(400, 'DuplicateOrderBy', { properties: duplicates });

  return [
    ...(yield* each(fields, (field) => sortKey(property(set, field.apiName), field.direction))),
    yield* sortKey(objectType.primaryKey, 'asc'),
  ];
}

function property(set: CompiledObjectSet, apiName: string): RowProperty {
  const found = set.row.compute(apiName);

  invariant(found, `The rows of ${set.objectType.apiName} have no Property ${apiName}.`);

  return found;
}

function* sortKey(property: RowProperty, direction: 'asc' | 'desc'): Fallible<SortKey, ApiError> {
  const { type } = property;

  if (type.kind === 'struct') return yield unsupportedFeature('orderBy on a struct Property');

  if (type.kind === 'array') return yield unsupportedFeature('orderBy on an array Property');

  const column = `${ROW}.${quoteName(property.column)}`;

  return {
    sql: type.kind === 'string' ? `${column} COLLATE "C"` : column,
    value: jsonForm(type, column),
    direction,
    type,
  };
}
