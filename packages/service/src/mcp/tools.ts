import type { JsonSchemaType, ToolAnnotations } from '@modelcontextprotocol/server';
import { attempt, outsideFailure, type ApiError, type AsyncFallible, type Fault } from '../errors/index.ts';
import type { McpCtx, McpLogFields, RouteResult } from '../handler/index.ts';
import type { JsonObject, JsonValue } from '../ontology/index.ts';
import type { Empty, McpToolName } from '../spans/index.ts';
import { actionTypeAnswer, actionTypeList, businessMap, objectTypeAnswer, propertiesText } from './describe.ts';
import { DESCRIBE_ACTION, DESCRIBE_OBJECT_TYPE, DESCRIBE_QUERY } from './describeSchemas.ts';
import { pageSizeOf } from './pageSize.ts';
import { describeQuery } from './queries.ts';
import { AGGREGATE_OBJECTS, APPLY_ACTION, EXECUTE_QUERY, GET_EDIT_HISTORY, LOAD_OBJECTS } from './schemas.ts';
import type { ShortNameArgument } from './shortNames.ts';

export type ToolArgs = JsonObject;

export interface Tool {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: JsonSchemaType;
  readonly annotations: ToolAnnotations;
  readonly apiNameArgument?: string;
  readonly shortNames?: ShortNameArgument;
  readonly call: (args: ToolArgs, ctx: McpCtx) => AsyncFallible<RouteResult, ApiError | Fault>;
  readonly faultNote?: string;
  readonly errorNote?: (body: JsonValue) => string | undefined;
  readonly listsOntologiesFor?: (args: ToolArgs) => boolean;
  readonly failed?: (body: JsonObject) => boolean;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

const MAP_FIRST = 'Call describe_object_type with no name first for a map of the business.';

function apiName(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;

  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  return value === undefined || value === null ? '' : JSON.stringify(value);
}

function withPageSize(args: ToolArgs, max: number): JsonObject {
  return { ...args, pageSize: pageSizeOf(args['pageSize'], max) };
}

const describeObjectType = {
  name: 'describe_object_type',
  description: `${MAP_FIRST} The map gives each Object Type, each Link Type, and the Action Types of each Object Type. With an objectType, it describes 1 Object Type: its Properties, its primary key, and its outgoing Link Types. Call it before load_objects or aggregate_objects.`,
  inputSchema: DESCRIBE_OBJECT_TYPE,
  annotations: READ_ONLY,
  shortNames: 'objectType',
  apiNameArgument: 'objectType',
  listsOntologiesFor: (args) => args['objectType'] === undefined,
  async *call(args, ctx): AsyncFallible<RouteResult, ApiError> {
    return {
      status: 200,
      body:
        args['objectType'] === undefined
          ? businessMap(ctx.ontology)
          : yield* objectTypeAnswer(ctx.ontology, apiName(args['objectType'])),
    };
  },
} satisfies Tool;

const describeAction = {
  name: 'describe_action',
  description: `${MAP_FIRST} Lists each Action Type of the Ontology, or describes 1 Action Type: its description and its parameters. Call it before apply_action.`,
  inputSchema: DESCRIBE_ACTION,
  annotations: READ_ONLY,
  apiNameArgument: 'actionType',
  async *call(args, ctx): AsyncFallible<RouteResult, ApiError> {
    return {
      status: 200,
      body:
        args['actionType'] === undefined
          ? actionTypeList(ctx.ontology)
          : yield* actionTypeAnswer(ctx.ontology, apiName(args['actionType'])),
    };
  },
} satisfies Tool;

const loadObjects = {
  name: 'load_objects',
  description: `${MAP_FIRST} Loads 1 page of Objects of an Object Set. Use select to name the Properties that you need. A Link traversal is a searchAround Object Set. A lookup by primary key is a filter. A derived Property is returned only when \`select\` names it.`,
  inputSchema: LOAD_OBJECTS,
  annotations: READ_ONLY,
  shortNames: 'objectSet',
  call: (args, ctx) =>
    attempt(
      () =>
        ctx.runRoute({
          key: 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects',
          params: {},
          body: { ...withPageSize(args, 200), loadOntologyDefinedDerivedProperties: false },
        }),
      outsideFailure,
    ),
} satisfies Tool;

const aggregateObjects = {
  name: 'aggregate_objects',
  description: `${MAP_FIRST} Aggregates the Objects of an Object Set: 1 or more metrics, for the whole set or for each group of groupBy.`,
  inputSchema: AGGREGATE_OBJECTS,
  annotations: READ_ONLY,
  shortNames: 'objectSet',
  call: (args, ctx) =>
    attempt(
      () => ctx.runRoute({ key: 'POST /api/v2/ontologies/{ontology}/objectSets/aggregate', params: {}, body: args }),
      outsideFailure,
    ),
} satisfies Tool;

const describeQueryTool = {
  name: 'describe_query',
  description: `${MAP_FIRST} Lists each Query Function, or describes 1 Query Function: its inputs and its output type. A Query Function computes a value, such as a total, and changes no data. Call it before execute_query.`,
  inputSchema: DESCRIBE_QUERY,
  annotations: READ_ONLY,
  apiNameArgument: 'query',
  async *call(args, ctx): AsyncFallible<RouteResult, ApiError> {
    return {
      status: 200,
      body: yield* describeQuery(ctx.ontology, args['query'] === undefined ? undefined : apiName(args['query'])),
    };
  },
} satisfies Tool;

const executeQuery = {
  name: 'execute_query',
  description: `${MAP_FIRST} Runs 1 Query Function as the person who signed in, and gives its value. It changes no data. Call describe_query first.`,
  inputSchema: EXECUTE_QUERY,
  annotations: { readOnlyHint: true, idempotentHint: true },
  apiNameArgument: 'query',
  call: (args, ctx) =>
    attempt(
      () =>
        ctx.runRoute({
          key: 'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute',
          params: { queryApiName: apiName(args['query']) },
          body: { parameters: args['parameters'] ?? null },
        }),
      outsideFailure,
    ),
} satisfies Tool;

const getEditHistory = {
  name: 'get_edit_history',
  description: `${MAP_FIRST} Reads the Object Edit History of 1 Object Type, or of 1 Object with objectPrimaryKey: who changed what, and when. An Object Type with history off gives an empty page.`,
  inputSchema: GET_EDIT_HISTORY,
  annotations: READ_ONLY,
  shortNames: 'objectType',
  apiNameArgument: 'objectType',
  call: ({ objectType, ...rest }, ctx) =>
    attempt(
      () =>
        ctx.runRoute({
          key: 'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory',
          params: { objectType: apiName(objectType) },
          body: withPageSize(rest, 100),
        }),
      outsideFailure,
    ),
} satisfies Tool;

const applyAction = {
  name: 'apply_action',
  description: `${MAP_FIRST} Applies 1 Action as the person who signed in: it validates the parameters, runs the Action, and writes its edits. The answer lists the edits, or only the edited Object Types when the Action edits more than 5,000 Objects. Call describe_action first.`,
  inputSchema: APPLY_ACTION,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  apiNameArgument: 'action',
  faultNote:
    'The Action may have applied. Call `get_edit_history` on the Objects before you call `apply_action` again.',
  failed: ({ validation }) => isObject(validation) && validation['result'] === 'INVALID',
  errorNote: clashNote,
  call: (args, ctx) =>
    attempt(
      () =>
        ctx.runRoute({
          key: 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply',
          params: { action: apiName(args['action']) },
          body: {
            parameters: args['parameters'] ?? null,
            options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
          },
        }),
      outsideFailure,
    ),
} satisfies Tool;

function clashNote(body: JsonValue): string | undefined {
  if (!isObject(body) || body['errorName'] !== 'PropertyValueAlreadyExists' || !isObject(body['parameters']))
    return undefined;

  const { objectType, properties } = body['parameters'];

  if (
    typeof objectType !== 'string' ||
    !Array.isArray(properties) ||
    !properties.every((property) => typeof property === 'string')
  )
    return undefined;

  return `Another Object of ${objectType} has the same ${propertiesText(properties)}, and the error does not name it, so use other values or change that Object first.`;
}

const tools = [
  describeObjectType,
  loadObjects,
  aggregateObjects,
  describeQueryTool,
  executeQuery,
  getEditHistory,
  describeAction,
  applyAction,
] as const;

export const TOOLS: readonly Tool[] = tools;

const toolNamesMatch: Empty<Exclude<McpToolName, (typeof tools)[number]['name']>> = true;

void toolNamesMatch;

export function mcpLogFields(body: JsonValue | undefined): Pick<McpLogFields, 'method' | 'tool' | 'apiName'> {
  if (!isObject(body)) return {};

  const method = typeof body['method'] === 'string' ? body['method'] : undefined;
  const params = isObject(body['params']) ? body['params'] : {};
  const tool = method === 'tools/call' && typeof params['name'] === 'string' ? params['name'] : undefined;
  const args = isObject(params['arguments']) ? params['arguments'] : {};
  const argument = tool === undefined ? undefined : TOOLS.find((candidate) => candidate.name === tool)?.apiNameArgument;
  const name = argument === undefined ? undefined : args[argument];

  return {
    ...(method === undefined ? {} : { method }),
    ...(tool === undefined ? {} : { tool }),
    ...(typeof name === 'string' ? { apiName: name } : {}),
  };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
