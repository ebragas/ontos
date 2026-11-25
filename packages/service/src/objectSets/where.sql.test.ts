import type { OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_ENGAGEMENTS } from '../actions/actions.test-utils.ts';
import { irOf, propertyOfType, STRING_FLAGS, twinBlock } from '../ontology/stored.test-utils.ts';
import {
  byPrimaryKey,
  errorAnswer,
  insertObjects,
  NS,
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
  const properties = block.objectType.propertyTypes;

  properties['tags'] = propertyOfType('tags', {
    type: 'array',
    array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
  });

  properties['founded'] = propertyOfType('founded', { type: 'date', date: {} });
  properties['employees'] = propertyOfType('employees', { type: 'integer', integer: {} });
  properties['revenue'] = propertyOfType('revenue', { type: 'decimal', decimal: { precision: 38, scale: 2 } });
  properties['rate'] = propertyOfType('rate', { type: 'decimal', decimal: { precision: 38, scale: 20 } });
  properties['active'] = propertyOfType('active', { type: 'boolean', boolean: {} });

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
  'p-s-01': 'ri.phonograph2-objects.main.object.8135ec0a-1d6c-5d2e-b911-715f79ec5f7e',
  'p-s-02': 'ri.phonograph2-objects.main.object.10efa5f1-f54b-55ca-865e-f911bbcc8c8e',
  'p-s-03': 'ri.phonograph2-objects.main.object.3668b147-0f34-5259-8c23-95106b46b4b2',
  'p-s-04': 'ri.phonograph2-objects.main.object.5a48d50d-bf7f-5a37-9c62-16a1b0bb9952',
  'p-s-05': 'ri.phonograph2-objects.main.object.cdb6071c-5334-5cff-8cc5-182d4edbcdce',
  'p-s-06': 'ri.phonograph2-objects.main.object.9aa4c761-a757-53ce-a01e-158a22e31db0',
  'p-s-07': 'ri.phonograph2-objects.main.object.52ebdf1c-965e-5d14-85fb-a2eb756b3b53',
  'p-s-08': 'ri.phonograph2-objects.main.object.8ba5f5d3-211f-559f-9ba3-d64a347594b3',
  'p-s-09': 'ri.phonograph2-objects.main.object.ff9d973d-5cb9-5c8d-95dc-4199028e340e',
  'p-s-10': 'ri.phonograph2-objects.main.object.5906c0a8-daf4-5c45-b531-5e0641fd320d',
  'p-s-11': 'ri.phonograph2-objects.main.object.82387c01-ebb1-5ae7-a037-2a484ff78cb2',
  'p-s-12': 'ri.phonograph2-objects.main.object.83cff43c-8a37-5f22-ac0b-17f3dc055cfa',
  'p-s-13': 'ri.phonograph2-objects.main.object.c0c75642-ab89-5b98-8729-6fb12038dd7e',
  'p-s-14': 'ri.phonograph2-objects.main.object.291fb5c4-caf7-543f-8895-43c787e4431c',
  'p-s-15': 'ri.phonograph2-objects.main.object.39f716fb-daa0-55ff-a4d3-51eb6dd92dc5',
  'sp-1': 'ri.phonograph2-objects.main.object.e2373f02-a8d7-5753-a631-42c742545641',
  'sp-2': 'ri.phonograph2-objects.main.object.be85d235-0287-526c-8f44-a7b39f7e119b',
  'sp-3': 'ri.phonograph2-objects.main.object.3ba80a48-8aa4-5127-b997-0d052593fc57',
  'sp-4': 'ri.phonograph2-objects.main.object.e9d397b0-5ada-534a-af38-b5f62bcc7e31',
  'sp-5': 'ri.phonograph2-objects.main.object.8988a593-3e6a-5791-9ab6-c1dfdfa033ee',
  'sp-6': 'ri.phonograph2-objects.main.object.399864a7-0406-59ef-8384-b7e46da6eea8',
};

const base = (objectType: string) => ({ type: 'base', objectType });
const filter = (objectSet: unknown, where: unknown) => ({ type: 'filter', objectSet, where });

const structField = (propertyApiName: string, structFieldApiName: string) => ({
  type: 'structField',
  propertyApiName,
  structFieldApiName,
});

const WHERE_REFUSAL = 'ontology/ontology-sdk/object-sets#where-clauses/aeba07a9';

function sortedAnswer(answer: Answer): Answer {
  const body = answer.body as Record<string, unknown>;

  return { status: answer.status, body: { ...body, data: byPrimaryKey(body.data) } };
}

function matches(answer: Answer): { status: number; primaryKeys: unknown; totalCount: unknown } {
  const body = answer.body as { data?: unknown; totalCount?: unknown };
  const data = byPrimaryKey(body.data);

  return {
    status: answer.status,
    primaryKeys: Array.isArray(data) ? data.map((object) => (object as { __primaryKey?: unknown }).__primaryKey) : data,
    totalCount: body.totalCount,
  };
}

const account = (accountId: string, name: string, phase: string | null): ObjectRow => ({ accountId, name, phase });

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
  'p-null': {
    name: 'Probe null phase',
    __title: 'Probe null phase',
    accountId: 'p-null',
    __primaryKey: 'p-null',
    __apiName: ACCOUNT,
    __rid: RID['p-null'],
  },
};

const CLIENT_ACCOUNTS: readonly ObjectRow[] = [
  {
    ...account('acc-1', 'Acme', 'customer'),
    tags: ['vip', 'emea'],
    founded: '2015-06-01',
    employees: 120,
    revenue: '1250000.50',
    active: true,
  },
  {
    ...account('acc-2', 'Globex', 'prospect'),
    tags: ['emea'],
    founded: '2020-01-01',
    employees: 45,
    revenue: '980000.00',
    active: false,
  },
  {
    ...account('acc-3', 'Initech', 'customer'),
    tags: null,
    founded: '2021-03-15',
    employees: null,
    revenue: '1250000.49',
    active: null,
  },
];

const SORT_ACCOUNTS = [
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
];

