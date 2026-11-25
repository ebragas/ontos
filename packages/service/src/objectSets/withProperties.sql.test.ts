import { createClient, getWireObjectSet, type ObjectTypeDefinition } from '@osdk/client';
import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  insertObjects,
  poolDb,
  startActions,
  type ActionsService,
  type ObjectRow,
} from '../actions/actions.test-utils.ts';
import type { Sql } from '../db/index.ts';
import { groupGrants } from '../policiesPeople.test-utils.ts';
import {
  ACCOUNT,
  addString,
  addTyped,
  at,
  CATEGORY,
  datasourceOf,
  derivedIr,
  ENGAGEMENT,
  INVOICE,
  type Json,
  ONTOLOGY,
  PEOPLE,
  type Person,
  ROLE_ASSIGNMENT,
  ROLES,
  TRANSACTION,
} from './derived.test-utils.ts';

const READS = 'ontology/object-link-types/derived-properties#reads';
const OPERATIONS = 'ontology/object-link-types/derived-properties#operations';
const TYPES = 'ontology/object-link-types/derived-properties#types';
const LIMITS = 'ontology/object-link-types/derived-properties#limits';
const SECURITY = 'ontology/object-link-types/derived-properties#security';
const ERRORS = 'service/http-api#errors';
const COST = 'ontology/object-link-types/derived-properties#cost';

function requestIr(): OntologyIr {
  const ir: Json = JSON.parse(JSON.stringify(derivedIr()));
  const block = (objectType: string) => at(ir, 'ontology', 'objectTypes', objectType);

  for (const objectType of [ACCOUNT, TRANSACTION, ENGAGEMENT, INVOICE]) addString(block(objectType), 'status');

  const column = (objectType: string, apiName: string, type: Json, template: string) => {
    addTyped(block(objectType), apiName, type, at(block(objectType), 'objectType', 'propertyTypes', template));

    at(datasourceOf(block(objectType), 'datasetV2'), 'propertyMapping')[apiName] = { type: 'column', column: apiName };
  };

  column(TRANSACTION, 'rate', { type: 'double', double: {} }, 'amount');

  column(TRANSACTION, 'fee', { type: 'decimal', decimal: { precision: 10, scale: 1 } }, 'amount');

  column(CATEGORY, 'budget', { type: 'decimal', decimal: { precision: 18, scale: 2 } }, 'name');

  const groups = (objectType: string) =>
    at(datasourceOf(block(objectType), 'datasetV2'), 'propertySecurityGroups')['groups'] as Json[];

  const secure = (objectType: string, ...names: string[]) => {
    const [first] = groups(objectType);

    if (!first) throw new Error(`The derived IR has no policy group on ${objectType}.`);

    (first['properties'] as string[]).push(...names);
  };

  secure(TRANSACTION, 'status', 'rate', 'fee');

  secure(ENGAGEMENT, 'status');

  return JSON.parse(JSON.stringify(ir)) as OntologyIr;
}

const IR = requestIr();
const GRANTS = groupGrants(IR, ROLES);
const grants = { ...GRANTS, objectTypes: { ...GRANTS.objectTypes, [CATEGORY]: 'admin', [ROLE_ASSIGNMENT]: 'admin' } };

type Db = ActionsService['db'];

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(IR, undefined, grants);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seed();
});

const mine = { owner: 'user_two', amountViewer: 'user_two' };

async function seed(): Promise<void> {
  await insertObjects(service.db, ACCOUNT, [
    { accountId: 'acc-1', name: 'Acme', entity: 'E1', status: 'pending' },
    { accountId: 'acc-2', name: 'Globex', entity: 'E2', status: 'cleared' },
    { accountId: 'acc-3', name: 'Initech', entity: 'E3', status: 'cleared' },
  ]);

  await insertObjects(service.db, TRANSACTION, [
    {
      transactionId: 'tx-1',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      amount: '100.00',
      status: 'cleared',
      postedOn: '2026-01-10',
      postedAt: '2026-03-31T23:30:00Z',
      units: 2,
      rate: 1.5,
      fee: '0.5',
      ...mine,
    },
    {
      transactionId: 'tx-2',
      accountId: 'acc-1',
      categoryId: 'cat-1',
      amount: '20.50',
      status: 'pending',
      postedOn: '2026-02-15',
      units: 3,
      rate: 2.5,
      owner: 'user_two',
      amountViewer: '',
    },
    {
      transactionId: 'tx-3',
      accountId: 'acc-1',
      categoryId: 'cat-2',
      amount: '5.25',
      status: 'cleared',
      postedOn: '2026-03-01',
      units: 5,
      owner: 'user_x',
      amountViewer: 'user_x',
    },
    {
      transactionId: 'tx-4',
      accountId: 'acc-2',
      categoryId: 'cat-2',
      amount: '7.00',
      status: 'pending',
      postedOn: '2026-01-20',
      units: 0,
      rate: 2,
      ...mine,
    },
    {
      transactionId: 'tx-5',
      accountId: 'acc-2',
      categoryId: 'cat-2',
      amount: '1.25',
      status: 'cleared',
      postedOn: '2026-04-02',
      units: 4,
      ...mine,
    },
  ]);

  await insertObjects(service.db, CATEGORY, [
    { categoryId: 'cat-1', name: 'Food', entity: 'C1', budget: '150.00' },
    { categoryId: 'cat-2', name: 'Rent', entity: 'C2', budget: '10.00' },
    { categoryId: 'cat-3', name: 'Misc', entity: 'C3', budget: '50.00' },
  ]);

  await insertObjects(service.db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'Build', status: 'active', owner: 'user_two' },
    { engagementId: 'eng-2', accountId: 'acc-1', title: 'Run', status: 'closed', owner: 'user_two' },
    { engagementId: 'eng-3', accountId: 'acc-2', title: 'Plan', status: 'closed', owner: 'user_two' },
    { engagementId: 'eng-4', accountId: 'acc-3', title: 'Ship', status: 'active', owner: 'user_x' },
  ]);

  await insertObjects(service.db, INVOICE, [
    { invoiceId: 'inv-1', engagementId: 'eng-1', total: '10.00', status: 'pending' },
    { invoiceId: 'inv-2', engagementId: 'eng-1', total: '20.00', status: 'cleared' },
    { invoiceId: 'inv-3', engagementId: 'eng-3', total: '30.00', status: 'cleared' },
  ]);
}

function recording(): { db: Db; statements: Sql[] } {
  const statements: Sql[] = [];

  const db: Db = {
    query: (sql) => service.db.query(sql),
    stream: (sql) => {
      statements.push(sql);

      return service.db.stream(sql);
    },
    transaction: (run) => service.db.transaction(run),
    snapshot: (run) => service.db.snapshot(run),
  };

  return { db, statements };
}

type Row = Record<string, unknown>;

interface Page {
  readonly data: Row[];
  readonly totalCount: string;
  readonly nextPageToken?: string;
}

async function post(
  path: string,
  body: object | string,
  person: Person,
  db?: Db,
): Promise<{ status: number; body: unknown }> {
  const answer = await service.call(
    'POST',
    `${ONTOLOGY}/${path}`,
    body,
    db ? { ...PEOPLE[person], db } : PEOPLE[person],
  );

  return { status: answer.status, body: JSON.parse(answer.text) as unknown };
}

async function load(body: object, person: Person = 'one', db?: Db): Promise<Page> {
  const answer = await post('objectSets/loadObjects', { excludeRid: true, ...body }, person, db);

  expect(answer.status, JSON.stringify(answer.body)).toBe(200);

  return answer.body as Page;
}

const builder = createClient('https://ontology.test', ONTOLOGY.split('/').at(-1) ?? '', async () => 'token');
const objectType = (apiName: string): ObjectTypeDefinition => ({ type: 'object', apiName });
const stock = (apiName: string) => builder(objectType(apiName));
const wire = (set: Parameters<typeof getWireObjectSet>[0]): Json => JSON.parse(JSON.stringify(getWireObjectSet(set)));

interface Expression {
  add(operand: Expression): Expression;
  subtract(operand: Expression): Expression;
  multiply(operand: Expression): Expression;
  divide(operand: Expression): Expression;
  max(operand: Expression): Expression;
  min(operand: Expression): Expression;
  abs(): Expression;
  negate(): Expression;
  extractPart(part: 'DAYS' | 'MONTHS' | 'QUARTERS' | 'YEARS'): Expression;
}

interface Hops {
  pivotTo(link: string): Hops;
  where(clause: object): Hops;
  aggregate(aggregation: string, options?: object): Expression;
  selectProperty(apiName: string): Expression;
}

const derived = (clause: Record<string, (b: Hops) => Expression>): never => clause as never;

const byKey = (field: string) => ({ orderBy: { fields: [{ field, direction: 'asc' }] } });

function valuesOf(page: Page, property: string): Record<string, unknown> {
  return Object.fromEntries(
    page.data.map((object) => [String(object['__primaryKey']), property in object ? object[property] : 'absent']),
  );
}

async function values(set: Json, property: string, person: Person = 'one'): Promise<Record<string, unknown>> {
  return valuesOf(await load({ objectSet: set, select: [property] }, person), property);
}

const accounts = () => stock(ACCOUNT);

const withProperties = (derivedProperties: Json, objectSet: Json = { type: 'base', objectType: ACCOUNT }) => ({
  type: 'withProperties',
  objectSet,
  derivedProperties,
});

const around = (link: string) => ({ type: 'searchAround', objectSet: { type: 'methodInput' }, link });
const selection = (objectSet: Json, operation: Json) => ({ type: 'selection', objectSet, operation });

