import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ACCOUNT, CREATE_ACCOUNT, startInstalled, type Installed } from './installed.test-utils.ts';
import { emptyOntology } from '../ontology/index.ts';
import { handle, handleTrusted, routes, type HandleInput, type TrustedInput } from '../handler/index.ts';
import { buffered } from '../routeHarness.test-utils.ts';
import {
  MEMBER,
  TEST_READER,
  testInput,
  testSettings,
  TEST_ONTOLOGY_RID,
  timeLeft,
  trustedSnapshot,
} from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { stubUsers } from '../workos.test-utils.ts';
import { promiseOf } from '../db/promise.test-utils.ts';

const base = 'http://localhost';
const rid = TEST_ONTOLOGY_RID;
const foundryRoutes = routes.filter((route) => route.access === 'ontology');
let issuer: TestIssuer;
let installed: Installed;
let input: HandleInput;
let token: string;
let actionTypeRid: string;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  issuer = await createTestIssuer(testSettings.auth);

  installed = await startInstalled(testSettings, issuer, 'jobsite:read');

  input = {
    ...testInput,
    db: installed.db,
    directDb: installed.db,
    keys: issuer.keys,
    users: stubUsers(undefined, undefined, { roles: { [ORGANIZATION]: { member: ['jobsite:read'] } } }),
  };

  token = await issuer.workos();

  const actionType = await send('GET', `/api/v2/ontologies/${rid}/actionTypes/${CREATE_ACCOUNT}`);

  actionTypeRid = ((await actionType.json()) as { rid: string }).rid;
});

afterAll(() => installed?.stop());

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

function send(
  method: string,
  path: string,
  init: { body?: string; authorization?: string | null } = {},
): Promise<Response> {
  const authorization = init.authorization === undefined ? `Bearer ${token}` : init.authorization;
  const headers: Record<string, string> = authorization === null ? {} : { authorization };
  const body = method === 'POST' ? { body: init.body ?? '{}' } : {};

  return buffered(handle(new Request(base + path, { method, headers, ...body }), input));
}

function pathOf(template: string, ontology: string): string {
  const params: Readonly<Record<string, string>> = {
    ontology,
    objectType: ACCOUNT,
    actionType: CREATE_ACCOUNT,
    action: CREATE_ACCOUNT,
    actionTypeRid,
    queryApiName: 'noSuchQuery',
  };

  return template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? 'x'));
}

describe('the Ontology is served at the Ontology RID of the deployment', () => {
  const queryRoutes = foundryRoutes.filter((route) => route.path.includes('{queryApiName}'));
  const otherRoutes = foundryRoutes.filter((route) => !route.path.includes('{queryApiName}'));

  it.each(otherRoutes.map((route) => [route.method, route.path] as const))(
    '%s %s serves the Ontology RID',
    async (method, path) => {
      const response = await send(method, pathOf(path, rid));

      expect(response.status).not.toBe(404);
    },
  );

  it.each(queryRoutes.map((route) => [route.method, route.path] as const))(
    '%s %s serves the Ontology RID',
    async (method, path) => {
      const response = await send(method, pathOf(path, rid));

      expect(await response.json()).toMatchObject({ errorName: 'QueryNotFound' });
    },
  );
});

describe('any other {ontology} value gets 404 OntologyNotFound', () => {
  it.each(foundryRoutes.map((route) => [route.method, route.path] as const))(
    '%s %s with an unknown Ontology RID gets 404',
    async (method, path) => {
      const response = await send(
        method,
        pathOf(path, 'ri.ontology.main.ontology.00000000-0000-0000-0000-00000000dead'),
      );

      expect(response.status).toBe(404);

      expect(await response.json()).toMatchObject({ errorName: 'OntologyNotFound' });
    },
  );

  it('the API name of the Ontology gets 404 (a deviation)', async () => {
    const response = await send('POST', '/api/v2/ontologies/twin/objectSets/loadObjects');

    expect(response.status).toBe(404);

    expect(await response.json()).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      errorInstanceId: expect.any(String),
      parameters: { ontologyRid: 'twin' },
    });
  });

  it('a request with no token gets the token error first', async () => {
    const response = await send('POST', '/api/v2/ontologies/twin/objectSets/loadObjects', { authorization: null });

    expect(response.status).toBe(401);

    expect(await response.json()).toMatchObject({ errorName: 'MissingCredentials' });
  });
});

describe('service/http-api#errors: an unknown Ontology gets 404 OntologyNotFound with ontologyRid', () => {
  it('service/http-api#errors: the answer of:36', async () => {
    const unknown = 'ri.ontology.main.ontology.00000000-0000-0000-0000-00000000dead';

    const response = await send('GET', `/api/v2/ontologies/${unknown}/fullMetadata`);

    expect(response.status).toBe(404);

    expect(await response.json()).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      errorInstanceId: expect.any(String),
      parameters: { ontologyRid: 'ri.ontology.main.ontology.00000000-0000-0000-0000-00000000dead' },
    });
  });
});