const TEXT_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'closed'),
  account('p-t-accent', 'café', null),
  account('p-t-hyphen', 'e-mail', null),
  account('p-t-dot', 'foo.bar', null),
  account('p-t-ja', '東京タワー', null),
  account('p-t-words', 'Acme Corp Holdings', null),
  account('p-t-apos', "O'Brien", null),
  account('p-t-zh', '中华人民共和国', null),
  account('p-t-under', 'hello_world', null),
  account('p-t-alnum', 'ABC123', null),
  account('p-t-case', 'MiXeD Case', null),
  ...SORT_ACCOUNTS,
];

const STRUCT_OBJECTS = {
  'sp-1': {
    __primaryKey: 'sp-1',
    measures: {},
    probeId: 'sp-1',
    __title: 'sp-1',
    __apiName: STRUCT_PROBE,
    __rid: RID['sp-1'],
    relationship: { label: 'introduced', since: '2024-03-01' },
  },
  'sp-2': {
    __primaryKey: 'sp-2',
    measures: {},
    probeId: 'sp-2',
    __title: 'sp-2',
    __apiName: STRUCT_PROBE,
    __rid: RID['sp-2'],
    relationship: { label: 'referred', since: '2025-07-15' },
  },
  'sp-3': {
    __primaryKey: 'sp-3',
    measures: {},
    probeId: 'sp-3',
    __title: 'sp-3',
    __apiName: STRUCT_PROBE,
    __rid: RID['sp-3'],
    relationship: { label: 'introduced' },
  },
  'sp-4': {
    __primaryKey: 'sp-4',
    measures: {},
    probeId: 'sp-4',
    __title: 'sp-4',
    __apiName: STRUCT_PROBE,
    __rid: RID['sp-4'],
    relationship: {},
  },
  'sp-5': {
    __primaryKey: 'sp-5',
    measures: { flag: true, count: 3, score: 2.5, at: '2026-10-17T12:00:00Z' },
    probeId: 'sp-5',
    __title: 'sp-5',
    __apiName: STRUCT_PROBE,
    __rid: RID['sp-5'],
    relationship: {},
  },
  'sp-6': {
    __primaryKey: 'sp-6',
    measures: { flag: false, count: -1, score: 0, at: '2025-01-01T00:00:00.123Z' },
    probeId: 'sp-6',
    __title: 'sp-6',
    __apiName: STRUCT_PROBE,
    __rid: RID['sp-6'],
    relationship: {},
  },
};

const STRUCT_PROBES_34: readonly ObjectRow[] = [
  { probeId: 'sp-1', relationship: { label: 'introduced', since: '2024-03-01' }, measures: {} },
  { probeId: 'sp-2', relationship: { label: 'referred', since: '2025-07-15' }, measures: {} },
  { probeId: 'sp-3', relationship: { label: 'introduced' }, measures: {} },
  { probeId: 'sp-4', relationship: {}, measures: {} },
];

const STRUCT_PROBES_49: readonly ObjectRow[] = [
  ...STRUCT_PROBES_34,
  { probeId: 'sp-5', relationship: {}, measures: { flag: true, count: 3, score: 2.5, at: '2026-10-17T12:00:00Z' } },
  { probeId: 'sp-6', relationship: {}, measures: { flag: false, count: -1, score: 0, at: '2025-01-01T00:00:00.123Z' } },
];

const firstPage = (objectType: string, data: unknown[], totalCount: string) => ({
  data,
  totalCount,
  propertySecurities: [],
  objectSetEntities: { objectTypeApiNames: [objectType] },
});

