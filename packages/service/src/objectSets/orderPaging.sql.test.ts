import type { OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteName, type Sql } from '../db/index.ts';
import { columnName, tableName } from '../ontology/index.ts';
import { SEED_ENGAGEMENTS } from '../actions/actions.test-utils.ts';
import { irOf, propertyOfType, STRING_FLAGS, twinBlock } from '../ontology/stored.test-utils.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { asSnapshot } from '../service.test-utils.ts';
import {
  byPrimaryKey,
  errorAnswer,
  insertObjects,
  NS,
  pageOf,
  startObjectSets,
  type Answer,
  type ObjectRow,
  type ObjectSetsService,
} from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;

function accountBlock(): OntologyIrObjectTypeBlockDataV2 {
  const block = twinBlock('0.6.3', ACCOUNT);

  block.objectType.propertyTypes['tags'] = propertyOfType('tags', {
    type: 'array',
    array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
  });

  block.objectType.propertyTypes['employees'] = propertyOfType('employees', { type: 'integer', integer: {} });
  block.objectType.propertyTypes['founded'] = propertyOfType('founded', { type: 'date', date: {} });

  block.objectType.propertyTypes['balance'] = propertyOfType('balance', {
    type: 'decimal',
    decimal: { precision: 38, scale: 18 },
  });

  return block;
}

const IR = irOf(accountBlock(), twinBlock('0.6.3', ENGAGEMENT), twinBlock('0.6.3', STRUCT_PROBE));

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(IR);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const RID: Readonly<Record<string, string>> = {
  'acc-1': 'ri.phonograph2-objects.main.object.8d7bec66-1177-57d5-8311-9617d1f43aa2',
  'acc-2': 'ri.phonograph2-objects.main.object.8f164048-7dab-5f42-97d1-76399da06441',
  'acc-3': 'ri.phonograph2-objects.main.object.03aae71d-fb1a-5e2f-b568-f696aaf1576a',
  'p-a': 'ri.phonograph2-objects.main.object.0cbb1d84-6195-524c-8336-eace42c790e2',
  'p-null': 'ri.phonograph2-objects.main.object.94f9b677-3cc0-5f3f-8899-b8b48c68f868',
  'p-t-words': 'ri.phonograph2-objects.main.object.e4ad94d9-c5d3-58e1-84aa-1323cf3f527d',
  'eng-1': 'ri.phonograph2-objects.main.object.f00fa478-0c56-50f1-b4ab-7c6bd453e7a4',
  'eng-2': 'ri.phonograph2-objects.main.object.10365908-0021-51d0-a8b8-ac7c9d133829',
  'eng-3': 'ri.phonograph2-objects.main.object.99a88626-70f0-57d4-9dc9-351fcb421b32',
  'eng-4': 'ri.phonograph2-objects.main.object.36ffcd7c-b38f-5601-880f-38f658e4460a',
  'eng-5': 'ri.phonograph2-objects.main.object.2887b475-d137-509c-8340-28ea18d6d5d1',
  'eng-6': 'ri.phonograph2-objects.main.object.0468c910-ab4b-54c0-8a9a-6adfecc7a918',
  'eng-7': 'ri.phonograph2-objects.main.object.4709852d-e1ec-534d-b105-a64990c3c000',
  'p-e-dur': 'ri.phonograph2-objects.main.object.ce7461e5-be5b-5d74-9281-1ae9818117ac',
  'p-n-e': 'ri.phonograph2-objects.main.object.89d544ea-6ad7-5c8f-8d28-bb8710a07f30',
  'sp-1': 'ri.phonograph2-objects.main.object.e2373f02-a8d7-5753-a631-42c742545641',
  'sp-2': 'ri.phonograph2-objects.main.object.be85d235-0287-526c-8f44-a7b39f7e119b',
  'sp-3': 'ri.phonograph2-objects.main.object.3ba80a48-8aa4-5127-b997-0d052593fc57',
  'sp-4': 'ri.phonograph2-objects.main.object.e9d397b0-5ada-534a-af38-b5f62bcc7e31',
};

const base = (objectType: string) => ({ type: 'base', objectType });
const orderBy = (...fields: { field: string; direction?: string }[]) => ({ fields });

function tokenOf(answer: Answer): string {
  const token = (answer.body as { nextPageToken?: unknown }).nextPageToken;

  if (typeof token !== 'string') throw new Error(`The page has no nextPageToken: ${JSON.stringify(answer)}`);

  return token;
}