describe(`${READS}: a withProperties set gives a value for each of the 11 operations`, () => {
  const all = () =>
    wire(
      accounts().withProperties(
        derived({
          txCount: (b) => b.pivotTo('transactions').aggregate('$count'),
          total: (b) => b.pivotTo('transactions').aggregate('amount:sum'),
          average: (b) => b.pivotTo('transactions').aggregate('amount:avg'),
          smallest: (b) => b.pivotTo('transactions').aggregate('amount:min'),
          largest: (b) => b.pivotTo('transactions').aggregate('amount:max'),
          categories: (b) => b.pivotTo('transactions').aggregate('categoryId:exactDistinct'),
          distinctEstimate: (b) => b.pivotTo('transactions').aggregate('categoryId:approximateDistinct'),
          lowerQuartile: (b) =>
            b.pivotTo('transactions').aggregate('amount:approximatePercentile', { percentile: 0.25 }),
          firstTwo: (b) => b.pivotTo('transactions').aggregate('transactionId:collectList', { limit: 2 }),
          categorySet: (b) => b.pivotTo('transactions').aggregate('categoryId:collectSet', { limit: 100 }),
        }),
      ),
    );

  it(`${READS}: with an empty select, the load gives each request derived property of the set, with the values of the 10 aggregate operations`, async () => {
    const page = await load({ objectSet: all(), select: [], ...byKey('accountId') });

    expect(page.data).toEqual([
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-1',
        __title: 'Acme',
        accountId: 'acc-1',
        name: 'Acme',
        entity: 'E1',
        status: 'pending',
        txCount: 3,
        total: '125.75',
        average: '41.92',
        smallest: '5.25',
        largest: '100.00',
        categories: 2,
        distinctEstimate: 2,
        lowerQuartile: 12.875,
        firstTwo: ['tx-1', 'tx-2'],
        categorySet: ['cat-1', 'cat-2'],
      },
      expect.objectContaining({
        accountId: 'acc-2',
        txCount: 2,
        total: '8.25',
        lowerQuartile: 2.6875,
        firstTwo: ['tx-4', 'tx-5'],
        categorySet: ['cat-2'],
      }),
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-3',
        __title: 'Initech',
        accountId: 'acc-3',
        name: 'Initech',
        entity: 'E3',
        status: 'cleared',
        txCount: 0,
        categories: 0,
        distinctEstimate: 0,
      },
    ]);
  });

  it(`${READS}: with a select, the load gives only the named request derived properties`, async () => {
    const page = await load({ objectSet: all(), select: ['total'], ...byKey('accountId') });

    expect(page.data).toEqual([
      { __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1', total: '125.75' },
      { __apiName: ACCOUNT, __primaryKey: 'acc-2', accountId: 'acc-2', total: '8.25' },
      { __apiName: ACCOUNT, __primaryKey: 'acc-3', accountId: 'acc-3' },
    ]);
  });

  it(`${READS}: get reads the value of the 1 Object at the end of a hop with cardinality ONE`, async () => {
    const set = wire(
      stock(TRANSACTION).withProperties(derived({ accountName: (b) => b.pivotTo('account').selectProperty('name') })),
    );

    expect(await values(set, 'accountName')).toEqual({
      'tx-1': 'Acme',
      'tx-2': 'Acme',
      'tx-3': 'Acme',
      'tx-4': 'Globex',
      'tx-5': 'Globex',
    });
  });
});

describe(`${OPERATIONS}: a filter on a hop keeps only its Objects`, () => {
  it(`${OPERATIONS}: cleared balance is the sum of amount of the Transactions whose status is cleared`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      ),
    );

    expect((set['derivedProperties'] as Json)['clearedBalance']).toMatchObject({
      objectSet: {
        type: 'filter',
        objectSet: { type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'transactions' },
      },
    });

    expect(await values(set, 'clearedBalance')).toEqual({ 'acc-1': '105.25', 'acc-2': '1.25', 'acc-3': 'absent' });
  });

  it(`${OPERATIONS}: plan cash is the sum of amount of the Transactions whose date is on or before a date that the request sends`, async () => {
    const today = '2026-02-15';

    const set = wire(
      accounts().withProperties(
        derived({
          planCash: (b) =>
            b
              .pivotTo('transactions')
              .where({ postedOn: { $lte: today } })
              .aggregate('amount:sum'),
        }),
      ),
    );

    expect(await values(set, 'planCash')).toEqual({ 'acc-1': '120.50', 'acc-2': '7.00', 'acc-3': 'absent' });
  });

  it(`${OPERATIONS}: a filter before the first hop keeps only the input rows that match it`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          pendingCount: (b) =>
            b
              .where({ status: { $eq: 'pending' } })
              .pivotTo('transactions')
              .aggregate('$count'),
        }),
      ),
    );

    expect(await values(set, 'pendingCount')).toEqual({ 'acc-1': 3, 'acc-2': 0, 'acc-3': 0 });
  });
});

describe(`${OPERATIONS}: a hop filter reads the rows of its own hop, never an outer row`, () => {
  it(`${OPERATIONS}: a hop filter on status counts the cleared Transactions, not the Accounts whose own status is cleared`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          clearedCount: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('$count'),
        }),
      ),
    );

    expect(await values(set, 'clearedCount')).toEqual({ 'acc-1': 2, 'acc-2': 1, 'acc-3': 0 });
  });

  it(`${OPERATIONS}: a filter on status at each of 3 hops reads its own hop: Invoice to Engagement to Account to Transaction`, async () => {
    const set = wire(
      stock(INVOICE).withProperties(
        derived({
          clearedOfActive: (b) =>
            b
              .pivotTo('engagement')
              .where({ status: { $eq: 'active' } })
              .pivotTo('account')
              .where({ status: { $eq: 'pending' } })
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('$count'),
        }),
      ),
    );

    expect(
      valuesOf(await load({ objectSet: set, select: ['clearedOfActive'], ...byKey('invoiceId') }), 'clearedOfActive'),
    ).toEqual({ 'inv-1': 2, 'inv-2': 2, 'inv-3': 0 });
  });

  it(`${OPERATIONS}: 2 entries that hop to the same Object Type each read their own filter`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          cleared: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('$count'),
          pending: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'pending' } })
              .aggregate('$count'),
        }),
      ),
    );

    const page = await load({ objectSet: set, select: ['cleared', 'pending'], ...byKey('accountId') });

    expect(page.data.map((object) => [object['accountId'], object['cleared'], object['pending']])).toEqual([
      ['acc-1', 2, 1],
      ['acc-2', 1, 1],
      ['acc-3', 0, 0],
    ]);
  });

  it(`${OPERATIONS}: 2 nested derived values whose hop filters name the same Property give the right values, in the select and in a where`, async () => {
    const set = wire(
      accounts()
        .withProperties(
          derived({
            cleared: (b) =>
              b
                .pivotTo('transactions')
                .where({ status: { $eq: 'cleared' } })
                .aggregate('$count'),
          }),
        )
        .withProperties(
          derived({
            pending: (b) =>
              b
                .pivotTo('transactions')
                .where({ status: { $eq: 'pending' } })
                .aggregate('$count'),
          }),
        )
        .where({ cleared: { $gt: 0 }, pending: { $gt: 0 } }),
    );

    const page = await load({ objectSet: set, select: ['cleared', 'pending'], ...byKey('accountId') });

    expect(page.data.map((object) => [object['accountId'], object['cleared'], object['pending']])).toEqual([
      ['acc-1', 2, 1],
      ['acc-2', 1, 1],
    ]);
  });
});

const transactions = () => stock(TRANSACTION);

async function expressionValues(property: string, set: Json): Promise<Record<string, unknown>> {
  const page = await load({ objectSet: set, select: [property], ...byKey('transactionId') });

  return valuesOf(page, property);
}

