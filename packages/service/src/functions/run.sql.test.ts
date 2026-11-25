import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newVersion, NS, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'createAccount',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'name', type: 'string' },
    ],
    edits: [ACCOUNT],
  },
  { apiName: 'inspectRuntime', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] },
  { apiName: 'countCalls', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] },
  {
    apiName: 'waitAndReport',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'waitMs', type: 'integer' },
    ],
    edits: [ACCOUNT],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
const worker = () => process.getBuiltinModule('node:worker_threads');

// Module-level code: it runs each time a worker loads the bundle.
globalThis.loads = (globalThis.loads ?? 0) + 1;
let calls = 0;

function create(client, accountId, name) {
  const batch = createEditBatch(client);
  batch.create(Account, { accountId, name });
  return batch.getEdits();
}

export const functions = {
  createAccount: async (client, accountId, name) => create(client, accountId, name),
  inspectRuntime: async (client, accountId) =>
    create(client, accountId, JSON.stringify({ env: process.env, mainThread: worker().isMainThread })),
  countCalls: async (client, accountId) => {
    calls += 1;
    return create(client, accountId, JSON.stringify({ thread: worker().threadId, loads: globalThis.loads, calls }));
  },
  waitAndReport: async (client, accountId, waitMs) => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return create(client, accountId, JSON.stringify({ thread: worker().threadId, start, end: Date.now() }));
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

function apply(apiName: string, parameters: Record<string, unknown>) {
  return service.apply(actionOf(apiName), { parameters, options: EXECUTE_ALL_V2 });
}

async function reports(): Promise<Record<string, Record<string, unknown>>> {
  const rows = (await rowsOf(service.db, ACCOUNT, 'account_id')) as { account_id: string; name: string }[];

  return Object.fromEntries(rows.map((row) => [row.account_id, JSON.parse(row.name) as Record<string, unknown>]));
}

describe('a function-backed Action whose Function takes only scalar inputs', () => {
  it(
    'service/code-layout#seams, ontology/functions/edit-functions#edits: ' +
      'a createObject edit of the Function writes the Object, and the answer names it as an addObject edit',
    async () => {
      const answer = await apply('createAccount', { accountId: 'fn-acc-1', name: 'Hooli' });

      expect(answer).toEqual({
        status: 200,
        body: {
          operationId: expect.stringMatching(ACTION_RID),
          validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
          edits: {
            type: 'edits',
            edits: [{ type: 'addObject', primaryKey: 'fn-acc-1', objectType: ACCOUNT }],
            addedObjectCount: 1,
            modifiedObjectsCount: 0,
            deletedObjectsCount: 0,
            addedLinksCount: 0,
            deletedLinksCount: 0,
          },
        },
      });

      expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([
        { __version: newVersion(), account_id: 'fn-acc-1', name: 'Hooli', phase: null },
      ]);
    },
  );

  it('ontology/functions/functions#runtime: the Function runs in a worker thread with an empty environment', async () => {
    expect((await apply('inspectRuntime', { accountId: 'fn-acc-1' })).status).toBe(200);

    expect(await reports()).toEqual({ 'fn-acc-1': { env: {}, mainThread: false } });
  });

  it('ontology/functions/functions#runtime: a worker loads the bundle once, and later calls reuse its module-level code', async () => {
    for (const accountId of ['fn-acc-1', 'fn-acc-2', 'fn-acc-3'])
      expect((await apply('countCalls', { accountId })).status).toBe(200);

    const calls = Object.values(await reports()) as { thread: number; loads: number; calls: number }[];

    const byThread = Map.groupBy(calls, (call) => call.thread);

    for (const reports of byThread.values()) {
      expect(reports.map((report) => [report.loads, report.calls])).toEqual(reports.map((_, i) => [1, i + 1]));
    }

    expect(Math.max(...[...byThread.values()].map((reports) => reports.length))).toBeGreaterThanOrEqual(2);
  });

  it('ontology/functions/functions#runtime: after a publish of another bundle, the call runs in a worker that loaded only that bundle', async () => {
    expect((await apply('countCalls', { accountId: 'fn-acc-1' })).status).toBe(200);

    const { ir, functions } = await withFunctions(
      [...FUNCTIONS, { apiName: 'unused', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] }],
      `${SOURCE}\nglobalThis.bundleVersion = 2;`,
    );

    await service.publish(ir, functions);

    expect((await apply('countCalls', { accountId: 'fn-acc-2' })).status).toBe(200);

    expect((await reports())['fn-acc-2']).toMatchObject({ loads: 1, calls: 1 });
  });

  it('ontology/functions/functions#runtime: 2 warm workers run 3 calls, and each worker runs 1 call at a time', async () => {
    const answers = await Promise.all(
      ['fn-acc-1', 'fn-acc-2', 'fn-acc-3'].map((accountId) => apply('waitAndReport', { accountId, waitMs: 500 })),
    );

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);

    const calls = Object.values(await reports()) as { thread: number; start: number; end: number }[];

    const threads = [...new Set(calls.map((call) => call.thread))];

    expect(threads).toHaveLength(2);

    const groups = threads.map((thread) =>
      calls.filter((call) => call.thread === thread).sort((x, y) => x.start - y.start),
    );

    expect(groups.map((group) => group.length).sort((a, b) => a - b)).toEqual([1, 2]);

    const pair = groups.find((group) => group.length === 2);

    if (!pair?.[0] || !pair[1]) throw new Error('Expected one worker to run 2 calls.');

    expect(pair[1].start).toBeGreaterThanOrEqual(pair[0].end);
  });
});
