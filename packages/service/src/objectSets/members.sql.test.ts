import type { OntologyIrLinkTypeBlockDataV2 } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/promise.test-utils.ts';
import { CLIENT_ENGAGEMENTS } from '../actions/actions.test-utils.ts';
import { irOf, twinBlock, twinIr } from '../ontology/stored.test-utils.ts';
import { manyToManyLink, sql } from '../publish/publish.test-utils.ts';
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

function twinLink(id: string): OntologyIrLinkTypeBlockDataV2 {
  const block = twinIr('0.6.3').ontology.linkTypes[id];

  if (!block) throw new Error(`The twin 0.6.3 IR has no Link Type ${id}.`);

  return structuredClone(block);
}

const IR = irOf(twinBlock('0.6.3', ACCOUNT), twinBlock('0.6.3', ENGAGEMENT));

for (const link of [
  twinLink('account-to-engagements'),
  manyToManyLink(
    'engagement-sponsors',
    { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
    { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
  ),
  manyToManyLink(
    'account-partners',
    { type: ACCOUNT, key: 'accountId', side: 'partners' },
    { type: ACCOUNT, key: 'accountId', side: 'partnerOf' },
  ),
]) {
  IR.ontology.linkTypes[link.linkType.id] = link;
}

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(IR);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

async function insertLinks(
  db: Db,
  table: 'engagement_sponsors' | 'account_partners',
  pairs: readonly (readonly [string, string])[],
): Promise<void> {
  const [a, b] =
    table === 'engagement_sponsors' ? ['a_engagement_id', 'b_account_id'] : ['a_account_id', 'b_account_id'];

  for (const [left, right] of pairs)
    await db.query(sql(`INSERT INTO ontology_1_objects.${table} (${a}, ${b}) VALUES ($1, $2)`, left, right));
}

function setAnswer(answer: Answer): Answer {
  const body = answer.body as Record<string, unknown>;

  if (answer.status !== 200) return answer;

  const entities = body.objectSetEntities as { objectTypeApiNames?: unknown } | undefined;
  const names = entities?.objectTypeApiNames;

  return {
    status: answer.status,
    body: {
      ...body,
      data: byPrimaryKey(body.data),
      ...(entities
        ? {
            objectSetEntities: {
              ...entities,
              objectTypeApiNames: Array.isArray(names) ? [...(names as string[])].sort() : names,
            },
          }
        : {}),
    },
  };
}

function load(objectSet: unknown, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectSet,
    select: [],
    selectV2: [],
    loadPropertySecurities: false,
    excludeRid: true,
    snapshot: false,
    ...fields,
  };
}

const base = (objectType: string) => ({ type: 'base', objectType });

const eq = (objectType: string, field: string, value: string) => ({
  type: 'filter',
  objectSet: base(objectType),
  where: { type: 'eq', field, value },
});

const searchAround = (objectSet: unknown, link: string) => ({ type: 'searchAround', objectSet, link });

const account = (accountId: string, name: string, phase: string): ObjectRow => ({ accountId, name, phase });

const CLIENT_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'customer'),
];

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

