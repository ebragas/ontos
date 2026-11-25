import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ONTOLOGY_RID,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from './actions/actions.test-utils.ts';
import {
  addDecimalProbe,
  CREATE_DECIMAL_PROBE,
  DECIMAL_PROBE,
  DELETE_DECIMAL_PROBE,
  EDIT_COUNTS,
  MODIFY_DECIMAL_PROBE,
  numberPaths,
} from './decimalProbe.test-utils.ts';

const REQUESTS = 'service/http-api#requests';
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const RETURN_EDITS = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL' };

const DEC_1 = {
  accountId: 'dec-1',
  name: 'Probe 1',
  amount: 1299.9,
  amounts: [1.5, 2],
  line: { sku: 'A-1', unitPrice: 12.5 },
};

const DEC_2 = {
  accountId: 'dec-2',
  name: 'Probe 2',
  amount: 0.01,
  amounts: [0.25],
  line: { sku: 'B-2', unitPrice: 3 },
};

const DEC_3 = { accountId: 'dec-3', name: 'Probe 3', amount: 10.5, amounts: [1], line: { sku: 'C-3', unitPrice: 0.5 } };
const DEC_3_MODIFIED = { amount: 20.25, amounts: [3.5, 4], line: { sku: 'C-3', unitPrice: 1.75 } };
const PADDED_1 = { amount: '1299.90', amounts: ['1.50', '2.00'], line: { sku: 'A-1', unitPrice: '12.5000' } };
const PADDED_2 = { amount: '0.01', amounts: ['0.25'], line: { sku: 'B-2', unitPrice: '3.0000' } };

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

let service: ActionsService;
let applied: Answer[];
let changed: Answer[];

beforeAll(async () => {
  service = await startActions(addDecimalProbe(twinIr('0.6.3')), twinFunctions('0.6.3'));

  const apply = (parameters: object) =>
    post(`actions/${CREATE_DECIMAL_PROBE}/apply`, { parameters, options: RETURN_EDITS });

  applied = [await apply(DEC_1), await apply(DEC_2)];

  await apply(DEC_3);

  const change = (action: string, parameters: object) =>
    post(`actions/${action}/apply`, {
      parameters: { obj: 'dec-3', ...parameters },
      options: { ...RETURN_EDITS, returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

  changed = [await change(MODIFY_DECIMAL_PROBE, DEC_3_MODIFIED), await change(DELETE_DECIMAL_PROBE, {})];
});

afterAll(() => service?.stop());

async function post(path: string, body: unknown): Promise<Answer> {
  const answer = await service.call('POST', `${ONTOLOGY}/${path}`, body);

  return { status: answer.status, body: JSON.parse(answer.text) };
}

it(`${REQUESTS}: apply with returnEdits gives no Decimal, and no JSON number except the edit counts`, () => {
  const added = (primaryKey: string) => ({
    status: 200,
    body: { edits: { edits: [{ type: 'addObject', primaryKey, objectType: DECIMAL_PROBE }] } },
  });

  expect(applied).toMatchObject([added('dec-1'), added('dec-2')]);
  expect(applied.map(({ body }) => numberPaths(body))).toEqual([EDIT_COUNTS, EDIT_COUNTS]);

  expect(changed).toMatchObject([
    {
      status: 200,
      body: { edits: { edits: [{ type: 'modifyObject', primaryKey: 'dec-3', objectType: DECIMAL_PROBE }] } },
    },
    {
      status: 200,
      body: { edits: { edits: [{ type: 'deleteObject', primaryKey: 'dec-3', objectType: DECIMAL_PROBE }] } },
    },
  ]);

  expect(changed.map(({ body }) => numberPaths(body))).toEqual([EDIT_COUNTS, EDIT_COUNTS]);
});

it(`${REQUESTS}: loadObjects gives each scalar, array, struct, and derived Decimal as a padded string, and no JSON number`, async () => {
  const amount = { type: 'property', apiName: 'amount' };

  const answer = await post('objectSets/loadObjects', {
    objectSet: {
      type: 'withProperties',
      objectSet: { type: 'base', objectType: DECIMAL_PROBE },
      derivedProperties: { doubled: { type: 'add', properties: [amount, amount] } },
    },
    select: ['accountId', 'amount', 'amounts', 'line', 'doubled'],
    orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    excludeRid: true,
  });

  expect(answer.status).toBe(200);

  expect(answer.body).toMatchObject({
    data: [
      { accountId: 'dec-1', ...PADDED_1, doubled: '2599.80' },
      { accountId: 'dec-2', ...PADDED_2, doubled: '0.02' },
    ],
  });

  expect(numberPaths(answer.body)).toEqual([]);
});

it(`${REQUESTS}: aggregate gives sum, avg, min, and max of a Decimal as exact strings, and only the counts as JSON numbers`, async () => {
  const answer = await post('objectSets/aggregate', {
    objectSet: { type: 'base', objectType: DECIMAL_PROBE },
    groupBy: [],
    aggregation: [
      ...['sum', 'avg', 'min', 'max', 'exactDistinct', 'approximateDistinct'].map((type) => ({
        type,
        field: 'amount',
        name: type,
      })),
      { type: 'count', name: 'count' },
    ],
  });

  expect(answer.status).toBe(200);

  expect(answer.body).toMatchObject({
    data: [
      {
        metrics: [
          { name: 'sum', value: '1299.91' },
          { name: 'avg', value: '649.96' },
          { name: 'min', value: '0.01' },
          { name: 'max', value: '1299.90' },
          { name: 'exactDistinct', value: 2 },
          { name: 'approximateDistinct', value: 2 },
          { name: 'count', value: 2 },
        ],
      },
    ],
  });

  expect(numberPaths(answer.body)).toEqual([
    'data.0.metrics.4.value',
    'data.0.metrics.5.value',
    'data.0.metrics.6.value',
  ]);
});

it.each<[string, object, object[]]>([
  ['an exact', { type: 'exact', field: 'amount' }, [{ amount: '0.01' }, { amount: '1299.90' }]],
  [
    'a ranges',
    {
      type: 'ranges',
      field: 'amount',
      ranges: [
        { startValue: 0, endValue: 1000.5 },
        { startValue: 1000.5, endValue: 2000 },
      ],
    },
    [{ amount: { startValue: '0', endValue: '1000.5' } }, { amount: { startValue: '1000.5', endValue: '2000' } }],
  ],
])(
  `${REQUESTS} ontology/ontology-sdk/aggregations#group-bys: aggregate gives %s group key, and the sum and avg of each group, of a Decimal as exact strings`,
  async (_case, groupBy, groups) => {
    const aggregation = [
      { type: 'count', name: 'count' },
      ...['sum', 'avg'].map((type) => ({ type, field: 'amount', name: type })),
    ];

    const answer = await post('objectSets/aggregate', {
      objectSet: { type: 'base', objectType: DECIMAL_PROBE },
      groupBy: [groupBy],
      aggregation,
    });

    expect(answer.status).toBe(200);

    const data = (answer.body as { data: { group: unknown }[] }).data;

    const metrics = (amount: string) => [
      { name: 'count', value: 1 },
      { name: 'sum', value: amount },
      { name: 'avg', value: amount },
    ];

    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: groups[0], metrics: metrics('0.01') }),
        expect.objectContaining({ group: groups[1], metrics: metrics('1299.90') }),
      ]),
    );

    expect(numberPaths(answer.body)).toEqual(['data.0.metrics.0.value', 'data.1.metrics.0.value', 'excludedItems']);
  },
);