describe('the where queries', () => {
  it('ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#base-types: and(gte amount 10000, not(eq status "lost")) ordered by amount desc', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.loadObjects({
      objectSet: filter(base(ENGAGEMENT), {
        type: 'and',
        value: [
          { type: 'gte', field: 'amount', value: 10000 },
          { type: 'not', value: { type: 'eq', field: 'status', value: 'lost' } },
        ],
      }),
      select: [],
      selectV2: [],
      loadPropertySecurities: false,
      excludeRid: true,
      snapshot: false,
      orderBy: { fields: [{ field: 'amount', direction: 'desc' }] },
    });

    expect(answer).toEqual({
      status: 200,
      body: firstPage(
        ENGAGEMENT,
        [
          {
            accountId: 'acc-1',
            createdAt: '2026-10-17T18:20:05.839Z',
            __primaryKey: 'eng-2',
            amount: 48000,
            __title: 'Ontology build',
            __apiName: ENGAGEMENT,
            title: 'Ontology build',
            engagementId: 'eng-2',
            status: 'open',
          },
          {
            accountId: 'acc-3',
            createdAt: '2026-10-17T18:20:06.436Z',
            __primaryKey: 'eng-6',
            amount: 30000,
            __title: 'Migration',
            __apiName: ENGAGEMENT,
            title: 'Migration',
            engagementId: 'eng-6',
            status: 'open',
          },
          {
            accountId: 'acc-1',
            createdAt: '2026-10-17T18:20:05.687Z',
            __primaryKey: 'eng-1',
            amount: 12000,
            __title: 'Discovery workshop',
            __apiName: ENGAGEMENT,
            title: 'Discovery workshop',
            engagementId: 'eng-1',
            status: 'won',
          },
        ],
        '3',
      ),
    });
  });

  it.each([
    ['eq status "won"', { type: 'eq', field: 'status', value: 'won' }, ['eng-1', 'eng-5'], '2'],
    ['gt amount 15000', { type: 'gt', field: 'amount', value: 15000 }, ['eng-2', 'eng-6'], '2'],
    ['gte amount 15000', { type: 'gte', field: 'amount', value: 15000 }, ['eng-2', 'eng-4', 'eng-6'], '3'],
    ['lt amount 9000', { type: 'lt', field: 'amount', value: 9000 }, ['eng-3'], '1'],
    ['lte amount 9000', { type: 'lte', field: 'amount', value: 9000 }, ['eng-3', 'eng-5'], '2'],
    [
      'in status ["lost", "won"]',
      { type: 'in', field: 'status', value: ['lost', 'won'] },
      ['eng-1', 'eng-4', 'eng-5'],
      '3',
    ],
    ['in status ["nope"]', { type: 'in', field: 'status', value: ['nope'] }, [], '0'],
    [
      'and(eq accountId "acc-1", gt amount 10000)',
      {
        type: 'and',
        value: [
          { type: 'eq', field: 'accountId', value: 'acc-1' },
          { type: 'gt', field: 'amount', value: 10000 },
        ],
      },
      ['eng-1', 'eng-2'],
      '2',
    ],
    [
      'and of 3 queries: gte amount 6000, lte amount 15000, not(eq status "lost")',
      {
        type: 'and',
        value: [
          { type: 'gte', field: 'amount', value: 6000 },
          { type: 'lte', field: 'amount', value: 15000 },
          { type: 'not', value: { type: 'eq', field: 'status', value: 'lost' } },
        ],
      },
      ['eng-1', 'eng-3', 'eng-5'],
      '3',
    ],
    [
      'or(eq status "lost", gte amount 30000)',
      {
        type: 'or',
        value: [
          { type: 'eq', field: 'status', value: 'lost' },
          { type: 'gte', field: 'amount', value: 30000 },
        ],
      },
      ['eng-2', 'eng-4', 'eng-6'],
      '3',
    ],
    [
      'not(eq status "open")',
      { type: 'not', value: { type: 'eq', field: 'status', value: 'open' } },
      ['eng-1', 'eng-4', 'eng-5'],
      '3',
    ],
    [
      'eq on the title Property with propertyIdentifier titleProperty',
      { type: 'eq', propertyIdentifier: { type: 'titleProperty' }, value: 'Pilot' },
      ['eng-4'],
      '1',
    ],
    [
      'eq on the primary key with propertyIdentifier primaryKeyProperty',
      { type: 'eq', propertyIdentifier: { type: 'primaryKeyProperty' }, value: 'eng-3' },
      ['eng-3'],
      '1',
    ],
    [
      'eq with propertyIdentifier property',
      { type: 'eq', propertyIdentifier: { type: 'property', apiName: 'status' }, value: 'lost' },
      ['eng-4'],
      '1',
    ],
  ])('ontology/ontology-sdk/object-sets#where-clauses: %s', async (_case, where, primaryKeys, totalCount) => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.loadObjects({ objectSet: filter(base(ENGAGEMENT), where), select: [] });

    expect(matches(answer)).toEqual({ status: 200, primaryKeys, totalCount });
  });

  it('ontology/ontology-sdk/object-sets#where-clauses: a filter of a filter, as 2 where calls of the client send it, matches the Objects that both queries match', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.loadObjects({
      objectSet: filter(filter(base(ENGAGEMENT), { type: 'eq', field: 'accountId', value: 'acc-1' }), {
        type: 'gt',
        field: 'amount',
        value: 10000,
      }),
      select: [],
    });

    expect(matches(answer)).toEqual({ status: 200, primaryKeys: ['eng-1', 'eng-2'], totalCount: '2' });
  });

  it.each([
    ['isNull phase false', { type: 'isNull', field: 'phase', value: false }, ['acc-1', 'acc-2', 'acc-3', 'p-a'], '4'],
    ['isNull phase true', { type: 'isNull', field: 'phase', value: true }, ['p-null'], '1'],
  ])('ontology/ontology-sdk/object-sets#where-clauses: %s', async (_case, where, primaryKeys, totalCount) => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

    expect(matches(answer)).toEqual({ status: 200, primaryKeys, totalCount });
  });

  it('ontology/ontology-sdk/object-sets#where-clauses ontology/ontology-sdk/object-sets#paging: the pages of a filtered set, 2 for each page, hold each Object that the filter matches, and each page counts only those Objects', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const request = {
      objectSet: filter(base(ENGAGEMENT), {
        type: 'or',
        value: [
          { type: 'eq', field: 'status', value: 'open' },
          { type: 'eq', field: 'status', value: 'won' },
        ],
      }),
      select: [],
      pageSize: 2,
      orderBy: { fields: [{ field: 'amount', direction: 'asc' }] },
    };

    const pages: { primaryKeys: unknown[]; totalCount: unknown }[] = [];
    let pageToken: unknown;

    do {
      const answer = await service.loadObjects(pageToken === undefined ? request : { ...request, pageToken });

      if (answer.status !== 200)
        throw new Error(`Page ${pages.length + 1} gave ${answer.status}: ${JSON.stringify(answer.body)}`);

      const body = answer.body as { data: { __primaryKey: unknown }[]; totalCount: unknown; nextPageToken?: unknown };

      pages.push({ primaryKeys: body.data.map((object) => object.__primaryKey), totalCount: body.totalCount });

      pageToken = body.nextPageToken;
    } while (pageToken !== undefined && pages.length < 10);

    expect(pages).toEqual([
      { primaryKeys: ['eng-3', 'eng-5'], totalCount: '5' },
      { primaryKeys: ['eng-1', 'eng-6'], totalCount: '5' },
      { primaryKeys: ['eng-2'], totalCount: '5' },
    ]);
  });

  it.each([
    ['in accountId []', { type: 'in', field: 'accountId', value: [] }],
    ['in phase [], where 1 Account has a null phase', { type: 'in', field: 'phase', value: [] }],
  ])('ontology/ontology-sdk/object-sets#where-clauses: %s matches every Object', async (_case, where) => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

    expect(matches(answer)).toEqual({
      status: 200,
      primaryKeys: ['acc-1', 'acc-2', 'acc-3', 'p-a', 'p-null'],
      totalCount: '5',
    });
  });

  it.each([
    ['and []', { type: 'and', value: [] }, ['acc-1', 'acc-2', 'acc-3', 'p-a', 'p-null']],
    ['or []', { type: 'or', value: [] }, []],
    ['not(and [])', { type: 'not', value: { type: 'and', value: [] } }, []],
    ['not(or [])', { type: 'not', value: { type: 'or', value: [] } }, ['acc-1', 'acc-2', 'acc-3', 'p-a', 'p-null']],
    ['and with the 1 part eq phase "a"', { type: 'and', value: [{ type: 'eq', field: 'phase', value: 'a' }] }, ['p-a']],
    ['or with the 1 part eq phase "a"', { type: 'or', value: [{ type: 'eq', field: 'phase', value: 'a' }] }, ['p-a']],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: %s matches the Objects that its parts all match, or that 1 part matches',
    async (_case, where, primaryKeys) => {
      await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

      const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

      expect(matches(answer)).toEqual({ status: 200, primaryKeys, totalCount: String(primaryKeys.length) });
    },
  );
});

