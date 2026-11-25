import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { irOf, NS, propertyOfType, STRING_FLAGS, stringProperty, twinBlock } from '../ontology/stored.test-utils.ts';
import { errorAnswer } from '../service.test-utils.ts';
import { startObjectSets, type ObjectSetsService } from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;

function accountBlock() {
  const block = twinBlock('0.6.3', ACCOUNT);
  const properties = block.objectType.propertyTypes;

  properties['tags'] = propertyOfType('tags', {
    type: 'array',
    array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
  });

  properties['founded'] = propertyOfType('founded', { type: 'date', date: {} });
  properties['employees'] = propertyOfType('employees', { type: 'integer', integer: {} });
  properties['active'] = propertyOfType('active', { type: 'boolean', boolean: {} });
  properties['note'] = { ...stringProperty('note'), indexedForSearch: false };

  return block;
}

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(
    irOf(accountBlock(), twinBlock('0.6.3', ENGAGEMENT), twinBlock('0.6.3', STRUCT_PROBE)),
  );
});

afterAll(() => service?.stop());

type Route = 'loadObjects' | 'aggregate';

async function answerOf(route: Route, body: unknown): Promise<unknown> {
  const response =
    route === 'loadObjects' ? await service.loadObjectsResponse(body) : await service.aggregateResponse(body);

  const answer = errorAnswer({ status: response.status, body: await response.json() });

  return { ...answer, headers: Object.fromEntries(response.headers) };
}

interface Case {
  readonly name: string;
  readonly route: Route;
  readonly body: unknown;
}

const load = (name: string, body: unknown): Case => ({ name, route: 'loadObjects', body });
const aggregate = (name: string, body: unknown): Case => ({ name, route: 'aggregate', body });

function pin(cases: readonly Case[]): void {
  for (const { name, route, body } of cases) {
    it(`${route}: ${name}`, async () => {
      expect(await answerOf(route, body)).toMatchSnapshot();
    });
  }
}

const base = (objectType: string) => ({ type: 'base', objectType });
const filter = (objectSet: unknown, where: unknown) => ({ type: 'filter', objectSet, where });
const ACCOUNTS = base(ACCOUNT);
const STRUCT_PROBES = base(STRUCT_PROBE);
const accountsWhere = (where: unknown) => ({ objectSet: filter(ACCOUNTS, where) });

const structField = (propertyApiName?: string, structFieldApiName?: string) => ({
  type: 'structField',
  propertyApiName,
  structFieldApiName,
});

const COUNT = { type: 'count' };

const countOf = (objectSet: unknown, fields: Readonly<Record<string, unknown>> = {}) => ({
  objectSet,
  aggregation: [COUNT],
  ...fields,
});

const groupedBy = (...groupBy: unknown[]) => countOf(ACCOUNTS, { groupBy });

const OTHER_BODY_TOKEN = Buffer.from(
  JSON.stringify({ values: ['acc-1'], checksum: 'another body', expires: Date.UTC(2100, 0, 1) }),
  'utf8',
).toString('base64url');

const WORDS_17 = 'a b c d e f g h i j k l m n o p q';

const DEEP_WHERE = {
  type: 'and',
  value: [
    { type: 'eq', field: 'name', value: 'Acme' },
    {
      type: 'or',
      value: [
        { type: 'isNull', field: 'phase', value: false },
        {
          type: 'and',
          value: [
            { type: 'gte', field: 'employees', value: 10 },
            { type: 'eq', field: 'employees', value: 'many' },
          ],
        },
      ],
    },
  ],
};

const REFUSED_FIELDS: readonly (readonly [string, unknown])[] = [
  ['defaultLoadLevel', 'none'],
  ['snapshot', 'yes'],
  ['select', 5],
  ['selectV2', 5],
  ['pageToken', 5],
  ['orderBy', 5],
  ['pageSize', 0],
  ['excludeRid', 1],
];

