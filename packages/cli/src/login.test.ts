import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, STUB, stubConfig, stubFetch, tempFolder, type Handler } from './cli.test-utils.ts';

const WORKOS = 'https://api.workos.com/user_management';

const DEVICE = {
  device_code: 'd',
  user_code: 'RRGQ-BJVS',
  verification_uri: 'https://auth.example/device',
  verification_uri_complete: 'https://auth.example/device?user_code=RRGQ-BJVS',
  expires_in: 300,
  interval: 5,
};

const lastLine = (stderr: string): unknown => JSON.parse(stderr.trim().split('\n').at(-1) ?? '');

function workos(...errors: string[]): Handler {
  return ({ url }) => {
    if (url === `${WORKOS}/authorize/device`) return Response.json(DEVICE);

    if (url !== `${WORKOS}/authenticate`) return undefined;

    const error = errors.shift();

    return error
      ? Response.json({ error }, { status: 400 })
      : Response.json({ user: { id: 'user_1' }, access_token: 'a', refresh_token: 'r' });
  };
}

function deviceThenDenied(device: Readonly<Record<string, unknown>>): Handler {
  let polls = 0;

  return ({ url }) => {
    if (url === `${WORKOS}/authorize/device`) return Response.json(device);

    if (url !== `${WORKOS}/authenticate`) return undefined;

    polls += 1;

    return polls === 1
      ? Response.json({ error: 'authorization_pending' }, { status: 400 })
      : Response.json({ error: 'access_denied' }, { status: 400 });
  };
}

const without = (field: string): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(DEVICE).filter(([key]) => key !== field));

describe('the polling of ontology login', () => {
  it('service/authentication#people: after slow_down, the CLI waits 5 seconds more for this poll and each later poll (RFC 8628 section 3.5)', async () => {
    const run = await cli(['login', '--app', 'twin', '--url', STUB], {
      fetch: stubFetch(stubConfig, workos('authorization_pending', 'slow_down', 'authorization_pending')),
    });

    expect(run.code).toBe(0);
    expect(run.sleeps).toEqual([5000, 10_000, 10_000]);
  });

  it('service/authentication#people: access_denied and expired_token stop the sign-in', async () => {
    for (const error of ['access_denied', 'expired_token']) {
      const run = await cli(['login', '--app', 'twin', '--url', STUB], { fetch: stubFetch(stubConfig, workos(error)) });

      expect(run.code).toBe(1);
      expect(run.stderr.trim().split('\n').at(-1)).toBe(JSON.stringify({ error }));
    }
  });

  it.each([
    ['no interval', without('interval'), 'interval'],
    ['no expires_in', without('expires_in'), 'expires_in'],
    ['an interval of 0', { ...DEVICE, interval: 0 }, 'interval'],
    ['an expires_in of -1', { ...DEVICE, expires_in: -1 }, 'expires_in'],
  ])('a device authorization with %s stops with an error and does not wait', async (_, device, field) => {
    const run = await cli(['login', '--app', 'twin', '--url', STUB], {
      fetch: stubFetch(stubConfig, deviceThenDenied(device)),
    });

    expect(run.code).toBe(1);
    expect(run.sleeps).toEqual([]);
    expect(lastLine(run.stderr)).toEqual({ message: `The device authorization gave no positive number for ${field}.` });
  });

  it('a token with no refresh_token stops with an error, does not wait, and keeps the stored token', async () => {
    const fetch = stubFetch(stubConfig, ({ url }) => {
      if (url === `${WORKOS}/authorize/device`) return Response.json(DEVICE);

      if (url === `${WORKOS}/authenticate`) return Response.json({ user: { id: 'user_1' }, access_token: 'a' });

      return undefined;
    });

    const tokens = tempFolder({ 'twin/staging': 'refresh-0' });

    const run = await cli(['login', '--app', 'twin', '--url', STUB], { fetch, tokens });

    expect(run.code).toBe(1);
    expect(run.sleeps).toEqual([]);
    expect(lastLine(run.stderr)).toEqual({ message: 'The sign-in gave no string for refresh_token.' });
    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('refresh-0');
  });
});
