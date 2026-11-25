import type { OntologyIrObjectTypeBlockDataV2, OntologyIrPropertyType } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountWith,
  irOf,
  propertyOfType,
  renamed,
  stringProperty,
  twinIr,
  twinObjectType,
} from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  byPrimaryKey,
  errorAnswer,
  expectAggregate,
  insertObjects,
  NS,
  pageOf,
  startObjectSets,
  type Answer,
  type ObjectRow,
  type ObjectSetsService,
} from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const STRUCT_PROBE = `${NS}StructProbe`;

function structProbeBlock(): OntologyIrObjectTypeBlockDataV2 {
  const block = twinIr('0.6.3').ontology.objectTypes[STRUCT_PROBE];

  if (!block) throw new Error('The twin 0.6.3 IR has no StructProbe.');

  return structuredClone(block);
}

function objectTypeBlock(
  apiName: string,
  primaryKey: string,
  title: string,
  properties: readonly OntologyIrPropertyType[],
): OntologyIrObjectTypeBlockDataV2 {
  const block = renamed(twinObjectType('Account'), apiName);

  block.objectType.propertyTypes = Object.fromEntries(properties.map((property) => [property.apiName, property]));
  block.objectType.primaryKeys = [primaryKey];
  block.objectType.titlePropertyTypeRid = title;

  return block;
}

const LONG_NAMES = `${NS}LongNames`;
const LONG_KEY = `k${'a'.repeat(69)}`;
const LONG_TITLE = `n${'a'.repeat(69)}`;

const SCORE_TITLE = `${NS}ScoreTitle`;
const FLAG_TITLE = `${NS}FlagTitle`;

const IR = irOf(
  accountWith(propertyOfType('revenue', { type: 'decimal', decimal: { precision: 38, scale: 2 } })),
  structProbeBlock(),
  objectTypeBlock(LONG_NAMES, LONG_KEY, LONG_TITLE, [stringProperty(LONG_KEY), stringProperty(LONG_TITLE)]),
  objectTypeBlock(SCORE_TITLE, 'scoreId', 'score', [
    stringProperty('scoreId'),
    propertyOfType('score', { type: 'integer', integer: {} }),
  ]),
  objectTypeBlock(FLAG_TITLE, 'flagId', 'flag', [
    stringProperty('flagId'),
    propertyOfType('flag', { type: 'boolean', boolean: {} }),
  ]),
);

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(IR);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

function sortedAnswer(answer: Answer): Answer {
  const body = answer.body as Record<string, unknown>;

  return { status: answer.status, body: { ...body, data: byPrimaryKey(body.data) } };
}

const account = (accountId: string, name: string, phase: string | null): ObjectRow => ({ accountId, name, phase });

const PROBE_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'closed'),
];

describe('the Object RID', () => {
  it('service/http-api#rids: gives each Object the RID ri.phonograph2-objects.main.object.<UUID>, the UUID version 5 of object:<Object Type>:<primary key> in the namespace of the Ontology RID', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: [],
      pageSize: 1000,
    });

    expect(sortedAnswer(answer)).toEqual({
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
            __rid: 'ri.phonograph2-objects.main.object.8d7bec66-1177-57d5-8311-9617d1f43aa2',
          },
          {
            phase: 'prospect',
            accountId: 'acc-2',
            __primaryKey: 'acc-2',
            name: 'Globex',
            __title: 'Globex',
            __apiName: ACCOUNT,
            __rid: 'ri.phonograph2-objects.main.object.8f164048-7dab-5f42-97d1-76399da06441',
          },
          {
            phase: 'closed',
            accountId: 'acc-3',
            __primaryKey: 'acc-3',
            name: 'Initech',
            __title: 'Initech',
            __apiName: ACCOUNT,
            __rid: 'ri.phonograph2-objects.main.object.03aae71d-fb1a-5e2f-b568-f696aaf1576a',
          },
        ],
        totalCount: '3',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });
});

