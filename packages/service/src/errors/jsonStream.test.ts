import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DbFailure } from '../db/index.ts';
import { settle, type FallibleStream } from './index.ts';
import { orThrow } from './fallible.ts';
import { jsonStream } from './jsonStream.ts';

let consoleLog: MockInstance<typeof console.log>;

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

async function readChunks(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(decoder.decode(next.value, { stream: true }));
  }

  const final = decoder.decode();

  if (final.length > 0) chunks.push(final);

  return chunks;
}

describe('batched jsonStream framing and backpressure', () => {
  it('batches many items into fewer chunks while preserving exact JSON output', async () => {
    const total = 200;

    async function* objects(): AsyncGenerator<{ id: number; label: string }> {
      for (let i = 0; i < total; i += 1) yield { id: i, label: `item-${i}` };
    }

    const body = await orThrow(
      jsonStream(
        () => ({ totalCount: String(total) }),
        'data',
        objects(),
        () => ({ nextPageToken: 'tok-1' }),
      ),
    );

    const chunks = await readChunks(body);

    expect(chunks.length).toBeLessThan(10);
    expect(chunks.length).toBeGreaterThan(2);

    const parsed = JSON.parse(chunks.join('')) as {
      totalCount: string;
      data: { id: number; label: string }[];
      nextPageToken: string;
    };

    expect(parsed.totalCount).toBe(String(total));
    expect(parsed.nextPageToken).toBe('tok-1');
    expect(parsed.data).toHaveLength(total);
    expect(parsed.data[0]).toEqual({ id: 0, label: 'item-0' });
    expect(parsed.data.at(-1)).toEqual({ id: 199, label: 'item-199' });
  });

  it('produces exact empty and non-empty JSON for an empty head like editsHistory', async () => {
    async function* empty(): AsyncGenerator<unknown> {}

    const emptyBody = await orThrow(
      jsonStream(
        () => ({}),
        'data',
        empty(),
        () => ({ totalCount: 0 }),
      ),
    );

    expect(await new Response(emptyBody).text()).toBe('{"data":[],"totalCount":0}');

    async function* single(): AsyncGenerator<{ id: string }> {
      yield { id: 'a' };
    }

    const singleBody = await orThrow(
      jsonStream(
        () => ({}),
        'data',
        single(),
        () => ({ totalCount: 1 }),
      ),
    );

    const chunks = await readChunks(singleBody);

    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe('{"data":[{"id":"a"}],"totalCount":1}');
  });

  it('flushes chunks bounded by byte size for large items and stops pulling when cancelled', async () => {
    const payload = 'x'.repeat(10_000);
    let yielded = 0;
    let closed = false;

    async function* large(): AsyncGenerator<{ payload: string }> {
      try {
        for (let i = 0; i < 100; i += 1) {
          yielded += 1;

          yield { payload };
        }
      } finally {
        closed = true;
      }
    }

    const body = await orThrow(
      jsonStream(
        () => ({}),
        'data',
        large(),
        () => ({}),
      ),
    );

    const reader = body.getReader();

    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(yielded).toBeLessThan(10);

    await reader.cancel();

    expect(closed).toBe(true);
  });
});

describe('a streamed body that fails after the first item', () => {
  it('service/observability#logs: writes 1 log line with the stack of the error, and the body fails with no internals', async () => {
    async function* objects(): AsyncGenerator<Record<string, unknown>> {
      yield { accountId: 'acc-1' };

      throw new Error('the database connection closed');
    }

    const body = await orThrow(
      jsonStream(
        () => ({ totalCount: '2' }),
        'data',
        objects(),
        () => ({}),
      ),
    );

    await expect(new Response(body).text()).rejects.toThrow('the database connection closed');

    expect(consoleLog.mock.calls.map(([text]) => JSON.parse(String(text)) as unknown)).toEqual([
      { stack: expect.stringMatching(/^Error: the database connection closed\n\s+at /) },
    ]);
  });

  it('service/http-api#requests: an item that fails to serialize ends the source items, so a database stream frees its client', async () => {
    let finished = false;

    async function* objects(): AsyncGenerator<Record<string, unknown>> {
      try {
        yield { accountId: 'acc-1' };

        yield { accountId: 'acc-2', seats: 1n };

        yield { accountId: 'acc-3' };
      } finally {
        finished = true;
      }
    }

    const body = await orThrow(
      jsonStream(
        () => ({ totalCount: '3' }),
        'data',
        objects(),
        () => ({}),
      ),
    );

    await expect(new Response(body).text()).rejects.toThrow(TypeError);

    expect(finished).toBe(true);
    expect(consoleLog).toHaveBeenCalledTimes(1);
  });
});

describe('a source stream that returns its failure', () => {
  const closed = new Error('the database connection closed');
  const failure: DbFailure = { kind: 'refused', error: closed };
  let finished = 0;

  async function* rows(count: number): FallibleStream<Record<string, unknown>, DbFailure> {
    try {
      for (let n = 1; n <= count; n += 1) yield { accountId: `acc-${n}` };

      return failure;
    } finally {
      finished += 1;
    }
  }

  it('service/code-layout#errors: a failure before the first item is the failure of the call, and no body starts', async () => {
    expect(
      await settle(
        jsonStream(
          () => ({}),
          'data',
          rows(0),
          () => ({}),
        ),
      ),
    ).toEqual({ ok: false, error: failure });

    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('service/observability#logs: a failure after the first item fails the body with the error of the failure, and writes 1 log line with its stack', async () => {
    finished = 0;

    const body = await orThrow(
      jsonStream(
        () => ({ totalCount: '2' }),
        'data',
        rows(1),
        () => ({}),
      ),
    );

    await expect(new Response(body).text()).rejects.toBe(closed);

    expect(consoleLog.mock.calls.map(([text]) => JSON.parse(String(text)) as unknown)).toEqual([
      { stack: closed.stack },
    ]);

    expect(finished).toBe(1);
  });
});
