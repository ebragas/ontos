import { readFileSync } from 'node:fs';
import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { routeKeyOf, routes, type Route } from './index.ts';
import type { FinishedSpan } from '../spans/index.ts';
import { ROUTE_FIXTURES, routeTraceProblems, type RouteFixtures } from '../routeHarness.test-utils.ts';

function ended(
  name: string,
  spanId: string,
  parentSpanId: string | undefined,
  [start, end]: readonly [number, number],
  attributes: FinishedSpan['attributes'] = {},
): FinishedSpan {
  return {
    name,
    traceId: 't1',
    spanId,
    parentSpanId,
    start: BigInt(start),
    end: BigInt(end),
    status: { code: SpanStatusCode.UNSET },
    attributes,
    events: 0,
  };
}

const CONFIG = 'GET /api/ontology-service/v1/client-config';

const root = (status: number) =>
  ended(CONFIG, 'r', undefined, [0, 10], { 'route.key': CONFIG, 'http.status_code': status });

const body = ended('response.body', 'b', 'r', [1, 9]);

describe('the trace check of the route tests', () => {
  it('service/observability#traces: passes a trace with 1 root and its children inside it', () => {
    expect(routeTraceProblems([body, root(200)])).toEqual([]);
  });

  it('service/observability#traces: fails a span with a lost parent', () => {
    expect(routeTraceProblems([{ ...body, parentSpanId: 'gone' }, root(200)])).toContain(
      `${CONFIG}: response.body: its parent is not in the trace`,
    );
  });

  it('service/observability#traces: fails a child that ends after its parent', () => {
    expect(routeTraceProblems([{ ...body, end: 11n }, root(200)])).toEqual([
      `${CONFIG}: response.body: ends after its parent`,
    ]);
  });

  it('service/observability#traces: a shared WorkOS read that starts at 3 seconds and ends at 8 seconds may end after the root that ended at 5 seconds', () => {
    const second = 1_000_000_000;
    const lateRoot = { ...root(200), end: BigInt(5 * second) };

    for (const kind of ['membership', 'role', 'application', 'members page', 'applications page', 'memberships page']) {
      const read = ended('workos read', 'w', 'r', [3 * second, 8 * second], {
        'workos.read': kind,
        'http.status_code': 200,
      });

      expect([kind, routeTraceProblems([{ ...body, end: BigInt(4 * second) }, read, lateRoot])]).toEqual([kind, []]);
    }
  });

  it('service/observability#traces: each other span that ends after its parent still fails: a workos read of another kind, a workos write, a workos token, and a non-WorkOS span', () => {
    const late = (name: string, attributes: FinishedSpan['attributes']) =>
      routeTraceProblems([
        ...(name === 'response.body' ? [] : [body]),
        ended(name, 'w', 'r', [3, 11], attributes),
        root(200),
      ]);

    expect([
      late('workos read', { 'workos.read': 'user', 'http.status_code': 200 }),
      late('workos read', { 'workos.read': 'organizations page', 'http.status_code': 200 }),
      late('workos write', { 'workos.write': 'createRole', 'http.status_code': 201 }),
      late('workos token', { 'http.status_code': 200 }),
      late('response.body', {}),
    ]).toEqual([
      [`${CONFIG}: workos read: ends after its parent`],
      [`${CONFIG}: workos read: ends after its parent`],
      [`${CONFIG}: workos write: ends after its parent`],
      [`${CONFIG}: workos token: ends after its parent`],
      [`${CONFIG}: response.body: ends after its parent`],
    ]);
  });

  it('service/observability#traces: fails a CANARY value', () => {
    expect(
      routeTraceProblems([body, { ...root(200), attributes: { ...root(200).attributes, 'route.key': 'CANARY' } }]),
    ).toEqual([`${CONFIG}: ${CONFIG}: holds a CANARY value`]);
  });

  it('service/observability#traces: fails a trace whose root did not end', () => {
    expect(routeTraceProblems([body])).toEqual([
      'a trace with no root: no root span',
      'a trace with no root: response.body: its parent is not in the trace',
    ]);
  });

  it('service/observability#traces: fails a 2xx answer that lacks a span of its route row, and passes an error answer that lacks it', () => {
    expect(routeTraceProblems([root(200)])).toEqual([`${CONFIG}: ${CONFIG}: no child response.body`]);
    expect(routeTraceProblems([root(404)])).toEqual([]);
  });

  it('service/observability#traces: fails a span that never ended in a trace whose root ended', () => {
    const open = [{ name: 'sql', traceId: 't1', spanId: 's', parentSpanId: 'r' }];

    expect(routeTraceProblems([body, root(200)], open)).toEqual([`${CONFIG}: sql: never ended`]);
  });

  it('service/observability#traces: fails a route trace whose root never ended, as for a test that reads no body', () => {
    const open = [
      { name: CONFIG, traceId: 't1', spanId: 'r', parentSpanId: undefined },
      { name: 'response.body', traceId: 't1', spanId: 'b', parentSpanId: 'r' },
    ];

    expect(routeTraceProblems([], open)).toEqual([
      `${CONFIG}: ${CONFIG}: never ended`,
      `${CONFIG}: response.body: never ended`,
    ]);
  });

  it('skips an open trace whose root is not a route', () => {
    expect(routeTraceProblems([], [{ name: 'sql', traceId: 't2', spanId: 's', parentSpanId: undefined }])).toEqual([]);
  });

  it('skips a trace whose root is not a route, such as a statement of a test', () => {
    expect(routeTraceProblems([ended('sql', 's', undefined, [0, 1])])).toEqual([]);
  });

  it('service/observability#traces: each route row names the child spans that each 2xx answer of its route must have', () => {
    const checked = ['token check', 'response.body'];
    const view = [...checked, 'ontology view'];

    expect(Object.fromEntries(routes.map((route) => [routeKeyOf(route), route.spans]))).toEqual({
      'GET /api/v2/ontologies': checked,
      'GET /api/v2/ontologies/{ontology}/fullMetadata': view,
      'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata': view,
      'GET /api/v2/ontologies/{ontology}/actionTypes/{actionType}': view,
      'GET /api/v2/ontologies/{ontology}/objectTypes': view,
      'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}': view,
      'GET /api/v2/ontologies/{ontology}/actionTypes': view,
      'GET /api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}': view,
      'GET /api/v2/ontologies/{ontology}/queryTypes': view,
      'GET /api/v2/ontologies/{ontology}/queryTypes/{queryApiName}': view,
      'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects': view,
      'POST /api/v2/ontologies/{ontology}/objectSets/aggregate': view,
      'POST /api/v2/ontologies/{ontology}/actions/{action}/apply': [...view, 'apply attempt'],
      'POST /api/v2/ontologies/{ontology}/actions/{action}/applyBatch': view,
      'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory': view,
      'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute': [...view, 'function run'],
      'GET /api/v2/admin/users/getCurrent': checked,
      'GET /api/v2/admin/users/{userId}': checked,
      'POST /api/v2/admin/users/getBatch': checked,
      'POST /api/ontology-service/v1/publish': [...checked, 'publish read', 'publish plan'],
      'POST /api/ontology-service/v1/ontologies': checked,
      'GET /api/ontology-service/v1/ontologies/{ontologyRid}/permissions': checked,
      'GET /api/ontology-service/v1/organizations': checked,
      'GET /api/ontology-service/v1/client-config': ['response.body'],
      'POST /api/mcp': ['token check'],
      'GET /api/mcp': ['token check'],
      'GET /api/oauth-protected-resource': ['response.body'],
      'POST /multipass/api/oauth2/token': ['workos token', 'response.body'],
    });
  });

  it('service/observability#traces: tsc refuses a route row with no spans field', () => {
    const [first] = routes;

    if (first === undefined) throw new Error('The route table is empty.');

    const { spans, ...row } = first;
    // @ts-expect-error A route row needs its `spans` field.
    const bare: Route = row;

    expect([bare.path, spans]).toEqual(['/api/v2/ontologies', ['token check', 'response.body']]);
  });

  it('service/observability#traces: tsc refuses ROUTE_FIXTURES with no fixture for a route key', () => {
    const { 'GET /api/mcp': dropped, ...fewer } = ROUTE_FIXTURES;
    // @ts-expect-error Each route key needs a fixture.
    const fixtures: RouteFixtures = fewer;

    expect([dropped.status, Object.keys(fixtures)]).toEqual([
      405,
      Object.keys(ROUTE_FIXTURES).filter((key) => key !== 'GET /api/mcp'),
    ]);
  });
});

describe('the OpenTelemetry packages of the service', () => {
  it('service/observability#traces: package.json has no automatic instrumentation package', () => {
    const { dependencies = {}, devDependencies = {} } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;

    const names = [...Object.keys(dependencies), ...Object.keys(devDependencies)];

    expect(names).toContain('@opentelemetry/api');
    expect(names.filter((name) => /^@opentelemetry\/(?:instrumentation|auto-instrumentations)/.test(name))).toEqual([]);
  });
});
