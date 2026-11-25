import type { OntologyIrObjectTypeBlockDataV2, OntologyIrPropertyType } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_ENGAGEMENTS } from '../actions/actions.test-utils.ts';
import { irOf, propertyOfType, twinBlock } from '../ontology/stored.test-utils.ts';
import {
  errorAnswer,
  expectAggregate,
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
    propertyOfType('price', { type: 'decimal', decimal: { precision: 38, scale: 2 } }),
    propertyOfType('signedOn', { type: 'date', date: {} }),
    propertyOfType('seenAt', { type: 'timestamp', timestamp: {} }),
    propertyOfType('scores', { type: 'array', array: { subtype: { type: 'integer', integer: {} }, reducers: [] } }),
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

const base = (objectType: string) => ({ type: 'base', objectType });

const engagement = (
  engagementId: string,
  accountId: string,
  title: string,
  amount: number,
  status: string,
  createdAt: string,
): ObjectRow => ({
  engagementId,
  accountId,
  title,
  amount,
  status,
  createdAt,
});

const TEXT_ENGAGEMENTS = [
  ...SEED_ENGAGEMENTS,
  engagement('p-e-dur', 'p-t-words', 'Duration probe', 1, 'open', '2026-10-17T19:22:25.573Z'),
];

const SEARCHABLE_ENGAGEMENTS = [
  ...SEED_ENGAGEMENTS,
  engagement('p-n-e', 'p-n-1', 'Duration probe', 1, 'open', '2026-10-17T22:36:37.569Z'),
];

const EDGES: readonly ObjectRow[] = [
  { accountId: 'e-1', name: 'Edge 1', seenAt: '2025-12-31T23:59:59.999Z', signedOn: '2025-12-31' },
  { accountId: 'e-2', name: 'Edge 2', seenAt: '2026-09-30T23:59:59.999Z', signedOn: '2026-09-30' },
  { accountId: 'e-3', name: 'Edge 3', seenAt: '2026-10-01T00:00:00Z', signedOn: '2026-10-01' },
  { accountId: 'e-4', name: 'Edge 4', seenAt: '2026-10-11T23:59:59.999Z', signedOn: '2026-10-11' },
  { accountId: 'e-5', name: 'Edge 5', seenAt: '2026-10-12T00:00:00Z', signedOn: '2026-10-12' },
];

const NUMBERS: readonly ObjectRow[] = [
  { accountId: 'r-1', name: 'Range 1', seats: 9, rate: 1.5, price: '99.99' },
  { accountId: 'r-2', name: 'Range 2', seats: 10, rate: 2.5, price: '100.00' },
  { accountId: 'r-3', name: 'Range 3', seats: 20, rate: 4, price: '150.25' },
  { accountId: 'r-4', name: 'Range 4', seats: 20, rate: 5.25, price: '200.49' },
  { accountId: 'r-5', name: 'Range 5', seats: 25, rate: -0.5, price: '200.50' },
  { accountId: 'r-6', name: 'Range 6', seats: -5 },
  { accountId: 'r-7', name: 'Range 7' },
];

const UNNAMED_METRICS = [{ type: 'count' }, { type: 'min', field: 'createdAt' }, { type: 'max', field: 'createdAt' }];

const NAMED_METRICS = [
  { type: 'count', name: 'count' },
  { type: 'min', field: 'createdAt', name: 'min' },
  { type: 'max', field: 'createdAt', name: 'max' },
];

function counts(field: string, groups: readonly (readonly [unknown, number])[]) {
  return groups.map(([key, count]) => ({ group: { [field]: key }, metrics: [{ name: 'count', value: count }] }));
}

const ALL_TEXT_METRICS = [
  { name: 'max_createdAt', value: '2026-10-17T19:22:25.573Z' },
  { name: 'min_createdAt', value: '2026-10-17T18:20:05.687Z' },
  { name: 'count', value: 8 },
];

const ALL_SEARCHABLE_METRICS = [
  { name: 'count', value: 8 },
  { name: 'max', value: '2026-10-17T22:36:37.569Z' },
  { name: 'min', value: '2026-10-17T18:20:05.687Z' },
];

const TEXT_RULES =
  'ontology/ontology-sdk/aggregations#group-bys ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#response';

const SEARCHABLE_RULES =
  'ontology/ontology-sdk/aggregations#group-bys ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#response';

describe('duration group-bys', () => {
  it.each([
    [
      TEXT_RULES,
      1,
      'HOURS',
      [
        {
          group: { createdAt: '2026-10-17T18:00:00Z' },
          metrics: [
            { name: 'max_createdAt', value: '2026-10-17T18:20:08.937Z' },
            { name: 'min_createdAt', value: '2026-10-17T18:20:05.687Z' },
            { name: 'count', value: 7 },
          ],
        },
        {
          group: { createdAt: '2026-10-17T19:00:00Z' },
          metrics: [
            { name: 'max_createdAt', value: '2026-10-17T19:22:25.573Z' },
            { name: 'min_createdAt', value: '2026-10-17T19:22:25.573Z' },
            { name: 'count', value: 1 },
          ],
        },
      ],
    ],
    [TEXT_RULES, 1, 'DAYS', [{ group: { createdAt: '2026-10-17T00:00:00Z' }, metrics: ALL_TEXT_METRICS }]],
    [
      `${TEXT_RULES} ontology/ontology-sdk/aggregations#group-bys`,
      3,
      'DAYS',
      [{ group: { createdAt: '2026-10-16T00:00:00Z' }, metrics: ALL_TEXT_METRICS }],
    ],
    [TEXT_RULES, 1, 'WEEKS', [{ group: { createdAt: '2026-10-12T00:00:00Z' }, metrics: ALL_TEXT_METRICS }]],
    [TEXT_RULES, 1, 'MONTHS', [{ group: { createdAt: '2026-10-01T00:00:00Z' }, metrics: ALL_TEXT_METRICS }]],
    [TEXT_RULES, 1, 'QUARTERS', [{ group: { createdAt: '2026-10-01T00:00:00Z' }, metrics: ALL_TEXT_METRICS }]],
    [TEXT_RULES, 1, 'YEARS', [{ group: { createdAt: '2026-01-01T00:00:00Z' }, metrics: ALL_TEXT_METRICS }]],
  ])(
    '%s: a duration group-by of %i %s on createdAt, with metrics that have no name',
    async (_rules, value, unit, data) => {
      await insertObjects(service.db, ENGAGEMENT, TEXT_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        aggregation: UNNAMED_METRICS,
        groupBy: [{ type: 'duration', field: 'createdAt', value, unit }],
      });

      expectAggregate(answer, { status: 200, body: { excludedItems: 0, accuracy: 'ACCURATE', data } });
    },
  );

  it.each([
    ['WEEKS 2', 2, 'WEEKS'],
    ['MONTHS 3', 3, 'MONTHS'],
    ['QUARTERS 2', 2, 'QUARTERS'],
    ['YEARS 2', 2, 'YEARS'],
  ])(
    'ontology/ontology-sdk/aggregations#group-bys service/http-api#errors: %s gets 400 InvalidDurationGroupByValue with empty parameters',
    async (_case, value, unit) => {
      await insertObjects(service.db, ENGAGEMENT, TEXT_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        aggregation: UNNAMED_METRICS,
        groupBy: [{ type: 'duration', field: 'createdAt', value, unit }],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidDurationGroupByValue', parameters: {} },
      });
    },
  );

  it.each([
    [7, 'DAYS', [{ group: { createdAt: '2026-10-15T00:00:00Z' }, metrics: ALL_SEARCHABLE_METRICS }]],
    [2, 'DAYS', [{ group: { createdAt: '2026-10-16T00:00:00Z' }, metrics: ALL_SEARCHABLE_METRICS }]],
    [6, 'HOURS', [{ group: { createdAt: '2026-10-17T18:00:00Z' }, metrics: ALL_SEARCHABLE_METRICS }]],
    [
      7,
      'HOURS',
      [
        {
          group: { createdAt: '2026-10-17T15:00:00Z' },
          metrics: [
            { name: 'count', value: 7 },
            { name: 'max', value: '2026-10-17T18:20:08.937Z' },
            { name: 'min', value: '2026-10-17T18:20:05.687Z' },
          ],
        },
        {
          group: { createdAt: '2026-10-17T22:00:00Z' },
          metrics: [
            { name: 'count', value: 1 },
            { name: 'max', value: '2026-10-17T22:36:37.569Z' },
            { name: 'min', value: '2026-10-17T22:36:37.569Z' },
          ],
        },
      ],
    ],
    [5, 'HOURS', [{ group: { createdAt: '2026-10-17T18:00:00Z' }, metrics: ALL_SEARCHABLE_METRICS }]],
  ])(
    `${SEARCHABLE_RULES}: a duration group-by of %i %s on createdAt starts each range at a multiple of its length after 1970-01-01`,
    async (value, unit, data) => {
      await insertObjects(service.db, ENGAGEMENT, SEARCHABLE_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        aggregation: NAMED_METRICS,
        groupBy: [{ type: 'duration', field: 'createdAt', value, unit }],
      });

      expectAggregate(answer, { status: 200, body: { excludedItems: 0, accuracy: 'ACCURATE', data } });
    },
  );
});