async function primaryKeysOfEachPage(request: Readonly<Record<string, unknown>>): Promise<unknown[][]> {
  const pages: unknown[][] = [];
  let pageToken: unknown;

  do {
    const answer = await service.loadObjects(pageToken === undefined ? request : { ...request, pageToken });

    if (answer.status !== 200)
      throw new Error(`Page ${pages.length + 1} gave ${answer.status}: ${JSON.stringify(answer.body)}`);

    const body = answer.body as { data: { __primaryKey: unknown }[]; nextPageToken?: unknown };

    pages.push(body.data.map((object) => object.__primaryKey));

    pageToken = body.nextPageToken;
  } while (pageToken !== undefined && pages.length < 20);

  if (pageToken !== undefined) throw new Error('The read did not end after 20 pages.');

  return pages;
}

const account = (accountId: string, name: string, phase: string | null): ObjectRow => ({ accountId, name, phase });

const CLIENT_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'customer'),
];

const PROBE_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'closed'),
  account('p-a', 'Probe phase a', 'a'),
  account('p-null', 'Probe null phase', null),
];

const PROBE_OBJECTS = {
  'acc-1': {
    phase: 'customer',
    accountId: 'acc-1',
    __primaryKey: 'acc-1',
    name: 'Acme',
    __title: 'Acme',
    __apiName: ACCOUNT,
    __rid: RID['acc-1'],
  },
  'acc-2': {
    phase: 'prospect',
    accountId: 'acc-2',
    __primaryKey: 'acc-2',
    name: 'Globex',
    __title: 'Globex',
    __apiName: ACCOUNT,
    __rid: RID['acc-2'],
  },
  'acc-3': {
    phase: 'closed',
    accountId: 'acc-3',
    __primaryKey: 'acc-3',
    name: 'Initech',
    __title: 'Initech',
    __apiName: ACCOUNT,
    __rid: RID['acc-3'],
  },
  'p-a': {
    phase: 'a',
    accountId: 'p-a',
    __primaryKey: 'p-a',
    name: 'Probe phase a',
    __title: 'Probe phase a',
    __apiName: ACCOUNT,
    __rid: RID['p-a'],
  },
  'p-null': {
    name: 'Probe null phase',
    __title: 'Probe null phase',
    accountId: 'p-null',
    __primaryKey: 'p-null',
    __apiName: ACCOUNT,
    __rid: RID['p-null'],
  },
};

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

const DURATION_PROBE = engagement('p-e-dur', 'p-t-words', 'Duration probe', 1, 'open', '2026-10-17T19:22:25.573Z');

const createdAtOnly = (engagementId: string, createdAt: string) => ({
  createdAt,
  __primaryKey: engagementId,
  __apiName: ENGAGEMENT,
  __rid: RID[engagementId],
  engagementId,
});