describe(`${OPERATIONS}: each of the 8 expressions gives its value on literal data`, () => {
  it(`${OPERATIONS}: add, subtract, multiply, and divide of the Properties of the input row`, async () => {
    const set = wire(
      transactions().withProperties(
        derived({
          doubled: (b) => b.selectProperty('units').add(b.selectProperty('units')),
          net: (b) => b.selectProperty('amount').subtract(b.selectProperty('fee')),
          weighted: (b) => b.selectProperty('units').multiply(b.selectProperty('rate')),
          perUnit: (b) => b.selectProperty('rate').divide(b.selectProperty('units')),
        }),
      ),
    );

    expect(await expressionValues('doubled', set)).toEqual({ 'tx-1': 4, 'tx-2': 6, 'tx-3': 10, 'tx-4': 0, 'tx-5': 8 });

    expect(await expressionValues('net', set)).toEqual({
      'tx-1': '99.50',
      'tx-2': 'absent',
      'tx-3': 'absent',
      'tx-4': 'absent',
      'tx-5': 'absent',
    });

    expect(await expressionValues('weighted', set)).toEqual({
      'tx-1': 3,
      'tx-2': 7.5,
      'tx-3': 'absent',
      'tx-4': 0,
      'tx-5': 'absent',
    });

    expect(await expressionValues('perUnit', set)).toEqual({
      'tx-1': 0.75,
      'tx-2': 2.5 / 3,
      'tx-3': 'absent',
      'tx-4': 'absent',
      'tx-5': 'absent',
    });
  });

  it(`${OPERATIONS}: a division by 0 gives null, so the load leaves it out`, async () => {
    const set = wire(
      transactions().withProperties(
        derived({ perUnit: (b) => b.selectProperty('rate').divide(b.selectProperty('units')) }),
      ),
    );

    const page = await load({ objectSet: set, select: ['perUnit', 'units', 'rate'], ...byKey('transactionId') });

    expect(page.data.find((object) => object['transactionId'] === 'tx-4')).toEqual({
      __apiName: TRANSACTION,
      __primaryKey: 'tx-4',
      transactionId: 'tx-4',
      units: 0,
      rate: 2,
    });
  });

  it(`${OPERATIONS}: absoluteValue and negate keep the type of the operand`, async () => {
    const set = wire(
      transactions().withProperties(
        derived({
          negated: (b) => b.selectProperty('units').negate(),
          distance: (b) => b.selectProperty('fee').subtract(b.selectProperty('amount')).abs(),
        }),
      ),
    );

    expect(await expressionValues('negated', set)).toEqual({
      'tx-1': -2,
      'tx-2': -3,
      'tx-3': -5,
      'tx-4': 0,
      'tx-5': -4,
    });

    expect(await expressionValues('distance', set)).toEqual({
      'tx-1': '99.50',
      'tx-2': 'absent',
      'tx-3': 'absent',
      'tx-4': 'absent',
      'tx-5': 'absent',
    });
  });

  it(`${OPERATIONS}: greatest and least skip a null operand, and give null only when each operand is null`, async () => {
    const set = wire(
      transactions().withProperties(
        derived({
          most: (b) => b.selectProperty('rate').max(b.selectProperty('units')),
          fewest: (b) => b.selectProperty('rate').min(b.selectProperty('units')),
          feeOrRate: (b) => b.selectProperty('rate').max(b.selectProperty('fee')),
        }),
      ),
    );

    expect(await expressionValues('most', set)).toEqual({ 'tx-1': 2, 'tx-2': 3, 'tx-3': 5, 'tx-4': 2, 'tx-5': 4 });

    expect(await expressionValues('fewest', set)).toEqual({
      'tx-1': 1.5,
      'tx-2': 2.5,
      'tx-3': 5,
      'tx-4': 0,
      'tx-5': 4,
    });

    expect(await expressionValues('feeOrRate', set)).toEqual({
      'tx-1': 1.5,
      'tx-2': 2.5,
      'tx-3': 'absent',
      'tx-4': 2,
      'tx-5': 'absent',
    });
  });

  it(`${OPERATIONS}: an expression with a null operand gives null`, async () => {
    const set = wire(
      transactions().withProperties(derived({ sum: (b) => b.selectProperty('units').add(b.selectProperty('rate')) })),
    );

    expect(await expressionValues('sum', set)).toEqual({
      'tx-1': 3.5,
      'tx-2': 5.5,
      'tx-3': 'absent',
      'tx-4': 2,
      'tx-5': 'absent',
    });
  });

  it(`${OPERATIONS}: extract gives the DAYS, MONTHS, QUARTERS, or YEARS part of a Date or a Timestamp as an Integer, in UTC`, async () => {
    const set = wire(
      transactions().withProperties(
        derived({
          day: (b) => b.selectProperty('postedOn').extractPart('DAYS'),
          month: (b) => b.selectProperty('postedOn').extractPart('MONTHS'),
          quarter: (b) => b.selectProperty('postedOn').extractPart('QUARTERS'),
          year: (b) => b.selectProperty('postedOn').extractPart('YEARS'),
          postedDay: (b) => b.selectProperty('postedAt').extractPart('DAYS'),
          postedMonth: (b) => b.selectProperty('postedAt').extractPart('MONTHS'),
        }),
      ),
    );

    const page = await load({
      objectSet: set,
      select: ['day', 'month', 'quarter', 'year', 'postedDay', 'postedMonth'],
      ...byKey('transactionId'),
    });

    expect(page.data[0]).toEqual({
      __apiName: TRANSACTION,
      __primaryKey: 'tx-1',
      transactionId: 'tx-1',
      day: 10,
      month: 1,
      quarter: 1,
      year: 2026,
      postedDay: 31,
      postedMonth: 3,
    });

    expect(page.data.map((object) => object['quarter'])).toEqual([1, 1, 1, 1, 2]);
  });

  it(`${OPERATIONS}: category available is the sum of amount of the Transactions of a Category minus its budget, and null with no Transaction`, async () => {
    const set = wire(
      stock(CATEGORY).withProperties(
        derived({
          available: (b) => b.pivotTo('transactions').aggregate('amount:sum').subtract(b.selectProperty('budget')),
        }),
      ),
    );

    const page = await load({ objectSet: set, select: ['available'], ...byKey('categoryId') });

    expect(valuesOf(page, 'available')).toEqual({ 'cat-1': '-29.50', 'cat-2': '3.50', 'cat-3': 'absent' });
  });
});

describe(`${TYPES}: a Decimal expression is exact, and multiply and divide round 1 time to the scale of the left value`, () => {
  beforeEach(async () => {
    await insertObjects(service.db, TRANSACTION, [
      { transactionId: 'tx-d1', accountId: 'acc-3', categoryId: 'cat-3', amount: '1.25', fee: '0.5', ...mine },
      { transactionId: 'tx-d2', accountId: 'acc-3', categoryId: 'cat-3', amount: '-1.25', fee: '0.5', ...mine },
      { transactionId: 'tx-d3', accountId: 'acc-3', categoryId: 'cat-3', amount: '2.00', fee: '0.3', ...mine },
      { transactionId: 'tx-d4', accountId: 'acc-3', categoryId: 'cat-3', amount: '-2.00', fee: '0.3', ...mine },
      { transactionId: 'tx-d5', accountId: 'acc-3', categoryId: 'cat-3', amount: '1.00', fee: '0.0', ...mine },
    ]);
  });

  const decimals = async () => {
    const set = wire(
      stock(TRANSACTION)
        .where({ categoryId: { $eq: 'cat-3' } })
        .withProperties(
          derived({
            product: (b) => b.selectProperty('amount').multiply(b.selectProperty('fee')),
            quotient: (b) => b.selectProperty('amount').divide(b.selectProperty('fee')),
            combined: (b) => b.selectProperty('amount').add(b.selectProperty('fee')),
            larger: (b) => b.selectProperty('amount').max(b.selectProperty('fee')),
          }),
        ),
    );

    const answer = await service.call(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      {
        excludeRid: true,
        objectSet: set,
        select: ['product', 'quotient', 'combined', 'larger'],
        ...byKey('transactionId'),
      },
      PEOPLE.one,
    );

    expect(answer.status, answer.text).toBe(200);

    return { text: answer.text, page: JSON.parse(answer.text) as Page };
  };

  it(`${TYPES}: on scale 2, 1.25 * 0.5 gives "0.63", and -1.25 * 0.5 gives "-0.63"`, async () => {
    const { page } = await decimals();

    expect(valuesOf(page, 'product')).toMatchObject({
      'tx-d1': '0.63',
      'tx-d2': '-0.63',
      'tx-d3': '0.60',
      'tx-d5': '0.00',
    });
  });

  it(`${TYPES}: divide rounds 1 time, half away from zero, and a division by 0 gives null`, async () => {
    const { page } = await decimals();

    expect(valuesOf(page, 'quotient')).toEqual({
      'tx-d1': '2.50',
      'tx-d2': '-2.50',
      'tx-d3': '6.67',
      'tx-d4': '-6.67',
      'tx-d5': 'absent',
    });
  });

  it(`${TYPES}: add and greatest of Decimals are exact, with the largest scale of the operands`, async () => {
    const { page } = await decimals();

    expect(valuesOf(page, 'combined')).toEqual({
      'tx-d1': '1.75',
      'tx-d2': '-0.75',
      'tx-d3': '2.30',
      'tx-d4': '-1.70',
      'tx-d5': '1.00',
    });

    expect(valuesOf(page, 'larger')).toEqual({
      'tx-d1': '1.25',
      'tx-d2': '0.50',
      'tx-d3': '2.00',
      'tx-d4': '0.30',
      'tx-d5': '1.00',
    });
  });

  const moreDecimals = async (rows: readonly ObjectRow[] = []) => {
    if (rows.length > 0) await insertObjects(service.db, TRANSACTION, rows);

    const set = wire(
      stock(TRANSACTION)
        .where({ categoryId: { $eq: 'cat-3' } })
        .withProperties(
          derived({
            difference: (b) => b.selectProperty('amount').subtract(b.selectProperty('fee')),
            reversed: (b) => b.selectProperty('fee').subtract(b.selectProperty('amount')),
            smaller: (b) => b.selectProperty('amount').min(b.selectProperty('fee')),
            flipped: (b) => b.selectProperty('fee').negate(),
            magnitude: (b) => b.selectProperty('amount').abs(),
            combined: (b) => b.selectProperty('amount').add(b.selectProperty('fee')),
            mixedSum: (b) => b.selectProperty('amount').add(b.selectProperty('rate')),
            mixedProduct: (b) => b.selectProperty('amount').multiply(b.selectProperty('rate')),
          }),
        ),
    );

    const names = ['difference', 'combined', 'reversed', 'smaller', 'flipped', 'magnitude', 'mixedSum', 'mixedProduct'];

    const answer = await service.call(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      { excludeRid: true, objectSet: set, select: names, ...byKey('transactionId') },
      PEOPLE.one,
    );

    expect(answer.status, answer.text).toBe(200);

    return { text: answer.text, page: JSON.parse(answer.text) as Page };
  };

  it(`${TYPES}: subtract of Decimals is exact, with the largest scale of the operands, in each operand order`, async () => {
    const { page } = await moreDecimals();

    expect(valuesOf(page, 'difference')).toEqual({
      'tx-d1': '0.75',
      'tx-d2': '-1.75',
      'tx-d3': '1.70',
      'tx-d4': '-2.30',
      'tx-d5': '1.00',
    });

    expect(valuesOf(page, 'reversed')).toEqual({
      'tx-d1': '-0.75',
      'tx-d2': '1.75',
      'tx-d3': '-1.70',
      'tx-d4': '2.30',
      'tx-d5': '-1.00',
    });
  });

  it(`${TYPES}: least of Decimals is exact, with the largest scale of the operands`, async () => {
    const { page } = await moreDecimals();

    expect(valuesOf(page, 'smaller')).toEqual({
      'tx-d1': '0.50',
      'tx-d2': '-1.25',
      'tx-d3': '0.30',
      'tx-d4': '-2.00',
      'tx-d5': '0.00',
    });
  });

  it(`${TYPES}: negate and absoluteValue of a Decimal keep its scale`, async () => {
    const { page } = await moreDecimals();

    expect(valuesOf(page, 'flipped')).toEqual({
      'tx-d1': '-0.5',
      'tx-d2': '-0.5',
      'tx-d3': '-0.3',
      'tx-d4': '-0.3',
      'tx-d5': '0.0',
    });

    expect(valuesOf(page, 'magnitude')).toEqual({
      'tx-d1': '1.25',
      'tx-d2': '1.25',
      'tx-d3': '2.00',
      'tx-d4': '2.00',
      'tx-d5': '1.00',
    });
  });

  it(`${TYPES}: add and subtract of Decimals past 2^53 keep each digit`, async () => {
    const { page } = await moreDecimals([
      {
        transactionId: 'tx-d6',
        accountId: 'acc-3',
        categoryId: 'cat-3',
        amount: '9007199254740993.01',
        fee: '0.5',
        ...mine,
      },
    ]);

    expect(valuesOf(page, 'difference')['tx-d6']).toBe('9007199254740992.51');
    expect(valuesOf(page, 'combined')['tx-d6']).toBe('9007199254740993.51');
    expect(valuesOf(page, 'magnitude')['tx-d6']).toBe('9007199254740993.01');
  });

  it(`${TYPES}: a Decimal with a Double gives a Double, and leaves as a JSON number`, async () => {
    const { page, text } = await moreDecimals([
      {
        transactionId: 'tx-d7',
        accountId: 'acc-3',
        categoryId: 'cat-3',
        amount: '1.25',
        fee: '0.5',
        rate: 1.5,
        ...mine,
      },
    ]);

    expect(valuesOf(page, 'mixedSum')['tx-d7']).toBe(2.75);
    expect(valuesOf(page, 'mixedProduct')['tx-d7']).toBe(1.875);
    expect(valuesOf(page, 'mixedSum')['tx-d1']).toBe('absent');
    expect(text).toContain('"mixedSum":2.75');
  });

  it(`${TYPES}: no Decimal value leaves as a JSON number`, async () => {
    const { text } = await decimals();

    expect(text).toContain('"product":"0.63"');
    expect(text).not.toMatch(/"(product|quotient|combined|larger)":-?\d/);
  });
});