describe('the selectV2 selectors', () => {
  const phase = { type: 'property', apiName: 'phase' };

  it.each([
    ['titleProperty', [{ type: 'titleProperty' }], { name: 'Acme', __title: 'Acme' }],
    ['primaryKeyProperty', [{ type: 'primaryKeyProperty' }], {}],
    [
      'propertyWithLoadLevel phase with the load level noLoadLevel',
      [{ type: 'propertyWithLoadLevel', propertyIdentifier: phase, loadLevel: { type: 'noLoadLevel' } }],
      { phase: 'customer' },
    ],
    [
      'propertyWithLoadLevel phase with no load level',
      [{ type: 'propertyWithLoadLevel', propertyIdentifier: phase }],
      { phase: 'customer' },
    ],
    [
      'titleProperty and primaryKeyProperty',
      [{ type: 'titleProperty' }, { type: 'primaryKeyProperty' }],
      { name: 'Acme', __title: 'Acme' },
    ],
  ])(
    'ontology/ontology-sdk/object-sets#objects-in-a-page: a selectV2 of %s gives the primary key Property and the Properties that it names, and __title only for the title Property',
    async (_case, selectV2, properties) => {
      await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS.slice(0, 1));

      const answer = await service.loadObjects({
        objectSet: { type: 'base', objectType: ACCOUNT },
        select: [],
        selectV2,
        excludeRid: true,
      });

      expect(answer).toEqual({
        status: 200,
        body: {
          data: [{ __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1', ...properties }],
          totalCount: '1',
          propertySecurities: [],
          objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
        },
      });
    },
  );

  it.each([
    [
      'the load level applyReducersAndExtractMainValue',
      {
        type: 'propertyWithLoadLevel',
        propertyIdentifier: phase,
        loadLevel: { type: 'applyReducersAndExtractMainValue' },
      },
      'applyReducersAndExtractMainValue',
    ],
    [
      'the load level applyReducers',
      { type: 'propertyWithLoadLevel', propertyIdentifier: phase, loadLevel: { type: 'applyReducers' } },
      'applyReducers',
    ],
    [
      'a struct field',
      { type: 'structField', propertyApiName: 'relationship', structFieldApiName: 'label' },
      'structField',
    ],
  ])(
    'ontology/object-link-types/properties#out-of-scope: a selectV2 entry with %s, a feature outside V1, gets 400 Default:InvalidArgument with the feature',
    async (_case, identifier, feature) => {
      const answer = await service.loadObjects({
        objectSet: { type: 'base', objectType: STRUCT_PROBE },
        select: [],
        selectV2: [identifier],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { feature } },
      });
    },
  );

  it('service/http-api#errors: a selectV2 of 1 unknown Property gets 404 PropertiesNotFound, with its name', async () => {
    const answer = await service.loadObjects({
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: [],
      selectV2: [{ type: 'property', apiName: 'nope' }],
    });

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'PropertiesNotFound',
        parameters: { objectType: ACCOUNT, properties: ['nope'] },
      },
    });
  });

  it.each([
    ['the String "phase"', 'phase'],
    ['the unknown type nope', { type: 'nope', apiName: 'phase' }],
    ['a property with the API name 5', { type: 'property', apiName: 5 }],
    [
      'the load level "noLoadLevel", a String',
      { type: 'propertyWithLoadLevel', propertyIdentifier: phase, loadLevel: 'noLoadLevel' },
    ],
    [
      'the unknown load level nope',
      { type: 'propertyWithLoadLevel', propertyIdentifier: phase, loadLevel: { type: 'nope' } },
    ],
  ])(
    'ontology/ontology-sdk/object-sets#objects-in-a-page: a selectV2 entry of %s gets 400 Default:InvalidArgument',
    async (_case, identifier) => {
      const answer = await service.loadObjects({
        objectSet: { type: 'base', objectType: ACCOUNT },
        select: [],
        selectV2: [identifier],
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { field: 'selectV2' },
        },
      });
    },
  );
});

