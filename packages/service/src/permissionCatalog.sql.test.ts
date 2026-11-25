import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installOntology } from './install.test-utils.ts';

import { convertOrThrow, ONTOLOGY_RID, stored, twinFunctions, twinIr } from './ontology/stored.test-utils.ts';
import type { Server } from 'node:http';
import { createNodeServer } from './node.ts';
import { mcpSettings, startMcpService, type McpService } from './mcp/mcp.test-utils.ts';
import { routeSpans } from './routeHarness.test-utils.ts';
import { now, ORGANIZATION, OTHER_ORGANIZATION, SERVICE_USER } from './tokens.test-utils.ts';
import { STUB_APPLICATION, STUB_PERSON, stubPublish, stubWorkos, type StubWorkos } from './workos.test-utils.ts';
import { workosUsers } from './auth/index.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

const V3_RID = 'ri.ontology.main.ontology.6b0c1f5e-3c52-4c1e-9d4e-2f1a7a0c9b11';
const FOREIGN_RID = 'ri.ontology.main.ontology.6b0c1f5e-3c52-4c1e-9d4e-2f1a7a0c9b12';
const UNKNOWN_RID = 'ri.ontology.main.ontology.6b0c1f5e-3c52-4c1e-9d4e-2f1a7a0c9b13';
const V2_RID = 'ri.ontology.main.ontology.6b0c1f5e-3c52-4c1e-9d4e-2f1a7a0c9b14';

const GRANTS_V3: unknown = JSON.parse(
  readFileSync(new URL('../twin/ontology/0.7.0/grants.json', import.meta.url), 'utf8'),
);

const TWIN_CATALOG = {
  data: [
    {
      slug: 'accounts:close',
      description: 'Close accounts and copy their phase to engagements',
      requires: ['accounts:read', 'engagements:read'],
    },
    { slug: 'accounts:read', description: 'View accounts', requires: [] },
    { slug: 'accounts:write', description: 'Create and change accounts', requires: ['accounts:read'] },
    { slug: 'engagements:read', description: 'View engagements', requires: [] },
    { slug: 'engagements:write', description: 'Create and change engagements', requires: ['engagements:read'] },
    { slug: 'ontology:install', description: 'Install an Ontology of a product in the Organization', requires: [] },
    { slug: 'probes:read', description: 'View struct probes', requires: [] },
    { slug: 'probes:write', description: 'Create and change struct probes', requires: ['probes:read'] },
  ],
};

const TWIN = convertOrThrow(
  { ...stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') }), validateOnly: false },
  ONTOLOGY_RID,
  1,
);

let service: McpService;

beforeAll(async () => {
  service = await startMcpService();

  await service.db.query({
    text: `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
      SELECT product, 2, ir, metadata, schema_migrations, osdk_set, functions, $1::jsonb, publisher FROM ontology_registry.product_versions WHERE product = 'twin' AND version = 1`,
    values: [JSON.stringify(GRANTS_V3)],
  });

  await installOntology(service.db, {
    rid: V3_RID,
    product: 'twin',
    apiName: 'twinv3',
    displayName: 'twin v3',
    organization: ORGANIZATION,
  });

  await installOntology(service.db, {
    rid: FOREIGN_RID,
    product: 'twin',
    apiName: 'twin',
    displayName: 'twin',
    organization: OTHER_ORGANIZATION,
  });
});

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map(closeServer));

  await service.stop();
});

const HOLDER = {
  id: 'user_01TEST00000000000000000002',
  email: 'grace@example.com',
  first_name: 'Grace',
  last_name: 'Hopper',
};

function rolesStub(): StubWorkos {
  return stubWorkos(
    [STUB_PERSON, HOLDER],
    [
      { user_id: STUB_PERSON.id, organization_id: ORGANIZATION, status: 'active', roles: ['member'] },
      { user_id: HOLDER.id, organization_id: ORGANIZATION, status: 'active', roles: ['admin'] },
    ],
    { roles: { [ORGANIZATION]: { member: [], admin: ['accounts:read'] } } },
  );
}

