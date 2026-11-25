import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db/promise.test-utils.ts';
import type { FaultFields, ReportFault } from '../handler/index.ts';
import { NS, ONTOLOGY_RID } from '../ontology/stored.test-utils.ts';
import { insertObjects } from '../publish/publish.test-utils.ts';
import { MCP_CLIENT, PERSON } from '../tokens.test-utils.ts';
import {
  connectV1,
  connectV2,
  mcpSettings,
  recordingFetch,
  startMcpService,
  type Exchange,
  type McpService,
} from './mcp.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

let service: McpService;
let faulty: McpService;
let cut: McpService;
let reported: [unknown, FaultFields][];

const ACCOUNT = 'com.example.twin.Account';
const LOAD_OBJECTS = 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects';
const ENGAGEMENT = `${NS}Engagement`;

function failingStreams(db: Db): Db {
  return {
    query: (sql) => db.query(sql),
    stream: () => {
      throw new Error('the database failed');
    },
    transaction: (run) => db.transaction(run),
    snapshot: (run) => db.snapshot(run),
  };
}

function streamsCutAfterFirstRow(db: Db): Db {
  return {
    ...failingStreams(db),
    async *stream<Row extends object>(sql: Parameters<Db['stream']>[0]) {
      for await (const row of db.stream<Row>(sql)) {
        yield row;

        throw new Error('the connection ended');
      }
    },
  };
}

beforeAll(async () => {
  service = await startMcpService();

  reported = [];

  const reportFault: ReportFault = (error, fields) => void reported.push([error, fields]);

  const baseUrl = await service.serve(mcpSettings, { db: fallibleOf(failingStreams(service.db)), reportFault });

  faulty = { ...service, baseUrl, url: new URL('/api/mcp', baseUrl) };

  const cutUrl = await service.serve(mcpSettings, { db: fallibleOf(streamsCutAfterFirstRow(service.db)), reportFault });

  cut = { ...service, baseUrl: cutUrl, url: new URL('/api/mcp', cutUrl) };
});

afterAll(() => service?.stop());

let consoleLog: MockInstance<typeof console.log>;

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');

  reported.length = 0;
});

afterEach(() => consoleLog.mockRestore());

function lines(): Record<string, unknown>[] {
  return consoleLog.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface Called {
  readonly result: CallToolResult;
  readonly exchanges: Exchange[];
}

async function call(target: McpService, name: string, args: Record<string, unknown>): Promise<Called> {
  const exchanges: Exchange[] = [];

  const { client } = await connectV1(target, { fetch: recordingFetch(exchanges) });

  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;

    return { result, exchanges };
  } finally {
    await client.close();
  }
}

interface ErrorBody {
  readonly errorCode: string;
  readonly errorName: string;
  readonly errorInstanceId: string;
  readonly parameters: Record<string, unknown>;
}

function errorOf(result: CallToolResult): ErrorBody {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);

  const [block] = result.content as { type: string; text: string }[];

  expect(block?.type).toBe('text');
  expect(JSON.parse(block?.text ?? '')).toEqual(result.structuredContent);

  const body = result.structuredContent;

  if (!isErrorBody(body)) throw new Error('The structuredContent is not an error body.');

  return body;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'errorCode' in value &&
    typeof value.errorCode === 'string' &&
    'errorName' in value &&
    typeof value.errorName === 'string' &&
    'errorInstanceId' in value &&
    typeof value.errorInstanceId === 'string' &&
    'parameters' in value &&
    typeof value.parameters === 'object' &&
    value.parameters !== null
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('service/ontology-mcp#errors: each error of a tool call is an isError result at HTTP 200', () => {
  it('service/ontology-mcp#errors service/code-layout#libraries: a bad tool argument gets the OSDK error of its route, with its errorInstanceId', async () => {
    const { result, exchanges } = await call(service, 'load_objects', {
      objectSet: { type: 'base', objectType: ACCOUNT },
      pageSize: 'ten',
    });

    expect(exchanges.filter((exchange) => exchange.rpc === 'tools/call').map((exchange) => exchange.status)).toEqual([
      200,
    ]);

    const error = errorOf(result);

    expect(error).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.stringMatching(UUID),
      parameters: { field: 'pageSize' },
    });
  });

  it('service/ontology-mcp#errors service/code-layout#libraries: an unknown Object Type gets the 404 of its route as isError', async () => {
    const { result, exchanges } = await call(service, 'describe_object_type', { objectType: 'Nope' });

    expect(exchanges.filter((exchange) => exchange.rpc === 'tools/call').map((exchange) => exchange.status)).toEqual([
      200,
    ]);

    expect(errorOf(result)).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'ObjectTypeNotFound',
      errorInstanceId: expect.stringMatching(UUID),
      parameters: { objectType: 'Nope' },
    });
  });

  it('service/ontology-mcp#errors: a fault of the route gets 500 Default:Internal as isError, at HTTP 200', async () => {
    const { result, exchanges } = await call(faulty, 'load_objects', {
      objectSet: { type: 'base', objectType: ACCOUNT },
    });

    expect(exchanges.filter((exchange) => exchange.rpc === 'tools/call').map((exchange) => exchange.status)).toEqual([
      200,
    ]);

    expect(errorOf(result)).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'Default:Internal',
      errorInstanceId: expect.stringMatching(UUID),
      parameters: {},
    });
  });
});