describe('not and null', () => {
  it('ontology/ontology-sdk/object-sets#where-clauses: not(eq phase "a") also matches the Account with a null phase', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: filter(base(ACCOUNT), { type: 'not', value: { type: 'eq', field: 'phase', value: 'a' } }),
      select: [],
    });

    expect(sortedAnswer(answer)).toEqual({
      status: 200,
      body: firstPage(
        ACCOUNT,
        [PROBE_OBJECTS['acc-1'], PROBE_OBJECTS['acc-2'], PROBE_OBJECTS['acc-3'], PROBE_OBJECTS['p-null']],
        '4',
      ),
    });
  });

  it('ontology/ontology-sdk/object-sets#where-clauses: isNull phase true matches only the Account with a null phase', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: filter(base(ACCOUNT), { type: 'isNull', field: 'phase', value: true }),
      select: [],
    });

    expect(answer).toEqual({ status: 200, body: firstPage(ACCOUNT, [PROBE_OBJECTS['p-null']], '1') });
  });

  it.each([
    [
      'not(in phase ["a", "closed"])',
      { type: 'not', value: { type: 'in', field: 'phase', value: ['a', 'closed'] } },
      ['acc-1', 'acc-2', 'p-null'],
      '3',
    ],
    ['not(gt phase "b")', { type: 'not', value: { type: 'gt', field: 'phase', value: 'b' } }, ['p-a', 'p-null'], '2'],
    [
      'not(and(not(eq phase "a"), not(eq phase "closed")))',
      {
        type: 'not',
        value: {
          type: 'and',
          value: [
            { type: 'not', value: { type: 'eq', field: 'phase', value: 'a' } },
            { type: 'not', value: { type: 'eq', field: 'phase', value: 'closed' } },
          ],
        },
      },
      ['acc-3', 'p-a'],
      '2',
    ],
    [
      'not(or(eq phase "a", eq phase "closed"))',
      {
        type: 'not',
        value: {
          type: 'or',
          value: [
            { type: 'eq', field: 'phase', value: 'a' },
            { type: 'eq', field: 'phase', value: 'closed' },
          ],
        },
      },
      ['acc-1', 'acc-2', 'p-null'],
      '3',
    ],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: %s matches each Account that its query does not match, also the Account with a null phase',
    async (_case, where, primaryKeys, totalCount) => {
      await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

      const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

      expect(matches(answer)).toEqual({ status: 200, primaryKeys, totalCount });
    },
  );
});