describe('service/http-api#errors', () => {
  pin([
    ...REFUSED_FIELDS.map(([field], index) =>
      load(`the fields of the body from ${field} on, each refused`, {
        objectSet: ACCOUNTS,
        ...Object.fromEntries(REFUSED_FIELDS.slice(index)),
      }),
    ),
    load(
      'an unknown Object Type, an unknown select, an unknown orderBy, and a pageToken that the service did not make',
      {
        objectSet: base(`${NS}Missing`),
        select: ['missing'],
        orderBy: { fields: [{ field: 'gone' }] },
        pageToken: 'garbage',
      },
    ),
    load('an unknown select, an unknown orderBy, and a pageToken that the service did not make', {
      objectSet: ACCOUNTS,
      select: ['missing'],
      orderBy: { fields: [{ field: 'gone' }] },
      pageToken: 'garbage',
    }),
    load('an unknown orderBy and a pageToken that the service did not make', {
      objectSet: ACCOUNTS,
      orderBy: { fields: [{ field: 'gone' }] },
      pageToken: 'garbage',
    }),
    load('excludeRid that is not a Boolean and an unknown Object Type', {
      objectSet: base(`${NS}Missing`),
      excludeRid: 1,
    }),
    load(
      'an and of 2 refused clauses',
      accountsWhere({
        type: 'and',
        value: [
          { type: 'eq', field: 'missing', value: 'x' },
          { type: 'eq', field: 'employees', value: 'many' },
        ],
      }),
    ),
    load('a filter of an unknown Object Type with a refused where', {
      objectSet: filter(base(`${NS}Missing`), { type: 'eq', field: 'missing', value: 'x' }),
    }),
    load('a searchAround of an unknown Object Type with no link', {
      objectSet: { type: 'searchAround', objectSet: base(`${NS}Missing`) },
    }),
    aggregate('accuracy, aggregation, and groupBy, each refused', {
      objectSet: ACCOUNTS,
      accuracy: 'EXACT',
      aggregation: {},
      groupBy: 'phase',
    }),
    aggregate('aggregation and groupBy, each refused', { objectSet: ACCOUNTS, aggregation: {}, groupBy: 'phase' }),
    aggregate(
      'accuracy that is not REQUIRE_ACCURATE or ALLOW_APPROXIMATE and an unknown Object Type',
      countOf(base(`${NS}Missing`), { accuracy: 'EXACT' }),
    ),
    aggregate('an unknown Object Type and a metric of an unknown type', {
      objectSet: base(`${NS}Missing`),
      aggregation: [{ type: 'median', field: 'employees' }],
    }),
    aggregate('a refused group-by at entry 1 and a refused metric at entry 2', {
      objectSet: ACCOUNTS,
      aggregation: [COUNT, { type: 'median', field: 'employees' }],
      groupBy: [{ type: 'bucket', field: 'phase' }],
    }),
    aggregate('2 group-bys on 1 field and a metric with a direction', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'count', direction: 'DESC' }],
      groupBy: [
        { type: 'exact', field: 'phase' },
        { type: 'exact', field: 'phase' },
      ],
    }),
  ]);
});

describe('ontology/ontology-sdk/object-sets#paging', () => {
  pin([
    load('a body that is a JSON array', []),
    load('no body', undefined),
    load('snapshot that is not a Boolean', { objectSet: ACCOUNTS, snapshot: 'yes' }),
    load('excludeRid that is not a Boolean', { objectSet: ACCOUNTS, excludeRid: 1 }),
    load('pageToken that is not a string', { objectSet: ACCOUNTS, pageToken: 5 }),
    load('pageSize that is not a whole number', { objectSet: ACCOUNTS, pageSize: 1.5 }),
    load('pageSize 0', { objectSet: ACCOUNTS, pageSize: 0 }),
    load('a pageToken that the service did not make', { objectSet: ACCOUNTS, pageToken: 'garbage' }),
    load('a pageToken of another request body', { objectSet: ACCOUNTS, pageToken: OTHER_BODY_TOKEN }),
    load('defaultLoadLevel that is not an object', { objectSet: ACCOUNTS, defaultLoadLevel: 'none' }),
    load('defaultLoadLevel applyReducers', { objectSet: ACCOUNTS, defaultLoadLevel: { type: 'applyReducers' } }),
    load('defaultLoadLevel of an unknown type', { objectSet: ACCOUNTS, defaultLoadLevel: { type: 'everything' } }),
  ]);
});