describe('service/ontology-mcp#errors: a fault in a tool call stays a fault', () => {
  it('a failed Ontology list gives a tool error, one fault report, and the same error ID without an Ontology version', async () => {
    const failure = new Error('the Ontology list failed');
    let failListing = false;

    const db: Db = {
      ...service.db,
      query: (sql) => {
        if (
          failListing &&
          sql.text.startsWith(
            'SELECT rid, api_name, display_name FROM ontology_registry.ontologies WHERE organization = ',
          )
        )
          throw failure;

        return service.db.query(sql);
      },
    };

    const baseUrl = await service.serve(mcpSettings, {
      db: fallibleOf(db),
      reportFault: (error, fields) => void reported.push([error, fields]),
    });

    const target = { ...service, baseUrl, url: new URL('/api/mcp', baseUrl) };
    const exchanges: Exchange[] = [];

    const { client } = await connectV1(target, { fetch: recordingFetch(exchanges) });

    try {
      expect((await client.listTools()).tools).toHaveLength(8);

      expect(reported).toEqual([]);

      failListing = true;

      const result = (await client.callTool({
        name: 'load_objects',
        arguments: { objectSet: { type: 'base', objectType: ACCOUNT } },
      })) as CallToolResult;

      expect(exchanges.filter((exchange) => exchange.rpc === 'tools/call').map((exchange) => exchange.status)).toEqual([
        200,
      ]);

      const body = errorOf(result);

      expect(body).toEqual({
        errorCode: 'INTERNAL',
        errorName: 'Default:Internal',
        errorInstanceId: expect.stringMatching(UUID),
        parameters: {},
      });

      expect(reported).toEqual([
        [
          failure,
          {
            errorInstanceId: body.errorInstanceId,
            errorName: 'Default:Internal',
            route: 'POST /api/mcp',
            userId: PERSON,
            callerKind: 'person',
            mcp: { method: 'tools/call', tool: 'load_objects', clientId: MCP_CLIENT },
          },
        ],
      ]);

      expect(lines().find((line) => line['errorInstanceId'] === body.errorInstanceId)).toEqual({
        userId: PERSON,
        callerKind: 'person',
        mcp: { method: 'tools/call', tool: 'load_objects', clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
        errorInstanceId: body.errorInstanceId,
        route: 'POST /api/mcp',
        routeParams: {},
        errorName: 'Default:Internal',
        parameters: {},
        stack: expect.stringContaining('the Ontology list failed'),
      });
    } finally {
      await client.close();
    }
  });

  it('service/ontology-mcp#errors service/observability#error-reports service/code-layout#seams: a 5xx in a tool call gives 1 fault report, with the mcp tags, and the error fields in the request log', async () => {
    const { result } = await call(faulty, 'load_objects', { objectSet: { type: 'base', objectType: ACCOUNT } });

    const { errorInstanceId } = errorOf(result);

    expect(reported).toHaveLength(1);

    const [error, fields] = reported[0] ?? [];

    expect(error).toEqual(new Error('the database failed'));

    expect(fields).toEqual({
      errorInstanceId,
      errorName: 'Default:Internal',
      route: LOAD_OBJECTS,
      ontologyVersion: 1,
      userId: PERSON,
      callerKind: 'person',
      mcp: { method: 'tools/call', tool: 'load_objects', clientId: MCP_CLIENT },
    });

    const line = lines().find((candidate) => candidate['errorInstanceId'] === errorInstanceId);

    expect(line).toEqual({
      userId: PERSON,
      callerKind: 'person',
      ontologyVersion: 1,
      mcp: { method: 'tools/call', tool: 'load_objects', clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
      errorInstanceId,
      route: LOAD_OBJECTS,
      routeParams: { ontology: ONTOLOGY_RID },
      errorName: 'Default:Internal',
      parameters: {},
      stack: expect.stringContaining('the database failed'),
    });
  });

  it('service/observability#error-reports: a route body that a fault ends after its first row gives 1 fault report, with its errorInstanceId', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      { engagementId: 'e-1', accountId: 'a', title: 't1', amount: 1, status: 's1', createdAt: null },
      { engagementId: 'e-2', accountId: 'a', title: 't2', amount: 2, status: 's2', createdAt: null },
    ]);

    const { result } = await call(cut, 'load_objects', { objectSet: { type: 'base', objectType: ENGAGEMENT } });

    const { errorInstanceId } = errorOf(result);

    expect(errorInstanceId).toMatch(UUID);

    expect(reported).toEqual([
      [
        new Error('the connection ended'),
        expect.objectContaining({ errorInstanceId, errorName: 'Default:Internal', route: LOAD_OBJECTS }),
      ],
    ]);
  });

  it('service/observability#error-reports: a 4xx of a tool call gives no report, and keeps the error fields in the request log', async () => {
    const { result } = await call(service, 'describe_object_type', { objectType: 'Nope' });

    const { errorInstanceId } = errorOf(result);

    expect(reported).toEqual([]);

    const line = lines().find((candidate) => candidate['errorInstanceId'] === errorInstanceId);

    expect(line).toEqual({
      userId: PERSON,
      callerKind: 'person',
      ontologyVersion: 1,
      mcp: {
        method: 'tools/call',
        tool: 'describe_object_type',
        apiName: 'Nope',
        clientId: MCP_CLIENT,
        protocolVersion: '2025-11-25',
      },
      errorInstanceId,
      route: 'POST /api/mcp',
      routeParams: {},
      errorName: 'ObjectTypeNotFound',
      parameters: { objectType: 'Nope' },
      stack: expect.stringContaining('ObjectTypeNotFound'),
    });
  });
});

