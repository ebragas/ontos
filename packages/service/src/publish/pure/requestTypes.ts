import type { OntologyIr } from '@osdk/client.unstable';
import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import type { GrantsFile, JsonObject } from '../../ontology/index.ts';
import type { WorkosStep } from '../workosSteps.ts';
import type { OsdkSet, PublishedFunctions, SchemaMigration, SchemaMigrationsFile } from './schemaTypes.ts';

export interface PublishRequest {
  readonly product: string;
  readonly ir: OntologyIr;
  readonly schemaMigrations: SchemaMigrationsFile;
  readonly osdkSet: OsdkSet;
  readonly functions?: PublishedFunctions;
  readonly grants: GrantsFile;
  readonly validateOnly: boolean;
}

export interface CheckedRequest extends Omit<PublishRequest, 'ir' | 'functions'> {
  readonly ir: JsonObject;
  readonly functions?: CheckedFunctions;
}

export interface CheckedFunctions {
  readonly discovered: readonly JsonObject[];
  readonly bundle: string;
}

export interface PlannedChange {
  readonly description: string;
  readonly migration?: SchemaMigration;
}

export interface PublishResponse {
  readonly changes: readonly PlannedChange[];
  readonly metadata: OntologyFullMetadata;
  readonly version?: number;
  readonly transactionMs?: number;
  readonly warnings?: readonly string[];
  readonly workosSteps?: readonly WorkosStep[];
}
