import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { settle } from '../errors/index.ts';
import { TIME_LIMIT_MS, WAIT_LIMIT_MS } from './limits.ts';
import { callFunction, RunFailure, type Bridge } from './pool.ts';

const BUNDLE = `
let kept;
let memo;
let refreshed;
export const createClient = (baseUrl, ontologyRid, token, options, fetch) => ({ fetch, ontologyRid });
const thread = () => process.getBuiltinModule('node:worker_threads').threadId;
export const functions = {
  leaveThrow: async () => { setTimeout(() => { throw new Error('a throw of an earlier call'); }, 50); return [{ thread: thread() }]; },
  leaveInterval: async () => { setInterval(() => undefined, 10).unref(); return [{ thread: thread() }]; },
  leaveTimeout: async () => { setTimeout(() => undefined, 50).unref(); return [{ thread: thread() }]; },
  leaveImmediateLoop: async () => { const tick = () => { setImmediate(tick).unref(); }; tick(); return [{ thread: thread() }]; },
  leaveRefThenUnref: async () => { setTimeout(() => undefined, 50).ref().unref(); return [{ thread: thread() }]; },
  leaveTimersModule: async () => { process.getBuiltinModule('node:timers').setInterval(() => undefined, 10).unref(); return [{ thread: thread() }]; },
  leavePromiseTimer: async () => { void process.getBuiltinModule('node:timers/promises').setTimeout(50, null, { ref: false }); return [{ thread: thread() }]; },
  leaveRefresh: async () => { refreshed ??= setTimeout(() => undefined, 1); await new Promise((resolve) => setTimeout(resolve, 20)); refreshed.refresh().unref(); return [{ thread: thread() }]; },
  leaveRead: async (client) => { void client.fetch('https://x.invalid/slow').catch(() => undefined); return [{ thread: thread() }]; },
  leaveChannel: async () => {
    const channel = new BroadcastChannel('pool-leftover');
    channel.onmessage = () => setImmediate(() => { throw new Error('the leftover work of an earlier call'); });
    channel.unref();
    return [];
  },
  pokeChannel: async () => {
    const channel = new BroadcastChannel('pool-leftover');
    channel.postMessage('poke');
    await new Promise((resolve) => setTimeout(resolve, 100));
    channel.close();
    return [];
  },
  leaveRequest: async (client) => { setTimeout(() => void client.fetch('https://x.invalid/late').catch(() => undefined), 1); return [{ thread: thread() }]; },
  remember: async (client) => {
    const seen = memo ?? null;
    memo = client.ontologyRid;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [{ thread: thread(), seen, rid: client.ontologyRid }];
  },
  listen: async (client) => {
    const channel = new BroadcastChannel('pool-test');
    channel.onmessage = () => channel.postMessage(client.ontologyRid);
    channel.unref();
    return [];
  },
  ask: async () => {
    const channel = new BroadcastChannel('pool-test');
    const heard = await new Promise((resolve) => {
      channel.onmessage = ({ data }) => resolve(data);
      channel.postMessage('ask');
      setTimeout(() => resolve(null), 1000);
    });
    channel.close();
    return [{ heard }];
  },
  wait: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return [{ thread: thread() }]; },
  hold: async () => {
    const channel = new BroadcastChannel('pool-test-hold');
    channel.postMessage('holding');
    channel.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return [{ thread: thread() }];
  },
  keepClient: async (client) => { kept ??= client; const response = await kept.fetch('https://x.invalid/read'); return [{ thread: thread(), path: await response.text() }]; },
  values: async () => [{ properties: { nan: 0 / 0, infinity: 1 / 0, absent: undefined, when: new Date(0) } }],
  throwError: async () => { throw new Error('a plain error'); },
  refuseNamed: async () => { throw Object.assign(new Error('ein must match'), { parameterId: 'ein' }); },
  refuseNumber: async () => { throw Object.assign(new Error('ein must match'), { parameterId: 7 }); },
  refuseInherited: async () => { throw Object.create(Object.assign(new Error('ein must match'), { parameterId: 'ein' })); },
  importMissing: async () => { await import('a-module-that-is-not-there'); return []; },
  hangOnFetch: async (client) => { await client.fetch('https://x.invalid/hang'); return []; },
};
`;

