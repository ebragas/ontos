import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { orThrow, settle, step } from '../../errors/index.ts';
import { createDb } from '../../db/index.ts';
import { handle, inputFromEnv, settingsFromEnv, type HandleInput, type MissingSettings } from '../../handler/index.ts';
import { unusedKeys } from '../index.ts';
import { forPermissions } from '../../ontology/access/forPermissions.ts';
import { permissionIndex } from '../../ontology/access/permissionIndex.ts';
import { compileOntology } from '../../ontology/index.ts';
import { NS, stored, twinFunctions, twinGrants, twinIr } from '../../ontology/stored.test-utils.ts';
import { testEnv } from '../../service.test-utils.ts';
import { OrganizationId, UserId } from '../caller.ts';
import { DEFAULT_DEV_TOKEN, DEV_ORG_ID, DEV_USER_ID, devIdentityProvider } from './dev.ts';
import { oidcIdentityProvider } from './oidc.ts';
import { constantTimeEqual, noopWorkosPublish } from './shared.ts';

interface JwksFixture {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly sign: (
    claims: Record<string, unknown>,
    options?: { readonly kid?: string; readonly exp?: number },
  ) => Promise<string>;
  readonly signUntrusted: (claims: Record<string, unknown>) => Promise<string>;
  readonly close: () => Promise<void>;
}

