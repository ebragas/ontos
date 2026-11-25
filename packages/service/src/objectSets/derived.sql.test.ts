import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import { insertObjects, startActions, type ActionsService, type SendOptions } from '../actions/actions.test-utils.ts';
import { groupGrants } from '../policiesPeople.test-utils.ts';
import {
  ACCOUNT,
  TRANSACTION,
  CATEGORY,
  ENGAGEMENT,
  INVOICE,
  ROLE,
  ROLE_ASSIGNMENT,
  ONTOLOGY,
  ROLES,
  PEOPLE,
  type Person,
  addTyped,
  at,
  datasourceOf,
  derivedIr,
} from './derived.test-utils.ts';

function roleDistinctIr(): OntologyIr {
  const ir = derivedIr();
  const role = at(ir, 'ontology', 'objectTypes', ROLE);
  const mapping = at(datasourceOf(role, 'derived'), 'definition', 'aggregatedProperties', 'propertyTypeMapping');

  for (const [apiName, operation] of [
    ['personCount', 'exactCardinality'],
    ['personEstimate', 'approximateCardinality'],
  ] as const) {
    addTyped(
      role,
      apiName,
      { type: 'integer', integer: {} },
      at(role, 'objectType', 'propertyTypes', 'assignmentCount'),
    );

    mapping[apiName] = { type: operation, [operation]: { type: 'propertyType', propertyType: 'person' } };
  }

  return ir;
}

const IR = roleDistinctIr();
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

const ACCOUNTS = [
  { accountId: 'acc-1', name: 'Acme', entity: 'E1' },
  { accountId: 'acc-2', name: 'Globex', entity: 'E2' },
  { accountId: 'acc-3', name: 'Initech', entity: 'E3' },
  { accountId: 'acc-4', name: 'Hooli', entity: 'E4' },
];

const TRANSACTIONS = [
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
    amountViewer: '',
  },
  {
    transactionId: 'tx-3',
    accountId: 'acc-1',
    categoryId: 'cat-2',
    amount: '5.25',
    owner: 'user_x',
    amountViewer: 'user_x',
  },
  {
    transactionId: 'tx-4',
    accountId: 'acc-2',
    categoryId: 'cat-2',
    amount: '7.00',
    owner: 'user_two',
    amountViewer: 'user_two',
  },
  {
    transactionId: 'tx-5',
    accountId: 'acc-4',
    categoryId: 'cat-2',
    amount: '7.00',
    owner: 'user_two',
    amountViewer: 'user_two',
  },
];