describe('the order of the Objects', () => {
  it('ontology/ontology-sdk/object-sets#order ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#objects-in-a-page ontology/object-link-types/properties#base-types: 2 pages of Accounts ordered by name, where the last page has no nextPageToken', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const request = {
      objectSet: base(ACCOUNT),
      select: [],
      selectV2: [],
      loadPropertySecurities: false,
      excludeRid: true,
      snapshot: false,
      pageSize: 2,
      orderBy: orderBy({ field: 'name', direction: 'asc' }),
    };

    const first = await service.loadObjects(request);

    const { nextPageToken, ...firstBody } = first.body as Record<string, unknown>;

    expect(typeof nextPageToken).toBe('string');

    expect({ status: first.status, body: firstBody }).toEqual({
      status: 200,
      body: {
        data: [
          {
            phase: 'customer',
            accountId: 'acc-1',
            __primaryKey: 'acc-1',
            name: 'Acme',
            __title: 'Acme',
            __apiName: ACCOUNT,
          },
          {
            phase: 'prospect',
            accountId: 'acc-2',
            __primaryKey: 'acc-2',
            name: 'Globex',
            __title: 'Globex',
            __apiName: ACCOUNT,
          },
        ],
        totalCount: '3',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });

    const { orderBy: order, pageSize, ...head } = request;

    const second = await service.loadObjects({ ...head, pageToken: nextPageToken, pageSize, orderBy: order });

    expect(second).toEqual({
      status: 200,
      body: {
        data: [
          {
            phase: 'customer',
            accountId: 'acc-3',
            __primaryKey: 'acc-3',
            name: 'Initech',
            __title: 'Initech',
            __apiName: ACCOUNT,
          },
        ],
        totalCount: '3',
        propertySecurities: [],
      },
    });
  });

  it.each([
    ['asc', ['p-null', 'p-a', 'acc-3', 'acc-1', 'acc-2']],
    ['desc', ['acc-2', 'acc-1', 'acc-3', 'p-a', 'p-null']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#order: orderBy phase %s sorts the null phase as the lowest value',
    async (direction, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

      const answer = await service.loadObjects({
        objectSet: base(ACCOUNT),
        select: [],
        orderBy: orderBy({ field: 'phase', direction }),
      });

      expect(answer).toEqual({
        status: 200,
        body: {
          data: primaryKeys.map((key) => PROBE_OBJECTS[key]),
          totalCount: '5',
          propertySecurities: [],
          objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
        },
      });
    },
  );

  it.each([
    ['a field with no direction', orderBy({ field: 'name' })],
    ['orderType fields', { orderType: 'fields', fields: [{ field: 'name', direction: 'asc' }] }],
  ])('ontology/ontology-sdk/object-sets#order: %s orders by name asc', async (_case, order) => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({ objectSet: base(ACCOUNT), select: [], orderBy: order });

    expect(pageOf(answer)).toEqual({
      status: 200,
      primaryKeys: ['acc-1', 'acc-2', 'acc-3', 'p-null', 'p-a'],
      nextPageToken: 'undefined',
      totalCount: '5',
      fields: ['data', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });
  });

  it('ontology/ontology-sdk/object-sets#order: orderBy phase asc, then name desc, orders by each field in list order', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: base(ACCOUNT),
      select: [],
      orderBy: orderBy({ field: 'phase', direction: 'asc' }, { field: 'name', direction: 'desc' }),
    });

    expect(pageOf(answer)).toEqual({
      status: 200,
      primaryKeys: ['acc-3', 'acc-1', 'acc-2'],
      nextPageToken: 'undefined',
      totalCount: '3',
      fields: ['data', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });
  });

  it('ontology/ontology-sdk/object-sets#order: with no orderBy, the pages of a read hold each Object 1 time', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const pages = await primaryKeysOfEachPage({ objectSet: base(ACCOUNT), select: [], pageSize: 2 });

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);

    expect(pages.flat().sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'acc-1',
      'acc-2',
      'acc-3',
      'p-a',
      'p-null',
    ]);
  });

  it('ontology/ontology-sdk/object-sets#order: a relevance order gets 400 Default:InvalidArgument', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: base(ACCOUNT),
      select: [],
      orderBy: { orderType: 'relevance', fields: [] },
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: { feature: 'relevance' },
      },
    });
  });

  it('ontology/ontology-sdk/object-sets#out-of-scope: an orderBy on the struct Property relationship gets 400 Default:InvalidArgument', async () => {
    await insertObjects(service.db, STRUCT_PROBE, [
      { probeId: 'sp-1', relationship: { label: 'introduced' }, measures: {} },
    ]);

    const answer = await service.loadObjects({
      objectSet: base(STRUCT_PROBE),
      select: [],
      orderBy: orderBy({ field: 'relationship', direction: 'asc' }),
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: { feature: 'orderBy on a struct Property' },
      },
    });
  });

  it.each([
    [
      'a Property that the Object Type does not have gets 404 PropertiesNotFound',
      orderBy({ field: 'nope', direction: 'asc' }),
      {
        status: 404,
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'PropertiesNotFound',
          parameters: { objectType: ACCOUNT, properties: ['nope'] },
        },
      },
    ],
    [
      'the same Property 2 times gets 400 DuplicateOrderBy',
      orderBy({ field: 'name', direction: 'asc' }, { field: 'name', direction: 'desc' }),
      {
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'DuplicateOrderBy', parameters: { properties: ['name'] } },
      },
    ],
    [
      'the array Property tags gets 400 Default:InvalidArgument',
      orderBy({ field: 'tags', direction: 'asc' }),
      {
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { feature: 'orderBy on an array Property' },
        },
      },
    ],
    [
      'a direction other than asc or desc gets 400 Default:InvalidArgument',
      orderBy({ field: 'name', direction: 'up' }),
      {
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { field: 'orderBy' } },
      },
    ],
  ])('ontology/ontology-sdk/object-sets#order: in orderBy, %s', async (_case, order, expected) => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const answer = await service.loadObjects({ objectSet: base(ACCOUNT), select: [], orderBy: order });

    expect(errorAnswer(answer)).toEqual(expected);
  });
});

