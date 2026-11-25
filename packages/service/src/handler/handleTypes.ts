import type { AuthMode, AuthSettings, CallerKind, IdentityProvider, KeySource, UserSource } from '../auth/index.ts';
import type { Db } from '../db/index.ts';
import type { WorkosPort } from '../publish/index.ts';
import type { McpLogFields } from './entryTypes.ts';

export interface Settings {
  readonly productRid: string;
  readonly environment: string;
  readonly auth: AuthSettings;
  readonly authMode?: AuthMode;
  readonly authkitDomain?: string;
  readonly oidcIssuer?: string;
  readonly mcp?: true;
  readonly logRequestBodies?: true;
  readonly loadDerivedProperties?: true;
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
}

export interface HandleInput {
  readonly db: Db;
  readonly directDb: Db;
  readonly settings: Settings;
  readonly keys: KeySource;
  readonly users: UserSource;
  readonly workos: WorkosPort;
  readonly identity?: IdentityProvider;
  readonly reportFault?: ReportFault;
  readonly bodyPending?: (settled: Promise<void>) => void;
  readonly onBackground?: (pending: Promise<void>) => void;
}

export type ReportFault = (error: unknown, fields: FaultFields) => void;

export interface FaultFields {
  readonly errorInstanceId?: string;
  readonly errorName: string;
  readonly route?: string;
  readonly ontologyVersion?: number;
  readonly userId?: string;
  readonly callerKind?: CallerKind;
  readonly mcp?: McpFaultFields;
  readonly traceId?: string;
  readonly rootSpanId?: string;
}

export type McpFaultFields = Pick<McpLogFields, 'method' | 'tool' | 'apiName' | 'clientId'>;

export interface MissingSettings {
  readonly missing: readonly string[];
  readonly reason?: string;
  readonly reportFault?: ReportFault;
}
