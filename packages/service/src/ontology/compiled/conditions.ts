import type { ParameterId, PropertyApiName } from './names.ts';
import type { Bound } from './parameters.ts';
import type { PersonFact } from './policies.ts';
import type { JsonValue } from './primitives.ts';
import type { Rule } from './rules.ts';

export type AllowedValues =
  | { readonly kind: 'oneOf'; readonly values: readonly JsonValue[]; readonly otherValueAllowed: boolean }
  | { readonly kind: 'range'; readonly min?: Bound; readonly max?: Bound }
  | { readonly kind: 'text'; readonly minLength?: number; readonly maxLength?: number; readonly regex?: string }
  | { readonly kind: 'datetime'; readonly min?: Bound; readonly max?: Bound }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'objectQuery' }
  | { readonly kind: 'struct' }
  | { readonly kind: 'user' };

export interface Criterion {
  readonly condition: Condition;
  readonly failureMessage: string;
}

export type ComparisonOperator =
  'EQUALS' | 'NOT_EQUALS' | 'LESS_THAN' | 'LESS_THAN_EQUALS' | 'GREATER_THAN' | 'GREATER_THAN_EQUALS' | 'INTERSECTS';

export type Condition =
  | { readonly kind: 'true' }
  | { readonly kind: 'and' | 'or'; readonly conditions: readonly Condition[] }
  | { readonly kind: 'not'; readonly condition: Condition }
  | {
      readonly kind: 'comparison';
      readonly operator: ComparisonOperator;
      readonly left: ConditionValue;
      readonly right: ConditionValue;
    }
  | { readonly kind: 'regex'; readonly value: ConditionValue; readonly regex: string };

export type ConditionValue =
  | { readonly kind: 'parameter'; readonly parameter: ParameterId }
  | { readonly kind: 'static'; readonly value: JsonValue }
  | { readonly kind: 'objectProperty'; readonly parameter: ParameterId; readonly property: PropertyApiName }
  | { readonly kind: 'listLength'; readonly parameter: ParameterId }
  | { readonly kind: 'person'; readonly fact: PersonFact };

export interface RuleLogic {
  readonly kind: 'rules';
  readonly rules: readonly Rule[];
}
