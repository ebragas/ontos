import type { OntologyIrObjectTypeBlockDataV2, OntologyIrPropertyType } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName } from '../db/index.ts';
import { columnName, tableName } from '../ontology/index.ts';
import { CLIENT_ENGAGEMENTS } from '../actions/actions.test-utils.ts';
import { irOf, propertyOfType, twinBlock } from '../ontology/stored.test-utils.ts';
import {
  errorAnswer,
  expectAggregate,
  expectOrderedAggregate,
  insertObjects,
  NS,
  startObjectSets,
  type ObjectRow,
  type ObjectSetsService,
} from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;

function accountBlock(): OntologyIrObjectTypeBlockDataV2 {
  const block = twinBlock('0.7.0', ACCOUNT);

  const properties: OntologyIrPropertyType[] = [
    propertyOfType('seats', { type: 'integer', integer: {} }),
    propertyOfType('rate', { type: 'double', double: {} }),
    propertyOfType('revenue', { type: 'decimal', decimal: { precision: 38, scale: 2 } }),
    propertyOfType('units', { type: 'decimal', decimal: { precision: 38, scale: 0 } }),
    propertyOfType('signedOn', { type: 'date', date: {} }),
    propertyOfType('seenAt', { type: 'timestamp', timestamp: {} }),
    { ...propertyOfType('score', { type: 'integer', integer: {} }), typeClasses: [] },
  ];

  for (const property of properties) block.objectType.propertyTypes[property.apiName] = property;

  return block;
}

const IR = irOf(accountBlock(), twinBlock('0.7.0', ENGAGEMENT), twinBlock('0.7.0', STRUCT_PROBE));

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(IR);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const RID: Readonly<Record<string, string>> = {
  'p-n-1': 'ri.phonograph2-objects.main.object.76d289d9-a1f0-55ff-8dba-1b137ed682c1',
  'p-n-2': 'ri.phonograph2-objects.main.object.3fc7fd7d-20e8-5ecd-a730-b9a83bcf2240',
  'p-n-3': 'ri.phonograph2-objects.main.object.0db06307-c1e0-585d-bfb9-d04ea774c22f',
  'p-n-4': 'ri.phonograph2-objects.main.object.24bc107e-61d8-54e8-9905-6264893d31c4',
};

const base = (objectType: string) => ({ type: 'base', objectType });

const PROBES = {
  type: 'filter',
  objectSet: base(ACCOUNT),
  where: { type: 'in', field: 'accountId', value: ['p-n-1', 'p-n-2', 'p-n-3', 'p-n-4'] },
};

const NOTE_PROBES: readonly ObjectRow[] = [
  { accountId: 'p-n-1', name: 'Probe One', note: 'alpha beta', active: true },
  { accountId: 'p-n-2', name: 'Probe Two', note: 'gamma', active: false },
  { accountId: 'p-n-3', name: 'Probe Three', note: 'alpha', active: true },
  { accountId: 'p-n-4', name: 'Probe Four' },
];