describe('the duration group-by', () => {
  it('ontology/ontology-sdk/aggregations#group-bys: a duration group-by of 7 minutes gives only the 2 ranges that have Objects', async () => {
    await insertObjects(service.db, ENGAGEMENT, SEARCHABLE_ENGAGEMENTS);

    const answer = await service.aggregate({
      objectSet: base(ENGAGEMENT),
      aggregation: NAMED_METRICS,
      groupBy: [{ type: 'duration', field: 'createdAt', value: 7, unit: 'MINUTES' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: { createdAt: '2026-10-17T18:16:00Z' },
            metrics: [
              { name: 'count', value: 7 },
              { name: 'max', value: '2026-10-17T18:20:08.937Z' },
              { name: 'min', value: '2026-10-17T18:20:05.687Z' },
            ],
          },
          {
            group: { createdAt: '2026-10-17T22:35:00Z' },
            metrics: [
              { name: 'count', value: 1 },
              { name: 'max', value: '2026-10-17T22:36:37.569Z' },
              { name: 'min', value: '2026-10-17T22:36:37.569Z' },
            ],
          },
        ],
      },
    });
  });

  it.each([
    [
      9,
      'SECONDS',
      [
        ['2026-10-17T18:19:57Z', 3],
        ['2026-10-17T18:20:06Z', 4],
      ],
    ],
    [
      7,
      'MILLISECONDS',
      [
        ['2026-10-17T18:20:05.686Z', 1],
        ['2026-10-17T18:20:05.833Z', 1],
        ['2026-10-17T18:20:05.987Z', 1],
        ['2026-10-17T18:20:06.134Z', 1],
        ['2026-10-17T18:20:06.281Z', 1],
        ['2026-10-17T18:20:06.435Z', 1],
        ['2026-10-17T18:20:08.934Z', 1],
      ],
    ],
  ] as const)(
    'ontology/ontology-sdk/aggregations#group-bys: a duration group-by of %i %s starts each range at a multiple of its length after 1970-01-01',
    async (value, unit, groups) => {
      await insertObjects(service.db, ENGAGEMENT, SEED_ENGAGEMENTS);

      const answer = await service.aggregate({
        objectSet: base(ENGAGEMENT),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [{ type: 'duration', field: 'createdAt', value, unit }],
      });

      expectAggregate(answer, {
        status: 200,
        body: { excludedItems: 0, accuracy: 'ACCURATE', data: counts('createdAt', groups) },
      });
    },
  );

  it.each([
    [
      'DAYS',
      [
        ['2025-12-31T00:00:00Z', 1],
        ['2026-09-30T00:00:00Z', 1],
        ['2026-10-01T00:00:00Z', 1],
        ['2026-10-11T00:00:00Z', 1],
        ['2026-10-12T00:00:00Z', 1],
      ],
    ],
    [
      'WEEKS',
      [
        ['2025-12-29T00:00:00Z', 1],
        ['2026-09-28T00:00:00Z', 2],
        ['2026-10-05T00:00:00Z', 1],
        ['2026-10-12T00:00:00Z', 1],
      ],
    ],
    [
      'MONTHS',
      [
        ['2025-12-01T00:00:00Z', 1],
        ['2026-09-01T00:00:00Z', 1],
        ['2026-10-01T00:00:00Z', 3],
      ],
    ],
    [
      'QUARTERS',
      [
        ['2025-10-01T00:00:00Z', 1],
        ['2026-07-01T00:00:00Z', 1],
        ['2026-10-01T00:00:00Z', 3],
      ],
    ],
    [
      'YEARS',
      [
        ['2025-01-01T00:00:00Z', 1],
        ['2026-01-01T00:00:00Z', 4],
      ],
    ],
  ] as const)(
    'ontology/ontology-sdk/aggregations#group-bys: a duration group-by of 1 %s on the Timestamp seenAt and on the Date signedOn starts each range in UTC, and keys it with a Timestamp string',
    async (unit, groups) => {
      await insertObjects(service.db, ACCOUNT, EDGES);

      for (const field of ['seenAt', 'signedOn']) {
        const answer = await service.aggregate({
          objectSet: base(ACCOUNT),
          aggregation: [{ type: 'count', name: 'count' }],
          groupBy: [{ type: 'duration', field, value: 1, unit }],
        });

        expectAggregate(answer, {
          status: 200,
          body: { excludedItems: 0, accuracy: 'ACCURATE', data: counts(field, groups) },
        });
      }
    },
  );

  it('ontology/ontology-sdk/aggregations#response ontology/ontology-sdk/aggregations#metrics ontology/ontology-sdk/aggregations#group-bys: min and max of the Date signedOn in a duration group-by of 1 month are date strings', async () => {
    await insertObjects(service.db, ACCOUNT, EDGES);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      aggregation: [
        { type: 'count', name: 'count' },
        { type: 'min', field: 'signedOn', name: 'signedOn.min' },
        { type: 'max', field: 'signedOn', name: 'signedOn.max' },
      ],
      groupBy: [{ type: 'duration', field: 'signedOn', value: 1, unit: 'MONTHS' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [
          {
            group: { signedOn: '2025-12-01T00:00:00Z' },
            metrics: [
              { name: 'count', value: 1 },
              { name: 'signedOn.min', value: '2025-12-31' },
              { name: 'signedOn.max', value: '2025-12-31' },
            ],
          },
          {
            group: { signedOn: '2026-09-01T00:00:00Z' },
            metrics: [
              { name: 'count', value: 1 },
              { name: 'signedOn.min', value: '2026-09-30' },
              { name: 'signedOn.max', value: '2026-09-30' },
            ],
          },
          {
            group: { signedOn: '2026-10-01T00:00:00Z' },
            metrics: [
              { name: 'count', value: 3 },
              { name: 'signedOn.min', value: '2026-10-01' },
              { name: 'signedOn.max', value: '2026-10-12' },
            ],
          },
        ],
      },
    });
  });

  it.each([
    [
      7,
      'DAYS',
      [
        ['1969-12-25T00:00:00Z', 1],
        ['1970-01-01T00:00:00Z', 1],
      ],
    ],
    [
      5,
      'HOURS',
      [
        ['1969-12-31T09:00:00Z', 1],
        ['1970-01-01T10:00:00Z', 1],
      ],
    ],
  ] as const)(
    'ontology/ontology-sdk/aggregations#group-bys: a duration group-by of %i %s puts a Timestamp before 1970 in the range that starts at the multiple below it',
    async (value, unit, groups) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'b-1', name: 'Before 1970', seenAt: '1969-12-31T12:00:00Z' },
        { accountId: 'b-2', name: 'After 1970', seenAt: '1970-01-01T12:00:00Z' },
      ]);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [{ type: 'duration', field: 'seenAt', value, unit }],
      });

      expectAggregate(answer, {
        status: 200,
        body: { excludedItems: 0, accuracy: 'ACCURATE', data: counts('seenAt', groups) },
      });
    },
  );

  it.each([
    ['1 hour on the Date signedOn', 'signedOn', 1, 'HOURS'],
    ['0 days on the Timestamp seenAt', 'seenAt', 0, 'DAYS'],
    ['1,000,001 days on the Timestamp seenAt', 'seenAt', 1_000_001, 'DAYS'],
    ['2,147,483,647 days on the Timestamp seenAt', 'seenAt', 2_147_483_647, 'DAYS'],
  ])(
    'ontology/ontology-sdk/aggregations#group-bys: a duration group-by of %s gets 400 InvalidDurationGroupByValue',
    async (_case, field, value, unit) => {
      await insertObjects(service.db, ACCOUNT, EDGES);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [{ type: 'duration', field, value, unit }],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidDurationGroupByValue', parameters: {} },
      });
    },
  );
});

