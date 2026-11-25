import { describe, expect, it } from 'vitest';
import { settle } from '../errors/index.ts';
import { callFunction } from './pool.ts';

const threads = { alive: 0, most: 0 };

process.on('worker', (worker) => {
  threads.alive += 1;
  threads.most = Math.max(threads.most, threads.alive);

  worker.once('exit', () => {
    threads.alive -= 1;
  });
});

const BUNDLE = `
export const createClient = () => ({});
export const functions = {
  wait: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return []; },
  leaveTimer: async () => { setTimeout(() => undefined, 200); return []; },
};
`;

const bridge = () => Promise.resolve({ status: 200, headers: [] as [string, string][], body: '' });

const callOn = async (installation: number, fn = 'wait') => {
  const ran = await settle(
    callFunction(
      { bundle: BUNDLE, function: fn, inputs: [], ontologyRid: `ri.ontology.main.ontology.limit-${installation}` },
      bridge,
    ),
  );

  if (!ran.ok) throw ran.error;

  return ran.value;
};

describe('the worker limit', () => {
  it('no more than 2 worker threads are alive at once, also while a retired worker has not exited', async () => {
    for (let call = 0; call < 12; call += 1) await callOn(call % 4);

    expect(threads.most).toBe(2);
  });

  it('no more than 2 worker threads are alive at once under concurrent calls of 8 installations, and each call runs', async () => {
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.allSettled(
        [...Array(8).keys()].map((installation) => callOn(installation + round)),
      );

      expect(results.map(({ status }) => status)).toEqual(Array(8).fill('fulfilled'));
    }

    expect(threads.most).toBe(2);
  });

  it('no more than 2 worker threads are alive at once while calls that leave a timer open stop their workers', async () => {
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.allSettled(
        [...Array(6).keys()].map((n) => callOn(n % 2, n % 3 === 0 ? 'wait' : 'leaveTimer')),
      );

      expect(results.map(({ status }) => status)).toEqual(Array(6).fill('fulfilled'));
    }

    expect(threads.most).toBe(2);
  });
});