const SEARCHABLE_ACCOUNTS: readonly ObjectRow[] = [
  { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
  { accountId: 'acc-2', name: 'Globex', phase: 'prospect' },
  { accountId: 'acc-3', name: 'Initech', phase: 'closed' },
  ...NOTE_PROBES,
];

const PROBE_ACCOUNTS: readonly ObjectRow[] = [
  { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
  { accountId: 'acc-2', name: 'Globex', phase: 'prospect' },
  { accountId: 'acc-3', name: 'Initech', phase: 'closed' },
  { accountId: 'p-a', name: 'Probe phase a', phase: 'a' },
  { accountId: 'p-null', name: 'Probe null phase', phase: null },
];

const METRIC_ACCOUNTS: readonly ObjectRow[] = [
  {
    accountId: 'm-1',
    name: 'Alpha',
    seats: 10,
    rate: 1.5,
    revenue: '100.25',
    signedOn: '2026-01-15',
    seenAt: '2026-10-17T18:20:05.687Z',
    active: true,
  },
  {
    accountId: 'm-2',
    name: 'Beta',
    seats: 20,
    rate: 2.5,
    revenue: '200.50',
    signedOn: '2026-03-01',
    seenAt: '2026-10-17T19:22:25.573Z',
    active: false,
  },
  {
    accountId: 'm-3',
    name: 'Alpha',
    seats: 20,
    rate: 4,
    revenue: '0.25',
    signedOn: '2025-12-31',
    seenAt: '2026-10-18T00:00:00Z',
    active: true,
  },
  { accountId: 'm-4', name: 'Gamma' },
];

const STRUCT_PROBES: readonly ObjectRow[] = [
  { probeId: 'sp-1', relationship: { label: 'introduced', since: '2024-03-01' }, measures: {} },
  { probeId: 'sp-2', relationship: { label: 'referred', since: '2025-07-15' }, measures: {} },
  { probeId: 'sp-3', relationship: { label: 'introduced' }, measures: {} },
  { probeId: 'sp-4', relationship: {}, measures: {} },
];

describe('aggregations', () => {
  it('ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#response ontology/ontology-sdk/aggregations#group-bys: count, sum, and max of amount, grouped by the exact status', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [{ type: 'exact', field: 'status' }],
      aggregation: [
        { type: 'count', name: 'count' },
        { type: 'sum', name: 'amount.sum', field: 'amount' },
        { type: 'max', name: 'amount.max', field: 'amount' },
      ],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: { status: 'lost' },
            metrics: [
              { name: 'amount.sum', value: 15000 },
              { name: 'count', value: 1 },
              { name: 'amount.max', value: 15000 },
            ],
          },
          {
            group: { status: 'open' },
            metrics: [
              { name: 'amount.sum', value: 84000 },
              { name: 'count', value: 3 },
              { name: 'amount.max', value: 48000 },
            ],
          },
          {
            group: { status: 'won' },
            metrics: [
              { name: 'amount.sum', value: 21000 },
              { name: 'count', value: 2 },
              { name: 'amount.max', value: 12000 },
            ],
          },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#response: count and avg of amount over the Engagements of acc-1, with an empty groupBy, give 1 entry and no excludedItems', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: {
        type: 'filter',
        objectSet: base(ENGAGEMENT),
        where: { type: 'eq', field: 'accountId', value: 'acc-1' },
      },
      groupBy: [],
      aggregation: [
        { type: 'count', name: 'count' },
        { type: 'avg', name: 'amount.avg', field: 'amount' },
      ],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        accuracy: 'ACCURATE',
        data: [
          {
            group: {},
            metrics: [
              { name: 'count', value: 3 },
              { name: 'amount.avg', value: 22000 },
            ],
          },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#response: a count of an empty Object Set with an empty groupBy gives 1 entry with the count 0', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.aggregate({
      objectSet: {
        type: 'filter',
        objectSet: base(ACCOUNT),
        where: { type: 'eq', field: 'accountId', value: 'p-none' },
      },
      aggregation: [{ type: 'count' }],
      groupBy: [],
    });

    expectAggregate(answer, {
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'count', value: 0 }] }] },
    });
  });

  it('ontology/ontology-sdk/aggregations#response: a count of an empty Object Set grouped by phase gives an empty data and excludedItems 0', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.aggregate({
      objectSet: {
        type: 'filter',
        objectSet: base(ACCOUNT),
        where: { type: 'eq', field: 'accountId', value: 'p-none' },
      },
      aggregation: [{ type: 'count' }],
      groupBy: [{ type: 'exact', field: 'phase' }],
    });

    expectAggregate(answer, { status: 200, body: { excludedItems: 0, accuracy: 'ACCURATE', data: [] } });
  });

  it('ontology/ontology-sdk/aggregations#group-bys ontology/object-link-types/properties#searchable: a count grouped by note, which is not Searchable, leaves out the null note', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.aggregate({
      objectSet: PROBES,
      aggregation: [{ type: 'count' }],
      groupBy: [{ type: 'exact', field: 'note' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          { group: { note: 'alpha' }, metrics: [{ name: 'count', value: 1 }] },
          { group: { note: 'alpha beta' }, metrics: [{ name: 'count', value: 1 }] },
          { group: { note: 'gamma' }, metrics: [{ name: 'count', value: 1 }] },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#group-bys ontology/object-link-types/properties#searchable: exactDistinct of note, which is not Searchable, does not count the null note', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.aggregate({
      objectSet: PROBES,
      aggregation: [{ type: 'exactDistinct', field: 'note', name: 'distinct' }],
      groupBy: [],
    });

    expectAggregate(answer, {
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'distinct', value: 3 }] }] },
    });
  });

  it.each([
    ['ontology/ontology-sdk/aggregations#metrics', 'exactDistinct', 'name', 4],
    ['ontology/ontology-sdk/aggregations#metrics', 'approximateDistinct', 'name', 4],
    ['ontology/ontology-sdk/aggregations#metrics', 'min', 'active', 0],
    ['ontology/ontology-sdk/aggregations#metrics', 'max', 'active', 1],
    ['ontology/ontology-sdk/aggregations#metrics', 'sum', 'active', 2],
    ['ontology/ontology-sdk/aggregations#metrics', 'avg', 'active', 0.6666666666666666],
    ['ontology/ontology-sdk/aggregations#metrics', 'exactDistinct', 'active', 2],
    ['ontology/ontology-sdk/aggregations#metrics', 'approximateDistinct', 'active', 2],
  ])('%s: %s of %s gives %s', async (_rules, type, field, value) => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const name = `${field}.${type}`;

    const answer = await service.aggregate({ objectSet: PROBES, aggregation: [{ type, field, name }], groupBy: [] });

    expectAggregate(answer, {
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name, value }] }] },
    });
  });

  it('ontology/object-link-types/properties#base-types: a count grouped by the Boolean active keys each group with false or true', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.aggregate({
      objectSet: PROBES,
      aggregation: [{ type: 'count' }],
      groupBy: [{ type: 'exact', field: 'active' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          { group: { active: false }, metrics: [{ name: 'count', value: 1 }] },
          { group: { active: true }, metrics: [{ name: 'count', value: 2 }] },
        ],
      },
    });
  });
});

