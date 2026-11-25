import type { LinkSideApiName, LinkTypeApiName, ObjectTypeApiName, ParameterId, PropertyApiName } from './names.ts';
import type { QueryOutput } from './outputs.ts';
import type { CompiledParameter } from './parameters.ts';
import type { FunctionApiName, JsonValue } from './primitives.ts';

export type Rule =
  | {
      readonly kind: 'addObject';
      readonly objectType: ObjectTypeApiName;
      readonly properties: ReadonlyMap<PropertyApiName, RuleValue>;
    }
  | {
      readonly kind: 'modifyObject';
      readonly object: ParameterId;
      readonly properties: ReadonlyMap<PropertyApiName, RuleValue>;
    }
  | { readonly kind: 'deleteObject'; readonly object: ParameterId }
  | {
      readonly kind: 'addLink' | 'deleteLink';
      readonly link: LinkSideApiName;
      readonly source: ParameterId;
      readonly target: ParameterId;
    };

export type RuleValue =
  | { readonly kind: 'parameter'; readonly parameter: ParameterId }
  | { readonly kind: 'static'; readonly value: JsonValue }
  | { readonly kind: 'objectProperty'; readonly parameter: ParameterId; readonly property: PropertyApiName }
  | { readonly kind: 'currentUser' }
  | { readonly kind: 'currentTime' }
  | { readonly kind: 'uniqueIdentifier' }
  | { readonly kind: 'structParameter'; readonly parameter: ParameterId };

export interface FunctionLogic {
  readonly kind: 'function';
  readonly function: FunctionApiName;
}

interface FunctionBase {
  readonly apiName: FunctionApiName;
  readonly rid: string;
  readonly version: string;
  readonly parameters: ReadonlyMap<ParameterId, CompiledParameter>;
  readonly descriptions: ReadonlyMap<ParameterId, string>;
}

export interface EditFunction extends FunctionBase {
  readonly kind: 'edit';
  readonly provenance: {
    readonly objectTypes: ReadonlySet<ObjectTypeApiName>;
    readonly linkTypes: ReadonlySet<LinkTypeApiName>;
  };
}

export interface QueryFunction extends FunctionBase {
  readonly kind: 'query';
  readonly description: string | undefined;
  readonly output: QueryOutput;
}

export type CompiledFunction = EditFunction | QueryFunction;
