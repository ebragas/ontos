import type { CallerKind } from '../auth/index.ts';
import type { Route } from '../handler/index.ts';
import type { CompiledFunction } from '../ontology/index.ts';
import type { ApiName, SqlTemplate, TracedUser } from './brandTypes.ts';
import type { RouteKey } from './catalogHelpers.ts';

export type Kind = 'number' | 'boolean' | 'routeKey' | 'sqlTemplate' | 'apiName' | 'tracedUser' | readonly string[];

export type ValueOf<K> = K extends 'number'
  ? number
  : K extends 'boolean'
    ? boolean
    : K extends 'routeKey'
      ? RouteKey
      : K extends 'sqlTemplate'
        ? SqlTemplate
        : K extends 'apiName'
          ? ApiName
          : K extends 'tracedUser'
            ? TracedUser
            : K extends readonly (infer L extends string)[]
              ? L
              : never;

export interface Entry {
  readonly start: Readonly<Record<string, Kind>>;
  readonly later: Readonly<Record<string, Kind>>;
  readonly requires: readonly string[];
  readonly named?: true;
  readonly fixed?: Readonly<Record<string, string>>;
  readonly records?: readonly string[];
}

const ACCESS = [
  'organization',
  'ontology',
  'users',
  'publish',
  'public',
  'mcp',
  'token',
] as const satisfies readonly Route['access'][];

const CALLER_KINDS = ['person', 'service', 'publish', 'check'] as const satisfies readonly CallerKind[];
const FUNCTION_KINDS = ['edit', 'query'] as const satisfies readonly CompiledFunction['kind'][];

export const MCP_METHODS = [
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'tools/call',
  'other',
] as const;

export const MCP_TOOLS = [
  'describe_object_type',
  'describe_action',
  'load_objects',
  'aggregate_objects',
  'describe_query',
  'execute_query',
  'get_edit_history',
  'apply_action',
] as const;

const STATUS = { 'http.status_code': 'number' } as const;

const DERIVED_OPERATIONS = [
  'get',
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'exactDistinct',
  'approximateDistinct',
  'approximatePercentile',
  'collectList',
  'collectSet',
  'property',
  'expression',
] as const;