describe('ontology/ontology-sdk/object-sets#objects-in-a-page', () => {
  pin([
    load('select that is not a list', { objectSet: ACCOUNTS, select: 'name' }),
    load('selectV2 that is not a list', { objectSet: ACCOUNTS, selectV2: {} }),
    load('a select entry that is not a string', { objectSet: ACCOUNTS, select: [5] }),
    load('a selectV2 entry that is not an object', { objectSet: ACCOUNTS, selectV2: ['name'] }),
    load('a selectV2 property with no apiName', { objectSet: ACCOUNTS, selectV2: [{ type: 'property' }] }),
    load('a selectV2 structField', { objectSet: STRUCT_PROBES, selectV2: [structField('relationship', 'label')] }),
    load('a selectV2 entry of an unknown type', { objectSet: ACCOUNTS, selectV2: [{ type: 'rid' }] }),
    load('a selectV2 load level extractMainValue', {
      objectSet: ACCOUNTS,
      selectV2: [
        {
          type: 'propertyWithLoadLevel',
          loadLevel: { type: 'extractMainValue' },
          propertyIdentifier: { type: 'property', apiName: 'name' },
        },
      ],
    }),
    load('a selectV2 load level of an unknown type', {
      objectSet: ACCOUNTS,
      selectV2: [
        {
          type: 'propertyWithLoadLevel',
          loadLevel: { type: 'everything' },
          propertyIdentifier: { type: 'property', apiName: 'name' },
        },
      ],
    }),
    load('a select of 1 known and 2 unknown Properties', { objectSet: ACCOUNTS, select: ['name', 'missing', 'gone'] }),
  ]);
});

describe('ontology/ontology-sdk/object-sets#order', () => {
  pin([
    load('orderBy that is not an object', { objectSet: ACCOUNTS, orderBy: 'name' }),
    load('orderBy of the type relevance', { objectSet: ACCOUNTS, orderBy: { orderType: 'relevance' } }),
    load('orderBy of an unknown orderType', { objectSet: ACCOUNTS, orderBy: { orderType: 'score', fields: [] } }),
    load('orderBy fields that is not a list', { objectSet: ACCOUNTS, orderBy: { fields: 'name' } }),
    load('an orderBy entry with no field', { objectSet: ACCOUNTS, orderBy: { fields: [{ direction: 'asc' }] } }),
    load('an orderBy direction that is not asc or desc', {
      objectSet: ACCOUNTS,
      orderBy: { fields: [{ field: 'name', direction: 'up' }] },
    }),
    load('an orderBy of an unknown Property', { objectSet: ACCOUNTS, orderBy: { fields: [{ field: 'missing' }] } }),
    load('an orderBy of 1 Property 2 times', {
      objectSet: ACCOUNTS,
      orderBy: { fields: [{ field: 'name' }, { field: 'name', direction: 'desc' }] },
    }),
    load('an orderBy of a struct Property', {
      objectSet: STRUCT_PROBES,
      orderBy: { fields: [{ field: 'relationship' }] },
    }),
    load('an orderBy of an array Property', { objectSet: ACCOUNTS, orderBy: { fields: [{ field: 'tags' }] } }),
  ]);
});