const exits = new Map<number, Promise<void>>();

process.on('worker', (worker) => {
  exits.set(worker.threadId, new Promise((resolve) => worker.once('exit', () => resolve())));
});

const exitOf = (thread: number | undefined) =>
  exits.get(thread ?? -1) ?? Promise.reject(new Error(`No worker has the thread ${thread}.`));

const paths: string[] = [];
let slowAnswers = 0;
let slowAnswered = Promise.withResolvers<undefined>();

const bridge: Bridge = async (request) => {
  const { pathname } = new URL(request.url);

  paths.push(pathname);

  if (pathname === '/slow') {
    await new Promise((resolve) => setTimeout(resolve, 200));

    slowAnswers += 1;

    slowAnswered.resolve(undefined);

    return { status: 500, headers: [], body: '' };
  }

  return { status: 200, headers: [], body: pathname };
};

const RID = 'ri.ontology.main.ontology.test';

const settleOn = (ontologyRid: string, fn: string) =>
  settle(callFunction({ bundle: BUNDLE, function: fn, inputs: [], ontologyRid }, bridge));

const callOn = async (ontologyRid: string, fn: string) => {
  const ran = await settleOn(ontologyRid, fn);

  if (!ran.ok) throw ran.error;

  return ran.value;
};

const call = (fn: string) => callOn(RID, fn);
const threadOf = (edits: unknown) => (edits as { thread: number }[])[0]?.thread;

async function failureOf(fn: string): Promise<unknown> {
  const ran = await settleOn(RID, fn);

  if (ran.ok) throw new Error(`${fn} did not fail.`);

  return ran.error instanceof RunFailure ? ran.error.failure : ran.error;
}

describe('the warm workers', () => {
  it('ontology/functions/functions#runtime: a timer that a call leaves behind does not fail the next call', async () => {
    const first = await call('leaveThrow');

    const second = await call('wait');

    expect(second).toEqual([{ thread: expect.any(Number) }]);
    expect(threadOf(second)).not.toBe(threadOf(first));
  });

  it.each([
    'leaveInterval',
    'leaveTimeout',
    'leaveImmediateLoop',
    'leaveRefThenUnref',
    'leaveTimersModule',
    'leavePromiseTimer',
    'leaveRefresh',
  ])(
    "ontology/functions/functions#runtime: an unref'd timer that a call leaves behind does not run in the next call (%s)",
    async (fn) => {
      const first = await call(fn);

      expect(threadOf(await call('wait'))).not.toBe(threadOf(first));
    },
  );

  describe('process exit after an idle worker', () => {
    let exit: { code: number | null; stdout: string };

    beforeAll(async () => {
      const pool = new URL('./pool.ts', import.meta.url).href;
      const errors = new URL('../errors/index.ts', import.meta.url).href;

      const script = `const { callFunction } = await import(${JSON.stringify(pool)});
        const { settle } = await import(${JSON.stringify(errors)});
        const bundle = 'export const createClient = () => ({}); export const functions = { one: async () => [] };';
        const ran = await settle(callFunction({ bundle, function: 'one', inputs: [], ontologyRid: 'ri.x' }, async () => ({ status: 200, headers: [], body: '' })));
        console.log(JSON.stringify(ran.ok ? ran.value : ran.error.message));`;

      const file = join(mkdtempSync(join(tmpdir(), 'pool-exit-')), 'call.mjs');

      writeFileSync(file, script);

      exit = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = execFile(process.execPath, [file], { timeout: 10_000 }, (_error, stdout) =>
          resolve({ code: child.exitCode, stdout }),
        );
      });
    });

    it('ontology/functions/functions#runtime: an idle worker does not keep the process alive after a call', () => {
      expect(exit).toEqual({ code: 0, stdout: '[]\n' });
    });
  });

  it('ontology/functions/functions#runtime: a call that leaves nothing behind keeps its worker warm', async () => {
    const first = await call('wait');

    expect(threadOf(await call('wait'))).toBe(threadOf(first));
  });

  it('a client request after the end of its call gets no answer, and the worker leaves the pool', async () => {
    paths.length = 0;

    const first = await call('leaveRequest');

    await exitOf(threadOf(first));

    expect(paths).not.toContain('/late');

    expect(threadOf(await call('wait'))).not.toBe(threadOf(first));
  });

  it('ontology/functions/functions#errors: a client request that answers after its call ended reaches neither the Function nor the call, and the worker leaves the pool', async () => {
    slowAnswers = 0;

    slowAnswered = Promise.withResolvers<undefined>();

    const first = await call('leaveRead');

    expect(slowAnswers).toBe(0);

    await slowAnswered.promise;

    expect(slowAnswers).toBe(1);

    expect(threadOf(await call('wait'))).not.toBe(threadOf(first));
  });

  it('ontology/functions/functions#runtime: work that a Function leaves on a channel can stop its warm worker during a later call, and that call fails', async () => {
    const rid = 'ri.ontology.main.ontology.leftover';

    await callOn(rid, 'leaveChannel');

    const poked = await settleOn(rid, 'pokeChannel');

    const failure = poked.ok ? undefined : poked.error instanceof RunFailure ? poked.error.failure : poked.error;

    expect(failure).toMatchObject({
      kind: 'stopped',
      started: true,
      cause: expect.objectContaining({ message: 'the leftover work of an earlier call' }),
    });
  });

  it('a client that a Function keeps at module scope sends its requests in the later call', async () => {
    const first = await call('keepClient');

    const second = await call('keepClient');

    expect(second).toEqual([{ thread: threadOf(first), path: '/read' }]);
  });
});

