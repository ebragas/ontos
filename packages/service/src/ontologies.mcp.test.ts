import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from 'node:http';
import { createNodeServer } from './node.ts';
import { installOntology } from './install.test-utils.ts';
import { twinGrants } from './ontology/stored.test-utils.ts';
import { now, ORGANIZATION, OTHER_ORGANIZATION, PERSON } from './tokens.test-utils.ts';
import { STUB_PERSON, stubPublish, stubUsers } from './workos.test-utils.ts';
import {
  connectV1,
  connectV2,
  mcpSettings,
  recordingFetch,
  startMcpService,
  type Exchange,
  type McpService,
} from './mcp/mcp.test-utils.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

const SEVERAL = OTHER_ORGANIZATION;
const EMPTY = 'org_01TEST0RG00000000000000003';
const GROWING = 'org_01TEST0RG00000000000000004';
const SAME_NAME = 'org_01TEST0RG00000000000000005';

const ALPHA_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-00000000000a';
const BETA_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-00000000000b';
const SAME_NAME_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-00000000000e';

const NS = 'com.example.twin.';
const ACCOUNT = `${NS}Account`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const BASE = { type: 'base', objectType: ACCOUNT };

const NO_ORGANIZATION = 'Your sign-in has no Organization. Join or create an Organization, then sign in again.';
const NO_ONTOLOGY = 'Your Organization has no Ontology. An admin of your Organization must install one.';

const CHOOSE =
  'Your Organization has more than 1 Ontology. Call this tool again, and set `ontology` to 1 of the API names in `parameters.ontologies`.';

const UNKNOWN =
  'Your Organization has no Ontology with this API name. Call this tool again, and set `ontology` to 1 of the API names in `parameters.ontologies`.';

function everyTool(accountId: string): readonly (readonly [string, Record<string, unknown>])[] {
  return [
    ['describe_object_type', { objectType: ACCOUNT }],
    ['load_objects', { objectSet: BASE, select: ['accountId'] }],
    ['aggregate_objects', { objectSet: BASE, aggregation: [{ type: 'count', name: 'count' }] }],
    ['get_edit_history', { objectType: ACCOUNT }],
    ['describe_action', { actionType: SET_ACCOUNT_PHASE }],
    [
      'apply_action',
      { action: SET_ACCOUNT_PHASE, parameters: { objectToModifyParameter: accountId, phase: 'renewed' } },
    ],
  ];
}

const TOOLS = everyTool('acc-twin');

const ORGANIZATIONS = [ORGANIZATION, SEVERAL, EMPTY, GROWING, SAME_NAME];

let harness: McpService;
let service: McpService;
let server: Server | undefined;

beforeAll(async () => {
  harness = await startMcpService();

  const member = twinGrants('0.7.0').defaultRoles['member'] ?? [];

  const users = stubUsers(
    [STUB_PERSON],
    ORGANIZATIONS.map((organization) => ({
      user_id: PERSON,
      organization_id: organization,
      status: 'active',
      organization_name: 'Test Organization',
      roles: ['member'],
    })),
    { roles: Object.fromEntries(ORGANIZATIONS.map((organization) => [organization, { member }])) },
  );

  server = createNodeServer({
    db: fallibleOf(harness.db),
    directDb: fallibleOf(harness.db),
    settings: mcpSettings,
    keys: harness.issuer.keys,
    users,
    workos: stubPublish(),
  });

  service = { ...harness, url: new URL('/api/mcp', await listenLocal(server)) };

  await installOntology(service.db, {
    rid: ALPHA_RID,
    product: 'twin',
    apiName: 'alpha',
    displayName: 'The alpha Ontology',
    organization: SEVERAL,
  });

  await installOntology(service.db, {
    rid: BETA_RID,
    product: 'twin',
    apiName: 'beta',
    displayName: 'The beta Ontology',
    organization: SEVERAL,
  });

  await installOntology(service.db, {
    rid: SAME_NAME_RID,
    product: 'twin',
    apiName: 'alpha',
    displayName: 'The other alpha Ontology',
    organization: SAME_NAME,
  });

  for (const [schema, id] of [
    ['ontology_1_objects', 'acc-twin'],
    ['ontology_2_objects', 'acc-alpha'],
    ['ontology_3_objects', 'acc-beta'],
    ['ontology_4_objects', 'acc-same-name'],
  ] as const) {
    await service.db.query({
      text: `INSERT INTO ${schema}.account (account_id, name, phase) VALUES ($1, 'Acme', 'customer')`,
      values: [id],
    });
  }
});