describe('loadObjects reads of a Property that is not Searchable', () => {
  it('ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#searchable: a where eq on note, which is not Searchable, matches the whole value', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: { type: 'filter', objectSet: PROBES, where: { type: 'eq', field: 'note', value: 'gamma' } },
      select: ['name', 'note'],
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          {
            accountId: 'p-n-2',
            note: 'gamma',
            __primaryKey: 'p-n-2',
            name: 'Probe Two',
            __title: 'Probe Two',
            __apiName: ACCOUNT,
            __rid: RID['p-n-2'],
          },
        ],
        totalCount: '1',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });

  it('ontology/ontology-sdk/object-sets#order ontology/object-link-types/properties#searchable: an orderBy note asc, which is not Searchable, puts the null note first', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: PROBES,
      select: ['name', 'note'],
      orderBy: { fields: [{ field: 'note', direction: 'asc' }] },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          {
            name: 'Probe Four',
            __title: 'Probe Four',
            accountId: 'p-n-4',
            __primaryKey: 'p-n-4',
            __apiName: ACCOUNT,
            __rid: RID['p-n-4'],
          },
          {
            accountId: 'p-n-3',
            note: 'alpha',
            __primaryKey: 'p-n-3',
            name: 'Probe Three',
            __title: 'Probe Three',
            __apiName: ACCOUNT,
            __rid: RID['p-n-3'],
          },
          {
            accountId: 'p-n-1',
            note: 'alpha beta',
            __primaryKey: 'p-n-1',
            name: 'Probe One',
            __title: 'Probe One',
            __apiName: ACCOUNT,
            __rid: RID['p-n-1'],
          },
          {
            accountId: 'p-n-2',
            note: 'gamma',
            __primaryKey: 'p-n-2',
            name: 'Probe Two',
            __title: 'Probe Two',
            __apiName: ACCOUNT,
            __rid: RID['p-n-2'],
          },
        ],
        totalCount: '4',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });

  it('ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#searchable: a where isNull on note, which is not Searchable, matches p-n-4', async () => {
    await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: { type: 'filter', objectSet: PROBES, where: { type: 'isNull', field: 'note', value: true } },
      select: ['name', 'note'],
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          {
            name: 'Probe Four',
            __title: 'Probe Four',
            accountId: 'p-n-4',
            __primaryKey: 'p-n-4',
            __apiName: ACCOUNT,
            __rid: RID['p-n-4'],
          },
        ],
        totalCount: '1',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });
});