async function seed(): Promise<void> {
  await insertObjects(service.db, ACCOUNT, ACCOUNTS);

  await insertObjects(service.db, TRANSACTION, TRANSACTIONS);

  await insertObjects(service.db, CATEGORY, [
    { categoryId: 'cat-1', name: 'Food', entity: 'C1' },
    { categoryId: 'cat-2', name: 'Rent', entity: 'C2' },
  ]);

  await insertObjects(service.db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'Build', owner: 'user_two' },
    { engagementId: 'eng-2', accountId: 'acc-2', title: 'Run', owner: 'user_x' },
  ]);

  await insertObjects(service.db, INVOICE, [
    { invoiceId: 'inv-1', engagementId: 'eng-1', total: '10.00' },
    { invoiceId: 'inv-2', engagementId: 'eng-1', total: '20.00' },
    { invoiceId: 'inv-3', engagementId: 'eng-2', total: '30.00' },
  ]);

  await insertObjects(service.db, ROLE, [
    { roleId: 'role-1', name: 'Owner' },
    { roleId: 'role-2', name: 'Viewer' },
  ]);

  await insertObjects(service.db, ROLE_ASSIGNMENT, [
    { assignmentId: 'ra-1', roleId: 'role-1', person: 'p1' },
    { assignmentId: 'ra-2', roleId: 'role-1', person: 'p2' },
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
  body: object,
  person: Person,
  db?: Db,
  settings?: SendOptions['settings'],
): Promise<{ status: number; body: unknown }> {
  const answer = await service.call('POST', `${ONTOLOGY}/${path}`, body, {
    ...PEOPLE[person],
    ...(db ? { db } : {}),
    ...(settings ? { settings } : {}),
  });

  return { status: answer.status, body: JSON.parse(answer.text) as unknown };
}

async function load(body: object, person: Person = 'one', db?: Db, settings?: SendOptions['settings']): Promise<Page> {
  const answer = await post('objectSets/loadObjects', { excludeRid: true, ...body }, person, db, settings);

  expect(answer.status, JSON.stringify(answer.body)).toBe(200);

  return answer.body as Page;
}

async function aggregate(body: object, person: Person = 'one'): Promise<unknown> {
  const answer = await post('objectSets/aggregate', body, person);

  expect(answer.status, JSON.stringify(answer.body)).toBe(200);

  return answer.body;
}

const base = (objectType: string) => ({ type: 'base', objectType });
const filter = (objectSet: object, where: object) => ({ type: 'filter', objectSet, where });
const byKey = (field: string) => ({ orderBy: { fields: [{ field, direction: 'asc' }] } });

function valuesOf(page: Page, property: string): Record<string, unknown> {
  return Object.fromEntries(
    page.data.map((object) => [String(object['__primaryKey']), property in object ? object[property] : 'absent']),
  );
}

describe('ontology/object-link-types/derived-properties#reads: a load returns an Object Type derived property by select or by the request flag', () => {
  it('ontology/object-link-types/derived-properties#reads: a select that names balance gives the sum of the Transactions of each Account', async () => {
    const page = await load({ objectSet: base(ACCOUNT), select: ['name', 'balance'], ...byKey('accountId') });

    expect(page.data).toEqual([
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-1',
        __title: 'Acme',
        accountId: 'acc-1',
        name: 'Acme',
        balance: '125.75',
      },
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-2',
        __title: 'Globex',
        accountId: 'acc-2',
        name: 'Globex',
        balance: '7.00',
      },
      { __apiName: ACCOUNT, __primaryKey: 'acc-3', __title: 'Initech', accountId: 'acc-3', name: 'Initech' },
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-4',
        __title: 'Hooli',
        accountId: 'acc-4',
        name: 'Hooli',
        balance: '7.00',
      },
    ]);
  });

  it('ontology/object-link-types/derived-properties#reads: with no select and no request flag, a load gives no derived property', async () => {
    const page = await load({ objectSet: base(ACCOUNT), select: [], ...byKey('accountId') });

    expect(page.data[0]).toEqual({
      __apiName: ACCOUNT,
      __primaryKey: 'acc-1',
      __title: 'Acme',
      accountId: 'acc-1',
      name: 'Acme',
      entity: 'E1',
    });

    expect(page.data.every((object) => !('balance' in object) && !('transactionCount' in object))).toBe(true);
  });

  it('ontology/object-link-types/derived-properties#reads: loadOntologyDefinedDerivedProperties true gives each derived property, and false gives none', async () => {
    const all = await load({
      objectSet: base(ACCOUNT),
      select: [],
      loadOntologyDefinedDerivedProperties: true,
      ...byKey('accountId'),
    });

    expect(all.data[0]).toEqual({
      __apiName: ACCOUNT,
      __primaryKey: 'acc-1',
      __title: 'Acme',
      accountId: 'acc-1',
      name: 'Acme',
      entity: 'E1',
      balance: '125.75',
      transactionCount: 3,
      transactionIds: ['tx-1', 'tx-2'],
      categoryIds: ['cat-1', 'cat-2'],
      averageAmount: '41.92',
      minAmount: '5.25',
      maxAmount: '100.00',
      categoryCount: 2,
      categoryEstimate: 2,
    });

    const none = await load({
      objectSet: base(ACCOUNT),
      select: [],
      loadOntologyDefinedDerivedProperties: false,
      ...byKey('accountId'),
    });

    expect(none.data[0]).toEqual({
      __apiName: ACCOUNT,
      __primaryKey: 'acc-1',
      __title: 'Acme',
      accountId: 'acc-1',
      name: 'Acme',
      entity: 'E1',
    });
  });

  it('ontology/object-link-types/derived-properties#reads: the request flag must be a Boolean', async () => {
    const answer = await post(
      'objectSets/loadObjects',
      { objectSet: base(ACCOUNT), loadOntologyDefinedDerivedProperties: 'yes' },
      'one',
    );

    expect(answer).toMatchObject({
      status: 400,
      body: { errorName: 'Default:InvalidArgument', parameters: { field: 'loadOntologyDefinedDerivedProperties' } },
    });
  });

  it('ontology/object-link-types/derived-properties#cost: a load whose select does not name balance has no derived value in its SQL', async () => {
    const { db, statements } = recording();

    await load({ objectSet: base(ACCOUNT), select: ['name'] }, 'one', db);

    await load(
      {
        objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'name', value: 'Acme' }),
        select: [],
        orderBy: { fields: [{ field: 'name' }] },
      },
      'one',
      db,
    );

    expect(statements).toHaveLength(2);

    for (const statement of statements) expect(statement.text).not.toMatch(/LATERAL|__d\d|transaction/i);
  });
});