describe('the Objects in a page', () => {
  it('ontology/ontology-sdk/object-sets#objects-in-a-page: an empty select gives each Property, __title, and __rid, and leaves out the null phase', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({ objectSet: base(ACCOUNT), select: [], pageSize: 1000 });

    const body = answer.body as Record<string, unknown>;

    expect({ status: answer.status, body: { ...body, data: byPrimaryKey(body.data) } }).toEqual({
      status: 200,
      body: {
        data: [
          PROBE_OBJECTS['acc-1'],
          PROBE_OBJECTS['acc-2'],
          PROBE_OBJECTS['acc-3'],
          PROBE_OBJECTS['p-a'],
          PROBE_OBJECTS['p-null'],
        ],
        totalCount: '5',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });

  it('ontology/ontology-sdk/object-sets#objects-in-a-page: a select of the title Property name gives __title and the primary key Property', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('acc-1', 'Acme', 'customer'),
      account('p-t-words', 'Acme Corp Holdings', null),
    ]);

    const answer = await service.loadObjects({
      objectSet: base(ACCOUNT),
      select: ['name'],
      orderBy: orderBy({ field: 'accountId', direction: 'asc' }),
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          {
            name: 'Acme',
            __title: 'Acme',
            accountId: 'acc-1',
            __primaryKey: 'acc-1',
            __apiName: ACCOUNT,
            __rid: RID['acc-1'],
          },
          {
            name: 'Acme Corp Holdings',
            __title: 'Acme Corp Holdings',
            accountId: 'p-t-words',
            __primaryKey: 'p-t-words',
            __apiName: ACCOUNT,
            __rid: RID['p-t-words'],
          },
        ],
        totalCount: '2',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });

  it('ontology/ontology-sdk/object-sets#objects-in-a-page: a select of createdAt only gives no __title, and orders by engagementId', async () => {
    await insertObjects(service.db, ENGAGEMENT, [...SEED_ENGAGEMENTS, DURATION_PROBE]);

    const answer = await service.loadObjects({
      objectSet: base(ENGAGEMENT),
      select: ['createdAt'],
      orderBy: orderBy({ field: 'engagementId', direction: 'asc' }),
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          createdAtOnly('eng-1', '2026-10-17T18:20:05.687Z'),
          createdAtOnly('eng-2', '2026-10-17T18:20:05.839Z'),
          createdAtOnly('eng-3', '2026-10-17T18:20:05.991Z'),
          createdAtOnly('eng-4', '2026-10-17T18:20:06.135Z'),
          createdAtOnly('eng-5', '2026-10-17T18:20:06.284Z'),
          createdAtOnly('eng-6', '2026-10-17T18:20:06.436Z'),
          createdAtOnly('eng-7', '2026-10-17T18:20:08.937Z'),
          createdAtOnly('p-e-dur', '2026-10-17T19:22:25.573Z'),
        ],
        totalCount: '8',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ENGAGEMENT] },
      },
    });
  });

  it('ontology/ontology-sdk/object-sets#objects-in-a-page: a select of createdAt only gives no __title, and orders by createdAt', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      ...SEED_ENGAGEMENTS,
      engagement('p-n-e', 'p-n-1', 'Duration probe', 1, 'open', '2026-10-17T22:36:37.569Z'),
    ]);

    const answer = await service.loadObjects({
      objectSet: base(ENGAGEMENT),
      select: ['createdAt'],
      orderBy: orderBy({ field: 'createdAt', direction: 'asc' }),
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          createdAtOnly('eng-1', '2026-10-17T18:20:05.687Z'),
          createdAtOnly('eng-2', '2026-10-17T18:20:05.839Z'),
          createdAtOnly('eng-3', '2026-10-17T18:20:05.991Z'),
          createdAtOnly('eng-4', '2026-10-17T18:20:06.135Z'),
          createdAtOnly('eng-5', '2026-10-17T18:20:06.284Z'),
          createdAtOnly('eng-6', '2026-10-17T18:20:06.436Z'),
          createdAtOnly('eng-7', '2026-10-17T18:20:08.937Z'),
          createdAtOnly('p-n-e', '2026-10-17T22:36:37.569Z'),
        ],
        totalCount: '8',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ENGAGEMENT] },
      },
    });
  });

  it('ontology/object-link-types/properties#structs: each struct value has a key for each field that holds a value', async () => {
    const probe = (probeId: string, relationship: ObjectRow[string]): ObjectRow => ({
      probeId,
      relationship,
      measures: {},
    });

    await insertObjects(service.db, STRUCT_PROBE, [
      probe('sp-1', { label: 'introduced', since: '2024-03-01' }),
      probe('sp-2', { label: 'referred', since: '2025-07-15' }),
      probe('sp-3', { label: 'introduced' }),
      probe('sp-4', {}),
    ]);

    const answer = await service.loadObjects({
      objectSet: base(STRUCT_PROBE),
      select: [],
      orderBy: orderBy({ field: 'probeId', direction: 'asc' }),
    });

    const object = (probeId: string, relationship: Record<string, unknown>) => ({
      __primaryKey: probeId,
      measures: {},
      probeId,
      __title: probeId,
      __apiName: STRUCT_PROBE,
      __rid: RID[probeId],
      relationship,
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        data: [
          object('sp-1', { label: 'introduced', since: '2024-03-01' }),
          object('sp-2', { label: 'referred', since: '2025-07-15' }),
          object('sp-3', { label: 'introduced' }),
          object('sp-4', {}),
        ],
        totalCount: '4',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [STRUCT_PROBE] },
      },
    });
  });
});