describe('the metrics', () => {
  it.each([
    ['the 4 Accounts of METRIC_ACCOUNTS', METRIC_ACCOUNTS],
    ['an empty Object Set', []],
  ])(
    'ontology/ontology-sdk/aggregations#response: with no metric and no groupBy, %s gives exactly 1 entry with an empty group',
    async (_case, objects) => {
      await insertObjects(service.db, ACCOUNT, objects);

      const answer = await service.aggregate({ objectSet: base(ACCOUNT), aggregation: [], groupBy: [] });

      expectAggregate(answer, { status: 200, body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [] }] } });
    },
  );

  it('ontology/ontology-sdk/aggregations#metrics: each metric on each base type that it takes, with a number for each numeric value, an exact string for each Decimal value, and a date string for each Date or Timestamp value', async () => {
    await insertObjects(service.db, ACCOUNT, METRIC_ACCOUNTS);

    const metric = (type: string, field: string) => ({ type, field, name: `${field}.${type}` });
    const numeric = ['sum', 'avg', 'min', 'max', 'exactDistinct', 'approximateDistinct'];
    const dated = ['min', 'max', 'exactDistinct', 'approximateDistinct'];

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [],
      aggregation: [
        { type: 'count', name: 'count' },
        ...['seats', 'rate', 'revenue', 'active'].flatMap((field) => numeric.map((type) => metric(type, field))),
        ...['signedOn', 'seenAt'].flatMap((field) => dated.map((type) => metric(type, field))),
        metric('exactDistinct', 'name'),
        metric('approximateDistinct', 'name'),
      ],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        accuracy: 'ACCURATE',
        data: [
          {
            group: {},
            metrics: [
              { name: 'count', value: 4 },
              { name: 'seats.sum', value: 50 },
              { name: 'seats.avg', value: 16.666666666666668 },
              { name: 'seats.min', value: 10 },
              { name: 'seats.max', value: 20 },
              { name: 'seats.exactDistinct', value: 2 },
              { name: 'seats.approximateDistinct', value: 2 },
              { name: 'rate.sum', value: 8 },
              { name: 'rate.avg', value: 2.6666666666666665 },
              { name: 'rate.min', value: 1.5 },
              { name: 'rate.max', value: 4 },
              { name: 'rate.exactDistinct', value: 3 },
              { name: 'rate.approximateDistinct', value: 3 },
              { name: 'revenue.sum', value: '301.00' },
              { name: 'revenue.avg', value: '100.33' },
              { name: 'revenue.min', value: '0.25' },
              { name: 'revenue.max', value: '200.50' },
              { name: 'revenue.exactDistinct', value: 3 },
              { name: 'revenue.approximateDistinct', value: 3 },
              { name: 'active.sum', value: 2 },
              { name: 'active.avg', value: 0.6666666666666666 },
              { name: 'active.min', value: 0 },
              { name: 'active.max', value: 1 },
              { name: 'active.exactDistinct', value: 2 },
              { name: 'active.approximateDistinct', value: 2 },
              { name: 'signedOn.min', value: '2025-12-31' },
              { name: 'signedOn.max', value: '2026-03-01' },
              { name: 'signedOn.exactDistinct', value: 3 },
              { name: 'signedOn.approximateDistinct', value: 3 },
              { name: 'seenAt.min', value: '2026-10-17T18:20:05.687Z' },
              { name: 'seenAt.max', value: '2026-10-18T00:00:00Z' },
              { name: 'seenAt.exactDistinct', value: 3 },
              { name: 'seenAt.approximateDistinct', value: 3 },
              { name: 'name.exactDistinct', value: 3 },
              { name: 'name.approximateDistinct', value: 3 },
            ],
          },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics: a metric over Objects with no value in its Property has its name and no value, and exactDistinct gives 0', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'm-4', name: 'Gamma' }]);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [],
      aggregation: [
        { type: 'count', name: 'count' },
        { type: 'max', field: 'seats', name: 'seats.max' },
        { type: 'avg', field: 'seats', name: 'seats.avg' },
        { type: 'avg', field: 'revenue', name: 'revenue.avg' },
        { type: 'min', field: 'seenAt', name: 'seenAt.min' },
        { type: 'exactDistinct', field: 'seats', name: 'seats.exactDistinct' },
      ],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        accuracy: 'ACCURATE',
        data: [
          {
            group: {},
            metrics: [
              { name: 'count', value: 1 },
              { name: 'seats.max' },
              { name: 'seats.avg' },
              { name: 'revenue.avg' },
              { name: 'seenAt.min' },
              { name: 'seats.exactDistinct', value: 0 },
            ],
          },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics: a metric with no name gets <metric>_<property>, and a count with no name gets count', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [{ type: 'exact', field: 'status' }],
      aggregation: [{ type: 'count' }, { type: 'max', field: 'amount' }, { type: 'avg', field: 'amount' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: { status: 'lost' },
            metrics: [
              { name: 'count', value: 1 },
              { name: 'max_amount', value: 15000 },
              { name: 'avg_amount', value: 15000 },
            ],
          },
          {
            group: { status: 'open' },
            metrics: [
              { name: 'count', value: 3 },
              { name: 'max_amount', value: 48000 },
              { name: 'avg_amount', value: 28000 },
            ],
          },
          {
            group: { status: 'won' },
            metrics: [
              { name: 'count', value: 2 },
              { name: 'max_amount', value: 12000 },
              { name: 'avg_amount', value: 10500 },
            ],
          },
        ],
      },
    });
  });

  it.each(['min', 'max', 'sum', 'avg'] as const)(
    'ontology/ontology-sdk/aggregations#metrics service/http-api#errors: %s of the String name gets 400 Default:InvalidArgument with metric, property, and propertyBaseType',
    async (type) => {
      await insertObjects(service.db, ACCOUNT, SEARCHABLE_ACCOUNTS);

      const answer = await service.aggregate({
        objectSet: PROBES,
        aggregation: [{ type, field: 'name', name: `name.${type}` }],
        groupBy: [],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { metric: type, property: 'name', propertyBaseType: 'String' },
        },
      });
    },
  );

  it.each([
    ['sum', 'signedOn', 'LocalDate'],
    ['avg', 'seenAt', 'Timestamp'],
  ])(
    'ontology/ontology-sdk/aggregations#metrics: %s of the %s Property %s, a base type that the metric does not take, gets 400 Default:InvalidArgument',
    async (type, field, propertyBaseType) => {
      await insertObjects(service.db, ACCOUNT, METRIC_ACCOUNTS);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        aggregation: [{ type, field, name: `${field}.${type}` }],
        groupBy: [],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { metric: type, property: field, propertyBaseType },
        },
      });
    },
  );

  it.each([
    ['a metric', { aggregation: [{ type: 'max', field: 'nope', name: 'nope.max' }], groupBy: [] }],
    ['a group-by', { aggregation: [{ type: 'count' }], groupBy: [{ type: 'exact', field: 'nope' }] }],
  ])(
    'ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#group-bys: %s on a Property that the Object Type does not have gets 404 PropertiesNotFound',
    async (_case, request) => {
      await insertObjects(service.db, ACCOUNT, METRIC_ACCOUNTS);

      const answer = await service.aggregate({ objectSet: base(ACCOUNT), ...request });

      expect(errorAnswer(answer)).toEqual({
        status: 404,
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'PropertiesNotFound',
          parameters: { objectType: ACCOUNT, properties: ['nope'] },
        },
      });
    },
  );

  it('ontology/object-link-types/properties#ontology-metadata: score, a Property with no type classes, sorts in loadObjects, and groups and sums in aggregate', async () => {
    await insertObjects(service.db, ACCOUNT, [
      { accountId: 's-1', name: 'Score One', score: 1 },
      { accountId: 's-2', name: 'Score Two', score: 2 },
      { accountId: 's-3', name: 'Score Three', score: 2 },
    ]);

    const page = await service.loadObjects({
      objectSet: base(ACCOUNT),
      select: ['score'],
      orderBy: { fields: [{ field: 'score', direction: 'desc' }] },
      excludeRid: true,
    });

    expect(page).toEqual({
      status: 200,
      body: {
        data: [
          { score: 2, accountId: 's-2', __primaryKey: 's-2', __apiName: ACCOUNT },
          { score: 2, accountId: 's-3', __primaryKey: 's-3', __apiName: ACCOUNT },
          { score: 1, accountId: 's-1', __primaryKey: 's-1', __apiName: ACCOUNT },
        ],
        totalCount: '3',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'score' }],
      aggregation: [
        { type: 'count', name: 'count' },
        { type: 'sum', field: 'score', name: 'score.sum' },
      ],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: { score: 1 },
            metrics: [
              { name: 'count', value: 1 },
              { name: 'score.sum', value: 1 },
            ],
          },
          {
            group: { score: 2 },
            metrics: [
              { name: 'count', value: 2 },
              { name: 'score.sum', value: 4 },
            ],
          },
        ],
      },
    });
  });
});

