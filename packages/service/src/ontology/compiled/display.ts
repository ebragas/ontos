import type { ParameterId } from './names.ts';

export interface TypeClass {
  readonly kind: string;
  readonly name: string;
}

export type Visibility = 'NORMAL' | 'PROMINENT' | 'HIDDEN';

export interface ObjectTypeDisplay {
  readonly displayName: string;
  readonly pluralDisplayName: string;
  readonly description: string | undefined;
  readonly icon: { readonly color: string; readonly locator: string };
  readonly visibility: Visibility;
}

export interface PropertyDisplay {
  readonly displayName: string;
  readonly description: string | undefined;
  readonly visibility: Visibility;
  readonly typeClasses: readonly TypeClass[];
  readonly structFields: ReadonlyMap<string, readonly TypeClass[]>;
}

export interface ActionTypeDisplay {
  readonly displayName: string;
  readonly description: string | undefined;
  readonly parameters: ReadonlyMap<ParameterId, ParameterDisplay>;
}

export interface ParameterDisplay {
  readonly displayName: string;
  readonly description: string;
  readonly typeClasses: readonly TypeClass[];
}