const OBJECT = {
  'acc-1': {
    phase: 'customer',
    accountId: 'acc-1',
    __primaryKey: 'acc-1',
    name: 'Acme',
    __title: 'Acme',
    __apiName: ACCOUNT,
  },
  'acc-2': {
    phase: 'prospect',
    accountId: 'acc-2',
    __primaryKey: 'acc-2',
    name: 'Globex',
    __title: 'Globex',
    __apiName: ACCOUNT,
  },
  'acc-3': {
    phase: 'customer',
    accountId: 'acc-3',
    __primaryKey: 'acc-3',
    name: 'Initech',
    __title: 'Initech',
    __apiName: ACCOUNT,
  },
  'eng-1': {
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
  'eng-2': {
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
  'eng-3': {
    accountId: 'acc-1',
    createdAt: '2026-10-17T18:20:05.991Z',
    __primaryKey: 'eng-3',
    amount: 6000,
    __title: 'Support retainer',
    __apiName: ENGAGEMENT,
    title: 'Support retainer',
    engagementId: 'eng-3',
    status: 'open',
  },
  'eng-4': {
    accountId: 'acc-2',
    createdAt: '2026-10-17T18:20:06.135Z',
    __primaryKey: 'eng-4',
    amount: 15000,
    __title: 'Pilot',
    __apiName: ENGAGEMENT,
    title: 'Pilot',
    engagementId: 'eng-4',
    status: 'lost',
  },
} as const;

const page = (data: readonly unknown[], totalCount: string, objectTypeApiNames: readonly string[]) => ({
  data,
  totalCount,
  propertySecurities: [],
  objectSetEntities: { objectTypeApiNames },
});

async function insertClientObjects(): Promise<void> {
  await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

  await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);
}

describe('union, intersect, and subtract', () => {
  it('ontology/ontology-sdk/object-sets#members: union gives each Object that any of its sets holds, 1 time', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(
      load({ type: 'union', objectSets: [eq(ACCOUNT, 'accountId', 'acc-1'), eq(ACCOUNT, 'phase', 'customer')] }),
    );

    expect(setAnswer(answer)).toEqual({ status: 200, body: page([OBJECT['acc-1'], OBJECT['acc-3']], '2', [ACCOUNT]) });
  });

  it('ontology/ontology-sdk/object-sets#members: intersect gives each Object that all of its sets hold', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(
      load({ type: 'intersect', objectSets: [eq(ACCOUNT, 'phase', 'customer'), eq(ACCOUNT, 'accountId', 'acc-3')] }),
    );

    expect(setAnswer(answer)).toEqual({ status: 200, body: page([OBJECT['acc-3']], '1', [ACCOUNT]) });
  });

  it('ontology/ontology-sdk/object-sets#members: subtract gives each Object of its first set that no later set holds', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(
      load({
        type: 'subtract',
        objectSets: [base(ACCOUNT), eq(ACCOUNT, 'phase', 'prospect'), eq(ACCOUNT, 'accountId', 'acc-1')],
      }),
    );

    expect(setAnswer(answer)).toEqual({ status: 200, body: page([OBJECT['acc-3']], '1', [ACCOUNT]) });
  });

  it('ontology/ontology-sdk/object-sets#members ontology/ontology-sdk/object-sets#objects-in-a-page: subtract of a searchAround and a filter combines the 2 members, and lists both Object Types', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(
      load({
        type: 'subtract',
        objectSets: [searchAround(eq(ACCOUNT, 'accountId', 'acc-1'), 'engagements'), eq(ENGAGEMENT, 'status', 'won')],
      }),
    );

    expect(setAnswer(answer)).toEqual({
      status: 200,
      body: page([OBJECT['eng-2'], OBJECT['eng-3']], '2', [ACCOUNT, ENGAGEMENT]),
    });
  });

  it('ontology/ontology-sdk/object-sets#members: the pages of a searchAround of a union, ordered by amount desc, hold each Object 1 time', async () => {
    await insertClientObjects();

    const request = load(
      searchAround(
        { type: 'union', objectSets: [eq(ACCOUNT, 'accountId', 'acc-1'), eq(ACCOUNT, 'accountId', 'acc-3')] },
        'engagements',
      ),
      {
        pageSize: 2,
        orderBy: { fields: [{ field: 'amount', direction: 'desc' }] },
      },
    );

    const first = await service.loadObjects(request);

    expect(pageOf(first)).toEqual({
      status: 200,
      primaryKeys: ['eng-2', 'eng-6'],
      nextPageToken: 'string',
      totalCount: '5',
      fields: ['data', 'nextPageToken', 'objectSetEntities', 'propertySecurities', 'totalCount'],
    });

    const second = await service.loadObjects({
      ...request,
      pageToken: (first.body as { nextPageToken: string }).nextPageToken,
    });

    expect(pageOf(second)).toEqual({
      status: 200,
      primaryKeys: ['eng-1', 'eng-5'],
      nextPageToken: 'string',
      totalCount: '5',
      fields: ['data', 'nextPageToken', 'propertySecurities', 'totalCount'],
    });

    const third = await service.loadObjects({
      ...request,
      pageToken: (second.body as { nextPageToken: string }).nextPageToken,
    });

    expect(pageOf(third)).toEqual({
      status: 200,
      primaryKeys: ['eng-3'],
      nextPageToken: 'undefined',
      totalCount: '5',
      fields: ['data', 'propertySecurities', 'totalCount'],
    });
  });

  it.each([
    ['union', [base(ACCOUNT), base(ENGAGEMENT)]],
    ['intersect', [base(ACCOUNT), base(ENGAGEMENT)]],
    ['subtract', [base(ACCOUNT), searchAround(base(ACCOUNT), 'engagements')]],
  ])(
    'ontology/ontology-sdk/object-sets#members: the member %s of sets of 2 Object Types gets 400 Default:InvalidArgument',
    async (type, objectSets) => {
      await insertClientObjects();

      const answer = await service.loadObjects(load({ type, objectSets }));

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { field: 'objectSet' },
        },
      });
    },
  );
});

