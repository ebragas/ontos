import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { settle } from '../errors/index.ts';
import { rootSpan } from '../spans/index.ts';
import { recordSpans, settle as settleSpans } from '../tracing.test-utils.ts';
import type { Bridge } from './pool.ts';

const BUNDLE = `
export const createClient = () => ({});
const thread = () => process.getBuiltinModule('node:worker_threads').threadId;
export const functions = {
  one: async () => [{ thread: thread(), version: 'v1' }],
};
`;

const BUNDLE_V2 = `
export const createClient = () => ({});
const thread = () => process.getBuiltinModule('node:worker_threads').threadId;
export const functions = {
  one: async () => [{ thread: thread(), version: 'v2' }],
};
`;

const bridge: Bridge = async () => ({ status: 200, headers: [], body: '' });
const RID = 'ri.ontology.main.ontology.warm-test';

type PoolModule = typeof import('./pool.ts');

const spawned: Worker[] = [];
const exits = new Map<number, Promise<void>>();

const onWorker = (worker: Worker) => {
  spawned.push(worker);

  exits.set(worker.threadId, new Promise((resolve) => worker.once('exit', () => resolve())));
};

async function freshPool(): Promise<PoolModule> {
  vi.resetModules();

  spawned.length = 0;

  exits.clear();

  process.on('worker', onWorker);

  return import('./pool.ts');
}

afterEach(async () => {
  process.off('worker', onWorker);

  const active = spawned.splice(0);

  await Promise.all(active.map((worker) => worker.terminate()));
});