describe('the pages of a read', () => {
  it('ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#order: a pageSize of 1 with no orderBy gives 1 of the 5 Accounts, and a nextPageToken', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const page = pageOf(await service.loadObjects({ objectSet: base(ACCOUNT), select: [], pageSize: 1 }));

    expect({
      ...page,
      primaryKeys: Array.isArray(page.primaryKeys) ? page.primaryKeys.length : page.primaryKeys,
    }).toEqual({
      status: 200,
      primaryKeys: 1,
      nextPageToken: 'string',
      totalCount: '5',
      fields: ['data', 'nextPageToken', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });
  });

  it.each([
    ['phase asc', 1, 'asc', [['p-null'], ['p-a'], ['acc-3'], ['acc-1'], ['acc-2']]],
    ['phase desc', 2, 'desc', [['acc-2', 'acc-1'], ['acc-3', 'p-a'], ['p-null']]],
  ] as const)(
    'ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#order: the pages of %s, %i for each page, hold the order',
    async (_case, pageSize, direction, pages) => {
      await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

      expect(
        await primaryKeysOfEachPage({
          objectSet: base(ACCOUNT),
          select: [],
          pageSize,
          orderBy: orderBy({ field: 'phase', direction }),
        }),
      ).toEqual(pages);
    },
  );

  it.each([
    ['asc', [['acc-2'], ['acc-4'], ['acc-1'], ['acc-3']]],
    ['desc', [['acc-1'], ['acc-3'], ['acc-2'], ['acc-4']]],
  ] as const)(
    'ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#order: the pages of phase %s, 1 for each page, hold each Account 1 time, also when 2 Accounts have the same phase or a null phase',
    async (direction, pages) => {
      await insertObjects(service.db, ACCOUNT, [
        account('acc-1', 'Acme', 'customer'),
        account('acc-2', 'Globex', null),
        account('acc-3', 'Initech', 'customer'),
        account('acc-4', 'Umbrella', null),
      ]);

      expect(
        await primaryKeysOfEachPage({
          objectSet: base(ACCOUNT),
          select: [],
          pageSize: 1,
          orderBy: orderBy({ field: 'phase', direction }),
        }),
      ).toEqual(pages);
    },
  );

  it('ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#order: the pages of name asc, 4 for each page, hold code point order, which the en-US order of the test database does not give', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('p-s-01', '10', null),
      account('p-s-02', '9', null),
      account('p-s-03', '1abc', null),
      account('p-s-04', 'ABC', null),
      account('p-s-05', 'Abc', null),
      account('p-s-06', 'abc', null),
      account('p-s-07', 'ebc', null),
      account('p-s-08', 'Ébc', null),
      account('p-s-09', 'ébc', null),
      account('p-s-10', 'Zed', null),
      account('p-s-11', 'zed', null),
      account('p-s-12', '_x', null),
      account('p-s-13', 'Ölm', null),
      account('p-s-14', '日本', null),
      account('p-s-15', 'Ωmega', null),
    ]);

    expect(
      await primaryKeysOfEachPage({
        objectSet: base(ACCOUNT),
        select: [],
        pageSize: 4,
        orderBy: orderBy({ field: 'name', direction: 'asc' }),
      }),
    ).toEqual([
      ['p-s-01', 'p-s-03', 'p-s-02', 'p-s-04'],
      ['p-s-05', 'p-s-10', 'p-s-12', 'p-s-06'],
      ['p-s-07', 'p-s-11', 'p-s-08', 'p-s-13'],
      ['p-s-09', 'p-s-15', 'p-s-14'],
    ]);
  });

  it.each([
    [
      'status asc, 2 for each page',
      2,
      orderBy({ field: 'status', direction: 'asc' }),
      [
        ['eng-6', 'eng-4'],
        ['eng-3', 'p-e-dur'],
        ['eng-2', 'eng-1'],
        ['eng-5', 'eng-7'],
      ],
    ],
    [
      'createdAt asc, 3 for each page',
      3,
      orderBy({ field: 'createdAt', direction: 'asc' }),
      [
        ['eng-1', 'eng-2', 'eng-3'],
        ['eng-4', 'eng-5', 'eng-6'],
        ['eng-7', 'p-e-dur'],
      ],
    ],
    [
      'amount desc, 3 for each page',
      3,
      orderBy({ field: 'amount', direction: 'desc' }),
      [
        ['eng-2', 'eng-6', 'eng-7'],
        ['eng-4', 'eng-1', 'eng-5'],
        ['eng-3', 'p-e-dur'],
      ],
    ],
  ])(
    'ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#order: the pages of the Engagements by %s',
    async (_case, pageSize, order, pages) => {
      await insertObjects(service.db, ENGAGEMENT, [...SEED_ENGAGEMENTS, DURATION_PROBE]);

      expect(
        await primaryKeysOfEachPage({ objectSet: base(ENGAGEMENT), select: [], pageSize, orderBy: order }),
      ).toEqual(pages);
    },
  );
});