afterAll(async () => {
  if (server) await closeServer(server);

  await harness?.stop();
});

let consoleLog: MockInstance<typeof console.log>;

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

function lines(): Record<string, unknown>[] {
  return consoleLog.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function tokenOf(organization: string | undefined): Promise<string> {
  return service.issuer.authkit({ exp: now() + 3600, org_id: organization });
}

interface Called {
  readonly result: CallToolResult;
  readonly statuses: readonly number[];
}

async function call(organization: string | undefined, name: string, args: Record<string, unknown>): Promise<Called> {
  const exchanges: Exchange[] = [];

  const { client } = await connectV1(service, { token: await tokenOf(organization), fetch: recordingFetch(exchanges) });

  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;

    return {
      result,
      statuses: exchanges.filter((exchange) => exchange.rpc === 'tools/call').map((exchange) => exchange.status),
    };
  } finally {
    await client.close();
  }
}

interface ToolError {
  readonly body: unknown;
  readonly note: string;
}

function toolError({ result, statuses }: Called): ToolError {
  expect(statuses).toEqual([200]);
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);

  const [block] = result.content as { type: string; text: string }[];
  const newline = (block?.text ?? '').indexOf('\n');

  expect(JSON.parse((block?.text ?? '').slice(0, newline))).toEqual(result.structuredContent);

  return { body: result.structuredContent, note: (block?.text ?? '').slice(newline + 1) };
}

const UUID = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) as unknown;

function loadedIds({ result }: Called): unknown {
  expect(result.isError).toBeUndefined();

  return (result.structuredContent as { data: { accountId: string }[] }).data.map((object) => object.accountId);
}

