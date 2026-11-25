import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handle, routes, type Ctx, type HandleInput, type RouteAnswer, type RouteInput } from './index.ts';
import { ONTOLOGY_RID, publishBody, startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { testSettings } from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, SERVICE_USER, type TestIssuer } from '../tokens.test-utils.ts';
import { STUB_APPLICATION, stubUsers } from '../workos.test-utils.ts';

type Kind = 'person' | 'publish' | 'check';

const base = 'http://localhost';
const rid = ONTOLOGY_RID;
const settings = { ...testSettings, productRid: ONTOLOGY_RID };
const publishPath = '/api/ontology-service/v1/publish';
const foundryRoutes = routes.filter((route) => route.access === 'ontology');
let installed: InstalledOntology;
let issuer: TestIssuer;
let input: HandleInput;
let tokens: Record<Kind, string>;
let consoleLog: MockInstance<typeof console.log>;
let runs: MockInstance<(input: RouteInput, ctx: Ctx) => RouteAnswer>[];

beforeAll(async () => {
  installed = await startInstalled();

  issuer = await createTestIssuer(settings.auth);

  input = {
    ...installed.input,
    settings,
    keys: issuer.keys,
    users: roleUsers({ member: [USE, 'ontology:install'] }),
  };

  tokens = {
    person: await issuer.workos(),
    publish: await issuer.github(),
    check: await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' }),
  };
});

afterAll(async () => {
  await installed?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');

  runs = routes.map((route) => vi.spyOn(route as { run: (input: RouteInput, ctx: Ctx) => RouteAnswer }, 'run'));
});

afterEach(() => {
  consoleLog.mockRestore();

  for (const run of runs) run.mockRestore();
});

function callers(): { readonly kind: string }[] {
  return runs.flatMap((run) => run.mock.calls.map(([, ctx]) => ctx.caller));
}

function ranAs(): string[] {
  return callers().map((caller) => caller.kind);
}

function noValidateOnly(): object {
  const { validateOnly, ...body } = publishBody(false) as { readonly validateOnly: boolean };

  void validateOnly;

  return body;
}

function publish(kind: Kind, body: unknown, path = publishPath): Promise<Response> {
  return handle(
    new Request(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens[kind]}` },
      body: JSON.stringify(body),
    }),
    input,
  );
}

function foundry(kind: Kind, method: string, template: string): Promise<Response> {
  const path = template.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x');
  const body = method === 'POST' ? { body: '{}' } : {};

  return handle(
    new Request(base + path, { method, headers: { authorization: `Bearer ${tokens[kind]}` }, ...body }),
    input,
  );
}

async function expectAllowed(response: Response, kind: Kind | 'service', status = 200): Promise<void> {
  await response.body?.cancel();

  expect({ ran: ranAs(), status: response.status }).toEqual({ ran: [kind], status });
}

async function expectPermissionDenied(response: Response): Promise<void> {
  expect(response.status).toBe(403);

  expect(await response.json()).toEqual({
    errorCode: 'PERMISSION_DENIED',
    errorName: 'Default:PermissionDenied',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
}

const FOUNDRY_STATUS: Readonly<Record<string, number>> = {
  'GET /api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}': 404,
  'GET /api/v2/ontologies/{ontology}/actionTypes/{actionType}': 404,
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}': 404,
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata': 404,
  'POST /api/v2/ontologies/{ontology}/actions/{action}/apply': 404,
  'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory': 404,
  'GET /api/v2/ontologies/{ontology}/queryTypes/{queryApiName}': 404,
  'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute': 404,
  'POST /api/v2/ontologies/{ontology}/actions/{action}/applyBatch': 400,
  'POST /api/v2/ontologies/{ontology}/objectSets/aggregate': 400,
  'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects': 400,
};

const foundryStatus = (method: string, path: string): number => FOUNDRY_STATUS[`${method} ${path}`] ?? 200;

const kinds: readonly Kind[] = ['person', 'publish', 'check'];
const githubKinds = ['publish', 'check'] as const;

const refusedRoutes = routes.filter(
  (route) => route.access === 'ontology' || route.access === 'organization' || route.access === 'users',
);

const refusedCases = githubKinds.flatMap((kind) =>
  refusedRoutes.map((route) => [kind, route.method, route.path] as const),
);

describe('service/publish#route: a person can only validate, and only the publish workflow can apply', () => {
  it.each(kinds)('service/publish#route: a %s caller can publish with validateOnly', async (kind) => {
    await expectAllowed(await publish(kind, publishBody(true)), kind);
  });

  it('service/publish#route: the publish workflow can apply a publish', async () => {
    await expectAllowed(await publish('publish', publishBody(false)), 'publish');
  });

  it.each(['person', 'check'] as const)(
    'service/publish#route: a %s caller that applies a publish gets 403',
    async (kind) => {
      await expectPermissionDenied(await publish(kind, publishBody(false)));
    },
  );

  it.each(['person', 'check'] as const)(
    'service/publish#route: a %s caller with no validateOnly applies, so gets 403',
    async (kind) => {
      await expectPermissionDenied(await publish(kind, noValidateOnly()));
    },
  );
});

describe('service/authentication#ci-workflows: a pull request check only on publish with validateOnly', () => {
  it('service/authentication#ci-workflows: a check can publish with validateOnly', async () => {
    await expectAllowed(await publish('check', publishBody(true)), 'check');
  });

  it('service/authentication#ci-workflows: a check that applies a publish gets 403', async () => {
    await expectPermissionDenied(await publish('check', publishBody(false)));
  });

  it('service/authentication#ci-workflows: a check, a token with no environment, on loadObjects gets 403', async () => {
    const token = await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' });

    const response = await handle(
      new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      }),
      input,
    );

    await expectPermissionDenied(response);
  });

  it.each(foundryRoutes.map((route) => [route.method, route.path] as const))(
    'service/authentication#ci-workflows: a check on %s %s gets 403',
    async (method, path) => {
      await expectPermissionDenied(await foundry('check', method, path));
    },
  );
});

describe('service/publish#default-roles-in-workos: a service user can send a validateOnly publish', () => {
  const asService = async (body: unknown): Promise<Response> =>
    handle(
      new Request(base + publishPath, {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.m2m()}` },
        body: JSON.stringify(body),
      }),
      {
        ...input,
        users: stubUsers(undefined, undefined, {
          applications: { [SERVICE_USER]: { ...STUB_APPLICATION, scopes: ['ontology:install'] } },
        }),
      },
    );

  it('service/publish#default-roles-in-workos: a validateOnly publish of a service user token reaches the publish route, as a person does', async () => {
    const service = await asService(publishBody(true));

    const person = await publish('person', publishBody(true));

    expect([service.status, person.status]).toEqual([200, 200]);

    await Promise.all([service.body?.cancel(), person.body?.cancel()]);

    expect(callers()).toEqual([
      { user: SERVICE_USER, kind: 'service', organization: ORGANIZATION, permissions: ['ontology:install'] },
      expect.objectContaining({ kind: 'person' }),
    ]);
  });

  it('service/publish#default-roles-in-workos: a service user that applies a publish gets 403 Default:PermissionDenied', async () => {
    await expectPermissionDenied(await asService(publishBody(false)));

    await expectPermissionDenied(await asService(noValidateOnly()));
  });
});

