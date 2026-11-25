import type { LinkSideApiName, LinkTypeApiName, ObjectTypeApiName } from './names.ts';
import type { CompiledProperty } from './objects.ts';
import type { Status } from './primitives.ts';

export type ScalarType =
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'double' }
  | { readonly kind: 'decimal'; readonly precision: number; readonly scale: number }
  | { readonly kind: 'date' }
  | { readonly kind: 'timestamp' };

export type PropertyType =
  | ScalarType
  | { readonly kind: 'array'; readonly element: ScalarType }
  | { readonly kind: 'struct'; readonly fields: ReadonlyMap<string, ScalarType> };

export interface CompiledLinkType {
  readonly apiName: LinkTypeApiName;
  readonly rid: string;
  readonly status: Status;
  readonly description?: string;
  readonly storage:
    | {
        readonly kind: 'foreignKey';
        readonly manySide: ObjectTypeApiName;
        readonly property: CompiledProperty;
        readonly oneSide: ObjectTypeApiName;
        readonly table: string;
      }
    | {
        readonly kind: 'joinTable';
        readonly table: string;
        readonly a: JoinTableSide;
        readonly b: JoinTableSide;
      };
}

export interface JoinTable {
  readonly table: string;
  readonly columns: readonly string[];
}

export interface JoinTableSide {
  readonly objectType: ObjectTypeApiName;
  readonly column: string;
}

export interface CompiledLink {
  readonly apiName: LinkSideApiName;
  readonly displayName: string;
  readonly linkType: LinkTypeApiName;
  readonly target: ObjectTypeApiName;
  readonly cardinality: 'ONE' | 'MANY';
  readonly via:
    | { readonly kind: 'foreignKeyHere'; readonly column: string }
    | { readonly kind: 'foreignKeyOnTarget'; readonly column: string }
    | {
        readonly kind: 'joinTable';
        readonly table: string;
        readonly sourceColumn: string;
        readonly targetColumn: string;
      };
}
