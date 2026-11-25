import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { closeServer, listenLocal } from '../localServer.test-utils.ts';
import { createNodeServer } from '../node.ts';
import { ONTOLOGY_RID, stored, twinFunctions, twinIr } from '../ontology/stored.test-utils.ts';
import { claimsOf, roleUsers } from '../people.test-utils.ts';
import { ACCOUNT, ENGAGEMENT, twinSplitGrants } from '../roles.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { connectV1, mcpSettings, startMcpService, type McpService } from './mcp.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

const TOOLS = 'service/ontology-mcp#tools/0433a01e';

let harness: McpService;
let server: Server;
let service: McpService;
let admin: string;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  harness = await startMcpService();

  server = createNodeServer({
    db: fallibleOf(harness.db),
    directDb: fallibleOf(harness.db),
    settings: mcpSettings,
    keys: harness.issuer.keys,
    users: roleUsers(twinSplitGrants().defaultRoles),
    workos: stubPublish(),
  });

  service = { ...harness, baseUrl: await listenLocal(server) };

  service = { ...service, url: new URL('/api/mcp', service.baseUrl) };

  const ir = twinIr('0.7.0');

  const published = await fetch(new URL('/api/ontology-service/v1/publish', service.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await service.issuer.github({ exp: now() + 3600 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      product: 'twin',
      ir,
      functions: twinFunctions('0.7.0'),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants: twinSplitGrants(),
      validateOnly: false,
    }),
  });

  if (published.status !== 200) throw new Error(`The publish gave ${published.status}: ${await published.text()}`);

  await service.db.query({
    text: "INSERT INTO ontology_1_objects.account (account_id, name, phase) VALUES ('acc-1', 'Acme', 'customer')",
    values: [],
  });

  await service.db.query({
    text: "INSERT INTO ontology_1_objects.engagement (engagement_id, account_id, title, amount, status) VALUES ('eng-1', 'acc-1', 'Renewal', 1000, 'open')",
    values: [],
  });

  admin = await service.issuer.authkit({ exp: now() + 3600, ...claimsOf('admin') });
});

afterAll(async () => {
  if (server) await closeServer(server);

  await harness?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

async function call(name: string, args: Record<string, unknown>, token?: string): Promise<CallToolResult> {
  const { client } = await connectV1(service, token === undefined ? {} : { token });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

async function route(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${service.baseUrl}/api/v2/ontologies/${ONTOLOGY_RID}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await service.issuer.workos({ exp: now() + 3600, ...claimsOf('admin') })}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() };
}

function shown(result: CallToolResult, name: string): string {
  return JSON.stringify(result)
    .replaceAll(name, '<name>')
    .replace(/"errorInstanceId":"[^"]*"/g, '"errorInstanceId":"<id>"')
    .replace(/\\"errorInstanceId\\":\\"[^"\\]*\\"/g, '\\"errorInstanceId\\":\\"<id>\\"');
}

function mcpFields(): Record<string, unknown>[] {
  return consoleLog.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => (JSON.parse(line) as { mcp?: Record<string, unknown> }).mcp)
    .filter((mcp) => mcp?.['tool'] !== undefined) as Record<string, unknown>[];
}

const base = (objectType: string) => ({ type: 'base', objectType });
const around = (objectSet: unknown, link: string) => ({ type: 'searchAround', objectSet, link });

const count = {
  type: 'selection',
  objectSet: { type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'engagements' },
  operation: { type: 'count' },
};

describe(`${TOOLS}: describe_object_type and get_edit_history take a short name`, () => {
  it(`${TOOLS}: describe_object_type gives the answer of the API name for a short name that 1 Object Type has`, async () => {
    const short = await call('describe_object_type', { objectType: 'Engagement' });

    const full = await call('describe_object_type', { objectType: ENGAGEMENT });

    expect(full.isError).toBeFalsy();
    expect(short).toEqual(full);
    expect(short.structuredContent).toMatchObject({ apiName: ENGAGEMENT, primaryKey: 'engagementId' });
  });

  it(`${TOOLS}: get_edit_history gives the answer of the API name for a short name that 1 Object Type has`, async () => {
    const short = await call('get_edit_history', { objectType: 'Engagement' });

    const full = await call('get_edit_history', { objectType: ENGAGEMENT });

    expect(full.isError).toBeFalsy();
    expect(short).toEqual(full);
  });

  it(`${TOOLS}: a name of no Object Type gives 404 ObjectTypeNotFound with the name as the agent sent it`, async () => {
    const result = await call('describe_object_type', { objectType: 'Nonesuch' });

    expect(result.isError).toBe(true);

    expect(result.structuredContent).toMatchObject({
      errorName: 'ObjectTypeNotFound',
      parameters: { objectType: 'Nonesuch' },
    });
  });

  it(`${TOOLS}: part of an API name with a dot is no short name`, async () => {
    const result = await call('describe_object_type', { objectType: 'ontology.Engagement' });

    expect(result.structuredContent).toMatchObject({
      errorName: 'ObjectTypeNotFound',
      parameters: { objectType: 'ontology.Engagement' },
    });
  });
});