async function startJwksFixture(): Promise<JwksFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');

  const untrusted = await generateKeyPair('RS256');

  const jwk = { ...(await exportJWK(publicKey)), kid: 'oidc-key-1', use: 'sig', alg: 'RS256' };

  const server: Server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));

      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;
  const jwksUri = `${issuer}/.well-known/jwks.json`;

  const signWith = (key: CryptoKey, claims: Record<string, unknown>, kid: string, exp?: number): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setExpirationTime(exp ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(key);

  return {
    issuer,
    jwksUri,
    sign: (claims, options = {}) =>
      signWith(privateKey, { iss: issuer, sub: 'oidc-user-1', ...claims }, options.kid ?? 'oidc-key-1', options.exp),
    signUntrusted: (claims) =>
      signWith(untrusted.privateKey, { iss: issuer, sub: 'oidc-user-1', ...claims }, 'oidc-key-1'),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('constantTimeEqual and noopWorkosPublish', () => {
  it('compares tokens in constant time including different lengths', () => {
    expect(constantTimeEqual('secret-token', 'secret-token')).toBe(true);
    expect(constantTimeEqual('secret-token', 'secret-tokeN')).toBe(false);
    expect(constantTimeEqual('secret-token', 'short')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('provides a no-op WorkosPort with empty reads and no writes', async () => {
    const port = noopWorkosPublish();

    const read = await settle(port.read());

    expect(read).toEqual({ ok: true, value: { permissions: new Map(), roles: new Map() } });

    const first = await settle(step(port.memberRoles()));

    expect(first).toEqual({ ok: true, value: { done: true, value: undefined } });

    expect(await settle(port.apply({ step: 'createRole', role: 'admin' }))).toEqual({ ok: true, value: undefined });

    expect(await settle(port.setPermissions('admin', ['accounts:read']))).toEqual({ ok: true, value: undefined });
  });
});

describe('devIdentityProvider', () => {
  it('authenticates configured dev token for data, publish, and MCP routes and rejects invalid tokens', async () => {
    const provider = devIdentityProvider({ token: 'custom-dev-secret' });

    const missing = await settle(
      provider.authenticate(new Request('http://localhost/api/v2/ontologies'), { access: 'data' }),
    );

    expect(missing.ok).toBe(false);

    const wrong = await settle(
      provider.authenticate(
        new Request('http://localhost/api/v2/ontologies', { headers: { authorization: 'Bearer wrong' } }),
        { access: 'data' },
      ),
    );

    expect(wrong.ok).toBe(false);

    const dataCaller = await settle(
      provider.authenticate(
        new Request('http://localhost/api/v2/ontologies', {
          headers: { authorization: 'Bearer custom-dev-secret' },
        }),
        { access: 'data' },
      ),
    );

    expect(dataCaller).toEqual({
      ok: true,
      value: { user: DEV_USER_ID, kind: 'person', organization: DEV_ORG_ID },
    });

    const publishCaller = await settle(
      provider.authenticate(
        new Request('http://localhost/api/ontology-service/v1/publish', {
          headers: { authorization: 'Bearer custom-dev-secret' },
        }),
        { access: 'publish' },
      ),
    );

    expect(publishCaller).toEqual({ ok: true, value: { user: DEV_USER_ID, kind: 'publish' } });

    const mcpCaller = await settle(
      provider.authenticateMcp(
        new Request('http://localhost/api/mcp', {
          headers: { authorization: 'Bearer custom-dev-secret' },
        }),
      ),
    );

    expect(mcpCaller).toEqual({
      ok: true,
      value: { user: DEV_USER_ID, kind: 'person', organization: DEV_ORG_ID, clientId: 'dev-client' },
    });
  });

  it('serves synthetic user, organization, wildcard permission, and OAuth client_credentials token', async () => {
    const provider = devIdentityProvider();

    const user = await settle(provider.users.get(DEV_USER_ID));

    const missingUser = await settle(provider.users.get('user_other'));

    const orgs = await settle(provider.users.organizations(DEV_USER_ID));

    const perms = await settle(provider.users.permissions(DEV_USER_ID, DEV_ORG_ID));

    const deniedPerms = await settle(
      provider.users.permissions(UserId.parse('user_other'), OrganizationId.parse('org_other')),
    );

    expect(user).toMatchObject({ ok: true, value: { id: DEV_USER_ID, status: 'ACTIVE', realm: 'dev' } });
    expect(missingUser).toEqual({ ok: true, value: undefined });
    expect(orgs).toEqual({ ok: true, value: [{ id: DEV_ORG_ID, name: 'Local Dev' }] });
    expect(perms).toEqual({ ok: true, value: ['*'] });
    expect(deniedPerms.ok).toBe(false);

    const tokenRes = await settle(
      provider.tokenRoute(
        new Request('http://localhost/multipass/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&client_id=local&client_secret=dev',
        }),
        settingsFromEnv({ ONTOS_AUTH_MODE: 'dev' }),
      ),
    );

    if (!tokenRes.ok) throw new Error('Expected tokenRoute to succeed.');

    expect(tokenRes.value.status).toBe(200);

    expect(await tokenRes.value.json()).toEqual({
      access_token: DEFAULT_DEV_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const badGrant = await settle(
      provider.tokenRoute(
        new Request('http://localhost/multipass/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=password',
        }),
        settingsFromEnv({ ONTOS_AUTH_MODE: 'dev' }),
      ),
    );

    if (!badGrant.ok) throw new Error('Expected badGrant tokenRoute to succeed.');

    expect(badGrant.value.status).toBe(400);

    expect(await badGrant.value.json()).toEqual({ error: 'unsupported_grant_type' });
  });
});

describe('oidcIdentityProvider', () => {
  let jwks: JwksFixture;

  beforeAll(async () => {
    jwks = await startJwksFixture();
  });

  afterAll(async () => {
    await jwks.close();
  });

  it('verifies RS256 JWTs, extracts org, array or scope permissions, and profile claims', async () => {
    const provider = oidcIdentityProvider({
      issuer: jwks.issuer,
      audience: 'https://ontos.example',
      baseUrl: 'https://ontos.example',
      orgClaim: 'tenant_id',
      defaultOrg: 'org-default',
      permissionsClaim: 'scope',
    });

    const token = await jwks.sign({
      sub: 'alice-123',
      aud: 'https://ontos.example',
      tenant_id: 'org-acme',
      scope: 'accounts:read accounts:write accounts:read',
      email: 'alice@acme.example',
      preferred_username: 'alice',
      given_name: 'Alice',
      family_name: 'Smith',
    });

    const verified = await settle(
      provider.authenticate(
        new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${token}` } }),
        { access: 'data' },
      ),
    );

    expect(verified).toEqual({
      ok: true,
      value: {
        user: UserId.parse('alice-123'),
        kind: 'person',
        organization: OrganizationId.parse('org-acme'),
        permissions: ['accounts:read', 'accounts:write'],
        profile: {
          username: 'alice',
          email: 'alice@acme.example',
          givenName: 'Alice',
          familyName: 'Smith',
          realm: 'oidc',
        },
      },
    });

    const fallbackToken = await jwks.sign({
      sub: 'bob-456',
      aud: 'https://ontos.example',
      scope: ['accounts:read'],
    });

    const fallback = await settle(
      provider.authenticate(
        new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${fallbackToken}` } }),
        { access: 'data' },
      ),
    );

    expect(fallback).toEqual({
      ok: true,
      value: {
        user: UserId.parse('bob-456'),
        kind: 'person',
        organization: OrganizationId.parse('org-default'),
        permissions: ['accounts:read'],
        profile: { username: 'bob-456', realm: 'oidc' },
      },
    });
  });

  it('rejects wrong issuer, wrong audience, expired tokens, and untrusted keys', async () => {
    const provider = oidcIdentityProvider({
      issuer: jwks.issuer,
      audience: 'https://ontos.example',
      baseUrl: 'https://ontos.example',
    });

    const badIssuer = await jwks.sign({ iss: 'https://wrong.example', aud: 'https://ontos.example' });

    const badAudience = await jwks.sign({ aud: 'https://other.example' });

    const expired = await jwks.sign({ aud: 'https://ontos.example' }, { exp: Math.floor(Date.now() / 1000) - 60 });

    const untrusted = await jwks.signUntrusted({ aud: 'https://ontos.example' });

    for (const bad of [badIssuer, badAudience, expired, untrusted]) {
      const checked = await settle(
        provider.authenticate(
          new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${bad}` } }),
          { access: 'data' },
        ),
      );

      expect(checked.ok).toBe(false);
    }
  });

  it('authenticates publish via static ONTOS_PUBLISH_TOKEN and via publish OIDC subject', async () => {
    const provider = oidcIdentityProvider({
      issuer: jwks.issuer,
      baseUrl: 'https://ontos.example',
      publish: {
        token: 'super-secret-publish-token',
        oidc: { issuer: jwks.issuer, subject: 'ci-publisher', audience: 'https://ontos.example' },
      },
    });

    const staticOk = await settle(
      provider.authenticate(
        new Request('http://localhost/api/ontology-service/v1/publish', {
          headers: { authorization: 'Bearer super-secret-publish-token' },
        }),
        { access: 'publish' },
      ),
    );

    expect(staticOk).toEqual({ ok: true, value: { user: UserId.parse('publish_token'), kind: 'publish' } });

    const staticWrong = await settle(
      provider.authenticate(
        new Request('http://localhost/api/ontology-service/v1/publish', {
          headers: { authorization: 'Bearer wrong-publish-token' },
        }),
        { access: 'publish' },
      ),
    );

    expect(staticWrong.ok).toBe(false);

    const oidcPublishJwt = await jwks.sign({ sub: 'ci-publisher', aud: 'https://ontos.example' });

    const oidcPublishOk = await settle(
      provider.authenticate(
        new Request('http://localhost/api/ontology-service/v1/publish', {
          headers: { authorization: `Bearer ${oidcPublishJwt}` },
        }),
        { access: 'publish' },
      ),
    );

    expect(oidcPublishOk).toEqual({ ok: true, value: { user: UserId.parse('ci-publisher'), kind: 'publish' } });

    const mcpJwt = await jwks.sign({
      sub: 'mcp-user',
      aud: 'https://ontos.example/api/mcp',
      org_id: 'org-1',
      azp: 'mcp-app',
    });

    const mcpOk = await settle(
      provider.authenticateMcp(
        new Request('http://localhost/api/mcp', { headers: { authorization: `Bearer ${mcpJwt}` } }),
      ),
    );

    expect(mcpOk).toMatchObject({
      ok: true,
      value: { user: UserId.parse('mcp-user'), organization: OrganizationId.parse('org-1'), clientId: 'mcp-app' },
    });
  });

  it('defaults user audience to baseUrl, isolates MCP audience, rejects M2M MCP tokens, strips wildcard *, and fails closed on invalid orgClaim', async () => {
    const provider = oidcIdentityProvider({
      issuer: jwks.issuer,
      baseUrl: 'https://ontos.example',
      defaultOrg: 'org-default',
    });

    const wrongAudUser = await jwks.sign({ sub: 'user-1', aud: 'https://other-rp.example' });

    const noAudUser = await jwks.sign({ sub: 'user-1' });

    const baseAudUser = await jwks.sign({
      sub: 'user-1',
      aud: 'https://ontos.example',
      permissions: ['*', 'accounts:read'],
      org_id: ['not-a-string'],
    });

    for (const bad of [wrongAudUser, noAudUser]) {
      const checked = await settle(
        provider.authenticate(
          new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${bad}` } }),
          { access: 'data' },
        ),
      );

      expect(checked.ok).toBe(false);
    }

    const valid = await settle(
      provider.authenticate(
        new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${baseAudUser}` } }),
        { access: 'data' },
      ),
    );

    expect(valid).toEqual({
      ok: true,
      value: {
        user: UserId.parse('user-1'),
        kind: 'person',
        permissions: ['accounts:read'],
        profile: { username: 'user-1', realm: 'oidc' },
      },
    });

    const userAudOnMcp = await settle(
      provider.authenticateMcp(
        new Request('http://localhost/api/mcp', { headers: { authorization: `Bearer ${baseAudUser}` } }),
      ),
    );

    expect(userAudOnMcp.ok).toBe(false);

    const m2mMcp = await jwks.sign({
      sub: 'client-123',
      client_id: 'client-123',
      aud: 'https://ontos.example/api/mcp',
    });

    const m2mRejected = await settle(
      provider.authenticateMcp(
        new Request('http://localhost/api/mcp', { headers: { authorization: `Bearer ${m2mMcp}` } }),
      ),
    );

    expect(m2mRejected.ok).toBe(false);
  });
});

describe('devIdentityProvider custom tokenRoute and production env guards', () => {
  it('requires client_secret matching custom ONTOS_DEV_TOKEN on tokenRoute', async () => {
    const provider = devIdentityProvider({ token: 'custom-secret-value' });
    const devSettings = settingsFromEnv({ ONTOS_AUTH_MODE: 'dev' });

    const noSecret = await settle(
      provider.tokenRoute(
        new Request('http://localhost/multipass/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&client_id=local&client_secret=wrong',
        }),
        devSettings,
      ),
    );

    if (!noSecret.ok) throw new Error('Expected tokenRoute to return a Response.');

    expect(noSecret.value.status).toBe(401);

    const matchingSecret = await settle(
      provider.tokenRoute(
        new Request('http://localhost/multipass/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials&client_id=local&client_secret=custom-secret-value',
        }),
        devSettings,
      ),
    );

    if (!matchingSecret.ok) throw new Error('Expected tokenRoute to return a Response.');

    expect(matchingSecret.value.status).toBe(200);
  });

  it.each([
    { ONTOS_AUTH_MODE: 'dev', ONTOLOGY_ENVIRONMENT: 'prod', DATABASE_URL: 'postgresql://localhost/dev' },
    { ONTOS_AUTH_MODE: 'dev', NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/dev' },
    { ONTOS_AUTH_MODE: 'dev', VERCEL_ENV: 'production', DATABASE_URL: 'postgresql://localhost/dev' },
  ])('refuses dev mode when production env signal is present', (env) => {
    expect(() => settingsFromEnv(env)).toThrow(/ONTOS_AUTH_MODE=dev is refused/);

    expect(inputFromEnv(env, () => new pg.Pool({ connectionString: 'postgresql://localhost/unused' }))).toEqual({
      missing: ['ONTOS_AUTH_MODE'],
      reason: 'ONTOS_AUTH_MODE=dev is refused when ONTOLOGY_ENVIRONMENT=production.',
    });
  });

  it('rejects malformed AUTHKIT_DOMAIN and ONTOLOGY_BASE_URL in inputFromEnv', () => {
    const dummyPool = () => new pg.Pool({ connectionString: 'postgresql://localhost/unused' });

    expect(
      inputFromEnv(
        {
          ...testEnv,
          DATABASE_URL: 'postgresql://localhost/db',
          WORKOS_API_KEY: 'sk_test',
          AUTHKIT_DOMAIN: 'a@evil.test/x',
        },
        dummyPool,
      ),
    ).toEqual({ missing: ['AUTHKIT_DOMAIN'] });

    expect(
      inputFromEnv(
        {
          ...testEnv,
          DATABASE_URL: 'postgresql://localhost/db',
          WORKOS_API_KEY: 'sk_test',
          ONTOLOGY_BASE_URL: 'not-a-url',
        },
        dummyPool,
      ),
    ).toEqual({ missing: ['ONTOLOGY_BASE_URL'] });
  });
});

describe('inputFromEnv and settingsFromEnv auth modes', () => {
  const newPool = (connectionString: string) => new pg.Pool({ connectionString });
  const poolSpy = () => vi.spyOn({ newPool }, 'newPool');

  it('boots dev mode with only DATABASE_URL and defaults DATABASE_URL_DIRECT, PRODUCT_RID, environment, baseUrl, and MCP', () => {
    const createPool = poolSpy();
    const input = inputFromEnv({ ONTOS_AUTH_MODE: 'dev', DATABASE_URL: 'postgresql://localhost/dev' }, createPool);

    expect('missing' in input).toBe(false);
    expect(createPool.mock.calls).toEqual([['postgresql://localhost/dev']]);

    const ready = input as HandleInput;

    expect(ready.directDb).toBe(ready.db);

    expect(ready.settings).toEqual({
      productRid: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000001',
      environment: 'development',
      auth: { workosClientId: 'dev', baseUrl: 'http://localhost:8080', app: { repository: '', environment: '' } },
      authMode: 'dev',
      mcp: true,
    });

    expect(ready.identity?.mode).toBe('dev');
  });

  it.each(['production', 'PRODUCTION', 'Production', ' production '] as const)(
    'refuses dev mode when ONTOLOGY_ENVIRONMENT is %j in settingsFromEnv, inputFromEnv, and handle',
    async (environment) => {
      const prodDev = {
        ONTOS_AUTH_MODE: 'dev',
        ONTOLOGY_ENVIRONMENT: environment,
        DATABASE_URL: 'postgresql://localhost/dev',
      };

      expect(() => settingsFromEnv(prodDev)).toThrow(/ONTOS_AUTH_MODE=dev is refused/);

      const createPool = poolSpy();
      const missing = inputFromEnv(prodDev, createPool) as MissingSettings;

      expect(missing).toEqual({
        missing: ['ONTOS_AUTH_MODE'],
        reason: 'ONTOS_AUTH_MODE=dev is refused when ONTOLOGY_ENVIRONMENT=production.',
      });

      expect(createPool).not.toHaveBeenCalled();

      const pool = newPool('postgresql://localhost/unused');
      const db = createDb(pool);
      const identity = devIdentityProvider();

      const directDevInput: HandleInput = {
        db,
        directDb: db,
        settings: {
          productRid: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000001',
          environment,
          auth: { workosClientId: 'dev', baseUrl: 'http://localhost:8080', app: { repository: '', environment: '' } },
          authMode: 'dev',
        },
        keys: unusedKeys(),
        users: identity.users,
        workos: identity.workos,
        identity,
      };

      const log = vi.spyOn(console, 'log');

      try {
        const fromEnvResponse = await handle(
          new Request('http://localhost/api/ontology-service/v1/client-config'),
          missing,
        );

        expect(fromEnvResponse.status).toBe(503);

        expect(await fromEnvResponse.json()).toMatchObject({ errorName: 'OntologyService:SettingMissing' });

        const directResponse = await handle(
          new Request('http://localhost/api/ontology-service/v1/client-config'),
          directDevInput,
        );

        expect(directResponse.status).toBe(503);

        expect(await directResponse.json()).toMatchObject({ errorName: 'OntologyService:SettingMissing' });
      } finally {
        log.mockRestore();

        await pool.end();
      }
    },
  );

  it('trims ONTOLOGY_ENVIRONMENT in settingsFromEnv', () => {
    expect(settingsFromEnv({ ONTOS_AUTH_MODE: 'dev', ONTOLOGY_ENVIRONMENT: ' staging ' }).environment).toBe('staging');
    expect(settingsFromEnv({ ONTOS_AUTH_MODE: 'dev', ONTOLOGY_ENVIRONMENT: '   ' }).environment).toBe('development');
    expect(settingsFromEnv({ ...testEnv, ONTOLOGY_ENVIRONMENT: ' staging ' }).environment).toBe('staging');
  });

  it('defaults DATABASE_URL_DIRECT to DATABASE_URL in workos and oidc modes', () => {
    const workosPools = poolSpy();

    const workosInput = inputFromEnv(
      { ...testEnv, DATABASE_URL: 'postgresql://localhost/workos', WORKOS_API_KEY: 'sk_test' },
      workosPools,
    );

    expect('missing' in workosInput).toBe(false);
    expect('db' in workosInput && workosInput.directDb === workosInput.db).toBe(true);
    expect(workosPools.mock.calls).toEqual([['postgresql://localhost/workos']]);

    const oidcPools = poolSpy();

    const oidcInput = inputFromEnv(
      {
        ONTOS_AUTH_MODE: 'oidc',
        PRODUCT_RID: testEnv.PRODUCT_RID,
        ONTOLOGY_ENVIRONMENT: 'staging',
        ONTOLOGY_BASE_URL: 'https://ontos.example',
        ONTOS_OIDC_ISSUER: 'https://idp.example',
        DATABASE_URL: 'postgresql://localhost/oidc',
      },
      oidcPools,
    );

    expect('missing' in oidcInput).toBe(false);
    expect('db' in oidcInput && oidcInput.directDb === oidcInput.db).toBe(true);
    expect(oidcPools.mock.calls).toEqual([['postgresql://localhost/oidc']]);
    expect((oidcInput as HandleInput).identity?.mode).toBe('oidc');
  });

  it('rejects invalid ONTOS_AUTH_MODE and invalid OIDC URLs', () => {
    expect(inputFromEnv({ ONTOS_AUTH_MODE: 'invalid' }, newPool)).toEqual({ missing: ['ONTOS_AUTH_MODE'] });
    expect(() => settingsFromEnv({ ONTOS_AUTH_MODE: 'invalid' })).toThrow(/ONTOS_AUTH_MODE/);

    expect(
      inputFromEnv(
        {
          ONTOS_AUTH_MODE: 'oidc',
          PRODUCT_RID: testEnv.PRODUCT_RID,
          ONTOLOGY_ENVIRONMENT: 'staging',
          ONTOLOGY_BASE_URL: 'https://ontos.example',
          ONTOS_OIDC_ISSUER: 'not-a-url',
          DATABASE_URL: 'postgresql://localhost/oidc',
        },
        newPool,
      ),
    ).toEqual({ missing: ['ONTOS_OIDC_ISSUER'] });
  });
});

describe('wildcard permissions in forPermissions', () => {
  it('grants every Object Type, Link Type, Action Type, and Function when caller holds *', () => {
    const ir = twinIr('0.7.0');
    const grants = twinGrants('0.7.0');
    const compiled = orThrow(compileOntology({ ...stored(ir), functions: twinFunctions('0.7.0') }));
    const index = permissionIndex(compiled, grants);
    const view = forPermissions(compiled, index, new Set(['*']));

    expect([...view.objectTypes.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [...compiled.objectTypes.keys()].sort((a, b) => a.localeCompare(b)),
    );

    expect([...view.actionTypes.keys()].sort((a, b) => a.localeCompare(b))).toEqual(
      [...compiled.actionTypes.keys()].sort((a, b) => a.localeCompare(b)),
    );

    expect(view.objectTypes.has(`${NS}Account`)).toBe(true);
  });
});
