import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, settle as settleFallible } from '../errors/index.ts';
import { emptyOntology, listOntologies } from '../ontology/index.ts';
import { handle, handleTrusted, routes } from './index.ts';
import {
  noSnapshot,
  TEST_READER,
  testInput,
  testSettings,
  TEST_ONTOLOGY_RID,
  timeLeft,
} from '../service.test-utils.ts';
import { recordSpans, settle, type SpanRecorder } from '../tracing.test-utils.ts';
import { OrganizationId, UserId } from '../auth/caller.ts';

const base = 'http://localhost';
const rid = TEST_ONTOLOGY_RID;

function pathOf(template: string): string {
  return template.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x');
}

const tokenRoutes = routes.filter((route) => route.access === 'ontology' || route.access === 'publish');

describe('handle', () => {
  it.each(tokenRoutes.map((route) => [route.method, route.path] as const))(
    '%s %s with no token gives 401 MissingCredentials',
    async (method, path) => {
      const response = await handle(new Request(base + pathOf(path), { method }), testInput);

      expect(response.status).toBe(401);

      expect(await response.json()).toMatchObject({
        errorCode: 'UNAUTHORIZED',
        errorName: 'MissingCredentials',
        parameters: {},
      });
    },
  );

  it('checks the token before it reads the body', async () => {
    const request = new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      method: 'POST',
      body: 'not json',
    });

    expect((await handle(request, testInput)).status).toBe(401);
  });

  it('gives client-config with no token', async () => {
    const response = await handle(new Request(`${base}/api/ontology-service/v1/client-config`), testInput);

    expect(response.status).toBe(200);
  });

  it('gives 404 with an empty body for a path that no route has', async () => {
    const response = await handle(new Request(`${base}/api/v2/ontologies/${rid}/nope`), testInput);

    expect(response.status).toBe(404);

    expect(await response.text()).toBe('');
  });

  it('gives 404 for a route path with the wrong method', async () => {
    const request = new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`);

    expect((await handle(request, testInput)).status).toBe(404);
  });
});

describe('handleTrusted', () => {
  const trusted = {
    db: noSnapshot,
    reader: TEST_READER,
    ontology: emptyOntology(testSettings.productRid),
    caller: {
      user: UserId.parse('user-1'),
      kind: 'person' as const,
      organization: OrganizationId.parse('org_1'),
      permissions: [],
    },
    checkWrite: timeLeft,
  };

  it.each([
    ['POST', '/api/ontology-service/v1/publish'],
    ['GET', '/api/ontology-service/v1/client-config'],
    ['POST', `/api/v2/ontologies/${rid}/actions/x/apply`],
    ['POST', `/api/v2/ontologies/${rid}/actions/x/applyBatch`],
  ])('refuses %s %s, because a Function only reads', async (method, path) => {
    const init = method === 'POST' ? { method, body: '{}' } : { method };

    const response = await handleTrusted(new Request(base + path, init), trusted);

    expect(response.status).toBe(403);

    expect(await response.json()).toMatchObject({ errorName: 'Default:PermissionDenied', parameters: {} });
  });
});

describe('the request of a Function client', () => {
  const ACTION_RID = 'ri.ontology.main.ontology.33333333-3333-4333-8333-333333333333';
  const empty = emptyOntology(testSettings.productRid);
  const view = { ...empty, metadata: { ...empty.metadata, ontology: { ...empty.metadata.ontology, rid: ACTION_RID } } };

  const trusted = {
    db: noSnapshot,
    reader: TEST_READER,
    ontology: view,
    caller: {
      user: UserId.parse('user-1'),
      kind: 'person' as const,
      organization: OrganizationId.parse('org_1'),
      permissions: [],
    },
    checkWrite: timeLeft,
  };

  it('service/code-layout#http-entry service/code-layout#seams: reads in the view of the Ontology of its Action', async () => {
    const response = await handleTrusted(new Request(`${base}/api/v2/ontologies/${ACTION_RID}/fullMetadata`), trusted);

    expect(response.status).toBe(200);

    expect(((await response.json()) as { ontology: unknown }).ontology).toEqual({
      apiName: 'ontology',
      displayName: 'Ontology',
      description: '',
      rid: ACTION_RID,
    });
  });

  it('service/code-layout#http-entry service/code-layout#seams: gets 404 OntologyNotFound for each other Ontology', async () => {
    const response = await handleTrusted(new Request(`${base}/api/v2/ontologies/${rid}/fullMetadata`), trusted);

    expect([response.status, await response.json()]).toEqual([
      404,
      {
        errorCode: 'NOT_FOUND',
        errorName: 'OntologyNotFound',
        errorInstanceId: expect.any(String),
        parameters: { ontologyRid: rid },
      },
    ]);
  });

  it.each([
    ['gives the route the setting when the outer request has it', { loadDerivedProperties: true as const }, true],
    ['gives the route no setting when the outer request has none', {}, undefined],
  ])('ontology/object-link-types/derived-properties#reads: a Function client %s', async (_name, extra, expected) => {
    const route = routes.find(
      (candidate) => candidate.method === 'GET' && candidate.path === '/api/v2/ontologies/{ontology}/fullMetadata',
    );

    if (!route || route.access !== 'ontology') throw new Error('No fullMetadata route.');

    const run = vi.spyOn(route, 'run');

    try {
      await handleTrusted(new Request(`${base}/api/v2/ontologies/${ACTION_RID}/fullMetadata`), {
        ...trusted,
        ...extra,
      });

      expect(run.mock.calls.map(([, ctx]) => ctx.loadDerivedProperties)).toEqual([expected]);
    } finally {
      run.mockRestore();
    }
  });

  it.each([
    ['GET', '/api/v2/ontologies'],
    ['POST', '/api/ontology-service/v1/ontologies'],
  ])('service/code-layout#http-entry: refuses %s %s, which is not an ontology route', async (method, path) => {
    const response = await handleTrusted(
      new Request(base + path, method === 'POST' ? { method, body: '{}' } : { method }),
      trusted,
    );

    expect(response.status).toBe(403);
  });
});

describe('the route table', () => {
  it('service/code-layout#seams: the access kinds are ontology, organization, publish, mcp, users, token, and public', () => {
    expect([...new Set(routes.map((route) => route.access))].sort()).toEqual([
      'mcp',
      'ontology',
      'organization',
      'public',
      'publish',
      'token',
      'users',
    ]);
  });

  it('service/code-layout#seams: the token route is the one route of access kind token', () => {
    expect(routes.filter((route) => route.access === 'token').map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /multipass/api/oauth2/token',
    ]);
  });

  it('service/http-api#routes service/ontology-service#permission-catalog: the organization routes are List Ontologies, install, and the permission catalog', () => {
    expect(
      routes.filter((route) => route.access === 'organization').map((route) => `${route.method} ${route.path}`),
    ).toEqual([
      'GET /api/v2/ontologies',
      'POST /api/ontology-service/v1/ontologies',
      'GET /api/ontology-service/v1/ontologies/{ontologyRid}/permissions',
    ]);
  });

  it('each ontology route names a RID with {ontology}', () => {
    for (const route of routes.filter((candidate) => candidate.access === 'ontology'))
      expect(route.path).toMatch(/^\/api\/v2\/ontologies\/\{ontology\}\//);
  });

  it('service/code-layout#modules: the ontology module serves List Ontologies, and the publish module serves the publish route and the install route', async () => {
    const routeOf = (path: string) => routes.find((route) => route.path === path);

    expect(routeOf('/api/v2/ontologies')?.run).toBe(listOntologies);

    const publishRoute = routeOf('/api/ontology-service/v1/publish');
    const installRoute = routeOf('/api/ontology-service/v1/ontologies');

    if (publishRoute?.access !== 'publish' || installRoute?.access !== 'organization')
      throw new Error('Expected publish and install routes.');

    const caller = {
      user: UserId.parse('user-1'),
      kind: 'person' as const,
      organization: OrganizationId.parse('org_1'),
      permissions: ['ontology:install'],
    };

    const emptyInput = { params: {}, query: new URLSearchParams(), body: {} };

    const publishResult = await settleFallible(
      publishRoute.run(
        emptyInput,
        { caller, settings: testSettings, log: () => undefined, workos: testInput.workos },
        noSnapshot,
      ) as ReturnType<typeof import('../publish/index.ts').publish>,
    );

    const installResult = await settleFallible(
      installRoute.run(emptyInput, { db: noSnapshot, caller, log: () => undefined }) as ReturnType<
        typeof import('../publish/index.ts').install
      >,
    );

    expect(publishResult).toEqual({
      ok: false,
      error: new ApiError(400, 'Default:InvalidArgument', { part: 'product' }),
    });

    expect(installResult).toEqual({
      ok: false,
      error: new ApiError(400, 'Default:InvalidArgument', { part: 'apiName' }),
    });
  });

  it('service/code-layout#seams: the publish route is the one route of access kind publish, so no other route gets the direct connection', () => {
    expect(
      routes.filter((route) => route.access === 'publish').map((route) => `${route.method} ${route.path}`),
    ).toEqual(['POST /api/ontology-service/v1/publish']);
  });

  it('service/authentication#organizations: the Ontology service has no route that creates an Organization or adds a person to it', () => {
    expect(
      routes
        .filter((route) => /organization|membership|invitation/i.test(route.path))
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual(['GET /api/ontology-service/v1/organizations']);
  });

  it('service/code-layout#packages: no route and no access kind is for the remap or a Mirror Organization', () => {
    expect(routes.filter((route) => /remap|mirror/i.test(`${route.path} ${route.access}`))).toEqual([]);

    expect([...new Set(routes.map((route) => route.access))].filter((access) => /remap|mirror/i.test(access))).toEqual(
      [],
    );
  });

  describe('lazy imports of handler/index.ts', () => {
    let result: SpawnSyncReturns<string>;

    beforeAll(() => {
      const entry = new URL('./index.ts', import.meta.url).href;

      const probe = [
        "import { registerHooks } from 'node:module';",
        'const loaded = [];',
        'registerHooks({ load(url, ctx, next) { loaded.push(url); return next(url, ctx); } });',
        `await import(${JSON.stringify(entry)});`,
        'console.log(JSON.stringify(loaded));',
      ].join('\n');

      result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
    });

    it('importing handler/index.ts does not load the mcp or publish modules eagerly', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');

      const loaded = JSON.parse(result.stdout) as string[];

      expect(
        loaded.filter(
          (url) =>
            url.includes('/src/mcp/') || url.includes('/src/publish/') || url.includes('@modelcontextprotocol/server'),
        ),
      ).toEqual([]);
    });
  });
});

describe('the root span', () => {
  let recorder: SpanRecorder;

  beforeAll(() => {
    recorder = recordSpans();
  });

  beforeEach(() => recorder.reset());

  afterAll(() => recorder.stop());

  const CLIENT_CONFIG = `${base}/api/ontology-service/v1/client-config`;

  const tree = () =>
    recorder.spans().map((span) => ({ name: span.name, root: span.attributes['route.key'] === span.name }));

  it('service/observability#traces: the root span is named by the route key', async () => {
    const response = await handle(new Request(CLIENT_CONFIG), testInput);

    await response.text();

    await settle();

    expect(tree()).toEqual([
      { name: 'response.body', root: false },
      { name: 'GET /api/ontology-service/v1/client-config', root: true },
    ]);
  });

  it('service/observability#traces: a request that matches no route records no span', async () => {
    const response = await handle(new Request(`${base}/api/v2/nothing`), testInput);

    expect(response.status).toBe(404);

    await settle();

    expect(recorder.spans()).toEqual([]);
  });

  it('service/observability#traces: a valid traceparent header sets the trace ID and the parent span ID on the root span', async () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    await (await handle(new Request(CLIENT_CONFIG, { headers: { traceparent } }), testInput)).text();

    await settle();

    const spans = recorder.spans();
    const root = spans.find((span) => span.attributes['route.key'] === span.name);
    const body = spans.find((span) => span.name === 'response.body');

    expect(root?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(root?.parentSpanId).toBe('b7ad6b7169203331');
    expect(body?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(body?.parentSpanId).toBe(root?.spanId);
  });

  it.each([
    '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01',
    'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra',
    '00-00000000000000000000000000000000-b7ad6b7169203331-01',
    '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
    'not-a-traceparent',
  ])(
    'service/observability#traces: a malformed traceparent header (%s) starts a fresh trace ID',
    async (traceparent) => {
      await (await handle(new Request(CLIENT_CONFIG, { headers: { traceparent } }), testInput)).text();

      await settle();

      const root = recorder.spans().find((span) => span.attributes['route.key'] === span.name);

      expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(root?.traceId).not.toBe('0af7651916cd43dd8448eb211c80319c');
      expect(root?.parentSpanId).toBeUndefined();
    },
  );

  it('service/observability#traces: a traceparent header that is not sampled adopts the trace and does not stop it', async () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00';

    await (await handle(new Request(CLIENT_CONFIG, { headers: { traceparent } }), testInput)).text();

    await settle();

    const root = recorder.spans().find((span) => span.attributes['route.key'] === span.name);

    expect(root?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(root?.parentSpanId).toBe('b7ad6b7169203331');
    expect(tree()).toContainEqual({ name: 'GET /api/ontology-service/v1/client-config', root: true });
  });
});
