import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertObjects, NS, startActions, type ActionsService, type RawAnswer } from './actions/actions.test-utils.ts';
import { propertyPoliciesIr } from './ontology/stored.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions/functions.test-utils.ts';
import { sql } from './publish/publish.test-utils.ts';
import { groupGrants, policyPeople, PROPERTY_ROLES } from './policiesPeople.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ONTOLOGY = `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}`;

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    ben: { sub: 'user_ben', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
    guest: { sub: 'user_guest', role: 'guest' },
    auditor: { sub: 'user_aud', role: 'auditor' },
  },
  PROPERTY_ROLES,
);

type Person = keyof typeof PEOPLE;

const SEES_PAY: Readonly<Record<Person, readonly string[]>> = {
  ann: ['acc-1', 'acc-2'],
  ben: ['acc-2'],
  admin: ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5'],
  guest: [],
  auditor: [],
};

const PAY = ['name', 'phase', 'region', 'rate', 'profile'] as const;
const SEES_OPS: readonly Person[] = ['admin', 'auditor'];
const OPS = ['notes', 'score', 'cost', 'startDate', 'seenAt', 'active'] as const;

const FUNCTIONS: TestFunction[] = [
  { apiName: 'readRates', inputs: [{ name: 'note', type: 'string' }], edits: [ENGAGEMENT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

export const functions = {
  readRates: async (client, note) => {
    const batch = createEditBatch(client);
    const page = await client(Account).fetchPage({ $orderBy: { accountId: 'asc' } });
    const seen = page.data.map((account) => [account.$primaryKey, account.rate ?? null, account.phase ?? null]);
    batch.update({ $apiName: '${ENGAGEMENT}', $primaryKey: 'eng-1' }, { title: JSON.stringify({ note, seen }) });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, propertyPoliciesIr());

  const mine = functions.discovered.filter((fn) => JSON.stringify(fn.locator).includes('readRates'));

  service = await startActions(ir, { ...functions, discovered: mine }, groupGrants(ir, PROPERTY_ROLES));

  await service.db.query(sql('ALTER TABLE ontology_1_objects.account ALTER COLUMN name DROP NOT NULL'));
});

afterAll(() => service?.stop());

beforeEach(() => seed());

const ACCOUNTS = [
  {
    accountId: 'acc-1',
    name: 'Acme',
    phase: 'customer',
    region: 'west coast',
    rate: 10,
    profile: { label: 'gold', since: '2026-01-02' },
    ownerId: 'user_ann',
    readers: [],
    tags: ['t1'],
    notes: ['call', 'visit'],
    score: 7,
    cost: '12.50',
    startDate: '2026-01-05',
    seenAt: '2026-02-01T10:00:00Z',
    active: true,
  },
  {
    accountId: 'acc-2',
    name: 'Globex',
    phase: 'prospect',
    region: 'east coast',
    rate: 20,
    profile: { label: 'silver' },
    ownerId: 'user_ben',
    readers: ['user_ann'],
    tags: [],
    notes: ['visit'],
    score: 3,
    cost: '8.25',
    startDate: '2026-03-01',
    seenAt: '2026-02-02T11:30:00Z',
    active: false,
  },
  {
    accountId: 'acc-3',
    name: 'Initech',
    phase: 'customer',
    region: 'north',
    rate: 30,
    profile: { label: 'gold' },
    ownerId: 'user_carl',
    readers: ['user_dan'],
    tags: ['t3'],
    notes: [],
    score: 9,
    cost: '100.00',
    startDate: '2025-12-31',
    seenAt: '2026-01-15T08:00:00Z',
    active: true,
  },
  {
    accountId: 'acc-4',
    name: 'Hooli',
    phase: 'prospect',
    region: 'west coast',
    rate: 40,
    profile: { label: 'bronze' },
    ownerId: null,
    readers: ['member'],
    tags: [],
    notes: ['call'],
    score: 1,
    cost: '0.99',
    startDate: '2026-06-30',
    seenAt: '2026-03-03T03:03:03Z',
    active: false,
  },
  {
    accountId: 'acc-5',
    name: 'Stark',
    phase: 'customer',
    region: 'south',
    rate: 50,
    profile: { label: 'gold' },
    ownerId: '',
    readers: [null],
    tags: [],
    notes: ['email', 'call'],
    score: 5,
    cost: '45.00',
    startDate: '2026-02-14',
    seenAt: '2026-04-04T04:04:04Z',
    active: true,
  },
];

const ENGAGEMENTS = [
  { engagementId: 'eng-1', accountId: 'acc-1', title: 'First', amount: 100, status: 'open' },
  { engagementId: 'eng-2', accountId: 'acc-2', title: 'Second', amount: 200, status: 'open' },
  { engagementId: 'eng-3', accountId: 'acc-3', title: 'Third', amount: 300, status: 'won' },
];

async function seed(nulled?: Person): Promise<void> {
  await service.clear();

  const hidden = (account: (typeof ACCOUNTS)[number]) => [
    ...(nulled === undefined || SEES_PAY[nulled].includes(account.accountId) ? [] : PAY),
    ...(nulled === undefined || SEES_OPS.includes(nulled) ? [] : OPS),
  ];

  const accounts = ACCOUNTS.map((account) => ({
    ...account,
    ...Object.fromEntries(hidden(account).map((name) => [name, null])),
  }));

  await insertObjects(service.db, ACCOUNT, accounts);

  const engagements = ENGAGEMENTS.map((engagement) =>
    nulled === undefined || nulled === 'admin' || nulled === 'guest' || nulled === 'auditor'
      ? engagement
      : { ...engagement, accountId: null, amount: null },
  );

  await insertObjects(service.db, ENGAGEMENT, engagements);
}

const base = (objectType: string) => ({ type: 'base', objectType });
const accounts = base(ACCOUNT);
const engagements = base(ENGAGEMENT);
const filter = (objectSet: object, where: object) => ({ type: 'filter', objectSet, where });
const eq = (field: string, value: unknown) => ({ type: 'eq', field, value });
const around = (objectSet: object, link: string) => ({ type: 'searchAround', objectSet, link });
const byKey = { orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] } };