describe('the workers of 2 or more installations of 1 product', () => {
  const other = (n: number) => `ri.ontology.main.ontology.other-${n}`;

  it('ontology/functions/functions#runtime: a worker runs the calls of 1 installation, also when more installations than workers take turns', async () => {
    const installations = new Map<number, Set<string>>();

    for (const rid of [RID, other(1), other(2), RID, other(2), other(1), RID]) {
      const thread = threadOf(await callOn(rid, 'wait'));

      if (thread === undefined) throw new Error('The call gave no thread.');

      installations.set(thread, (installations.get(thread) ?? new Set()).add(rid));
    }

    for (const rids of installations.values()) expect(rids.size).toBe(1);
  });

  it('ontology/functions/functions#runtime: a call that waits for a worker never reads the module state of another installation, also when it gets a worker that another installation freed', async () => {
    for (let round = 0; round < 3; round += 1) {
      const results = await Promise.all(
        [...Array(6).keys()].map((n) => callOn(other(10 + ((n + round) % 4)), 'remember')),
      );

      for (const [result] of results as { seen: string | null; rid: string }[][])
        expect([null, result?.rid]).toContain(result?.seen);
    }
  });

  it('ontology/functions/functions#runtime: a BroadcastChannel that a Function opens on purpose reaches a worker of another installation', async () => {
    await callOn(other(20), 'listen');

    expect(await callOn(other(21), 'ask')).toEqual([{ heard: other(20) }]);
  });

  it('a call of a third installation retires 1 worker, and the other installation keeps its warm worker', async () => {
    await callOn(other(30), 'wait');

    const kept = threadOf(await callOn(other(31), 'wait'));

    await callOn(other(32), 'wait');

    expect(threadOf(await callOn(other(31), 'wait'))).toBe(kept);
  });

  it('2 installations that take turns each keep their own warm worker', async () => {
    const first = threadOf(await callOn(RID, 'wait'));

    const theirs = threadOf(await callOn(other(1), 'wait'));

    expect(theirs).not.toBe(first);

    expect(threadOf(await callOn(RID, 'wait'))).toBe(first);

    expect(threadOf(await callOn(other(1), 'wait'))).toBe(theirs);
  });

  it('starts a new worker when 1 installation publishes a new bundle, and reuses the warm worker while the bundle stays the same', async () => {
    const rid = other(40);

    const first = threadOf(await callOn(rid, 'wait'));

    expect(threadOf(await callOn(rid, 'wait'))).toBe(first);

    const updated = `${BUNDLE}\n// version 2`;

    const ran = await settle(callFunction({ bundle: updated, function: 'wait', inputs: [], ontologyRid: rid }, bridge));

    if (!ran.ok) throw ran.error;

    expect(threadOf(ran.value)).not.toBe(first);
  });
});

