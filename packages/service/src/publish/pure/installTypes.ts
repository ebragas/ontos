import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import type { Schemas } from '../../db/index.ts';
import type { CheckedRequest } from '../index.ts';

export interface InstallInput {
  readonly rid: string;
  readonly product: string;
  readonly apiName: string;
  readonly displayName: string;
  readonly organization: string;
}

export interface Installation {
  readonly rid: string;
  readonly schemas: Schemas;
  readonly version: number;
}

declare const versionsLock: unique symbol;

export type VersionsLock = { readonly [versionsLock]: true };

declare const rowLock: unique symbol;

export interface LockedInstallation {
  readonly [rowLock]: true;
  readonly number: number;
  readonly rid: string;
  readonly apiName: string;
  readonly product: string;
  readonly schemas: Schemas;
  readonly version: number;
}

export interface NewProductVersion {
  readonly product: string;
  readonly request: CheckedRequest;
  readonly metadata: OntologyFullMetadata;
  readonly publisher: string;
}

export type CheckScope = 'product' | { readonly organization: string | undefined };