function post(path: string, body: unknown, person: Person): Promise<RawAnswer> {
  return service.call('POST', `${ONTOLOGY}/${path}`, body, PEOPLE[person]);
}

function get(path: string, person: Person): Promise<RawAnswer> {
  return service.call('GET', `${ONTOLOGY}/${path}`, undefined, PEOPLE[person]);
}

type Row = Record<string, unknown>;

async function load(
  body: object,
  person: Person,
): Promise<{ data: Row[]; totalCount: string; nextPageToken?: string; propertySecurities: unknown }> {
  const answer = await post('objectSets/loadObjects', { excludeRid: true, ...body }, person);

  expect(answer.status).toBe(200);

  return JSON.parse(answer.text) as {
    data: Row[];
    totalCount: string;
    nextPageToken?: string;
    propertySecurities: unknown;
  };
}

async function keys(objectSet: object, person: Person, primaryKey = 'accountId'): Promise<unknown[]> {
  const page = await load(
    { objectSet, select: [primaryKey], orderBy: { fields: [{ field: primaryKey, direction: 'asc' }] } },
    person,
  );

  return page.data.map((object) => object[primaryKey]);
}

async function aggregate(body: object, person: Person, objectSet: object = accounts): Promise<unknown> {
  const answer = await post('objectSets/aggregate', { objectSet, ...body }, person);

  expect(answer.status).toBe(200);

  return JSON.parse(answer.text);
}