describe('service/ontology-mcp#tools: each tool takes an optional ontology, with the rule of the CLI', () => {
  it('service/ontology-mcp#tools: tools/list gives each of the 8 tools an ontology string that is not required', async () => {
    const { client } = await connectV1(service);

    try {
      const { tools } = await client.listTools();

      expect(
        tools.map((tool) => [
          tool.name,
          (tool.inputSchema.properties?.['ontology'] as { type?: string } | undefined)?.type,
          tool.inputSchema.required?.includes('ontology') ?? false,
        ]),
      ).toEqual([
        ['describe_object_type', 'string', false],
        ['load_objects', 'string', false],
        ['aggregate_objects', 'string', false],
        ['describe_query', 'string', false],
        ['execute_query', 'string', false],
        ['get_edit_history', 'string', false],
        ['describe_action', 'string', false],
        ['apply_action', 'string', false],
      ]);
    } finally {
      await client.close();
    }
  });

  it.each(TOOLS)('service/ontology-mcp#tools: with 1 Ontology and no ontology, %s uses it', async (name, args) => {
    const { result, statuses } = await call(ORGANIZATION, name, args);

    expect(statuses).toEqual([200]);
    expect(result.isError).toBeUndefined();
  });

  it.each(TOOLS)('service/ontology-mcp#tools: with 1 Ontology, %s also takes its apiName', async (name, args) => {
    const { result } = await call(ORGANIZATION, name, { ...args, ontology: 'twin' });

    expect(result.isError).toBeUndefined();
  });

  it.each(TOOLS)(
    'service/ontology-mcp#tools service/ontology-mcp#errors: with more than 1 Ontology and no ontology, %s gives a tool error that lists the API names',
    async (name, args) => {
      expect(toolError(await call(SEVERAL, name, args))).toEqual({
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'OntologyService:OntologyRequired',
          errorInstanceId: UUID,
          parameters: { ontologies: ['alpha', 'beta'] },
        },
        note: CHOOSE,
      });
    },
  );

  it.each(TOOLS)('service/ontology-mcp#tools: with more than 1 Ontology, %s takes the apiName', async (name, args) => {
    const accountId = 'acc-beta';

    const withId =
      name === 'apply_action'
        ? { ...args, parameters: { objectToModifyParameter: accountId, phase: 'renewed' } }
        : args;

    const { result } = await call(SEVERAL, name, { ...withId, ontology: 'beta' });

    expect(result.isError).toBeUndefined();
  });

  it.each([...TOOLS, ['describe_object_type', {}] as const])(
    'service/ontology-mcp#tools service/ontology-mcp#errors: with no Ontology, %s gives a tool error that says an admin must install one',
    async (name, args) => {
      expect(toolError(await call(EMPTY, name, args))).toEqual({
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'OntologyService:NoOntologyInstalled',
          errorInstanceId: UUID,
          parameters: {},
        },
        note: NO_ONTOLOGY,
      });
    },
  );

  it('service/ontology-mcp#tools service/ontology-mcp#errors service/http-api#errors: an apiName that the Organization does not have gives a tool error with its own API names', async () => {
    expect(toolError(await call(SEVERAL, 'load_objects', { objectSet: BASE, ontology: 'gamma' }))).toEqual({
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'OntologyNotFound',
        errorInstanceId: UUID,
        parameters: { apiName: 'gamma', ontologies: ['alpha', 'beta'] },
      },
      note: UNKNOWN,
    });
  });

  it.each([
    [7, '7'],
    [true, 'true'],
    [false, 'false'],
    [['alpha'], '["alpha"]'],
    [[], '[]'],
    [{ apiName: 'alpha' }, '{"apiName":"alpha"}'],
  ] as const)(
    'service/ontology-mcp#tools service/ontology-mcp#errors: an ontology of %j is not an API name, so it gets the tool error of an unknown apiName',
    async (ontology, apiName) => {
      expect(toolError(await call(SEVERAL, 'load_objects', { objectSet: BASE, ontology }))).toEqual({
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'OntologyNotFound',
          errorInstanceId: UUID,
          parameters: { apiName, ontologies: ['alpha', 'beta'] },
        },
        note: UNKNOWN,
      });
    },
  );

  it.each(TOOLS)(
    'service/ontology-mcp#tools service/ontology-mcp#errors: %s does not take an array that holds an apiName',
    async (name, args) => {
      expect(toolError(await call(SEVERAL, name, { ...args, ontology: ['alpha'] })).body).toMatchObject({
        errorName: 'OntologyNotFound',
        parameters: { apiName: '["alpha"]' },
      });
    },
  );

  it('service/ontology-mcp#tools: with no Ontology, an ontology still gives the tool error that says an admin must install one', async () => {
    expect(toolError(await call(EMPTY, 'load_objects', { objectSet: BASE, ontology: 'twin' }))).toEqual({
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'OntologyService:NoOntologyInstalled',
        errorInstanceId: UUID,
        parameters: {},
      },
      note: NO_ONTOLOGY,
    });
  });

  it.each([[null], ['']])('service/ontology-mcp#tools: an ontology of %j counts as no ontology', async (ontology) => {
    expect(
      loadedIds(await call(ORGANIZATION, 'load_objects', { objectSet: BASE, select: ['accountId'], ontology })),
    ).toEqual(['acc-twin']);

    expect(toolError(await call(SEVERAL, 'load_objects', { objectSet: BASE, ontology })).body).toMatchObject({
      errorName: 'OntologyService:OntologyRequired',
    });
  });

  it('service/ontology-mcp#tools: each answer follows the Ontologies of this moment, as an Organization goes from 0 to 1 to 2', async () => {
    const load = { objectSet: BASE, select: ['accountId'] };

    expect(toolError(await call(GROWING, 'load_objects', load)).note).toBe(NO_ONTOLOGY);

    await installOntology(service.db, {
      rid: 'ri.ontology.main.ontology.00000000-0000-4000-8000-00000000000c',
      product: 'twin',
      apiName: 'first',
      displayName: 'First',
      organization: GROWING,
    });

    expect(loadedIds(await call(GROWING, 'load_objects', load))).toEqual([]);

    await installOntology(service.db, {
      rid: 'ri.ontology.main.ontology.00000000-0000-4000-8000-00000000000d',
      product: 'twin',
      apiName: 'second',
      displayName: 'Second',
      organization: GROWING,
    });

    expect(toolError(await call(GROWING, 'load_objects', load)).body).toMatchObject({
      errorName: 'OntologyService:OntologyRequired',
      parameters: { ontologies: ['first', 'second'] },
    });
  });
});

