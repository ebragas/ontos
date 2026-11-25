import { expect } from 'vitest';
import { routeKeyOf, routes } from './handler/index.ts';
import { checkTrace, isRouteKey, type FinishedSpan, type RouteKey } from './spans/index.ts';
import { grantsOf, NS, ONTOLOGY_RID, stored, twinFunctions, twinIr } from './ontology/stored.test-utils.ts';
import { PERSON } from './tokens.test-utils.ts';
import { routeRecording, settle, type OpenSpan, type SpanRecorder } from './tracing.test-utils.ts';

export const CANARY = 'CANARY';

export async function routeSpans(): Promise<FinishedSpan[]> {
  const { recorder } = routeRecording;

  if (recorder === undefined) throw new Error('Only a test of the sql project records the spans of its routes.');

  await settle();

  return recorder.spans();
}

export async function checkRouteTraces(recorder: SpanRecorder): Promise<void> {
  await settle();

  const problems = [...routeTraceProblems(recorder.spans(), recorder.open()), ...recorder.strayFetches()];

  recorder.reset();

  expect(problems).toEqual([]);
}

export function routeTraceProblems(ended: readonly FinishedSpan[], open: readonly OpenSpan[] = []): string[] {
  const endedByTrace = Map.groupBy(ended, (span) => span.traceId);
  const openByTrace = Map.groupBy(open, (span) => span.traceId);

  return [...new Set([...endedByTrace.keys(), ...openByTrace.keys()])].flatMap((traceId) => {
    const trace = endedByTrace.get(traceId) ?? [];
    const stillOpen = openByTrace.get(traceId) ?? [];
    const endedIds = new Set(trace.map((span) => span.spanId));
    const openIds = new Set(stillOpen.map((span) => span.spanId));

    const root = trace.find(
      (span) => span.parentSpanId === undefined || (isRouteKey(span.name) && !endedIds.has(span.parentSpanId)),
    );

    const openRoot = stillOpen.find(
      (span) =>
        span.parentSpanId === undefined ||
        (isRouteKey(span.name) && !endedIds.has(span.parentSpanId) && !openIds.has(span.parentSpanId)),
    );

    const name = (root ?? openRoot)?.name;
    const route = name === undefined ? undefined : routes.find((candidate) => routeKeyOf(candidate) === name);

    if (name !== undefined && route === undefined) return [];

    if (openRoot !== undefined) return stillOpen.map((span) => `${openRoot.name}: ${span.name}: never ended`);

    const status = root?.attributes['http.status_code'];
    const answered = typeof status === 'number' && status >= 200 && status < 300;

    const problems = [
      ...checkTrace(trace, answered && route !== undefined ? { rootRequires: route.spans } : {}),
      ...stillOpen.map((span) => `${span.name}: never ended`),
    ];

    return problems.map((problem) => `${root?.name ?? 'a trace with no root'}: ${problem}`);
  });
}