describe('ontology/ontology-sdk/object-sets#members', () => {
  pin([
    load('an objectSet that is not an object', { objectSet: ACCOUNT }),
    load('no objectSet', {}),
    load('a member of a type outside V1', { objectSet: { type: 'static', objects: [] } }),
    load('a base member with no objectType', { objectSet: { type: 'base' } }),
    load('a base member of an unknown Object Type', { objectSet: base(`${NS}Missing`) }),
    load('a union with no objectSets list', { objectSet: { type: 'union' } }),
    load('a union of no set', { objectSet: { type: 'union', objectSets: [] } }),
    load('an intersect of 2 Object Types', {
      objectSet: { type: 'intersect', objectSets: [ACCOUNTS, base(ENGAGEMENT)] },
    }),
    load('a subtract with an unknown Object Type in its second set', {
      objectSet: { type: 'subtract', objectSets: [ACCOUNTS, base(`${NS}Missing`)] },
    }),
    load('a searchAround with no link', { objectSet: { type: 'searchAround', objectSet: ACCOUNTS } }),
    load('a searchAround of an unknown Link side', {
      objectSet: { type: 'searchAround', objectSet: ACCOUNTS, link: 'partners' },
    }),
    aggregate('an aggregate of an unknown Object Type', countOf(base(`${NS}Missing`))),
  ]);
});

describe('ontology/ontology-sdk/object-sets#where-clauses', () => {
  pin([
    load('a where that is not an object', accountsWhere(5)),
    load('a where with no type', accountsWhere({ field: 'name', value: 'Acme' })),
    load(
      'an and with a value that is not a list',
      accountsWhere({ type: 'and', value: { type: 'eq', field: 'name', value: 'Acme' } }),
    ),
    load('a query with no field and no propertyIdentifier', accountsWhere({ type: 'eq', value: 'Acme' })),
    load(
      'a query with both field and propertyIdentifier',
      accountsWhere({
        type: 'eq',
        field: 'name',
        propertyIdentifier: { type: 'property', apiName: 'name' },
        value: 'Acme',
      }),
    ),
    load(
      'a propertyIdentifier that is not an object',
      accountsWhere({ type: 'eq', propertyIdentifier: 'name', value: 'Acme' }),
    ),
    load(
      'a property propertyIdentifier with no apiName',
      accountsWhere({ type: 'eq', propertyIdentifier: { type: 'property' }, value: 'Acme' }),
    ),
    load(
      'a propertyIdentifier of an unknown type',
      accountsWhere({ type: 'eq', propertyIdentifier: { type: 'rid' }, value: 'Acme' }),
    ),
    load('a query on an unknown Property', accountsWhere({ type: 'eq', field: 'missing', value: 'Acme' })),
    load(
      'a structField with no names',
      accountsWhere({ type: 'eq', propertyIdentifier: structField(), value: 'Acme' }),
    ),
    load('a structField of an unknown field', {
      objectSet: filter(STRUCT_PROBES, {
        type: 'eq',
        propertyIdentifier: structField('relationship', 'missing'),
        value: 'x',
      }),
    }),
    load(
      'a structField of a Property that is not a struct',
      accountsWhere({ type: 'eq', propertyIdentifier: structField('name', 'label'), value: 'x' }),
    ),
    load('isNull with a value that is not a Boolean', accountsWhere({ type: 'isNull', field: 'phase', value: 'yes' })),
    load('eq with a value of the wrong base type', accountsWhere({ type: 'eq', field: 'employees', value: 'many' })),
    load('gt on a Boolean', accountsWhere({ type: 'gt', field: 'active', value: true })),
    load('in with a value that is not a list', accountsWhere({ type: 'in', field: 'name', value: 'Acme' })),
    load(
      'contains on a Property that is not an array',
      accountsWhere({ type: 'contains', field: 'name', value: 'Acme' }),
    ),
    load('eq on an array Property', accountsWhere({ type: 'eq', field: 'tags', value: 'vip' })),
    load('a query outside V1', accountsWhere({ type: 'withinDistanceOf', field: 'name', value: {} })),
    load(
      'not of a query on an unknown Property',
      accountsWhere({ type: 'not', value: { type: 'eq', field: 'missing', value: 'Acme' } }),
    ),
    load('a refused clause at the deepest of 3 levels of and and or', accountsWhere(DEEP_WHERE)),
    aggregate(
      'a refused clause at the deepest of 3 levels of and and or in the objectSet filter',
      countOf(filter(ACCOUNTS, DEEP_WHERE)),
    ),
  ]);
});

