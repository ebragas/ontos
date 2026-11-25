import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ONTOLOGY_RID } from '../ontology/stored.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import {
  connectV1,
  connectV2,
  recordingFetch,
  startMcpService,
  type Exchange,
  type McpService,
} from './mcp.test-utils.ts';

let service: McpService;

const ACCOUNT = 'com.example.twin.Account';
const ACCOUNTS = 52;

beforeAll(async () => {
  service = await startMcpService();

  const values = Array.from({ length: ACCOUNTS }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');

    return `('acc-${n}', 'Account ${n}', '${index % 2 === 0 ? 'active' : 'closed'}', ${index % 2 === 0})`;
  });

  await service.db.query({
    text: `INSERT INTO ontology_1_objects.account (account_id, name, phase, active) VALUES ${values.join(', ')}`,
    values: [],
  });
});

afterAll(() => service?.stop());

async function route(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const token = await service.issuer.workos({ exp: now() + 3600 });

  const response = await fetch(`${service.baseUrl}/api/v2/ontologies/${ONTOLOGY_RID}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() };
}

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { client } = await connectV1(service);

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function text(result: CallToolResult): unknown {
  expect(result.content).toHaveLength(1);

  const [block] = result.content;

  expect(block?.type).toBe('text');

  return JSON.parse((block as { text: string }).text);
}

const base = { type: 'base', objectType: ACCOUNT };

describe('service/ontology-mcp#tools: tools/list', () => {
  it('service/ontology-mcp#tools: lists the 4 read tools with plain names and readOnlyHint', async () => {
    const { client } = await connectV1(service);

    try {
      const { tools } = await client.listTools();

      const read = tools.filter((tool) =>
        ['describe_object_type', 'load_objects', 'aggregate_objects', 'get_edit_history'].includes(tool.name),
      );

      expect(read.map((tool) => [tool.name, tool.annotations])).toEqual([
        ['describe_object_type', { readOnlyHint: true }],
        ['load_objects', { readOnlyHint: true }],
        ['aggregate_objects', { readOnlyHint: true }],
        ['get_edit_history', { readOnlyHint: true }],
      ]);

      for (const tool of read) expect(tool.outputSchema).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('service/ontology-mcp#tools: each input schema types the top level, and the Object Set schema types the 7 kinds, leaves where and derivedProperties open, and gives 1 example', async () => {
    const { client } = await connectV1(service);

    try {
      const { tools } = await client.listTools();

      const schema = (name: string) =>
        tools.find((tool) => tool.name === name)?.inputSchema as {
          properties: Record<string, unknown>;
          required?: string[];
          $defs?: Record<string, unknown>;
        };

      expect(Object.keys(schema('describe_object_type').properties)).toEqual(['ontology', 'objectType']);
      expect(schema('describe_object_type').required).toBeUndefined();

      expect(Object.keys(schema('load_objects').properties)).toEqual([
        'ontology',
        'objectSet',
        'select',
        'orderBy',
        'pageSize',
        'pageToken',
      ]);

      expect(schema('load_objects').required).toEqual(['objectSet']);

      expect(Object.keys(schema('aggregate_objects').properties)).toEqual([
        'ontology',
        'objectSet',
        'aggregation',
        'groupBy',
      ]);

      expect(schema('aggregate_objects').required).toEqual(['objectSet', 'aggregation']);

      expect(Object.keys(schema('get_edit_history').properties)).toEqual([
        'ontology',
        'objectType',
        'objectPrimaryKey',
        'filters',
        'sortOrder',
        'pageSize',
        'pageToken',
      ]);

      expect(schema('get_edit_history').required).toEqual(['objectType']);

      expect(schema('get_edit_history').properties['filters']).toEqual({
        description:
          'One filter: a timestampFilter with an optional startTime and endTime, or an operationIdsFilter with Action IDs in operationIds, such as {"type":"timestampFilter","startTime":"2026-10-20T11:00:00Z"}.',
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'timestampFilter' },
              startTime: { type: 'string', description: 'A timestamp. The entries at or after it.' },
              endTime: { type: 'string', description: 'A timestamp. The entries at or before it.' },
            },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'operationIdsFilter' },
              operationIds: { type: 'array', items: { type: 'string' }, description: 'The Action IDs.' },
            },
            required: ['type', 'operationIds'],
          },
        ],
      });

      expect(schema('load_objects').properties['select']).toEqual({
        type: 'array',
        items: { type: 'string' },
        description: 'The Property API names to load. Name only the Properties that you need.',
      });

      const objectSet = schema('load_objects').$defs?.['objectSet'] as {
        description: string;
        oneOf: { properties: { type: { const: string }; where?: unknown } }[];
      };

      expect(schema('load_objects').properties['objectSet']).toEqual({ $ref: '#/$defs/objectSet' });
      expect(schema('aggregate_objects').$defs?.['objectSet']).toEqual(objectSet);

      expect(objectSet.oneOf.map((kind) => kind.properties.type.const)).toEqual([
        'base',
        'filter',
        'union',
        'intersect',
        'subtract',
        'searchAround',
        'withProperties',
      ]);

      expect(objectSet.oneOf[6]?.properties).toMatchObject({ derivedProperties: { type: 'object' } });

      expect(objectSet.oneOf[1]?.properties.where).toEqual({
        type: 'object',
        description: 'A where clause of the Ontology HTTP API, such as {"type":"eq","field":"phase","value":"active"}.',
      });

      expect(objectSet.description).toBe(
        'An Object Set of the Ontology HTTP API. Example: {"type":"filter","objectSet":{"type":"base","objectType":"Account"},"where":{"type":"eq","field":"phase","value":"active"}}. A Link traversal is a searchAround. A lookup by primary key is a filter on the primary key Property.',
      );
    } finally {
      await client.close();
    }
  });
});

describe('service/ontology-mcp#tools: load_objects', () => {
  it('service/ontology-mcp#tools/63cfeb50 service/ontology-mcp#security service/code-layout#modules: a page with select and orderBy equals the answer of POST .../objectSets/loadObjects for the same body', async () => {
    const body = {
      objectSet: base,
      select: ['accountId', 'phase'],
      orderBy: { fields: [{ field: 'accountId', direction: 'desc' }] },
      pageSize: 100,
    };

    const result = await call('load_objects', body);

    const answer = await route('POST', '/objectSets/loadObjects', body);

    expect(answer.status).toBe(200);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(answer.body);
    expect(text(result)).toEqual(answer.body);

    const page = result.structuredContent as {
      totalCount: string;
      nextPageToken?: string;
      data: { accountId: string; phase: string }[];
    };

    expect(page.totalCount).toBe('52');
    expect(page.nextPageToken).toBeUndefined();
    expect(page.data).toHaveLength(52);

    expect(page.data[0]).toEqual({
      __rid: expect.any(String),
      __primaryKey: 'acc-52',
      __apiName: ACCOUNT,
      accountId: 'acc-52',
      phase: 'closed',
    });
  });

  it('service/ontology-mcp#tools: with no pageSize, loads 50 Objects and gives the nextPageToken of the route', async () => {
    const result = await call('load_objects', { objectSet: base, select: ['accountId'] });

    const page = result.structuredContent as {
      totalCount: string;
      nextPageToken?: string;
      data: { accountId: string }[];
    };

    expect(page.data).toHaveLength(50);
    expect(page.data.at(-1)?.accountId).toBe('acc-50');
    expect(typeof page.nextPageToken).toBe('string');

    const next = await call('load_objects', { objectSet: base, select: ['accountId'], pageToken: page.nextPageToken });

    expect(
      (next.structuredContent as { data: { accountId: string }[] }).data.map((object) => object.accountId),
    ).toEqual(['acc-51', 'acc-52']);
  });

  it('service/ontology-mcp#tools: with a null pageSize, loads 50 Objects, the same as with no pageSize', async () => {
    const result = await call('load_objects', { objectSet: base, select: ['accountId'], pageSize: null });

    expect(result.isError).toBeFalsy();

    const page = result.structuredContent as { nextPageToken?: string; data: { accountId: string }[] };

    expect(page.data).toHaveLength(50);
    expect(page.data.at(-1)?.accountId).toBe('acc-50');
    expect(typeof page.nextPageToken).toBe('string');
  });

  it('service/ontology-mcp#tools: a filter Object Set with a where clause loads the matching Objects', async () => {
    const objectSet = { type: 'filter', objectSet: base, where: { type: 'eq', field: 'phase', value: 'closed' } };

    const result = await call('load_objects', { objectSet, select: ['accountId'] });

    const page = result.structuredContent as { totalCount: string; data: { accountId: string }[] };

    expect(page.totalCount).toBe('26');
    expect(page.data.map((object) => object.accountId).slice(0, 3)).toEqual(['acc-02', 'acc-04', 'acc-06']);
  });
});

describe('service/ontology-mcp#tools: aggregate_objects', () => {
  it('service/ontology-mcp#tools/63cfeb50 service/ontology-mcp#security: a count by phase equals the answer of POST .../objectSets/aggregate for the same body', async () => {
    const body = {
      objectSet: base,
      aggregation: [{ type: 'count', name: 'count' }],
      groupBy: [{ type: 'exact', field: 'phase' }],
    };

    const result = await call('aggregate_objects', body);

    const answer = await route('POST', '/objectSets/aggregate', body);

    expect(answer.status).toBe(200);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(answer.body);
    expect(text(result)).toEqual(answer.body);

    expect(result.structuredContent).toEqual({
      accuracy: 'ACCURATE',
      data: [
        { group: { phase: 'active' }, metrics: [{ name: 'count', value: 26 }] },
        { group: { phase: 'closed' }, metrics: [{ name: 'count', value: 26 }] },
      ],
      excludedItems: 0,
    });
  });
});

describe('service/ontology-mcp#tools: get_edit_history', () => {
  it('service/ontology-mcp#tools/63cfeb50: the history of an Object Type with history off is an empty page, equal to the answer of POST .../objectTypes/{objectType}/editsHistory', async () => {
    const result = await call('get_edit_history', { objectType: ACCOUNT });

    const answer = await route('POST', `/objectTypes/${ACCOUNT}/editsHistory`, { pageSize: 50 });

    expect(answer.status).toBe(200);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ data: [], totalCount: 0 });
    expect(result.structuredContent).toEqual(answer.body);
    expect(text(result)).toEqual(answer.body);
  });

  it('service/ontology-mcp#tools: the history of 1 Object, with objectPrimaryKey and sortOrder, is an empty page too', async () => {
    const result = await call('get_edit_history', {
      objectType: ACCOUNT,
      objectPrimaryKey: { accountId: 'acc-01' },
      sortOrder: 'oldest_first',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ data: [], totalCount: 0 });
  });
});

describe('service/testing#mcp-tests: a client of each protocol revision calls a tool', () => {
  const posts = (exchanges: Exchange[]) =>
    exchanges.filter((exchange) => exchange.method === 'POST' && exchange.rpc === 'tools/call');

  it('service/testing#mcp-tests service/ontology-mcp#route: the 2025-11-25 client calls describe_object_type, and gets a JSON answer', async () => {
    const exchanges: Exchange[] = [];

    const { client } = await connectV1(service, { fetch: recordingFetch(exchanges) });

    try {
      const result = (await client.callTool({ name: 'describe_object_type', arguments: {} })) as CallToolResult;

      expect(Object.keys((result.structuredContent as { objectTypes: object }).objectTypes)).toHaveLength(3);
    } finally {
      await client.close();
    }

    expect(posts(exchanges).map((exchange) => [exchange.status, exchange.contentType])).toEqual([
      [200, 'application/json'],
    ]);
  });

  it('service/testing#mcp-tests service/ontology-mcp#route: the 2026-07-28 client calls describe_object_type, and gets a JSON answer', async () => {
    const exchanges: Exchange[] = [];

    const client = await connectV2(service, { pin: '2026-07-28', fetch: recordingFetch(exchanges) });

    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

      const result = (await client.callTool({
        name: 'describe_object_type',
        arguments: { objectType: ACCOUNT },
      })) as CallToolResult;

      expect((result.structuredContent as { apiName: string }).apiName).toBe(ACCOUNT);
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    expect(posts(exchanges).map((exchange) => [exchange.status, exchange.contentType])).toEqual([
      [200, 'application/json'],
    ]);
  });
});