describe(`${TYPES}: an Integer expression that overflows gets 400 Default:InvalidArgument`, () => {
  it(`${TYPES}: units + units past 2^31 - 1 gets 400, not a 500`, async () => {
    await insertObjects(service.db, TRANSACTION, [
      {
        transactionId: 'tx-big',
        accountId: 'acc-3',
        categoryId: 'cat-3',
        amount: '1.00',
        units: 2_000_000_000,
        ...mine,
      },
    ]);

    const set = wire(
      transactions().withProperties(
        derived({ doubled: (b) => b.selectProperty('units').add(b.selectProperty('units')) }),
      ),
    );

    const answer = await post('objectSets/loadObjects', { objectSet: set, select: ['doubled'] }, 'one');

    expect(answer).toMatchObject({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: { field: 'derivedProperties' },
      },
    });
  });

  it(`${COST}: a select-only Integer overflow on row 6 does not fail page 1 of pageSize 2, and paging to row 6 gets 400`, async () => {
    await insertObjects(service.db, TRANSACTION, [
      {
        transactionId: 'tx-big',
        accountId: 'acc-3',
        categoryId: 'cat-3',
        amount: '500.00',
        units: 2_000_000_000,
        ...mine,
      },
    ]);

    const set = wire(
      transactions().withProperties(
        derived({ doubled: (b) => b.selectProperty('units').add(b.selectProperty('units')) }),
      ),
    );

    const body = {
      objectSet: set,
      select: ['doubled'],
      orderBy: { fields: [{ field: 'amount', direction: 'asc' }] },
      pageSize: 2,
    };

    const first = await load(body);

    expect(first.totalCount).toBe('6');

    expect(first.data.map((object) => [object['transactionId'], object['doubled']])).toEqual([
      ['tx-5', 8],
      ['tx-3', 10],
    ]);

    expect(typeof first.nextPageToken).toBe('string');

    const second = await load({ ...body, pageToken: first.nextPageToken });

    expect(second.data.map((object) => [object['transactionId'], object['doubled']])).toEqual([
      ['tx-4', 0],
      ['tx-2', 6],
    ]);

    expect(typeof second.nextPageToken).toBe('string');

    const third = await post(
      'objectSets/loadObjects',
      { excludeRid: true, ...body, pageToken: second.nextPageToken },
      'one',
    );

    expect(third).toMatchObject({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: { field: 'derivedProperties' },
      },
    });
  });

  const overflow = {
    status: 400,
    body: { errorName: 'Default:InvalidArgument', parameters: { field: 'derivedProperties' } },
  };

  const doubledOver = () => {
    const set = wire(
      transactions().withProperties(
        derived({ doubled: (b) => b.selectProperty('units').add(b.selectProperty('units')) }),
      ),
    );

    return { type: 'filter', objectSet: set, where: { type: 'gt', field: 'doubled', value: 0 } };
  };

  const base = { type: 'base', objectType: TRANSACTION };

  it.each([
    ['a union', () => ({ type: 'union', objectSets: [doubledOver(), base] })],
    ['an intersect', () => ({ type: 'intersect', objectSets: [doubledOver(), base] })],
    ['a subtract', () => ({ type: 'subtract', objectSets: [base, doubledOver()] })],
    ['a searchAround', () => ({ type: 'searchAround', objectSet: doubledOver(), link: 'account' })],
  ])(`${TYPES}: an overflow in a filter inside %s gets 400, not a 500`, async (_shape, objectSet) => {
    await insertObjects(service.db, TRANSACTION, [
      {
        transactionId: 'tx-big',
        accountId: 'acc-3',
        categoryId: 'cat-3',
        amount: '1.00',
        units: 2_000_000_000,
        ...mine,
      },
    ]);

    expect(await post('objectSets/loadObjects', { objectSet: objectSet() }, 'one')).toMatchObject(overflow);
  });

  it(`${TYPES}: an overflow in a filter inside a union of an aggregate gets 400, not a 500`, async () => {
    await insertObjects(service.db, TRANSACTION, [
      {
        transactionId: 'tx-big',
        accountId: 'acc-3',
        categoryId: 'cat-3',
        amount: '1.00',
        units: 2_000_000_000,
        ...mine,
      },
    ]);

    const objectSet = { type: 'union', objectSets: [doubledOver(), base] };

    expect(
      await post('objectSets/aggregate', { objectSet, aggregation: [{ type: 'count', name: 'count' }] }, 'one'),
    ).toMatchObject(overflow);
  });
});

describe(`${READS}: a where, an orderBy, and an aggregate read a request derived value`, () => {
  const accountActive = () =>
    accounts().withProperties(
      derived({
        activeEngagements: (b) =>
          b
            .pivotTo('engagements')
            .where({ status: { $eq: 'active' } })
            .aggregate('$count'),
      }),
    );

  it(`${READS}: account active keeps each Account whose count of active Engagements is > 0`, async () => {
    const set = wire(accountActive().where({ activeEngagements: { $gt: 0 } }));

    expect(set['where']).toEqual({ type: 'gt', field: 'activeEngagements', value: 0 });

    const page = await load({ objectSet: set, select: ['activeEngagements'], ...byKey('accountId') });

    expect(page.data.map((object) => [object['accountId'], object['activeEngagements']])).toEqual([
      ['acc-1', 1],
      ['acc-3', 1],
    ]);

    expect(page.totalCount).toBe('2');
  });

  it(`${READS}: an orderBy on a request derived value over 2 pages gives each Object 1 time`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      ),
    );

    const body = {
      objectSet: set,
      select: ['clearedBalance'],
      orderBy: { fields: [{ field: 'clearedBalance', direction: 'desc' }] },
      pageSize: 2,
    };

    const first = await load(body);

    expect(first.data.map((object) => [object['accountId'], object['clearedBalance']])).toEqual([
      ['acc-1', '105.25'],
      ['acc-2', '1.25'],
    ]);

    const second = await load({ ...body, pageToken: first.nextPageToken });

    expect(second.data.map((object) => [object['accountId'], object['clearedBalance'] ?? null])).toEqual([
      ['acc-3', null],
    ]);
  });

  it(`${READS}: an aggregate takes a request derived value as a metric and as a group-by`, async () => {
    const set = wire(
      accountActive().withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      ),
    );

    const answer = await post(
      'objectSets/aggregate',
      {
        objectSet: set,
        aggregation: [
          { type: 'sum', field: 'clearedBalance', name: 'total' },
          { type: 'count', name: 'count' },
        ],
        groupBy: [{ type: 'exact', field: 'activeEngagements' }],
      },
      'one',
    );

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);

    const groups = Object.fromEntries(
      (answer.body as { data: { group: Row; metrics: Row[] }[] }).data.map((entry) => [
        String(entry.group['activeEngagements']),
        entry.metrics,
      ]),
    );

    expect(groups).toEqual({
      '1': [
        { name: 'total', value: '105.25' },
        { name: 'count', value: 2 },
      ],
      '0': [
        { name: 'total', value: '1.25' },
        { name: 'count', value: 1 },
      ],
    });
  });
});

