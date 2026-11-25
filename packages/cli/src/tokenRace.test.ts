import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cli,
  stubExchange,
  replay,
  STUB,
  stubConfig,
  stubFetch,
  tempFolder,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const WORKOS = 'https://api.workos.com/user_management';
const AUTHENTICATE = `${WORKOS}/authenticate`;
const GRACE = 30_000;
const ACME = 'org_01TEST0RG00000000000000001';
const GLOBEX = 'org_01TEST0RG00000000000000002';

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
}

const form = (call: Call): Record<string, string> => Object.fromEntries(new URLSearchParams(call.body ?? ''));

const accessToken = (claims: Readonly<Record<string, string>>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

function workos(first: string, organization: string) {
  let now = 0;
  let issued = 0;
  const live = new Map<string, string | undefined>([[first, organization]]);
  const retired = new Map<string, { readonly at: number; readonly next: Tokens }>();
  const accessTokens = new Set<string>();
  const organizations = new Map<string, string | undefined>([[first, organization]]);

  const issue = (org: string | undefined): Tokens => {
    issued += 1;

    const next = {
      access_token: accessToken({ sid: `access-${issued}`, ...(org === undefined ? {} : { org_id: org }) }),
      refresh_token: `refresh-${issued}`,
    };

    live.set(next.refresh_token, org);

    organizations.set(next.refresh_token, org);

    accessTokens.add(next.access_token);

    return next;
  };

  const handler: Handler = (call) => {
    if (call.url === `${WORKOS}/authorize/device`) {
      return Response.json({
        device_code: 'd',
        user_code: 'RRGQ-BJVS',
        verification_uri: 'https://auth.example/device',
        verification_uri_complete: 'https://auth.example/device?user_code=RRGQ-BJVS',
        expires_in: 300,
        interval: 5,
      });
    }

    if (call.url !== AUTHENTICATE) return undefined;

    const fields = form(call);

    if (fields['grant_type'] !== 'refresh_token') return Response.json({ user: { id: 'user_1' }, ...issue(undefined) });

    const token = fields['refresh_token'] ?? '';

    if (live.has(token)) {
      const next = issue(fields['organization_id'] ?? live.get(token));

      live.delete(token);

      retired.set(token, { at: now, next });
    }

    const replayed = retired.get(token);

    if (!replayed || now - replayed.at > GRACE)
      return Response.json(
        { error: 'invalid_grant', error_description: 'Session has already ended.' },
        { status: 400 },
      );

    return Response.json({ user: { id: 'user_1' }, ...replayed.next });
  };

  return {
    handler,
    wait: (ms: number) => {
      now += ms;
    },
    issued: (header: string | undefined) => header !== undefined && accessTokens.has(header.replace(/^Bearer /, '')),
    organizationOf: (refreshToken: string) => organizations.get(refreshToken),
  };
}

function hold(auth: Handler, when: 'before' | 'after') {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();

  const handler: Handler = async (call) => {
    if (call.url !== AUTHENTICATE) return auth(call);

    reached.resolve(undefined);

    if (when === 'before') await released.promise;

    const answer = await auth(call);

    if (when === 'after') await released.promise;

    return answer;
  };

  return { handler, reached: reached.promise, release: () => released.resolve(undefined) };
}

const TOKEN_FILE = 'twin/staging';

async function objects(tokens: string, auth: Handler) {
  const fetch = stubFetch(stubConfig, auth, replay(stubExchange('client', 1), stubExchange('client', 2)));

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
    { fetch, tokens },
  );

  const authorizations = fetch.calls
    .filter(({ url }) => url.startsWith(STUB) && !url.endsWith('/client-config'))
    .map(({ headers }) => headers['authorization']);

  return { run, authorizations };
}

const stored = (tokens: string): string | undefined =>
  existsSync(join(tokens, TOKEN_FILE)) ? readFileSync(join(tokens, TOKEN_FILE), 'utf8') : undefined;

describe('2 writers of 1 token file', () => {
  it('service/cli#sign-in: a refresh that started from an older token does not overwrite the newer token of a parallel refresh, and each command goes on with a valid token', async () => {
    const auth = workos('refresh-0', ACME);
    const tokens = tempFolder({ [TOKEN_FILE]: 'refresh-0' });
    const slow = hold(auth.handler, 'before');
    const late = objects(tokens, slow.handler);

    await slow.reached;

    const a = await objects(tokens, auth.handler);

    const c = await objects(tokens, auth.handler);

    expect(stored(tokens)).toBe('refresh-2');

    slow.release();

    const b = await late;

    expect(stored(tokens)).toBe('refresh-2');

    for (const { run, authorizations } of [a, b, c]) {
      expect(run.code).toBe(0);
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every(auth.issued)).toBe(true);
    }

    auth.wait(GRACE + 1000);

    const later = await objects(tokens, auth.handler);

    expect(later.run.code).toBe(0);
    expect(stored(tokens)).toBe('refresh-3');
  });

  it('service/cli#sign-in: login --org runs while a command of another Organization refreshes, and the file holds the token of the login', async () => {
    const auth = workos('refresh-0', ACME);
    const tokens = tempFolder({ [TOKEN_FILE]: 'refresh-0' });
    const slow = hold(auth.handler, 'after');
    const late = objects(tokens, slow.handler);

    await slow.reached;

    auth.wait(GRACE + 1000);

    const login = await cli(['login', '--app', 'twin', '--url', STUB, '--org', GLOBEX], {
      fetch: stubFetch(stubConfig, auth.handler),
      tokens,
    });

    expect(login.code).toBe(0);
    expect(login.output).toEqual({ loggedIn: TOKEN_FILE, user: 'user_1', organization: GLOBEX });

    slow.release();

    const command = await late;

    expect(command.run.code).toBe(0);
    expect(command.authorizations.every(auth.issued)).toBe(true);

    const token = stored(tokens);

    expect(token).toBe('refresh-3');
    expect(auth.organizationOf(token ?? '')).toBe(GLOBEX);
  });

  it('service/cli#sign-in: after logout, the late refresh of a command in flight leaves no token file', async () => {
    const auth = workos('refresh-0', ACME);
    const tokens = tempFolder({ [TOKEN_FILE]: 'refresh-0' });
    const slow = hold(auth.handler, 'before');
    const late = objects(tokens, slow.handler);

    await slow.reached;

    const logout = await cli(['logout', '--app', 'twin'], { tokens });

    expect(logout.output).toEqual({ loggedOut: TOKEN_FILE });

    slow.release();

    const command = await late;

    expect(command.run.code).toBe(0);
    expect(command.authorizations.every(auth.issued)).toBe(true);
    expect(existsSync(join(tokens, TOKEN_FILE))).toBe(false);
  });
});