describe('service/ontology-mcp#tools: describe_object_type with no name lists the Ontologies when the Organization has more than 1', () => {
  it('service/ontology-mcp#tools: with more than 1 Ontology, it lists each apiName and displayName, in the code point order of the API names', async () => {
    const { result, statuses } = await call(SEVERAL, 'describe_object_type', {});

    expect(statuses).toEqual([200]);
    expect(result.isError).toBeUndefined();

    const answer = {
      ontologies: [
        { apiName: 'alpha', displayName: 'The alpha Ontology' },
        { apiName: 'beta', displayName: 'The beta Ontology' },
      ],
    };

    expect(result.structuredContent).toEqual(answer);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(answer) }]);
  });

  it('service/ontology-mcp#tools: a tools/call with no arguments field also lists the Ontologies', async () => {
    const { client } = await connectV1(service, { token: await tokenOf(SEVERAL) });

    try {
      const result = (await client.callTool({ name: 'describe_object_type' })) as CallToolResult;

      expect(result.isError).toBeUndefined();

      expect(
        (result.structuredContent as { ontologies: { apiName: string }[] }).ontologies.map(
          (ontology) => ontology.apiName,
        ),
      ).toEqual(['alpha', 'beta']);
    } finally {
      await client.close();
    }
  });

  it('service/ontology-mcp#tools: with 1 Ontology, it gives the list of Object Types of that Ontology', async () => {
    const { result } = await call(ORGANIZATION, 'describe_object_type', {});

    expect(result.structuredContent).toHaveProperty('objectTypes');
    expect(result.structuredContent).not.toHaveProperty('ontologies');
  });

  it('service/ontology-mcp#tools: with more than 1 Ontology and an ontology, it gives the list of Object Types of that Ontology', async () => {
    const { result } = await call(SEVERAL, 'describe_object_type', { ontology: 'beta' });

    expect(result.structuredContent).toHaveProperty('objectTypes');
    expect(result.structuredContent).not.toHaveProperty('ontologies');
  });

  it('service/ontology-mcp#tools: describe_action with no name still needs the ontology', async () => {
    expect(toolError(await call(SEVERAL, 'describe_action', {})).body).toMatchObject({
      errorName: 'OntologyService:OntologyRequired',
    });
  });
});

describe('service/ontology-mcp#tools: each tool call opens the view of its Ontology for the caller', () => {
  const load = { objectSet: BASE, select: ['accountId'] };

  it('service/ontology-mcp#tools: 1 MCP URL reads the Objects of the chosen Ontology, and no others', async () => {
    expect(loadedIds(await call(ORGANIZATION, 'load_objects', load))).toEqual(['acc-twin']);

    expect(loadedIds(await call(SEVERAL, 'load_objects', { ...load, ontology: 'alpha' }))).toEqual(['acc-alpha']);

    expect(loadedIds(await call(SEVERAL, 'load_objects', { ...load, ontology: 'beta' }))).toEqual(['acc-beta']);
  });

  it('service/ontology-mcp#tools: 2 Organizations with the same apiName each read only their own rows', async () => {
    expect(loadedIds(await call(SEVERAL, 'load_objects', { ...load, ontology: 'alpha' }))).toEqual(['acc-alpha']);

    expect(loadedIds(await call(SAME_NAME, 'load_objects', { ...load, ontology: 'alpha' }))).toEqual(['acc-same-name']);
  });

  it('service/ontology-mcp#tools: an apply writes only in the chosen Ontology', async () => {
    const before = await service.db.query<{ phase: string }>({
      text: "SELECT phase FROM ontology_3_objects.account WHERE account_id = 'acc-beta'",
      values: [],
    });

    const { result } = await call(SEVERAL, 'apply_action', {
      action: SET_ACCOUNT_PHASE,
      parameters: { objectToModifyParameter: 'acc-alpha', phase: 'chosen' },
      ontology: 'alpha',
    });

    expect(result.isError).toBeUndefined();

    expect(
      await service.db.query({
        text: "SELECT phase FROM ontology_2_objects.account WHERE account_id = 'acc-alpha'",
        values: [],
      }),
    ).toEqual([{ phase: 'chosen' }]);

    expect(
      await service.db.query({
        text: "SELECT phase FROM ontology_3_objects.account WHERE account_id = 'acc-beta'",
        values: [],
      }),
    ).toEqual(before);
  });

  it('service/ontology-mcp#tools: an Ontology of another Organization gives the same tool error as an unknown apiName', async () => {
    const other = toolError(await call(SEVERAL, 'load_objects', { ...load, ontology: 'twin' }));

    expect(other).toEqual({
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'OntologyNotFound',
        errorInstanceId: UUID,
        parameters: { apiName: 'twin', ontologies: ['alpha', 'beta'] },
      },
      note: UNKNOWN,
    });
  });

  it('service/ontology-mcp#tools: the request log has the version and the RID of the chosen Ontology', async () => {
    const { result } = await call(SEVERAL, 'get_edit_history', { objectType: 'Nope', ontology: 'beta' });

    const { errorInstanceId } = result.structuredContent as { errorInstanceId: string };

    expect(lines().find((line) => line['errorInstanceId'] === errorInstanceId)).toMatchObject({
      ontologyVersion: 1,
      route: 'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory',
      routeParams: { ontology: BETA_RID, objectType: 'Nope' },
    });
  });

  it('service/ontology-mcp#tools service/ontology-mcp#route service/code-layout#seams: tools/list opens no Ontology, so its log line has no Ontology version', async () => {
    const { client } = await connectV1(service, { token: await tokenOf(SEVERAL) });

    try {
      await client.listTools();
    } finally {
      await client.close();
    }

    const line = lines().find(
      (candidate) => (candidate['mcp'] as { method?: string } | undefined)?.method === 'tools/list',
    );

    expect(line).toBeDefined();
    expect(line).not.toHaveProperty('ontologyVersion');
  });

  it('service/ontology-mcp#tools: a deployment has no Ontology setting, and the MCP route serves the Ontologies of the caller', async () => {
    const baseUrl = await service.serve(mcpSettings);

    const { client } = await connectV1({ ...service, url: new URL('/api/mcp', baseUrl) });

    try {
      const result = (await client.callTool({ name: 'load_objects', arguments: load })) as CallToolResult;

      expect(result.isError).toBeUndefined();

      expect(
        (result.structuredContent as { data: { accountId: string }[] }).data.map((object) => object.accountId),
      ).toEqual(['acc-twin']);
    } finally {
      await client.close();
    }
  });
});