export async function buffered(answer: Promise<Response>): Promise<Response> {
  const response = await answer;

  return new Response(response.body === null ? null : await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export interface FixtureInput {
  readonly person: string;
  readonly publish: string;
  readonly mcp: string;
  readonly actionTypeRid: string;
}

export interface RouteFixture {
  readonly status: number;
  readonly request: (input: FixtureInput) => Request;
}

export type RouteFixtures = Readonly<Record<RouteKey, RouteFixture>>;

const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;

const CANARY_ACCOUNTS = {
  type: 'filter',
  objectSet: { type: 'base', objectType: ACCOUNT },
  where: { type: 'eq', field: 'name', value: CANARY },
};

const CANARY_PARAMETERS = { accountId: `${CANARY}-1`, name: CANARY, phase: CANARY };

function publishCheck(): object {
  const ir = twinIr('0.6.3');

  return {
    ir,
    functions: twinFunctions('0.6.3'),
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants: grantsOf(ir),
    validateOnly: true,
  };
}

function fixtureRequest(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Request {
  return new Request(`http://localhost${path}?canary=${CANARY}`, {
    method,
    headers: {
      'x-canary': CANARY,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ok = (request: RouteFixture['request']): RouteFixture => ({ status: 200, request });

export const ROUTE_FIXTURES: RouteFixtures = {
  'GET /api/v2/ontologies': ok(({ person }) => fixtureRequest('GET', '/api/v2/ontologies', person)),
  'GET /api/v2/ontologies/{ontology}/fullMetadata': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/fullMetadata`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/objectTypes/${ACCOUNT}/fullMetadata`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/actionTypes/{actionType}': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/actionTypes/${CREATE_ACCOUNT}`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/objectTypes': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/objectTypes`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/objectTypes/${ACCOUNT}`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/actionTypes': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/actionTypes`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}': ok(({ person, actionTypeRid }) =>
    fixtureRequest('GET', `${ONTOLOGY}/actionTypes/byRid/${actionTypeRid}`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/queryTypes': ok(({ person }) =>
    fixtureRequest('GET', `${ONTOLOGY}/queryTypes`, person),
  ),
  'GET /api/v2/ontologies/{ontology}/queryTypes/{queryApiName}': {
    status: 404,
    request: ({ person }) => fixtureRequest('GET', `${ONTOLOGY}/queryTypes/noSuchQuery`, person),
  },
  'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute': {
    status: 404,
    request: ({ person }) =>
      fixtureRequest('POST', `${ONTOLOGY}/queries/noSuchQuery/execute`, person, { parameters: CANARY_PARAMETERS }),
  },
  'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects': ok(({ person }) =>
    fixtureRequest('POST', `${ONTOLOGY}/objectSets/loadObjects`, person, { objectSet: CANARY_ACCOUNTS }),
  ),
  'POST /api/v2/ontologies/{ontology}/objectSets/aggregate': ok(({ person }) =>
    fixtureRequest('POST', `${ONTOLOGY}/objectSets/aggregate`, person, {
      objectSet: CANARY_ACCOUNTS,
      aggregation: [{ type: 'count' }],
      groupBy: [],
    }),
  ),
  'POST /api/v2/ontologies/{ontology}/actions/{action}/apply': ok(({ person }) =>
    fixtureRequest('POST', `${ONTOLOGY}/actions/${CREATE_ACCOUNT}/apply`, person, { parameters: CANARY_PARAMETERS }),
  ),
  'POST /api/v2/ontologies/{ontology}/actions/{action}/applyBatch': {
    status: 400,
    request: ({ person }) =>
      fixtureRequest('POST', `${ONTOLOGY}/actions/${CREATE_ACCOUNT}/applyBatch`, person, {
        requests: [{ parameters: CANARY_PARAMETERS }],
      }),
  },
  'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory': ok(({ person }) =>
    fixtureRequest('POST', `${ONTOLOGY}/objectTypes/${ACCOUNT}/editsHistory`, person, {
      objectPrimaryKey: { accountId: CANARY_PARAMETERS.accountId },
    }),
  ),
  'GET /api/v2/admin/users/getCurrent': ok(({ person }) =>
    fixtureRequest('GET', '/api/v2/admin/users/getCurrent', person),
  ),
  'GET /api/v2/admin/users/{userId}': ok(({ person }) =>
    fixtureRequest('GET', `/api/v2/admin/users/${PERSON}`, person),
  ),
  'POST /api/v2/admin/users/getBatch': ok(({ person }) =>
    fixtureRequest('POST', '/api/v2/admin/users/getBatch', person, [{ userId: PERSON }, { userId: CANARY }]),
  ),
  'POST /api/ontology-service/v1/publish': ok(({ publish }) =>
    fixtureRequest('POST', '/api/ontology-service/v1/publish', publish, publishCheck()),
  ),
  'POST /api/ontology-service/v1/ontologies': ok(({ person }) =>
    fixtureRequest('POST', '/api/ontology-service/v1/ontologies', person, {
      product: 'twin',
      apiName: 'canary-copy',
      displayName: `The ${CANARY} Ontology`,
    }),
  ),
  'GET /api/ontology-service/v1/ontologies/{ontologyRid}/permissions': ok(({ person }) =>
    fixtureRequest('GET', `/api/ontology-service/v1/ontologies/${ONTOLOGY_RID}/permissions`, person),
  ),
  'GET /api/ontology-service/v1/organizations': ok(({ person }) =>
    fixtureRequest('GET', '/api/ontology-service/v1/organizations', person),
  ),
  'GET /api/ontology-service/v1/client-config': ok(() =>
    fixtureRequest('GET', '/api/ontology-service/v1/client-config'),
  ),
  'POST /api/mcp': ok(({ mcp }) =>
    fixtureRequest('POST', '/api/mcp', mcp, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'load_objects', arguments: { ontology: 'twin', objectSet: CANARY_ACCOUNTS } },
    }),
  ),
  'GET /api/mcp': { status: 405, request: ({ mcp }) => fixtureRequest('GET', '/api/mcp', mcp) },
  'GET /api/oauth-protected-resource': ok(() => fixtureRequest('GET', '/api/oauth-protected-resource')),
  'POST /multipass/api/oauth2/token': ok(
    () =>
      new Request(`http://localhost/multipass/api/oauth2/token?canary=${CANARY}`, {
        method: 'POST',
        headers: {
          'x-canary': CANARY,
          authorization: `Basic ${btoa(`${CANARY}:${CANARY}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: `api:read-data ${CANARY}`,
          client_secret: CANARY,
        }),
      }),
  ),
};
