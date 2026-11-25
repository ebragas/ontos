import { existsSync, readFileSync } from 'node:fs';
import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
} from '@modelcontextprotocol/server';
import { invariant, type ApiError, type AsyncFallible, type Fault } from '../errors/index.ts';
import type { CallTool, RouteResult } from '../handler/index.ts';
import type { JsonObject } from '../ontology/index.ts';
import { adviceOf, chooseOntology } from './chooseOntology.ts';
import { withShortNames } from './shortNames.ts';
import { TOOLS, type Tool, type ToolArgs } from './tools.ts';

const SERVER_INSTRUCTIONS = [
  'To read data, call `describe_object_type`, then `load_objects` or `aggregate_objects`.',
  'A derived Property is computed when you read it. Name it in `select`.',
  'To compute a value, such as a total, call `describe_query`, then `execute_query`.',
  'To change data, call `describe_action`, then `apply_action`.',
  'After a timeout or a lost connection, call `get_edit_history` on the Objects before you call `apply_action` again.',
].join('\n');

const SERVICE_PACKAGE_CANDIDATES = [
  new URL('../package.json', import.meta.url),
  new URL('../../package.json', import.meta.url),
];

function readServiceVersion(): string {
  let found: string | undefined;

  for (const candidate of SERVICE_PACKAGE_CANDIDATES) {
    if (!existsSync(candidate)) continue;

    const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
      readonly name?: string;
      readonly version?: string;
    };

    if (pkg.name === '@ericbragas/ontos-service' && typeof pkg.version === 'string') {
      found = pkg.version;

      break;
    }
  }

  invariant(found !== undefined, '@ericbragas/ontos-service package.json not found.');

  return found;
}

const version = readServiceVersion();

const acceptAll: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

export function createMcpServer(callTool: CallTool): McpServer {
  const server = new McpServer(
    { name: 'ontology', version },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: false } } },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<ToolArgs>(tool.inputSchema, acceptAll),
        annotations: tool.annotations,
      },
      (raw) => {
        const record: ToolArgs = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};

        const { ontology, ...args } = record;

        return callTool(
          chooseOntology({ requested: ontology, listWhenSeveral: tool.listsOntologiesFor?.(args) === true }),
          async function* (ctx): AsyncFallible<RouteResult, ApiError | Fault> {
            return yield* tool.call(yield* withShortNames(tool.shortNames, args, ctx), ctx);
          },
        ).then((result) => toolResult(result, tool));
      },
    );
  }

  return server;
}

function toolResult({ status, body }: RouteResult, tool: Tool): CallToolResult {
  const advice =
    status >= 500 ? tool.faultNote : status >= 400 ? (tool.errorNote?.(body) ?? adviceOf(body)) : undefined;

  const note = advice === undefined ? '' : `\n${advice}`;
  const structuredContent = body as JsonObject;

  return {
    content: [{ type: 'text', text: `${JSON.stringify(body)}${note}` }],
    structuredContent,
    ...(status >= 400 || tool.failed?.(structuredContent) === true ? { isError: true } : {}),
  };
}
