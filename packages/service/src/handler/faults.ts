import type { CallerKind } from '../auth/index.ts';
import { errorBody, redactedParameters, type ApiError } from '../errors/index.ts';
import type { TraceIds } from '../spans/index.ts';
import type { FaultFields, McpFaultFields, McpLogFields } from './context.ts';
import type { RouteMatch } from './routes.ts';

export type RequestLine = {
  userId?: string;
  callerKind?: CallerKind;
  ontologyVersion?: number;
  mcp?: McpLogFields;
  traceId?: string;
} & Record<string, unknown>;

interface ErrorLogFields {
  readonly errorInstanceId: string;
  readonly route?: string;
  readonly routeParams?: Readonly<Record<string, string>>;
  readonly errorName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type OnError = (error: unknown, fields: ErrorLogFields, status: number) => void;

export function errorLogFields(
  error: ApiError,
  errorInstanceId: string,
  match: Pick<RouteMatch, 'route' | 'params'> | undefined,
): ErrorLogFields {
  return {
    errorInstanceId,
    ...(match ? { route: `${match.route.method} ${match.route.path}`, routeParams: match.params } : {}),
    errorName: error.errorName,
    parameters: redactedParameters(error.errorName, error.parameters),
  };
}

type FaultSource = Pick<ErrorLogFields, 'errorName' | 'route'> & { readonly errorInstanceId?: string };

export function faultFields(
  fields: FaultSource,
  {
    userId,
    callerKind,
    ontologyVersion,
    mcp,
  }: Pick<RequestLine, 'userId' | 'callerKind' | 'ontologyVersion' | 'mcp'> = {},
  ids?: TraceIds,
): FaultFields {
  return {
    ...(fields.errorInstanceId === undefined ? {} : { errorInstanceId: fields.errorInstanceId }),
    errorName: fields.errorName,
    ...(fields.route === undefined ? {} : { route: fields.route }),
    ...(ontologyVersion === undefined ? {} : { ontologyVersion }),
    ...(userId === undefined ? {} : { userId }),
    ...(callerKind === undefined ? {} : { callerKind }),
    ...(mcp === undefined ? {} : { mcp: mcpFaultFields(mcp) }),
    ...(ids === undefined ? {} : { traceId: ids.traceId, rootSpanId: ids.rootSpanId }),
  };
}

function mcpFaultFields({ protocolVersion, ...fields }: McpLogFields): McpFaultFields {
  void protocolVersion;

  return fields;
}

export function stackOf(error: unknown): string {
  const source = error instanceof Error && error.cause instanceof Error ? error.cause : error;

  return source instanceof Error ? (source.stack ?? String(source)) : String(source);
}

export function errorResponse(
  error: ApiError,
  errorInstanceId: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(errorBody(error, errorInstanceId), { status: error.status, headers });
}
