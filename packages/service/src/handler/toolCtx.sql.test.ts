import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handle, routes, type Ctx, type HandleInput, type RouteAnswer, type RouteInput } from './index.ts';
import { startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { TOOLS } from '../mcp/tools.ts';
import { NS } from '../ontology/stored.test-utils.ts';
import { AUTHKIT_DOMAIN } from '../tokens.test-utils.ts';

let installed: InstalledOntology;
let input: HandleInput;
let toolCalls: MockInstance[];
let routeRuns: MockInstance<(input: RouteInput, ctx: Ctx) => RouteAnswer>[];

beforeAll(async () => {
  installed = await startInstalled();

  input = { ...installed.input, settings: { ...installed.settings, authkitDomain: AUTHKIT_DOMAIN, mcp: true } };
});

afterAll(async () => {
  await installed?.stop();
});

beforeEach(() => {
  toolCalls = TOOLS.map((tool) => vi.spyOn(tool as { call: (...args: never[]) => unknown }, 'call'));

  routeRuns = routes
    .filter((route) => route.access !== 'mcp')
    .map((route) => vi.spyOn(route as { run: (input: RouteInput, ctx: Ctx) => RouteAnswer }, 'run'));
});

afterEach(() => {
  for (const spy of [...toolCalls, ...routeRuns]) spy.mockRestore();
});

function toolKeys(name: string): string[][] {
  const index = TOOLS.findIndex((tool) => tool.name === name);

  return (toolCalls[index]?.mock.calls ?? []).map((args: unknown[]) => Object.keys(args[1] as object).sort());
}

function routeKeys(): string[][] {
  return routeRuns.flatMap((run) => run.mock.calls.map(([, ctx]) => Object.keys(ctx).sort()));
}

async function callTool(name: string, args: object): Promise<unknown> {
  const request = new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await installed.issuer.authkit()}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const answer = (await (await handle(request, input)).json()) as { result: { content: { text: string }[] } };

  return JSON.parse(answer.result.content[0]?.text ?? 'null') as unknown;
}

const ACCOUNT = `${NS}Account`;
const ACTION = `${NS}create-engagement`;
const valid = (required: boolean) => ({ result: 'VALID', evaluatedConstraints: [], required });

const ANSWERS: Readonly<Record<string, unknown>> = {
  load_objects: {
    totalCount: '0',
    propertySecurities: [],
    objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
    data: [],
  },
  aggregate_objects: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [] }] },
  get_edit_history: { data: [], totalCount: 0 },
  apply_action: {
    validation: {
      result: 'INVALID',
      submissionCriteria: [],
      parameters: {
        title: { ...valid(true), result: 'INVALID' },
        amount: valid(false),
        accountId: valid(false),
        engagementId: valid(false),
      },
    },
  },
};

const READ_CTX = ['caller', 'checkWrite', 'db', 'handleTrusted', 'log', 'ontology', 'reader', 'traceDerived'];

describe('the ctx of a tool of the Ontology MCP', () => {
  it.each([
    ['load_objects', { objectSet: { type: 'base', objectType: ACCOUNT } }, READ_CTX],
    ['aggregate_objects', { objectSet: { type: 'base', objectType: ACCOUNT }, aggregation: [] }, READ_CTX],
    ['get_edit_history', { objectType: ACCOUNT }, READ_CTX],
    ['apply_action', { action: ACTION, parameters: {} }, [...READ_CTX, 'activeMembers', 'writer'].sort()],
  ])(
    'service/code-layout#seams: %s holds no Writer and no member check, and its route gets them only when it writes',
    async (name, args, keys) => {
      const result = await callTool(name, args);

      expect(result).toEqual(ANSWERS[name]);
      expect(routeKeys()).toEqual([keys]);
      expect(toolKeys(name)).toEqual([[...READ_CTX, 'runRoute'].sort()]);
    },
  );

  it('service/code-layout#seams: describe_object_type holds no Writer and no member check', async () => {
    await callTool('describe_object_type', {});

    expect(toolKeys('describe_object_type')).toEqual([[...READ_CTX, 'runRoute'].sort()]);
  });
});
