import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertObjects, startActions, type ActionsService, type SendOptions } from '../actions/actions.test-utils.ts';
import { groupGrants } from '../policiesPeople.test-utils.ts';
import { CANARY, routeSpans, routeTraceProblems } from '../routeHarness.test-utils.ts';
import type { FinishedSpan } from '../spans/index.ts';
import {
  ACCOUNT,
  CATEGORY,
  derivedIr,
  INVOICE,
  ENGAGEMENT,
  ONTOLOGY,
  PEOPLE,
  ROLE_ASSIGNMENT,
  ROLES,
  TRANSACTION,
} from './derived.test-utils.ts';

const TRACES = 'service/observability#traces';

const IR = derivedIr();
const GRANTS = groupGrants(IR, ROLES);
const grants = { ...GRANTS, objectTypes: { ...GRANTS.objectTypes, [CATEGORY]: 'admin', [ROLE_ASSIGNMENT]: 'admin' } };

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(IR, undefined, grants);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await insertObjects(service.db, ACCOUNT, [
    { accountId: 'acc-1', name: 'Acme', entity: 'E1' },
    { accountId: 'acc-2', name: 'Globex', entity: 'E2' },
    { accountId: `${CANARY}-3`, name: CANARY, entity: 'E3' },
  ]);

  await insertObjects(service.db, TRANSACTION, [
    {
      transactionId: 'tx-1',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      amount: '100.00',
      owner: 'user_two',
      amountViewer: 'user_two',
    },
    {
      transactionId: 'tx-2',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      amount: '20.50',
      owner: 'user_two',
      amountViewer: 'user_two',
    },
    {
      transactionId: `${CANARY}-tx`,
      accountId: `${CANARY}-3`,
      categoryId: 'cat-1',
      amount: '7.00',
      owner: 'user_two',
      amountViewer: 'user_two',
    },
  ]);

  await insertObjects(service.db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'Build', owner: 'user_two' },
  ]);

  await insertObjects(service.db, INVOICE, [{ invoiceId: 'inv-1', engagementId: 'eng-1', total: '10.00' }]);
});

const base = (objectType: string) => ({ type: 'base', objectType });
const around = (link: string) => ({ type: 'searchAround', objectSet: { type: 'methodInput' }, link });
const selection = (link: string, operation: object) => ({ type: 'selection', objectSet: around(link), operation });

const withProperties = (objectSet: object, derivedProperties: object) => ({
  type: 'withProperties',
  objectSet,
  derivedProperties,
});

async function post(
  route: 'loadObjects' | 'aggregate',
  body: object,
  settings?: SendOptions['settings'],
): Promise<Record<string, unknown>> {
  const answer = await service.call('POST', `${ONTOLOGY}/objectSets/${route}`, body, {
    ...PEOPLE.one,
    ...(settings ? { settings } : {}),
  });

  expect(answer.status, answer.text).toBe(200);

  return JSON.parse(answer.text) as Record<string, unknown>;
}