describe('ontology/ontology-sdk/object-sets#text-search', () => {
  pin([
    load(
      'fuzzy that is not a Boolean',
      accountsWhere({ type: 'containsAnyTerm', field: 'name', value: 'acme', fuzzy: 'yes' }),
    ),
    load('regex', accountsWhere({ type: 'regex', field: 'name', value: 'a.*' })),
    load('interval', accountsWhere({ type: 'interval', field: 'name', rule: {} })),
    load('fuzzy true', accountsWhere({ type: 'containsAllTerms', field: 'name', value: 'acme', fuzzy: true })),
    load(
      'an analyzerSelection of an unknown name',
      accountsWhere({ type: 'containsAnyTerm', field: 'name', value: 'acme', analyzerSelection: 'STANDARD' }),
    ),
    load(
      'analyzerSelection PHONETIC_ANALYZER',
      accountsWhere({ type: 'containsAnyTerm', field: 'name', value: 'acme', analyzerSelection: 'PHONETIC_ANALYZER' }),
    ),
    load('a Property that is not Searchable', accountsWhere({ type: 'containsAnyTerm', field: 'note', value: 'acme' })),
    load('a struct field', {
      objectSet: filter(STRUCT_PROBES, {
        type: 'containsAnyTerm',
        propertyIdentifier: structField('relationship', 'label'),
        value: 'acme',
      }),
    }),
    load(
      'a Searchable Property that is not a String',
      accountsWhere({ type: 'startsWith', field: 'employees', value: '1' }),
    ),
    load('a value that is not a string', accountsWhere({ type: 'containsAllTermsInOrder', field: 'name', value: 5 })),
    load(
      'a value of 257 characters',
      accountsWhere({ type: 'containsAnyTerm', field: 'name', value: 'a'.repeat(257) }),
    ),
    load(
      '17 words in 1 query',
      accountsWhere({ type: 'containsAllTermsInOrderPrefixLastTerm', field: 'name', value: WORDS_17 }),
    ),
    load('9 and 8 words in 2 filter members of 1 tree', {
      objectSet: filter(filter(ACCOUNTS, { type: 'containsAnyTerm', field: 'name', value: 'a b c d e f g h i' }), {
        type: 'containsAnyTerm',
        field: 'phase',
        value: 'j k l m n o p q',
      }),
    }),
  ]);
});

describe('ontology/ontology-sdk/aggregations#response', () => {
  pin([
    aggregate('a body that is a JSON array', []),
    aggregate('accuracy that is not REQUIRE_ACCURATE or ALLOW_APPROXIMATE', countOf(ACCOUNTS, { accuracy: 'EXACT' })),
    aggregate('aggregation that is not a list', { objectSet: ACCOUNTS, aggregation: {} }),
    aggregate('groupBy that is not a list', countOf(ACCOUNTS, { groupBy: 'phase' })),
  ]);
});

describe('ontology/ontology-sdk/aggregations#metrics', () => {
  pin([
    aggregate('a metric that is not an object', { objectSet: ACCOUNTS, aggregation: [5] }),
    aggregate('a metric name that is not a string', { objectSet: ACCOUNTS, aggregation: [{ type: 'count', name: 5 }] }),
    aggregate('a metric direction that is not ASC or DESC', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'count', direction: 'UP' }],
    }),
    aggregate('approximatePercentile', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'approximatePercentile', field: 'employees', approximatePercentile: 0.5 }],
    }),
    aggregate('a metric of an unknown type', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'median', field: 'employees' }],
    }),
    aggregate('a metric with no field', { objectSet: ACCOUNTS, aggregation: [{ type: 'sum' }] }),
    aggregate('a metric on a struct field', {
      objectSet: STRUCT_PROBES,
      aggregation: [{ type: 'sum', propertyIdentifier: structField('measures', 'count') }],
    }),
    aggregate('a metric on an unknown Property', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'max', field: 'missing' }],
    }),
    aggregate('sum on a struct Property', {
      objectSet: STRUCT_PROBES,
      aggregation: [{ type: 'sum', field: 'measures' }],
    }),
    aggregate('sum on a String', { objectSet: ACCOUNTS, aggregation: [{ type: 'sum', field: 'name' }] }),
    aggregate('avg on a Date', { objectSet: ACCOUNTS, aggregation: [{ type: 'avg', field: 'founded' }] }),
  ]);
});