describe('the queries of each base type', () => {
  it.each([
    [
      'lt name "A": the digits come before upper case',
      { type: 'lt', field: 'name', value: 'A' },
      ['p-s-01', 'p-s-02', 'p-s-03'],
      '3',
    ],
    [
      'gt name "Zed": _ and lower case come after upper case, and é after z',
      { type: 'gt', field: 'name', value: 'Zed' },
      ['p-s-06', 'p-s-07', 'p-s-08', 'p-s-09', 'p-s-11', 'p-s-12', 'p-s-13', 'p-s-14', 'p-s-15'],
      '9',
    ],
    [
      'gte name "zed": é, Ö, Ω, and 日 come after z',
      { type: 'gte', field: 'name', value: 'zed' },
      ['p-s-08', 'p-s-09', 'p-s-11', 'p-s-13', 'p-s-14', 'p-s-15'],
      '6',
    ],
    [
      'lte name "Abc"',
      { type: 'lte', field: 'name', value: 'Abc' },
      ['p-s-01', 'p-s-02', 'p-s-03', 'p-s-04', 'p-s-05'],
      '5',
    ],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses ontology/ontology-sdk/object-sets#order: on a String, %s, by code point',
    async (_case, where, primaryKeys, totalCount) => {
      await insertObjects(service.db, ACCOUNT, SORT_ACCOUNTS);

      const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

      expect(matches(answer)).toEqual({ status: 200, primaryKeys, totalCount });
    },
  );

  it.each([
    ['on an Integer, gte employees 45', { type: 'gte', field: 'employees', value: 45 }, ['acc-1', 'acc-2'], '2'],
    ['on an Integer, lt employees 100', { type: 'lt', field: 'employees', value: 100 }, ['acc-2'], '1'],
    ['on a Decimal, gt revenue "1250000.49"', { type: 'gt', field: 'revenue', value: '1250000.49' }, ['acc-1'], '1'],
    [
      'on a Decimal, lte revenue 1250000.49',
      { type: 'lte', field: 'revenue', value: 1250000.49 },
      ['acc-2', 'acc-3'],
      '2',
    ],
    [
      'on a Date, lte founded "2020-01-01"',
      { type: 'lte', field: 'founded', value: '2020-01-01' },
      ['acc-1', 'acc-2'],
      '2',
    ],
    ['on a Date, gt founded "2020-01-01"', { type: 'gt', field: 'founded', value: '2020-01-01' }, ['acc-3'], '1'],
    ['on a Boolean, eq active true', { type: 'eq', field: 'active', value: true }, ['acc-1'], '1'],
    ['on a Boolean, in active [false]', { type: 'in', field: 'active', value: [false] }, ['acc-2'], '1'],
    ['on a String array, contains tags "vip"', { type: 'contains', field: 'tags', value: 'vip' }, ['acc-1'], '1'],
    [
      'on a String array, contains tags "emea"',
      { type: 'contains', field: 'tags', value: 'emea' },
      ['acc-1', 'acc-2'],
      '2',
    ],
    ['on a String array, isNull tags true', { type: 'isNull', field: 'tags', value: true }, ['acc-3'], '1'],
  ])('ontology/ontology-sdk/object-sets#where-clauses: %s', async (_case, where, primaryKeys, totalCount) => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

    expect(matches(answer)).toEqual({ status: 200, primaryKeys, totalCount });
  });

  it.each([
    ['the number 100', 100],
    ['the plain string "100.00"', '100.00'],
    ['the exponent string "1e2"', '1e2'],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#base-types: on a Decimal, eq revenue with %s matches the Accounts with the value 100.00',
    async (_case, value) => {
      await insertObjects(service.db, ACCOUNT, [
        { ...account('acc-1', 'Acme', 'customer'), revenue: '100.00' },
        { ...account('acc-2', 'Globex', 'prospect'), revenue: '100.01' },
        { ...account('acc-3', 'Initech', 'customer'), revenue: '100.00' },
        { ...account('p-a', 'Probe phase a', 'a'), revenue: '99.99' },
      ]);

      const answer = await service.loadObjects({
        objectSet: filter(base(ACCOUNT), { type: 'eq', field: 'revenue', value }),
        select: [],
      });

      expect(matches(answer)).toEqual({ status: 200, primaryKeys: ['acc-1', 'acc-3'], totalCount: '2' });
    },
  );

  it.each([
    ['eq', 'acc-1'],
    ['gte', 'acc-1'],
    ['lt', 'acc-2'],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#base-types: on a Decimal of scale 20, %s rate with a string of 20 significant digits compares the exact value',
    async (type, primaryKey) => {
      expect(Number('0.12345678901234567891')).toBe(Number('0.12345678901234567890'));

      await insertObjects(service.db, ACCOUNT, [
        { ...account('acc-1', 'Acme', 'customer'), rate: '0.12345678901234567891' },
        { ...account('acc-2', 'Globex', 'prospect'), rate: '0.12345678901234567890' },
      ]);

      const answer = await service.loadObjects({
        objectSet: filter(base(ACCOUNT), { type, field: 'rate', value: '0.12345678901234567891' }),
        select: [],
      });

      expect(matches(answer)).toEqual({ status: 200, primaryKeys: [primaryKey], totalCount: '1' });
    },
  );

  it('ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#base-types: on a Timestamp, gt createdAt "2026-10-17T18:20:06Z"', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.loadObjects({
      objectSet: filter(base(ENGAGEMENT), { type: 'gt', field: 'createdAt', value: '2026-10-17T18:20:06Z' }),
      select: [],
    });

    expect(matches(answer)).toEqual({ status: 200, primaryKeys: ['eng-4', 'eng-5', 'eng-6'], totalCount: '3' });
  });

  it.each([
    [
      'gt on the Boolean active',
      ACCOUNT,
      { type: 'gt', field: 'active', value: false },
      { property: 'active', propertyBaseType: 'Boolean' },
    ],
    [
      'contains on the String name',
      ACCOUNT,
      { type: 'contains', field: 'name', value: 'Acme' },
      { property: 'name', propertyBaseType: 'String' },
    ],
    [
      'eq on the String array tags',
      ACCOUNT,
      { type: 'eq', field: 'tags', value: 'vip' },
      { property: 'tags', propertyBaseType: 'Array<String>' },
    ],
    [
      'gt on the String array tags',
      ACCOUNT,
      { type: 'gt', field: 'tags', value: 'a' },
      { property: 'tags', propertyBaseType: 'Array<String>' },
    ],
    [
      'lte on the Boolean struct field measures.flag',
      STRUCT_PROBE,
      { type: 'lte', propertyIdentifier: structField('measures', 'flag'), value: true },
      { property: 'measures.flag', propertyBaseType: 'Boolean' },
    ],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: %s gets 400 InvalidPropertyType, with property and propertyBaseType',
    async (_case, objectType, where, parameters) => {
      const answer = await service.loadObjects({ objectSet: filter(base(objectType), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPropertyType', parameters },
      });
    },
  );

  it.each([
    [
      'eq amount "abc"',
      ENGAGEMENT,
      { type: 'eq', field: 'amount', value: 'abc' },
      { property: 'amount', propertyBaseType: 'Double', propertyValue: 'abc' },
    ],
    [
      'in status ["won", 7]',
      ENGAGEMENT,
      { type: 'in', field: 'status', value: ['won', 7] },
      { property: 'status', propertyBaseType: 'String', propertyValue: 7 },
    ],
    [
      'gt createdAt "yesterday"',
      ENGAGEMENT,
      { type: 'gt', field: 'createdAt', value: 'yesterday' },
      { property: 'createdAt', propertyBaseType: 'Timestamp', propertyValue: 'yesterday' },
    ],
    [
      'eq employees 1.5',
      ACCOUNT,
      { type: 'eq', field: 'employees', value: 1.5 },
      { property: 'employees', propertyBaseType: 'Integer', propertyValue: 1.5 },
    ],
    [
      'lte founded "2020-13-01"',
      ACCOUNT,
      { type: 'lte', field: 'founded', value: '2020-13-01' },
      { property: 'founded', propertyBaseType: 'LocalDate', propertyValue: '2020-13-01' },
    ],
    [
      'eq active "yes"',
      ACCOUNT,
      { type: 'eq', field: 'active', value: 'yes' },
      { property: 'active', propertyBaseType: 'Boolean', propertyValue: 'yes' },
    ],
    [
      'gt revenue "a lot"',
      ACCOUNT,
      { type: 'gt', field: 'revenue', value: 'a lot' },
      { property: 'revenue', propertyBaseType: 'Decimal', propertyValue: 'a lot' },
    ],
    [
      'eq revenue "1e999999", over the exponent cap',
      ACCOUNT,
      { type: 'eq', field: 'revenue', value: '1e999999' },
      { property: 'revenue', propertyBaseType: 'Decimal', propertyValue: '1e999999' },
    ],
    [
      'eq revenue with 1,001 digits, over the length cap',
      ACCOUNT,
      { type: 'eq', field: 'revenue', value: '1'.repeat(1001) },
      { property: 'revenue', propertyBaseType: 'Decimal', propertyValue: '1'.repeat(1001) },
    ],
    [
      'contains tags 7',
      ACCOUNT,
      { type: 'contains', field: 'tags', value: 7 },
      { property: 'tags', propertyBaseType: 'String', propertyValue: 7 },
    ],
    [
      'eq name null',
      ACCOUNT,
      { type: 'eq', field: 'name', value: null },
      { property: 'name', propertyBaseType: 'String', propertyValue: null },
    ],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: a value of the wrong type, %s, gets 400 InvalidPropertyValue',
    async (_case, objectType, where, parameters) => {
      const answer = await service.loadObjects({ objectSet: filter(base(objectType), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPropertyValue', parameters },
      });
    },
  );

  it.each([
    [
      'eq name "a\\u0000b"',
      ACCOUNT,
      { type: 'eq', field: 'name', value: 'a\u0000b' },
      { property: 'name', propertyBaseType: 'String', propertyValue: 'a\u0000b' },
    ],
    [
      'eq createdAt "2021-02-30T00:00:00Z"',
      ENGAGEMENT,
      { type: 'eq', field: 'createdAt', value: '2021-02-30T00:00:00Z' },
      { property: 'createdAt', propertyBaseType: 'Timestamp', propertyValue: '2021-02-30T00:00:00Z' },
    ],
    [
      'eq createdAt "2026-10-17T18:00:00+23:59"',
      ENGAGEMENT,
      { type: 'eq', field: 'createdAt', value: '2026-10-17T18:00:00+23:59' },
      { property: 'createdAt', propertyBaseType: 'Timestamp', propertyValue: '2026-10-17T18:00:00+23:59' },
    ],
    [
      'eq createdAt "0000-01-01T00:00:00Z"',
      ENGAGEMENT,
      { type: 'eq', field: 'createdAt', value: '0000-01-01T00:00:00Z' },
      { property: 'createdAt', propertyBaseType: 'Timestamp', propertyValue: '0000-01-01T00:00:00Z' },
    ],
    [
      'eq founded "0000-01-01"',
      ACCOUNT,
      { type: 'eq', field: 'founded', value: '0000-01-01' },
      { property: 'founded', propertyBaseType: 'LocalDate', propertyValue: '0000-01-01' },
    ],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: a value that Postgres does not take, %s, gets 400 InvalidPropertyValue',
    async (_case, objectType, where, parameters) => {
      const answer = await service.loadObjects({ objectSet: filter(base(objectType), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPropertyValue', parameters },
      });
    },
  );

  it.each([
    [
      'isNull with the value "yes"',
      { type: 'isNull', field: 'phase', value: 'yes' },
      { type: 'isNull', field: 'phase', value: 'yes' },
    ],
    [
      'in with a value that is not a list',
      { type: 'in', field: 'phase', value: 'a' },
      { type: 'in', field: 'phase', value: 'a' },
    ],
    [
      'and with a value that is not a list',
      { type: 'and', value: { type: 'eq', field: 'phase', value: 'a' } },
      { type: 'and', value: { type: 'eq', field: 'phase', value: 'a' } },
    ],
    ['not with no query', { type: 'not' }, { type: 'not' }],
    [
      'isNull with no value, inside and',
      {
        type: 'and',
        value: [
          { type: 'eq', field: 'phase', value: 'a' },
          { type: 'isNull', field: 'phase' },
        ],
      },
      { type: 'isNull', field: 'phase' },
    ],
    [
      'a text search with the analyzerSelection "X"',
      { type: 'containsAnyTerm', field: 'phase', value: 'a', analyzerSelection: 'X' },
      { type: 'containsAnyTerm', field: 'phase', value: 'a', analyzerSelection: 'X' },
    ],
    [
      'a query with field and propertyIdentifier',
      { type: 'eq', field: 'phase', propertyIdentifier: { type: 'property', apiName: 'phase' }, value: 'a' },
      { type: 'eq', field: 'phase', propertyIdentifier: { type: 'property', apiName: 'phase' }, value: 'a' },
    ],
    ['a query with no field and no propertyIdentifier', { type: 'eq', value: 'a' }, { type: 'eq', value: 'a' }],
    ['a query with no type', { field: 'phase', value: 'a' }, { field: 'phase', value: 'a' }],
    [
      'a struct field with the field name 5',
      {
        type: 'eq',
        propertyIdentifier: { type: 'structField', propertyApiName: 'relationship', structFieldApiName: 5 },
        value: 'a',
      },
      {
        type: 'eq',
        propertyIdentifier: { type: 'structField', propertyApiName: 'relationship', structFieldApiName: 5 },
        value: 'a',
      },
    ],
    [
      'a struct field with the Property name 5',
      {
        type: 'eq',
        propertyIdentifier: { type: 'structField', propertyApiName: 5, structFieldApiName: 'label' },
        value: 'a',
      },
      {
        type: 'eq',
        propertyIdentifier: { type: 'structField', propertyApiName: 5, structFieldApiName: 'label' },
        value: 'a',
      },
    ],
  ])(
    `${WHERE_REFUSAL}: %s gets 400 Default:InvalidArgument, with the refused query in the parameters`,
    async (_case, where, refused) => {
      const answer = await service.loadObjects({ objectSet: filter(base(ACCOUNT), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { field: 'where', query: refused },
        },
      });
    },
  );

  it(`${WHERE_REFUSAL}: an aggregate filter and a filter of a filter name the refused query, and not the whole Object Set`, async () => {
    const refused = { type: 'isNull', field: 'phase' };

    const expected = {
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: { field: 'where', query: refused },
      },
    };

    const aggregated = await service.aggregate({
      objectSet: filter(base(ACCOUNT), refused),
      groupBy: [],
      aggregation: [{ type: 'count', name: 'count' }],
    });

    expect(errorAnswer(aggregated)).toEqual(expected);

    const nested = await service.loadObjects({
      objectSet: filter(filter(base(ACCOUNT), { type: 'eq', field: 'phase', value: 'a' }), refused),
      select: [],
    });

    expect(errorAnswer(nested)).toEqual(expected);
  });
});

describe('struct fields', () => {
  it.each([
    [
      36,
      { type: 'eq', propertyIdentifier: structField('relationship', 'label'), value: 'introduced' },
      ['sp-1', 'sp-3'],
      '2',
    ],
    [37, { type: 'eq', propertyIdentifier: structField('relationship', 'since'), value: '2025-07-15' }, ['sp-2'], '1'],
    [38, { type: 'gt', propertyIdentifier: structField('relationship', 'since'), value: '2024-12-31' }, ['sp-2'], '1'],
    [
      39,
      { type: 'isNull', propertyIdentifier: structField('relationship', 'since'), value: true },
      ['sp-3', 'sp-4'],
      '2',
    ],
    [
      40,
      {
        type: 'not',
        value: { type: 'eq', propertyIdentifier: structField('relationship', 'label'), value: 'introduced' },
      },
      ['sp-2', 'sp-4'],
      '2',
    ],
  ] as const)(
    'ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#base-types: case %i: a query on a field of relationship uses the queries of its base type',
    async (_line, where, primaryKeys, totalCount) => {
      await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_34);

      const answer = await service.loadObjects({ objectSet: filter(base(STRUCT_PROBE), where), select: [] });

      expect(sortedAnswer(answer)).toEqual({
        status: 200,
        body: firstPage(
          STRUCT_PROBE,
          primaryKeys.map((key) => STRUCT_OBJECTS[key]),
          totalCount,
        ),
      });
    },
  );

  it.each([
    [59, 'Boolean', { type: 'eq', propertyIdentifier: structField('measures', 'flag'), value: true }, 'sp-5'],
    [60, 'Integer', { type: 'gt', propertyIdentifier: structField('measures', 'count'), value: 0 }, 'sp-5'],
    [61, 'Double', { type: 'lt', propertyIdentifier: structField('measures', 'score'), value: 1 }, 'sp-6'],
    [
      62,
      'Timestamp',
      { type: 'gt', propertyIdentifier: structField('measures', 'at'), value: '2026-01-01T00:00:00Z' },
      'sp-5',
    ],
    [
      63,
      'Timestamp',
      { type: 'eq', propertyIdentifier: structField('measures', 'at'), value: '2025-01-01T00:00:00.123Z' },
      'sp-6',
    ],
  ] as const)(
    'ontology/ontology-sdk/object-sets#where-clauses ontology/object-link-types/properties#base-types: case %i: a query on the %s field of measures',
    async (_line, _type, where, primaryKey) => {
      await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_49);

      const answer = await service.loadObjects({ objectSet: filter(base(STRUCT_PROBE), where), select: [] });

      expect(answer).toEqual({ status: 200, body: firstPage(STRUCT_PROBE, [STRUCT_OBJECTS[primaryKey]], '1') });
    },
  );

  it('ontology/ontology-sdk/object-sets#where-clauses: isNull on the struct Property relationship matches no struct that no edit set, because it reads as {}', async () => {
    await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_34);

    const answer = await service.loadObjects({
      objectSet: filter(base(STRUCT_PROBE), { type: 'isNull', field: 'relationship', value: true }),
      select: [],
    });

    expect(answer).toEqual({ status: 200, body: firstPage(STRUCT_PROBE, [], '0') });
  });

  it('ontology/ontology-sdk/object-sets#where-clauses: isNull on the struct Property relationship matches a struct set to null, which has no key on read', async () => {
    await insertObjects(service.db, STRUCT_PROBE, [
      ...STRUCT_PROBES_34,
      { probeId: 'sp-n', relationship: null, measures: {} },
    ]);

    const answer = await service.loadObjects({
      objectSet: filter(base(STRUCT_PROBE), { type: 'isNull', field: 'relationship', value: true }),
      select: [],
      excludeRid: true,
    });

    expect(answer).toEqual({
      status: 200,
      body: firstPage(
        STRUCT_PROBE,
        [{ __primaryKey: 'sp-n', measures: {}, probeId: 'sp-n', __title: 'sp-n', __apiName: STRUCT_PROBE }],
        '1',
      ),
    });
  });

  it('ontology/ontology-sdk/object-sets#where-clauses: eq on the struct Property relationship with the full struct of sp-1 matches no Object', async () => {
    await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_34);

    const answer = await service.loadObjects({
      objectSet: filter(base(STRUCT_PROBE), {
        type: 'eq',
        field: 'relationship',
        value: { label: 'introduced', since: '2024-03-01' },
      }),
      select: [],
    });

    expect(answer).toEqual({ status: 200, body: firstPage(STRUCT_PROBE, [], '0') });
  });

  it.each([
    ['gt', { type: 'gt', field: 'relationship', value: { label: 'introduced' } }],
    ['in', { type: 'in', field: 'relationship', value: [{ label: 'introduced' }] }],
    ['contains', { type: 'contains', field: 'relationship', value: 'introduced' }],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: %s on the struct Property relationship gets 400 InvalidPropertyType',
    async (_case, where) => {
      await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_34);

      const answer = await service.loadObjects({ objectSet: filter(base(STRUCT_PROBE), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPropertyType',
          parameters: { property: 'relationship', propertyBaseType: 'Struct' },
        },
      });
    },
  );

  it.each([
    [
      'eq relationship.since "not-a-date"',
      { type: 'eq', propertyIdentifier: structField('relationship', 'since'), value: 'not-a-date' },
      { property: 'relationship.since', propertyBaseType: 'LocalDate', propertyValue: 'not-a-date' },
    ],
    [
      'gt measures.count 2147483648',
      { type: 'gt', propertyIdentifier: structField('measures', 'count'), value: 2147483648 },
      { property: 'measures.count', propertyBaseType: 'Integer', propertyValue: 2147483648 },
    ],
    [
      'eq measures.flag "yes"',
      { type: 'eq', propertyIdentifier: structField('measures', 'flag'), value: 'yes' },
      { property: 'measures.flag', propertyBaseType: 'Boolean', propertyValue: 'yes' },
    ],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses: a value of the wrong type for a struct field, %s, gets 400 InvalidPropertyValue',
    async (_case, where, parameters) => {
      const answer = await service.loadObjects({ objectSet: filter(base(STRUCT_PROBE), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPropertyValue', parameters },
      });
    },
  );
});

describe('the errors of the where clause', () => {
  it('service/http-api#errors: eq on the unknown Property nope gets 404 PropertiesNotFound', async () => {
    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const answer = await service.loadObjects({
      objectSet: filter(base(ENGAGEMENT), { type: 'eq', field: 'nope', value: 'x' }),
      select: [],
      selectV2: [],
      loadPropertySecurities: false,
      excludeRid: true,
      snapshot: false,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'PropertiesNotFound',
        parameters: { objectType: ENGAGEMENT, properties: ['nope'] },
      },
    });
  });

  it('service/http-api#errors: eq on the field name relationship.label gets 404 PropertiesNotFound, because a field name is not a Property', async () => {
    await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_34);

    const answer = await service.loadObjects({
      objectSet: filter(base(STRUCT_PROBE), { type: 'eq', field: 'relationship.label', value: 'introduced' }),
      select: [],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'PropertiesNotFound',
        parameters: { objectType: STRUCT_PROBE, properties: ['relationship.label'] },
      },
    });
  });

  it.each([
    ['the unknown field nope of relationship', structField('relationship', 'nope'), 'relationship.nope'],
    ['the field label of the unknown Property nope', structField('nope', 'label'), 'nope.label'],
    ['the field label of probeId, which is not a struct', structField('probeId', 'label'), 'probeId.label'],
  ])(
    'ontology/ontology-sdk/object-sets#where-clauses service/http-api#errors: a where on %s gets 404 PropertiesNotFound, with properties ["<property>.<field>"]',
    async (_case, propertyIdentifier, path) => {
      await insertObjects(service.db, STRUCT_PROBE, STRUCT_PROBES_34);

      const answer = await service.loadObjects({
        objectSet: filter(base(STRUCT_PROBE), { type: 'eq', propertyIdentifier, value: 'introduced' }),
        select: [],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 404,
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'PropertiesNotFound',
          parameters: { objectType: STRUCT_PROBE, properties: [path] },
        },
      });
    },
  );

  it.each([
    [
      'withinDistanceOf',
      {
        type: 'withinDistanceOf',
        field: 'name',
        value: { center: { type: 'Point', coordinates: [0, 0] }, distance: { value: 1, unit: 'KILOMETERS' } },
      },
      'name',
      'withinDistanceOf',
    ],
    [
      'intersectsBoundingBox',
      {
        type: 'intersectsBoundingBox',
        field: 'name',
        value: { topLeft: { type: 'Point', coordinates: [0, 1] }, bottomRight: { type: 'Point', coordinates: [1, 0] } },
      },
      'name',
      'intersectsBoundingBox',
    ],
    ['wildcard', { type: 'wildcard', field: 'name', value: 'Ac*' }, 'name', 'wildcard'],
    [
      'relativeDateRange',
      {
        type: 'relativeDateRange',
        field: 'founded',
        relativeStartTime: { type: 'relativePoint', value: -1, timeUnit: 'YEAR' },
        relativeEndTime: { type: 'relativePoint', value: 0, timeUnit: 'DAY' },
        timeZoneId: 'UTC',
      },
      'founded',
      'relativeDateRange',
    ],
    [
      'wildcard on a struct field',
      { type: 'wildcard', propertyIdentifier: structField('relationship', 'label'), value: 'intro*' },
      'relationship.label',
      'wildcard',
    ],
  ])(
    'service/http-api#errors: the filter %s, which is outside V1, gets 400 PropertyFiltersNotSupported',
    async (_case, where, property, propertyFilter) => {
      const objectType = property.startsWith('relationship') ? STRUCT_PROBE : ACCOUNT;

      const answer = await service.loadObjects({ objectSet: filter(base(objectType), where), select: [] });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'PropertyFiltersNotSupported',
          parameters: { property, propertyFilters: [propertyFilter] },
        },
      });
    },
  );

  it('service/http-api#errors: a filter outside V1 inside an and gets 400 PropertyFiltersNotSupported', async () => {
    const answer = await service.loadObjects({
      objectSet: filter(base(ACCOUNT), {
        type: 'and',
        value: [
          { type: 'eq', field: 'phase', value: 'customer' },
          { type: 'wildcard', field: 'name', value: 'Ac*' },
        ],
      }),
      select: [],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'PropertyFiltersNotSupported',
        parameters: { property: 'name', propertyFilters: ['wildcard'] },
      },
    });
  });
});