describe('a service user of the owner Organization reaches each OSDK route', () => {
  it.each(foundryRoutes.map((route) => [route.method, route.path] as const))(
    'a service user reaches %s %s',
    async (method, template) => {
      const path = template.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x');
      const body = method === 'POST' ? { body: '{}' } : {};

      const response = await handle(
        new Request(base + path, { method, headers: { authorization: `Bearer ${await issuer.m2m()}` }, ...body }),
        { ...input, users: stubUsers() },
      );

      await expectAllowed(response, 'service', foundryStatus(method, template));
    },
  );
});

describe('a person of the owner Organization can view and apply', () => {
  it.each(foundryRoutes.map((route) => [route.method, route.path] as const))(
    'a person can call %s %s',
    async (method, path) => {
      await expectAllowed(await foundry('person', method, path), 'person', foundryStatus(method, path));
    },
  );
});

describe('a GitHub token on any route other than publish', () => {
  it('service/ontology-service#permission-catalog: the test covers the 22 routes that read data, install, list, read the permission catalog, or read a user', () => {
    expect(refusedRoutes).toHaveLength(22);
  });

  it.each(refusedCases)('a %s token on %s %s gets 403 Default:PermissionDenied', async (kind, method, path) => {
    await expectPermissionDenied(await foundry(kind, method, path));
  });

  it.each(refusedCases)(
    'a %s token on %s %s gets 403 before the check of the query and the body',
    async (kind, method, template) => {
      const url = `${base}${template.replace('{ontology}', rid).replace(/\{\w+\}/g, 'x')}?branch=master`;
      const body = method === 'POST' ? { body: 'not json' } : {};

      await expectPermissionDenied(
        await handle(
          new Request(url, { method, headers: { authorization: `Bearer ${tokens[kind]}` }, ...body }),
          input,
        ),
      );
    },
  );

  it('service/authentication#ci-workflows: a token of the trusted pair applies a publish', async () => {
    await expectAllowed(await publish('publish', publishBody(false)), 'publish');
  });

  it('a pull request check publishes with validateOnly', async () => {
    await expectAllowed(await publish('check', publishBody(true)), 'check');
  });
});

describe('service/authentication#ci-workflows: a GitHub token only publishes', () => {
  it('service/authentication#ci-workflows: the publish route is the one route of a GitHub token', () => {
    expect(
      routes.filter((route) => route.access === 'publish').map((route) => `${route.method} ${route.path}`),
    ).toEqual(['POST /api/ontology-service/v1/publish']);
  });

  it('service/authentication#ci-workflows: a token of the trusted pair applies a publish', async () => {
    await expectAllowed(await publish('publish', publishBody(false)), 'publish');
  });

  it.each(refusedCases)(
    'service/authentication#ci-workflows: a %s token on %s %s gets 403 Default:PermissionDenied',
    async (kind, method, path) => {
      await expectPermissionDenied(await foundry(kind, method, path));
    },
  );

  it.each(['publish', 'check', 'person'] as const)(
    'service/authentication#ci-workflows: a %s caller on the upgrade path gets 404 with no body',
    async (kind) => {
      const response = await publish(kind, { product: 'twin', after: 0 }, '/api/ontology-service/v1/upgrade');

      expect([response.status, await response.text()]).toEqual([404, '']);
    },
  );
});

describe('a refused caller gets 403 Default:PermissionDenied', () => {
  it('a check on loadObjects gets 403 Default:PermissionDenied', async () => {
    await expectPermissionDenied(
      await foundry('check', 'POST', '/api/v2/ontologies/{ontology}/objectSets/loadObjects'),
    );
  });

  it('a person that applies a publish gets 403 Default:PermissionDenied', async () => {
    await expectPermissionDenied(await publish('person', publishBody(false)));
  });

  it('a token that fails a check still gets 401, not 403', async () => {
    const expired = await issuer.github({ environment: undefined, exp: Math.floor(Date.now() / 1000) - 300 });

    const response = await handle(
      new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${expired}` },
        body: '{}',
      }),
      input,
    );

    expect(response.status).toBe(401);

    expect(await response.json()).toMatchObject({ errorName: 'Default:Unauthorized' });
  });
});