describe('the pages of a Decimal order', () => {
  it.each([
    ['asc', [['acc-4'], ['acc-3'], ['acc-2'], ['acc-1']]],
    ['desc', [['acc-1'], ['acc-2'], ['acc-3'], ['acc-4']]],
  ] as const)(
    'ontology/ontology-sdk/object-sets#paging ontology/ontology-sdk/object-sets#order: the pages of balance %s, 1 for each page, hold each Account 1 time in exact order, also when 2 balances differ only after the 15th significant digit',
    async (direction, pages) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'acc-1', name: 'Acme', balance: '1.0000000000000004' },
        { accountId: 'acc-2', name: 'Globex', balance: '1.0000000000000003' },
        { accountId: 'acc-3', name: 'Initech', balance: '1.0000000000000002' },
        { accountId: 'acc-4', name: 'Umbrella', balance: '1.0000000000000001' },
      ]);

      expect(
        await primaryKeysOfEachPage({
          objectSet: base(ACCOUNT),
          select: [],
          pageSize: 1,
          orderBy: orderBy({ field: 'balance', direction }),
        }),
      ).toEqual(pages);
    },
  );
});

describe('the page token', () => {
  const CLIENT_2 = {
    objectSet: base(ACCOUNT),
    select: [],
    selectV2: [],
    loadPropertySecurities: false,
    excludeRid: true,
    snapshot: false,
    pageSize: 2,
    orderBy: orderBy({ field: 'name', direction: 'asc' }),
  };

  const FOREIGN_PAGE_CURSOR = `v1.${Buffer.from(
    JSON.stringify({ t: 'Objects.1', ps: 2, cursor: 'synthetic-foreign' }),
  ).toString('base64url')}`;

  const invalidPageToken = (pageToken: string) => ({
    status: 400,
    body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPageToken', parameters: { pageToken } },
  });

  it.each([
    ['a foreign-format pageToken', FOREIGN_PAGE_CURSOR],
    ['a token that is not base64url JSON', 'not-a-token'],
  ])('ontology/ontology-sdk/object-sets#paging: %s gets 400 InvalidPageToken', async (_case, pageToken) => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    expect(errorAnswer(await service.loadObjects({ ...CLIENT_2, pageToken }))).toEqual(invalidPageToken(pageToken));
  });

  it.each([
    ['pageSize', { pageSize: 3 }],
    ['orderBy', { orderBy: orderBy({ field: 'name', direction: 'desc' }) }],
    ['select', { select: ['name'] }],
    ['excludeRid', { excludeRid: false }],
  ])(
    'ontology/ontology-sdk/object-sets#paging: the token of page 1, in a request with another %s, gets 400 InvalidPageToken',
    async (_case, change) => {
      await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

      const pageToken = tokenOf(await service.loadObjects(CLIENT_2));

      expect(errorAnswer(await service.loadObjects({ ...CLIENT_2, ...change, pageToken }))).toEqual(
        invalidPageToken(pageToken),
      );
    },
  );

  it.each([
    ['an Integer orderBy with the value 1.5', ACCOUNT, [{ field: 'employees', direction: 'asc' }], [1.5, 'acc-1']],
    ['a Date orderBy with the value "x"', ACCOUNT, [{ field: 'founded', direction: 'asc' }], ['x', 'acc-1']],
    ['a Timestamp orderBy with the value "x"', ENGAGEMENT, [{ field: 'createdAt', direction: 'asc' }], ['x', 'eng-1']],
    [
      'a Decimal orderBy with the value "1e999999", over the exponent cap',
      ACCOUNT,
      [{ field: 'balance', direction: 'asc' }],
      ['1e999999', 'acc-1'],
    ],
    ['no orderBy, with the primary key "\\u0000"', ACCOUNT, [], ['\u0000']],
  ] as const)(
    'ontology/ontology-sdk/object-sets#paging: a token with a sort value of the right JSON type but a bad form, %s, gets 400 InvalidPageToken',
    async (_case, objectType, fields, values) => {
      await insertObjects(service.db, ACCOUNT, [
        { accountId: 'acc-1', name: 'Acme', employees: 10, founded: '2020-01-01' },
        { accountId: 'acc-2', name: 'Globex', employees: 20, founded: '2021-01-01' },
      ]);

      await insertObjects(service.db, ENGAGEMENT, SEED_ENGAGEMENTS);

      const request = { objectSet: base(objectType), select: [], pageSize: 1, orderBy: orderBy(...fields) };

      const fieldsOfToken = JSON.parse(
        Buffer.from(tokenOf(await service.loadObjects(request)), 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      const pageToken = Buffer.from(JSON.stringify({ ...fieldsOfToken, values }), 'utf8').toString('base64url');

      expect(errorAnswer(await service.loadObjects({ ...request, pageToken }))).toEqual(invalidPageToken(pageToken));
    },
  );

  it('ontology/ontology-sdk/object-sets#paging: the token of a read of the Accounts, in a request with the objectSet of the Engagements, gets 400 InvalidPageToken', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    await insertObjects(service.db, ENGAGEMENT, SEED_ENGAGEMENTS);

    const request = {
      objectSet: base(ACCOUNT),
      select: [],
      pageSize: 2,
      orderBy: orderBy({ field: 'accountId', direction: 'asc' }),
    };

    const pageToken = tokenOf(await service.loadObjects(request));

    expect(errorAnswer(await service.loadObjects({ ...request, objectSet: base(ENGAGEMENT), pageToken }))).toEqual(
      invalidPageToken(pageToken),
    );
  });

  it('ontology/ontology-sdk/object-sets#paging: a page token works 59 minutes 59 seconds after its page, and gets 400 InvalidPageToken 1 hour 1 second after it', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));

      const pageToken = tokenOf(await service.loadObjects(CLIENT_2));

      vi.setSystemTime(new Date('2026-10-20T12:59:59.000Z'));

      expect(pageOf(await service.loadObjects({ ...CLIENT_2, pageToken }))).toEqual({
        status: 200,
        primaryKeys: ['acc-3'],
        nextPageToken: 'undefined',
        totalCount: '3',
        fields: ['data', 'propertySecurities', 'totalCount'],
      });

      vi.setSystemTime(new Date('2026-10-20T13:00:01.000Z'));

      expect(errorAnswer(await service.loadObjects({ ...CLIENT_2, pageToken }))).toEqual(invalidPageToken(pageToken));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ontology/ontology-sdk/object-sets#paging: a page token expires 1 hour after the service sends the end of its page, not 1 hour after the request came in', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));

      const response = await service.loadObjectsResponse(CLIENT_2);

      vi.setSystemTime(new Date('2026-10-20T12:30:00.000Z'));

      const { nextPageToken } = JSON.parse(await response.text()) as { nextPageToken: string };

      vi.setSystemTime(new Date('2026-10-20T13:29:59.000Z'));

      expect(pageOf(await service.loadObjects({ ...CLIENT_2, pageToken: nextPageToken }))).toEqual({
        status: 200,
        primaryKeys: ['acc-3'],
        nextPageToken: 'undefined',
        totalCount: '3',
        fields: ['data', 'propertySecurities', 'totalCount'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ontology/ontology-sdk/object-sets#paging: an Account that a create adds after page 1 shows on page 2, after acc-3', async () => {
    await insertObjects(service.db, ACCOUNT, [
      ...PROBE_ACCOUNTS,
      account('p-0snap', 'Added after page 1, snapshot true', null),
    ]);

    const request = {
      objectSet: base(ACCOUNT),
      select: [],
      pageSize: 2,
      orderBy: orderBy({ field: 'accountId', direction: 'asc' }),
      snapshot: false,
    };

    const first = await service.loadObjects(request);

    expect(pageOf(first)).toEqual({
      status: 200,
      primaryKeys: ['acc-1', 'acc-2'],
      nextPageToken: 'string',
      totalCount: '6',
      fields: ['data', 'nextPageToken', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });

    await insertObjects(service.db, ACCOUNT, [account('p-0live', 'Added after page 1, snapshot false', null)]);

    expect(pageOf(await service.loadObjects({ ...request, pageToken: tokenOf(first) }))).toEqual({
      status: 200,
      primaryKeys: ['acc-3', 'p-0live'],
      nextPageToken: 'string',
      totalCount: '7',
      fields: ['data', 'nextPageToken', 'propertySecurities', 'totalCount'],
    });
  });

  it('ontology/ontology-sdk/object-sets#paging: after page 1, a delete of each Object of page 1, and a create that sorts before them, do not make page 2 skip an Object', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const request = {
      objectSet: base(ACCOUNT),
      select: [],
      pageSize: 2,
      orderBy: orderBy({ field: 'name', direction: 'asc' }),
    };

    const first = await service.loadObjects(request);

    expect(pageOf(first).primaryKeys).toEqual(['acc-1', 'acc-2']);

    await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id IN ('acc-1', 'acc-2')"));

    await insertObjects(service.db, ACCOUNT, [account('acc-0', 'Aardvark', 'prospect')]);

    const second = await service.loadObjects({ ...request, pageToken: tokenOf(first) });

    expect(pageOf(second)).toEqual({
      status: 200,
      primaryKeys: ['acc-3', 'p-null'],
      nextPageToken: 'string',
      totalCount: '4',
      fields: ['data', 'nextPageToken', 'propertySecurities', 'totalCount'],
    });

    expect(pageOf(await service.loadObjects({ ...request, pageToken: tokenOf(second) }))).toEqual({
      status: 200,
      primaryKeys: ['p-a'],
      nextPageToken: 'undefined',
      totalCount: '4',
      fields: ['data', 'propertySecurities', 'totalCount'],
    });
  });

  it('ontology/ontology-sdk/object-sets#paging: after a page that ends on a null phase, a delete of that Object does not make the next page skip an Object', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const request = {
      objectSet: base(ACCOUNT),
      select: [],
      pageSize: 1,
      orderBy: orderBy({ field: 'phase', direction: 'asc' }),
    };

    const first = await service.loadObjects(request);

    expect(pageOf(first).primaryKeys).toEqual(['p-null']);

    await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'p-null'"));

    expect(pageOf(await service.loadObjects({ ...request, pageToken: tokenOf(first) }))).toEqual({
      status: 200,
      primaryKeys: ['p-a'],
      nextPageToken: 'string',
      totalCount: '4',
      fields: ['data', 'nextPageToken', 'propertySecurities', 'totalCount'],
    });
  });
});