describe(`${READS}: a later withProperties reads an inner value, and a request derived property stays in its set`, () => {
  it(`${READS}: an expression of a later withProperties reads a value of an inner one`, async () => {
    const set = wire(
      accounts()
        .withProperties(
          derived({
            cleared: (b) =>
              b
                .pivotTo('transactions')
                .where({ status: { $eq: 'cleared' } })
                .aggregate('amount:sum'),
          }),
        )
        .withProperties(
          derived({
            uncleared: (b) => b.pivotTo('transactions').aggregate('amount:sum').subtract(b.selectProperty('cleared')),
          }),
        ),
    );

    expect(await values(set, 'uncleared')).toEqual({ 'acc-1': '20.50', 'acc-2': '7.00', 'acc-3': 'absent' });

    const filtered = wire(
      accounts()
        .withProperties(
          derived({
            cleared: (b) =>
              b
                .pivotTo('transactions')
                .where({ status: { $eq: 'cleared' } })
                .aggregate('amount:sum'),
          }),
        )
        .withProperties(
          derived({
            uncleared: (b) => b.pivotTo('transactions').aggregate('amount:sum').subtract(b.selectProperty('cleared')),
          }),
        )
        .where({ cleared: { $gt: 2 } }),
    );

    expect(await values(filtered, 'uncleared')).toEqual({ 'acc-1': '20.50' });
  });

  it(`${READS}: a selection cannot read a derived value: its selected Property is a stored Property of its target`, async () => {
    const set = wire(
      accounts().withProperties(derived({ invoices: (b) => b.pivotTo('engagements').aggregate('invoiceCount:sum') })),
    );

    const answer = await post('objectSets/loadObjects', { objectSet: set, select: ['invoices'] }, 'one');

    expect(answer).toMatchObject({
      status: 400,
      body: {
        errorName: 'InvalidDerivedPropertyDefinition',
        parameters: { objectType: ACCOUNT, derivedProperty: 'invoices' },
      },
    });
  });

  it(`${READS}: a select of a request derived property after a union gets 404 PropertiesNotFound`, async () => {
    const counted = wire(
      accounts().withProperties(derived({ cleared: (b) => b.pivotTo('transactions').aggregate('$count') })),
    );

    const union = { type: 'union', objectSets: [counted, { type: 'base', objectType: ACCOUNT }] };

    expect(await post('objectSets/loadObjects', { objectSet: union, select: ['cleared'] }, 'one')).toMatchObject({
      status: 404,
      body: { errorName: 'PropertiesNotFound', parameters: { objectType: ACCOUNT, properties: ['cleared'] } },
    });

    const around = { type: 'searchAround', objectSet: counted, link: 'transactions' };

    expect(await post('objectSets/loadObjects', { objectSet: around, select: ['cleared'] }, 'one')).toMatchObject({
      status: 404,
      body: { errorName: 'PropertiesNotFound' },
    });
  });
});

describe(`${ERRORS}: each error of a request derived property, with no read of data`, () => {
  async function refusal(objectSet: unknown, person: Person = 'one'): Promise<{ status: number; body: unknown }> {
    const { db, statements } = recording();

    const answer = await post('objectSets/loadObjects', { objectSet, select: [] }, person, db);

    expect(statements).toEqual([]);

    return answer;
  }

  const invalidDefinition = (derivedProperty: string, objectType = ACCOUNT) => ({
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'InvalidDerivedPropertyDefinition',
      parameters: { objectType, derivedProperty },
    },
  });

  it(`${ERRORS}: a definition with a wrong shape or type gets 400 InvalidDerivedPropertyDefinition with objectType and derivedProperty`, async () => {
    expect(
      await refusal(
        withProperties({
          median: selection(around('transactions'), { type: 'median', selectedPropertyApiName: 'amount' }),
        }),
      ),
    ).toMatchObject(invalidDefinition('median'));

    expect(
      await refusal(
        withProperties({
          statusSum: selection(around('transactions'), { type: 'sum', selectedPropertyApiName: 'status' }),
        }),
      ),
    ).toMatchObject(invalidDefinition('statusSum'));

    expect(await refusal(withProperties({ broken: 'count' }))).toMatchObject(invalidDefinition('broken'));

    expect(
      await refusal(withProperties({ owned: selection({ type: 'base', objectType: TRANSACTION }, { type: 'count' }) })),
    ).toMatchObject(invalidDefinition('owned'));
  });

  it(`${ERRORS}: a name that the set already has gets 400 DerivedPropertyApiNamesNotUnique with derivedPropertyApiNames`, async () => {
    const count = selection(around('transactions'), { type: 'count' });

    const notUnique = (names: string[]) => ({
      status: 400,
      body: { errorName: 'DerivedPropertyApiNamesNotUnique', parameters: { derivedPropertyApiNames: names } },
    });

    expect(await refusal(withProperties({ name: count }))).toMatchObject(notUnique(['name']));

    expect(await refusal(withProperties({ balance: count, fresh: count }))).toMatchObject(notUnique(['balance']));

    expect(await refusal(withProperties({ fresh: count }, withProperties({ fresh: count })))).toMatchObject(
      notUnique(['fresh']),
    );
  });

  it(`${ERRORS}: a collect limit outside 1 to 100 gets 400 InvalidDerivedPropertyCollectionLimit with limit, minLimit, and maxLimit`, async () => {
    for (const limit of [0, 101]) {
      const ids = selection(around('transactions'), {
        type: 'collectList',
        selectedPropertyApiName: 'transactionId',
        limit,
      });

      expect(await refusal(withProperties({ ids }))).toMatchObject({
        status: 400,
        body: { errorName: 'InvalidDerivedPropertyCollectionLimit', parameters: { limit, minLimit: 1, maxLimit: 100 } },
      });
    }
  });

  it(`${ERRORS}: a methodInput outside a selection gets 400 Default:InvalidArgument`, async () => {
    expect(await refusal({ type: 'methodInput' })).toMatchObject({
      status: 400,
      body: { errorName: 'Default:InvalidArgument', parameters: { feature: 'methodInput' } },
    });

    const inFilter = {
      type: 'filter',
      objectSet: { type: 'methodInput' },
      where: { type: 'eq', field: 'name', value: 'Acme' },
    };

    expect(await refusal(inFilter)).toMatchObject({
      status: 400,
      body: { errorName: 'Default:InvalidArgument', parameters: { feature: 'methodInput' } },
    });
  });

  it(`${ERRORS}: an unknown Link side in a hop gets 404 LinkTypeNotFound, as for a searchAround`, async () => {
    const nested = selection(
      { type: 'searchAround', objectSet: around('transactions'), link: 'nope' },
      { type: 'count' },
    );

    expect(await refusal(withProperties({ lost: selection(around('nope'), { type: 'count' }) }))).toMatchObject({
      status: 404,
      body: { errorName: 'LinkTypeNotFound', parameters: { objectType: ACCOUNT, linkType: 'nope' } },
    });

    expect(await refusal(withProperties({ lost: nested }))).toMatchObject({
      status: 404,
      body: { errorName: 'LinkTypeNotFound', parameters: { objectType: TRANSACTION, linkType: 'nope' } },
    });
  });

  it(`${ERRORS}: a hop filter on an unknown Property gets the error of the filter member`, async () => {
    const where = {
      type: 'filter',
      objectSet: around('transactions'),
      where: { type: 'eq', field: 'missing', value: 1 },
    };

    expect(await refusal(withProperties({ bad: selection(where, { type: 'count' }) }))).toMatchObject({
      status: 404,
      body: { errorName: 'PropertiesNotFound', parameters: { objectType: TRANSACTION, properties: ['missing'] } },
    });
  });

  it(`${ERRORS}: a name must be a Property API name, so a name with a quote, a semicolon, or a space gets 400 and never reaches the SQL`, async () => {
    const count = selection(around('transactions'), { type: 'count' });

    for (const name of [`it's`, 'a;DROP TABLE account', 'two words', '1st', '']) {
      expect(await refusal(withProperties({ [name]: count }))).toMatchObject(invalidDefinition(name));
    }

    const { db, statements } = recording();
    const set = withProperties({ secretName: count });

    await load({ objectSet: set, select: ['secretName'] }, 'one', db);

    await load(
      {
        objectSet: { type: 'filter', objectSet: set, where: { type: 'gt', field: 'secretName', value: 0 } },
        select: ['name'],
      },
      'one',
      db,
    );

    await load({ objectSet: set, select: ['name'], ...byKey('secretName') }, 'one', db);

    expect(statements).toHaveLength(3);

    for (const statement of statements) expect(statement.text).not.toContain('secretName');
  });
});