describe('ontology/object-security-policies#hidden-property-values: a hidden Property value is null for the person, and the Object stays', () => {
  it('ontology/object-security-policies#hidden-property-values ontology/ontology-sdk/object-sets#security: ann reads the pay values of acc-1 and acc-2 only, and each Object leaves out each hidden Property', async () => {
    const page = await load({ objectSet: accounts, ...byKey }, 'ann');

    expect(page.data).toEqual([
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-1',
        __title: 'Acme',
        accountId: 'acc-1',
        name: 'Acme',
        phase: 'customer',
        region: 'west coast',
        rate: 10,
        profile: { label: 'gold', since: '2026-01-02' },
        ownerId: 'user_ann',
        readers: [],
        tags: ['t1'],
      },
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-2',
        __title: 'Globex',
        accountId: 'acc-2',
        name: 'Globex',
        phase: 'prospect',
        region: 'east coast',
        rate: 20,
        profile: { label: 'silver' },
        ownerId: 'user_ben',
        readers: ['user_ann'],
        tags: [],
      },
      {
        __apiName: ACCOUNT,
        __primaryKey: 'acc-3',
        accountId: 'acc-3',
        ownerId: 'user_carl',
        readers: ['user_dan'],
        tags: ['t3'],
      },
      { __apiName: ACCOUNT, __primaryKey: 'acc-4', accountId: 'acc-4', readers: ['member'], tags: [] },
      { __apiName: ACCOUNT, __primaryKey: 'acc-5', accountId: 'acc-5', ownerId: '', readers: [null], tags: [] },
    ]);
  });

  it('ontology/object-security-policies#hidden-property-values: the count of Objects is the same for each person', async () => {
    const counts = await Promise.all(
      (['ann', 'ben', 'admin', 'guest'] as const).map(
        async (person) => (await load({ objectSet: accounts, select: ['accountId'] }, person)).totalCount,
      ),
    );

    expect(counts).toEqual(['5', '5', '5', '5']);
  });

  it('ontology/object-link-types/properties#security: an Object has no __title when the person cannot see the title Property', async () => {
    const page = await load({ objectSet: accounts, select: ['name'], ...byKey }, 'ben');

    expect(page.data).toEqual([
      { __apiName: ACCOUNT, __primaryKey: 'acc-1', accountId: 'acc-1' },
      { __apiName: ACCOUNT, __primaryKey: 'acc-2', __title: 'Globex', accountId: 'acc-2', name: 'Globex' },
      { __apiName: ACCOUNT, __primaryKey: 'acc-3', accountId: 'acc-3' },
      { __apiName: ACCOUNT, __primaryKey: 'acc-4', accountId: 'acc-4' },
      { __apiName: ACCOUNT, __primaryKey: 'acc-5', accountId: 'acc-5' },
    ]);
  });

  it('ontology/object-link-types/properties#security: a hidden struct Property is absent, not {}', async () => {
    const page = await load(
      {
        objectSet: filter(accounts, { type: 'in', field: 'accountId', value: ['acc-2', 'acc-3'] }),
        select: ['profile'],
        ...byKey,
      },
      'ben',
    );

    expect(page.data.map((object) => object['profile'] ?? 'absent')).toEqual([{ label: 'silver' }, 'absent']);
    expect(Object.keys(page.data[1] ?? {})).toEqual(['__apiName', '__primaryKey', 'accountId']);
  });

  it('ontology/ontology-sdk/object-sets#security: a loadObjects response keeps propertySecurities: [] when a value is hidden', async () => {
    expect((await load({ objectSet: accounts, select: ['rate'] }, 'guest')).propertySecurities).toEqual([]);
  });

  it('ontology/object-security-policies#empty-values: an empty ownerId fails only its own comparison: acc-4 stays visible, and admin still sees its pay values', async () => {
    const one = filter(accounts, eq('accountId', 'acc-4'));

    expect((await load({ objectSet: one, select: ['rate', 'phase'] }, 'admin')).data).toEqual([
      { __apiName: ACCOUNT, __primaryKey: 'acc-4', accountId: 'acc-4', rate: 40, phase: 'prospect' },
    ]);

    expect((await load({ objectSet: one, select: ['rate', 'phase'] }, 'ann')).data).toEqual([
      { __apiName: ACCOUNT, __primaryKey: 'acc-4', accountId: 'acc-4' },
    ]);
  });
});

describe('a where clause, a text search, and an orderBy read a hidden value as null', () => {
  it('ontology/ontology-sdk/object-sets#security: eq, gt, startsWith, and in match no hidden value, and isNull matches each one', async () => {
    expect(await keys(filter(accounts, eq('phase', 'customer')), 'ann')).toEqual(['acc-1']);

    expect(await keys(filter(accounts, eq('phase', 'customer')), 'admin')).toEqual(['acc-1', 'acc-3', 'acc-5']);

    expect(await keys(filter(accounts, { type: 'gt', field: 'rate', value: 5 }), 'ben')).toEqual(['acc-2']);

    expect(await keys(filter(accounts, { type: 'startsWith', field: 'region', value: 'west' }), 'ann')).toEqual([
      'acc-1',
    ]);

    expect(await keys(filter(accounts, { type: 'in', field: 'name', value: ['Initech', 'Acme'] }), 'ann')).toEqual([
      'acc-1',
    ]);

    expect(await keys(filter(accounts, { type: 'isNull', field: 'rate', value: true }), 'ann')).toEqual([
      'acc-3',
      'acc-4',
      'acc-5',
    ]);

    expect(await keys(filter(accounts, { type: 'isNull', field: 'rate', value: true }), 'admin')).toEqual([]);

    expect(
      await keys(filter(accounts, { type: 'not', value: { type: 'isNull', field: 'phase', value: true } }), 'ben'),
    ).toEqual(['acc-2']);
  });

  it('ontology/ontology-sdk/object-sets#security: a text search does not match a hidden value', async () => {
    const search = (type: string) => filter(accounts, { type, field: 'region', value: 'coast' });

    expect(await keys(search('containsAllTerms'), 'ben')).toEqual(['acc-2']);

    expect(await keys(search('containsAnyTerm'), 'ann')).toEqual(['acc-1', 'acc-2']);

    expect(await keys(search('containsAllTerms'), 'admin')).toEqual(['acc-1', 'acc-2', 'acc-4']);
  });

  it('ontology/ontology-sdk/object-sets#security: an orderBy sorts a hidden value as null, and the page token holds null for it', async () => {
    const body = {
      objectSet: accounts,
      select: ['accountId'],
      orderBy: {
        fields: [
          { field: 'rate', direction: 'desc' },
          { field: 'accountId', direction: 'asc' },
        ],
      },
      pageSize: 3,
    };

    const first = await load(body, 'ann');

    expect(first.data.map((object) => object['accountId'])).toEqual(['acc-2', 'acc-1', 'acc-3']);

    const token = JSON.parse(Buffer.from(first.nextPageToken ?? '', 'base64url').toString('utf8')) as {
      values: unknown[];
    };

    expect(token.values).toEqual([null, 'acc-3', 'acc-3']);

    const second = await load({ ...body, pageToken: first.nextPageToken }, 'ann');

    expect(second.data.map((object) => object['accountId'])).toEqual(['acc-4', 'acc-5']);
  });
});

