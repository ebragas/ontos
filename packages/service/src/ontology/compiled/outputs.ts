import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import type { OsdkSet } from '../../publish/index.ts';
import type { LinkSideApiName, ObjectTypeApiName, PropertyApiName } from './names.ts';
import type { ParameterScalarType } from './parameters.ts';

export type OutputValueType =
  | ParameterScalarType
  | { readonly kind: 'object'; readonly objectType: ObjectTypeApiName }
  | { readonly kind: 'list'; readonly element: OutputValueType }
  | {
      readonly kind: 'struct';
      readonly fields: ReadonlyMap<string, { readonly type: OutputValueType; readonly optional: boolean }>;
    };

export interface QueryOutput {
  readonly type: OutputValueType;
  readonly optional: boolean;
}

export interface StoredOntologyVersion {
  readonly version: number;
  readonly ir: unknown;
  readonly metadata: OntologyFullMetadata;
  readonly osdkSet: OsdkSet;
  readonly functions?: StoredFunctions;
  readonly grants: unknown;
}

export interface PersonAttributeDeclaration {
  readonly start: { readonly objectType: ObjectTypeApiName; readonly property: PropertyApiName };
  readonly links: readonly LinkSideApiName[];
}

export interface StoredFunctions {
  readonly discovered: readonly unknown[];
  readonly bundle: string;
}