describe(`${TOOLS}: load_objects and aggregate_objects take a short name in each base Object Set`, () => {
  const sets: [string, (name: string, other: string) => unknown][] = [
    ['a base', (name) => base(name)],
    [
      'a filter',
      (name) => ({ type: 'filter', objectSet: base(name), where: { type: 'eq', field: 'status', value: 'open' } }),
    ],
    ['a searchAround of a base', (_name, other) => around(base(other), 'engagements')],
    [
      'a union',
      (name) => ({
        type: 'union',
        objectSets: [
          base(name),
          { type: 'filter', objectSet: base(name), where: { type: 'eq', field: 'status', value: 'none' } },
        ],
      }),
    ],
    ['an intersect', (name) => ({ type: 'intersect', objectSets: [base(name), base(name)] })],
    [
      'a subtract',
      (name) => ({
        type: 'subtract',
        objectSets: [
          base(name),
          { type: 'filter', objectSet: base(name), where: { type: 'eq', field: 'status', value: 'none' } },
        ],
      }),
    ],
    ['a withProperties', (name) => ({ type: 'withProperties', objectSet: base(name), derivedProperties: {} })],
    [
      '3 sets down',
      (name, other) => ({
        type: 'filter',
        objectSet: { type: 'union', objectSets: [around(base(other), 'engagements'), base(name)] },
        where: { type: 'isNull', field: 'title', value: false },
      }),
    ],
  ];

  it.each(sets)(`${TOOLS}: load_objects gives the answer of the API names for %s`, async (_kind, make) => {
    const short = await call(
      'load_objects',
      { objectSet: make('Engagement', 'Account'), select: ['engagementId'] },
      admin,
    );

    const full = await call('load_objects', { objectSet: make(ENGAGEMENT, ACCOUNT), select: ['engagementId'] }, admin);

    expect(full.isError).toBeFalsy();
    expect(short).toEqual(full);
  });

  it.each(sets)(`${TOOLS}: aggregate_objects gives the answer of the API names for %s`, async (_kind, make) => {
    const request = (name: string, other: string) => ({
      objectSet: make(name, other),
      aggregation: [{ type: 'count', name: 'count' }],
    });

    const short = await call('aggregate_objects', request('Engagement', 'Account'), admin);

    const full = await call('aggregate_objects', request(ENGAGEMENT, ACCOUNT), admin);

    expect(full.isError).toBeFalsy();
    expect(short).toEqual(full);
  });

  it(`${TOOLS}: a short name in a Link traversal and in the Object Set of an aggregate gives the Objects of the API name`, async () => {
    const result = await call(
      'load_objects',
      { objectSet: around(base('Account'), 'engagements'), select: ['engagementId'] },
      admin,
    );

    expect(result.structuredContent).toMatchObject({
      totalCount: '1',
      data: [{ __apiName: ENGAGEMENT, __primaryKey: 'eng-1' }],
    });

    const aggregated = await call(
      'aggregate_objects',
      {
        objectSet: { type: 'withProperties', objectSet: base('Account'), derivedProperties: { n: count } },
        aggregation: [{ type: 'count', name: 'count' }],
      },
      admin,
    );

    expect(aggregated.structuredContent).toMatchObject({ data: [{ metrics: [{ name: 'count', value: 1 }] }] });
  });

  it(`${TOOLS}: a base of no Object Type gives 404 ObjectTypeNotFound with the name as the agent sent it`, async () => {
    const result = await call(
      'load_objects',
      { objectSet: { type: 'union', objectSets: [base('Engagement'), base('Nonesuch')] } },
      admin,
    );

    expect(result.isError).toBe(true);

    expect(result.structuredContent).toMatchObject({
      errorName: 'ObjectTypeNotFound',
      parameters: { objectType: 'Nonesuch' },
    });
  });
});