describe('searchAround from each side of a Link Type', () => {
  it('ontology/object-link-types/link-types#parts ontology/ontology-sdk/object-sets#members: from Account through engagements, a foreign key on the target', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(load(searchAround(eq(ACCOUNT, 'accountId', 'acc-1'), 'engagements')));

    expect(setAnswer(answer)).toEqual({
      status: 200,
      body: page([OBJECT['eng-1'], OBJECT['eng-2'], OBJECT['eng-3']], '3', [ACCOUNT, ENGAGEMENT]),
    });
  });

  it('ontology/object-link-types/link-types#parts ontology/ontology-sdk/object-sets#members: from Engagement through account, a foreign key on this side', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(
      load(searchAround(eq(ENGAGEMENT, 'engagementId', 'eng-4'), 'account'), { pageSize: 1 }),
    );

    expect(setAnswer(answer)).toEqual({ status: 200, body: page([OBJECT['acc-2']], '1', [ACCOUNT, ENGAGEMENT]) });
  });

  it('ontology/object-link-types/link-types#parts: from side A and from side B of a join table', async () => {
    await insertClientObjects();

    await insertLinks(service.db, 'engagement_sponsors', [
      ['eng-1', 'acc-2'],
      ['eng-1', 'acc-3'],
      ['eng-4', 'acc-3'],
    ]);

    const sponsors = await service.loadObjects(load(searchAround(eq(ENGAGEMENT, 'engagementId', 'eng-1'), 'sponsors')));

    expect(setAnswer(sponsors)).toEqual({
      status: 200,
      body: page([OBJECT['acc-2'], OBJECT['acc-3']], '2', [ACCOUNT, ENGAGEMENT]),
    });

    const sponsored = await service.loadObjects(
      load(searchAround(eq(ACCOUNT, 'accountId', 'acc-3'), 'sponsoredEngagements')),
    );

    expect(setAnswer(sponsored)).toEqual({
      status: 200,
      body: page([OBJECT['eng-1'], OBJECT['eng-4']], '2', [ACCOUNT, ENGAGEMENT]),
    });
  });

  it('ontology/object-link-types/link-types#parts: a second Link Type between Account and Engagement is a separate relationship', async () => {
    await insertClientObjects();

    await insertLinks(service.db, 'engagement_sponsors', [['eng-1', 'acc-2']]);

    const accountOf = await service.loadObjects(load(searchAround(eq(ENGAGEMENT, 'engagementId', 'eng-1'), 'account')));

    expect(setAnswer(accountOf)).toEqual({ status: 200, body: page([OBJECT['acc-1']], '1', [ACCOUNT, ENGAGEMENT]) });

    const engagementsOf = await service.loadObjects(
      load(searchAround(eq(ACCOUNT, 'accountId', 'acc-2'), 'engagements')),
    );

    expect(setAnswer(engagementsOf)).toEqual({
      status: 200,
      body: page([OBJECT['eng-4']], '1', [ACCOUNT, ENGAGEMENT]),
    });
  });

  it('ontology/object-link-types/link-types#parts: from side A and from side B of a self-link', async () => {
    await insertClientObjects();

    await insertLinks(service.db, 'account_partners', [
      ['acc-1', 'acc-2'],
      ['acc-2', 'acc-3'],
    ]);

    const partners = await service.loadObjects(load(searchAround(eq(ACCOUNT, 'accountId', 'acc-2'), 'partners')));

    expect(setAnswer(partners)).toEqual({ status: 200, body: page([OBJECT['acc-3']], '1', [ACCOUNT]) });

    const partnerOf = await service.loadObjects(load(searchAround(eq(ACCOUNT, 'accountId', 'acc-2'), 'partnerOf')));

    expect(setAnswer(partnerOf)).toEqual({ status: 200, body: page([OBJECT['acc-1']], '1', [ACCOUNT]) });
  });

  it('ontology/object-link-types/link-types#parts: a searchAround of a searchAround follows the Link Type in each direction', async () => {
    await insertClientObjects();

    const answer = await service.loadObjects(
      load(searchAround(searchAround(eq(ACCOUNT, 'accountId', 'acc-2'), 'engagements'), 'account')),
    );

    expect(setAnswer(answer)).toEqual({ status: 200, body: page([OBJECT['acc-2']], '1', [ACCOUNT, ENGAGEMENT]) });
  });

  it('ontology/ontology-sdk/object-sets#members: a searchAround gives each linked Object 1 time, also when many Objects link to it', async () => {
    await insertClientObjects();

    await insertLinks(service.db, 'engagement_sponsors', [
      ['eng-1', 'acc-3'],
      ['eng-4', 'acc-3'],
    ]);

    const accounts = await service.loadObjects(load(searchAround(base(ENGAGEMENT), 'account')));

    expect(setAnswer(accounts)).toEqual({
      status: 200,
      body: page([OBJECT['acc-1'], OBJECT['acc-2'], OBJECT['acc-3']], '3', [ACCOUNT, ENGAGEMENT]),
    });

    const sponsors = await service.loadObjects(load(searchAround(base(ENGAGEMENT), 'sponsors')));

    expect(setAnswer(sponsors)).toEqual({ status: 200, body: page([OBJECT['acc-3']], '1', [ACCOUNT, ENGAGEMENT]) });
  });

  it.each([
    ['a name that no Link Type has', searchAround(base(ACCOUNT), 'nope'), ACCOUNT, 'nope'],
    ['the side of Engagement, on Account', searchAround(base(ACCOUNT), 'account'), ACCOUNT, 'account'],
    [
      'the side of Account, on the Engagements of a searchAround',
      searchAround(searchAround(base(ACCOUNT), 'engagements'), 'partners'),
      ENGAGEMENT,
      'partners',
    ],
  ])(
    'ontology/ontology-sdk/object-sets#members: a searchAround through %s gets 404 LinkTypeNotFound',
    async (_case, objectSet, objectType, linkType) => {
      await insertClientObjects();

      const answer = await service.loadObjects(load(objectSet));

      expect(errorAnswer(answer)).toEqual({
        status: 404,
        body: { errorCode: 'NOT_FOUND', errorName: 'LinkTypeNotFound', parameters: { objectType, linkType } },
      });
    },
  );
});

