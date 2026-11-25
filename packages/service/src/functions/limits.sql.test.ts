import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorAnswer, NS, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';
import { TIME_LIMIT_MS } from './limits.ts';

const exits = new Map<string, Promise<void>>();

process.on('worker', (worker) => {
  exits.set(String(worker.threadId), new Promise((resolve) => worker.once('exit', () => resolve())));
});

const ACCOUNT = `${NS}Account`;
const accountInput = [{ name: 'accountId', type: 'string' as const }];

const FUNCTIONS: TestFunction[] = ['loopForever', 'fillHeap', 'throwError', 'reportThread', 'meetThread'].map(
  (apiName) => ({ apiName, inputs: accountInput, edits: [ACCOUNT] }),
);

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
function create(client, accountId, name) {
  const batch = createEditBatch(client);
  batch.create(Account, { accountId, name });
  return batch.getEdits();
}

export const functions = {
  loopForever: async (client, accountId) => {
    const edits = create(client, accountId, 'never written');
    new BroadcastChannel('limits.sql.test.ts loopForever').postMessage('looping');
    for (;;) {}
    return edits;
  },
  fillHeap: async (client, accountId) => {
    const edits = create(client, accountId, 'never written');
    const kept = [];
    for (;;) kept.push(new Array(1e5).fill({ accountId }));
    return edits;
  },
  throwError: async () => { throw new Error('a plain error'); },
  reportThread: async (client, accountId) => create(client, accountId, String(process.getBuiltinModule('node:worker_threads').threadId)),
  // Holds its worker until a call in another worker runs, then reports the thread. Each call posts when it
  // opens the channel, and answers the first post that it gets, so the call that opens first gets a post too.
  meetThread: async (client, accountId) => {
    const channel = new BroadcastChannel('limits.sql.test.ts meetThread');
    await new Promise((resolve) => {
      channel.onmessage = () => {
        channel.postMessage('here');
        channel.close();
        resolve();
      };
      channel.postMessage('here');
    });
    return create(client, accountId, String(process.getBuiltinModule('node:worker_threads').threadId));
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

function apply(apiName: string, accountId = 'fn-acc-1') {
  return service.apply(actionOf(apiName), {
    parameters: { accountId },
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
  });
}

async function withTimeLimit<T>(loops: number, run: (overLimit: () => Promise<void>) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const channel = new BroadcastChannel('limits.sql.test.ts loopForever');

  try {
    const looping = new Promise((resolve) => {
      let posts = 0;

      channel.onmessage = () => {
        posts += 1;

        if (posts === loops) resolve(undefined);
      };
    });

    return await run(async () => {
      await looping;

      await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);
    });
  } finally {
    channel.close();

    vi.useRealTimers();
  }
}

const FUNCTION_RID = expect.stringMatching(
  /^ri\.function-registry\.main\.function\.[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

async function threads(): Promise<string[]> {
  return ((await rowsOf(service.db, ACCOUNT, 'account_id')) as { name: string }[]).map((row) => row.name);
}

describe('the time limit', () => {
  it(
    'ontology/functions/functions#errors, ontology/functions/functions#runtime, service/testing#conformance-tests: ' +
      'a Function that runs over its time limit gets 400 FunctionExecutionTimedOut, and the Action writes nothing',
    async () => {
      const answer = await withTimeLimit(1, async (overLimit) => {
        const looped = apply('loopForever');

        await overLimit();

        return looped;
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'FunctionExecutionTimedOut',
          parameters: { functionRid: FUNCTION_RID, functionVersion: '1.0.0' },
        },
      });

      expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
    },
  );

  it('ontology/functions/functions#runtime: at the time limit, the service stops the worker, and a new worker runs the next call', async () => {
    const met = await Promise.all([apply('meetThread', 'fn-acc-1'), apply('meetThread', 'fn-acc-2')]);

    expect(met.map((answer) => answer.status)).toEqual([200, 200]);

    const before = await threads();

    expect(new Set(before).size).toBe(2);

    const stopped = await withTimeLimit(2, async (overLimit) => {
      const looped = Promise.all([apply('loopForever', 'fn-acc-3'), apply('loopForever', 'fn-acc-4')]);

      await overLimit();

      return looped;
    });

    expect(stopped.map((answer) => answer.status)).toEqual([400, 400]);

    await Promise.all(
      before.map((thread) => exits.get(thread) ?? Promise.reject(new Error(`No worker has the thread ${thread}.`))),
    );

    await service.clear();

    expect((await apply('reportThread', 'fn-acc-5')).status).toBe(200);

    const [after] = await threads();

    expect(before).not.toContain(after);
  });
});

describe('the other requests of the instance', () => {
  it('ontology/functions/functions#runtime: a loop, a heap overrun, and a throw in a Function do not fail a call in another worker', async () => {
    const answers = await withTimeLimit(1, async (overLimit) => {
      const looped = apply('loopForever', 'fn-acc-1');

      const others = await Promise.all([
        apply('fillHeap', 'fn-acc-2'),
        apply('throwError', 'fn-acc-3'),
        apply('reportThread', 'fn-acc-4'),
      ]);

      await overLimit();

      return [await looped, ...others];
    });

    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400, 200]);

    expect(await threads()).toHaveLength(1);
  });
});