describe('the longest duration', () => {
  it('ontology/ontology-sdk/aggregations#group-bys: a duration group-by of 1,000,000 days puts each Object after 1970 in the range from 1970-01-01', async () => {
    await insertObjects(service.db, ACCOUNT, EDGES);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      aggregation: [{ type: 'count', name: 'count' }],
      groupBy: [{ type: 'duration', field: 'seenAt', value: 1_000_000, unit: 'DAYS' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: { excludedItems: 0, accuracy: 'ACCURATE', data: counts('seenAt', [['1970-01-01T00:00:00Z', 5]]) },
    });
  });
});

describe('the fixedWidth group-by', () => {
  it.each([
    [
      'the Integer seats',
      'seats',
      10,
      [
        [-10, 1],
        [0, 1],
        [10, 1],
        [20, 3],
      ],
    ],
    [
      'the Double rate',
      'rate',
      2.5,
      [
        [-2.5, 1],
        [0, 1],
        [2.5, 2],
        [5, 1],
      ],
    ],
  ] as const)(
    'ontology/ontology-sdk/aggregations#group-bys: a fixedWidth group-by of %s gives 1 range for each multiple of the width that has Objects, keyed by its start',
    async (_case, field, fixedWidth, groups) => {
      await insertObjects(service.db, ACCOUNT, NUMBERS);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [{ type: 'fixedWidth', field, fixedWidth }],
      });

      expectAggregate(answer, {
        status: 200,
        body: { excludedItems: 0, accuracy: 'ACCURATE', data: counts(field, groups) },
      });
    },
  );
});