describe('ontology/object-link-types/derived-properties#reads: the deployment setting loadDerivedProperties and the request flag give the return rule of a load', () => {
  const READS = 'ontology/object-link-types/derived-properties#reads';

  const DERIVED = [
    'balance',
    'transactionCount',
    'transactionIds',
    'categoryIds',
    'averageAmount',
    'minAmount',
    'maxAmount',
    'categoryCount',
    'categoryEstimate',
  ];

  const around = { type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'transactions' };

  const requestSet = {
    type: 'withProperties',
    objectSet: base(ACCOUNT),
    derivedProperties: { requestCount: { type: 'selection', objectSet: around, operation: { type: 'count' } } },
  };

  const firstKeys = async (body: object, settings: SendOptions['settings']) =>
    Object.keys((await load({ select: [], ...byKey('accountId'), ...body }, 'one', undefined, settings)).data[0] ?? {});

  const derivedIn = (keys: string[]) => DERIVED.filter((name) => keys.includes(name));
  const withNoDerived = (keys: string[]) => DERIVED.every((name) => !keys.includes(name));

  it.each([
    ['request flag absent, setting off', {}, undefined, []],
    ['request flag absent, setting on', {}, { loadDerivedProperties: true } as const, DERIVED],
    ['request flag true, setting off', { loadOntologyDefinedDerivedProperties: true }, undefined, DERIVED],
    [
      'request flag true, setting on',
      { loadOntologyDefinedDerivedProperties: true },
      { loadDerivedProperties: true } as const,
      DERIVED,
    ],
    ['request flag false, setting off', { loadOntologyDefinedDerivedProperties: false }, undefined, []],
    [
      'request flag false, setting on',
      { loadOntologyDefinedDerivedProperties: false },
      { loadDerivedProperties: true } as const,
      [],
    ],
  ])(
    `${READS}: with an empty select and %s, the return of each Object Type derived property is as the rule says`,
    async (_state, flag, settings, expectedDerived) => {
      const keys = await firstKeys({ objectSet: base(ACCOUNT), ...flag }, settings);

      expect(derivedIn(keys)).toEqual(expectedDerived);
      expect(keys).toEqual(expect.arrayContaining(['accountId', 'name', 'entity']));
    },
  );

  it.each([
    ['request flag absent, setting off', {}, undefined],
    ['request flag absent, setting on', {}, { loadDerivedProperties: true } as const],
    [
      'request flag false, setting on',
      { loadOntologyDefinedDerivedProperties: false },
      { loadDerivedProperties: true } as const,
    ],
    ['request flag true, setting off', { loadOntologyDefinedDerivedProperties: true }, undefined],
    [
      'request flag true, setting on',
      { loadOntologyDefinedDerivedProperties: true },
      { loadDerivedProperties: true } as const,
    ],
  ])(
    `${READS}: a select that names balance gives only the named Properties, with %s`,
    async (_state, flag, settings) => {
      const page = await load(
        { objectSet: base(ACCOUNT), select: ['name', 'balance'], ...flag, ...byKey('accountId') },
        'one',
        undefined,
        settings,
      );

      expect(Object.keys(page.data[0] ?? {}).sort()).toEqual([
        '__apiName',
        '__primaryKey',
        '__title',
        'accountId',
        'balance',
        'name',
      ]);
    },
  );

  it.each([
    ['setting off', undefined],
    ['setting on', { loadDerivedProperties: true } as const],
  ])(
    `${READS}: a select that names a stored Property gives no Object Type derived property, with %s`,
    async (_state, settings) => {
      const keys = await firstKeys({ objectSet: base(ACCOUNT), select: ['name'] }, settings);

      expect(withNoDerived(keys)).toBe(true);
    },
  );

  it.each([
    ['the setting off and no flag', {}, undefined, []],
    ['the setting on and no flag', {}, { loadDerivedProperties: true } as const, DERIVED],
    [
      'the setting on and flag false',
      { loadOntologyDefinedDerivedProperties: false },
      { loadDerivedProperties: true } as const,
      [],
    ],
    ['the setting off and flag true', { loadOntologyDefinedDerivedProperties: true }, undefined, DERIVED],
  ])(
    `${READS}: a withProperties set with an empty select gives its request derived property, and the Object Type derived properties by the rule, with %s`,
    async (_state, flag, settings, expectedDerived) => {
      const keys = await firstKeys({ objectSet: requestSet, ...flag }, settings);

      expect(keys).toContain('requestCount');
      expect(derivedIn(keys)).toEqual(expectedDerived);
    },
  );
});

describe('ontology/object-link-types/derived-properties#reads: a where, an orderBy, and a page token read a derived value', () => {
  const keys = async (where: object, person: Person = 'one') =>
    (
      await load({ objectSet: filter(base(ACCOUNT), where), select: ['accountId'], ...byKey('accountId') }, person)
    ).data.map((object) => object['accountId']);

  it('ontology/object-link-types/derived-properties#reads: a where on balance by field or by propertyIdentifier keeps the Objects whose value matches', async () => {
    expect(await keys({ type: 'gt', field: 'balance', value: 10 })).toEqual(['acc-1']);

    expect(
      await keys({ type: 'lte', propertyIdentifier: { type: 'property', apiName: 'balance' }, value: '7.00' }),
    ).toEqual(['acc-2', 'acc-4']);

    expect(await keys({ type: 'eq', field: 'balance', value: '125.75' })).toEqual(['acc-1']);

    expect(await keys({ type: 'isNull', field: 'balance', value: true })).toEqual(['acc-3']);

    expect(await keys({ type: 'in', field: 'balance', value: ['7.00', '1.00'] })).toEqual(['acc-2', 'acc-4']);

    expect(
      await keys({
        type: 'and',
        value: [
          { type: 'gte', field: 'transactionCount', value: 1 },
          { type: 'lt', field: 'balance', value: 100 },
        ],
      }),
    ).toEqual(['acc-2', 'acc-4']);

    expect(await keys({ type: 'not', value: { type: 'eq', field: 'transactionCount', value: 0 } })).toEqual([
      'acc-1',
      'acc-2',
      'acc-4',
    ]);
  });

  it('ontology/object-link-types/derived-properties#reads: a where on a linked String value takes eq, in, and isNull', async () => {
    const transactions = async (where: object) =>
      (
        await load({
          objectSet: filter(base(TRANSACTION), where),
          select: ['transactionId'],
          ...byKey('transactionId'),
        })
      ).data.map((object) => object['transactionId']);

    expect(await transactions({ type: 'eq', field: 'accountEntity', value: 'E1' })).toEqual(['tx-1', 'tx-2', 'tx-3']);

    expect(await transactions({ type: 'in', field: 'categoryEntity', value: ['C2'] })).toEqual([
      'tx-3',
      'tx-4',
      'tx-5',
    ]);

    expect(await transactions({ type: 'isNull', field: 'accountEntity', value: false })).toEqual([
      'tx-1',
      'tx-2',
      'tx-3',
      'tx-4',
      'tx-5',
    ]);
  });

  it('ontology/object-link-types/derived-properties#reads: an orderBy on balance over 2 pages gives each Object 1 time, and a tie goes to the primary key', async () => {
    const body = {
      objectSet: base(ACCOUNT),
      select: ['balance'],
      orderBy: { fields: [{ field: 'balance', direction: 'desc' }] },
      pageSize: 2,
    };

    const first = await load(body);

    expect(first.data.map((object) => [object['accountId'], object['balance']])).toEqual([
      ['acc-1', '125.75'],
      ['acc-2', '7.00'],
    ]);

    expect(typeof first.nextPageToken).toBe('string');

    const second = await load({ ...body, pageToken: first.nextPageToken });

    expect(second.data.map((object) => [object['accountId'], object['balance'] ?? null])).toEqual([
      ['acc-4', '7.00'],
      ['acc-3', null],
    ]);

    expect(second.nextPageToken).toBeUndefined();
    expect(second.totalCount).toBe('4');
  });

  it('ontology/object-link-types/derived-properties#reads: a derived value in a where, an orderBy, and the select of 1 load', async () => {
    const page = await load({
      objectSet: filter(base(ACCOUNT), { type: 'gt', field: 'transactionCount', value: 0 }),
      select: ['balance', 'transactionCount'],
      orderBy: { fields: [{ field: 'transactionCount', direction: 'desc' }, { field: 'balance' }] },
    });

    expect(page.data.map((object) => [object['accountId'], object['balance'], object['transactionCount']])).toEqual([
      ['acc-1', '125.75', 3],
      ['acc-2', '7.00', 1],
      ['acc-4', '7.00', 1],
    ]);

    expect(page.totalCount).toBe('3');
  });

  it('ontology/object-link-types/derived-properties#reads: a derived value of the target of a searchAround and of a set operation', async () => {
    const around = {
      type: 'searchAround',
      objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-1' }),
      link: 'transactions',
    };

    expect(
      valuesOf(
        await load({ objectSet: around, select: ['accountEntity'], ...byKey('transactionId') }),
        'accountEntity',
      ),
    ).toEqual({ 'tx-1': 'E1', 'tx-2': 'E1', 'tx-3': 'E1' });

    const union = {
      type: 'union',
      objectSets: [
        filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-1' }),
        filter(base(ACCOUNT), { type: 'gt', field: 'balance', value: 5 }),
      ],
    };

    expect(
      valuesOf(
        await load({
          objectSet: filter(union, { type: 'lt', field: 'balance', value: 100 }),
          select: ['balance'],
          ...byKey('accountId'),
        }),
        'balance',
      ),
    ).toEqual({ 'acc-2': '7.00', 'acc-4': '7.00' });
  });
});

