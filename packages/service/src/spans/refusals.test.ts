import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, attempt, settle, type AsyncFallible } from '../errors/index.ts';
import { createNodeServer, sendResponse } from '../node.ts';
import { rootSpan, span, spanOf, type SpanName } from './index.ts';
import { startLocalService } from '../../testing/index.ts';
import { stubWorkos, STUB_WORKOS_KEY } from '../../testing/workos.ts';
import { createTestIssuer } from '../../testing/tokens.ts';
import { ONTOLOGY_RID } from '../ontology/stored.test-utils.ts';
import { closeServer, listenLocal } from '../localServer.test-utils.ts';
import { emptyDb, testInput } from '../service.test-utils.ts';
import { recordSpans, type SpanRecorder } from '../tracing.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

async function answerOf(response: Response): Promise<unknown> {
  const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));

  const body = (await response.text())
    .replace(/"errorInstanceId":"[^"]*"/g, '"errorInstanceId":"?"')
    .replace(/\\"errorInstanceId\\":\\"[^"\\]*\\"/g, '\\"errorInstanceId\\":\\"?\\"');

  return { status: response.status, headers, body };
}

async function rejection(run: () => Promise<unknown>, folder?: string): Promise<unknown> {
  try {
    await run();

    return { rejected: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      rejected: true,
      name: error instanceof Error ? error.constructor.name : typeof error,
      message: folder === undefined ? message : message.replaceAll(folder, '<folder>'),
    };
  }
}

