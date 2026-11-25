import type { Server } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeServer } from './node.ts';
import { jobsiteIr } from './ontology/stored.test-utils.ts';
import { now } from './tokens.test-utils.ts';
import {
  CREW,
  DAILY_LOG,
  EDIT_JOBSITE,
  CREATE_DAILY_LOG,
  JOBSITE,
  jobsiteGrants,
  jobsiteUsers,
  PEOPLE,
  seedJobsite,
  type Person,
} from '../twin/seed/jobsite.test-utils.ts';
import { stubPublish } from './workos.test-utils.ts';
import { connectV1, mcpSettings, startMcpService, type McpService } from './mcp/mcp.test-utils.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

const RULE = 'service/testing#policy-twin';
let harness: McpService;
let service: McpService;
let server: Server | undefined;
let tokens: Record<Person, string>;

beforeAll(async () => {
  const ir = jobsiteIr();
  const grants = jobsiteGrants(ir);

  harness = await startMcpService({ ir, grants });

  server = createNodeServer({
    db: fallibleOf(harness.db),
    directDb: fallibleOf(harness.db),
    settings: mcpSettings,
    keys: harness.issuer.keys,
    users: jobsiteUsers(grants),
    workos: stubPublish(),
  });

  service = { ...harness, url: new URL('/api/mcp', await listenLocal(server)) };

  await seedJobsite(service.db);

  const exp = now() + 3600;

  tokens = Object.fromEntries(
    await Promise.all(
      Object.entries(PEOPLE).map(async ([person, claims]) => [
        person,
        await service.issuer.authkit({ exp, ...claims }),
      ]),
    ),
  ) as Record<Person, string>;

  for (const [action, parameters] of [
    [EDIT_JOBSITE, { objectToModifyParameter: 'j-3', name: 'Hilltop', budget: 55000 }],
    [CREATE_DAILY_LOG, { logId: 'log-5', jobsiteId: 'j-1', note: 'Poured slab', hours: 7 }],
  ] as const) {
    const applied = await call('admin', 'apply_action', { action, parameters });

    if (applied.isError) throw new Error(`The apply of ${action} failed: ${JSON.stringify(applied.content)}`);
  }
});

afterAll(async () => {
  if (server) await closeServer(server);

  await harness?.stop();
});

async function call(person: Person, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { client } = await connectV1(service, { token: tokens[person] });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

async function answer(person: Person, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await call(person, name, args);

  expect(result.isError).toBeFalsy();

  const [block] = result.content;

  return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
}

async function each<T>(read: (person: Person) => Promise<T>): Promise<Record<'ann' | 'ben' | 'admin', T>> {
  return { ann: await read('ann'), ben: await read('ben'), admin: await read('admin') };
}

const base = (objectType: string) => ({ type: 'base', objectType });

type Row = Record<string, unknown>;

describe(`${RULE}: the Ontology MCP`, () => {
  it(`${RULE}: load_objects gives each person only their Jobsites, and a crew member reads budget as null, which the answer leaves out`, async () => {
    const jobsites = async (person: Person) => {
      const page = await answer(person, 'load_objects', {
        objectSet: base(JOBSITE),
        orderBy: { fields: [{ field: 'jobsiteId', direction: 'asc' }] },
      });

      return (page['data'] as Row[]).map((row) => [row['jobsiteId'], row['budget']]);
    };

    expect(await each(jobsites)).toEqual({
      ann: [
        ['j-1', undefined],
        ['j-2', undefined],
      ],
      ben: [
        ['j-2', undefined],
        ['j-3', undefined],
      ],
      admin: [
        ['j-1', 120000],
        ['j-2', 80000],
        ['j-3', 55000],
      ],
    });
  });

  it(`${RULE}: load_objects with a Search Around from the Crews gives each person only their Jobsites`, async () => {
    const jobsites = async (person: Person) => {
      const objectSet = { type: 'searchAround', link: 'jobsites', objectSet: base(CREW) };

      const page = await answer(person, 'load_objects', {
        objectSet,
        orderBy: { fields: [{ field: 'jobsiteId', direction: 'asc' }] },
      });

      return (page['data'] as Row[]).map((row) => row['jobsiteId']);
    };

    expect(await each(jobsites)).toEqual({ ann: ['j-1', 'j-2'], ben: ['j-2', 'j-3'], admin: ['j-1', 'j-2', 'j-3'] });
  });

  it(`${RULE}: load_objects with a Search Around from the Crews gives each person only the DailyLogs of their Jobsites`, async () => {
    const logs = async (person: Person) => {
      const objectSet = {
        type: 'searchAround',
        link: 'dailyLogs',
        objectSet: { type: 'searchAround', link: 'jobsites', objectSet: base(CREW) },
      };

      const page = await answer(person, 'load_objects', {
        objectSet,
        orderBy: { fields: [{ field: 'logId', direction: 'asc' }] },
      });

      return (page['data'] as Row[]).map((row) => row['logId']);
    };

    expect(await each(logs)).toEqual({
      ann: ['log-1', 'log-2', 'log-5'],
      ben: ['log-2', 'log-3', 'log-4'],
      admin: ['log-1', 'log-2', 'log-3', 'log-4', 'log-5'],
    });
  });

  it(`${RULE}: aggregate_objects counts and sums only the person's DailyLogs`, async () => {
    const totals = async (person: Person) => {
      const aggregation = [
        { type: 'count', name: 'count' },
        { type: 'sum', field: 'hours', name: 'hours' },
      ];

      const result = await answer(person, 'aggregate_objects', {
        objectSet: base(DAILY_LOG),
        aggregation,
        groupBy: [],
      });

      return (result['data'] as { metrics: { name: string; value: number }[] }[]).flatMap((group) =>
        group.metrics.map((metric) => [metric.name, metric.value]),
      );
    };

    expect(await each(totals)).toEqual({
      ann: [
        ['count', 3],
        ['hours', 21],
      ],
      ben: [
        ['count', 3],
        ['hours', 15],
      ],
      admin: [
        ['count', 5],
        ['hours', 30],
      ],
    });
  });

  it(`${RULE}: get_edit_history gives each person only the entries of their Objects, and a crew member reads no budget`, async () => {
    const entries = async (person: Person, objectType: string) => {
      const page = await answer(person, 'get_edit_history', { objectType, sortOrder: 'oldest_first' });

      return (
        page['data'] as {
          objectPrimaryKey: Record<string, { value: string }>;
          edit: { type: string; properties?: Row };
        }[]
      ).map(({ objectPrimaryKey, edit }) => [
        Object.values(objectPrimaryKey)[0]?.value,
        edit.type,
        edit.properties?.['budget'],
      ]);
    };

    expect(await each((person) => entries(person, JOBSITE))).toEqual({
      ann: [],
      ben: [['j-3', 'modifyEdit', undefined]],
      admin: [['j-3', 'modifyEdit', 55000]],
    });

    expect(await each((person) => entries(person, DAILY_LOG))).toEqual({
      ann: [['log-5', 'createEdit', undefined]],
      ben: [],
      admin: [['log-5', 'createEdit', undefined]],
    });
  });
});
