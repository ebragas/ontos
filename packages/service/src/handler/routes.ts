import { applyAction, applyActionBatch, editsHistory, executeQuery } from '../actions/index.ts';
import {
  authkitIssuer,
  getCurrentUser,
  getUser,
  getUsersBatch,
  listOrganizations,
  mcpUrl,
  tokenRoute,
} from '../auth/index.ts';
import { attempt, outsideFailure, type ApiError, type AsyncFallible, type Fault } from '../errors/index.ts';
import { aggregate, loadObjects } from '../objectSets/index.ts';
import {
  getActionType,
  getActionTypeByRid,
  getObjectType,
  getObjectTypeFullMetadata,
  getOntologyFullMetadata,
  getPermissionCatalog,
  getQueryType,
  listActionTypes,
  listObjectTypes,
  listOntologies,
  listQueryTypes,
  queryOf,
} from '../ontology/index.ts';
import type { ClientConfig } from './clientConfig.ts';
import type { Empty, RouteKey } from '../spans/index.ts';
import type { Db, DbFailure } from '../db/index.ts';
import type { CallTool, Ctx, McpInput, OrganizationCtx, PublishCtx, Route, RouteInput, Settings } from './context.ts';

type McpModule = typeof import('../mcp/index.ts');

type PublishModule = typeof import('../publish/index.ts');

let mcpModule: McpModule | undefined;
let publishModule: PublishModule | undefined;

export async function* loadMcp(): AsyncFallible<McpModule, ApiError | Fault> {
  return (mcpModule ??= yield* attempt(() => import('../mcp/index.ts'), outsideFailure));
}

async function* loadPublish(): AsyncFallible<PublishModule, ApiError | Fault> {
  return (publishModule ??= yield* attempt(() => import('../publish/index.ts'), outsideFailure));
}

async function* runMcp(input: McpInput, callTool: CallTool): AsyncFallible<Response, ApiError | Fault> {
  const { mcp } = yield* loadMcp();

  return yield* mcp(input, callTool);
}

async function* runPublish(
  input: RouteInput,
  ctx: PublishCtx,
  db: Db,
): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  const { publish } = yield* loadPublish();

  return yield* publish(input, ctx, db);
}

async function* runInstall(
  input: RouteInput,
  ctx: OrganizationCtx,
): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  const { install } = yield* loadPublish();

  return yield* install(input, ctx);
}

const OSDK_API_PREFIX = '/api/v2/ontologies/{ontology}';

function clientConfig(input: RouteInput, settings: Settings): Promise<Response> {
  void input;

  const body: ClientConfig = {
    productRid: settings.productRid,
    workosClientId: settings.auth.workosClientId,
    environment: settings.environment,
  };

  return Promise.resolve(Response.json(body));
}

async function* runQuery(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  const fn = yield* queryOf(ctx.ontology, input.params['queryApiName'] ?? '', input.query.get('version'));

  return yield* executeQuery(fn, input, ctx);
}

function authorizationServerOf(settings: Settings): string | undefined {
  if (settings.authMode === 'dev') return settings.auth.baseUrl;

  if (settings.authMode === 'oidc') return settings.oidcIssuer;

  return settings.authkitDomain === undefined ? undefined : authkitIssuer(settings.authkitDomain);
}

function protectedResource(input: RouteInput, settings: Settings): Promise<Response> {
  void input;

  const server = authorizationServerOf(settings);

  if (settings.mcp !== true || server === undefined) return Promise.resolve(new Response(null, { status: 404 }));

  return Promise.resolve(
    Response.json({
      resource: mcpUrl(settings.auth.baseUrl),
      authorization_servers: [server],
    }),
  );
}

export function mcpOn(settings: Settings): boolean {
  return settings.mcp === true && authorizationServerOf(settings) !== undefined;
}

const BODY = ['response.body'] as const;

const CHECKED = ['token check', ...BODY] as const;

const MCP = ['token check'] as const;

const VIEW = [...CHECKED, 'ontology view'] as const;