describe('service/observability#traces: the spans of a failed run', () => {
  let recorder: SpanRecorder;

  beforeAll(() => {
    recorder = recordSpans();
  });

  afterAll(() => recorder.stop());

  async function failedSpan(error: unknown, start: () => unknown): Promise<unknown> {
    recorder.reset();

    let seen: unknown;
    let threw = false;

    try {
      await (async () => start())();
    } catch (caught) {
      threw = true;

      seen = caught;
    }

    const spans = recorder.spans().map(({ name, status, attributes }) => ({
      name,
      status: status.code,
      errorType: attributes['error.type'],
      message: status.message,
    }));

    return { threw, same: seen === error, spans, open: recorder.open().length };
  }

  const cases: readonly (readonly [string, unknown, (name: SpanName, failure: unknown) => unknown])[] = [
    [
      'a run that throws before it returns',
      new TypeError('CANARY-sync'),
      (name, error) =>
        span(name, {}, () => {
          throw error;
        }),
    ],
    [
      'a run whose promise rejects with an Error',
      new TypeError('CANARY-reject'),
      (name, error) =>
        span(name, {}, async () => {
          throw error;
        }),
    ],
    [
      'a run whose promise rejects with an ApiError',
      new ApiError(404, 'ObjectNotFound', { primaryKey: 'CANARY-key' }),
      (name, error) =>
        span(name, {}, async () => {
          throw error;
        }),
    ],
    [
      'a run whose promise rejects with a value that is not an Error',
      'CANARY-text',
      (name, error) =>
        span(name, {}, async () => {
          throw error;
        }),
    ],
    [
      'an iterable that throws after its first item',
      new RangeError('CANARY-iterable'),
      async (name, error) => {
        for await (const item of span(name as 'sql', {}, async function* () {
          yield 1;

          throw error;
        }))
          void item;
      },
    ],
  ];

  for (const [name, error, run] of cases) {
    it(name, async () => {
      expect(await failedSpan(error, () => run('publish store', error))).toMatchSnapshot();
    });
  }

  async function spanOfAnswer(expected: unknown, run: () => AsyncFallible<unknown, unknown>): Promise<unknown> {
    recorder.reset();

    let settled: unknown;
    let thrown: { readonly same: boolean } | undefined;

    try {
      const ran = await settle(run());

      settled = ran.ok ? { value: ran.value } : { failure: ran.error === expected ? 'same' : ran.error };
    } catch (caught) {
      thrown = { same: caught === expected };
    }

    return {
      settled,
      thrown,
      spans: recorder
        .spans()
        .map(({ name, status, attributes }) => ({ name, status: status.code, errorType: attributes['error.type'] })),
      open: recorder.open().length,
    };
  }

  const rootAttributes = {
    'route.key': 'GET /api/ontology-service/v1/client-config',
    'route.access': 'public',
  } as const;

  const apiError = new ApiError(404, 'ObjectNotFound', { primaryKey: 'CANARY-key' });
  const defect = new RangeError('CANARY-spanOf-defect');
  const syncDefect = new TypeError('CANARY-spanOf-sync');
  const errorOfDefect = new RangeError('CANARY-errorOf');

  const spanOfCases: readonly (readonly [string, unknown, () => AsyncFallible<unknown, unknown>])[] = [
    [
      'a spanOf run that returns a value',
      undefined,
      () =>
        spanOf(
          'publish store',
          {},
          () => 'unused',
          async function* (): AsyncFallible<string, string> {
            return yield* attempt(() => Promise.resolve('CANARY-value'), String);
          },
        ),
    ],
    [
      'a spanOf run that yields an ApiError',
      apiError,
      () =>
        spanOf(
          'publish store',
          {},
          (failure) => failure,
          async function* () {
            return yield apiError;
          },
        ),
    ],
    [
      'a spanOf run that yields a failure with no Error',
      'CANARY-failure',
      () =>
        spanOf(
          'publish store',
          {},
          (failure) => failure,
          async function* () {
            return yield 'CANARY-failure';
          },
        ),
    ],
    [
      'a spanOf run that throws after its first step',
      defect,
      () =>
        spanOf(
          'publish store',
          {},
          () => 'unused',
          async function* (): AsyncFallible<never, string> {
            yield* attempt(() => Promise.resolve(), String);

            throw defect;
          },
        ),
    ],
    [
      'a spanOf run that throws before it returns a generator',
      syncDefect,
      () =>
        spanOf(
          'publish store',
          {},
          () => 'unused',
          () => {
            throw syncDefect;
          },
        ),
    ],
    [
      'a spanOf errorOf that throws',
      errorOfDefect,
      () =>
        spanOf(
          'publish store',
          {},
          () => {
            throw errorOfDefect;
          },
          async function* () {
            return yield 'CANARY-failure';
          },
        ),
    ],
  ];

  for (const [name, expected, run] of spanOfCases) {
    it(name, async () => {
      expect(await spanOfAnswer(expected, run)).toMatchSnapshot();
    });
  }

  it('a root span whose run throws before it returns', async () => {
    const error = new TypeError('CANARY-root-sync');

    recorder.reset();

    let seen: unknown;

    try {
      await rootSpan(rootAttributes, () => {
        throw error;
      });
    } catch (caught) {
      seen = caught;
    }

    expect({
      same: seen === error,
      spans: recorder
        .spans()
        .map(({ name, status, attributes }) => ({ name, status: status.code, errorType: attributes['error.type'] })),
      open: recorder.open().length,
    }).toMatchSnapshot();
  });

  it('a root span whose answer has no body', async () => {
    recorder.reset();

    const { response, ids, bodyEnd } = await rootSpan(rootAttributes, () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );

    expect({
      status: response.status,
      hasIds: ids !== undefined,
      end: await bodyEnd,
      spans: recorder.spans().map(({ name, status, attributes }) => ({
        name,
        status: status.code,
        httpStatus: attributes['http.status_code'],
      })),
    }).toMatchSnapshot();
  });

  it('a body whose source fails to close at a cancel', async () => {
    recorder.reset();

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array([1])),
      cancel: () => Promise.reject(new TypeError('CANARY-close')),
    });

    const { response, bodyEnd } = await rootSpan(rootAttributes, () =>
      Promise.resolve(new Response(body, { status: 200 })),
    );

    const cancelled = await rejection(() => response.body?.cancel('CANARY-cancel') ?? Promise.resolve());

    const end = await bodyEnd;

    await new Promise((resolve) => setImmediate(resolve));

    expect({
      cancelled,
      end,
      spans: recorder
        .spans()
        .map(({ name, status, attributes }) => ({ name, status: status.code, errorType: attributes['error.type'] })),
    }).toMatchSnapshot();
  });

  it('a root span whose run rejects', async () => {
    const error = new TypeError('CANARY-root');

    recorder.reset();

    let seen: unknown;

    try {
      await rootSpan(
        {
          'route.key': 'GET /api/ontology-service/v1/client-config',
          'route.access': 'public',
        },
        () => Promise.reject(error),
      );
    } catch (caught) {
      seen = caught;
    }

    expect({
      same: seen === error,
      spans: recorder.spans().map(({ name, status, attributes }) => ({
        name,
        status: status.code,
        errorType: attributes['error.type'],
      })),
    }).toMatchSnapshot();
  });

  it('a body that fails after its first chunk', async () => {
    recorder.reset();

    let step = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        step += 1;

        if (step === 1) controller.enqueue(new Uint8Array([1]));
        else controller.error(new TypeError('CANARY-body'));
      },
    });

    const { response, bodyEnd } = await rootSpan(
      {
        'route.key': 'GET /api/ontology-service/v1/client-config',
        'route.access': 'public',
      },
      () => Promise.resolve(new Response(body, { status: 200 })),
    );

    const reader = response.body?.getReader();

    const first = await reader?.read();

    const second = await rejection(() => reader?.read() ?? Promise.resolve());

    const end = await bodyEnd;

    await new Promise((resolve) => setImmediate(resolve));

    expect({
      first: first?.value?.length,
      second,
      end:
        typeof end === 'string'
          ? end
          : {
              failed: end.failed instanceof Error ? end.failed.message : String(end.failed),
            },
      spans: recorder.spans().map(({ name, status, attributes }) => ({
        name,
        status: status.code,
        errorType: attributes['error.type'],
      })),
    }).toMatchSnapshot();
  });

  it('a body that the client cancels', async () => {
    recorder.reset();

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array([1])),
    });

    const { response, bodyEnd } = await rootSpan(
      {
        'route.key': 'GET /api/ontology-service/v1/client-config',
        'route.access': 'public',
      },
      () => Promise.resolve(new Response(body, { status: 200 })),
    );

    await response.body?.cancel('CANARY-cancel');

    const end = await bodyEnd;

    await new Promise((resolve) => setImmediate(resolve));

    expect({
      end,
      spans: recorder.spans().map(({ name, status, attributes }) => ({
        name,
        status: status.code,
        errorType: attributes['error.type'],
      })),
    }).toMatchSnapshot();
  });
});

