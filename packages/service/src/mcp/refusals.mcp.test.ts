import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fallibleOf } from '../db/promise.test-utils.ts';
import { closeServer, listenLocal } from '../localServer.test-utils.ts';
import { createNodeServer } from '../node.ts';
import { stored, twinFunctions, twinIr } from '../ontology/stored.test-utils.ts';
import { claimsOf, roleUsers } from '../people.test-utils.ts';
import type { DiscoveredFunction, PublishedFunctions } from '../publish/index.ts';
import { ACCOUNT, SET_ENGAGEMENT_STATUS, twinSplitGrants } from '../roles.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import {
  connectV2,
  mcpSettings,
  recordingFetch,
  startMcpService,
  type Exchange,
  type McpService,
} from './mcp.test-utils.ts';

const SECTION = 'service/ontology-mcp#errors';
const NS = 'com.example.twin.';
const HIDDEN_QUERY = 'accountSummary';

function functions(): PublishedFunctions {
  const twin = twinFunctions('0.7.0');

  const accountSummary = {
    locator: { type: 'typescript', typescript: { functionName: HIDDEN_QUERY } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      { name: 'account', dataType: { type: 'object', object: { objectTypeId: ACCOUNT } } },
    ],
    output: { type: 'single', single: { dataType: { type: 'string', string: {} } } },
    customTypes: {},
    documentation: 'A summary of an Account.',
  } as DiscoveredFunction;

  return { ...twin, discovered: [...twin.discovered, accountSummary] };
}

let harness: McpService;
let server: Server;
let service: McpService;
let tokens: { admin: string; member: string };
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
      functions: functions(),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants: { ...twinSplitGrants(), queryTypes: { [HIDDEN_QUERY]: 'twin:admin' } },
      validateOnly: false,
    }),
  });

  if (published.status !== 200) throw new Error(`The publish gave ${published.status}: ${await published.text()}`);

  const exp = now() + 3600;

  tokens = {
    admin: await service.issuer.authkit({ exp, ...claimsOf('admin') }),
    member: await service.issuer.authkit({ exp, ...claimsOf('member') }),
  };
});

afterAll(async () => {
  if (server) await closeServer(server);

  await harness?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

interface Case {
  readonly name: string;
  readonly person: 'admin' | 'member';
  readonly tool: string;
  readonly args: unknown;
  readonly revision?: '2025-11-25' | '2026-07-28';
}

const as = ({
  revision,
  ...rest
}: Omit<Case, 'revision'> & { readonly revision?: Case['revision'] | undefined }): Case => ({
  ...rest,
  ...(revision === undefined ? {} : { revision }),
});

const SERVICE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

function masked(text: string): string {
  return text
    .replace(/"errorInstanceId":"[^"]*"/g, '"errorInstanceId":"?"')
    .replace(/\\"errorInstanceId\\":\\"[^"\\]*\\"/g, '\\"errorInstanceId\\":\\"?\\"')
    .replaceAll(
      `"io.modelcontextprotocol/serverInfo":{"name":"ontology","version":${JSON.stringify(SERVICE_VERSION)}}`,
      '"io.modelcontextprotocol/serverInfo":{"name":"ontology","version":"<service-version>"}',
    );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function logOf(): unknown[] {
  return consoleLog.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('{'))
    .map((line): unknown => JSON.parse(line))
    .filter(
      (line): line is Record<string, unknown> =>
        isRecord(line) && isRecord(line['mcp']) && line['mcp']['method'] === 'tools/call',
    )
    .map((line) =>
      Object.fromEntries(
        Object.entries(line)
          .filter(([key]) => key !== 'errorInstanceId')
          .map(([key, value]) => [key, key === 'stack' ? String(value).split('\n')[0] : value]),
      ),
    );
}

async function answerOf({ person, tool, args, revision = '2025-11-25' }: Case): Promise<unknown> {
  consoleLog.mockClear();

  if (revision === '2026-07-28') {
    const exchanges: Exchange[] = [];

    const client = await connectV2(service, { pin: revision, token: tokens[person], fetch: recordingFetch(exchanges) });

    try {
      const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });

      const call = exchanges.find((exchange) => exchange.rpc === 'tools/call');

      return {
        status: call?.status,
        contentType: call?.contentType,
        result: JSON.parse(masked(JSON.stringify(result))) as unknown,
        log: logOf(),
      };
    } finally {
      await client.close();
    }
  }

  const response = await fetch(service.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens[person]}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': revision,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });

  const text = masked(await response.text());

  const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));

  return { status: response.status, headers, body: JSON.parse(text) as unknown, log: logOf() };
}

function pin(cases: readonly Case[]): void {
  for (const refusal of cases) {
    it(`${refusal.tool}: ${refusal.name}`, async () => {
      expect(await answerOf(refusal)).toMatchSnapshot();
    });
  }
}

const base = (objectType: unknown) => ({ type: 'base', objectType });
const COUNT = [{ type: 'count', name: 'count' }];

describe(`${SECTION}: describe_object_type`, () => {
  const describing = (name: string, args: unknown, person: Case['person'] = 'admin', revision?: Case['revision']) =>
    as({ person, tool: 'describe_object_type', name, args, revision });

  pin([
    describing('an unknown name', { objectType: 'Nonesuch' }),
    describing('an unknown API name', { objectType: `${NS}Nosuchtype` }),
    describing('a part of an API name with a dot', { objectType: 'ontology.Engagement' }),
    describing('constructor', { objectType: 'constructor' }),
    describing('__proto__', { objectType: '__proto__' }),
    describing('toString', { objectType: 'toString' }),
    describing('an empty name', { objectType: '' }),
    describing('a number', { objectType: 5 }),
    describing('null', { objectType: null }),
    describing('a Boolean', { objectType: true }),
    describing('an object', { objectType: {} }),
    describing('a list', { objectType: ['Engagement'] }),
    describing('the API name of an Object Type that the member cannot see', { objectType: ACCOUNT }, 'member'),
    describing('the short name of an Object Type that the member cannot see', { objectType: 'Account' }, 'member'),
    describing('an unknown name, in the revision 2026-07-28', { objectType: 'Nonesuch' }, 'admin', '2026-07-28'),
  ]);
});