describe('the ranges group-by', () => {
  it('ontology/ontology-sdk/aggregations#group-bys: a ranges group-by of the Integer seats includes the start of each range and excludes its end', async () => {
    await insertObjects(service.db, ACCOUNT, NUMBERS);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      aggregation: [{ type: 'count', name: 'count' }],
      groupBy: [
        {
          type: 'ranges',
          field: 'seats',
          ranges: [
            { startValue: 0, endValue: 10 },
            { startValue: 10, endValue: 20 },
            { startValue: 20, endValue: 30 },
            { startValue: 15, endValue: 25 },
            { startValue: 100, endValue: 200 },
          ],
        },
      ],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: counts('seats', [
          [{ startValue: 0, endValue: 10 }, 1],
          [{ startValue: 10, endValue: 20 }, 1],
          [{ startValue: 20, endValue: 30 }, 3],
          [{ startValue: 15, endValue: 25 }, 2],
        ]),
      },
    });
  });

  it.each([
    ['the Timestamp seenAt', 'seenAt', '2026-10-01T00:00:00Z', '2026-10-12T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['the Date signedOn', 'signedOn', '2026-10-01', '2026-10-12', '2027-01-01'],
  ])(
    'ontology/ontology-sdk/aggregations#group-bys: a ranges group-by of %s includes the start of each range and excludes its end',
    async (_case, field, start, edge, end) => {
      await insertObjects(service.db, ACCOUNT, EDGES);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [
          {
            type: 'ranges',
            field,
            ranges: [
              { startValue: start, endValue: edge },
              { startValue: edge, endValue: end },
            ],
          },
        ],
      });

      expectAggregate(answer, {
        status: 200,
        body: {
          excludedItems: 0,
          accuracy: 'ACCURATE',
          data: counts(field, [
            [{ startValue: start, endValue: edge }, 2],
            [{ startValue: edge, endValue: end }, 1],
          ]),
        },
      });
    },
  );
});

