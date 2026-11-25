import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION, TEST_APP } from '../../../tools/packaging/testService.ts';
import { cli, stubFetch, tempFolder, type Call, type Handler } from './cli.test-utils.ts';
import { notesApp } from './apps.test-utils.ts';
import { localGate, installGate, notesUsers, toLocal } from './sql.test-utils.ts';

const local = localGate('production', notesUsers());
const WORKOS = 'https://api.workos.com/user_management';

const form = (call: Call): Record<string, string> => Object.fromEntries(new URLSearchParams(call.body ?? ''));

function workos(): Handler & { refreshes: string[] } {
  let polls = 0;
  const refreshes: string[] = [];

  const handler: Handler = async (call) => {
    if (call.url === `${WORKOS}/authorize/device`) {
      return Response.json({
        device_code: 'device-code-1',
        user_code: 'RRGQ-BJVS',
        verification_uri: 'https://auth.example/device',
        verification_uri_complete: 'https://auth.example/device?user_code=RRGQ-BJVS',
        expires_in: 300,
        interval: 5,
      });
    }

    if (call.url !== `${WORKOS}/authenticate`) return undefined;

    const fields = form(call);

    if (fields['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
      polls += 1;

      if (polls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 });

      return Response.json({
        user: { id: 'user_01TEST00000000000000000001' },
        access_token: await local.service.issuer.workos(),
        refresh_token: 'refresh-0',
      });
    }

    if (fields['grant_type'] === 'refresh_token') {
      refreshes.push(fields['refresh_token'] ?? '');

      return Response.json({
        access_token: await local.service.issuer.workos(),
        refresh_token: `refresh-${refreshes.length}`,
      });
    }

    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  };

  return Object.assign(handler, { refreshes });
}

