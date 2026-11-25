import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeServer, registerGracefulShutdown } from './node.ts';
import { closeServer } from './localServer.test-utils.ts';

describe('createNodeServer request target hardening', () => {
  const server = createNodeServer({ missing: ['DATABASE_URL'] });
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  function sendRaw(path: string, host: string): Promise<{ readonly status: number; readonly body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));

        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });

      req.on('error', reject);

      req.end();
    });
  }

  it('returns 400 on protocol-relative request target instead of resolving an external origin', async () => {
    const res = await sendRaw('//evil.example/api/ontology-service/v1/client-config', 'localhost');

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ errorName: 'Default:InvalidArgument' });
  });

  it('does not crash with 500 when Host header is malformed', async () => {
    const res = await sendRaw('/api/ontology-service/v1/client-config', 'bad host:999999');

    expect(res.status).toBe(503);
  });
});

describe('registerGracefulShutdown', () => {
  it('drains in-flight requests before ending Postgres pools on SIGTERM and is idempotent', async () => {
    let releaseRequest: (() => void) | undefined;
    let requestArrived: (() => void) | undefined;

    const arrived = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });

    const server = createServer((_req, res) => {
      requestArrived?.();

      void new Promise<void>((resolve) => {
        releaseRequest = resolve;
      }).then(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });

        res.end('drained');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as AddressInfo;
    const poolA = new pg.Pool({ connectionString: 'postgres://localhost:1/unused_a' });
    const poolB = new pg.Pool({ connectionString: 'postgres://localhost:1/unused_b' });
    const signals = new EventEmitter();
    const shutdown = registerGracefulShutdown(server, [poolA, poolB], signals);

    const responsePromise = fetch(`http://127.0.0.1:${port}/slow`);

    await arrived;

    signals.emit('SIGTERM');

    signals.emit('SIGINT');

    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(poolA.ended).toBe(false);
    expect(poolB.ended).toBe(false);

    releaseRequest?.();

    const response = await responsePromise;

    expect(response.status).toBe(200);

    expect(await response.text()).toBe('drained');

    await shutdown();

    expect(poolA.ended).toBe(true);
    expect(poolB.ended).toBe(true);
    expect(server.listening).toBe(false);
  });

  it('deduplicates shared pools so pool.end() runs once on SIGTERM', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);

      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    let endCalls = 0;

    const sharedPool = {
      end: () => {
        endCalls += 1;

        return Promise.resolve();
      },
    };

    const signals = new EventEmitter();
    const shutdown = registerGracefulShutdown(server, [sharedPool, sharedPool], signals);

    signals.emit('SIGTERM');

    await shutdown();

    expect(endCalls).toBe(1);
    expect(server.listening).toBe(false);
  });

  it('handles a malformed request target synchronously returning 400 while closing without throwing ERR_HTTP_HEADERS_SENT', async () => {
    const server = createNodeServer({ missing: ['DATABASE_URL'] });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as AddressInfo;
    const signals = new EventEmitter();
    const shutdown = registerGracefulShutdown(server, [], signals);
    const uncaught: Error[] = [];

    const onUncaught = (error: Error): void => {
      uncaught.push(error);
    };

    process.on('uncaughtException', onUncaught);

    try {
      const headersStarted = new Promise<void>((resolve) => {
        server.once('connection', (serverSocket) => {
          serverSocket.once('data', () => setImmediate(resolve));
        });
      });

      const socket = connect(port, '127.0.0.1');

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);

        socket.once('error', reject);
      });

      const responsePromise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];

        socket.on('data', (chunk: Buffer) => chunks.push(chunk));

        socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));

        socket.once('error', reject);
      });

      socket.write('GET //evil.example/bad HTTP/1.1\r\nHost: localhost\r\n');

      await headersStarted;

      const closing = shutdown();

      socket.write('\r\n');

      const rawResponse = await responsePromise;

      await closing;

      expect(uncaught).toEqual([]);
      expect(rawResponse).toContain('HTTP/1.1 400 Bad Request');
      expect(rawResponse.toLowerCase()).toContain('connection: close');
      expect(server.listening).toBe(false);
    } finally {
      process.off('uncaughtException', onUncaught);

      await closeServer(server);
    }
  });

  describe('main node entrypoint SIGTERM handling', () => {
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> | undefined;

    beforeAll(async () => {
      const entry = fileURLToPath(new URL('./node.ts', import.meta.url));

      child = spawn(process.execPath, [entry], {
        env: { PATH: process.env['PATH'], PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const proc = child;

      exited = new Promise((resolve) => {
        proc.once('exit', (code, signal) => resolve({ code, signal }));
      });

      await new Promise<void>((resolve, reject) => {
        let stdout = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');

          if (stdout.includes('Ontology service on http://localhost:')) resolve();
        });

        proc.once('exit', (code, signal) => {
          reject(new Error(`Service exited before ready (code=${code}, signal=${signal})`));
        });
      });
    });

    afterAll(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });

    it('exits cleanly with code 0 on SIGTERM', async () => {
      child?.kill('SIGTERM');

      expect(await exited).toEqual({ code: 0, signal: null });
    });
  });
});
