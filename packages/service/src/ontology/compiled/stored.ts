import type { OsdkSet } from '../../publish/index.ts';
import type { CompiledOntology } from './objects.ts';

export interface ListedOsdkSet {
  readonly name: string;
  readonly packages: OsdkSet;
  readonly platformPackages: Readonly<Record<string, string>>;
  readonly deprecated?: boolean;
}

export function sameOsdkSet(left: OsdkSet, right: OsdkSet): boolean {
  const names = Object.keys(left);

  return names.length === Object.keys(right).length && names.every((name) => left[name] === right[name]);
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'CompileError';
  }
}

export function emptyOntology(productRid: string): CompiledOntology {
  return {
    version: 0,
    productRid,
    metadata: {
      ontology: { apiName: 'ontology', displayName: 'Ontology', description: '', rid: productRid },
      objectTypes: {},
      actionTypes: {},
      actionTypesFullMetadata: {},
      queryTypes: {},
      interfaceTypes: {},
      sharedPropertyTypes: {},
      valueTypes: {},
    },
    objectTypes: new Map(),
    linkTypes: new Map(),
    actionTypes: new Map(),
    publishedActionTypeNames: new Map(),
    functions: new Map(),
  };
}