function deleteAccounts(...accountIds: string[]): Sql {
  return sql(
    `DELETE FROM ontology_1_objects.${quoteName(tableName(ACCOUNT))} WHERE ${quoteName(columnName('accountId'))} = ANY($1)`,
    accountIds,
  );
}

function afterTheCount(between: Sql): { readonly db: Db; readonly ran: () => boolean } {
  const counts = (statement: Sql) => statement.text.includes('count(*)');
  let done = false;

  const runOnce = async () => {
    if (done) return;

    done = true;

    await service.db.query(between);
  };

  const watched = (db: Db): Db => ({
    query: async <Row extends object>(statement: Sql) => {
      const rows = await db.query<Row>(statement);

      if (counts(statement)) await runOnce();

      return rows;
    },
    stream: <Row extends object>(statement: Sql) =>
      (async function* () {
        for await (const row of db.stream<Row>(statement)) {
          if (counts(statement)) await runOnce();

          yield row;
        }
      })(),
    transaction: (run) => db.transaction((tx) => run(watched(tx))),
    snapshot: (run) => db.snapshot((tx) => run(asSnapshot(watched(tx)))),
  });

  return { db: watched(service.db), ran: () => done };
}

describe('totalCount and the page', () => {
  it('ontology/ontology-sdk/object-sets#paging: a delete of 2 of 3 Accounts after the count and before the page leaves totalCount and the page in 1 snapshot', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const watched = afterTheCount(deleteAccounts('acc-2', 'acc-3'));

    const page = pageOf(
      await service.loadObjects(
        { objectSet: base(ACCOUNT), select: [], excludeRid: true, orderBy: orderBy({ field: 'accountId' }) },
        watched.db,
      ),
    );

    expect(watched.ran()).toBe(true);

    expect(page).toEqual({
      status: 200,
      primaryKeys: ['acc-1', 'acc-2', 'acc-3'],
      nextPageToken: 'undefined',
      totalCount: '3',
      fields: ['data', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });
  });

  it('ontology/ontology-sdk/object-sets#paging: a delete during the read of a page larger than 1 cursor batch of 100 rows leaves the page and totalCount in 1 snapshot', async () => {
    const accountIds = Array.from({ length: 150 }, (_, index) => `acc-${String(index).padStart(3, '0')}`);

    await insertObjects(
      service.db,
      ACCOUNT,
      accountIds.map((accountId) => account(accountId, accountId, null)),
    );

    const watched = afterTheCount(deleteAccounts('acc-148', 'acc-149'));

    const page = pageOf(
      await service.loadObjects(
        { objectSet: base(ACCOUNT), select: [], excludeRid: true, orderBy: orderBy({ field: 'accountId' }) },
        watched.db,
      ),
    );

    expect(watched.ran()).toBe(true);

    expect(page).toEqual({
      status: 200,
      primaryKeys: accountIds,
      nextPageToken: 'undefined',
      totalCount: '150',
      fields: ['data', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });
  });

  it('ontology/ontology-sdk/object-sets#paging: an empty page has its totalCount', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const request = {
      objectSet: base(ACCOUNT),
      select: [],
      excludeRid: true,
      pageSize: 1,
      orderBy: orderBy({ field: 'accountId' }),
    };

    const first = await service.loadObjects(request);

    await service.db.query(deleteAccounts('acc-2', 'acc-3'));

    expect(pageOf(await service.loadObjects({ ...request, pageToken: tokenOf(first) }))).toEqual({
      status: 200,
      primaryKeys: [],
      nextPageToken: 'undefined',
      totalCount: '1',
      fields: ['data', 'propertySecurities', 'totalCount'],
    });
  });
});