export const CATALOG = {
  root: {
    start: { 'route.key': 'routeKey', 'route.access': ACCESS },
    later: {
      ...STATUS,
      'ontology.version': 'number',
      'user.id': 'tracedUser',
      'caller.kind': CALLER_KINDS,
      'mcp.method.name': MCP_METHODS,
      'mcp.tool.name': MCP_TOOLS,
      'ontology.cold_start': 'boolean',
      'derived.count': 'number',
      'derived.objects': 'number',
      'derived.sql_ms': 'number',
      'action.api_name': 'apiName',
    },
    requires: [],
    named: true,
    fixed: { 'sentry.op': 'http.server' },
  },
  'response.body': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'http.server' } },
  'token check': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'middleware' } },
  'jwks fetch': { start: {}, later: STATUS, requires: [], fixed: { 'sentry.op': 'http.client' } },
  'workos token': { start: {}, later: STATUS, requires: [], fixed: { 'sentry.op': 'http.client' } },
  'workos read': {
    start: {
      'workos.read': [
        'user',
        'membership',
        'memberships page',
        'members page',
        'applications page',
        'role',
        'permissions',
        'roles',
        'organizations page',
        'application',
        'organization',
      ],
    },
    later: STATUS,
    requires: [],
    fixed: { 'sentry.op': 'http.client' },
  },
  'workos write': {
    start: { 'workos.write': ['createPermission', 'setDescription', 'createRole', 'addPermission', 'setPermissions'] },
    later: STATUS,
    requires: [],
    fixed: { 'sentry.op': 'http.client' },
  },
  'ontology view': {
    start: {},
    later: { 'ontology.cache.hit': 'boolean', 'ontology.version': 'number' },
    requires: [],
    fixed: { 'sentry.op': 'cache.get' },
  },
  'ontology compile': {
    start: { 'ontology.version': 'number' },
    later: {},
    requires: [],
    fixed: { 'sentry.op': 'function' },
  },
  'cold start': {
    start: { 'cold_start.role': ['ran', 'joined'] },
    later: {},
    requires: [],
    fixed: { 'sentry.op': 'function' },
  },
  sql: {
    start: { 'sql.template': 'sqlTemplate', 'sql.held': 'boolean' },
    later: {},
    requires: [],
    fixed: { 'sentry.op': 'db.query' },
  },
  'sql connection wait': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'db' } },
  'function run': {
    start: { 'function.api_name': 'apiName', 'function.kind': FUNCTION_KINDS, 'action.api_name': 'apiName' },
    later: {},
    requires: ['worker wait', 'worker call'],
    fixed: { 'sentry.op': 'function' },
  },
  'worker wait': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'worker call': {
    start: {},
    later: {},
    requires: ['function body'],
    records: ['bundle load', 'function body'],
    fixed: { 'sentry.op': 'function' },
  },
  'bundle load': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'resource.script' } },
  'function body': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'function client': {
    start: { 'route.key': 'routeKey' },
    later: STATUS,
    requires: [],
    named: true,
    fixed: { 'sentry.op': 'handler' },
  },
  'mcp tool': {
    start: { 'mcp.tool.name': MCP_TOOLS, 'gen_ai.tool.name': MCP_TOOLS },
    later: {},
    requires: [],
    fixed: {
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'mcp.transport': 'http',
      'network.transport': 'tcp',
      'sentry.op': 'mcp.server',
    },
  },
  'mcp route': {
    start: { 'route.key': 'routeKey' },
    later: STATUS,
    requires: [],
    named: true,
    fixed: { 'sentry.op': 'handler' },
  },
  'derived property': {
    start: {
      'object_type.api_name': 'apiName',
      'derived.api_name': 'apiName',
      'derived.position': 'number',
      'derived.form': ['objectType', 'request'],
      'derived.reason': ['select', 'requestFlag', 'setting', 'query'],
      'derived.hops': 'number',
      'derived.operation': DERIVED_OPERATIONS,
    },
    later: {},
    requires: [],
    fixed: { 'sentry.op': 'function' },
  },
  'apply attempt': {
    start: { 'apply.attempt': 'number' },
    later: { 'apply.object_edits': 'number' },
    requires: [],
    fixed: { 'sentry.op': 'function' },
  },
  'publish read': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'publish plan': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'publish workos': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'publish workos steps': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'publish store': { start: {}, later: {}, requires: ['lock wait'], fixed: { 'sentry.op': 'function' } },
  'publish reconcile': { start: {}, later: {}, requires: [], fixed: { 'sentry.op': 'function' } },
  'lock wait': { start: {}, later: { 'ontology.number': 'number' }, requires: [], fixed: { 'sentry.op': 'db' } },
  'upgrade installation': { start: {}, later: {}, requires: ['upgrade step'], fixed: { 'sentry.op': 'function' } },
  'upgrade step': {
    start: { 'product.version': 'number' },
    later: {},
    requires: ['lock wait'],
    fixed: { 'sentry.op': 'function' },
  },
} as const satisfies Readonly<
  Record<string, Entry & { readonly fixed: { readonly 'sentry.op': string } & Readonly<Record<string, string>> }>
>;

type Catalog = typeof CATALOG;

type SpanName = keyof Catalog;

type Empty<T> = [T] extends [never] ? true : T;

type Recorded = Extract<Catalog[SpanName], { readonly records: readonly string[] }>['records'][number];

const catalogChecks: [
  Empty<Exclude<Catalog[SpanName]['requires'][number] | Recorded, SpanName>>,
  Empty<Exclude<Route['access'], (typeof ACCESS)[number]>>,
] = [true, true];

void catalogChecks;