describe('ontology/object-link-types/derived-properties#reads: an aggregate takes a derived property as a metric and as a group-by', () => {
  it('ontology/object-link-types/derived-properties#reads: a sum of balance in each group of an exact group-by on transactionCount', async () => {
    const answer = (await aggregate({
      objectSet: base(ACCOUNT),
      aggregation: [{ type: 'sum', field: 'balance', name: 'total' }, { type: 'count' }],
      groupBy: [{ type: 'exact', field: 'transactionCount' }],
    })) as { data: { group: Row; metrics: Row[] }[] };

    const groups = Object.fromEntries(
      answer.data.map((entry) => [String(entry.group['transactionCount']), entry.metrics]),
    );

    expect(groups).toEqual({
      '3': [
        { name: 'total', value: '125.75' },
        { name: 'count', value: 1 },
      ],
      '1': [
        { name: 'total', value: '14.00' },
        { name: 'count', value: 2 },
      ],
      '0': [{ name: 'total' }, { name: 'count', value: 1 }],
    });
  });

  it('ontology/object-link-types/derived-properties#reads: the avg, min, and max of balance are exact Decimal strings', async () => {
    const answer = await aggregate({
      objectSet: base(ACCOUNT),
      aggregation: [
        { type: 'avg', field: 'balance', name: 'avg' },
        { type: 'min', field: 'balance', name: 'min' },
        { type: 'max', field: 'balance', name: 'max' },
        { type: 'sum', field: 'transactionCount', name: 'transactions' },
      ],
      groupBy: [],
    });

    expect(answer).toEqual({
      accuracy: 'ACCURATE',
      data: [
        {
          group: {},
          metrics: [
            { name: 'avg', value: '46.58' },
            { name: 'min', value: '7.00' },
            { name: 'max', value: '125.75' },
            { name: 'transactions', value: 5 },
          ],
        },
      ],
    });
  });
});

describe('ontology/object-link-types/derived-properties#operations: the value over no linked Object, and a linked value', () => {
  it('ontology/object-link-types/derived-properties#operations: a count over no linked Object is 0, and a sum over none is null, so the load leaves it out', async () => {
    const page = await load({
      objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-3' }),
      select: ['balance', 'transactionCount'],
    });

    expect(page.data).toEqual([{ __apiName: ACCOUNT, __primaryKey: 'acc-3', accountId: 'acc-3', transactionCount: 0 }]);
  });

  it('ontology/object-link-types/derived-properties#operations: collectList keeps the primary key order up to its limit, and collectSet the distinct values in value order', async () => {
    const page = await load({
      objectSet: base(ACCOUNT),
      select: ['transactionIds', 'categoryIds'],
      ...byKey('accountId'),
    });

    expect(valuesOf(page, 'transactionIds')).toEqual({
      'acc-1': ['tx-1', 'tx-2'],
      'acc-2': ['tx-4'],
      'acc-3': 'absent',
      'acc-4': ['tx-5'],
    });

    expect(valuesOf(page, 'categoryIds')).toEqual({
      'acc-1': ['cat-1', 'cat-2'],
      'acc-2': ['cat-2'],
      'acc-3': 'absent',
      'acc-4': ['cat-2'],
    });

    const two = await load(
      {
        objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-1' }),
        select: ['transactionIds', 'categoryIds'],
      },
      'two',
    );

    expect(two.data).toEqual([
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-1',
        accountId: 'acc-1',
        transactionIds: ['tx-1', 'tx-2'],
        categoryIds: ['cat-1'],
      },
    ]);
  });

  it('ontology/object-link-types/derived-properties#operations: Invoice Account over 2 hops and the 2 entities of a Transaction give the linked value', async () => {
    expect(
      valuesOf(
        await load({ objectSet: base(INVOICE), select: ['invoiceAccount'], ...byKey('invoiceId') }),
        'invoiceAccount',
      ),
    ).toEqual({ 'inv-1': 'Acme', 'inv-2': 'Acme', 'inv-3': 'Globex' });

    const transactions = await load({
      objectSet: base(TRANSACTION),
      select: ['categoryEntity', 'accountEntity'],
      ...byKey('transactionId'),
    });

    expect(
      transactions.data.map((object) => [object['transactionId'], object['categoryEntity'], object['accountEntity']]),
    ).toEqual([
      ['tx-1', 'C1', 'E1'],
      ['tx-2', 'C1', 'E1'],
      ['tx-3', 'C2', 'E1'],
      ['tx-4', 'C2', 'E2'],
      ['tx-5', 'C2', 'E4'],
    ]);

    expect(
      valuesOf(
        await load({ objectSet: base(ENGAGEMENT), select: ['invoiceCount'], ...byKey('engagementId') }),
        'invoiceCount',
      ),
    ).toEqual({ 'eng-1': 2, 'eng-2': 1 });

    expect(
      valuesOf(
        await load({ objectSet: base(ROLE), select: ['assignmentCount'], ...byKey('roleId') }),
        'assignmentCount',
      ),
    ).toEqual({ 'role-1': 2, 'role-2': 0 });
  });
});

