import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEngineChanges, createDb, createPool } from '../../db/index.ts';
import { orThrow } from '../../errors/index.ts';
import { inputFromEnv } from '../../handler/index.ts';
import { closeServer, listenLocal } from '../../localServer.test-utils.ts';
import { createNodeServer } from '../../node.ts';
import { NS, ONTOLOGY_RID, stored, twinFunctions, twinGrants, twinIr } from '../../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../../postgres.test-utils.ts';
import { onNewConnection } from '../../publish/publish.test-utils.ts';
import { DEFAULT_DEV_TOKEN, DEV_ORG_ID, DEV_USER_ID } from './dev.ts';

const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;

async function serviceRoleUrl(postgres: TestPostgres, tag: string): Promise<string> {
  const roleName = `${postgres.role}_${tag}`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${roleName} LOGIN PASSWORD '${roleName}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${postgres.role} TO ${roleName}`);

  const url = new URL(postgres.url);

  url.username = roleName;
  url.password = roleName;

  return url.toString();
}

function twinPublishPayload() {
  const ir = twinIr('0.7.0');

  return {
    product: 'twin',
    ir,
    functions: twinFunctions('0.7.0'),
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants: twinGrants('0.7.0'),
    validateOnly: false,
  };
}

async function parseMcpBody(response: Response): Promise<unknown> {
  const text = await response.text();

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const dataLine = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('data:'));

    return dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : undefined;
  }

  return JSON.parse(text);
}

describe('dev auth mode end-to-end against Postgres', () => {
  let postgres: TestPostgres;
  let server: Server;
  let baseUrl: string;
  const pools: pg.Pool[] = [];

  beforeAll(async () => {
    postgres = await startPostgres();

    const databaseUrl = await serviceRoleUrl(postgres, 'dev_e2e');

    const input = inputFromEnv({ DATABASE_URL: databaseUrl, ONTOS_AUTH_MODE: 'dev' }, (connectionString) => {
      const pool = createPool(connectionString);

      pools.push(pool);

      return pool;
    });

    server = createNodeServer(input);

    baseUrl = await listenLocal(server);
  }, 60_000);

  afterAll(async () => {
    await closeServer(server);

    await Promise.all(pools.map((pool) => pool.end()));

    await postgres.stop();
  });

  it('boots with only DATABASE_URL + ONTOS_AUTH_MODE=dev and runs token, users, publish, install, apply, loadObjects, and MCP', async () => {
    const tokenResponse = await fetch(`${baseUrl}/multipass/api/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&client_id=local&client_secret=local',
    });

    expect(tokenResponse.status).toBe(200);

    const tokenBody = (await tokenResponse.json()) as { access_token: string; token_type: string; expires_in: number };

    expect(tokenBody).toEqual({ access_token: DEFAULT_DEV_TOKEN, token_type: 'Bearer', expires_in: 3600 });

    const authHeaders = {
      authorization: `Bearer ${tokenBody.access_token}`,
      'content-type': 'application/json',
    };

    const unauth = await fetch(`${baseUrl}/api/v2/admin/users/getCurrent`);

    expect(unauth.status).toBe(401);

    const badToken = await fetch(`${baseUrl}/api/v2/admin/users/getCurrent`, {
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(badToken.status).toBe(401);

    const currentUser = await fetch(`${baseUrl}/api/v2/admin/users/getCurrent`, { headers: authHeaders });

    expect(currentUser.status).toBe(200);

    expect(await currentUser.json()).toMatchObject({ id: DEV_USER_ID, status: 'ACTIVE', realm: 'dev' });

    const orgs = await fetch(`${baseUrl}/api/ontology-service/v1/organizations`, { headers: authHeaders });

    expect(orgs.status).toBe(200);

    expect(await orgs.json()).toEqual({ data: [{ id: DEV_ORG_ID, name: 'Local Dev' }] });

    const published = await fetch(`${baseUrl}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(twinPublishPayload()),
    });

    expect(published.status).toBe(200);

    expect(await published.json()).toMatchObject({ version: 1 });

    const installed = await fetch(`${baseUrl}/api/ontology-service/v1/ontologies`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ product: 'twin', apiName: 'twin', displayName: 'Twin Dev' }),
    });

    expect(installed.status).toBe(200);

    const { rid } = (await installed.json()) as { rid: string };

    expect(rid).toMatch(/^ri\.ontology\.main\.ontology\./);

    const applied = await fetch(`${baseUrl}/api/v2/ontologies/${rid}/actions/${CREATE_ACCOUNT}/apply`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        parameters: { accountId: 'dev-acc-1', name: 'Local Acme', phase: 'customer' },
        options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
      }),
    });

    expect(applied.status).toBe(200);

    const loaded = await fetch(`${baseUrl}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ objectSet: { type: 'base', objectType: ACCOUNT } }),
    });

    expect(loaded.status).toBe(200);

    const loadedBody = (await loaded.json()) as { data: Record<string, unknown>[] };

    expect(loadedBody.data.map((row) => [row['accountId'], row['name']])).toEqual([['dev-acc-1', 'Local Acme']]);

    const mcpHeaders = {
      authorization: `Bearer ${tokenBody.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const mcpLoad = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'load_objects',
          arguments: { objectSet: { type: 'base', objectType: ACCOUNT } },
        },
      }),
    });

    expect(mcpLoad.status).toBe(200);

    const mcpResult = (await parseMcpBody(mcpLoad)) as {
      result?: { isError?: boolean; content?: { type: string; text: string }[] };
    };

    expect(mcpResult.result?.isError).not.toBe(true);
    expect(mcpResult.result?.content?.[0]?.text).toContain('Local Acme');
  });

  it('refuses ONTOLOGY_ENVIRONMENT=production in dev mode', async () => {
    const prodInput = inputFromEnv(
      {
        DATABASE_URL: 'postgresql://localhost/unused',
        ONTOS_AUTH_MODE: 'dev',
        ONTOLOGY_ENVIRONMENT: 'production',
      },
      createPool,
    );

    const prodServer = createNodeServer(prodInput);

    const prodUrl = await listenLocal(prodServer);

    try {
      const response = await fetch(`${prodUrl}/api/ontology-service/v1/client-config`);

      expect(response.status).toBe(503);

      expect(await response.json()).toMatchObject({ errorName: 'OntologyService:SettingMissing' });
    } finally {
      await closeServer(prodServer);
    }
  });
});