describe('ontology/ontology-sdk/aggregations#group-bys', () => {
  pin([
    aggregate('a group-by that is not an object', groupedBy(5)),
    aggregate('a group-by of an unknown type', groupedBy({ type: 'bucket', field: 'phase' })),
    aggregate('an exact group-by with no field', groupedBy({ type: 'exact' })),
    aggregate('maxGroupCount 0', groupedBy({ type: 'exact', field: 'phase', maxGroupCount: 0 })),
    aggregate('a defaultValue that is not a string', groupedBy({ type: 'exact', field: 'phase', defaultValue: 5 })),
    aggregate(
      'includeNullValues that is not a Boolean',
      groupedBy({ type: 'exact', field: 'phase', includeNullValues: 'yes' }),
    ),
    aggregate(
      'a defaultValue and includeNullValues true',
      groupedBy({ type: 'exact', field: 'phase', defaultValue: 'none', includeNullValues: true }),
    ),
    aggregate(
      'an exact group-by on a struct Property',
      countOf(STRUCT_PROBES, { groupBy: [{ type: 'exact', field: 'relationship' }] }),
    ),
    aggregate('an exact group-by on an array Property', groupedBy({ type: 'exact', field: 'tags' })),
    aggregate('fixedWidth 0', groupedBy({ type: 'fixedWidth', field: 'employees', fixedWidth: 0 })),
    aggregate('fixedWidth on a String', groupedBy({ type: 'fixedWidth', field: 'name', fixedWidth: 10 })),
    aggregate('ranges that is not a list', groupedBy({ type: 'ranges', field: 'employees', ranges: 5 })),
    aggregate('a range that is not an object', groupedBy({ type: 'ranges', field: 'employees', ranges: [5] })),
    aggregate(
      'a range bound of the wrong base type',
      groupedBy({ type: 'ranges', field: 'employees', ranges: [{ startValue: 'low', endValue: 10 }] }),
    ),
    aggregate(
      'a duration value that is not a number',
      groupedBy({ type: 'duration', field: 'founded', value: '1', unit: 'DAYS' }),
    ),
    aggregate(
      'a duration of an unknown unit',
      groupedBy({ type: 'duration', field: 'founded', value: 1, unit: 'DECADES' }),
    ),
    aggregate('a duration of 2 weeks', groupedBy({ type: 'duration', field: 'founded', value: 2, unit: 'WEEKS' })),
    aggregate(
      'a duration of 1 hour on a Date',
      groupedBy({ type: 'duration', field: 'founded', value: 1, unit: 'HOURS' }),
    ),
    aggregate('a duration on a String', groupedBy({ type: 'duration', field: 'name', value: 1, unit: 'DAYS' })),
    aggregate(
      '2 group-bys on 1 field',
      groupedBy({ type: 'exact', field: 'phase' }, { type: 'exact', field: 'phase', maxGroupCount: 5 }),
    ),
    aggregate('a metric with a direction and 2 group-bys', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'count', direction: 'DESC' }],
      groupBy: [
        { type: 'exact', field: 'phase' },
        { type: 'exact', field: 'name' },
      ],
    }),
    aggregate('a metric with a direction and includeNullValues', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'count', direction: 'ASC' }],
      groupBy: [{ type: 'exact', field: 'phase', includeNullValues: true }],
    }),
    aggregate('a metric with a direction, 2 group-bys, and includeNullValues', {
      objectSet: ACCOUNTS,
      aggregation: [{ type: 'count', direction: 'DESC' }],
      groupBy: [
        { type: 'exact', field: 'phase', includeNullValues: true },
        { type: 'exact', field: 'name' },
      ],
    }),
    aggregate(
      'a defaultValue and includeNullValues true on an unknown Property',
      groupedBy({ type: 'exact', field: 'noSuchProperty', defaultValue: 'none', includeNullValues: true }),
    ),
  ]);
});