describe('ontology/object-link-types/derived-properties#reads: inside a hop, the derived properties of the target are not in scope', () => {
  it('ontology/object-link-types/derived-properties#reads: balance (Account to Transaction) and accountEntity (Transaction to Account) compute with no loop', async () => {
    const { db, statements } = recording();

    const accounts = await load(
      { objectSet: base(ACCOUNT), select: [], loadOntologyDefinedDerivedProperties: true, ...byKey('accountId') },
      'one',
      db,
    );

    expect(valuesOf(accounts, 'balance')).toEqual({
      'acc-1': '125.75',
      'acc-2': '7.00',
      'acc-3': 'absent',
      'acc-4': '7.00',
    });

    const transactions = await load(
      {
        objectSet: filter(base(TRANSACTION), { type: 'eq', field: 'accountEntity', value: 'E2' }),
        select: [],
        loadOntologyDefinedDerivedProperties: true,
      },
      'one',
      db,
    );

    expect(transactions.data).toEqual([
      {
        __apiName: TRANSACTION,
        __primaryKey: 'tx-4',
        __title: 'tx-4',
        transactionId: 'tx-4',
        accountId: 'acc-2',
        categoryId: 'cat-2',
        amount: '7.00',
        owner: 'user_two',
        amountViewer: 'user_two',
        categoryEntity: 'C2',
        accountEntity: 'E2',
      },
    ]);

    const [accountSql, transactionSql] = statements.map((statement) => statement.text);

    expect(accountSql).not.toMatch(/"category"|"categoryid"/i);
    expect(transactionSql).not.toMatch(/sum\(/i);
  });

  it('ontology/object-link-types/derived-properties#reads: a request hop filter on accountEntity, a derived property of its target, gets 404 PropertiesNotFound', async () => {
    const hop = filter(
      { type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'transactions' },
      { type: 'eq', field: 'accountEntity', value: 'E1' },
    );

    const derivedProperties = { selfCount: { type: 'selection', objectSet: hop, operation: { type: 'count' } } };

    const answer = await post(
      'objectSets/loadObjects',
      { objectSet: { type: 'withProperties', objectSet: base(ACCOUNT), derivedProperties }, select: ['selfCount'] },
      'one',
    );

    expect(answer).toMatchObject({
      status: 404,
      body: { errorName: 'PropertiesNotFound', parameters: { objectType: TRANSACTION, properties: ['accountEntity'] } },
    });
  });
});

describe('ontology/object-link-types/derived-properties#security: each hop reads only what the reader can see', () => {
  it('ontology/object-link-types/derived-properties#security: 2 readers get 2 balances of 1 Account: a hidden Transaction drops out, and a hidden amount is skipped', async () => {
    const one = await load(
      { objectSet: base(ACCOUNT), select: ['balance', 'transactionCount'], ...byKey('accountId') },
      'one',
    );

    const two = await load(
      { objectSet: base(ACCOUNT), select: ['balance', 'transactionCount'], ...byKey('accountId') },
      'two',
    );

    expect(valuesOf(one, 'balance')).toEqual({
      'acc-1': '125.75',
      'acc-2': '7.00',
      'acc-3': 'absent',
      'acc-4': '7.00',
    });

    expect(valuesOf(two, 'balance')).toEqual({
      'acc-1': '100.00',
      'acc-2': '7.00',
      'acc-3': 'absent',
      'acc-4': '7.00',
    });

    expect(valuesOf(one, 'transactionCount')).toEqual({ 'acc-1': 3, 'acc-2': 1, 'acc-3': 0, 'acc-4': 1 });
    expect(valuesOf(two, 'transactionCount')).toEqual({ 'acc-1': 2, 'acc-2': 1, 'acc-3': 0, 'acc-4': 1 });
  });

  it('ontology/object-link-types/derived-properties#security: a where, a sort, and an aggregate read the value of the reader', async () => {
    const where = { type: 'gte', field: 'balance', value: 100 };

    const keys = async (person: Person, value: number) =>
      (
        await load(
          { objectSet: filter(base(ACCOUNT), { ...where, value }), select: ['accountId'], ...byKey('accountId') },
          person,
        )
      ).data.map((object) => object['accountId']);

    expect(await keys('one', 120)).toEqual(['acc-1']);

    expect(await keys('two', 120)).toEqual([]);

    const sum = async (person: Person) =>
      aggregate(
        { objectSet: base(ACCOUNT), aggregation: [{ type: 'sum', field: 'balance', name: 'total' }], groupBy: [] },
        person,
      );

    expect(await sum('one')).toMatchObject({ data: [{ metrics: [{ name: 'total', value: '139.75' }] }] });

    expect(await sum('two')).toMatchObject({ data: [{ metrics: [{ name: 'total', value: '114.00' }] }] });
  });

  it('ontology/object-link-types/derived-properties#security: a hidden middle Object of a 2-hop path drops out', async () => {
    expect(
      valuesOf(
        await load({ objectSet: base(INVOICE), select: ['invoiceAccount'], ...byKey('invoiceId') }, 'two'),
        'invoiceAccount',
      ),
    ).toEqual({ 'inv-1': 'Acme', 'inv-2': 'Acme', 'inv-3': 'absent' });
  });

  it('ontology/object-link-types/derived-properties#security: a hop to an Object Type that the reader has no permission for gives 0 for a count, else null', async () => {
    expect(
      valuesOf(
        await load({ objectSet: base(ROLE), select: ['assignmentCount'], ...byKey('roleId') }, 'two'),
        'assignmentCount',
      ),
    ).toEqual({ 'role-1': 0, 'role-2': 0 });

    const transactions = await load(
      { objectSet: base(TRANSACTION), select: ['categoryEntity', 'accountEntity'], ...byKey('transactionId') },
      'two',
    );

    expect(
      transactions.data.map((object) => [
        object['transactionId'],
        object['categoryEntity'] ?? null,
        object['accountEntity'],
      ]),
    ).toEqual([
      ['tx-1', null, 'E1'],
      ['tx-2', null, 'E1'],
      ['tx-4', null, 'E2'],
      ['tx-5', null, 'E4'],
    ]);

    const counted = await aggregate(
      {
        objectSet: base(ROLE),
        aggregation: [{ type: 'count' }],
        groupBy: [{ type: 'exact', field: 'assignmentCount' }],
      },
      'two',
    );

    expect(counted).toMatchObject({
      data: [{ group: { assignmentCount: 0 }, metrics: [{ name: 'count', value: 2 }] }],
    });
  });

  it('ontology/object-link-types/derived-properties#security: a hop to an Object Type that the reader has no permission for gives 0 for an exactDistinct and an approximateDistinct, the same as over no linked Object', async () => {
    const select = ['personCount', 'personEstimate'];

    const admin = await load({ objectSet: base(ROLE), select, ...byKey('roleId') });

    expect(admin.data.map((object) => [object['roleId'], object['personCount'], object['personEstimate']])).toEqual([
      ['role-1', 2, 2],
      ['role-2', 0, 0],
    ]);

    const hidden = await load({ objectSet: base(ROLE), select, ...byKey('roleId') }, 'two');

    expect(hidden.data.map((object) => [object['roleId'], object['personCount'], object['personEstimate']])).toEqual([
      ['role-1', 0, 0],
      ['role-2', 0, 0],
    ]);
  });

  it('ontology/object-link-types/derived-properties#security: the Property of a hidden hop stays in the metadata of the reader', async () => {
    const role = await service.call('GET', `${ONTOLOGY}/objectTypes/${ROLE}`, undefined, PEOPLE.two);

    expect(role.status).toBe(200);

    expect((JSON.parse(role.text) as { properties: Row }).properties['assignmentCount']).toMatchObject({
      dataType: { type: 'integer' },
    });

    const transaction = await service.call('GET', `${ONTOLOGY}/objectTypes/${TRANSACTION}`, undefined, PEOPLE.two);

    expect((JSON.parse(transaction.text) as { properties: Row }).properties['categoryEntity']).toMatchObject({
      dataType: { type: 'string' },
    });
  });
});

describe('ontology/object-link-types/derived-properties#types: a Decimal derived value is exact', () => {
  it('ontology/object-link-types/derived-properties#types: a derived sum of a Decimal past 2^53 is an exact string', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-big', name: 'Big', entity: 'E9' }]);

    await insertObjects(service.db, TRANSACTION, [
      {
        transactionId: 'tx-big-1',
        accountId: 'acc-big',
        categoryId: 'cat-1',
        amount: '4503599627370497.01',
        owner: 'user_two',
        amountViewer: 'user_two',
      },
      {
        transactionId: 'tx-big-2',
        accountId: 'acc-big',
        categoryId: 'cat-1',
        amount: '4503599627370497.01',
        owner: 'user_two',
        amountViewer: 'user_two',
      },
    ]);

    const big = filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-big' });

    expect((await load({ objectSet: big, select: ['balance'] })).data).toEqual([
      { __apiName: ACCOUNT, __primaryKey: 'acc-big', accountId: 'acc-big', balance: '9007199254740994.02' },
    ]);

    expect(
      await aggregate({ objectSet: big, aggregation: [{ type: 'max', field: 'balance', name: 'max' }], groupBy: [] }),
    ).toMatchObject({ data: [{ metrics: [{ name: 'max', value: '9007199254740994.02' }] }] });
  });
});