describe('an aggregation reads a hidden value as null', () => {
  it('ontology/ontology-sdk/aggregations#security: a metric skips each hidden value', async () => {
    const metrics = {
      groupBy: [],
      aggregation: [
        { type: 'sum', name: 'sum', field: 'rate' },
        { type: 'min', name: 'min', field: 'rate' },
        { type: 'max', name: 'max', field: 'rate' },
        { type: 'avg', name: 'avg', field: 'rate' },
        { type: 'count', name: 'count' },
      ],
    };

    const values = (answer: unknown) =>
      (answer as { data: { metrics: { name: string; value: unknown }[] }[] }).data[0]?.metrics.map(
        ({ name, value }) => [name, value],
      );

    expect(values(await aggregate(metrics, 'ann'))).toEqual([
      ['sum', 30],
      ['min', 10],
      ['max', 20],
      ['avg', 15],
      ['count', 5],
    ]);

    expect(values(await aggregate(metrics, 'admin'))).toEqual([
      ['sum', 150],
      ['min', 10],
      ['max', 50],
      ['avg', 30],
      ['count', 5],
    ]);
  });

  it('ontology/ontology-sdk/aggregations#security: a group-by puts each hidden value in the null group', async () => {
    const groups = async (person: Person) => {
      const answer = (await aggregate(
        {
          groupBy: [{ type: 'exact', field: 'phase', includeNullValues: true }],
          aggregation: [{ type: 'count', name: 'count' }],
        },
        person,
      )) as { data: { group: Record<string, unknown>; metrics: { value: unknown }[] }[] };

      return Object.fromEntries(answer.data.map((entry) => [String(entry.group['phase']), entry.metrics[0]?.value]));
    };

    expect(await groups('ann')).toEqual({ customer: 1, prospect: 1, null: 3 });

    expect(await groups('admin')).toEqual({ customer: 3, prospect: 2 });
  });
});

describe('ontology/object-link-types/link-types#security: a Search Around through a hidden foreign key finds no linked Object', () => {
  it('ontology/object-link-types/link-types#security: a member, who cannot see accountId, reaches no Account and no Engagement; admin reaches each', async () => {
    expect(await keys(around(engagements, 'account'), 'ann')).toEqual([]);

    expect(await keys(around(accounts, 'engagements'), 'ann', 'engagementId')).toEqual([]);

    expect(await keys(around(engagements, 'account'), 'admin')).toEqual(['acc-1', 'acc-2', 'acc-3']);

    expect(await keys(around(accounts, 'engagements'), 'admin', 'engagementId')).toEqual(['eng-1', 'eng-2', 'eng-3']);
  });

  it('ontology/object-security-policies#policies: to view amount, the person passes the object security policy and the property security policy', async () => {
    const amounts = async (person: Person) =>
      (
        await load(
          {
            objectSet: engagements,
            select: ['amount'],
            orderBy: { fields: [{ field: 'engagementId', direction: 'asc' }] },
          },
          person,
        )
      ).data.map((object) => [object['__primaryKey'], object['amount'] ?? 'hidden']);

    expect(await amounts('admin')).toEqual([
      ['eng-1', 100],
      ['eng-2', 200],
      ['eng-3', 300],
    ]);

    expect(await amounts('ann')).toEqual([
      ['eng-1', 'hidden'],
      ['eng-2', 'hidden'],
      ['eng-3', 'hidden'],
    ]);

    expect(await amounts('guest')).toEqual([]);
  });
});

