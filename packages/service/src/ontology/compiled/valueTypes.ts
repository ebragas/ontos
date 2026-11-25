import type { ScalarType } from './links.ts';

export type ValueTypeApiName = string;

export type ScalarValue = string | number | boolean;

export type ValueTypeBase =
  { readonly kind: ScalarType['kind'] } | { readonly kind: 'array'; readonly element: ScalarType['kind'] };

export type ValueTypeRule =
  | { readonly kind: 'enum'; readonly options: readonly ScalarValue[] }
  | { readonly kind: 'range'; readonly minimum?: ScalarValue; readonly maximum?: ScalarValue }
  | { readonly kind: 'length'; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: 'regex'; readonly pattern: string; readonly partialMatch: boolean }
  | { readonly kind: 'uuid' }
  | {
      readonly kind: 'array';
      readonly minimumSize?: number;
      readonly maximumSize?: number;
      readonly uniqueValues: boolean;
      readonly element?: ValueTypeRule;
    };

export interface CompiledConstraint {
  readonly rule: ValueTypeRule;
  readonly failureMessage: string | undefined;
}

export interface CompiledValueType {
  readonly apiName: ValueTypeApiName;
  readonly rid: string;
  readonly version: string;
  readonly status: 'active' | 'deprecated';
  readonly displayName: string;
  readonly description: string | undefined;
  readonly baseType: ValueTypeBase;
  readonly constraints: readonly CompiledConstraint[];
}