describe(`${LIMITS}: the limits of the request form`, () => {
  const invalidDefinition = (derivedProperty: string, objectType = TRANSACTION) => ({
    status: 400,
    body: { errorName: 'InvalidDerivedPropertyDefinition', parameters: { objectType, derivedProperty } },
  });

  const units = { type: 'property', apiName: 'units' };

  it(`${LIMITS}: the request form has no fixed hop limit: 5 hops from an Account reach its Engagements`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          farEngagements: (b) =>
            b
              .pivotTo('transactions')
              .pivotTo('account')
              .pivotTo('transactions')
              .pivotTo('account')
              .pivotTo('engagements')
              .aggregate('$count'),
        }),
      ),
    );

    expect(await values(set, 'farEngagements')).toEqual({ 'acc-1': 2, 'acc-2': 1, 'acc-3': 0 });
  });

  it(`${LIMITS}: a literal in an expression gets 400 InvalidDerivedPropertyDefinition`, async () => {
    const answer = await post(
      'objectSets/loadObjects',
      {
        objectSet: {
          type: 'withProperties',
          objectSet: { type: 'base', objectType: TRANSACTION },
          derivedProperties: { plusFive: { type: 'add', properties: [units, 5] } },
        },
      },
      'one',
    );

    expect(answer).toMatchObject(invalidDefinition('plusFive'));

    const literal = await post(
      'objectSets/loadObjects',
      {
        objectSet: {
          type: 'withProperties',
          objectSet: { type: 'base', objectType: TRANSACTION },
          derivedProperties: { five: { type: 'literal', value: 5 } },
        },
      },
      'one',
    );

    expect(literal).toMatchObject(invalidDefinition('five'));
  });

  it(`${LIMITS}: the request form has no "now", so a definition of the current time gets 400 InvalidDerivedPropertyDefinition`, async () => {
    const answer = await post(
      'objectSets/loadObjects',
      {
        objectSet: {
          type: 'withProperties',
          objectSet: { type: 'base', objectType: TRANSACTION },
          derivedProperties: { today: { type: 'extract', part: 'DAYS', property: { type: 'now' } } },
        },
      },
      'one',
    );

    expect(answer).toMatchObject(invalidDefinition('today'));
  });

  it(`${LIMITS}: a get after a hop with cardinality MANY gets 400 InvalidDerivedPropertyDefinition`, async () => {
    const set = wire(
      accounts().withProperties(derived({ anyAmount: (b) => b.pivotTo('transactions').selectProperty('amount') })),
    );

    expect(await post('objectSets/loadObjects', { objectSet: set }, 'one')).toMatchObject(
      invalidDefinition('anyAmount', ACCOUNT),
    );
  });

  describe(`${LIMITS}: a request nests at most 32 layers`, () => {
    const property = (apiName: string) => ({ type: 'property', apiName });
    const rates = () => selection(around('transactions'), { type: 'sum', selectedPropertyApiName: 'rate' });

    const cleared = () =>
      selection(
        { type: 'filter', objectSet: around('transactions'), where: { type: 'eq', field: 'status', value: 'cleared' } },
        { type: 'count' },
      );

    function layered(layers: number, next: (k: number) => Json): Json {
      let set: Json = withProperties({ v0: rates() });

      for (let k = 1; k <= layers; k += 1) set = withProperties({ [`v${k}`]: next(k) }, set);

      return set;
    }

    const doubled = (layers: number) =>
      layered(layers, (k) => ({ type: 'add', properties: [property(`v${k - 1}`), property(`v${k - 1}`)] }));

    const hopping = (layers: number) =>
      layered(layers, (k) => ({ type: 'add', properties: [property(`v${k - 1}`), property(`v${k - 1}`), cleared()] }));

    function doubledJson(layers: number): string {
      const open: string[] = [];
      const close: string[] = [];

      for (let k = 1; k <= layers; k += 1) {
        open.push('{"type":"withProperties","objectSet":');

        close.push(
          `,"derivedProperties":{"v${k}":{"type":"add","properties":[{"type":"property","apiName":"v${k - 1}"},{"type":"property","apiName":"v${k - 1}"}]}}}`,
        );
      }

      return `${open.join('')}${JSON.stringify(withProperties({ v0: rates() }))}${close.join('')}`;
    }

    async function tooDeep(layers: number, objectSet: Json | string): Promise<number> {
      const { db, statements } = recording();
      const started = performance.now();

      const payload =
        typeof objectSet === 'string'
          ? `{"excludeRid":true,"objectSet":${objectSet},"select":["name"]}`
          : { excludeRid: true, objectSet, select: ['name'] };

      const answer = await post('objectSets/loadObjects', payload, 'one', db);

      const ms = performance.now() - started;

      expect(answer).toMatchObject(invalidDefinition(`v${layers - 33}`, ACCOUNT));
      expect(statements).toEqual([]);

      return ms;
    }

    it(`${LIMITS}: 32 layers that each read the layer before 2 times give the right value`, async () => {
      expect(valuesOf(await load({ objectSet: doubled(32), select: ['v32'] }), 'v32')).toEqual({
        'acc-1': 4 * 2 ** 32,
        'acc-2': 2 * 2 ** 32,
        'acc-3': 'absent',
      });
    });

    it(`${LIMITS}: 32 layers that each also add a hop count give the right value`, async () => {
      expect(valuesOf(await load({ objectSet: hopping(32), select: ['v32'] }), 'v32')).toEqual({
        'acc-1': 4 * 2 ** 32 + 2 * (2 ** 32 - 1),
        'acc-2': 2 * 2 ** 32 + (2 ** 32 - 1),
        'acc-3': 'absent',
      });
    });

    it(`${LIMITS}: 33 layers of each shape get 400 InvalidDerivedPropertyDefinition, and the service reads no data`, async () => {
      await tooDeep(33, doubled(33));

      await tooDeep(33, hopping(33));
    });

    it(`${LIMITS}: 512 layers, and about 25,000 layers near the 4.5 MB body limit, get the 400 fast`, async () => {
      expect(doubledJson(2)).toBe(JSON.stringify(doubled(2)));

      expect(await tooDeep(512, doubled(512))).toBeLessThan(1000);

      const body = doubledJson(25_000);

      expect(body.length).toBeGreaterThan(4_000_000);

      expect(await tooDeep(25_000, body)).toBeLessThan(1000);
    });
  });

  describe(`${LIMITS}: a request has at most 1,000 withProperties definitions`, () => {
    const names = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `d${from + i}`);

    const clause = (from: number, to: number, objectSet?: Json) =>
      withProperties(
        Object.fromEntries(names(from, to).map((name) => [name, { type: 'add', properties: [units, units] }])),
        objectSet ?? { type: 'base', objectType: TRANSACTION },
      );

    async function refused(objectSet: Json, derivedProperty: string): Promise<void> {
      const { db, statements } = recording();

      const answer = await post(
        'objectSets/loadObjects',
        { excludeRid: true, objectSet, select: ['transactionId'] },
        'one',
        db,
      );

      expect(answer).toMatchObject(invalidDefinition(derivedProperty));
      expect(statements).toEqual([]);
    }

    it(`${LIMITS}: 1,000 definitions on the Object Type with the most stored Properties give the right value`, async () => {
      const page = await load({ objectSet: clause(1, 1000), select: ['transactionId', 'd1', 'd1000'] });

      expect(page.data.find((row) => row['transactionId'] === 'tx-1')).toMatchObject({ d1: 4, d1000: 4 });
    });

    it(`${LIMITS}: 1,001 definitions in 1 clause get 400 InvalidDerivedPropertyDefinition, and the service reads no data`, async () => {
      await refused(clause(1, 1001), 'd1');
    });

    it(`${LIMITS}: 1,001 definitions in 2 clauses get 400 InvalidDerivedPropertyDefinition, and the service reads no data`, async () => {
      await refused(clause(501, 1001, clause(1, 500)), 'd1');
    });

    it(`${LIMITS}: the error names the first definition of the outer clause, also when the sets below declare definitions`, async () => {
      const one = (name: string) =>
        withProperties(
          { [name]: { type: 'add', properties: [units, units] } },
          { type: 'base', objectType: TRANSACTION },
        );

      const below = { type: 'union', objectSets: [one('a1'), one('b1')] };

      await refused(clause(1, 1001, below), 'd1');
    });
  });
});

describe(`${SECURITY}: the request form reads only what the reader can see`, () => {
  it(`${SECURITY}: 2 readers get 2 cleared balances: a hidden Transaction drops out`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      ),
    );

    expect(await values(set, 'clearedBalance', 'one')).toEqual({
      'acc-1': '105.25',
      'acc-2': '1.25',
      'acc-3': 'absent',
    });

    expect(await values(set, 'clearedBalance', 'two')).toEqual({
      'acc-1': '100.00',
      'acc-2': '1.25',
      'acc-3': 'absent',
    });
  });

  it(`${SECURITY}: a hop filter on a hidden amount reads the masked value of the reader, so it is no oracle of the real value`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          over10: (b) =>
            b
              .pivotTo('transactions')
              .where({ amount: { $gt: 10 } })
              .aggregate('$count'),
          noAmount: (b) =>
            b
              .pivotTo('transactions')
              .where({ amount: { $isNull: true } })
              .aggregate('$count'),
        }),
      ),
    );

    const read = async (person: Person) =>
      (await load({ objectSet: set, select: ['over10', 'noAmount'], ...byKey('accountId') }, person)).data.map(
        (object) => [object['accountId'], object['over10'], object['noAmount']],
      );

    expect(await read('one')).toEqual([
      ['acc-1', 2, 0],
      ['acc-2', 0, 0],
      ['acc-3', 0, 0],
    ]);

    expect(await read('two')).toEqual([
      ['acc-1', 1, 1],
      ['acc-2', 0, 0],
      ['acc-3', 0, 0],
    ]);

    const where = wire(
      accounts()
        .withProperties(
          derived({
            over20: (b) =>
              b
                .pivotTo('transactions')
                .where({ amount: { $gte: 20.5 } })
                .aggregate('$count'),
          }),
        )
        .where({ over20: { $gt: 1 } }),
    );

    expect(
      (await load({ objectSet: where, select: ['accountId'] }, 'one')).data.map((object) => object['accountId']),
    ).toEqual(['acc-1']);

    expect((await load({ objectSet: where, select: ['accountId'] }, 'two')).data).toEqual([]);
  });

  it(`${SECURITY}: a hidden row or value never enters an expression or a percentile`, async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          lowerQuartile: (b) =>
            b.pivotTo('transactions').aggregate('amount:approximatePercentile', { percentile: 0.25 }),
          spread: (b) =>
            b
              .pivotTo('transactions')
              .aggregate('amount:max')
              .subtract(b.pivotTo('transactions').aggregate('amount:min')),
        }),
      ),
    );

    const read = async (person: Person) =>
      (await load({ objectSet: set, select: ['lowerQuartile', 'spread'], ...byKey('accountId') }, person)).data.map(
        (object) => [object['accountId'], object['lowerQuartile'], object['spread']],
      );

    expect((await read('one'))[0]).toEqual(['acc-1', 12.875, '94.75']);

    expect((await read('two'))[0]).toEqual(['acc-1', 100, '0.00']);
  });

  it(`${SECURITY}: a request derived property that reads an Object Type derived property gets the policies of that property`, async () => {
    const set = wire(accounts().withProperties(derived({ owed: (b) => b.selectProperty('balance').negate() })));

    expect(await values(set, 'owed', 'one')).toEqual({ 'acc-1': '-125.75', 'acc-2': '-8.25', 'acc-3': 'absent' });

    expect(await values(set, 'owed', 'two')).toEqual({ 'acc-1': '-100.00', 'acc-2': '-8.25', 'acc-3': 'absent' });
  });

  it(`${SECURITY}: a hop through a Link side that the reader cannot see gets 404 LinkTypeNotFound`, async () => {
    const set = wire(
      transactions().withProperties(derived({ categoryName: (b) => b.pivotTo('category').selectProperty('name') })),
    );

    expect(await values(set, 'categoryName', 'one')).toMatchObject({ 'tx-1': 'Food', 'tx-3': 'Rent' });

    expect(await post('objectSets/loadObjects', { objectSet: set }, 'two')).toMatchObject({
      status: 404,
      body: { errorName: 'LinkTypeNotFound', parameters: { objectType: TRANSACTION, linkType: 'category' } },
    });
  });
});