describe('oidc auth mode end-to-end against Postgres', () => {
  const PUBLISH_SECRET = 'oidc-ci-publish-secret-123';
  const AUDIENCE = 'https://ontos-oidc-test.example';
  let postgres: TestPostgres;
  let jwksServer: Server;
  let serviceServer: Server;
  let issuerUrl: string;
  let baseUrl: string;
  let privateKey: CryptoKey;
  const pools: pg.Pool[] = [];

  const signJwt = (claims: Record<string, unknown>): Promise<string> =>
    new SignJWT({ iss: issuerUrl, aud: AUDIENCE, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'oidc-sql-1' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');

    privateKey = pair.privateKey;

    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'oidc-sql-1', use: 'sig', alg: 'RS256' };

    jwksServer = createServer((request, response) => {
      if (request.url === '/.well-known/jwks.json') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));

        return;
      }

      response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));

    const { port } = jwksServer.address() as AddressInfo;

    issuerUrl = `http://127.0.0.1:${port}`;

    postgres = await startPostgres();

    const databaseUrl = await serviceRoleUrl(postgres, 'oidc_e2e');

    const setupPool = createPool(databaseUrl);

    pools.push(setupPool);

    await orThrow(applyEngineChanges(createDb(setupPool)));

    const input = inputFromEnv(
      {
        ONTOS_AUTH_MODE: 'oidc',
        DATABASE_URL: databaseUrl,
        PRODUCT_RID: ONTOLOGY_RID,
        ONTOLOGY_ENVIRONMENT: 'staging',
        ONTOLOGY_BASE_URL: AUDIENCE,
        ONTOS_OIDC_ISSUER: issuerUrl,
        ONTOS_OIDC_AUDIENCE: AUDIENCE,
        ONTOS_PUBLISH_TOKEN: PUBLISH_SECRET,
      },
      (connectionString) => {
        const pool = createPool(connectionString);

        pools.push(pool);

        return pool;
      },
    );

    serviceServer = createNodeServer(input);

    baseUrl = await listenLocal(serviceServer);
  }, 60_000);

  afterAll(async () => {
    await closeServer(serviceServer);

    await closeServer(jwksServer);

    await Promise.all(pools.map((pool) => pool.end()));

    await postgres.stop();
  });

  it('verifies RS256 JWTs, enforces publish token, issuer/audience, permissions, and org isolation', async () => {
    const grants = twinGrants('0.7.0');
    const allTwinPermissions = Object.keys(grants.permissions);

    const aliceToken = await signJwt({
      sub: 'alice-oidc',
      org_id: 'org-alpha',
      permissions: ['ontology:install', ...allTwinPermissions],
      email: 'alice@alpha.example',
      preferred_username: 'alice',
    });

    const wrongPublish = await fetch(`${baseUrl}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-publish-token', 'content-type': 'application/json' },
      body: JSON.stringify(twinPublishPayload()),
    });

    expect(wrongPublish.status).toBe(401);

    await wrongPublish.text();

    const userCannotPublish = await fetch(`${baseUrl}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(twinPublishPayload()),
    });

    expect(userCannotPublish.status).toBe(403);

    await userCannotPublish.text();

    const publishTokenBlockedOnData = await fetch(`${baseUrl}/api/v2/ontologies`, {
      headers: { authorization: `Bearer ${PUBLISH_SECRET}` },
    });

    expect(publishTokenBlockedOnData.status).toBe(403);

    await publishTokenBlockedOnData.text();

    const published = await fetch(`${baseUrl}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PUBLISH_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(twinPublishPayload()),
    });

    expect(published.status).toBe(200);

    expect(await published.json()).toMatchObject({ version: 1 });

    const aliceHeaders = { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' };

    const currentUser = await fetch(`${baseUrl}/api/v2/admin/users/getCurrent`, { headers: aliceHeaders });

    expect(currentUser.status).toBe(200);

    expect(await currentUser.json()).toMatchObject({
      id: 'alice-oidc',
      username: 'alice',
      email: 'alice@alpha.example',
      realm: 'oidc',
    });

    const aliceOrgs = await fetch(`${baseUrl}/api/ontology-service/v1/organizations`, { headers: aliceHeaders });

    expect(aliceOrgs.status).toBe(200);

    expect(await aliceOrgs.json()).toEqual({ data: [{ id: 'org-alpha' }] });

    const installed = await fetch(`${baseUrl}/api/ontology-service/v1/ontologies`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify({ product: 'twin', apiName: 'twin', displayName: 'Alpha Twin' }),
    });

    expect(installed.status).toBe(200);

    const { rid: alphaRid } = (await installed.json()) as { rid: string };

    const created = await fetch(`${baseUrl}/api/v2/ontologies/${alphaRid}/actions/${CREATE_ACCOUNT}/apply`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify({
        parameters: { accountId: 'oidc-1', name: 'Alpha Corp', phase: 'customer' },
        options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
      }),
    });

    expect(created.status).toBe(200);

    const wrongAudienceToken = await signJwt({
      sub: 'alice-oidc',
      aud: 'https://wrong-audience.example',
      org_id: 'org-alpha',
      permissions: allTwinPermissions,
    });

    const wrongAudienceRes = await fetch(`${baseUrl}/api/v2/ontologies/${alphaRid}/objectTypes`, {
      headers: { authorization: `Bearer ${wrongAudienceToken}` },
    });

    expect(wrongAudienceRes.status).toBe(401);

    const accountReadPermission = grants.objectTypes[ACCOUNT];

    const readerToken = await signJwt({
      sub: 'reader-oidc',
      org_id: 'org-alpha',
      permissions: accountReadPermission,
    });

    const readerLoad = await fetch(`${baseUrl}/api/v2/ontologies/${alphaRid}/objectSets/loadObjects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ objectSet: { type: 'base', objectType: ACCOUNT } }),
    });

    expect(readerLoad.status).toBe(200);

    expect(((await readerLoad.json()) as { data: Record<string, unknown>[] }).data.map((r) => r['accountId'])).toEqual([
      'oidc-1',
    ]);

    const readerApply = await fetch(`${baseUrl}/api/v2/ontologies/${alphaRid}/actions/${CREATE_ACCOUNT}/apply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        parameters: { accountId: 'oidc-2', name: 'Denied Corp', phase: 'customer' },
        options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
      }),
    });

    expect(readerApply.status).toBe(404);

    const bobOtherOrgToken = await signJwt({
      sub: 'bob-oidc',
      org_id: 'org-beta',
      permissions: allTwinPermissions,
    });

    const crossOrgRead = await fetch(`${baseUrl}/api/v2/ontologies/${alphaRid}/objectTypes`, {
      headers: { authorization: `Bearer ${bobOtherOrgToken}` },
    });

    expect(crossOrgRead.status).toBe(404);
  });
});
