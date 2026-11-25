import { quoteName } from '../../db/index.ts';
import type { CompiledObjectType, DerivedForm, PropertyType } from '../../ontology/index.ts';
import type { Params } from './sql.ts';

export interface RowProperty {
  readonly apiName: string;
  readonly column: string;
  readonly type: PropertyType;
  readonly searchable: boolean;
  readonly derived?: { readonly form: DerivedForm };
}

export type ReturnReason = 'select' | 'requestFlag' | 'setting';

export interface Row {
  compute(apiName: string): RowProperty | undefined;
  computeForPage(apiName: string): RowProperty | undefined;
  select(property: RowProperty, reason: ReturnReason): (alias: string, params: Params) => string;
  all(): readonly RowProperty[];
}

export function storedRow(objectType: CompiledObjectType): Row {
  return {
    compute: (apiName) => objectType.properties.get(apiName),
    computeForPage: (apiName) => objectType.properties.get(apiName),
    select: (property) => (alias) => `${alias}.${quoteName(property.column)}`,
    all: () => [...objectType.properties.values()],
  };
}
