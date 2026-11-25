import type { JsonValue, LinkSideApiName, ObjectTypeApiName, PrimaryKey, PropertyApiName } from '../ontology/index.ts';

export interface ObjectLocator {
  readonly objectType: ObjectTypeApiName;
  readonly primaryKey: PrimaryKey;
}

type PropertyValues = ReadonlyMap<PropertyApiName, JsonValue>;

type UnsetLists = ReadonlySet<PropertyApiName>;

export type Edit =
  | {
      readonly type: 'addObject';
      readonly object: ObjectLocator;
      readonly properties: PropertyValues;
      readonly unset?: UnsetLists;
    }
  | {
      readonly type: 'modifyObject';
      readonly object: ObjectLocator;
      readonly properties: PropertyValues;
      readonly unset?: UnsetLists;
    }
  | { readonly type: 'deleteObject'; readonly object: ObjectLocator }
  | {
      readonly type: 'addLink' | 'deleteLink';
      readonly link: LinkSideApiName;
      readonly source: ObjectLocator;
      readonly target: ObjectLocator;
    };

declare const checked: unique symbol;

export type CheckedEdit = Edit & { readonly [checked]: true };
