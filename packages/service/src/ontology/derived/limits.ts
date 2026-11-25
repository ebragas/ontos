import type { DerivedForm, DerivedNode, DerivedRefusal } from './nodes.ts';

export interface FormLimits {
  readonly maxHops: number;
  readonly filters: boolean;
  readonly expressions: boolean;
  readonly percentile: boolean;
}

export const FORM_LIMITS = {
  objectType: { maxHops: 3, filters: false, expressions: false, percentile: false },
  request: { maxHops: Infinity, filters: true, expressions: true, percentile: true },
} as const satisfies Record<DerivedForm, FormLimits>;

export const COLLECT_LIMIT = { min: 1, max: 100 } as const;

export type ParsedDerived =
  { readonly ok: true; readonly node: DerivedNode } | { readonly ok: false; readonly refusal: DerivedRefusal };