describe('the wait for a free worker', () => {
  it('a third call that finds no free worker within the wait limit fails, and the 2 calls that hold the workers finish', async () => {
    const started = Date.now();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

    try {
      const holds = new BroadcastChannel('pool-test-hold');

      const holding = new Promise((resolve) => {
        let posts = 0;

        holds.onmessage = () => {
          posts += 1;

          if (posts === 2) resolve(undefined);
        };
      });

      const calls = Promise.all([settleOn(RID, 'hold'), settleOn(RID, 'hold'), settleOn(RID, 'wait')]);

      await holding;

      holds.close();

      await vi.advanceTimersByTimeAsync(WAIT_LIMIT_MS);

      const [first, second, third] = await calls;

      expect(third).toEqual({
        ok: false,
        error: new Error(`No worker was free for ${WAIT_LIMIT_MS} ms, so the Function did not run.`),
      });

      expect([first.ok, second.ok]).toEqual([true, true]);

      const stack = third?.ok === false ? third.error.stack : undefined;

      expect(stack).toContain('pool.ts');
      expect(stack).not.toMatch(/at (async )?(wait|acquire|callFunction) /);
    } finally {
      vi.useRealTimers();
    }

    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a call that waits gets the first worker that a call frees', async () => {
    const [, , third] = await Promise.all([settleOn(RID, 'wait'), settleOn(RID, 'wait'), settleOn(RID, 'wait')]);

    expect(third?.ok).toBe(true);
  });
});

describe('the edits and the errors of a call', () => {
  it('a NaN and an infinity reach the value check as numbers, and an undefined value is dropped, as in JSON', async () => {
    expect(await call('values')).toEqual([
      { properties: { nan: NaN, infinity: Infinity, when: '1970-01-01T00:00:00.000Z' } },
    ]);
  });

  it('a stack frame and an error message name the bundle, not its data: URL', async () => {
    const thrown = (await failureOf('throwError')) as { kind: string; thrown: { stack: string } };

    expect(thrown.kind).toBe('threw');
    expect(thrown.thrown.stack).toContain('function-bundle.js');
    expect(thrown.thrown.stack).not.toContain('data:');

    const missing = (await failureOf('importMissing')) as { thrown: { message: string } };

    expect(missing.thrown.message.length).toBeLessThan(1000);
    expect(missing.thrown.message).not.toContain('data:');
  });

  it('ontology/functions/functions#errors: an own string parameterId of a thrown Error crosses the worker boundary, and another value does not', async () => {
    expect(await failureOf('refuseNamed')).toMatchObject({
      kind: 'threw',
      thrown: { error: true, message: 'ein must match', parameterId: 'ein' },
    });

    const number = (await failureOf('refuseNumber')) as object;

    expect(number).toMatchObject({ kind: 'threw', thrown: { error: true, message: 'ein must match' } });
    expect(number).not.toHaveProperty('thrown.parameterId');

    expect((await failureOf('refuseInherited')) as object).not.toHaveProperty('thrown.parameterId');

    expect((await failureOf('throwError')) as object).not.toHaveProperty('thrown.parameterId');
  });

  it('aborts in-flight bridge request signals when a Function hits TIME_LIMIT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const fetchArrived = Promise.withResolvers<AbortSignal>();
    const signalAborted = Promise.withResolvers<boolean>();

    const abortAwareBridge: Bridge = (request) => {
      fetchArrived.resolve(request.signal);

      return new Promise((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            signalAborted.resolve(request.signal.aborted);

            resolve({ status: 500, headers: [], body: '' });
          },
          { once: true },
        );
      });
    };

    try {
      const pending = settle(
        callFunction(
          { bundle: BUNDLE, function: 'hangOnFetch', inputs: [], ontologyRid: 'ri.ontology.main.ontology.abort-test' },
          abortAwareBridge,
        ),
      );

      const signal = await fetchArrived.promise;

      expect(signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);

      const result = await pending;

      expect(await signalAborted.promise).toBe(true);

      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : (result.error as RunFailure).failure).toEqual({ kind: 'timedOut' });
    } finally {
      vi.useRealTimers();
    }
  });
});