describe(`${READS}: the stock client reads a request derived property and parses the answer`, () => {
  function client(person: Person, sent: Json[] = []) {
    return createClient(
      'http://localhost',
      ONTOLOGY.split('/').at(-1) ?? '',
      async () => 'token',
      undefined,
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;

        if (body) sent.push(body);

        const answer = await service.call(
          init?.method === 'POST' ? 'POST' : 'GET',
          `${url.pathname}${url.search}`,
          body,
          PEOPLE[person],
        );

        return new Response(answer.text, {
          status: answer.status,
          headers: { 'content-type': answer.contentType ?? 'application/json' },
        });
      },
    );
  }

  it(`${READS}: withProperties, where, and $orderBy with no $select give the value on each Object`, async () => {
    const sent: Json[] = [];

    const page = await client(
      'one',
      sent,
    )(objectType(ACCOUNT))
      .withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      )
      .where({ clearedBalance: { $gt: 1.5 } })
      .fetchPage({ $orderBy: { clearedBalance: 'desc' } });

    expect(page.data.map((object) => [object.$primaryKey, ({ ...object } as Row)['clearedBalance']])).toEqual([
      ['acc-1', '105.25'],
    ]);

    expect(sent.at(-1)).toMatchObject({
      objectSet: { type: 'filter', objectSet: { type: 'withProperties' } },
      selectV2: [],
      orderBy: { fields: [{ field: 'clearedBalance', direction: 'desc' }] },
    });
  });

  it(`${READS}: a $select of a request derived property gives only it`, async () => {
    const page = await client('two')(objectType(ACCOUNT))
      .withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      )
      .fetchPage({ $select: ['clearedBalance'] as never[] });

    expect(page.data.map((object) => [object.$primaryKey, ({ ...object } as Row)['clearedBalance']])).toEqual([
      ['acc-1', '100.00'],
      ['acc-2', '1.25'],
      ['acc-3', undefined],
    ]);
  });

  it(`${READS}: an aggregate of a request derived value`, async () => {
    const sent: Json[] = [];

    const result = await client(
      'one',
      sent,
    )(objectType(ACCOUNT))
      .withProperties(
        derived({
          clearedBalance: (b) =>
            b
              .pivotTo('transactions')
              .where({ status: { $eq: 'cleared' } })
              .aggregate('amount:sum'),
        }),
      )
      .aggregate({ $select: { 'clearedBalance:sum': 'unordered', $count: 'unordered' } } as never);

    expect(result).toMatchObject({ clearedBalance: { sum: '106.50' }, $count: 3 });

    expect(sent.at(-1)).toMatchObject({
      objectSet: { type: 'withProperties' },
      aggregation: [{ type: 'sum', field: 'clearedBalance' }, { type: 'count' }],
    });
  });
});

describe('ontology/object-link-types/derived-properties#cost: a request derived value runs only where a read uses it', () => {
  it('ontology/object-link-types/derived-properties#cost: a value that no read names is not in the SQL, and a value that only the select names is in the page projection', async () => {
    const set = wire(
      accounts().withProperties(
        derived({
          unused: (b) => b.pivotTo('transactions').aggregate('$count'),
          shown: (b) => b.pivotTo('engagements').aggregate('$count'),
        }),
      ),
    );

    const { db, statements } = recording();

    await load({ objectSet: set, select: ['name'] }, 'one', db);

    await load({ objectSet: set, select: ['shown'] }, 'one', db);

    const [none, shown] = statements.map((statement) => statement.text);

    expect(none).not.toMatch(/LATERAL|"transaction"|"engagement"/i);
    expect(shown).not.toMatch(/LEFT JOIN LATERAL|"transaction"/i);
    expect(shown).toMatch(/"engagement"/);
  });
});

describe(`${COST}: each derived value of a layer is computed 1 time in the source of its layer, so the SQL grows linearly with the request`, () => {
  const property = (apiName: string) => ({ type: 'property', apiName });
  const counted = (name: string) => withProperties({ [name]: selection(around('transactions'), { type: 'count' }) });

  function doubled(depth: number): Json {
    let set: Json = counted('v0');

    for (let k = 1; k <= depth; k += 1)
      set = withProperties(
        { [`v${k}`]: { type: 'add', properties: [property(`v${k - 1}`), property(`v${k - 1}`)] } },
        set,
      );

    return set;
  }

  async function linear(read: (depth: number, db: Db) => Promise<unknown>): Promise<unknown> {
    const sizes: { text: number; values: number }[] = [];
    let answer: unknown;

    for (const depth of [0, 4, 8, 12]) {
      const { db, statements } = recording();

      answer = await read(depth, db);

      expect(statements).toHaveLength(1);

      sizes.push({ text: statements[0]?.text.length ?? 0, values: statements[0]?.values.length ?? 0 });

      const [base, first, previous, size] = sizes.slice(0, 2).concat(sizes.slice(-2));

      if (sizes.length < 3 || !base || !first || !previous || !size) continue;

      expect(size.text - previous.text, `the SQL text from depth ${depth - 4} to ${depth}`).toBeLessThanOrEqual(
        1.5 * (first.text - base.text),
      );

      expect(
        size.values - previous.values,
        `the bind parameters from depth ${depth - 4} to ${depth}`,
      ).toBeLessThanOrEqual(1.5 * (first.values - base.values));
    }

    return answer;
  }

  const expected = { 'acc-1': 3 * 4096, 'acc-2': 2 * 4096, 'acc-3': 0 };

  const positive = (set: Json, name: string) => ({
    type: 'filter',
    objectSet: set,
    where: { type: 'gt', field: name, value: 0 },
  });

  it(`${COST}: a select of v12, where each of 12 layers reads its inner value 2 times, gives 4096 times the count, and its SQL grows linearly with the depth`, async () => {
    const page = (await linear((depth, db) =>
      load({ objectSet: doubled(depth), select: [`v${depth}`] }, 'one', db),
    )) as Page;

    expect(valuesOf(page, 'v12')).toEqual(expected);
  });

  it(`${COST}: a where, an orderBy, and an aggregate on v12 each give the right answer, and their SQL grows linearly with the depth`, async () => {
    const filtered = (await linear((depth, db) =>
      load({ objectSet: positive(doubled(depth), `v${depth}`), select: ['name'] }, 'one', db),
    )) as Page;

    expect(filtered.data.map((object) => object['__primaryKey'] as string).sort()).toEqual(['acc-1', 'acc-2']);

    const ordered = (await linear((depth, db) =>
      load({ objectSet: doubled(depth), select: ['name'], ...byKey(`v${depth}`) }, 'one', db),
    )) as Page;

    expect(ordered.data.map((object) => object['__primaryKey'])).toEqual(['acc-3', 'acc-2', 'acc-1']);

    const aggregated = await linear(async (depth, db) => {
      const answer = await post(
        'objectSets/aggregate',
        { objectSet: doubled(depth), aggregation: [{ type: 'sum', field: `v${depth}`, name: 'total' }] },
        'one',
        db,
      );

      expect(answer.status, JSON.stringify(answer.body)).toBe(200);

      return answer.body;
    });

    expect(aggregated).toMatchObject({ data: [{ metrics: [{ name: 'total', value: 5 * 4096 }] }] });
  });

  it(`${COST}: a load whose select, where, and orderBy all read v12 gives the right values, and its SQL grows linearly with the depth`, async () => {
    const page = (await linear((depth, db) =>
      load(
        { objectSet: positive(doubled(depth), `v${depth}`), select: [`v${depth}`], ...byKey(`v${depth}`) },
        'one',
        db,
      ),
    )) as Page;

    expect(page.data.map((object) => [object['__primaryKey'], object['v12']])).toEqual([
      ['acc-2', expected['acc-2']],
      ['acc-1', expected['acc-1']],
    ]);
  });

  it(`${COST}: a value that 3 other values each read is computed 1 time, so the SQL reads Transaction as often as for 1 reader`, async () => {
    const readers = {
      x: { type: 'add', properties: [property('c'), property('c')] },
      y: { type: 'multiply', properties: [property('c'), property('c')] },
      z: { type: 'greatest', properties: [property('c'), property('c')] },
    };

    const set = withProperties(readers, counted('c'));
    const { db, statements } = recording();

    await load({ objectSet: set, select: ['x'], ...byKey('accountId') }, 'one', db);

    const page = await load({ objectSet: set, select: ['x', 'y', 'z'], ...byKey('accountId') }, 'one', db);

    expect(page.data.map((object) => [object['__primaryKey'], object['x'], object['y'], object['z']])).toEqual([
      ['acc-1', 6, 9, 3],
      ['acc-2', 4, 4, 2],
      ['acc-3', 0, 0, 0],
    ]);

    const [one, three] = statements.map((statement) => statement.text.match(/"transaction"/g)?.length ?? 0);

    expect(three).toBe(one);
  });
});