describe(`${SECTION}: describe_action`, () => {
  const describing = (name: string, args: unknown, person: Case['person'] = 'admin', revision?: Case['revision']) =>
    as({ person, tool: 'describe_action', name, args, revision });

  pin([
    describing('an unknown name', { actionType: 'no-such-action' }),
    describing('the camelCase name of an Action Type', { actionType: 'setEngagementStatus' }),
    describing(
      'the camelCase name of an Action Type that the member cannot see',
      { actionType: 'setEngagementStatus' },
      'member',
    ),
    describing(
      'the API name of an Action Type that the member cannot see',
      { actionType: SET_ENGAGEMENT_STATUS },
      'member',
    ),
    describing('constructor', { actionType: 'constructor' }),
    describing('__proto__', { actionType: '__proto__' }),
    describing('an empty name', { actionType: '' }),
    describing('a number', { actionType: 5 }),
    describing('null', { actionType: null }),
    describing('an unknown name, in the revision 2026-07-28', { actionType: 'no-such-action' }, 'admin', '2026-07-28'),
  ]);
});

describe(`${SECTION}: describe_query`, () => {
  const describing = (name: string, args: unknown, person: Case['person'] = 'admin', revision?: Case['revision']) =>
    as({ person, tool: 'describe_query', name, args, revision });

  pin([
    describing('an unknown name', { query: 'noSuchQuery' }),
    describing('an edit Function', { query: 'closeAccount' }),
    describing('a Query Function that the member cannot see', { query: HIDDEN_QUERY }, 'member'),
    describing('constructor', { query: 'constructor' }),
    describing('__proto__', { query: '__proto__' }),
    describing('an empty name', { query: '' }),
    describing('a number', { query: 5 }),
    describing('null', { query: null }),
    describing('an unknown name, in the revision 2026-07-28', { query: 'noSuchQuery' }, 'admin', '2026-07-28'),
  ]);
});

describe(`${SECTION}: a tool that takes a short name`, () => {
  const loading = (name: string, objectSet: unknown, person: Case['person'] = 'admin') =>
    as({ person, tool: 'load_objects', name, args: { objectSet, select: ['engagementId'] } });

  const aggregating = (name: string, objectSet: unknown, person: Case['person'] = 'admin') =>
    as({ person, tool: 'aggregate_objects', name, args: { objectSet, aggregation: COUNT } });

  const filter = (objectSet: unknown) => ({
    type: 'filter',
    objectSet,
    where: { type: 'isNull', field: 'title', value: false },
  });

  pin([
    loading('a base of an unknown name', base('Nonesuch')),
    loading('a base that is not a string', base(5)),
    loading('an Object Set that is not an object', 5),
    loading('an Object Set that is a list', [base('Engagement')]),
    loading('a filter of a base of an unknown name', filter(base('Nonesuch'))),
    loading('a union of a base of an unknown name', {
      type: 'union',
      objectSets: [base('Engagement'), base('Nonesuch')],
    }),
    loading('a union with no list', { type: 'union', objectSets: 5 }),
    loading('a searchAround of a base of an unknown name', {
      type: 'searchAround',
      objectSet: base('Nonesuch'),
      link: 'engagements',
    }),
    loading('a withProperties with a selection of an unknown name', {
      type: 'withProperties',
      objectSet: base('Engagement'),
      derivedProperties: { n: { type: 'selection', objectSet: base('Nonesuch'), operation: { type: 'count' } } },
    }),
    loading('a withProperties with derived properties that are no object', {
      type: 'withProperties',
      objectSet: base('Engagement'),
      derivedProperties: 5,
    }),
    loading('a base of the short name of an Object Type that the member cannot see', base('Account'), 'member'),
    aggregating('a base of an unknown name', base('Nonesuch')),
    aggregating('a subtract of a base of an unknown name', {
      type: 'subtract',
      objectSets: [base('Engagement'), base('Nonesuch')],
    }),
    aggregating('a base of the short name of an Object Type that the member cannot see', base('Account'), 'member'),
    as({ person: 'admin', tool: 'get_edit_history', name: 'an unknown name', args: { objectType: 'Nonesuch' } }),
    as({ person: 'admin', tool: 'get_edit_history', name: 'a name that is not a string', args: { objectType: 5 } }),
    as({
      person: 'member',
      tool: 'get_edit_history',
      name: 'the short name of an Object Type that the member cannot see',
      args: { objectType: 'Account' },
    }),
    as({
      person: 'admin',
      tool: 'load_objects',
      name: 'a base of an unknown name, in the revision 2026-07-28',
      args: { objectSet: base('Nonesuch') },
      revision: '2026-07-28',
    }),
    as({
      person: 'admin',
      tool: 'execute_query',
      name: 'an unknown query',
      args: { query: 'noSuchQuery', parameters: {} },
    }),
    as({
      person: 'member',
      tool: 'execute_query',
      name: 'a Query Function that the member cannot see',
      args: { query: HIDDEN_QUERY, parameters: {} },
    }),
    as({
      person: 'admin',
      tool: 'apply_action',
      name: 'an unknown Action Type',
      args: { action: 'no-such-action', parameters: {} },
    }),
  ]);
});
