import { describe, expect, it } from 'vitest';
import { rootSpan, type BodyEnd } from './index.ts';
import { readerOf } from '../service.test-utils.ts';

const ATTRIBUTES = { 'route.key': 'GET /api/ontology-service/v1/client-config', 'route.access': 'public' } as const;
const CHUNK = new TextEncoder().encode('{"data":[');

function body(next: Promise<'close' | Error>): ReadableStream<Uint8Array> {
  let sent = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!sent) {
          sent = true;

          controller.enqueue(CHUNK);

          return;
        }

        const end = await next;

        if (end === 'close') controller.close();
        else throw end;
      },
    },
    { highWaterMark: 0 },
  );
}

const answerOf = (response: Response) => rootSpan(ATTRIBUTES, () => Promise.resolve(response));

const settledNow = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 0))]);

describe('the end of the body of a root span', () => {
  it("is 'closed' at once for an answer with no body", async () => {
    const { response, bodyEnd } = await answerOf(new Response(null, { status: 204 }));

    expect(response.status).toBe(204);

    expect(await bodyEnd).toBe('closed');
  });

  it("is 'closed' for a body that ends, and not before the client reads it", async () => {
    const { response, bodyEnd } = await answerOf(new Response(body(Promise.resolve('close'))));

    expect(await settledNow(bodyEnd)).toBe(false);

    expect(await response.text()).toBe('{"data":[');

    expect(await bodyEnd).toBe('closed');
  });

  it('is failed with the error for chunks that throw after 1 chunk', async () => {
    const failure = new Error('the connection ended');

    const { response, bodyEnd } = await answerOf(new Response(body(Promise.resolve(failure))));

    await expect(response.text()).rejects.toThrow('the connection ended');

    expect(await bodyEnd).toEqual({ failed: failure } satisfies BodyEnd);
  });

  it("is 'cancelled' when the client stops reading", async () => {
    const { response, bodyEnd } = await answerOf(new Response(body(new Promise(() => undefined))));

    const reader = readerOf(response);

    await reader.read();

    await reader.cancel();

    expect(await bodyEnd).toBe('cancelled');
  });

  it("is 'cancelled' when a pull that waits during the cancel then throws", async () => {
    let fail: (error: Error) => void = () => undefined;

    const { response, bodyEnd } = await answerOf(new Response(body(new Promise((resolve) => (fail = resolve)))));

    const reader = readerOf(response);

    await reader.read();

    const pending = reader.read();
    const cancelled = reader.cancel();

    fail(new Error('the source saw the cancel'));

    await cancelled;

    await pending;

    expect(await bodyEnd).toBe('cancelled');
  });
});