describe('service/observability#logs: the request log of the MCP route', () => {
  it('service/observability#logs: writes 1 line for each POST, with the mcp field of each JSON-RPC message', async () => {
    const { exchanges } = await call(service, 'describe_object_type', { objectType: ACCOUNT });

    const posts = exchanges.filter((exchange) => exchange.method === 'POST');

    expect(posts.map((exchange) => exchange.rpc)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);

    const mcpLines = lines().filter((line) => line['mcp'] !== undefined);

    expect(mcpLines).toHaveLength(posts.length + 1);

    expect(mcpLines.map((line) => line['mcp'])).toEqual(
      expect.arrayContaining([
        { method: 'initialize', clientId: MCP_CLIENT },
        { method: 'notifications/initialized', clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
        {
          method: 'tools/call',
          tool: 'describe_object_type',
          apiName: ACCOUNT,
          clientId: MCP_CLIENT,
          protocolVersion: '2025-11-25',
        },
        { clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
      ]),
    );

    const callLine = mcpLines.find((line) => (line['mcp'] as { method?: string }).method === 'tools/call');

    expect(callLine).toEqual({
      userId: PERSON,
      callerKind: 'person',
      ontologyVersion: 1,
      mcp: {
        method: 'tools/call',
        tool: 'describe_object_type',
        apiName: ACCOUNT,
        clientId: MCP_CLIENT,
        protocolVersion: '2025-11-25',
      },
    });
  });

  it('service/observability#logs: a tools/call of the 2026-07-28 revision has the same mcp field, with its protocol version', async () => {
    const client = await connectV2(service, { pin: '2026-07-28' });

    try {
      await client.callTool({ name: 'get_edit_history', arguments: { objectType: ACCOUNT } });
    } finally {
      await client.close();
    }

    const calls = lines()
      .map((line) => line['mcp'])
      .filter((mcp) => (mcp as { method?: string } | undefined)?.method === 'tools/call');

    expect(calls).toEqual([
      {
        method: 'tools/call',
        tool: 'get_edit_history',
        apiName: ACCOUNT,
        clientId: MCP_CLIENT,
        protocolVersion: '2026-07-28',
      },
    ]);
  });

  it('service/observability#logs: tools/list has no tool and no apiName, and a tool with no Object Type argument has no apiName', async () => {
    const { client } = await connectV1(service);

    try {
      await client.listTools();

      await client.callTool({ name: 'describe_object_type', arguments: {} });

      await client.callTool({
        name: 'aggregate_objects',
        arguments: {
          objectSet: { type: 'base', objectType: ACCOUNT },
          aggregation: [{ type: 'count', name: 'count' }],
        },
      });

      await client.callTool({ name: 'get_edit_history', arguments: { objectType: ACCOUNT } });
    } finally {
      await client.close();
    }

    const methods = lines()
      .map((line) => line['mcp'])
      .filter(
        (mcp): mcp is Record<string, unknown> => mcp !== undefined && (mcp as { method?: string }).method !== undefined,
      );

    expect(methods.slice(2)).toEqual([
      { method: 'tools/list', clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
      { method: 'tools/call', tool: 'describe_object_type', clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
      { method: 'tools/call', tool: 'aggregate_objects', clientId: MCP_CLIENT, protocolVersion: '2025-11-25' },
      {
        method: 'tools/call',
        tool: 'get_edit_history',
        apiName: ACCOUNT,
        clientId: MCP_CLIENT,
        protocolVersion: '2025-11-25',
      },
    ]);
  });
});