describe('2 property security policies on 1 Object Type: each Property follows the policy of its own group', () => {
  const sub = filter(accounts, { type: 'in', field: 'accountId', value: ['acc-1', 'acc-2'] });

  const values = async (person: Person) =>
    (await load({ objectSet: sub, select: ['phase', 'score'], ...byKey }, person)).data.map((object) => [
      object['__primaryKey'],
      object['phase'] ?? '-',
      object['score'] ?? '-',
    ]);

  const people = ['ann', 'auditor', 'admin', 'guest'] as const;

  const of = async <T>(read: (person: Person) => Promise<T>) =>
    Object.fromEntries(await Promise.all(people.map(async (person) => [person, await read(person)] as const)));

  it('ontology/object-security-policies#hidden-property-values ontology/object-security-policies#policies: in a load, ann sees only pay, auditor only ops, admin both, and guest neither', async () => {
    expect(await of(values)).toEqual({
      ann: [
        ['acc-1', 'customer', '-'],
        ['acc-2', 'prospect', '-'],
      ],
      auditor: [
        ['acc-1', '-', 7],
        ['acc-2', '-', 3],
      ],
      admin: [
        ['acc-1', 'customer', 7],
        ['acc-2', 'prospect', 3],
      ],
      guest: [
        ['acc-1', '-', '-'],
        ['acc-2', '-', '-'],
      ],
    });
  });

  it('ontology/ontology-sdk/object-sets#security: a filter on each policy matches only for the people who pass that policy', async () => {
    expect(await of((person) => keys(filter(accounts, eq('score', 7)), person))).toEqual({
      ann: [],
      auditor: ['acc-1'],
      admin: ['acc-1'],
      guest: [],
    });

    expect(await of((person) => keys(filter(accounts, eq('phase', 'customer')), person))).toEqual({
      ann: ['acc-1'],
      auditor: [],
      admin: ['acc-1', 'acc-3', 'acc-5'],
      guest: [],
    });
  });

  it('ontology/ontology-sdk/object-sets#security: a sort on score orders by score only for the people who pass ops', async () => {
    const order = async (person: Person) =>
      (
        await load(
          {
            objectSet: accounts,
            select: ['accountId'],
            orderBy: {
              fields: [
                { field: 'score', direction: 'asc' },
                { field: 'accountId', direction: 'asc' },
              ],
            },
          },
          person,
        )
      ).data.map((object) => object['accountId']);

    expect(await of(order)).toEqual({
      ann: ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5'],
      auditor: ['acc-4', 'acc-2', 'acc-5', 'acc-1', 'acc-3'],
      admin: ['acc-4', 'acc-2', 'acc-5', 'acc-1', 'acc-3'],
      guest: ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5'],
    });
  });

  it('ontology/ontology-sdk/aggregations#security: an aggregate of each policy counts only the values that the person passes', async () => {
    const sums = async (person: Person) => {
      const answer = (await aggregate(
        {
          groupBy: [],
          aggregation: [
            { type: 'sum', name: 'score', field: 'score' },
            { type: 'sum', name: 'rate', field: 'rate' },
          ],
        },
        person,
      )) as { data: { metrics: { name: string; value?: unknown }[] }[] };

      return answer.data[0]?.metrics.map(({ name, value }) => [name, value ?? '-']);
    };

    expect(await of(sums)).toEqual({
      ann: [
        ['score', '-'],
        ['rate', 30],
      ],
      auditor: [
        ['score', 25],
        ['rate', '-'],
      ],
      admin: [
        ['score', 25],
        ['rate', 150],
      ],
      guest: [
        ['score', '-'],
        ['rate', '-'],
      ],
    });
  });
});