describe(`${COST}: Postgres plans and runs each request derived value 1 time, so the time of a read grows linearly with the request`, () => {
  const property = (apiName: string) => ({ type: 'property', apiName });
  const add = (...names: string[]) => ({ type: 'add', properties: names.map(property) });
  const count = () => selection(around('transactions'), { type: 'count' });

  const cleared = () =>
    selection(
      { type: 'filter', objectSet: around('transactions'), where: { type: 'eq', field: 'status', value: 'cleared' } },
      { type: 'count' },
    );

  const unitsSum = () => selection(around('transactions'), { type: 'sum', selectedPropertyApiName: 'units' });

  const positive = (set: Json, name: string) => ({
    type: 'filter',
    objectSet: set,
    where: { type: 'gte', field: name, value: 0 },
  });

  function layered(depth: number, first: Json, next: (k: number) => Json): Json {
    let set: Json = withProperties(first);

    for (let k = 1; k <= depth; k += 1) set = withProperties(next(k), set);

    return set;
  }

  const doubled = (depth: number) =>
    layered(depth, { v0: count() }, (k) => ({ [`v${k}`]: add(`v${k - 1}`, `v${k - 1}`) }));

  let reader: ReturnType<typeof poolDb>;

  beforeAll(() => {
    reader = poolDb(service.url);
  });

  afterAll(() => reader.pool.end());

  const read = (body: object) => load(body, 'one', reader.db);
  const send = (path: string, body: object) => post(path, body, 'one', reader.db);

  async function linearTime(sizes: readonly number[], read: (size: number) => Promise<void>): Promise<void> {
    let previous: { size: number; ms: number } | undefined;

    for (const size of sizes) {
      let ms = Number.POSITIVE_INFINITY;

      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();

        await read(size);

        ms = Math.min(ms, performance.now() - started);
      }

      if (previous)
        expect(
          ms,
          `the read at size ${size} after ${previous.ms.toFixed(1)} ms at size ${previous.size}`,
        ).toBeLessThanOrEqual(2 * (size / previous.size) * previous.ms + 150);

      previous = { size, ms };
    }
  }

  it(`${COST}: each of 8, 16, 24, and 32 layers reads its inner value 2 times: 24 layers give 2^24 times the count, and 32 layers overflow the Integer with 400`, async () => {
    const expectedByDepth: Readonly<Record<number, object>> = {
      8: { status: 200, values: { 'acc-1': 3 * 2 ** 8, 'acc-2': 2 * 2 ** 8, 'acc-3': 0 } },
      16: { status: 200, values: { 'acc-1': 3 * 2 ** 16, 'acc-2': 2 * 2 ** 16, 'acc-3': 0 } },
      24: { status: 200, values: { 'acc-1': 3 * 2 ** 24, 'acc-2': 2 * 2 ** 24, 'acc-3': 0 } },
      32: {
        status: 400,
        errorName: 'Default:InvalidArgument',
        parameters: { field: 'derivedProperties' },
      },
    };

    await linearTime([8, 16, 24, 32], async (depth) => {
      const answer = await send('objectSets/loadObjects', {
        excludeRid: true,
        objectSet: doubled(depth),
        select: [`v${depth}`],
      });

      const actual =
        answer.status === 200
          ? { status: answer.status, values: valuesOf(answer.body as Page, `v${depth}`) }
          : {
              status: answer.status,
              errorName: (answer.body as { errorName?: unknown }).errorName,
              parameters: (answer.body as { parameters?: unknown }).parameters,
            };

      expect(actual, JSON.stringify(answer.body)).toEqual(expectedByDepth[depth]);
    });
  });

  it(`${COST}: each of 12 layers reads its inner value 2 times and adds its own hop count, and a where reads the last value`, async () => {
    const hopping = (depth: number) =>
      layered(depth, { h0: count() }, (k) => ({
        [`h${k}`]: { type: 'add', properties: [property(`h${k - 1}`), property(`h${k - 1}`), cleared()] },
      }));

    const counts = { 'acc-1': [3, 2], 'acc-2': [2, 1], 'acc-3': [0, 0] } as const;

    await linearTime([2, 4, 6, 8, 12], async (depth) => {
      const page = await read({ objectSet: positive(hopping(depth), `h${depth}`), select: [`h${depth}`] });

      expect(valuesOf(page, `h${depth}`)).toEqual(
        Object.fromEntries(
          Object.entries(counts).map(([key, [all, clear]]) => [key, 2 ** depth * all + (2 ** depth - 1) * clear]),
        ),
      );
    });
  });

  it(`${COST}: 3 values in each layer that each read the 3 values of the layer before`, async () => {
    const ops = (k: number) => add(`a${k - 1}`, `b${k - 1}`, `c${k - 1}`);

    const diamond = (depth: number) =>
      layered(depth, { a0: count(), b0: count(), c0: count() }, (k) => ({
        [`a${k}`]: ops(k),
        [`b${k}`]: ops(k),
        [`c${k}`]: ops(k),
      }));

    await linearTime([4, 8], async (depth) => {
      expect(valuesOf(await read({ objectSet: diamond(depth), select: [`a${depth}`] }), `a${depth}`)).toEqual({
        'acc-1': 3 ** (depth + 1),
        'acc-2': 2 * 3 ** depth,
        'acc-3': 0,
      });
    });
  });

  it(`${COST}: a greatest of 20 reads of the value of the layer before`, async () => {
    const wide = (depth: number) =>
      layered(depth, { g0: count() }, (k) => ({
        [`g${k}`]: { type: 'greatest', properties: Array.from({ length: 20 }, () => property(`g${k - 1}`)) },
      }));

    await linearTime([4, 8], async (depth) => {
      expect(valuesOf(await read({ objectSet: wide(depth), select: [`g${depth}`] }), `g${depth}`)).toEqual({
        'acc-1': 3,
        'acc-2': 2,
        'acc-3': 0,
      });
    });
  });

  it(`${COST}: a value that the select, a where, an orderBy, and an aggregate all read`, async () => {
    await linearTime([6, 12], async (depth) => {
      const page = await read({
        objectSet: positive(doubled(depth), `v${depth}`),
        select: [`v${depth}`],
        ...byKey(`v${depth}`),
      });

      expect(page.data.map((object) => [object['__primaryKey'], object[`v${depth}`]])).toEqual([
        ['acc-3', 0],
        ['acc-2', 2 * 2 ** depth],
        ['acc-1', 3 * 2 ** depth],
      ]);

      const answer = await send('objectSets/aggregate', {
        objectSet: positive(doubled(depth), `v${depth}`),
        aggregation: [{ type: 'sum', field: `v${depth}`, name: 'total' }],
        groupBy: [{ type: 'exact', field: `v${depth - 1}` }],
      });

      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect((answer.body as { data: unknown[] }).data).toHaveLength(3);
    });
  });

  it(`${COST}: 2 values in each layer that each read both values of the layer before`, async () => {
    const pair = (depth: number) =>
      layered(depth, { p0: count(), q0: unitsSum() }, (k) => ({
        [`p${k}`]: add(`p${k - 1}`, `q${k - 1}`),
        [`q${k}`]: { type: 'subtract', left: property(`q${k - 1}`), right: property(`p${k - 1}`) },
      }));

    const start = await read({ objectSet: pair(0), select: ['p0', 'q0'] });

    await linearTime([4, 8], async (depth) => {
      const page = await read({ objectSet: pair(depth), select: [`p${depth}`, `q${depth}`] });

      expect(page.data.map((object) => [object['__primaryKey'], object[`p${depth}`], object[`q${depth}`]])).toEqual(
        start.data.map((object) => {
          let [p, q] = [object['p0'] as number, object['q0'] as number | undefined];

          for (let k = 1; k <= depth; k += 1) [p, q] = q === undefined ? [p, q] : [p + q, q - p];

          return q === undefined ? [object['__primaryKey'], undefined, undefined] : [object['__primaryKey'], p, q];
        }),
      );
    });
  });

  it(`${COST}: a Decimal divide whose right operand is a divide, nested 4 and 10 times in 1 value`, async () => {
    const nested = (n: number): Json =>
      n === 0 ? property('budget') : { type: 'divide', left: property('budget'), right: nested(n - 1) };

    await linearTime([4, 10], async (depth) => {
      expect(
        valuesOf(
          await read({
            objectSet: withProperties({ q: nested(depth) }, { type: 'base', objectType: CATEGORY }),
            select: ['q'],
          }),
          'q',
        ),
      ).toEqual({ 'cat-1': '150.00', 'cat-2': '10.00', 'cat-3': '50.00' });
    });
  });

  it(`${COST}: a value that reads the Object Type derived property transactionCount 20 times, and each later layer reads it again`, async () => {
    const many = (depth: number) =>
      layered(depth, { t0: add(...Array.from({ length: 20 }, () => 'transactionCount')) }, (k) => ({
        [`t${k}`]: add(`t${k - 1}`, `t${k - 1}`, 'transactionCount'),
      }));

    await linearTime([4, 8], async (depth) => {
      expect(valuesOf(await read({ objectSet: many(depth), select: [`t${depth}`] }), `t${depth}`)).toEqual({
        'acc-1': 20 * 3 * 2 ** depth + 3 * (2 ** depth - 1),
        'acc-2': 20 * 2 * 2 ** depth + 2 * (2 ** depth - 1),
        'acc-3': 0,
      });
    });
  });

  it(`${COST}: 10 values in each of 32 layers, where each reads the 10 values of the layer before and adds its own hop count, give the right value`, async () => {
    const names = (k: number) => Array.from({ length: 10 }, (_, i) => `w${k}i${i}`);
    const rates = () => selection(around('transactions'), { type: 'sum', selectedPropertyApiName: 'rate' });

    const wide = layered(32, Object.fromEntries(names(0).map((name) => [name, rates()])), (k) =>
      Object.fromEntries(
        names(k).map((name) => [name, { type: 'add', properties: [...names(k - 1).map(property), cleared()] }]),
      ),
    );

    const page = await read({ objectSet: wide, select: ['w32i0'] });

    expect(valuesOf(page, 'w32i0')).toEqual({
      'acc-1': 4.222222222222222e32,
      'acc-2': 2.111111111111111e32,
      'acc-3': 'absent',
    });
  });

  it(`${COST}: 400 hop counts in 1 layer give the right values`, async () => {
    const names = Array.from({ length: 400 }, (_, i) => `c${i}`);

    const page = await read({
      objectSet: withProperties(Object.fromEntries(names.map((name) => [name, cleared()]))),
      select: [],
    });

    expect(valuesOf(page, 'c399')).toEqual({ 'acc-1': 2, 'acc-2': 1, 'acc-3': 0 });
  });
});
