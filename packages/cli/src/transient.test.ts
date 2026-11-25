import { describe, expect, it } from 'vitest';
import {
  cli,
  stubExchange,
  replay,
  STUB,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const CREATE_ENGAGEMENT = 'com.example.twin.create-engagement';
const ONTOLOGY = `${STUB}/api/v2/ontologies/${STUB_CONFIG.productRid}`;
const flags = ['--app', 'twin', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };
const WAITS = [1000, 2000, 4000, 8000, 16_000, 32_000];

const reset = () => new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });

function failing(suffix: string, times: number, fail: () => Response): Handler {
  let left = times;

  return ({ url }) => {
    if (!new URL(url).pathname.endsWith(suffix) || left === 0) return undefined;

    left -= 1;

    return fail();
  };
}

const to = (calls: readonly Call[], suffix: string) =>
  calls.filter(({ url }) => new URL(url).pathname.endsWith(suffix));

describe('a read that fails for a short time', () => {
  it('service/cli#output: objects tries loadObjects again after 2 network errors, 1 then 2 seconds apart', async () => {
    const fetch = stubFetch(
      stubConfig,
      failing('/objectSets/loadObjects', 2, () => {
        throw reset();
      }),
      replay(stubExchange('client', 1), stubExchange('client', 2)),
    );

    const run = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', ...flags], {
      fetch,
      env,
    });

    expect(run.error).toBeUndefined();
    expect(run.code).toBe(0);
    expect((run.output as { data: unknown[] }).data).toHaveLength(2);
    expect(run.sleeps).toEqual([1000, 2000]);
    expect(to(fetch.calls, '/objectSets/loadObjects')).toHaveLength(3);
  });

  it('service/cli#output: history tries editsHistory again after a 503', async () => {
    const history: Handler = ({ method, url }) =>
      method === 'POST' && url === `${ONTOLOGY}/objectTypes/${ACCOUNT}/editsHistory`
        ? Response.json({ data: [], totalCount: 0 })
        : undefined;

    const fetch = stubFetch(
      stubConfig,
      failing('/editsHistory', 1, () => new Response('Service Unavailable', { status: 503 })),
      history,
    );

    const run = await cli(['history', ACCOUNT, ...flags], { fetch, env });

    expect(run.error).toBeUndefined();
    expect(run.code).toBe(0);
    expect(run.output).toEqual({ data: [], totalCount: 0 });
    expect(run.sleeps).toEqual([1000]);
  });

  it('service/cli#output: client-config waits the Retry-After time of a 502', async () => {
    const fetch = stubFetch(
      failing('/client-config', 1, () => new Response('Bad Gateway', { status: 502, headers: { 'retry-after': '5' } })),
      stubConfig,
      replay(stubExchange('client', 1), stubExchange('client', 2)),
    );

    const run = await cli(['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}', ...flags], {
      fetch,
      env,
    });

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([5000]);
  });

  it('service/cli#output: aggregate tries 7 times on 504, then prints TransientFailure with no errorCode', async () => {
    const fetch = stubFetch(
      stubConfig,
      failing('/objectSets/aggregate', 7, () => new Response('Gateway Timeout', { status: 504 })),
      replay(stubExchange('client', 4)),
    );

    const run = await cli(['aggregate', ENGAGEMENT, '--select', '{"$count":"unordered"}', ...flags], { fetch, env });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');

    expect(run.error).toEqual({
      errorName: 'TransientFailure',
      message: 'https://stub.test gave 504.',
      status: 504,
      url: `${ONTOLOGY}/objectSets/aggregate`,
      tries: 7,
    });

    expect(run.error).not.toHaveProperty('errorCode');
    expect(run.sleeps).toEqual(WAITS);
    expect(to(fetch.calls, '/objectSets/aggregate')).toHaveLength(7);
  });

  it('service/cli#output: a read that never gets an answer prints TransientFailure with status null and the URL without its query', async () => {
    const unreachable = (async () => {
      throw reset();
    }) as typeof fetch;

    const run = await cli(['describe', ...flags], { fetch: unreachable, env });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      errorName: 'TransientFailure',
      message: 'Cannot reach https://stub.test: read ECONNRESET.',
      status: null,
      url: `${STUB}/api/ontology-service/v1/client-config`,
      tries: 7,
    });

    expect(run.sleeps).toEqual(WAITS);
  });

  it('service/cli#output: a Retry-After that passes 63 seconds in all stops the tries', async () => {
    const fetch = stubFetch(
      failing(
        '/client-config',
        1,
        () => new Response('Service Unavailable', { status: 503, headers: { 'retry-after': '120' } }),
      ),
      stubConfig,
    );

    const run = await cli(['describe', ...flags], { fetch, env });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      errorName: 'TransientFailure',
      message: 'https://stub.test gave 503.',
      status: 503,
      url: `${STUB}/api/ontology-service/v1/client-config`,
      tries: 1,
    });

    expect(run.sleeps).toEqual([]);

    const total = stubFetch(
      failing(
        '/client-config',
        7,
        () => new Response('Service Unavailable', { status: 503, headers: { 'retry-after': '20' } }),
      ),
      stubConfig,
    );

    const capped = await cli(['describe', ...flags], { fetch: total, env });

    expect(capped.code).toBe(1);
    expect(capped.sleeps).toEqual([20_000, 20_000, 20_000]);
    expect(to(total.calls, '/client-config')).toHaveLength(4);
  });

  it('service/cli#output: objects sends a read that gets a 429 1 time, though the stock client tries a 429 again', async () => {
    const busy = {
      errorCode: 'TOO_MANY_REQUESTS',
      errorName: 'TooManyRequests',
      errorInstanceId: 'e-429',
      parameters: {},
    };

    const fetch = stubFetch(
      stubConfig,
      failing('/objectSets/loadObjects', 1, () => Response.json(busy, { status: 429 })),
      replay(stubExchange('client', 1)),
    );

    const run = await cli(['objects', ACCOUNT, ...flags], { fetch, env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual(busy);
    expect(run.sleeps).toEqual([]);
    expect(to(fetch.calls, '/objectSets/loadObjects')).toHaveLength(1);
  });

  it('service/cli#output: objects sends a read that gets a 400 OSDK error 1 time, and prints the error body', async () => {
    const refusal = {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'InvalidPropertyFilterValue',
      errorInstanceId: 'e-400',
      parameters: { property: 'name' },
    };

    const fetch = stubFetch(
      stubConfig,
      failing('/objectSets/loadObjects', 1, () => Response.json(refusal, { status: 400 })),
      replay(stubExchange('client', 1)),
    );

    const run = await cli(['objects', ACCOUNT, ...flags], { fetch, env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual(refusal);
    expect(run.sleeps).toEqual([]);
    expect(to(fetch.calls, '/objectSets/loadObjects')).toHaveLength(1);
  });
});

describe('a request that may write', () => {
  const apply = (fail: () => Response) => {
    const fetch = stubFetch(stubConfig, failing('/apply', 1, fail), replay(stubExchange('client', 14)));

    return {
      fetch,
      run: cli(['apply', CREATE_ENGAGEMENT, '--parameters', '{"engagementId":"eng-7"}', ...flags], { fetch, env }),
    };
  };

  it('service/cli#output: apply sends an apply that gets a 503 1 time, though the stock client tries a 503 again', async () => {
    const unavailable = {
      errorCode: 'INTERNAL',
      errorName: 'ServiceUnavailable',
      errorInstanceId: 'e-503',
      parameters: {},
    };

    const { fetch, run } = apply(() => Response.json(unavailable, { status: 503 }));

    const { code, error, sleeps } = await run;

    expect(code).toBe(1);
    expect(error).toEqual(unavailable);
    expect(sleeps).toEqual([]);
    expect(to(fetch.calls, '/apply')).toHaveLength(1);
  });

  it('service/cli#output: apply sends an apply that gets a network error, a 429, a 500, a 502, or a 504 1 time', async () => {
    for (const fail of [
      () => {
        throw reset();
      },
      ...[429, 500, 502, 504].map((status) => () => new Response('Failed', { status })),
    ]) {
      const { fetch, run } = apply(fail);

      const { code, sleeps } = await run;

      expect(code).toBe(1);
      expect(sleeps).toEqual([]);
      expect(to(fetch.calls, '/apply')).toHaveLength(1);
    }
  });
});