describe('a Link to a missing Object', () => {
  async function insertOrphans(): Promise<void> {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    await insertObjects(service.db, ENGAGEMENT, [
      engagement('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
      { engagementId: 'eng-8', accountId: 'acc-404', title: 'Link to a missing Account' },
      { engagementId: 'eng-9', accountId: null, title: 'No Account' },
    ]);
  }

  it('service/storage#links: from Engagement through account, a foreign key to a missing Account resolves to no Object', async () => {
    await insertOrphans();

    const all = await service.loadObjects(load(searchAround(base(ENGAGEMENT), 'account')));

    expect(setAnswer(all)).toEqual({ status: 200, body: page([OBJECT['acc-2']], '1', [ACCOUNT, ENGAGEMENT]) });

    const orphan = await service.loadObjects(load(searchAround(eq(ENGAGEMENT, 'engagementId', 'eng-8'), 'account')));

    expect(setAnswer(orphan)).toEqual({ status: 200, body: page([], '0', [ACCOUNT, ENGAGEMENT]) });
  });

  it('service/storage#links: from Account through engagements, an Engagement whose foreign key names a missing Account is not in the set', async () => {
    await insertOrphans();

    const answer = await service.loadObjects(load(searchAround(base(ACCOUNT), 'engagements')));

    expect(setAnswer(answer)).toEqual({ status: 200, body: page([OBJECT['eng-4']], '1', [ACCOUNT, ENGAGEMENT]) });
  });

  it('service/storage#links: from each side of a join table, a row with a missing Object resolves to no Object', async () => {
    await insertClientObjects();

    await insertLinks(service.db, 'engagement_sponsors', [
      ['eng-1', 'acc-2'],
      ['eng-1', 'acc-404'],
      ['eng-404', 'acc-2'],
    ]);

    const sponsors = await service.loadObjects(load(searchAround(eq(ENGAGEMENT, 'engagementId', 'eng-1'), 'sponsors')));

    expect(setAnswer(sponsors)).toEqual({ status: 200, body: page([OBJECT['acc-2']], '1', [ACCOUNT, ENGAGEMENT]) });

    const sponsored = await service.loadObjects(
      load(searchAround(eq(ACCOUNT, 'accountId', 'acc-2'), 'sponsoredEngagements')),
    );

    expect(setAnswer(sponsored)).toEqual({ status: 200, body: page([OBJECT['eng-1']], '1', [ACCOUNT, ENGAGEMENT]) });
  });
});

describe('a member outside V1', () => {
  it.each([
    ['static', { type: 'static', objects: [] }],
    [
      'reference',
      { type: 'reference', reference: 'ri.object-set.main.object-set.00000000-0000-0000-0000-000000000000' },
    ],
    ['interfaceBase', { type: 'interfaceBase', interfaceType: `${NS}Nope` }],
    [
      'interfaceLinkSearchAround',
      { type: 'interfaceLinkSearchAround', objectSet: base(ACCOUNT), interfaceLink: 'nope' },
    ],
    ['asType', { type: 'asType', entityType: ACCOUNT, objectSet: base(ACCOUNT) }],
    ['asBaseObjectTypes', { type: 'asBaseObjectTypes', objectSet: base(ACCOUNT) }],
    [
      'nearestNeighbors',
      {
        type: 'nearestNeighbors',
        objectSet: base(ACCOUNT),
        propertyIdentifier: { type: 'property', apiName: 'name' },
        numNeighbors: 1,
        query: { type: 'text', value: 'Acme' },
      },
    ],
    ['methodInput', { type: 'methodInput' }],
    ['nope', { type: 'nope' }],
  ])(
    'ontology/ontology-sdk/object-sets#members: the member %s gets 400 Default:InvalidArgument',
    async (feature, objectSet) => {
      await insertClientObjects();

      const answer = await service.loadObjects(load(objectSet));

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: { feature } },
      });
    },
  );

  it.each([
    ['a union', { type: 'union', objectSets: [base(ACCOUNT), { type: 'static', objects: [] }] }],
    ['a searchAround', searchAround({ type: 'static', objects: [] }, 'engagements')],
  ])(
    'ontology/ontology-sdk/object-sets#members: the member static in %s gets 400 Default:InvalidArgument',
    async (_case, objectSet) => {
      await insertClientObjects();

      const answer = await service.loadObjects(load(objectSet));

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'Default:InvalidArgument',
          parameters: { feature: 'static' },
        },
      });
    },
  );
});

