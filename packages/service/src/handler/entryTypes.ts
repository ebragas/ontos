import type { PermittedCaller } from '../auth/index.ts';
import type { Reader, SnapshotDb } from '../db/index.ts';
import type { CompiledOntology } from '../ontology/index.ts';
import type { Ctx } from './ctxTypes.ts';
import type { HandleInput, MissingSettings } from './handleTypes.ts';

export interface TrustedInput {
  readonly db: SnapshotDb;
  readonly reader: Reader;
  readonly ontology: CompiledOntology;
  readonly caller: PermittedCaller;
  readonly checkWrite: Ctx['checkWrite'];
  readonly loadDerivedProperties?: true;
  readonly includeTotalCount?: boolean;
}

export type Handle = (request: Request, input: HandleInput | MissingSettings) => Promise<Response>;

export type HandleTrusted = (request: Request, input: TrustedInput) => Promise<Response>;

export interface RouteLogFields {
  readonly publish?: object;
  readonly mcp?: McpLogFields;
}

export interface McpLogFields {
  readonly method?: string;
  readonly tool?: string;
  readonly apiName?: string;
  readonly clientId?: string;
  readonly protocolVersion?: string;
}