const TYPES = 'ontology/object-link-types/derived-properties#types';

async function averageOf(amounts: readonly string[]): Promise<{ text: string; value: unknown }> {
  await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-avg', name: 'Avg', entity: 'E8' }]);

  await insertObjects(
    service.db,
    TRANSACTION,
    amounts.map((amount, index) => ({
      transactionId: `tx-avg-${index}`,
      accountId: 'acc-avg',
      categoryId: 'cat-1',
      amount,
      owner: 'user_two',
      amountViewer: 'user_two',
    })),
  );

  const body = {
    excludeRid: true,
    objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-avg' }),
    select: ['averageAmount'],
  };

  const answer = await service.call('POST', `${ONTOLOGY}/objectSets/loadObjects`, body, PEOPLE.one);

  expect(answer.status, answer.text).toBe(200);

  const [object] = (JSON.parse(answer.text) as Page).data;

  return { text: answer.text, value: object?.['averageAmount'] };
}

describe(`${TYPES}: a derived avg of a Decimal is a Decimal with the scale of the Property, rounded 1 time, half away from zero`, () => {
  it(`${TYPES}: the avg of the 3 amounts of acc-1 (100.00, 20.50, 5.25) is 41.9166... and gives "41.92"`, async () => {
    expect(
      valuesOf(
        await load({ objectSet: base(ACCOUNT), select: ['averageAmount'], ...byKey('accountId') }),
        'averageAmount',
      ),
    ).toEqual({ 'acc-1': '41.92', 'acc-2': '7.00', 'acc-3': 'absent', 'acc-4': '7.00' });
  });

  it(`${TYPES}: a positive half rounds up: 0.01 and 0.02 give "0.02"`, async () => {
    expect((await averageOf(['0.01', '0.02'])).value).toBe('0.02');
  });

  it(`${TYPES}: a positive half rounds up, also when the digit before it is even: 0.02 and 0.03 give "0.03"`, async () => {
    expect((await averageOf(['0.02', '0.03'])).value).toBe('0.03');
  });

  it(`${TYPES}: a negative half rounds away from zero: -0.01 and -0.02 give "-0.02"`, async () => {
    expect((await averageOf(['-0.01', '-0.02'])).value).toBe('-0.02');
  });

  it(`${TYPES}: a negative half rounds away from zero, also when the digit before it is even: -0.02 and -0.03 give "-0.03"`, async () => {
    expect((await averageOf(['-0.02', '-0.03'])).value).toBe('-0.03');
  });

  it(`${TYPES}: a value below a half rounds down: 0.01, 0.01, and 0.02 give "0.01"`, async () => {
    expect((await averageOf(['0.01', '0.01', '0.02'])).value).toBe('0.01');
  });

  it(`${TYPES}: the objectSets/aggregate avg of a derived avg of a Decimal past 2^53 is an exact string: 9007199254740993.01 and 9007199254740993.02 give "9007199254740993.02"`, async () => {
    await averageOf(['9007199254740993.01', '9007199254740993.02']);

    const big = filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-avg' });

    expect(
      await aggregate({
        objectSet: big,
        aggregation: [{ type: 'avg', field: 'averageAmount', name: 'avg' }],
        groupBy: [],
      }),
    ).toMatchObject({ data: [{ metrics: [{ name: 'avg', value: '9007199254740993.02' }] }] });
  });

  it(`${TYPES}: the avg leaves as a JSON string, not a number`, async () => {
    const { text, value } = await averageOf(['0.01', '0.02']);

    expect(typeof value).toBe('string');
    expect(text).toContain('"averageAmount":"0.02"');
  });
});

