import type { OntologyV2 } from '@osdk/foundry.ontologies';
import type { ApiError, AsyncFallible, Fallible, Fault } from '../errors/index.ts';
import type { JsonValue } from '../ontology/index.ts';
import type { Ctx } from './ctxTypes.ts';
import type { RouteCall } from './routeTypes.ts';

export type CallTool = (
  choose: ChooseOntology,
  call: (ctx: McpCtx) => AsyncFallible<RouteResult, ApiError | Fault>,
) => Promise<RouteResult>;

export type ChooseOntology = (ontologies: readonly OntologyV2[]) => Fallible<string | RouteResult, ApiError>;

export interface McpCtx extends Ctx {
  readonly runRoute: RunRoute;
}

export type RunRoute = (call: RouteCall) => Promise<RouteResult>;

export interface RouteResult {
  readonly status: number;
  readonly body: JsonValue;
}

export interface McpInput {
  readonly request: Request;
  readonly body: JsonValue | undefined;
}