describe('service/authentication#organizations: a person with no Organization learns to join or create one', () => {
  it('service/authentication#organizations: the 2025-11-25 client connects and lists the tools at HTTP 200', async () => {
    const exchanges: Exchange[] = [];

    const { client } = await connectV1(service, { token: await tokenOf(undefined), fetch: recordingFetch(exchanges) });

    try {
      expect((await client.listTools()).tools).toHaveLength(8);
    } finally {
      await client.close();
    }

    expect(
      exchanges.filter((exchange) => exchange.method === 'POST').map((exchange) => [exchange.rpc, exchange.status]),
    ).toEqual([
      ['initialize', 200],
      ['notifications/initialized', 202],
      ['tools/list', 200],
    ]);
  });

  it('service/authentication#organizations: the 2026-07-28 client connects, lists the tools, and gets the tool error', async () => {
    const client = await connectV2(service, { pin: '2026-07-28', token: await tokenOf(undefined) });

    try {
      expect((await client.listTools()).tools).toHaveLength(8);

      const result = (await client.callTool({ name: 'describe_object_type', arguments: {} })) as CallToolResult;

      expect(result.isError).toBe(true);

      expect(result.structuredContent).toEqual({
        errorCode: 'PERMISSION_DENIED',
        errorName: 'OntologyService:NoOrganization',
        errorInstanceId: UUID,
        parameters: {},
      });
    } finally {
      await client.close();
    }
  });

  it.each([
    ...TOOLS,
    ['describe_object_type', {}] as const,
    ['load_objects', { objectSet: BASE, ontology: 'twin' }] as const,
  ])(
    'service/authentication#organizations service/ontology-mcp#errors: %s gives a tool error at HTTP 200 that tells the person to join or create an Organization',
    async (name, args) => {
      expect(toolError(await call(undefined, name, args))).toEqual({
        body: {
          errorCode: 'PERMISSION_DENIED',
          errorName: 'OntologyService:NoOrganization',
          errorInstanceId: UUID,
          parameters: {},
        },
        note: NO_ORGANIZATION,
      });
    },
  );

  it('service/authentication#organizations service/observability#error-reports: the request log holds the error fields of the tool error', async () => {
    const { result } = await call(undefined, 'load_objects', { objectSet: BASE });

    const { errorInstanceId } = result.structuredContent as { errorInstanceId: string };

    expect(lines().find((line) => line['errorInstanceId'] === errorInstanceId)).toMatchObject({
      userId: PERSON,
      errorName: 'OntologyService:NoOrganization',
      route: 'POST /api/mcp',
      parameters: {},
    });
  });

  it('service/authentication#organizations: a token with no org_id keeps the 403 on an OSDK route', async () => {
    const token = await service.issuer.workos({ exp: now() + 3600, org_id: undefined });

    const response = await fetch(new URL('/api/v2/ontologies', service.baseUrl), {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(403);

    expect(await response.json()).toMatchObject({ errorName: 'OntologyService:NoOrganization' });
  });
});
