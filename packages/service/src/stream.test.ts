import { createServer, get, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { sendResponse } from './node.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';

const servers: Server[] = [];

afterEach(() => Promise.all(servers.splice(0).map(closeServer)));

async function serveOnce(response: () => Response): Promise<string> {
  const server = createServer((_incoming, outgoing) => void sendResponse(response(), outgoing));

  servers.push(server);

  return listenLocal(server);
}

describe('a streamed body that fails part way', () => {
  it('gives the client a network error, not a cut body with status 200', async () => {
    const url = await serveOnce(() => {
      const encoder = new TextEncoder();

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"data":[{"accountId":"acc-1"}'));
        },
        pull(controller) {
          controller.error(new Error('the database connection closed'));
        },
      });

      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(fetch(url).then((response) => response.text())).rejects.toThrow();
  });

  it('sends a body that completes', async () => {
    const url = await serveOnce(() => Response.json({ data: [] }));

    const response = await fetch(url);

    expect(await response.json()).toEqual({ data: [] });
  });

  it('reads the source at most 400 chunks ahead of what the client received', async () => {
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;

    const url = await serveOnce(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;

              if (pulled > 2_000) controller.close();
              else controller.enqueue(chunk);
            },
          }),
        ),
    );

    const response = await new Promise<IncomingMessage>((resolve) => get(url, resolve));

    let received = 0;
    let ahead = 0;

    response.on('data', (data: Buffer) => {
      received += data.length;

      ahead = Math.max(ahead, pulled - received / chunk.length);
    });

    await new Promise((resolve) => response.on('end', resolve));

    expect(received).toBe(2_000 * chunk.length);
    expect(ahead).toBeLessThan(400);
  });
});