describe('a hidden String array Property', () => {
  it('ontology/object-security-policies#hidden-property-values ontology/ontology-sdk/object-sets#security: a load, contains, and isNull read a hidden array as null', async () => {
    const notes = async (person: Person) =>
      (await load({ objectSet: accounts, select: ['notes'], ...byKey }, person)).data.map(
        (object) => object['notes'] ?? '-',
      );

    expect(await notes('auditor')).toEqual([['call', 'visit'], ['visit'], [], ['call'], ['email', 'call']]);

    expect(await notes('ann')).toEqual(['-', '-', '-', '-', '-']);

    expect(await keys(filter(accounts, { type: 'contains', field: 'notes', value: 'call' }), 'auditor')).toEqual([
      'acc-1',
      'acc-4',
      'acc-5',
    ]);

    expect(await keys(filter(accounts, { type: 'contains', field: 'notes', value: 'call' }), 'ann')).toEqual([]);

    expect(await keys(filter(accounts, { type: 'isNull', field: 'notes', value: true }), 'ann')).toEqual([
      'acc-1',
      'acc-2',
      'acc-3',
      'acc-4',
      'acc-5',
    ]);
  });

  it('a group-by on an array Property is a feature outside V1, so each person gets the same refusal', async () => {
    const refusal = async (person: Person) => {
      const answer = await post(
        'objectSets/aggregate',
        { objectSet: accounts, groupBy: [{ type: 'exact', field: 'notes' }], aggregation: count },
        person,
      );

      const body = JSON.parse(answer.text) as { errorName: string; parameters: unknown };

      return [answer.status, body.errorName, body.parameters];
    };

    const auditor = await refusal('auditor');

    expect(auditor[0]).toBe(400);

    expect(await refusal('ann')).toEqual(auditor);
  });
});

describe('ontology/object-link-types/properties#security: a hidden Property keeps its Ontology metadata', () => {
  it('ontology/object-link-types/properties#security: name keeps NOT_NULLABLE, and the metadata bytes are the same for each person', async () => {
    const metadata = JSON.parse((await get(`objectTypes/${ACCOUNT}`, 'guest')).text) as {
      properties: Record<string, { dataConstraints?: unknown }>;
    };

    expect(metadata.properties['name']?.dataConstraints).toEqual({ nullability: 'NOT_NULLABLE' });

    expect(Object.keys(metadata.properties).sort()).toEqual([
      'accountId',
      'active',
      'cost',
      'name',
      'notes',
      'ownerId',
      'phase',
      'profile',
      'rate',
      'readers',
      'region',
      'score',
      'seenAt',
      'startDate',
      'tags',
    ]);

    const texts = await Promise.all(
      (['ann', 'admin', 'guest'] as const).map(
        async (person) => (await get(`objectTypes/${ACCOUNT}/fullMetadata`, person)).text,
      ),
    );

    expect(new Set(texts).size).toBe(1);
  });
});