describe('service/code-layout#http-entry: the Node adapter', () => {
  it('a request with no token', async () => {
    const server = createNodeServer({ ...testInput, db: fallibleOf(emptyDb) });

    const url = await listenLocal(server);

    try {
      expect(await answerOf(await fetch(`${url}/api/v2/ontologies/${ONTOLOGY_RID}/fullMetadata`))).toMatchSnapshot();
    } finally {
      await closeServer(server);
    }
  });

  it('a handle that rejects gives 500 and 1 line of error', async () => {
    const server = createNodeServer(undefined as never);

    const url = await listenLocal(server);

    const logged = vi.spyOn(console, 'error');

    try {
      const answer = await answerOf(await fetch(`${url}/x`));

      expect({
        answer,
        logged: logged.mock.calls.map(([error]) => (error instanceof Error ? error.constructor.name : typeof error)),
      }).toMatchSnapshot();
    } finally {
      logged.mockRestore();

      await closeServer(server);
    }
  });

  it('a body that fails after the status is sent', async () => {
    const server = createServer((_request, outgoing) => {
      let step = 0;

      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          step += 1;

          if (step === 1) controller.enqueue(new Uint8Array([1]));
          else controller.error(new TypeError('CANARY-cut'));
        },
      });

      void sendResponse(new Response(body, { status: 200 }), outgoing);
    });

    const url = await listenLocal(server);

    try {
      const response = await fetch(url);

      expect({
        status: response.status,
        body: await rejection(() => response.text()),
      }).toMatchSnapshot();
    } finally {
      await closeServer(server);
    }
  });
});