describe('the metrics of a Decimal', () => {
  const metrics = (field: string, types: readonly string[]) =>
    types.map((type) => ({ type, field, name: `${field}.${type}` }));

  const accounts = (revenues: readonly string[], phase?: string) =>
    revenues.map((revenue, index) => ({
      accountId: `${phase ?? 'd'}-${index}`,
      name: 'Decimal',
      revenue,
      ...(phase === undefined ? {} : { phase }),
    }));

  it('ontology/ontology-sdk/aggregations#metrics: sum, min, and max of a Decimal are exact strings with the scale of the Property, also a sum past 2^53', async () => {
    await insertObjects(service.db, ACCOUNT, accounts(['9007199254740993.00', '1.00']));

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [],
      aggregation: metrics('revenue', ['sum', 'min', 'max']),
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        accuracy: 'ACCURATE',
        data: [
          {
            group: {},
            metrics: [
              { name: 'revenue.sum', value: '9007199254740994.00' },
              { name: 'revenue.min', value: '1.00' },
              { name: 'revenue.max', value: '9007199254740993.00' },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ['0.01 and 0.02', '0.02', ['0.01', '0.02']],
    ['-0.01 and -0.02', '-0.02', ['-0.01', '-0.02']],
    ['0.02 and 0.03', '0.03', ['0.02', '0.03']],
    ['-0.02 and -0.03', '-0.03', ['-0.02', '-0.03']],
    ['-0.01, 0.00, and 0.00, which rounds to zero,', '0.00', ['-0.01', '0.00', '0.00']],
  ])(
    'ontology/ontology-sdk/aggregations#metrics: avg of a Decimal rounds 1 time to the scale, half away from zero: the average of %s is %s',
    async (_case, average, revenues) => {
      await insertObjects(service.db, ACCOUNT, accounts(revenues));

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        groupBy: [],
        aggregation: metrics('revenue', ['avg']),
      });

      expectAggregate(answer, {
        status: 200,
        body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'revenue.avg', value: average }] }] },
      });
    },
  );

  it.each([
    ['1 and 2', '2', ['1', '2']],
    ['-1 and -2', '-2', ['-1', '-2']],
  ])(
    'ontology/ontology-sdk/aggregations#metrics: avg of a Decimal of scale 0 rounds to the scale of its Property: the average of %s is %s',
    async (_case, average, units) => {
      await insertObjects(
        service.db,
        ACCOUNT,
        units.map((value, index) => ({ accountId: `u-${index}`, name: 'Decimal', units: value })),
      );

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        groupBy: [],
        aggregation: metrics('units', ['avg']),
      });

      expectAggregate(answer, {
        status: 200,
        body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'units.avg', value: average }] }] },
      });
    },
  );

  it('ontology/ontology-sdk/aggregations#metrics: avg of a Decimal rounds the exact average, not a quotient that Postgres rounded before, also in a group', async () => {
    const revenues = [...Array.from({ length: 100 }, () => '50000000000000.00'), '50000000000000.50'];

    await insertObjects(service.db, ACCOUNT, accounts(revenues, 'open'));

    const avg = metrics('revenue', ['avg']);
    const expected = [{ name: 'revenue.avg', value: '50000000000000.00' }];

    expectAggregate(await service.aggregate({ objectSet: base(ACCOUNT), groupBy: [], aggregation: avg }), {
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: expected }] },
    });

    expectAggregate(
      await service.aggregate({
        objectSet: base(ACCOUNT),
        groupBy: [{ type: 'exact', field: 'phase' }],
        aggregation: avg,
      }),
      {
        status: 200,
        body: { excludedItems: 0, accuracy: 'ACCURATE', data: [{ group: { phase: 'open' }, metrics: expected }] },
      },
    );
  });

  it.each([
    ['ASC', 'b', 'a'],
    ['ASC', 'a', 'b'],
    ['DESC', 'b', 'a'],
    ['DESC', 'a', 'b'],
  ] as const)(
    'ontology/ontology-sdk/aggregations#metrics: an avg of a Decimal with the direction %s orders the groups by the shown value, when the .00 group is %s and the .01 group is %s',
    async (direction, low, high) => {
      const lowRevenues = [...Array.from({ length: 100 }, () => '50000000000000.00'), '50000000000000.50'];

      await insertObjects(service.db, ACCOUNT, [
        ...accounts(lowRevenues, low),
        ...accounts(['50000000000000.00', '50000000000000.01'], high),
      ]);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        groupBy: [{ type: 'exact', field: 'phase' }],
        aggregation: [{ type: 'avg', field: 'revenue', name: 'revenue.avg', direction }],
      });

      const lowGroup = { group: { phase: low }, metrics: [{ name: 'revenue.avg', value: '50000000000000.00' }] };
      const highGroup = { group: { phase: high }, metrics: [{ name: 'revenue.avg', value: '50000000000000.01' }] };

      expectOrderedAggregate(answer, {
        status: 200,
        body: {
          excludedItems: 0,
          accuracy: 'ACCURATE',
          data: direction === 'ASC' ? [lowGroup, highGroup] : [highGroup, lowGroup],
        },
      });
    },
  );

  it('ontology/ontology-sdk/aggregations#metrics: a grouped aggregate gives the exact strings of sum, avg, min, and max for each group', async () => {
    await insertObjects(service.db, ACCOUNT, [
      ...accounts(['9007199254740993.00', '1.00'], 'open'),
      ...accounts(['-0.01', '-0.02'], 'lost'),
    ]);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'phase' }],
      aggregation: metrics('revenue', ['sum', 'avg', 'min', 'max']),
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: { phase: 'open' },
            metrics: [
              { name: 'revenue.sum', value: '9007199254740994.00' },
              { name: 'revenue.avg', value: '4503599627370497.00' },
              { name: 'revenue.min', value: '1.00' },
              { name: 'revenue.max', value: '9007199254740993.00' },
            ],
          },
          {
            group: { phase: 'lost' },
            metrics: [
              { name: 'revenue.sum', value: '-0.03' },
              { name: 'revenue.avg', value: '-0.02' },
              { name: 'revenue.min', value: '-0.02' },
              { name: 'revenue.max', value: '-0.01' },
            ],
          },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics: a distinct count of a Decimal stays a JSON number', async () => {
    await insertObjects(service.db, ACCOUNT, accounts(['1.00', '1.00', '2.50']));

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [],
      aggregation: metrics('revenue', ['exactDistinct', 'approximateDistinct']),
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        accuracy: 'ACCURATE',
        data: [
          {
            group: {},
            metrics: [
              { name: 'revenue.exactDistinct', value: 2 },
              { name: 'revenue.approximateDistinct', value: 2 },
            ],
          },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics: a sum of a Decimal with a direction orders the groups by number, not by text', async () => {
    await insertObjects(service.db, ACCOUNT, [...accounts(['9.00'], 'open'), ...accounts(['10.00'], 'lost')]);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'phase' }],
      aggregation: [{ type: 'sum', field: 'revenue', name: 'revenue.sum', direction: 'DESC' }],
    });

    expectOrderedAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          { group: { phase: 'lost' }, metrics: [{ name: 'revenue.sum', value: '10.00' }] },
          { group: { phase: 'open' }, metrics: [{ name: 'revenue.sum', value: '9.00' }] },
        ],
      },
    });
  });
});