const table = [
  {
    method: 'GET',
    path: '/api/v2/ontologies',
    access: 'organization',
    permissions: false,
    spans: CHECKED,
    run: listOntologies,
  },
  {
    method: 'GET',
    path: `${OSDK_API_PREFIX}/fullMetadata`,
    access: 'ontology',
    spans: VIEW,
    run: getOntologyFullMetadata,
  },
  {
    method: 'GET',
    path: `${OSDK_API_PREFIX}/objectTypes/{objectType}/fullMetadata`,
    access: 'ontology',
    spans: VIEW,
    run: getObjectTypeFullMetadata,
  },
  {
    method: 'GET',
    path: `${OSDK_API_PREFIX}/actionTypes/{actionType}`,
    access: 'ontology',
    spans: VIEW,
    run: getActionType,
  },
  { method: 'GET', path: `${OSDK_API_PREFIX}/objectTypes`, access: 'ontology', spans: VIEW, run: listObjectTypes },
  {
    method: 'GET',
    path: `${OSDK_API_PREFIX}/objectTypes/{objectType}`,
    access: 'ontology',
    spans: VIEW,
    run: getObjectType,
  },
  { method: 'GET', path: `${OSDK_API_PREFIX}/actionTypes`, access: 'ontology', spans: VIEW, run: listActionTypes },
  {
    method: 'GET',
    path: `${OSDK_API_PREFIX}/actionTypes/byRid/{actionTypeRid}`,
    access: 'ontology',
    spans: VIEW,
    run: getActionTypeByRid,
  },
  { method: 'GET', path: `${OSDK_API_PREFIX}/queryTypes`, access: 'ontology', spans: VIEW, run: listQueryTypes },
  {
    method: 'GET',
    path: `${OSDK_API_PREFIX}/queryTypes/{queryApiName}`,
    access: 'ontology',
    spans: VIEW,
    run: getQueryType,
  },
  {
    method: 'POST',
    path: `${OSDK_API_PREFIX}/queries/{queryApiName}/execute`,
    access: 'ontology',
    runsFunction: true,
    spans: [...VIEW, 'function run'],
    run: runQuery,
  },
  {
    method: 'POST',
    path: `${OSDK_API_PREFIX}/objectSets/loadObjects`,
    access: 'ontology',
    spans: VIEW,
    run: loadObjects,
  },
  { method: 'POST', path: `${OSDK_API_PREFIX}/objectSets/aggregate`, access: 'ontology', spans: VIEW, run: aggregate },
  {
    method: 'POST',
    path: `${OSDK_API_PREFIX}/actions/{action}/apply`,
    access: 'ontology',
    writes: true,
    spans: [...VIEW, 'apply attempt'],
    run: applyAction,
  },
  {
    method: 'POST',
    path: `${OSDK_API_PREFIX}/actions/{action}/applyBatch`,
    access: 'ontology',
    writes: true,
    spans: VIEW,
    run: applyActionBatch,
  },
  {
    method: 'POST',
    path: `${OSDK_API_PREFIX}/objectTypes/{objectType}/editsHistory`,
    access: 'ontology',
    spans: VIEW,
    run: editsHistory,
  },
  { method: 'GET', path: '/api/v2/admin/users/getCurrent', access: 'users', spans: CHECKED, run: getCurrentUser },
  { method: 'GET', path: '/api/v2/admin/users/{userId}', access: 'users', spans: CHECKED, run: getUser },
  { method: 'POST', path: '/api/v2/admin/users/getBatch', access: 'users', spans: CHECKED, run: getUsersBatch },
  {
    method: 'POST',
    path: '/api/ontology-service/v1/publish',
    access: 'publish',
    spans: [...CHECKED, 'publish read', 'publish plan'],
    run: runPublish,
  },
  {
    method: 'POST',
    path: '/api/ontology-service/v1/ontologies',
    access: 'organization',
    spans: CHECKED,
    run: runInstall,
  },
  {
    method: 'GET',
    path: '/api/ontology-service/v1/ontologies/{ontologyRid}/permissions',
    access: 'organization',
    spans: CHECKED,
    run: getPermissionCatalog,
  },
  {
    method: 'GET',
    path: '/api/ontology-service/v1/organizations',
    access: 'users',
    spans: CHECKED,
    run: listOrganizations,
  },
  { method: 'GET', path: '/api/ontology-service/v1/client-config', access: 'public', spans: BODY, run: clientConfig },
  { method: 'POST', path: '/api/mcp', access: 'mcp', spans: MCP, run: runMcp },
  { method: 'GET', path: '/api/mcp', access: 'mcp', spans: MCP, run: runMcp },
  { method: 'GET', path: '/api/oauth-protected-resource', access: 'public', spans: BODY, run: protectedResource },
  {
    method: 'POST',
    path: '/multipass/api/oauth2/token',
    access: 'token',
    spans: ['workos token', ...BODY],
    run: tokenRoute,
  },
] as const satisfies readonly Route[];

export const routes: readonly Route[] = table;

export type RouteTable = typeof table;

type TableKey = RouteTable[number] extends infer R
  ? R extends { readonly method: infer M extends string; readonly path: infer P extends string }
    ? `${M} ${P}`
    : never
  : never;

const routeKeysMatch: [Empty<Exclude<TableKey, RouteKey>>, Empty<Exclude<RouteKey, TableKey>>] = [true, true];

void routeKeysMatch;

export interface RouteMatch {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}
