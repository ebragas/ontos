import type { AllowedValues, Criterion, RuleLogic } from './conditions.ts';
import type { ActionTypeDisplay } from './display.ts';
import type { ScalarType } from './links.ts';
import type { ActionTypeApiName, ObjectTypeApiName, ParameterId } from './names.ts';
import type { Status } from './primitives.ts';
import type { FunctionLogic, RuleValue } from './rules.ts';

export interface CompiledActionType {
  readonly apiName: ActionTypeApiName;
  readonly rid: string;
  readonly status: Status;
  readonly display: ActionTypeDisplay;
  readonly parameters: ReadonlyMap<ParameterId, CompiledParameter>;
  readonly criteria: readonly Criterion[];
  readonly logic: RuleLogic | FunctionLogic;
}

export interface CompiledParameter {
  readonly id: ParameterId;
  readonly type: ParameterType;
  readonly required: boolean;
  readonly allowed: AllowedValues;
  readonly listLength?: { readonly min?: number; readonly max?: number };
  readonly defaultValue?: Extract<RuleValue, { kind: 'objectProperty' }>;
}

export type ParameterScalarType =
  | Exclude<ScalarType, { kind: 'decimal' }>
  | { readonly kind: 'decimal'; readonly precision?: number; readonly scale?: number };

export type StructParameterType = {
  readonly kind: 'struct';
  readonly fields: ReadonlyMap<string, { readonly type: ParameterScalarType; readonly required: boolean }>;
};

type ListElementType = ParameterScalarType | StructParameterType;

export type ParameterType =
  | ParameterScalarType
  | { readonly kind: 'list'; readonly element: ListElementType }
  | StructParameterType
  | { readonly kind: 'object'; readonly objectType: ObjectTypeApiName }
  | { readonly kind: 'objectList'; readonly objectType: ObjectTypeApiName };

export interface Bound {
  readonly value: string | number;
  readonly inclusive: boolean;
}
