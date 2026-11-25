import { MCP_METHODS, MCP_TOOLS } from './catalogData.ts';

const ROUTE_KEYS = [
  'GET /api/v2/ontologies',
  'GET /api/v2/ontologies/{ontology}/fullMetadata',
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata',
  'GET /api/v2/ontologies/{ontology}/actionTypes/{actionType}',
  'GET /api/v2/ontologies/{ontology}/objectTypes',
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}',
  'GET /api/v2/ontologies/{ontology}/actionTypes',
  'GET /api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}',
  'GET /api/v2/ontologies/{ontology}/queryTypes',
  'GET /api/v2/ontologies/{ontology}/queryTypes/{queryApiName}',
  'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute',
  'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects',
  'POST /api/v2/ontologies/{ontology}/objectSets/aggregate',
  'POST /api/v2/ontologies/{ontology}/actions/{action}/apply',
  'POST /api/v2/ontologies/{ontology}/actions/{action}/applyBatch',
  'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory',
  'GET /api/v2/admin/users/getCurrent',
  'GET /api/v2/admin/users/{userId}',
  'POST /api/v2/admin/users/getBatch',
  'POST /api/ontology-service/v1/publish',
  'POST /api/ontology-service/v1/ontologies',
  'GET /api/ontology-service/v1/ontologies/{ontologyRid}/permissions',
  'GET /api/ontology-service/v1/organizations',
  'GET /api/ontology-service/v1/client-config',
  'POST /api/mcp',
  'GET /api/mcp',
  'GET /api/oauth-protected-resource',
  'POST /multipass/api/oauth2/token',
] as const;

export type RouteKey = (typeof ROUTE_KEYS)[number];

const routeKeys: ReadonlySet<string> = new Set(ROUTE_KEYS);

export const isRouteKey = (value: unknown): value is RouteKey => typeof value === 'string' && routeKeys.has(value);

export type McpToolName = (typeof MCP_TOOLS)[number];

const isOneOf = <L extends string>(values: readonly L[], value: string): value is L =>
  (values as readonly string[]).includes(value);

export const mcpMethodOf = (method: string): (typeof MCP_METHODS)[number] =>
  isOneOf(MCP_METHODS, method) ? method : 'other';

export const mcpToolOf = (tool: string): McpToolName | undefined => (isOneOf(MCP_TOOLS, tool) ? tool : undefined);
