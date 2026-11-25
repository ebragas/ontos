import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handle, routes, type Ctx, type HandleInput, type RouteAnswer, type RouteInput } from './index.ts';
import { ONTOLOGY_RID, startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import { AUTHKIT_DOMAIN, PERSON } from '../tokens.test-utils.ts';

const base = 'http://localhost';
const rid = ONTOLOGY_RID;
const ontologyRoutes = routes.filter((route) => route.access === 'ontology');
const MEMBER_PERMISSIONS = [USE];
let installed: InstalledOntology;
let input: HandleInput;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  installed = await startInstalled();

  input = installed.input;
});

afterAll(async () => {
  await installed?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

function runOf(method: string, path: string): MockInstance<(input: RouteInput, ctx: Ctx) => RouteAnswer> {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);

  if (!route) throw new Error(`No route ${method} ${path}.`);

  return vi.spyOn(route as { run: (input: RouteInput, ctx: Ctx) => RouteAnswer }, 'run');
}

function pathOf(template: string): string {
  return template.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x');
}

async function send(method: string, path: string, token: string): Promise<Response> {
  const body = method === 'POST' ? { body: '{}' } : {};

  return handle(new Request(base + path, { method, headers: { authorization: `Bearer ${token}` }, ...body }), input);
}

describe('service/authentication#organizations: the token carries the active Organization as org_id and the role as role', () => {
  it('gives the route a person caller with the Organization of the token, and the caller holds no role of the token', async () => {
    const run = runOf('POST', '/api/v2/ontologies/{ontology}/objectSets/loadObjects');

    try {
      const response = await send(
        'POST',
        pathOf('/api/v2/ontologies/{ontology}/objectSets/loadObjects'),
        await installed.issuer.workos({ role: 'admin' }),
      );

      expect([response.status, ((await response.json()) as { errorName?: string }).errorName]).toEqual([
        400,
        'Default:InvalidArgument',
      ]);

      expect(run.mock.calls.map(([routeInput, ctx]) => ({ caller: ctx.caller, body: routeInput.body }))).toEqual([
        {
          caller: {
            user: PERSON,
            kind: 'person',
            organization: 'org_01TEST0RG00000000000000001',
            permissions: MEMBER_PERMISSIONS,
          },
          body: {},
        },
      ]);
    } finally {
      run.mockRestore();
    }
  });

  it('gives a person caller with no role when the token has none', async () => {
    const run = runOf('POST', '/api/v2/ontologies/{ontology}/objectSets/loadObjects');

    try {
      const response = await send(
        'POST',
        pathOf('/api/v2/ontologies/{ontology}/objectSets/loadObjects'),
        await installed.issuer.workos({ role: undefined }),
      );

      expect(response.status).toBe(400);

      await response.body?.cancel();

      expect(run.mock.calls.map(([routeInput, ctx]) => ({ caller: ctx.caller, body: routeInput.body }))).toEqual([
        {
          caller: {
            user: PERSON,
            kind: 'person',
            organization: 'org_01TEST0RG00000000000000001',
            permissions: MEMBER_PERMISSIONS,
          },
          body: {},
        },
      ]);
    } finally {
      run.mockRestore();
    }
  });
});

describe('service/authentication#organizations: a person token with no org_id gets 403 OntologyService:NoOrganization', () => {
  it.each(ontologyRoutes.map((route) => [route.method, route.path] as const))('%s %s', async (method, path) => {
    const response = await send(
      method,
      pathOf(path),
      await installed.issuer.workos({ org_id: undefined, role: undefined }),
    );

    expect(response.status).toBe(403);

    expect(await response.json()).toEqual({
      errorCode: 'PERMISSION_DENIED',
      errorName: 'OntologyService:NoOrganization',
      errorInstanceId: expect.any(String),
      parameters: {},
    });
  });
});

describe('service/code-layout#seams: the request context', () => {
  it('service/code-layout#seams: holds the database client, the view of the request Ontology, the caller, handleTrusted, log, checkWrite, and traceDerived', async () => {
    const run = runOf('GET', '/api/v2/ontologies/{ontology}/fullMetadata');

    try {
      const response = await send(
        'GET',
        pathOf('/api/v2/ontologies/{ontology}/fullMetadata'),
        await installed.issuer.workos(),
      );

      expect([response.status, ((await response.json()) as { ontology: { rid: string } }).ontology.rid]).toEqual([
        200,
        rid,
      ]);

      expect(
        run.mock.calls.map(([, ctx]) => ({ keys: Object.keys(ctx).sort(), rid: ctx.ontology.metadata.ontology.rid })),
      ).toEqual([
        { keys: ['caller', 'checkWrite', 'db', 'handleTrusted', 'log', 'ontology', 'reader', 'traceDerived'], rid },
      ]);
    } finally {
      run.mockRestore();
    }
  });
});

describe('service/authentication#organizations: the MCP route', () => {
  it('service/authentication#organizations: an AuthKit token with no org_id connects, so that a tool call can tell the person to join or create an Organization', async () => {
    const request = new Request(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await installed.issuer.authkit({ org_id: undefined, role: undefined })}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

    const response = await handle(request, {
      ...input,
      settings: { ...installed.settings, authkitDomain: AUTHKIT_DOMAIN, mcp: true },
    });

    expect([response.status, await response.json()]).toEqual([200, { jsonrpc: '2.0', id: 1, result: {} }]);
  });
});
