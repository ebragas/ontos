import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { settle } from '../errors/index.ts';
import { WAIT_LIMIT_MS } from './limits.ts';
import { callFunction } from './pool.ts';

const threads = { alive: 0, most: 0, exits: [] as Promise<unknown>[] };

process.on('worker', (worker) => {
  threads.alive += 1;
  threads.most = Math.max(threads.most, threads.alive);

  threads.exits.push(
    new Promise((resolve) => {
      worker.once('exit', () => {
        threads.alive -= 1;

        resolve(undefined);
      });
    }),
  );
});

const BUNDLE = `
export const createClient = () => ({});
export const functions = {
  wait: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return []; },
  block: async () => {
    const channel = new BroadcastChannel('pool-replace-test');
    channel.onmessage = ({ data: port }) => process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['-e', \`require('node:net').connect(\${port}).on('close', () => process.exit())\`]);
    channel.unref();
    return [];
  },
};
`;

const bridge = () => Promise.resolve({ status: 200, headers: [] as [string, string][], body: '' });

const callOn = (installation: string, fn = 'wait') =>
  settle(
    callFunction(
      { bundle: BUNDLE, function: fn, inputs: [], ontologyRid: `ri.ontology.main.ontology.replace-${installation}` },
      bridge,
    ),
  );

describe('the wait for the worker that replaces a worker of another installation', () => {
  it('ends at the wait limit, and the pool serves calls again after the old worker exits', async () => {
    await Promise.all([callOn('a', 'block'), callOn('a', 'block')]);

    const children: Socket[] = [];
    const server = createServer();

    const bothBlocked = new Promise((resolve) => {
      server.on('connection', (socket: Socket) => {
        if (children.push(socket) === 2) resolve(undefined);
      });
    });

    server.listen(0);

    await once(server, 'listening');

    const channel = new BroadcastChannel('pool-replace-test');

    channel.postMessage((server.address() as { port: number }).port);

    channel.close();

    await bothBlocked;

    const started = Date.now();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

    try {
      const refused = expect(callOn('b')).resolves.toEqual({
        ok: false,
        error: new Error(`No worker was free for ${WAIT_LIMIT_MS} ms, so the Function did not run.`),
      });

      await vi.advanceTimersByTimeAsync(WAIT_LIMIT_MS);

      await refused;
    } finally {
      vi.useRealTimers();
    }

    expect(Date.now() - started).toBeLessThan(1500);

    for (const child of children) child.destroy();

    server.close();

    await Promise.race(threads.exits);

    await expect(callOn('b')).resolves.toEqual({ ok: true, value: [] });

    await expect(callOn('c')).resolves.toEqual({ ok: true, value: [] });

    expect(threads.most).toBe(2);
  });
});
