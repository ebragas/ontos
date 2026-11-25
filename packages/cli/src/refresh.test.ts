import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, stubExchange, replay, STUB, stubConfig, stubFetch, tempFolder, type Handler } from './cli.test-utils.ts';

const AUTHENTICATE = 'https://api.workos.com/user_management/authenticate';
const GRACE = 30_000;

type Failure = (() => Response) | 'lost' | 'cut';

const status =
  (code: number, headers: Record<string, string> = {}): Failure =>
  () =>
    Response.json({ message: `stub ${code}` }, { status: code, headers });

function workos(sleeps: readonly number[], ...failures: Failure[]): Handler & { readonly tokens: string[] } {
  let current = 'refresh-0';
  let issued = 0;

  const retired = new Map<
    string,
    { readonly at: number; readonly next: { access_token: string; refresh_token: string } }
  >();

  const tokens: string[] = [];

  const handler: Handler = ({ url, body }) => {
    if (url !== AUTHENTICATE) return undefined;

    const token = new URLSearchParams(body ?? '').get('refresh_token') ?? '';

    tokens.push(token);

    const failure = failures.shift();

    if (typeof failure === 'function') return failure();

    const now = sleeps.reduce((sum, ms) => sum + ms, 0);

    if (token === current) {
      issued += 1;

      const next = { access_token: `access-${issued}`, refresh_token: `refresh-${issued}` };

      retired.set(token, { at: now, next });

      current = next.refresh_token;
    }

    const replayed = retired.get(token);

    if (!replayed || now - replayed.at > GRACE)
      return Response.json(
        { error: 'invalid_grant', error_description: 'Session has already ended.' },
        { status: 400 },
      );

    if (failure === 'lost') throw new TypeError('fetch failed');

    if (failure === 'cut')
      return new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError('terminated')) }));

    return Response.json(replayed.next);
  };

  return Object.assign(handler, { tokens });
}

async function load(failures: Failure[], stored = 'refresh-0') {
  const sleeps: number[] = [];
  const auth = workos(sleeps, ...failures);
  const fetch = stubFetch(stubConfig, auth, replay(stubExchange('client', 1), stubExchange('client', 2)));
  const tokens = tempFolder({ 'twin/staging': stored });

  const run = await cli(
    [
      'objects',
      'com.example.twin.Account',
      '--page-size',
      '2',
      '--order-by',
      '{"name":"asc"}',
      '--app',
      'twin',
      '--url',
      STUB,
    ],
    { fetch, tokens, sleeps },
  );

  const authorizations = fetch.calls
    .filter(({ url }) => url.startsWith(STUB) && !url.endsWith('/client-config'))
    .map(({ headers }) => headers['authorization']);

  return { run, sent: auth.tokens, stored: readFileSync(join(tokens, 'twin/staging'), 'utf8'), authorizations };
}