describe('the order of the groups', () => {
  it.each([
    [
      'count DESC',
      { type: 'count', name: 'count', direction: 'DESC' },
      [
        { group: { status: 'open' }, metrics: [{ name: 'count', value: 3 }] },
        { group: { status: 'won' }, metrics: [{ name: 'count', value: 2 }] },
        { group: { status: 'lost' }, metrics: [{ name: 'count', value: 1 }] },
      ],
    ],
    [
      'the sum of amount ASC',
      { type: 'sum', field: 'amount', name: 'amount.sum', direction: 'ASC' },
      [
        { group: { status: 'lost' }, metrics: [{ name: 'amount.sum', value: 15000 }] },
        { group: { status: 'won' }, metrics: [{ name: 'amount.sum', value: 21000 }] },
        { group: { status: 'open' }, metrics: [{ name: 'amount.sum', value: 84000 }] },
      ],
    ],
  ])(
    'ontology/ontology-sdk/aggregations#metrics: with 1 group-by, %s orders the groups',
    async (_case, metric, data) => {
      await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        groupBy: [{ type: 'exact', field: 'status' }],
        aggregation: [metric],
      });

      expectOrderedAggregate(answer, { status: 200, body: { excludedItems: 0, accuracy: 'ACCURATE', data } });
    },
  );

  it('ontology/ontology-sdk/aggregations#metrics: with no group-by, a metric with a direction gives the 1 entry', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [],
      aggregation: [{ type: 'count', name: 'count', direction: 'ASC' }],
    });

    expectOrderedAggregate(answer, {
      status: 200,
      body: { accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'count', value: 6 }] }] },
    });
  });

  it('ontology/ontology-sdk/aggregations#metrics: with 2 group-bys, a metric with a direction gets 400 InvalidAggregationOrdering', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [
        { type: 'exact', field: 'status' },
        { type: 'exact', field: 'accountId' },
      ],
      aggregation: [{ type: 'count', name: 'count', direction: 'DESC' }],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidAggregationOrdering', parameters: {} },
    });
  });
});

describe('the exact group-by', () => {
  it('ontology/ontology-sdk/aggregations#group-bys ontology/ontology-sdk/aggregations#response: 2 exact group-bys give 1 group for each pair of values, keyed by each field', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [
        { type: 'exact', field: 'status' },
        { type: 'exact', field: 'accountId' },
      ],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          { group: { status: 'lost', accountId: 'acc-2' }, metrics: [{ name: 'count', value: 1 }] },
          { group: { status: 'open', accountId: 'acc-1' }, metrics: [{ name: 'count', value: 2 }] },
          { group: { status: 'open', accountId: 'acc-3' }, metrics: [{ name: 'count', value: 1 }] },
          { group: { status: 'won', accountId: 'acc-1' }, metrics: [{ name: 'count', value: 1 }] },
          { group: { status: 'won', accountId: 'acc-3' }, metrics: [{ name: 'count', value: 1 }] },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#group-bys ontology/ontology-sdk/aggregations#response: an exact group key of an Integer, a Double, a Decimal, a Date, and a Timestamp has the JSON form of its base type', async () => {
    await insertObjects(service.db, ACCOUNT, METRIC_ACCOUNTS);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: ['seats', 'rate', 'revenue', 'signedOn', 'seenAt'].map((field) => ({ type: 'exact', field })),
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: {
              seats: 10,
              rate: 1.5,
              revenue: '100.25',
              signedOn: '2026-01-15',
              seenAt: '2026-10-17T18:20:05.687Z',
            },
            metrics: [{ name: 'count', value: 1 }],
          },
          {
            group: {
              seats: 20,
              rate: 2.5,
              revenue: '200.50',
              signedOn: '2026-03-01',
              seenAt: '2026-10-17T19:22:25.573Z',
            },
            metrics: [{ name: 'count', value: 1 }],
          },
          {
            group: { seats: 20, rate: 4, revenue: '0.25', signedOn: '2025-12-31', seenAt: '2026-10-18T00:00:00Z' },
            metrics: [{ name: 'count', value: 1 }],
          },
        ],
      },
    });
  });

  it.each([
    [
      'includeNullValues true gives a group with the key null',
      { includeNullValues: true },
      [
        { group: { note: 'alpha' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'alpha beta' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'gamma' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: null }, metrics: [{ name: 'count', value: 1 }] },
      ],
    ],
    [
      'defaultValue none gives the Object with no note the group key none',
      { defaultValue: 'none' },
      [
        { group: { note: 'alpha' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'alpha beta' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'gamma' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'none' }, metrics: [{ name: 'count', value: 1 }] },
      ],
    ],
    [
      'defaultValue gamma, a value that p-n-2 has, puts the Object with no note in the 1 group gamma',
      { defaultValue: 'gamma' },
      [
        { group: { note: 'alpha' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'alpha beta' }, metrics: [{ name: 'count', value: 1 }] },
        { group: { note: 'gamma' }, metrics: [{ name: 'count', value: 2 }] },
      ],
    ],
  ])('ontology/ontology-sdk/aggregations#group-bys: in a group-by of note, %s', async (_case, fields, data) => {
    await insertObjects(service.db, ACCOUNT, NOTE_PROBES);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'note', ...fields }],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expectAggregate(answer, { status: 200, body: { excludedItems: 0, accuracy: 'ACCURATE', data } });
  });

  it('ontology/ontology-sdk/aggregations#group-bys: in a group-by of note, the defaultValue "\\u0000", which Postgres does not take, gets 400 Default:InvalidArgument', async () => {
    await insertObjects(service.db, ACCOUNT, NOTE_PROBES);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'note', defaultValue: '\u0000' }],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { field: 'groupBy' } },
    });
  });
});