async function serveWith(stub: StubWorkos): Promise<string> {
  const server = createNodeServer({
    db: fallibleOf(service.db),
    directDb: fallibleOf(service.db),
    settings: mcpSettings,
    keys: service.issuer.keys,
    users: workosUsers('sk_test_stub', { fetch: stub.fetch }),
    workos: stubPublish(),
  });

  servers.push(server);

  return listenLocal(server);
}

async function catalogAt(baseUrl: string, rid: string, user: string): Promise<Response> {
  const token = await service.issuer.workos({ exp: now() + 3600, sub: user });

  return fetch(new URL(`/api/ontology-service/v1/ontologies/${rid}/permissions`, baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
}

interface Answer {
  readonly status: number;
  readonly text: string;
}

async function catalog(rid: string, token?: string): Promise<Answer> {
  const bearer = token ?? (await service.issuer.workos({ exp: now() + 3600 }));

  const response = await fetch(new URL(`/api/ontology-service/v1/ontologies/${rid}/permissions`, service.baseUrl), {
    headers: { authorization: `Bearer ${bearer}` },
  });

  return { status: response.status, text: await response.text() };
}

function errorOf(answer: Answer): unknown {
  const { errorInstanceId, ...rest } = JSON.parse(answer.text) as { errorInstanceId: string };

  void errorInstanceId;

  return { status: answer.status, ...rest };
}

describe('the permission catalog route', () => {
  it('service/ontology-service#permission-catalog: GET .../permissions gives the literal catalog of the twin, in the code point order of slug', async () => {
    const answer = await catalog(V3_RID);

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual(TWIN_CATALOG);

    const spans = await routeSpans();

    const compiles = spans.filter(
      (span) => span.name === 'ontology compile' && span.attributes['ontology.version'] === 2,
    );

    const parents = compiles.map(
      (compile) => spans.find((span) => span.spanId === compile.parentSpanId)?.attributes['route.key'],
    );

    expect(parents).toEqual(['GET /api/ontology-service/v1/ontologies/{ontologyRid}/permissions']);
  });

  it('service/ontology-service#permission-catalog: requires is the direct list of the index that the version load builds', async () => {
    const { data } = JSON.parse((await catalog(V3_RID)).text) as typeof TWIN_CATALOG;

    expect(Object.fromEntries(data.map(({ slug, requires }) => [slug, requires]))).toEqual({
      'accounts:close': ['accounts:read', 'engagements:read'],
      'accounts:read': [],
      'accounts:write': ['accounts:read'],
      'engagements:read': [],
      'engagements:write': ['engagements:read'],
      'ontology:install': [],
      'probes:read': [],
      'probes:write': ['probes:read'],
    });
  });

  it('service/ontology-service#permission-catalog: the answer names no Object Type and no Action Type of the twin', async () => {
    const text = (await catalog(V3_RID)).text;

    const names = [...TWIN.objectTypes.keys(), ...TWIN.actionTypes.keys()];

    expect(names.length).toBe(16);

    for (const name of names) {
      expect(text).not.toContain(name);
      expect(text).not.toContain(name.split('.').at(-1));
    }
  });

  it('service/ontology-service#permission-catalog: a member with no permission and a member with a permission both read the same catalog', async () => {
    const stub = rolesStub();

    const baseUrl = await serveWith(stub);

    const without = await catalogAt(baseUrl, V3_RID, STUB_PERSON.id);

    const holder = await catalogAt(baseUrl, V3_RID, HOLDER.id);

    expect([without.status, holder.status]).toEqual([200, 200]);

    expect(await without.json()).toEqual(TWIN_CATALOG);

    expect(await holder.json()).toEqual(TWIN_CATALOG);

    expect(stub.requests.filter((request) => request.startsWith('/authorization/organizations/')).sort()).toEqual([
      `/authorization/organizations/${ORGANIZATION}/roles/admin`,
      `/authorization/organizations/${ORGANIZATION}/roles/member`,
    ]);
  });

  it('service/authentication#permissions-of-a-caller service/ontology-service#permission-catalog: with WorkOS down and no kept answer, the catalog gives 503 with Retry-After, never the catalog', async () => {
    const stub = rolesStub();

    stub.fail('5xx');

    const answer = await catalogAt(await serveWith(stub), V3_RID, STUB_PERSON.id);

    expect(answer.status).toBe(503);
    expect(answer.headers.get('retry-after')).toBe('10');

    const { errorInstanceId, ...body } = (await answer.json()) as { errorInstanceId: string };

    expect(typeof errorInstanceId).toBe('string');
    expect(body).toEqual({ errorCode: 'INTERNAL', errorName: 'OntologyService:WorkosUnavailable', parameters: {} });
  });

  it('service/ontology-service#permission-catalog: a RID of another Organization gets 404 OntologyNotFound, the same as an unknown RID', async () => {
    const foreign = errorOf(await catalog(FOREIGN_RID));

    const unknown = errorOf(await catalog(UNKNOWN_RID));

    expect(foreign).toEqual({
      status: 404,
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      parameters: { ontologyRid: FOREIGN_RID },
    });

    expect(unknown).toEqual({
      status: 404,
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      parameters: { ontologyRid: UNKNOWN_RID },
    });
  });

  it('service/ontology-service#permission-catalog: a service user of the owner Organization with no scope reads the catalog', async () => {
    const stub = stubWorkos();

    expect(stub.applications()[SERVICE_USER]?.scopes).toEqual([]);

    const token = await service.issuer.m2m();

    const response = await fetch(
      new URL(`/api/ontology-service/v1/ontologies/${V3_RID}/permissions`, await serveWith(stub)),
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual(TWIN_CATALOG);

    expect(stub.requests).toContain(`/connect/applications/${SERVICE_USER}`);
  });

  it('service/ontology-service#permission-catalog: a service user of another Organization gets 404 OntologyNotFound, the same as an unknown RID', async () => {
    const stub = stubWorkos([], [], {
      applications: { [SERVICE_USER]: { ...STUB_APPLICATION, organization_id: OTHER_ORGANIZATION } },
    });

    const baseUrl = await serveWith(stub);

    const token = await service.issuer.m2m({ org_id: OTHER_ORGANIZATION });

    const read = async (rid: string): Promise<Answer> => {
      const response = await fetch(new URL(`/api/ontology-service/v1/ontologies/${rid}/permissions`, baseUrl), {
        headers: { authorization: `Bearer ${token}` },
      });

      return { status: response.status, text: await response.text() };
    };

    expect(errorOf(await read(V3_RID))).toEqual({
      status: 404,
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      parameters: { ontologyRid: V3_RID },
    });

    expect(errorOf(await read(UNKNOWN_RID))).toEqual({
      status: 404,
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      parameters: { ontologyRid: UNKNOWN_RID },
    });

    expect(stub.requests).toContain(`/connect/applications/${SERVICE_USER}`);
  });

  it('service/ontology-service#permission-catalog: a GitHub token gets 403 Default:PermissionDenied', async () => {
    const answer = await catalog(V3_RID, await service.issuer.github({ exp: now() + 3600 }));

    expect(errorOf(answer)).toEqual({
      status: 403,
      errorCode: 'PERMISSION_DENIED',
      errorName: 'Default:PermissionDenied',
      parameters: {},
    });
  });

  it('service/ontology-service#permission-catalog: an Ontology on a version whose grants file does not parse gets {"data": []}', async () => {
    await service.db.query({
      text: `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, grants, publisher)
        SELECT product, 3, ir, metadata, schema_migrations, osdk_set, functions, $1::jsonb, publisher FROM ontology_registry.product_versions WHERE product = 'twin' AND version = 1`,
      values: [JSON.stringify({ roles: ['admin', 'member'], objectTypes: {}, actionTypes: {} })],
    });

    await installOntology(service.db, {
      rid: V2_RID,
      product: 'twin',
      apiName: 'twinv2',
      displayName: 'twin v2',
      organization: ORGANIZATION,
    });

    const answer = await catalog(V2_RID);

    expect(answer.status).toBe(200);
    expect(answer.text).toBe('{"data":[]}');
  });
});