describe('the ranges group-by of a Decimal', () => {
  it.each([
    ['numbers', 100, 200.5],
    ['strings', '1e2', '200.50'],
  ])(
    'ontology/ontology-sdk/aggregations#group-bys ontology/object-link-types/properties#base-types: a ranges group-by of the Decimal price, with bounds sent as %s, keys the range by its bounds as exact strings in the plain form',
    async (_case, startValue, endValue) => {
      await insertObjects(service.db, ACCOUNT, NUMBERS);

      const answer = await service.aggregate({
        objectSet: base(ACCOUNT),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [{ type: 'ranges', field: 'price', ranges: [{ startValue, endValue }] }],
      });

      expectAggregate(answer, {
        status: 200,
        body: {
          excludedItems: 0,
          accuracy: 'ACCURATE',
          data: counts('price', [[{ startValue: '100', endValue: '200.5' }, 3]]),
        },
      });
    },
  );
});

describe('the range group-bys that a Property or a value does not take', () => {
  it.each([
    [
      'ontology/ontology-sdk/aggregations#group-bys',
      'a fixedWidth group-by of the String name gets 400 InvalidPropertyType',
      { type: 'fixedWidth', field: 'name', fixedWidth: 10 },
      {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyType',
        parameters: { property: 'name', propertyBaseType: 'String' },
      },
    ],
    [
      'ontology/ontology-sdk/aggregations#group-bys',
      'a fixedWidth group-by with the width 0 gets 400 Default:InvalidArgument',
      { type: 'fixedWidth', field: 'seats', fixedWidth: 0 },
      { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { field: 'groupBy' } },
    ],
    [
      'ontology/ontology-sdk/aggregations#group-bys',
      'a duration group-by of the Integer seats gets 400 InvalidPropertyType',
      { type: 'duration', field: 'seats', value: 1, unit: 'DAYS' },
      {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyType',
        parameters: { property: 'seats', propertyBaseType: 'Integer' },
      },
    ],
    [
      'ontology/ontology-sdk/aggregations#group-bys',
      'a ranges group-by of the Integer seats with a String start value gets 400 InvalidPropertyValue',
      { type: 'ranges', field: 'seats', ranges: [{ startValue: 'ten', endValue: 20 }] },
      {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyValue',
        parameters: { property: 'seats', propertyBaseType: 'Integer', propertyValue: 'ten' },
      },
    ],
    [
      'ontology/ontology-sdk/aggregations#group-bys ontology/object-link-types/properties#base-types',
      'a ranges group-by of the Decimal price with the start value "1e999999", over the exponent cap, gets 400 InvalidPropertyValue',
      { type: 'ranges', field: 'price', ranges: [{ startValue: '1e999999', endValue: 200 }] },
      {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyValue',
        parameters: { property: 'price', propertyBaseType: 'Decimal', propertyValue: '1e999999' },
      },
    ],
  ])('%s: %s', async (_rule, _case, groupBy, body) => {
    await insertObjects(service.db, ACCOUNT, NUMBERS);

    const answer = await service.aggregate({
      objectSet: base(ACCOUNT),
      aggregation: [{ type: 'count', name: 'count' }],
      groupBy: [groupBy],
    });

    expect(errorAnswer(answer)).toEqual({ status: 400, body });
  });

  it.each([
    [
      'a fixedWidth group-by of the Integer array scores',
      ACCOUNT,
      { type: 'fixedWidth', field: 'scores', fixedWidth: 10 },
      'scores',
      'Array<Integer>',
    ],
    [
      'a ranges group-by of the Integer array scores',
      ACCOUNT,
      { type: 'ranges', field: 'scores', ranges: [{ startValue: 0, endValue: 10 }] },
      'scores',
      'Array<Integer>',
    ],
    [
      'a duration group-by of the struct Property relationship',
      STRUCT_PROBE,
      { type: 'duration', field: 'relationship', value: 1, unit: 'DAYS' },
      'relationship',
      'Struct',
    ],
    [
      'a ranges group-by of the struct Property relationship',
      STRUCT_PROBE,
      { type: 'ranges', field: 'relationship', ranges: [{ startValue: 0, endValue: 10 }] },
      'relationship',
      'Struct',
    ],
  ])(
    'ontology/ontology-sdk/aggregations#group-bys: %s gets 400 InvalidPropertyType',
    async (_case, objectType, groupBy, property, propertyBaseType) => {
      const answer = await service.aggregate({
        objectSet: base(objectType),
        aggregation: [{ type: 'count', name: 'count' }],
        groupBy: [groupBy],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPropertyType',
          parameters: { property, propertyBaseType },
        },
      });
    },
  );
});