describe('the limit of the groups', () => {
  it.each([0, -1, 1.5])(
    'ontology/ontology-sdk/aggregations#group-bys: maxGroupCount %s, which is not a whole number of 1 or more, gets 400 Default:InvalidArgument',
    async (maxGroupCount) => {
      await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        groupBy: [{ type: 'exact', field: 'status', maxGroupCount }],
        aggregation: [{ type: 'count', name: 'count' }],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { field: 'groupBy' } },
      });
    },
  );

  it('ontology/ontology-sdk/aggregations#group-bys: maxGroupCount 1e20, a whole number over the largest safe integer, gets 400 Default:InvalidArgument', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [{ type: 'exact', field: 'status', maxGroupCount: 1e20 }],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { field: 'groupBy' } },
    });
  });

  it('ontology/ontology-sdk/aggregations#group-bys ontology/ontology-sdk/aggregations#response: maxGroupCount 1 keeps open, the group with the most Objects, and excludedItems counts the 2 groups that it leaves out', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [{ type: 'exact', field: 'status', maxGroupCount: 1 }],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 2,
        accuracy: 'ACCURATE',
        data: [{ group: { status: 'open' }, metrics: [{ name: 'count', value: 3 }] }],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#group-bys ontology/ontology-sdk/aggregations#metrics: maxGroupCount 1 with count ASC keeps lost, the first group in the order of the metric', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [{ type: 'exact', field: 'status', maxGroupCount: 1 }],
      aggregation: [{ type: 'count', name: 'count', direction: 'ASC' }],
    });

    expectOrderedAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 2,
        accuracy: 'ACCURATE',
        data: [{ group: { status: 'lost' }, metrics: [{ name: 'count', value: 1 }] }],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#group-bys: maxGroupCount 2 over 3 groups of 1 Object keeps the 2 lowest group values by code point, Zed and abc', async () => {
    await insertObjects(service.db, ACCOUNT, [
      { accountId: 't-1', name: 'Tie One', note: 'abc' },
      { accountId: 't-2', name: 'Tie Two', note: 'Zed' },
      { accountId: 't-3', name: 'Tie Three', note: 'mid' },
    ]);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'note', maxGroupCount: 2 }],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 1,
        accuracy: 'ACCURATE',
        data: [
          { group: { note: 'Zed' }, metrics: [{ name: 'count', value: 1 }] },
          { group: { note: 'abc' }, metrics: [{ name: 'count', value: 1 }] },
        ],
      },
    });
  });

  it('ontology/ontology-sdk/aggregations#group-bys: with no maxGroupCount, 10,001 groups give 10,000 groups and excludedItems 1', async () => {
    await service.db.query({
      text: `INSERT INTO ontology_1_objects.${quoteName(tableName(ACCOUNT))} (${quoteName(columnName('accountId'))}, ${quoteName(columnName('name'))}) SELECT 'g-' || n, 'Group ' || n FROM generate_series(1, 10001) AS n`,
      values: [],
    });

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      groupBy: [{ type: 'exact', field: 'name' }],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    const body = answer.body as { data?: unknown; excludedItems?: unknown; accuracy?: unknown };

    expect({
      status: answer.status,
      groups: Array.isArray(body.data) ? body.data.length : body.data,
      excludedItems: body.excludedItems,
      accuracy: body.accuracy,
    }).toEqual({
      status: 200,
      groups: 10_000,
      excludedItems: 1,
      accuracy: 'ACCURATE',
    });
  });
});

