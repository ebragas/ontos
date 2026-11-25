import type { Caller, OrganizationData, PermittedCaller } from '../auth/index.ts';
import type { Db, Reader, Writer } from '../db/index.ts';
import type { ApiError, AsyncFallible, Fallible, Fault } from '../errors/index.ts';
import type { DerivedRead } from '../objectSets/index.ts';
import type { CompiledOntology, CompileRun } from '../ontology/index.ts';
import type { WorkosPort } from '../publish/index.ts';
import type { HandleTrusted, RouteLogFields } from './entryTypes.ts';
import type { Settings } from './handleTypes.ts';

export interface Ctx {
  readonly db: Db;
  readonly reader: Reader;
  readonly ontology: CompiledOntology;
  readonly caller: PermittedCaller;
  readonly handleTrusted: HandleTrusted;
  readonly log: (fields: RouteLogFields) => void;
  readonly checkWrite: () => Fallible<number, ApiError>;
  readonly traceDerived: (read: DerivedRead) => void;
  readonly loadDerivedProperties?: true;
  readonly includeTotalCount?: boolean;
}

export type MemberCheck = (
  userIds: readonly string[],
  signal?: AbortSignal,
) => AsyncFallible<ReadonlySet<string>, ApiError | Fault>;

export interface WriteCtx extends Ctx {
  readonly writer: Writer;
  readonly activeMembers: MemberCheck;
}

export type OrganizationCaller = PermittedCaller;

export interface OrganizationCtx<Caller extends OrganizationData = OrganizationCaller> {
  readonly db: Db;
  readonly caller: Caller;
  readonly log: (fields: RouteLogFields) => void;
  readonly compile?: CompileRun;
}

export interface PublishCtx {
  readonly caller: Caller;
  readonly settings: Settings;
  readonly log: (fields: RouteLogFields) => void;
  readonly workos: WorkosPort;
}