it.each([
  ['dec-1', { name: 'Probe 1', ...PADDED_1 }],
  ['dec-2', { name: 'Probe 2', ...PADDED_2 }],
])(
  `${REQUESTS}: Object Edit History gives each Decimal of the create of %s as a padded string, and no JSON number except totalCount`,
  async (accountId, properties) => {
    const answer = await service.editsHistory(DECIMAL_PROBE, { objectPrimaryKey: { accountId } });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ data: [{ edit: { type: 'createEdit', properties } }] });
    expect(numberPaths(answer.body)).toEqual(['totalCount']);
  },
);

it(`${REQUESTS}: Object Edit History gives each Decimal of a modify and a delete entry as a padded string, and no JSON number except totalCount`, async () => {
  const answer = await service.editsHistory(DECIMAL_PROBE, { objectPrimaryKey: { accountId: 'dec-3' } });

  expect(answer.status).toBe(200);

  const created = { amount: '10.50', amounts: ['1.00'], line: { sku: 'C-3', unitPrice: '0.5000' } };
  const modified = { amount: '20.25', amounts: ['3.50', '4.00'], line: { sku: 'C-3', unitPrice: '1.7500' } };

  expect((answer.body as { data: { edit: unknown }[] }).data.map(({ edit }) => edit)).toEqual(
    expect.arrayContaining([
      { type: 'deleteEdit', previousProperties: { accountId: 'dec-3', name: 'Probe 3', ...modified } },
      { type: 'modifyEdit', properties: modified, previousProperties: created, includesAllPreviousValues: false },
      { type: 'createEdit', properties: { name: 'Probe 3', ...created } },
    ]),
  );

  expect(numberPaths(answer.body)).toEqual(['totalCount']);
});