describe('the errors of the request', () => {
  it('service/http-api#errors: an unknown Object Type gets 404 ObjectTypeNotFound, with the objectType parameter', async () => {
    const objectType = `${NS}Nope`;

    const answer = await service.loadObjects({ objectSet: { type: 'base', objectType }, select: [] });

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: { errorCode: 'NOT_FOUND', errorName: 'ObjectTypeNotFound', parameters: { objectType } },
    });
  });

  it.each([0, -1])('service/http-api#errors: a pageSize of %i gets 400 InvalidPageSize', async (pageSize) => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.loadObjects({
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: [],
      pageSize,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidPageSize', parameters: { pageSize } },
    });
  });

  it.each([
    ['defaultLoadLevel extractMainValue', { defaultLoadLevel: { type: 'extractMainValue' } }, 'extractMainValue'],
    [
      'a selectV2 Property with the load level extractMainValue',
      {
        selectV2: [
          {
            type: 'propertyWithLoadLevel',
            propertyIdentifier: { type: 'property', apiName: 'relationship' },
            loadLevel: { type: 'extractMainValue' },
          },
        ],
      },
      'extractMainValue',
    ],
    [
      'defaultLoadLevel applyReducersAndExtractMainValue',
      { defaultLoadLevel: { type: 'applyReducersAndExtractMainValue' } },
      'applyReducersAndExtractMainValue',
    ],
  ])(
    'ontology/object-link-types/properties#out-of-scope: a request for the EXTRACT_MAIN_VALUE load level (%s) gets 400 Default:InvalidArgument',
    async (_case, fields, feature) => {
      const answer = await service.loadObjects({
        objectSet: { type: 'base', objectType: STRUCT_PROBE },
        select: [],
        selectV2: [],
        ...fields,
      });

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { feature } },
      });
    },
  );
});

describe('the JSON form of each value', () => {
  it('ontology/object-link-types/properties#base-types: gives a Decimal value as an exact string', async () => {
    await insertObjects(service.db, ACCOUNT, [
      { ...account('acc-1', 'Acme', 'customer'), revenue: '1299.95' },
      { ...account('acc-2', 'Globex', 'prospect'), revenue: '123456789012345678901234567890123456.78' },
      { ...account('acc-3', 'Initech', 'closed'), revenue: null },
    ]);

    const answer = await service.loadObjects({
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: [],
      excludeRid: true,
    });

    expect(sortedAnswer(answer)).toEqual({
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
            revenue: '1299.95',
          },
          {
            phase: 'prospect',
            accountId: 'acc-2',
            __primaryKey: 'acc-2',
            name: 'Globex',
            __title: 'Globex',
            __apiName: ACCOUNT,
            revenue: '123456789012345678901234567890123456.78',
          },
          {
            phase: 'closed',
            accountId: 'acc-3',
            __primaryKey: 'acc-3',
            name: 'Initech',
            __title: 'Initech',
            __apiName: ACCOUNT,
          },
        ],
        totalCount: '3',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });

  it('ontology/object-link-types/properties#base-types: gives each struct value in the JSON form of Structs', async () => {
    const probe = (probeId: string, relationship: ObjectRow[string], measures: ObjectRow[string]): ObjectRow => ({
      probeId,
      relationship,
      measures,
    });

    const before = { label: 'before', since: '2020-01-01' };

    await insertObjects(service.db, STRUCT_PROBE, [
      probe('sp-1', { label: 'poll', since: '2024-01-01' }, {}),
      probe('sp-2', {}, {}),
      probe('sp-3', { label: 'introduced' }, {}),
      probe('sp-4', { label: 'met', since: '2026-01-02' }, {}),
      probe(
        'sp-5',
        { label: 'met', since: '2026-01-02' },
        { flag: true, count: 3, score: 2.5, at: '2026-10-17T12:00:00Z' },
      ),
      probe('sp-6', {}, { flag: false, count: -1, score: 0, at: '2025-01-01T00:00:00.123Z' }),
      probe('sp-f1', before, {}),
      probe('sp-f2', before, {}),
      probe('sp-f3', before, {}),
      probe('sp-f4', before, {}),
      probe('sp-f5', null, {}),
      probe('sp-f6', {}, {}),
      probe('sp-f7', before, {}),
    ]);

    const answer = await service.loadObjects({
      objectSet: { type: 'base', objectType: STRUCT_PROBE },
      select: [],
      pageSize: 1000,
      excludeRid: true,
    });

    const object = (probeId: string, fields: Record<string, unknown>) => ({
      __primaryKey: probeId,
      probeId,
      __title: probeId,
      __apiName: STRUCT_PROBE,
      ...fields,
    });

    expect(sortedAnswer(answer)).toEqual({
      status: 200,
      body: {
        data: [
          object('sp-1', { measures: {}, relationship: { label: 'poll', since: '2024-01-01' } }),
          object('sp-2', { measures: {}, relationship: {} }),
          object('sp-3', { measures: {}, relationship: { label: 'introduced' } }),
          object('sp-4', { measures: {}, relationship: { label: 'met', since: '2026-01-02' } }),
          object('sp-5', {
            measures: { flag: true, count: 3, score: 2.5, at: '2026-10-17T12:00:00Z' },
            relationship: { label: 'met', since: '2026-01-02' },
          }),
          object('sp-6', {
            measures: { flag: false, count: -1, score: 0, at: '2025-01-01T00:00:00.123Z' },
            relationship: {},
          }),
          object('sp-f1', { measures: {}, relationship: { label: 'before', since: '2020-01-01' } }),
          object('sp-f2', { measures: {}, relationship: { label: 'before', since: '2020-01-01' } }),
          object('sp-f3', { measures: {}, relationship: { label: 'before', since: '2020-01-01' } }),
          object('sp-f4', { measures: {}, relationship: { label: 'before', since: '2020-01-01' } }),
          object('sp-f5', { measures: {} }),
          object('sp-f6', { measures: {}, relationship: {} }),
          object('sp-f7', { measures: {}, relationship: { label: 'before', since: '2020-01-01' } }),
        ],
        totalCount: '13',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [STRUCT_PROBE] },
      },
    });
  });
});