describe('the Ontology MCP and the client of a Function read a hidden value as null', () => {
  it('load_objects of the Ontology MCP gives ann the rates of acc-1 and acc-2 only', async () => {
    const answer = await service.tool(
      'load_objects',
      { objectSet: accounts, select: ['rate'], orderBy: { fields: [{ field: 'accountId' }] } },
      PEOPLE.ann,
    );

    const result = (answer.body as { result: { structuredContent: { data: Row[] } } }).result.structuredContent;

    expect(result.data.map((object) => [object['accountId'], object['rate'] ?? 'hidden'])).toEqual([
      ['acc-1', 10],
      ['acc-2', 20],
      ['acc-3', 'hidden'],
      ['acc-4', 'hidden'],
      ['acc-5', 'hidden'],
    ]);
  });

  it('ontology/functions/functions#reads: the client of a Function reads a hidden value as null, as the person who applies its Action does', async () => {
    const seen = async (person: Person) => {
      const applied = await service.apply(
        actionOf('readRates'),
        { parameters: { note: person }, options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' } },
        PEOPLE[person],
      );

      expect(applied.status).toBe(200);

      const rows = await service.db.query<{ title: string }>(
        sql("SELECT title FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-1'"),
      );

      return (JSON.parse(rows[0]?.title ?? '{}') as { seen: unknown }).seen;
    };

    expect(await seen('ben')).toEqual([
      ['acc-1', null, null],
      ['acc-2', 20, 'prospect'],
      ['acc-3', null, null],
      ['acc-4', null, null],
      ['acc-5', null, null],
    ]);

    expect(await seen('admin')).toEqual([
      ['acc-1', 10, 'customer'],
      ['acc-2', 20, 'prospect'],
      ['acc-3', 30, 'customer'],
      ['acc-4', 40, 'prospect'],
      ['acc-5', 50, 'customer'],
    ]);
  });
});

type Call = (person: Person) => Promise<RawAnswer>;

const read =
  (body: object): Call =>
  (person) =>
    post('objectSets/loadObjects', { excludeRid: true, ...body }, person);

const sum =
  (objectSet: object, body: object): Call =>
  (person) =>
    post('objectSets/aggregate', { objectSet, ...body }, person);

const count = [{ type: 'count', name: 'count' }];

const rateOrder = {
  orderBy: {
    fields: [
      { field: 'rate', direction: 'asc' },
      { field: 'accountId', direction: 'asc' },
    ],
  },
};

const ORACLE: Readonly<Record<string, Call>> = {
  'load each Property': read({ objectSet: accounts, ...byKey }),
  'load with select': read({ objectSet: accounts, select: ['name', 'rate', 'profile'], ...byKey }),
  'eq on a hidden value': read({ objectSet: filter(accounts, eq('phase', 'customer')), ...byKey }),
  'gt on a hidden value': read({ objectSet: filter(accounts, { type: 'gt', field: 'rate', value: 25 }), ...byKey }),
  'lte on a hidden value': read({ objectSet: filter(accounts, { type: 'lte', field: 'rate', value: 25 }), ...byKey }),
  'startsWith on a hidden value': read({
    objectSet: filter(accounts, { type: 'startsWith', field: 'region', value: 'n' }),
    ...byKey,
  }),
  'isNull on a hidden value': read({
    objectSet: filter(accounts, { type: 'isNull', field: 'rate', value: true }),
    ...byKey,
  }),
  'a struct field': read({
    objectSet: filter(accounts, {
      type: 'eq',
      propertyIdentifier: { type: 'structField', propertyApiName: 'profile', structFieldApiName: 'label' },
      value: 'gold',
    }),
    ...byKey,
  }),
  'a text search': read({
    objectSet: filter(accounts, { type: 'containsAnyTerm', field: 'region', value: 'north coast' }),
    ...byKey,
  }),
  'an orderBy and its page token': read({ objectSet: accounts, select: ['accountId'], ...rateOrder, pageSize: 2 }),
  'an orderBy desc': read({
    objectSet: accounts,
    select: ['accountId'],
    orderBy: { fields: [{ field: 'name', direction: 'desc' }] },
  }),
  'a union': read({
    objectSet: {
      type: 'union',
      objectSets: [
        filter(accounts, eq('phase', 'prospect')),
        filter(accounts, { type: 'gt', field: 'rate', value: 25 }),
      ],
    },
    ...byKey,
  }),
  'an intersect': read({
    objectSet: { type: 'intersect', objectSets: [accounts, filter(accounts, eq('region', 'north'))] },
    ...byKey,
  }),
  'a subtract': read({
    objectSet: { type: 'subtract', objectSets: [accounts, filter(accounts, eq('phase', 'customer'))] },
    ...byKey,
  }),
  'a Search Around by a hidden foreign key': read({ objectSet: around(engagements, 'account'), ...byKey }),
  'a Search Around to a hidden foreign key': read({
    objectSet: around(accounts, 'engagements'),
    orderBy: { fields: [{ field: 'engagementId', direction: 'asc' }] },
  }),
  'a Search Around from a filter on a hidden value': read({
    objectSet: around(filter(engagements, { type: 'gt', field: 'amount', value: 150 }), 'account'),
    ...byKey,
  }),
  'the metrics': sum(accounts, {
    groupBy: [],
    aggregation: [
      ...count,
      { type: 'sum', name: 's', field: 'rate' },
      { type: 'min', name: 'mi', field: 'rate' },
      { type: 'max', name: 'ma', field: 'rate' },
      { type: 'avg', name: 'a', field: 'rate' },
      { type: 'exactDistinct', name: 'd', field: 'phase' },
      { type: 'approximateDistinct', name: 'ad', field: 'region' },
    ],
  }),
  'a group-by exact': sum(accounts, {
    groupBy: [{ type: 'exact', field: 'phase', includeNullValues: true }],
    aggregation: count,
  }),
  'a group-by of ranges': sum(accounts, {
    groupBy: [
      {
        type: 'ranges',
        field: 'rate',
        ranges: [
          { startValue: 0, endValue: 25 },
          { startValue: 25, endValue: 100 },
        ],
      },
    ],
    aggregation: count,
  }),
  'a group-by of a fixed width': sum(accounts, {
    groupBy: [{ type: 'fixedWidth', field: 'rate', fixedWidth: 20 }],
    aggregation: count,
  }),
  'an aggregate of a hidden foreign key': sum(engagements, {
    groupBy: [{ type: 'exact', field: 'accountId', includeNullValues: true }],
    aggregation: [...count, { type: 'sum', name: 's', field: 'amount' }],
  }),
  'the MCP load_objects': (person) =>
    service
      .tool(
        'load_objects',
        {
          objectSet: filter(accounts, { type: 'gt', field: 'rate', value: 15 }),
          orderBy: { fields: [{ field: 'rate' }] },
        },
        PEOPLE[person],
      )
      .then(asRaw),
  'contains on a hidden array': read({
    objectSet: filter(accounts, { type: 'contains', field: 'notes', value: 'call' }),
    ...byKey,
  }),
  'isNull on a hidden array': read({
    objectSet: filter(accounts, { type: 'isNull', field: 'notes', value: true }),
    ...byKey,
  }),
  'select of a hidden array': read({ objectSet: accounts, select: ['notes'], ...byKey }),
  'gt on a hidden integer': read({ objectSet: filter(accounts, { type: 'gt', field: 'score', value: 4 }), ...byKey }),
  'gte on a hidden decimal': read({
    objectSet: filter(accounts, { type: 'gte', field: 'cost', value: '10' }),
    ...byKey,
  }),
  'lt on a hidden date': read({
    objectSet: filter(accounts, { type: 'lt', field: 'startDate', value: '2026-02-01' }),
    ...byKey,
  }),
  'gt on a hidden timestamp': read({
    objectSet: filter(accounts, { type: 'gt', field: 'seenAt', value: '2026-02-01T12:00:00Z' }),
    ...byKey,
  }),
  'eq on a hidden boolean': read({ objectSet: filter(accounts, eq('active', true)), ...byKey }),
  'an orderBy on each hidden type': read({
    objectSet: accounts,
    select: ['accountId'],
    orderBy: {
      fields: ['score', 'cost', 'startDate', 'seenAt', 'active'].map((field) => ({ field, direction: 'desc' })),
    },
    pageSize: 2,
  }),
  'the metrics of the ops group': sum(accounts, {
    groupBy: [],
    aggregation: [
      { type: 'sum', name: 's', field: 'score' },
      { type: 'max', name: 'c', field: 'cost' },
      { type: 'min', name: 'd', field: 'startDate' },
      { type: 'max', name: 't', field: 'seenAt' },
    ],
  }),
  'a group-by of a hidden boolean': sum(accounts, {
    groupBy: [{ type: 'exact', field: 'active', includeNullValues: true }],
    aggregation: count,
  }),
  'a group-by of a hidden integer': sum(accounts, {
    groupBy: [{ type: 'fixedWidth', field: 'score', fixedWidth: 5 }],
    aggregation: count,
  }),
  'the MCP aggregate_objects': (person) =>
    service
      .tool(
        'aggregate_objects',
        {
          objectSet: accounts,
          groupBy: [{ type: 'exact', field: 'region' }],
          aggregation: [{ type: 'sum', name: 's', field: 'rate' }],
        },
        PEOPLE[person],
      )
      .then(asRaw),
};

function asRaw(answer: { status: number; body: unknown }): RawAnswer {
  return {
    status: answer.status,
    contentType: 'application/json',
    text: JSON.stringify((answer.body as { result: unknown }).result),
  };
}

function withoutExpiry(answer: RawAnswer): string {
  const text = answer.text.replace(/"nextPageToken":"([^"]*)"/, (_match, token: string) => {
    const fields = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      values: unknown;
      checksum: unknown;
    };

    return `"nextPageToken":${JSON.stringify({ values: fields.values, checksum: fields.checksum })}`;
  });

  return `${answer.status} ${text}`;
}

describe('the oracle: a filter, a sort, or a metric on a hidden value does not let the person detect it', () => {
  it.each(['ann', 'ben', 'guest', 'auditor'] as const)(
    '%s gets the same bytes on each read path when each value that the person cannot see is NULL',
    async (person) => {
      const present: Record<string, string> = {};

      for (const [name, call] of Object.entries(ORACLE)) present[name] = withoutExpiry(await call(person));

      await seed(person);

      const nulled: Record<string, string> = {};

      for (const [name, call] of Object.entries(ORACLE)) nulled[name] = withoutExpiry(await call(person));

      expect(nulled).toEqual(present);
      expect(Object.values(present).every((text) => text.startsWith('200 '))).toBe(true);
    },
  );

  it('admin sees each value, so the NULL data of ann gives other bytes on most read paths', async () => {
    const present: Record<string, string> = {};

    for (const [name, call] of Object.entries(ORACLE)) present[name] = withoutExpiry(await call('admin'));

    await seed('ann');

    const changed: string[] = [];

    for (const [name, call] of Object.entries(ORACLE))
      if (withoutExpiry(await call('admin')) !== present[name]) changed.push(name);

    expect(changed.length).toBeGreaterThan(Object.keys(ORACLE).length / 2);
  });
});