describe('warmWorker', () => {
  beforeAll(async () => {
    await import('./pool.ts');
  });

  it('pre-warms 1 worker so the first callFunction reuses it and skips bundle load', async () => {
    const { callFunction, warmWorker } = await freshPool();

    await warmWorker({ ontologyRid: RID, bundle: BUNDLE });

    expect(spawned).toHaveLength(1);

    const warmedThread = spawned[0]?.threadId;

    const recorder = recordSpans();

    try {
      const ran = await rootSpan(
        { 'route.key': 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply', 'route.access': 'ontology' },
        async () => {
          const result = await settle(
            callFunction({ ontologyRid: RID, bundle: BUNDLE, function: 'one', inputs: [] }, bridge),
          );

          return Response.json(result.ok ? result.value : null);
        },
      );

      const body = (await ran.response.json()) as { thread: number; version: string }[];

      expect(body).toEqual([{ thread: warmedThread, version: 'v1' }]);
      expect(spawned).toHaveLength(1);

      await settleSpans();

      const spans = recorder.spans();
      const workerCall = spans.find((span) => span.name === 'worker call');
      const children = spans.filter((span) => span.parentSpanId === workerCall?.spanId).map((span) => span.name);

      expect(children).toEqual(['function body']);
    } finally {
      recorder.stop();
    }
  });

  it('deduplicates concurrent and repeated warmWorker calls for the same key', async () => {
    const { warmWorker } = await freshPool();

    await Promise.all([
      warmWorker({ ontologyRid: RID, bundle: BUNDLE }),
      warmWorker({ ontologyRid: RID, bundle: BUNDLE }),
      warmWorker({ ontologyRid: RID, bundle: BUNDLE }),
    ]);

    expect(spawned).toHaveLength(1);

    await warmWorker({ ontologyRid: RID, bundle: BUNDLE });

    expect(spawned).toHaveLength(1);
  });

  it('never exceeds MAX_WORKERS and never evicts warm workers', async () => {
    const { callFunction, warmWorker } = await freshPool();

    const rid1 = `${RID}-1`;
    const rid2 = `${RID}-2`;
    const rid3 = `${RID}-3`;

    await Promise.all([
      warmWorker({ ontologyRid: rid1, bundle: BUNDLE }),
      warmWorker({ ontologyRid: rid2, bundle: BUNDLE }),
      warmWorker({ ontologyRid: rid3, bundle: BUNDLE }),
    ]);

    expect(spawned).toHaveLength(2);

    const threads = spawned.map((worker) => worker.threadId);

    const first = await settle(
      callFunction({ ontologyRid: rid1, bundle: BUNDLE, function: 'one', inputs: [] }, bridge),
    );

    const second = await settle(
      callFunction({ ontologyRid: rid2, bundle: BUNDLE, function: 'one', inputs: [] }, bridge),
    );

    if (!first.ok) throw first.error;

    if (!second.ok) throw second.error;

    expect([
      (first.value as { thread: number }[])[0]?.thread,
      (second.value as { thread: number }[])[0]?.thread,
    ]).toEqual(threads);

    expect(spawned).toHaveLength(2);
  });

  it.each([
    ['syntax error', 'export const functions = {{{;'],
    ['top-level throw', 'throw new Error("boom at module load");'],
    [
      'leftover timer',
      'setInterval(() => undefined, 10).unref(); export const createClient = () => ({}); export const functions = {};',
    ],
    ['worker exit', 'process.exit(1);'],
  ])('retires the bad slot cleanly and never rejects on %s', async (_kind, broken) => {
    const { callFunction, warmWorker } = await freshPool();

    await expect(warmWorker({ ontologyRid: RID, bundle: broken })).resolves.toBeUndefined();

    expect(spawned).toHaveLength(1);

    const failedThread = spawned[0]?.threadId;

    await exits.get(failedThread ?? -1);

    const ran = await settle(callFunction({ ontologyRid: RID, bundle: BUNDLE, function: 'one', inputs: [] }, bridge));

    if (!ran.ok) throw ran.error;

    expect((ran.value as { thread: number; version: string }[])[0]?.thread).not.toBe(failedThread);
  });

  it('respects a publish bundle change and does not reuse a worker warmed for an earlier bundle', async () => {
    const { callFunction, warmWorker } = await freshPool();

    await warmWorker({ ontologyRid: RID, bundle: BUNDLE });

    const v1Thread = spawned[0]?.threadId;

    const ran = await settle(
      callFunction({ ontologyRid: RID, bundle: BUNDLE_V2, function: 'one', inputs: [] }, bridge),
    );

    if (!ran.ok) throw ran.error;

    const [result] = ran.value as { thread: number; version: string }[];

    expect(result?.version).toBe('v2');
    expect(result?.thread).not.toBe(v1Thread);
  });

  it('hands an in-flight warm slot to a callFunction of the same key, and spawns slot 2 for a different key', async () => {
    const { callFunction, warmWorker } = await freshPool();

    const warming = warmWorker({ ontologyRid: RID, bundle: BUNDLE });
    const sameKey = settle(callFunction({ ontologyRid: RID, bundle: BUNDLE, function: 'one', inputs: [] }, bridge));

    const otherKey = settle(
      callFunction({ ontologyRid: `${RID}-other`, bundle: BUNDLE, function: 'one', inputs: [] }, bridge),
    );

    const [, sameResult, otherResult] = await Promise.all([warming, sameKey, otherKey]);

    expect(spawned).toHaveLength(2);

    if (!sameResult.ok) throw sameResult.error;

    if (!otherResult.ok) throw otherResult.error;

    expect((sameResult.value as { thread: number }[])[0]?.thread).toBe(spawned[0]?.threadId);
    expect((otherResult.value as { thread: number }[])[0]?.thread).toBe(spawned[1]?.threadId);
  });

  describe('process exit after pre-warming', () => {
    let idleExit: { code: number | null; stdout: string };
    let crashExit: { code: number | null; stdout: string };

    beforeAll(async () => {
      const pool = new URL('./pool.ts', import.meta.url).href;

      const runScript = (prefix: string, script: string) => {
        const file = join(mkdtempSync(join(tmpdir(), prefix)), 'warm.mjs');

        writeFileSync(file, script);

        return new Promise<{ code: number | null; stdout: string }>((resolve) => {
          const child = execFile(process.execPath, [file], { timeout: 10_000 }, (_error, stdout) =>
            resolve({ code: child.exitCode, stdout }),
          );
        });
      };

      [idleExit, crashExit] = await Promise.all([
        runScript(
          'pool-warm-exit-',
          `const { warmWorker } = await import(${JSON.stringify(pool)});
          const bundle = 'export const createClient = () => ({}); export const functions = { one: async () => [] };';
          await warmWorker({ ontologyRid: 'ri.x', bundle });
          console.log('warmed');`,
        ),
        runScript(
          'pool-warm-crash-',
          `const { warmWorker } = await import(${JSON.stringify(pool)});
          await warmWorker({ ontologyRid: 'ri.x', bundle: 'process.exit(1);' });
          console.log('settled');`,
        ),
      ]);
    });

    it('does not keep the Node process alive with an idle pre-warmed worker', () => {
      expect(idleExit).toEqual({ code: 0, stdout: 'warmed\n' });
    });

    it('settles top-level await and exits with code 0 when a pre-warmed bundle calls process.exit(1)', () => {
      expect(crashExit).toEqual({ code: 0, stdout: 'settled\n' });
    });
  });
});