describe('the code point order of Strings', () => {
  const sortObject = (accountId: string, name: string) => ({
    name,
    __title: name,
    accountId,
    __primaryKey: accountId,
    __apiName: ACCOUNT,
    __rid: RID[accountId],
  });

  const ASC = [
    sortObject('p-s-01', '10'),
    sortObject('p-s-03', '1abc'),
    sortObject('p-s-02', '9'),
    sortObject('p-s-04', 'ABC'),
    sortObject('p-s-05', 'Abc'),
    sortObject('p-s-10', 'Zed'),
    sortObject('p-s-12', '_x'),
    sortObject('p-s-06', 'abc'),
    sortObject('p-s-07', 'ebc'),
    sortObject('p-s-11', 'zed'),
    sortObject('p-s-08', 'Ébc'),
    sortObject('p-s-13', 'Ölm'),
    sortObject('p-s-09', 'ébc'),
    sortObject('p-s-15', 'Ωmega'),
    sortObject('p-s-14', '日本'),
  ];

  const DESC = [
    sortObject('p-s-14', '日本'),
    sortObject('p-s-15', 'Ωmega'),
    sortObject('p-s-09', 'ébc'),
    sortObject('p-s-13', 'Ölm'),
    sortObject('p-s-08', 'Ébc'),
    sortObject('p-s-11', 'zed'),
    sortObject('p-s-07', 'ebc'),
    sortObject('p-s-06', 'abc'),
    sortObject('p-s-12', '_x'),
    sortObject('p-s-10', 'Zed'),
    sortObject('p-s-05', 'Abc'),
    sortObject('p-s-04', 'ABC'),
    sortObject('p-s-02', '9'),
    sortObject('p-s-03', '1abc'),
    sortObject('p-s-01', '10'),
  ];

  it.each([
    ['asc', ASC],
    ['desc', DESC],
  ] as const)(
    'ontology/ontology-sdk/object-sets#order ontology/ontology-sdk/object-sets#where-clauses: the 15 sort Accounts that an in on accountId gives, ordered by name %s, by code point',
    async (direction, data) => {
      await insertObjects(service.db, ACCOUNT, TEXT_ACCOUNTS);

      const answer = await service.loadObjects({
        objectSet: filter(base(ACCOUNT), {
          type: 'in',
          field: 'accountId',
          value: SORT_ACCOUNTS.map((sortAccount) => sortAccount.accountId),
        }),
        select: ['name'],
        orderBy: { fields: [{ field: 'name', direction }] },
      });

      expect(answer).toEqual({ status: 200, body: firstPage(ACCOUNT, data, '15') });
    },
  );
});
