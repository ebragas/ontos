import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import type { DerivedNode } from '../derived/nodes.ts';
import type { StoredSelection } from '../derived/ir.ts';
import type { ObjectTypeDisplay, PropertyDisplay } from './display.ts';
import type { CompiledLink, CompiledLinkType, JoinTable, PropertyType } from './links.ts';
import type {
  ActionTypeApiName,
  LinkSideApiName,
  LinkTypeApiName,
  ObjectTypeApiName,
  PropertyApiName,
} from './names.ts';
import type { CompiledActionType } from './parameters.ts';
import type { Policy } from './policies.ts';
import type { FunctionApiName, PropertyStatus, Status } from './primitives.ts';
import type { CompiledFunction } from './rules.ts';
import type { CompiledValueType } from './valueTypes.ts';

export interface CompiledOntology {
  readonly version: number;
  readonly productRid: string;
  readonly metadata: OntologyFullMetadata;
  readonly objectTypes: ReadonlyMap<ObjectTypeApiName, CompiledObjectType>;
  readonly linkTypes: ReadonlyMap<LinkTypeApiName, CompiledLinkType>;
  readonly actionTypes: ReadonlyMap<ActionTypeApiName, CompiledActionType>;
  readonly publishedActionTypeNames: ReadonlyMap<string, ActionTypeApiName>;
  readonly functions: ReadonlyMap<FunctionApiName, CompiledFunction>;
  readonly functionBundle?: string;
}

export const UNIQUE_STRING_BYTES = 500;

export interface UniquenessConstraint {
  readonly name: string;
  readonly properties: readonly CompiledProperty[];
  readonly constraint: string;
}

export interface CompiledObjectType<Derived = CompiledDerivedProperty> {
  readonly apiName: ObjectTypeApiName;
  readonly rid: string;
  readonly status: Status;
  readonly display: ObjectTypeDisplay;
  readonly table: string;
  readonly primaryKey: CompiledProperty;
  readonly titleKey: PropertyApiName;
  readonly properties: ReadonlyMap<PropertyApiName, CompiledProperty>;
  readonly derived: ReadonlyMap<PropertyApiName, Derived>;
  readonly links: ReadonlyMap<LinkSideApiName, CompiledLink>;
  readonly joinTables: readonly JoinTable[];
  readonly uniqueness: readonly UniquenessConstraint[];
  readonly editsHistory?: { readonly storeAllPreviousProperties: boolean };
  readonly policy?: Policy;
}

export interface CompiledProperty {
  readonly apiName: PropertyApiName;
  readonly rid: string;
  readonly status: PropertyStatus;
  readonly display: PropertyDisplay;
  readonly column: string;
  readonly type: PropertyType;
  readonly required: boolean;
  readonly noEmptyCollections: boolean;
  readonly searchable: boolean;
  readonly policy?: Policy;
  readonly valueType?: CompiledValueType;
}

export interface CompiledDerivedProperty {
  readonly apiName: PropertyApiName;
  readonly rid: string;
  readonly status: PropertyStatus;
  readonly display: PropertyDisplay;
  readonly type: PropertyType;
  readonly definition: StoredSelection;
  readonly node: Extract<DerivedNode, { kind: 'selection' }>;
}