async function trace(): Promise<{ root: FinishedSpan['attributes']; derived: FinishedSpan['attributes'][] }> {
  const spans = await routeSpans();

  const roots = spans.filter((span) => span.parentSpanId === undefined && span.name.startsWith('POST '));

  expect(roots).toHaveLength(1);

  const derived = spans
    .filter((span) => span.name === 'derived property' && span.traceId === roots[0]?.traceId)
    .map((span) => span.attributes);

  return {
    root: roots[0]?.attributes ?? {},
    derived: derived.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

const counts = (root: FinishedSpan['attributes']) => ({
  count: root['derived.count'],
  objects: root['derived.objects'],
  sqlMs: typeof root['derived.sql_ms'],
});

describe(`${TRACES}: a read records 1 derived property span for each derived value that it computes`, () => {
  it(`${TRACES}: a load that selects balance and filters by a request derived value records 1 span for each, and the 3 counts on the root`, async () => {
    const set = {
      type: 'filter',
      objectSet: withProperties(base(ACCOUNT), { txCount: selection('transactions', { type: 'count' }) }),
      where: { type: 'gt', field: 'txCount', value: 1 },
    };

    const page = await post('loadObjects', { objectSet: set, select: ['name', 'balance'] });

    expect(page['data']).toHaveLength(1);

    const { root, derived } = await trace();

    expect(derived).toEqual([
      {
        'object_type.api_name': ACCOUNT,
        'derived.form': 'objectType',
        'derived.api_name': 'balance',
        'derived.reason': 'select',
        'derived.hops': 1,
        'derived.operation': 'sum',
        'sentry.op': 'function',
      },
      {
        'object_type.api_name': ACCOUNT,
        'derived.form': 'request',
        'derived.position': 0,
        'derived.reason': 'query',
        'derived.hops': 1,
        'derived.operation': 'count',
        'sentry.op': 'function',
      },
    ]);

    expect(counts(root)).toEqual({ count: 2, objects: 1, sqlMs: 'number' });
  });

  it(`${TRACES}: the request flag gives the reason requestFlag, and a 2-hop get gives its hops`, async () => {
    await post('loadObjects', { objectSet: base(INVOICE), select: [], loadOntologyDefinedDerivedProperties: true });

    const { root, derived } = await trace();

    expect(derived).toEqual([
      {
        'object_type.api_name': INVOICE,
        'derived.form': 'objectType',
        'derived.api_name': 'invoiceAccount',
        'derived.reason': 'requestFlag',
        'derived.hops': 2,
        'derived.operation': 'get',
        'sentry.op': 'function',
      },
    ]);

    expect(counts(root)).toEqual({ count: 1, objects: 1, sqlMs: 'number' });
  });

  it(`${TRACES}: the deployment setting, with no request flag, gives the reason setting`, async () => {
    await post('loadObjects', { objectSet: base(INVOICE), select: [] }, { loadDerivedProperties: true });

    const { derived } = await trace();

    expect(derived).toEqual([
      {
        'object_type.api_name': INVOICE,
        'derived.form': 'objectType',
        'derived.api_name': 'invoiceAccount',
        'derived.reason': 'setting',
        'derived.hops': 2,
        'derived.operation': 'get',
        'sentry.op': 'function',
      },
    ]);
  });

  it(`${TRACES}: a request expression that reads balance records the expression by its position, and balance as query`, async () => {
    const owed = { type: 'negate', property: { type: 'property', apiName: 'balance' } };
    const count = selection('transactions', { type: 'count' });

    await post('loadObjects', { objectSet: withProperties(base(ACCOUNT), { txCount: count, owed }), select: ['owed'] });

    const { root, derived } = await trace();

    expect(derived).toEqual([
      {
        'object_type.api_name': ACCOUNT,
        'derived.form': 'objectType',
        'derived.api_name': 'balance',
        'derived.reason': 'query',
        'derived.hops': 1,
        'derived.operation': 'sum',
        'sentry.op': 'function',
      },
      {
        'object_type.api_name': ACCOUNT,
        'derived.form': 'request',
        'derived.position': 1,
        'derived.reason': 'select',
        'derived.hops': 0,
        'derived.operation': 'expression',
        'sentry.op': 'function',
      },
    ]);

    expect(counts(root)).toEqual({ count: 2, objects: 3, sqlMs: 'number' });
  });

  it(`${TRACES}: an aggregate of balance records its span with the reason query, and no Object count`, async () => {
    const answer = await post('aggregate', {
      objectSet: base(ACCOUNT),
      aggregation: [{ type: 'sum', field: 'balance', name: 'total' }],
      groupBy: [],
    });

    expect(answer['data']).toEqual([{ group: {}, metrics: [{ name: 'total', value: '127.50' }] }]);

    const { root, derived } = await trace();

    expect(derived).toEqual([
      {
        'object_type.api_name': ACCOUNT,
        'derived.form': 'objectType',
        'derived.api_name': 'balance',
        'derived.reason': 'query',
        'derived.hops': 1,
        'derived.operation': 'sum',
        'sentry.op': 'function',
      },
    ]);

    expect(counts(root)).toEqual({ count: 1, objects: undefined, sqlMs: 'number' });
  });

  it(`${TRACES}: a slow reader of the body does not add to derived.sql_ms`, async () => {
    await insertObjects(
      service.db,
      ACCOUNT,
      Array.from({ length: 40 }, (_, i) => ({ accountId: `slow-${i}`, name: `slow ${i}`, entity: 'E1' })),
    );

    const response = await service.respond(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      { objectSet: base(ACCOUNT), select: ['balance'], pageSize: 40 },
      PEOPLE.one,
    );

    const reader = response.body?.getReader();
    const started = performance.now();

    for (;;) {
      const chunk = await reader?.read();

      if (chunk?.done !== false) break;

      // oxlint-disable-next-line landmines/no-fixed-sleep -- The test is a client that reads slowly, so the wait is the input, not a guess about the service.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const readMs = performance.now() - started;

    const { root } = await trace();

    const sqlMs = root['derived.sql_ms'] as number;

    expect(readMs).toBeGreaterThan(500);
    expect(sqlMs).toBeLessThan(readMs / 2);
  });

  it(`${TRACES}: a load that computes no derived value records no derived property span, and no counts`, async () => {
    await post('loadObjects', { objectSet: base(ACCOUNT), select: ['name'] });

    const { root, derived } = await trace();

    expect(derived).toEqual([]);
    expect(counts(root)).toEqual({ count: undefined, objects: undefined, sqlMs: 'undefined' });
  });
});

describe(`${TRACES}: no span holds a derived value, a primary key, or a request derived property name`, () => {
  it(`${TRACES}: a read whose values, keys, and request names hold ${CANARY} records its derived spans with no ${CANARY}`, async () => {
    const accountName = {
      type: 'selection',
      objectSet: around('account'),
      operation: { type: 'get', selectedPropertyApiName: 'name' },
    };

    const set = {
      type: 'filter',
      objectSet: withProperties(base(TRANSACTION), { [`name${CANARY}`]: accountName }),
      where: { type: 'eq', field: `name${CANARY}`, value: CANARY },
    };

    const page = await post('loadObjects', { objectSet: set, select: [`name${CANARY}`, 'accountEntity'] });

    expect(page['data']).toEqual([
      expect.objectContaining({ __primaryKey: `${CANARY}-tx`, [`name${CANARY}`]: CANARY }),
    ]);

    const spans = await routeSpans();

    expect(spans.filter((span) => span.name === 'derived property')).toHaveLength(2);
    expect(routeTraceProblems(spans)).toEqual([]);
  });
});
