import type { CompiledLink } from './links.ts';
import type { PropertyApiName } from './names.ts';

export type PersonAttributeName = string;

export type PersonFact =
  | { readonly kind: 'userId' }
  | { readonly kind: 'permissions' }
  | { readonly kind: 'attribute'; readonly name: PersonAttributeName };

export type PolicyOperator = 'equal' | 'intersects' | 'subsetOf' | 'supersetOf';

export type PolicyObjectSide =
  | { readonly kind: 'property'; readonly property: PropertyApiName }
  | { readonly kind: 'constant'; readonly values: readonly string[] };

export type Policy =
  | { readonly kind: 'and' | 'or'; readonly conditions: readonly Policy[] }
  | {
      readonly kind: 'compare';
      readonly object: PolicyObjectSide;
      readonly operator: PolicyOperator;
      readonly person: PersonFact;
    };

export interface CompiledPersonAttribute {
  readonly name: PersonAttributeName;
  readonly start: { readonly table: string; readonly keyColumn: string; readonly userColumn: string };
  readonly steps: readonly {
    readonly via: CompiledLink['via'];
    readonly target: { readonly table: string; readonly keyColumn: string };
  }[];
}
