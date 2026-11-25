import type { DataCaller, OrganizationData, UserSource } from '../auth/index.ts';
import type { Db, DbFailure } from '../db/index.ts';
import type { ApiError, AsyncFallible, Fault } from '../errors/index.ts';
import type { JsonValue } from '../ontology/index.ts';
import type { SpanName } from '../spans/index.ts';
import type { Ctx, OrganizationCtx, PublishCtx, WriteCtx } from './ctxTypes.ts';
import type { Settings } from './handleTypes.ts';
import type { CallTool, McpInput } from './mcpTypes.ts';
import type { RouteTable } from './routes.ts';

export type OntologyRouteKey = KeyOf<Extract<RouteTable[number], { readonly access: 'ontology' }>>;

type KeyOf<R> = R extends { readonly method: infer M extends string; readonly path: infer P extends string }
  ? `${M} ${P}`
  : never;

type PathOf<K extends string> = K extends `${string} ${infer P}` ? P : never;

type PathParamNames<P extends string> = P extends `${string}{${infer N}}${infer Rest}`
  ? N | PathParamNames<Rest>
  : never;

export type RouteParams<K extends OntologyRouteKey> = Readonly<
  Record<Exclude<PathParamNames<PathOf<K>>, 'ontology'>, string>
>;

export type RouteCall = {
  [K in OntologyRouteKey]: { readonly key: K; readonly params: RouteParams<K>; readonly body?: JsonValue };
}[OntologyRouteKey];

export interface RouteInput {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: JsonValue | undefined;
  readonly signal?: AbortSignal;
}

interface RouteBase {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly spans: readonly SpanName[];
}

export type RouteAnswer = AsyncFallible<Response, ApiError | DbFailure | Fault> | Promise<Response>;

export type Route =
  | (RouteBase & {
      readonly access: 'ontology';
      readonly writes?: never;
      readonly runsFunction?: true;
      readonly run: (input: RouteInput, ctx: Ctx) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'ontology';
      readonly writes: true;
      readonly run: (input: RouteInput, ctx: WriteCtx) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'organization';
      readonly permissions?: true;
      readonly run: (input: RouteInput, ctx: OrganizationCtx) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'organization';
      readonly permissions: false;
      readonly run: (input: RouteInput, ctx: OrganizationCtx<OrganizationData>) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'publish';
      readonly run: (input: RouteInput, ctx: PublishCtx, directDb: Db) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'mcp';
      readonly run: (input: McpInput, callTool: CallTool) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'users';
      readonly run: (input: RouteInput, users: UserSource, caller: DataCaller) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'token';
      readonly run: (request: Request, settings: Settings) => RouteAnswer;
    })
  | (RouteBase & {
      readonly access: 'public';
      readonly run: (input: RouteInput, settings: Settings) => RouteAnswer;
    });