describe('paging', () => {
  it('ontology/ontology-sdk/object-sets#paging: ignores snapshot, so page 2 shows an Object that a create added after page 1', async () => {
    await insertObjects(service.db, ACCOUNT, [
      ...PROBE_ACCOUNTS,
      account('p-a', 'Probe phase a', 'a'),
      account('p-null', 'Probe null phase', null),
    ]);

    const request = {
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: [],
      pageSize: 2,
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
      snapshot: true,
    };

    const first = await service.loadObjects(request);

    expect(pageOf(first)).toEqual({
      status: 200,
      primaryKeys: ['acc-1', 'acc-2'],
      nextPageToken: 'string',
      totalCount: '5',
      fields: ['data', 'nextPageToken', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });

    await insertObjects(service.db, ACCOUNT, [account('p-0snap', 'Added after page 1, snapshot true', null)]);

    const pageToken = (first.body as { nextPageToken: string }).nextPageToken;

    expect(pageOf(await service.loadObjects({ ...request, pageToken }))).toEqual({
      status: 200,
      primaryKeys: ['acc-3', 'p-0snap'],
      nextPageToken: 'string',
      totalCount: '6',
      fields: ['data', 'nextPageToken', 'propertySecurities', 'totalCount'],
    });
  });

  it.each([
    ['no pageSize', 1000, {}],
    ['pageSize 10000', 10_000, { pageSize: 10_000 }],
    ['pageSize 10001', 10_000, { pageSize: 10_001 }],
    ['pageSize 100000', 10_000, { pageSize: 100_000 }],
  ])(
    'ontology/ontology-sdk/object-sets#paging: with %s, a page of 10,001 Accounts holds %i Objects, as the default of 1,000 and the maximum of 10,000 give',
    async (_case, size, fields) => {
      await service.db.query(
        sql(`INSERT INTO ontology_1_objects.account (account_id, name)
             SELECT 'acc-' || lpad(n::text, 5, '0'), 'Account ' || n FROM generate_series(1, 10001) AS n`),
      );

      const answer = await service.loadObjects({
        objectSet: { type: 'base', objectType: ACCOUNT },
        select: [],
        ...fields,
      });

      const page = pageOf(answer);

      expect({
        ...page,
        primaryKeys: Array.isArray(page.primaryKeys) ? page.primaryKeys.length : page.primaryKeys,
      }).toEqual({
        status: 200,
        primaryKeys: size,
        nextPageToken: 'string',
        totalCount: '10001',
        fields: ['data', 'nextPageToken', 'objectSetEntities', 'propertySecurities', 'totalCount'],
      });
    },
  );
});

describe('the Property API names longer than 63 bytes', () => {
  const RID: Readonly<Record<string, string>> = {
    'ln-1': 'ri.phonograph2-objects.main.object.a3c08aa4-f052-5e76-b224-98d610a8b1f5',
    'ln-2': 'ri.phonograph2-objects.main.object.08fcfc13-006f-5c40-b624-d0bde0e2eebf',
  };

  const longNames = (key: string, title: string) => ({
    __apiName: LONG_NAMES,
    __primaryKey: key,
    __title: title,
    __rid: RID[key],
    [LONG_KEY]: key,
    [LONG_TITLE]: title,
  });

  it('ontology/ontology-sdk/object-sets#objects-in-a-page: an Object Type whose primary key and title Property have API names of 70 characters reads each value, on 2 pages ordered by the title', async () => {
    await insertObjects(service.db, LONG_NAMES, [
      { [LONG_KEY]: 'ln-1', [LONG_TITLE]: 'Alpha' },
      { [LONG_KEY]: 'ln-2', [LONG_TITLE]: 'Beta' },
    ]);

    const request = {
      objectSet: { type: 'base', objectType: LONG_NAMES },
      select: [],
      pageSize: 1,
      orderBy: { fields: [{ field: LONG_TITLE, direction: 'asc' }] },
    };

    const first = await service.loadObjects(request);

    const { nextPageToken, ...firstBody } = first.body as Record<string, unknown>;

    expect(typeof nextPageToken).toBe('string');

    expect({ status: first.status, body: firstBody }).toEqual({
      status: 200,
      body: {
        data: [longNames('ln-1', 'Alpha')],
        totalCount: '2',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [LONG_NAMES] },
      },
    });

    expect(await service.loadObjects({ ...request, pageToken: nextPageToken })).toEqual({
      status: 200,
      body: { data: [longNames('ln-2', 'Beta')], totalCount: '2', propertySecurities: [] },
    });
  });

  it('ontology/ontology-sdk/aggregations#group-bys: an aggregate grouped by a Property with an API name of 70 characters, with a metric on another, keys each group by the API name', async () => {
    await insertObjects(service.db, LONG_NAMES, [
      { [LONG_KEY]: 'ln-1', [LONG_TITLE]: 'Alpha' },
      { [LONG_KEY]: 'ln-2', [LONG_TITLE]: 'Alpha' },
    ]);

    const answer = await service.aggregate({
      objectSet: { type: 'base', objectType: LONG_NAMES },
      groupBy: [{ type: 'exact', field: LONG_TITLE }],
      aggregation: [{ type: 'exactDistinct', field: LONG_KEY, name: 'keys' }],
    });

    expectAggregate(answer, {
      status: 200,
      body: {
        excludedItems: 0,
        accuracy: 'ACCURATE',
        data: [{ group: { [LONG_TITLE]: 'Alpha' }, metrics: [{ name: 'keys', value: 2 }] }],
      },
    });
  });
});

describe('the title of an Object', () => {
  it.each([
    [
      'the Integer score 42',
      SCORE_TITLE,
      { scoreId: 's-1', score: 42 },
      { __apiName: SCORE_TITLE, __primaryKey: 's-1', __title: '42', scoreId: 's-1', score: 42 },
    ],
    [
      'the Boolean flag false',
      FLAG_TITLE,
      { flagId: 'f-1', flag: false },
      { __apiName: FLAG_TITLE, __primaryKey: 'f-1', __title: 'false', flagId: 'f-1', flag: false },
    ],
  ] as const)(
    'ontology/ontology-sdk/object-sets#objects-in-a-page: the title Property %s gives __title as a string, and the Property its own value',
    async (_case, objectType, row, object) => {
      await insertObjects(service.db, objectType, [row]);

      const answer = await service.loadObjects({
        objectSet: { type: 'base', objectType },
        select: [],
        excludeRid: true,
      });

      expect(answer).toEqual({
        status: 200,
        body: {
          data: [object],
          totalCount: '1',
          propertySecurities: [],
          objectSetEntities: { objectTypeApiNames: [objectType] },
        },
      });
    },
  );
});