describe('service/http-api#requests: branch, transactionId, and scenarioRid get 400', () => {
  it.each([
    ['branch', 'branch=master'],
    ['transactionId', 'transactionId=ri.ontology.main.transaction.00000000-0000-0000-0000-000000000001'],
    ['scenarioRid', 'scenarioRid=ri.ontology.main.scenario.00000000-0000-0000-0000-000000000001'],
  ])('service/http-api#requests: a %s query parameter gets 400 Default:InvalidArgument', async (_name, query) => {
    const response = await send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects?${query}`);

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { feature: expect.any(String) },
    });
  });

  it('service/http-api#requests: an empty branch parameter gets 400 too', async () => {
    const response = await send('GET', `/api/v2/ontologies/${rid}/fullMetadata?branch=`);

    expect(response.status).toBe(400);
  });

  it('service/http-api#requests: another query parameter passes', async () => {
    const response = await send('GET', `/api/v2/ontologies/${rid}/fullMetadata?preview=true`);

    expect(response.status).toBe(200);
  });
});

describe('service/http-api#errors: a feature outside V1 gets 400 Default:InvalidArgument with feature', () => {
  it('service/http-api#errors: a route that refuses a feature sends it in the error envelope', async () => {
    const body = {
      objectSet: { type: 'base', objectType: 'com.example.twin.Engagement' },
      groupBy: [],
      aggregation: [{ type: 'approximatePercentile', field: 'amount', name: 'amount.p50', approximatePercentile: 0.5 }],
    };

    const response = await send('POST', `/api/v2/ontologies/${rid}/objectSets/aggregate`, {
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { feature: 'approximatePercentile' },
    });
  });
});

describe('service/http-api#errors: a body that is not JSON gets 400', () => {
  it('service/http-api#errors: a body that is not JSON gets 400 Default:InvalidArgument with parameters {}', async () => {
    const response = await send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects`, { body: '{"objectSet":' });

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: {},
    });
  });

  it('service/http-api#errors: a body that is not JSON, with no token, gets the token error first', async () => {
    const response = await send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      body: 'not json',
      authorization: null,
    });

    expect(response.status).toBe(401);

    expect(await response.json()).toMatchObject({ errorName: 'MissingCredentials' });
  });

  it('service/http-api#errors: a body that is not JSON, with a failed token, gets 401 Default:Unauthorized', async () => {
    const response = await send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      body: 'not json',
      authorization: 'Bearer not-a-jwt',
    });

    expect(response.status).toBe(401);

    expect(await response.json()).toMatchObject({ errorName: 'Default:Unauthorized' });
  });
});

describe('the order of the request checks', () => {
  it('an unknown Ontology with a branch parameter gets the Ontology error first', async () => {
    const response = await send('POST', '/api/v2/ontologies/twin/objectSets/loadObjects?branch=master');

    expect(response.status).toBe(404);

    expect(await response.json()).toMatchObject({ errorName: 'OntologyNotFound' });
  });

  it('a pull request check gets 403 before the Ontology check, so an unknown Ontology and a served one give the same answer', async () => {
    const check = await issuer.github({ environment: undefined, sub: 'repo:example/test-app:pull_request' });

    const unknown = await send('POST', '/api/v2/ontologies/twin/objectSets/loadObjects', {
      authorization: `Bearer ${check}`,
    });

    const served = await send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      authorization: `Bearer ${check}`,
    });

    expect([unknown.status, served.status]).toEqual([403, 403]);
  });

  it('service/http-api#requests: a branch parameter with a body that is not JSON gets the branch error first', async () => {
    const response = await send('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects?branch=master`, {
      body: 'not json',
    });

    expect(response.status).toBe(400);

    expect(await response.json()).toMatchObject({ parameters: { feature: expect.any(String) } });
  });
});

describe('ontology/functions/functions#reads: a Function client gets the same request checks as app code', () => {
  const trusted: TrustedInput = {
    db: trustedSnapshot(promiseOf(testInput.db)),
    reader: TEST_READER,
    ontology: emptyOntology(testSettings.productRid),
    caller: MEMBER,
    checkWrite: timeLeft,
  };

  function sendTrusted(path: string): Promise<Response> {
    return handleTrusted(new Request(base + path, { method: 'POST', body: '{}' }), trusted);
  }

  it('service/http-api#requests: a branch query parameter gets 400 Default:InvalidArgument', async () => {
    const response = await sendTrusted(`/api/v2/ontologies/${rid}/objectSets/loadObjects?branch=master`);

    expect(response.status).toBe(400);

    expect(await response.json()).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: expect.any(String),
      parameters: { feature: 'branch' },
    });
  });

  it('a path Ontology RID that differs from the pinned Ontology gets 404', async () => {
    const foreign = 'ri.ontology.main.ontology.00000000-0000-0000-0000-00000000dead';

    const response = await sendTrusted(`/api/v2/ontologies/${foreign}/objectSets/loadObjects`);

    expect(response.status).toBe(404);

    expect(await response.json()).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      errorInstanceId: expect.any(String),
      parameters: { ontologyRid: foreign },
    });
  });
});
