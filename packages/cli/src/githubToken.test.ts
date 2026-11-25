import { describe, expect, it } from 'vitest';
import { cli, stubExchange, replay, STUB, stubConfig, stubFetch, type Handler } from './cli.test-utils.ts';

const OIDC = 'https://oidc.stub/token?api-version=2.0';
const ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: OIDC, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };

function jwt(seconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) + seconds, jti: crypto.randomUUID() })}.`;
}

type Answer = () => Response;

const status =
  (code: number, headers: Record<string, string> = {}): Answer =>
  () =>
    Response.json({ message: `stub ${code}` }, { status: code, headers });

const token =
  (value: string): Answer =>
  () =>
    Response.json({ value });

const lost: Answer = () => {
  throw new TypeError('fetch failed');
};

function github(...answers: Answer[]): Handler & { readonly audiences: string[] } {
  const audiences: string[] = [];

  const handler: Handler = ({ url, headers }) => {
    if (!url.startsWith('https://oidc.stub/') || headers['authorization'] !== 'Bearer request-token') return undefined;

    audiences.push(new URL(url).searchParams.get('audience') ?? '');

    return (answers.shift() ?? token(jwt(300)))();
  };

  return Object.assign(handler, { audiences });
}

async function load(app: string, fetch: ReturnType<typeof stubFetch>, sleeps: number[] = []) {
  const before = fetch.calls.length;

  const run = await cli(
    [
      'objects',
      'com.example.twin.Account',
      '--page-size',
      '2',
      '--order-by',
      '{"name":"asc"}',
      '--app',
      app,
      '--env',
      'production',
      '--url',
      STUB,
    ],
    { fetch, env: ENV, sleeps },
  );

  const sent = fetch.calls
    .slice(before)
    .filter(({ url }) => url.startsWith(STUB) && !url.endsWith('/client-config'))
    .map(({ headers }) => headers['authorization']);

  return { run, sent };
}

const service = (gh: Handler) =>
  stubFetch(gh, stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

describe('the GitHub OIDC token', () => {
  it('service/cli#sign-in: 2 commands in 1 process make 1 token request, with the base URL as its audience, and send the same token', async () => {
    const gh = github();
    const fetch = service(gh);

    const first = await load('reuse', fetch);

    const second = await load('reuse', fetch);

    expect([first.run.code, second.run.code]).toEqual([0, 0]);
    expect(gh.audiences).toEqual(['https://reuse.ontos.example']);

    const sent = [...first.sent, ...second.sent];

    expect(sent).toHaveLength(6);
    expect(new Set(sent).size).toBe(1);
  });

  it('service/cli#sign-in: a command with another OIDC request URL makes its own token request for the same audience', async () => {
    const gh = github();
    const fetch = service(gh);

    await load('reuse-url', fetch);

    const other = await cli(
      [
        'objects',
        'com.example.twin.Account',
        '--page-size',
        '2',
        '--order-by',
        '{"name":"asc"}',
        '--app',
        'reuse-url',
        '--env',
        'production',
        '--url',
        STUB,
      ],
      {
        fetch,
        env: { ...ENV, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.stub/other?api-version=2.0' },
      },
    );

    expect(other.code).toBe(0);
    expect(gh.audiences).toEqual(['https://reuse-url.ontos.example', 'https://reuse-url.ontos.example']);
  });

  it('service/cli#sign-in: a token that expires in 59 seconds, or has no exp, is not sent again after its call', async () => {
    const near = github(token(jwt(59)), token(jwt(300)));

    const { run, sent } = await load('expiring', service(near));

    expect(run.code).toBe(0);
    expect(near.audiences).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);

    const opaque = github(token('no-exp-1'), token('no-exp-2'), token('no-exp-3'), token('no-exp-4'));
    const second = service(opaque);

    const runs = [await load('opaque', second), await load('opaque', second)];

    expect(runs.map(({ run }) => run.code)).toEqual([0, 0]);
    expect(opaque.audiences).toHaveLength(4);

    expect(runs.map(({ sent }) => sent)).toEqual([
      ['Bearer no-exp-1', 'Bearer no-exp-2', 'Bearer no-exp-2'],
      ['Bearer no-exp-3', 'Bearer no-exp-4', 'Bearer no-exp-4'],
    ]);
  });

  it('service/cli#sign-in: after 2 answers of 503, the CLI waits 1, then 2 seconds, and passes', async () => {
    const gh = github(status(503), status(503));

    const { run, sent } = await load('two-503', service(gh));

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([1000, 2000]);
    expect(gh.audiences).toHaveLength(3);
    expect(sent).toHaveLength(3);
  });

  it('service/cli#sign-in: after a network error and a 429, the CLI waits 1 second, then the Retry-After time', async () => {
    const gh = github(lost, status(429, { 'retry-after': '3' }));

    const { run } = await load('lost-429', service(gh));

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([1000, 3000]);
  });

  it('service/cli#sign-in: a Retry-After past the 63 seconds of all waits fails at once, with no wait', async () => {
    const gh = github(status(429, { 'retry-after': '120' }));

    const { run } = await load('long-retry-after', service(gh));

    expect(run.code).toBe(1);
    expect(run.sleeps).toEqual([]);
    expect(run.error).toEqual({ message: 'stub 429' });
    expect(gh.audiences).toHaveLength(1);
  });

  it('service/cli#sign-in: apply retries the token request too, after 2 answers of 503', async () => {
    const gh = github(status(503), status(503));
    const fetch = stubFetch(gh, stubConfig, replay(stubExchange('client', 14), stubExchange('client', 15)));
    const sleeps: number[] = [];
    const parameters = '{"engagementId":"eng-7","accountId":"acc-2","title":"Expansion","amount":22000}';

    const run = await cli(
      [
        'apply',
        'com.example.twin.create-engagement',
        '--parameters',
        parameters,
        '--app',
        'apply-503',
        '--env',
        'production',
        '--url',
        STUB,
      ],
      { fetch, env: ENV, sleeps },
    );

    expect(run.error).toBeUndefined();
    expect(run.code).toBe(0);
    expect(sleeps).toEqual([1000, 2000]);

    expect(gh.audiences).toEqual([
      'https://apply-503.ontos.example',
      'https://apply-503.ontos.example',
      'https://apply-503.ontos.example',
    ]);
  });

  it('service/cli#sign-in: after 7 answers of 503, the CLI fails after 6 waits, with the error of the last answer', async () => {
    const gh = github(...Array.from({ length: 7 }, () => status(503)));

    const { run, sent } = await load('seven-503', service(gh));

    expect(run.code).toBe(1);
    expect(run.sleeps).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000]);
    expect(run.error).toEqual({ message: 'stub 503' });
    expect(gh.audiences).toHaveLength(7);
    expect(sent).toEqual([]);
  });

  it('service/cli#sign-in: after the last network error, the CLI names the failed token request', async () => {
    const gh = github(...Array.from({ length: 7 }, () => lost));

    const { run } = await load('seven-lost', service(gh));

    expect(run.code).toBe(1);
    expect(run.error).toEqual({ message: 'The GitHub OIDC token request failed: fetch failed.' });
  });

  it('service/cli#sign-in: after a 401, the CLI fails at once, and the next command asks again', async () => {
    const gh = github(status(401));
    const fetch = service(gh);

    const refused = await load('refused', fetch);

    expect(refused.run.code).toBe(1);
    expect(refused.run.sleeps).toEqual([]);
    expect(refused.run.error).toEqual({ message: 'stub 401' });
    expect(gh.audiences).toHaveLength(1);

    const next = await load('refused', fetch);

    expect(next.run.code).toBe(0);
    expect(gh.audiences).toHaveLength(2);
  });
});