describe(`${TOOLS}: the OSDK routes take only the API name`, () => {
  it(`${TOOLS}: the metadata route and the Object Set routes refuse a short name with 404 ObjectTypeNotFound`, async () => {
    const refused = {
      status: 404,
      body: { errorName: 'ObjectTypeNotFound', parameters: { objectType: 'Engagement' } },
    };

    expect(await route('GET', '/objectTypes/Engagement')).toMatchObject(refused);

    expect(await route('POST', '/objectSets/loadObjects', { objectSet: base('Engagement') })).toMatchObject(refused);

    expect(
      await route('POST', '/objectSets/aggregate', {
        objectSet: base('Engagement'),
        aggregation: [{ type: 'count', name: 'count' }],
      }),
    ).toMatchObject(refused);

    expect(await route('POST', '/objectTypes/Engagement/editsHistory', {})).toMatchObject(refused);

    expect((await route('GET', `/objectTypes/${ENGAGEMENT}`)).status).toBe(200);
  });
});

describe(`${TOOLS}: a short name of a type that the caller cannot see`, () => {
  const MEMBER_ONLY: [string, Record<string, unknown>][] = [
    ['describe_object_type', { objectType: '@' }],
    ['get_edit_history', { objectType: '@' }],
    ['load_objects', { objectSet: base('@') }],
    [
      'load_objects',
      { objectSet: { type: 'filter', objectSet: base('@'), where: { type: 'isNull', field: 'name', value: false } } },
    ],
    ['aggregate_objects', { objectSet: base('@'), aggregation: [{ type: 'count', name: 'count' }] }],
  ];

  const named = (args: Record<string, unknown>, name: string) =>
    JSON.parse(JSON.stringify(args).replaceAll('@', name)) as Record<string, unknown>;

  it.each(MEMBER_ONLY)(
    `${TOOLS}: a member who sends the short name of Account to %s %j gets the answer of an unknown name, and an admin gets Account`,
    async (tool, args) => {
      const hidden = await call(tool, named(args, 'Account'));

      const unknown = await call(tool, named(args, 'Nonesuch'));

      expect(hidden.isError).toBe(true);
      expect(shown(hidden, 'Account')).toBe(shown(unknown, 'Nonesuch'));

      expect(hidden.structuredContent).toMatchObject({
        errorName: 'ObjectTypeNotFound',
        parameters: { objectType: 'Account' },
      });

      const seen = await call(tool, named(args, 'Account'), admin);

      expect(seen.isError).toBeFalsy();
    },
  );

  it(`${TOOLS}: a member who sends the API name of Account gets the answer of an unknown API name`, async () => {
    const hidden = await call('describe_object_type', { objectType: ACCOUNT });

    const unknown = await call('describe_object_type', { objectType: 'com.example.twin.Nonesuch' });

    expect(shown(hidden, 'Account')).toBe(shown(unknown, 'Nonesuch'));
  });
});

describe(`${TOOLS}: the request log holds the API name of the tool call`, () => {
  it.each([
    ['describe_object_type', 'Engagement'],
    ['describe_object_type', ENGAGEMENT],
    ['get_edit_history', 'Engagement'],
    ['get_edit_history', ENGAGEMENT],
  ])(`${TOOLS}: %s with %s gives the field mcp.apiName of the API name`, async (tool, name) => {
    await call(tool, { objectType: name });

    expect(mcpFields()).toEqual([expect.objectContaining({ method: 'tools/call', tool, apiName: ENGAGEMENT })]);
  });

  it(`${TOOLS}: a name of no Object Type stays in mcp.apiName as the agent sent it`, async () => {
    await call('describe_object_type', { objectType: 'Nonesuch' });

    expect(mcpFields()).toEqual([expect.objectContaining({ tool: 'describe_object_type', apiName: 'Nonesuch' })]);
  });

  it(`${TOOLS}: a tool with an Object Set has no mcp.apiName`, async () => {
    await call('load_objects', { objectSet: base('Engagement') });

    expect(mcpFields()).toEqual([expect.not.objectContaining({ apiName: expect.anything() })]);
  });
});
