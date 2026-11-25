#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createPool } from './db/index.ts';
import { caught } from './errors/index.ts';
import { handle, inputFromEnv, type HandleInput, type MissingSettings } from './handler/index.ts';

type NodeServerOptions = HandleInput | MissingSettings;

export function createNodeServer(options: NodeServerOptions): Server {
  return createServer((incoming, outgoing) => {
    void serveOrFail(incoming, outgoing, options);
  });
}

async function serveOrFail(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: NodeServerOptions,
): Promise<void> {
  const served = await caught(async () => {
    const request = toRequest(incoming);

    if (!request) {
      outgoing.writeHead(400, { 'content-type': 'application/json' });

      outgoing.end(
        JSON.stringify({ errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: {} }),
      );

      return;
    }

    const response = await handle(request, options);

    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';

    if (hasBody && !incoming.readableEnded) {
      outgoing.setHeader('connection', 'close');

      incoming.resume();
    }

    await sendResponse(response, outgoing);
  });

  if (served.ok) return;

  console.error(served.error);

  if (!outgoing.headersSent) outgoing.writeHead(500);

  outgoing.end();
}

export async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));

  if (!response.body) {
    outgoing.end();

    return;
  }

  const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);

  await caught(() => pipeline(source, outgoing));
}

function toRequest(incoming: IncomingMessage): Request | undefined {
  const rawUrl = incoming.url ?? '/';

  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return undefined;

  const url = URL.parse(rawUrl, 'http://localhost');

  if (!url) return undefined;

  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }

  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';

  return new Request(url, {
    method: incoming.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  });
}

export function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve) =>
    server.listen(port, () => resolve(`http://localhost:${(server.address() as AddressInfo).port}`)),
  );
}

interface Endable {
  end(): Promise<void>;
}

interface SignalSource {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export function registerGracefulShutdown(
  server: Server,
  pools: readonly Endable[],
  signals: SignalSource = process,
): () => Promise<void> {
  let closing: Promise<void> | undefined;

  const onRequest = (_incoming: IncomingMessage, outgoing: ServerResponse): void => {
    if (closing && !outgoing.headersSent) outgoing.setHeader('connection', 'close');

    outgoing.once('finish', () => {
      if (closing) setImmediate(() => server.closeIdleConnections());
    });
  };

  const onSignal = (): void => {
    void shutdown();
  };

  const detach = (): void => {
    signals.off('SIGTERM', onSignal);

    signals.off('SIGINT', onSignal);
  };

  const shutdown = (): Promise<void> => {
    if (closing) return closing;

    detach();

    closing = (async () => {
      await caught(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());

            server.closeIdleConnections();
          }),
      );

      server.off('request', onRequest);

      await caught(() =>
        Promise.all(
          [...new Set(pools)].map(async (pool) => {
            const ended = await caught(() => pool.end());

            if (!ended.ok) console.error('Pool shutdown failed.', ended.error);
          }),
        ),
      );
    })();

    return closing;
  };

  server.prependListener('request', onRequest);

  signals.once('SIGTERM', onSignal);

  signals.once('SIGINT', onSignal);

  server.once('close', () => {
    detach();

    server.off('request', onRequest);
  });

  return shutdown;
}

if (import.meta.main) {
  Error.stackTraceLimit = 30;

  const pools: Endable[] = [];

  const server = createNodeServer(
    inputFromEnv(process.env, (connectionString) => {
      const pool = createPool(connectionString);

      pools.push(pool);

      return pool;
    }),
  );

  registerGracefulShutdown(server, pools);

  // D1: the top-level await of a process entry; Node reads its rejection, such as a bad PORT, and exits with the error.
  const url = await listen(server, Number(process.env.PORT ?? 8080));

  console.log(`Ontology service on ${url}`);
}