describe('objectSetEntities', () => {
  it('ontology/ontology-sdk/object-sets#objects-in-a-page: the first page of a base Object Set lists its 1 Object Type', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('acc-1', 'Acme', 'customer'),
      account('acc-2', 'Globex', 'prospect'),
      account('acc-3', 'Initech', 'closed'),
      account('p-a', 'Probe phase a', 'a'),
      { accountId: 'p-null', name: 'Probe null phase', phase: null },
    ]);

    const answer = await service.loadObjects({ objectSet: base(ACCOUNT), select: [], pageSize: 1000 });

    expect(setAnswer(answer)).toEqual({
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
          {
            phase: 'a',
            accountId: 'p-a',
            __primaryKey: 'p-a',
            name: 'Probe phase a',
            __title: 'Probe phase a',
            __apiName: ACCOUNT,
            __rid: 'ri.phonograph2-objects.main.object.0cbb1d84-6195-524c-8336-eace42c790e2',
          },
          {
            name: 'Probe null phase',
            __title: 'Probe null phase',
            accountId: 'p-null',
            __primaryKey: 'p-null',
            __apiName: ACCOUNT,
            __rid: 'ri.phonograph2-objects.main.object.94f9b677-3cc0-5f3f-8899-b8b48c68f868',
          },
        ],
        totalCount: '5',
        propertySecurities: [],
        objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      },
    });
  });
});