describe('sign-in', () => {
  it('service/cli#sign-in: a person in 1 Organization, whose device-flow token has no org_id, gets that Organization from node.ts', async () => {
    const fetch = stubFetch(async (call) => {
      if (call.url === `${WORKOS}/authorize/device`) {
        return Response.json({
          device_code: 'device-code-1',
          user_code: 'RRGQ-BJVS',
          verification_uri: 'https://auth.example/device',
          verification_uri_complete: 'https://auth.example/device?user_code=RRGQ-BJVS',
          expires_in: 300,
          interval: 5,
        });
      }

      if (call.url !== `${WORKOS}/authenticate`) return undefined;

      const fields = form(call);

      if (fields['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
        return Response.json({
          user: { id: 'user_01TEST00000000000000000001' },
          access_token: await local.service.issuer.workos({ org_id: undefined, role: undefined }),
          refresh_token: 'refresh-unscoped',
        });
      }

      expect(fields).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-unscoped',
        client_id: TEST_APP.production.workosClientId,
        organization_id: ORGANIZATION,
      });

      return Response.json({
        user: { id: 'user_01TEST00000000000000000001' },
        access_token: await local.service.issuer.workos({ role: 'admin' }),
        refresh_token: 'refresh-scoped',
      });
    }, toLocal);

    const tokens = tempFolder();

    const run = await cli(['login', ...local.flags()], { fetch, tokens });

    expect(run.output).toEqual({
      loggedIn: 'app/production',
      user: 'user_01TEST00000000000000000001',
      organization: ORGANIZATION,
      role: 'admin',
    });

    expect(readFileSync(join(tokens, 'app/production'), 'utf8')).toBe('refresh-scoped');
  });

  it('service/authentication#people, service/cli#sign-in: ontology login signs a person in with WorkOS CLI Auth, the device authorization flow, with the client ID of client-config', async () => {
    const auth = workos();
    const fetch = stubFetch(auth, toLocal);
    const tokens = tempFolder();

    const run = await cli(['login', ...local.flags()], { fetch, tokens });

    expect(run.error).toEqual({
      userCode: 'RRGQ-BJVS',
      verificationUri: 'https://auth.example/device',
      open: 'https://auth.example/device?user_code=RRGQ-BJVS',
    });

    expect(run.code).toBe(0);

    expect(run.output).toEqual({
      loggedIn: 'app/production',
      user: 'user_01TEST00000000000000000001',
      organization: ORGANIZATION,
      role: 'member',
    });

    expect(run.sleeps).toEqual([5000]);

    const clientId = TEST_APP.production.workosClientId;

    expect(
      fetch.calls.map((call) => [call.method, call.url, call.url.startsWith(WORKOS) ? form(call) : undefined]),
    ).toEqual([
      ['GET', `${local.service.url}/api/ontology-service/v1/client-config`, undefined],
      ['POST', `${WORKOS}/authorize/device`, { client_id: clientId }],
      [
        'POST',
        `${WORKOS}/authenticate`,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: 'device-code-1',
          client_id: clientId,
        },
      ],
      [
        'POST',
        `${WORKOS}/authenticate`,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: 'device-code-1',
          client_id: clientId,
        },
      ],
    ]);

    expect(run.stderr + run.stdout).not.toContain('device-code-1');
    expect(readFileSync(join(tokens, 'app/production'), 'utf8')).toBe('refresh-0');
  });

  it('service/authentication#people: each command sends a token from the stored refresh token, and replaces the stored refresh token after each refresh', async () => {
    const published = await cli(['publish', ...local.flags()], {
      cwd: notesApp(),
      fetch: stubFetch(toLocal),
      env: { ONTOLOGY_TOKEN: await local.service.issuer.github() },
    });

    expect(published.stderr).toBe('');

    await installGate(local.service);

    const auth = workos();
    const fetch = stubFetch(auth, toLocal);
    const tokens = tempFolder();

    await cli(['login', ...local.flags()], { fetch, tokens });

    for (const expected of ['refresh-1', 'refresh-2']) {
      const run = await cli(['describe', ...local.flags()], { fetch, tokens });

      expect(run.error).toBeUndefined();
      expect(run.code).toBe(0);
      expect(readFileSync(join(tokens, 'app/production'), 'utf8')).toBe(expected);
    }

    expect(auth.refreshes).toEqual(['refresh-0', 'refresh-1']);
    expect(local.service.audiences).toEqual([]);
  });

  it('service/cli#sign-in: ontology login stores 1 refresh token for each app and environment, each in its own file, readable only by its owner (mode 0600)', async () => {
    const fetch = stubFetch(workos(), toLocal);
    const tokens = tempFolder();

    await cli(['login', ...local.flags()], { fetch, tokens });

    expect(statSync(join(tokens, 'app/production')).mode & 0o777).toBe(0o600);

    await cli(['login', '--app', 'app', '--env', 'staging', '--url', local.service.url], {
      fetch: stubFetch(workos(), toLocal),
      tokens,
    });

    expect(readdirSync(join(tokens, 'app')).sort()).toEqual(['production', 'staging']);
    expect(readFileSync(join(tokens, 'app/staging'), 'utf8')).toBe('refresh-0');
    expect(statSync(join(tokens, 'app/staging')).mode & 0o777).toBe(0o600);
  });

  it('service/cli#sign-in: ontology logout removes the stored token of the app and environment', async () => {
    const tokens = tempFolder({ 'app/production': 'r1', 'app/staging': 'r2' });

    const run = await cli(['logout', '--app', 'app', '--env', 'production'], { tokens });

    expect(run.code).toBe(0);
    expect(run.output).toEqual({ loggedOut: 'app/production' });
    expect(readdirSync(join(tokens, 'app'))).toEqual(['staging']);
    expect(readFileSync(join(tokens, 'app/staging'), 'utf8')).toBe('r2');

    const after = await cli(['describe', ...local.flags()], { fetch: stubFetch(toLocal), tokens });

    expect(after.code).toBe(1);

    expect(after.error).toEqual({
      message: 'No stored token for app/production: run ontos login --app app --env production.',
    });
  });

  it('service/cli#sign-in, service/authentication#ci-workflows: in a GitHub Actions job, the CLI asks GitHub for 1 OIDC token, with the base URL of the environment as its audience, and sends it with each call of each command', async () => {
    const before = local.service.audiences.length;
    const calls = stubFetch(toLocal);

    const run = await cli(['validate', ...local.flags()], {
      cwd: notesApp(),
      fetch: calls,
      env: local.service.oidcEnv,
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const twice = await cli(['validate', ...local.flags()], {
      cwd: notesApp(),
      fetch: calls,
      env: local.service.oidcEnv,
    });

    expect(twice.code).toBe(0);

    const authorized = calls.calls.filter(
      ({ url }) => url.startsWith(local.service.url) && !url.endsWith('/client-config'),
    );

    expect(authorized.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/ontology-service/v1/publish',
      '/api/ontology-service/v1/publish',
    ]);

    expect(local.service.audiences.slice(before)).toEqual(['https://app.ontos.example']);
    expect(new Set(authorized.map(({ headers }) => headers['authorization'])).size).toBe(1);

    const none = await cli(['describe', ...local.flags()], { fetch: globalThis.fetch });

    expect(none.code).toBe(1);

    expect(none.error).toEqual({
      message: 'No stored token for app/production: run ontos login --app app --env production.',
    });
  });
});