describe('service/testing#local-service: the functions of the test entry', () => {
  const folders: string[] = [];

  const folderOf = (deployment: object | undefined): string => {
    const folder = mkdtempSync(join(tmpdir(), 'service-small-'));

    folders.push(folder);

    if (deployment !== undefined) {
      mkdirSync(join(folder, '.ontology'));

      writeFileSync(join(folder, '.ontology/deployment.json'), JSON.stringify(deployment));
    }

    return folder;
  };

  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  const cli = () => Promise.resolve(0);

  it('a Postgres that is not on this computer', async () => {
    expect(
      await rejection(() =>
        startLocalService({
          app: 'probe',
          cli,
          postgres: 'postgresql://user:pass@db.example.com:5432/postgres',
        }),
      ),
    ).toMatchSnapshot();
  });

  it('a folder with no deployment file', async () => {
    const folder = folderOf(undefined);
    const fetchBefore = globalThis.fetch;

    const answer = await rejection(() => startLocalService({ app: 'probe', cli, folder }), folder);

    expect({
      answer,
      fetchRestored: globalThis.fetch === fetchBefore,
    }).toMatchSnapshot();
  });

  it('a deployment file with no staging environment', async () => {
    const folder = folderOf({ productRid: 'ri.ontology.main.ontology.probe' });
    const fetchBefore = globalThis.fetch;

    const answer = await rejection(() => startLocalService({ app: 'probe', cli, folder }), folder);

    expect({
      answer,
      fetchRestored: globalThis.fetch === fetchBefore,
    }).toMatchSnapshot();
  });

  async function detail(run: () => Promise<unknown>, folder?: string): Promise<unknown> {
    try {
      await run();

      return { rejected: false };
    } catch (error) {
      const text = (value: unknown): string => {
        const message = value instanceof Error ? value.message : String(value);

        return folder === undefined ? message : message.replaceAll(folder, '<folder>');
      };

      const named = (value: unknown): string => (value instanceof Error ? value.constructor.name : typeof value);

      return {
        rejected: true,
        name: named(error),
        message: text(error),
        ...(error instanceof Error && error.cause !== undefined
          ? { cause: { name: named(error.cause), message: text(error.cause) } }
          : {}),
        ...(error instanceof AggregateError
          ? { members: error.errors.map((member) => ({ name: named(member), message: text(member) })) }
          : {}),
      };
    }
  }

  const stagingDeployment = {
    productRid: 'ri.ontology.main.ontology.probe',
    staging: {
      baseUrl: 'https://probe.example.com',
      workosClientId: 'client_probe',
      trustedGithubRepository: 'example/probe',
      trustedGithubEnvironment: 'staging',
      authkitDomain: 'probe.authkit.app',
    },
  };

  it('a deployment file that is not JSON', async () => {
    const folder = folderOf(undefined);

    mkdirSync(join(folder, '.ontology'));

    writeFileSync(join(folder, '.ontology/deployment.json'), 'not json');

    const fetchBefore = globalThis.fetch;

    expect({
      answer: await detail(() => startLocalService({ app: 'probe', cli, folder }), folder),
      fetchRestored: globalThis.fetch === fetchBefore,
    }).toMatchSnapshot();
  });

  it('a Postgres URL that does not parse', async () => {
    const fetchBefore = globalThis.fetch;

    expect({
      answer: await detail(() => startLocalService({ app: 'probe', cli, postgres: 'not a url' })),
      fetchRestored: globalThis.fetch === fetchBefore,
    }).toMatchSnapshot();
  });

  it('a Postgres on this computer that takes no connection', async () => {
    const folder = folderOf(stagingDeployment);
    const fetchBefore = globalThis.fetch;

    const answer = await detail(
      () => startLocalService({ app: 'probe', cli, folder, postgres: 'postgresql://postgres:x@127.0.0.1:1/postgres' }),
      folder,
    );

    expect({ answer, fetchRestored: globalThis.fetch === fetchBefore }).toMatchSnapshot();
  });

  it('a Postgres container whose port is not a number', async () => {
    const bin = folderOf(undefined);
    const docker = join(bin, 'docker');

    writeFileSync(docker, '#!/bin/sh\ncase "$1" in\n  run) echo id ;;\n  port) echo 127.0.0.1:abc ;;\nesac\n');

    chmodSync(docker, 0o755);

    const folder = folderOf(stagingDeployment);
    const pathBefore = process.env.PATH;

    process.env.PATH = `${bin}:${pathBefore ?? ''}`;

    vi.useFakeTimers({ toFake: ['setTimeout'] });

    try {
      let settled = false;

      const running = detail(() => startLocalService({ app: 'probe', cli, folder }), folder).finally(
        () => void (settled = true),
      );

      while (!settled) await vi.advanceTimersByTimeAsync(100);

      const answer = await running;

      expect(
        JSON.parse(JSON.stringify(answer).replace(/ontology-local-[0-9a-f]{12}/g, 'ontology-local-<id>')),
      ).toMatchSnapshot();
    } finally {
      vi.useRealTimers();

      process.env.PATH = pathBefore;
    }
  });

  const probeKey = { authorization: `Bearer ${STUB_WORKOS_KEY}` };
  const userRead = 'https://api.workos.com/user_management/users/user_01TEST00000000000000000001';

  it('a stub request that is not a URL', async () => {
    expect(await detail(() => stubWorkos().fetch('not a url'))).toMatchSnapshot();
  });

  it('a stub write whose body is not JSON', async () => {
    const stub = stubWorkos();

    const answer = await detail(() =>
      stub.fetch('https://api.workos.com/authorization/permissions', {
        method: 'POST',
        headers: probeKey,
        body: 'not json',
      }),
    );

    expect({ answer, writes: stub.writes.length }).toMatchSnapshot();
  });

  it('a stub read that fails with a network error', async () => {
    const stub = stubWorkos();

    stub.fail('network');

    expect(await detail(() => stub.fetch(userRead, { headers: probeKey }))).toMatchSnapshot();
  });

  it('a stub read that times out, until the caller aborts it', async () => {
    const stub = stubWorkos();

    stub.fail('timeout');

    const controller = new AbortController();
    const pending = detail(() => stub.fetch(userRead, { headers: probeKey, signal: controller.signal }));

    controller.abort(new RangeError('CANARY-abort'));

    const later = await pending;

    const early = await detail(() =>
      stub.fetch(userRead, { headers: probeKey, signal: AbortSignal.abort(new RangeError('CANARY-aborted-before')) }),
    );

    expect({ later, early }).toMatchSnapshot();
  });

  it('a token that cannot be signed', async () => {
    const issuer = await createTestIssuer(testInput.settings.auth);

    expect(await detail(() => issuer.workos({ nested: 10n }))).toMatchSnapshot();
  });

  it('a WorkOS stub write that loses its answer, and one that gets no network', async () => {
    const request = () =>
      new Request('https://api.workos.com/authorization/permissions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${STUB_WORKOS_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: 'probe:read' }),
      });

    const lost = stubWorkos();

    lost.failWrites(0, 'answer lost');

    const offline = stubWorkos();

    offline.failWrites(0, 'network');

    expect({
      lost: await rejection(() => lost.fetch(request())),
      wrote: lost.environment().permissions,
      offline: await rejection(() => offline.fetch(request())),
    }).toMatchSnapshot();
  });
});
