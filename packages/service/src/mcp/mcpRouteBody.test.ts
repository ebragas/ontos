import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildService } from '../../build.ts';
import { orThrow } from '../errors/fallible.ts';
import type {
  CallTool,
  handle as handleFn,
  inputFromEnv as inputFromEnvFn,
  McpCtx,
  RouteCall,
} from '../handler/index.ts';
import { rejecting } from '../service.test-utils.ts';
import { mcp } from './index.ts';
import type { JsonObject } from '../ontology/index.ts';

const ACCOUNT = 'com.example.twin.Account';
const BASE = { type: 'base', objectType: ACCOUNT };

async function routeCallsOf(name: string, args: JsonObject): Promise<RouteCall[]> {
  const sent: RouteCall[] = [];

  const ctx = {
    log: () => undefined,
    ontology: { objectTypes: new Map([[ACCOUNT, {}]]) },
    runRoute: (routeCall: RouteCall) => {
      sent.push(routeCall);

      return Promise.resolve({ status: 200, body: {} });
    },
  };

  const callTool: CallTool = (_choose, run) =>
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The tools read only runRoute, log, and the Object Type names of the McpCtx.
    orThrow(run(ctx as unknown as McpCtx));

  const request = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
  });

  const response = await rejecting(
    mcp(
      { request, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } },
      callTool,
    ),
  );

  expect(response.status).toBe(200);

  return sent;
}

describe('service/ontology-mcp#tools: the ontology argument chooses the Ontology and goes to no route', () => {
  it.each([
    [
      'load_objects',
      { objectSet: BASE, ontology: 'beta' },
      {
        key: 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects',
        params: {},
        body: { objectSet: BASE, pageSize: 50, loadOntologyDefinedDerivedProperties: false },
      },
    ],
    [
      'aggregate_objects',
      { objectSet: BASE, aggregation: [], ontology: 'beta' },
      {
        key: 'POST /api/v2/ontologies/{ontology}/objectSets/aggregate',
        params: {},
        body: { objectSet: BASE, aggregation: [] },
      },
    ],
    [
      'get_edit_history',
      { objectType: ACCOUNT, ontology: 'beta' },
      {
        key: 'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory',
        params: { objectType: ACCOUNT },
        body: { pageSize: 50 },
      },
    ],
  ] as const)('service/ontology-mcp#tools: %s sends no ontology to its route', async (name, args, expected) => {
    expect(await routeCallsOf(name, args)).toEqual([expected]);
  });
});

describe('service/ontology-mcp#tools: a null pageSize sends a page of 50 to the route', () => {
  it.each([
    [
      'load_objects',
      { objectSet: BASE, pageSize: null },
      {
        key: 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects',
        params: {},
        body: { objectSet: BASE, pageSize: 50, loadOntologyDefinedDerivedProperties: false },
      },
    ],
    [
      'get_edit_history',
      { objectType: ACCOUNT, pageSize: null },
      {
        key: 'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory',
        params: { objectType: ACCOUNT },
        body: { pageSize: 50 },
      },
    ],
  ] as const)('service/ontology-mcp#tools: %s sends pageSize 50 for a null pageSize', async (name, args, expected) => {
    expect(await routeCallsOf(name, args)).toEqual([expected]);
  });
});

describe('lazy MCP handler creation', () => {
  let result: SpawnSyncReturns<string>;

  beforeAll(() => {
    const entry = new URL('./index.ts', import.meta.url).href;

    result = spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(entry)});`], { encoding: 'utf8' });
  });

  it('importing mcp/index.ts does not construct the modern MCP handler or emit its responseMode warning', () => {
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});

interface DistServiceModule {
  readonly handle: typeof handleFn;
  readonly inputFromEnv: typeof inputFromEnvFn;
}

describe('compiled dist MCP route', () => {
  let dist: DistServiceModule;
  const pools: pg.Pool[] = [];

  beforeAll(async () => {
    const distEntry = new URL('../../dist/index.js', import.meta.url);

    if (!existsSync(distEntry)) await buildService(fileURLToPath(new URL('../../dist', import.meta.url)));

    dist = (await import(distEntry.href)) as DistServiceModule;
  }, 30_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('serves POST /api/mcp ping with HTTP 200 from compiled packages/service/dist/index.js', async () => {
    const input = dist.inputFromEnv(
      { ONTOS_AUTH_MODE: 'dev', DATABASE_URL: 'postgresql://localhost/unused' },
      (connectionString) => {
        const pool = new pg.Pool({ connectionString });

        pools.push(pool);

        return pool;
      },
    );

    const response = await dist.handle(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ontos-dev-token',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      input,
    );

    expect(response.status).toBe(200);

    const text = await response.text();

    expect(text).toContain('"result":{}');
  });
});
