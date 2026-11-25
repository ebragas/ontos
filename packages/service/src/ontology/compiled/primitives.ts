import type { PropertyApiName } from './names.ts';

export type FunctionApiName = string;

export type PrimaryKey = string;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export type Status = 'experimental' | 'active' | 'deprecated';

export type PropertyStatus =
  | { readonly type: Exclude<Status, 'deprecated'> }
  | {
      readonly type: 'deprecated';
      readonly message: string;
      readonly deadline: string;
      readonly replacedBy: PropertyApiName | undefined;
    };
