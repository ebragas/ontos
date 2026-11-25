import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Handle } from './index.ts';
import type { FinishedSpan } from '../spans/index.ts';
import {
  ONTOLOGY_RID,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import { testInput, testSettings } from '../service.test-utils.ts';
import { createTestIssuer } from '../tokens.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

let service: ActionsService;

beforeAll(async () => {
  await import('./index.ts');

  service = await startActions(twinIr('0.6.3'), twinFunctions('0.6.3'));
});

afterAll(async () => service.stop());

const OBJECT_TYPES = `/api/v2/ontologies/${ONTOLOGY_RID}/objectTypes`;

const childrenOf = (spans: readonly FinishedSpan[], parent: FinishedSpan | undefined): FinishedSpan[] =>
  spans.filter((span) => parent !== undefined && span.parentSpanId === parent.spanId);

const named = (spans: readonly FinishedSpan[], name: string): FinishedSpan[] =>
  spans.filter((span) => span.name === name);

describe('the ontology view span', () => {
  it('service/observability#traces: the first read of a version gives ontology.cache.hit false and 1 ontology compile child, and the second gives true and none', async () => {
    for (let read = 0; read < 2; read += 1) expect((await service.call('GET', OBJECT_TYPES)).status).toBe(200);

    const spans = await routeSpans();

    const roots = spans.filter((span) => span.parentSpanId === undefined).sort((a, b) => Number(a.start - b.start));

    const reads = roots.map((root) => {
      const [view] = named(childrenOf(spans, root), 'ontology view');

      return {
        attributes: view?.attributes,
        compiles: named(childrenOf(spans, view), 'ontology compile').map((span) => span.attributes),
      };
    });

    expect(reads).toEqual([
      {
        attributes: { 'ontology.version': 1, 'ontology.cache.hit': false, 'sentry.op': 'cache.get' },
        compiles: [{ 'ontology.version': 1, 'sentry.op': 'function' }],
      },
      { attributes: { 'ontology.version': 1, 'ontology.cache.hit': true, 'sentry.op': 'cache.get' }, compiles: [] },
    ]);

    expect(named(spans, 'ontology compile')).toHaveLength(1);
  });
});

describe('the cold start of a new instance', () => {
  it('service/observability#traces: the request that runs it holds its SQL statements and the compile of each installed version under its cold start span', async () => {
    vi.resetModules();

    const { handle } = (await import('./index.ts')) as { handle: Handle };

    const issuer = await createTestIssuer(testSettings.auth);

    const response = await handle(
      new Request('http://localhost/api/v2/ontologies', {
        headers: { authorization: `Bearer ${await issuer.workos()}` },
      }),
      {
        ...testInput,
        db: fallibleOf(service.db),
        directDb: fallibleOf(service.db),
        keys: issuer.keys,
      },
    );

    expect(response.status).toBe(200);

    await response.text();

    const spans = await routeSpans();

    const [root] = spans.filter((span) => span.parentSpanId === undefined);
    const [coldStart] = named(childrenOf(spans, root), 'cold start');
    const [compile] = named(childrenOf(spans, coldStart), 'ontology compile');

    expect({
      role: coldStart?.attributes['cold_start.role'],
      sql: named(childrenOf(spans, coldStart), 'sql').length > 0,
      compile: compile?.attributes,
      compileSql: named(childrenOf(spans, compile), 'sql').length,
    }).toEqual({ role: 'ran', sql: true, compile: { 'ontology.version': 1, 'sentry.op': 'function' }, compileSql: 1 });
  });
});