describe('the group-bys that OSDK refuses', () => {
  it.each([
    [
      'defaultValue and includeNullValues in 1 group-by get 400 DefaultAndNullGroupsNotSupported',
      {
        groupBy: [{ type: 'exact', field: 'note', defaultValue: 'none', includeNullValues: true }],
        aggregation: [{ type: 'count', name: 'count' }],
      },
      { errorCode: 'INVALID_ARGUMENT', errorName: 'DefaultAndNullGroupsNotSupported', parameters: {} },
    ],
    [
      'includeNullValues with a metric direction gets 400 InvalidAggregationOrderingWithNullValues',
      {
        groupBy: [{ type: 'exact', field: 'note', includeNullValues: true }],
        aggregation: [{ type: 'count', name: 'count', direction: 'DESC' }],
      },
      { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidAggregationOrderingWithNullValues', parameters: {} },
    ],
    [
      'the same Property in 2 group-bys gets 400 MultipleGroupByOnFieldNotSupported',
      {
        groupBy: [
          { type: 'exact', field: 'note' },
          { type: 'exact', field: 'note', maxGroupCount: 2 },
        ],
        aggregation: [{ type: 'count', name: 'count' }],
      },
      {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'MultipleGroupByOnFieldNotSupported',
        parameters: { duplicateFields: ['note'] },
      },
    ],
  ])('ontology/ontology-sdk/aggregations#group-bys: %s', async (_case, request, body) => {
    await insertObjects(service.db, ACCOUNT, NOTE_PROBES);

    const answer = await service.aggregate({ objectSet: base(ACCOUNT), ...request });

    expect(errorAnswer(answer)).toEqual({ status: 400, body });
  });
});

describe('the accuracy', () => {
  it.each(['REQUIRE_ACCURATE', 'ALLOW_APPROXIMATE'])(
    'ontology/ontology-sdk/aggregations#response: a request with the accuracy %s gets ACCURATE',
    async (accuracy) => {
      await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        groupBy: [{ type: 'exact', field: 'status' }],
        aggregation: [{ type: 'count', name: 'count' }],
        accuracy,
      });

      expectAggregate(answer, {
        status: 200,
        body: {
          excludedItems: 0,
          accuracy: 'ACCURATE',
          data: [
            { group: { status: 'lost' }, metrics: [{ name: 'count', value: 1 }] },
            { group: { status: 'open' }, metrics: [{ name: 'count', value: 3 }] },
            { group: { status: 'won' }, metrics: [{ name: 'count', value: 2 }] },
          ],
        },
      });
    },
  );
});

describe('the metrics and group-bys of a shape that V1 does not read', () => {
  it.each([
    ['null', null],
    ['the String "count"', 'count'],
    ['an object with no type', { name: 'count' }],
    ['an object with the type 5', { type: 5, name: 'count' }],
  ])(
    'ontology/ontology-sdk/aggregations#metrics: the metric %s gets 400 Default:InvalidArgument',
    async (_case, metric) => {
      await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

      const answer = await service.aggregate({ objectSet: base(ENGAGEMENT), groupBy: [], aggregation: [metric] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { field: 'aggregation' },
        },
      });
    },
  );

  it.each([
    ['null', null],
    ['the String "exact"', 'exact'],
    ['an object with no type', { field: 'status' }],
    ['an object with the type 5', { type: 5, field: 'status' }],
  ])(
    'ontology/ontology-sdk/aggregations#group-bys: the group-by %s gets 400 Default:InvalidArgument',
    async (_case, groupBy) => {
      await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        groupBy: [groupBy],
        aggregation: [{ type: 'count', name: 'count' }],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { field: 'groupBy' } },
      });
    },
  );
});

describe('the OSDK features outside V1', () => {
  it('ontology/ontology-sdk/aggregations#out-of-scope: approximatePercentile gets 400 Default:InvalidArgument', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      groupBy: [],
      aggregation: [{ type: 'approximatePercentile', field: 'amount', name: 'amount.p50', approximatePercentile: 0.5 }],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: { feature: 'approximatePercentile' },
      },
    });
  });

  it.each([
    [
      'exactDistinct of the struct Property relationship',
      {
        aggregation: [{ type: 'exactDistinct', field: 'relationship', name: 'relationship.exactDistinct' }],
        groupBy: [],
      },
      'exactDistinct on a struct Property',
    ],
    [
      'approximateDistinct of the struct Property relationship',
      {
        aggregation: [{ type: 'approximateDistinct', field: 'relationship', name: 'relationship.approximateDistinct' }],
        groupBy: [],
      },
      'approximateDistinct on a struct Property',
    ],
    [
      'exactDistinct of the struct field relationship.label',
      {
        aggregation: [
          {
            type: 'exactDistinct',
            propertyIdentifier: { type: 'structField', propertyApiName: 'relationship', structFieldApiName: 'label' },
            name: 'label',
          },
        ],
        groupBy: [],
      },
      'structField',
    ],
    [
      'an exact group-by of the struct Property relationship',
      { aggregation: [{ type: 'count' }], groupBy: [{ type: 'exact', field: 'relationship' }] },
      'exact group-by on a struct Property',
    ],
    [
      'an exact group-by of the struct field relationship.label',
      {
        aggregation: [{ type: 'count' }],
        groupBy: [
          {
            type: 'exact',
            propertyIdentifier: { type: 'structField', propertyApiName: 'relationship', structFieldApiName: 'label' },
          },
        ],
      },
      'structField',
    ],
  ])(
    'ontology/ontology-sdk/aggregations#out-of-scope: %s gets 400 Default:InvalidArgument',
    async (_case, request, feature) => {
      await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES);

      const answer = await service.aggregate({ objectSet: base(STRUCT_PROBE), ...request });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { feature } },
      });
    },
  );
});