describe('the token refresh', () => {
  it('service/cli#sign-in: after a 503, the CLI waits 1 second and tries again with the same refresh token', async () => {
    const { run, sent, stored, authorizations } = await load([status(503)]);

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([1000]);
    expect(sent).toEqual(['refresh-0', 'refresh-0']);
    expect(stored).toBe('refresh-1');
    expect(authorizations).toEqual(['Bearer access-1', 'Bearer access-1', 'Bearer access-1']);
  });

  it('service/cli#sign-in: after a 429, the CLI waits the Retry-After time, in seconds or as an HTTP date, else 1 second', async () => {
    const seconds = await load([status(429, { 'retry-after': '3' })]);

    expect(seconds.run.code).toBe(0);
    expect(seconds.run.sleeps).toEqual([3000]);
    expect(seconds.stored).toBe('refresh-1');

    const date = await load([status(429, { 'retry-after': new Date(Date.now() + 5000).toUTCString() })]);

    expect(date.run.code).toBe(0);
    expect(date.run.sleeps).toHaveLength(1);
    expect(date.run.sleeps[0]).toBeGreaterThan(3000);
    expect(date.run.sleeps[0]).toBeLessThanOrEqual(5000);

    const none = await load([status(429)]);

    expect(none.run.code).toBe(0);
    expect(none.run.sleeps).toEqual([1000]);
    expect(none.sent).toEqual(['refresh-0', 'refresh-0']);

    const bad = await load([status(429, { 'retry-after': '1.5' })]);

    expect(bad.run.sleeps).toEqual([1000]);
  });

  it('service/cli#sign-in: after network errors that lose the new tokens, a replay of the same refresh token within the grace period gets them', async () => {
    const { run, sent, stored, authorizations } = await load(['lost', 'lost']);

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([1000, 2000]);
    expect(sent).toEqual(['refresh-0', 'refresh-0', 'refresh-0']);
    expect(stored).toBe('refresh-1');
    expect(authorizations).toEqual(['Bearer access-1', 'Bearer access-1', 'Bearer access-1']);
  });

  it('service/cli#sign-in: after an answer whose body breaks off, the CLI tries again, and the replay gets the new tokens', async () => {
    const { run, sent, stored } = await load(['cut']);

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([1000]);
    expect(sent).toEqual(['refresh-0', 'refresh-0']);
    expect(stored).toBe('refresh-1');
  });

  it('service/cli#sign-in: the CLI tries at most 3 more times, with waits of 1, 2, then 4 seconds, and then shows the WorkOS error', async () => {
    const { run, sent, stored } = await load([status(503), status(502), status(500), status(503)]);

    expect(run.code).toBe(1);
    expect(run.sleeps).toEqual([1000, 2000, 4000]);
    expect(sent).toEqual(['refresh-0', 'refresh-0', 'refresh-0', 'refresh-0']);
    expect(run.error).toEqual({ message: 'stub 503' });
    expect(stored).toBe('refresh-0');

    const short = await load([1, 2, 3, 4].map(() => status(503, { 'retry-after': '1' })));

    expect(short.run.code).toBe(1);
    expect(short.run.sleeps).toEqual([1000, 1000, 1000]);
    expect(short.sent).toHaveLength(4);
  });

  it('service/cli#sign-in: the CLI stops when the next wait would take the total past 20 seconds, inside the 30 second grace period', async () => {
    const inside = await load(['lost', status(503, { 'retry-after': '18' })]);

    expect(inside.run.code).toBe(0);
    expect(inside.run.sleeps).toEqual([1000, 18_000]);
    expect(inside.stored).toBe('refresh-1');

    const exact = await load([status(503, { 'retry-after': '10' }), status(503, { 'retry-after': '10' })]);

    expect(exact.run.code).toBe(0);
    expect(exact.run.sleeps).toEqual([10_000, 10_000]);

    const past = await load([
      status(503, { 'retry-after': '8' }),
      status(503, { 'retry-after': '8' }),
      status(503, { 'retry-after': '8' }),
    ]);

    expect(past.run.code).toBe(1);
    expect(past.run.sleeps).toEqual([8000, 8000]);
    expect(past.sent).toHaveLength(3);
    expect(past.run.error).toEqual({ message: 'stub 503' });

    const once = await load([status(429, { 'retry-after': '21' })]);

    expect(once.run.code).toBe(1);
    expect(once.run.sleeps).toEqual([]);
    expect(once.sent).toHaveLength(1);
  });

  it('service/cli#sign-in: after invalid_grant, the CLI tells the person to run ontology login, and does not try again', async () => {
    const { run, sent, stored } = await load([], 'retired-token');

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message: 'WorkOS no longer accepts the stored token of twin/staging: run ontos login --app twin --env staging.',
    });

    expect(sent).toEqual(['retired-token']);
    expect(run.sleeps).toEqual([]);
    expect(stored).toBe('retired-token');
  });

  it('service/cli#sign-in: after another 4xx, the CLI shows the WorkOS error, and does not try again', async () => {
    const invalidClient = (): Response =>
      Response.json({ error: 'invalid_client', error_description: 'Invalid client ID.' }, { status: 400 });

    const { run, sent, stored } = await load([invalidClient]);

    expect(run.code).toBe(1);
    expect(run.error).toEqual({ error: 'invalid_client', error_description: 'Invalid client ID.' });
    expect(run.sleeps).toEqual([]);
    expect(sent).toEqual(['refresh-0']);
    expect(stored).toBe('refresh-0');
  });

  it('a refresh answer with no refresh_token stops with an error, and the stored token stays', async () => {
    const noRefreshToken = (): Response => Response.json({ access_token: 'access-1' });

    const { run, sent, stored } = await load([noRefreshToken]);

    expect(run.code).toBe(1);
    expect(run.error).toEqual({ message: 'The token refresh gave no string for refresh_token.' });
    expect(run.sleeps).toEqual([]);
    expect(sent).toEqual(['refresh-0']);
    expect(stored).toBe('refresh-0');
  });
});
