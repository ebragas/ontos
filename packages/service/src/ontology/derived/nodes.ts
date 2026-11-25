import type {
  CompiledObjectType,
  CompiledProperty,
  JsonValue,
  PropertyApiName,
  PropertyType,
} from '../compiled/index.ts';

export type DerivedForm = 'objectType' | 'request';

interface Path {
  readonly objectSet: JsonValue;
  readonly hops: number;
  readonly target: CompiledObjectType;
  readonly single: boolean;
}

export type Operation =
  | { readonly kind: 'count' }
  | {
      readonly kind: 'get' | 'sum' | 'avg' | 'min' | 'max' | 'exactDistinct' | 'approximateDistinct';
      readonly property: CompiledProperty;
    }
  | { readonly kind: 'approximatePercentile'; readonly property: CompiledProperty; readonly percentile: number }
  | { readonly kind: 'collectList' | 'collectSet'; readonly property: CompiledProperty; readonly limit: number };

export type DerivedNode =
  | { readonly kind: 'selection'; readonly path: Path; readonly operation: Operation; readonly type: PropertyType }
  | { readonly kind: 'property'; readonly apiName: PropertyApiName; readonly type: PropertyType }
  | {
      readonly kind: 'nary';
      readonly op: 'add' | 'multiply' | 'greatest' | 'least';
      readonly operands: readonly DerivedNode[];
      readonly type: PropertyType;
    }
  | {
      readonly kind: 'binary';
      readonly op: 'subtract' | 'divide';
      readonly left: DerivedNode;
      readonly right: DerivedNode;
      readonly type: PropertyType;
    }
  | {
      readonly kind: 'unary';
      readonly op: 'absoluteValue' | 'negate';
      readonly operand: DerivedNode;
      readonly type: PropertyType;
    }
  | {
      readonly kind: 'extract';
      readonly part: 'DAYS' | 'MONTHS' | 'QUARTERS' | 'YEARS';
      readonly operand: DerivedNode;
      readonly type: PropertyType;
    };

export type DerivedRefusal =
  | { readonly kind: 'shape'; readonly detail: string }
  | { readonly kind: 'collectLimit'; readonly limit: number }
  | { readonly kind: 'notFound'; readonly linkOrProperty: string };

export interface InputRow {
  readonly objectType: CompiledObjectType;
  readonly property: (apiName: string) => { readonly type: PropertyType } | undefined;
}