describe(`${TYPES}: the min, max, distinct count, and sum of a derived value keep the type of the Property`, () => {
  beforeEach(async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-typed', name: 'Typed', entity: 'E7' }]);

    await insertObjects(service.db, TRANSACTION, [
      {
        transactionId: 'tx-t1',
        accountId: 'acc-typed',
        categoryId: 'cat-1',
        amount: '10.00',
        postedOn: '2026-01-05',
        postedAt: '2026-01-05T10:00:00Z',
        units: 2,
        owner: 'user_two',
        amountViewer: 'user_two',
      },
      {
        transactionId: 'tx-t2',
        accountId: 'acc-typed',
        categoryId: 'cat-1',
        amount: '2.50',
        postedOn: '2025-12-31',
        postedAt: '2025-12-31T23:59:59Z',
        units: 3,
        owner: 'user_two',
        amountViewer: 'user_two',
      },
      {
        transactionId: 'tx-t3',
        accountId: 'acc-typed',
        categoryId: 'cat-2',
        amount: '7.25',
        postedOn: '2026-03-01',
        postedAt: '2026-03-01T00:00:00Z',
        units: 5,
        owner: 'user_two',
        amountViewer: 'user_two',
      },
    ]);
  });

  const typed = async (select: string[]) =>
    (await load({ objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-typed' }), select }))
      .data[0] ?? {};

  it(`${TYPES}: the min and max of a Decimal are Decimal strings with the scale of the Property`, async () => {
    expect(await typed(['minAmount', 'maxAmount'])).toMatchObject({ minAmount: '2.50', maxAmount: '10.00' });
  });

  it(`${TYPES}: the min and max of a Date are the earliest and the latest Date`, async () => {
    expect(await typed(['firstPostedOn', 'lastPostedOn'])).toMatchObject({
      firstPostedOn: '2025-12-31',
      lastPostedOn: '2026-03-01',
    });
  });

  it(`${TYPES}: the min and max of a Timestamp are the earliest and the latest Timestamp`, async () => {
    expect(await typed(['firstPostedAt', 'lastPostedAt'])).toMatchObject({
      firstPostedAt: '2025-12-31T23:59:59Z',
      lastPostedAt: '2026-03-01T00:00:00Z',
    });
  });

  it(`${TYPES}: exactDistinct and approximateDistinct count the 2 distinct categories of 3 Transactions, as Integer`, async () => {
    expect(await typed(['categoryCount', 'categoryEstimate'])).toMatchObject({ categoryCount: 2, categoryEstimate: 2 });
  });

  it(`${TYPES}: the sum of an Integer is a JSON number, and the metadata types it Double`, async () => {
    expect(await typed(['unitsTotal'])).toMatchObject({ unitsTotal: 10 });

    const metadata = await service.call('GET', `${ONTOLOGY}/objectTypes/${ACCOUNT}`, undefined, PEOPLE.one);

    expect((JSON.parse(metadata.text) as { properties: Row }).properties['unitsTotal']).toMatchObject({
      dataType: { type: 'double' },
    });
  });
});

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Actual Loops'?: number;
  readonly 'Subplan Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

async function planOf(body: object): Promise<PlanNode[]> {
  const { db, statements } = recording();

  await load(body, 'one', db);

  const [statement] = statements;

  if (!statement) throw new Error('The load ran no statement.');

  const [row] = await service.db.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>({
    text: `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
    values: statement.values,
  });

  const plan = row?.['QUERY PLAN'][0]?.Plan;

  if (!plan) throw new Error('EXPLAIN gave no plan.');

  return nodesOf(plan);
}

const transactionScans = (nodes: readonly PlanNode[]) =>
  nodes.filter((node) => node['Relation Name'] === 'transaction').map((node) => node['Actual Loops']);

const BULK = 30;
const PAGE_SIZE = 10;

describe('ontology/object-link-types/derived-properties#cost: a derived value runs only where a read uses it', () => {
  beforeEach(async () => {
    const accounts = Array.from({ length: BULK }, (_, index) => ({
      accountId: `bulk-${String(index).padStart(2, '0')}`,
      name: `Bulk ${String(index).padStart(2, '0')}`,
      entity: 'B',
    }));

    await insertObjects(service.db, ACCOUNT, accounts);

    await insertObjects(
      service.db,
      TRANSACTION,
      accounts.flatMap((account, index) =>
        [1, 2].map((n) => ({
          transactionId: `bulk-tx-${index}-${n}`,
          accountId: account.accountId,
          categoryId: 'cat-1',
          amount: `${n}.00`,
          owner: 'user_two',
          amountViewer: 'user_two',
        })),
      ),
    );
  });

  it('ontology/object-link-types/derived-properties#cost: a load that names no derived property reads no Transaction', async () => {
    expect(
      transactionScans(
        await planOf({
          objectSet: base(ACCOUNT),
          select: ['name'],
          orderBy: { fields: [{ field: 'name' }] },
          pageSize: PAGE_SIZE,
        }),
      ),
    ).toEqual([]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load that selects balance and sorts by name with a page of 10 runs the subquery only for the rows of the page', async () => {
    const scans = transactionScans(
      await planOf({
        objectSet: base(ACCOUNT),
        select: ['balance'],
        orderBy: { fields: [{ field: 'name' }] },
        pageSize: PAGE_SIZE,
      }),
    );

    expect(scans).toEqual([PAGE_SIZE + 1]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load that selects balance on a larger sorted set with pageSize 1 runs the subquery only for 2 rows', async () => {
    const extra = Array.from({ length: 1_000 }, (_, index) => ({
      accountId: `many-${String(index).padStart(4, '0')}`,
      name: `Many ${String(index).padStart(4, '0')}`,
      entity: 'M',
    }));

    await insertObjects(service.db, ACCOUNT, extra);

    await service.db.query({ text: 'ANALYZE', values: [] });

    const scans = transactionScans(
      await planOf({
        objectSet: base(ACCOUNT),
        select: ['balance'],
        orderBy: { fields: [{ field: 'name' }] },
        pageSize: 1,
      }),
    );

    expect(scans).toEqual([2]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load that selects a request expression over balance and sorts by name computes balance only for the rows of the page', async () => {
    const set = {
      type: 'withProperties',
      objectSet: base(ACCOUNT),
      derivedProperties: { owed: { type: 'negate', property: { type: 'property', apiName: 'balance' } } },
    };

    const scans = transactionScans(
      await planOf({ objectSet: set, select: ['owed'], orderBy: { fields: [{ field: 'name' }] }, pageSize: PAGE_SIZE }),
    );

    expect(scans).toEqual([PAGE_SIZE + 1]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load whose where, orderBy, and select read balance runs it 1 time for each row', async () => {
    const scans = transactionScans(
      await planOf({
        objectSet: filter(base(ACCOUNT), { type: 'gt', field: 'balance', value: 0 }),
        select: ['balance'],
        orderBy: { fields: [{ field: 'balance' }] },
        pageSize: PAGE_SIZE,
      }),
    );

    expect(scans).toEqual([ACCOUNTS.length + BULK]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load whose where alone reads balance runs it 1 time for each row', async () => {
    const scans = transactionScans(
      await planOf({
        objectSet: filter(base(ACCOUNT), { type: 'gt', field: 'balance', value: 0 }),
        select: ['accountId'],
        pageSize: PAGE_SIZE,
      }),
    );

    expect(scans).toEqual([ACCOUNTS.length + BULK]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load whose orderBy alone reads balance runs it 1 time for each row', async () => {
    const scans = transactionScans(
      await planOf({
        objectSet: base(ACCOUNT),
        select: ['accountId'],
        orderBy: { fields: [{ field: 'balance' }] },
        pageSize: PAGE_SIZE,
      }),
    );

    expect(scans).toEqual([ACCOUNTS.length + BULK]);
  });

  it('ontology/object-link-types/derived-properties#cost: a load with a derived where and a second select-only derived value runs the filter 1 time per row and the selected value only for the page', async () => {
    const scans = transactionScans(
      await planOf({
        objectSet: filter(base(ACCOUNT), { type: 'gt', field: 'transactionCount', value: 0 }),
        select: ['balance'],
        orderBy: { fields: [{ field: 'name' }] },
        pageSize: PAGE_SIZE,
      }),
    );

    expect(scans.toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([PAGE_SIZE + 1, ACCOUNTS.length + BULK]);
  });
});
