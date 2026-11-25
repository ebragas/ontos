import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OntologyRouteKey } from '../handler/context.ts';
import { TOOLS } from './tools.ts';
import { insertObjects, NS, startActions, type ActionsService, type RawAnswer } from '../actions/actions.test-utils.ts';
import { policiesIr, USE } from '../ontology/stored.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { asPerson, groupGrants, policyPeople } from '../policiesPeople.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ONTOLOGY = `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}`;

const ROLES = { admin: ['ontology:install', USE, 'admin'], member: [USE, 'member'], guest: [USE] };

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    ben: { sub: 'user_ben', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
    nobody: { sub: 'user_nobody', role: 'guest' },
  },
  ROLES,
);

type Person = keyof typeof PEOPLE;

const FUNCTIONS: TestFunction[] = [
  { apiName: 'readAccounts', inputs: [{ name: 'note', type: 'string' }], edits: [ENGAGEMENT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

export const functions = {
  readAccounts: async (client, note) => {
    const batch = createEditBatch(client);
    const page = await client(Account).fetchPage({ $orderBy: { accountId: 'asc' } });
    batch.update({ $apiName: '${ENGAGEMENT}', $primaryKey: 'eng-2' }, { title: JSON.stringify({ note, accounts: page.data.map((account) => account.$primaryKey) }) });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, policiesIr());

  service = await startActions(ir, functions, groupGrants(ir, ROLES));
});

afterAll(() => service?.stop());

beforeEach(seed);

async function seed(): Promise<void> {
  await service.clear();

  const account = (
    accountId: string,
    name: string,
    phase: string,
    ownerId: string | null,
    viewers: (string | null)[],
  ) => ({ accountId, name, phase, ownerId, viewers });

  await insertObjects(service.db, ACCOUNT, [
    account('acc-1', 'Acme', 'customer', 'user_ann', ['user_dan']),
    account('acc-2', 'Globex', 'prospect', 'user_ben', ['user_ann']),
    account('acc-3', 'Initech', 'customer', 'user_carl', ['reviewer']),
    account('acc-4', 'Hooli', 'customer', null, ['member']),
    account('acc-5', 'Umbrella', 'prospect', 'user_ben', []),
    account('acc-6', 'Vandelay', 'prospect', 'user_ben', [null]),
    account('acc-7', 'Stark', 'customer', '', ['member']),
  ]);

  const keys = ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5', 'acc-6', 'acc-7'];

  await service.db.query(
    sql(
      "INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry) SELECT $1, key, jsonb_build_object('operationId', 'op-' || key, 'userId', 'user_admin', 'edit', jsonb_build_object('type', 'createEdit')) FROM unnest($2::text[]) AS key",
      ACCOUNT,
      keys,
    ),
  );

  const engagement = (engagementId: string, accountId: string) => ({
    engagementId,
    accountId,
    title: engagementId,
    amount: 1000,
    status: 'open',
    createdAt: null,
  });

  await insertObjects(service.db, ENGAGEMENT, [
    engagement('eng-1', 'acc-1'),
    engagement('eng-2', 'acc-1'),
    engagement('eng-3', 'acc-2'),
    engagement('eng-4', 'acc-3'),
    engagement('eng-5', 'acc-4'),
    engagement('eng-6', 'acc-7'),
  ]);

  for (const [engagementId, accountId] of [
    ['eng-1', 'acc-2'],
    ['eng-1', 'acc-3'],
    ['eng-3', 'acc-1'],
    ['eng-3', 'acc-7'],
    ['eng-5', 'acc-5'],
  ]) {
    await service.db.query(
      sql(
        'INSERT INTO ontology_1_objects.engagement_partners (a_engagement_id, b_account_id) VALUES ($1, $2)',
        engagementId,
        accountId,
      ),
    );
  }
}

async function noAccounts(): Promise<void> {
  await service.db.query(sql('DELETE FROM ontology_1_objects.engagement_partners'));

  await service.db.query(sql('DELETE FROM ontology_1_objects.account'));
}

const base = (objectType: string) => ({ type: 'base', objectType });
const accounts = base(ACCOUNT);
const engagements = base(ENGAGEMENT);

const where = (objectSet: object, field: string, value: string) => ({
  type: 'filter',
  objectSet,
  where: { type: 'eq', field, value },
});

const around = (objectSet: object, link: string) => ({ type: 'searchAround', objectSet, link });
const byKey = (field: string) => ({ orderBy: { fields: [{ field, direction: 'asc' }] }, excludeRid: true });

function post(path: string, body: unknown, person: Person): Promise<RawAnswer> {
  return service.call('POST', `${ONTOLOGY}/${path}`, body, PEOPLE[person]);
}

function get(path: string, person: Person): Promise<RawAnswer> {
  return service.call('GET', `${ONTOLOGY}/${path}`, undefined, PEOPLE[person]);
}

async function keysOf(
  objectSet: object,
  person: Person,
  primaryKey = 'accountId',
): Promise<{ status: number; keys: unknown; totalCount: unknown }> {
  const answer = await post(
    'objectSets/loadObjects',
    { objectSet, select: [primaryKey], ...byKey(primaryKey) },
    person,
  );

  const body = JSON.parse(answer.text) as { data?: Record<string, unknown>[]; totalCount?: unknown };

  return { status: answer.status, keys: body.data?.map((object) => object[primaryKey]), totalCount: body.totalCount };
}

async function each<T>(read: (person: Person) => Promise<T>): Promise<Record<Person, T>> {
  return { ann: await read('ann'), ben: await read('ben'), admin: await read('admin'), nobody: await read('nobody') };
}

const page = (keys: string[]) => ({ status: 200, keys, totalCount: String(keys.length) });

describe('ontology/object-security-policies#hidden-objects: a person sees only the Objects that the policy lets them see', () => {
  it('ontology/object-security-policies#hidden-objects: 2 people of the role member load different Accounts, and an admin loads each Account whose policy Properties have a value', async () => {
    expect(await each((person) => keysOf(accounts, person))).toEqual({
      ann: page(['acc-1', 'acc-2', 'acc-7']),
      ben: page(['acc-2', 'acc-7']),
      admin: page(['acc-1', 'acc-2', 'acc-3', 'acc-7']),
      nobody: page([]),
    });
  });

  it('ontology/object-security-policies#empty-values: an empty ownerId or viewers hides the Object from admin too, and an empty String does not', async () => {
    const hidden = await keysOf(
      {
        type: 'filter',
        objectSet: accounts,
        where: { type: 'in', field: 'accountId', value: ['acc-4', 'acc-5', 'acc-6', 'acc-7'] },
      },
      'admin',
    );

    expect(hidden).toEqual(page(['acc-7']));
  });

  it('a type with no policy shows each Object to each person of its roles', async () => {
    const all = page(['eng-1', 'eng-2', 'eng-3', 'eng-4', 'eng-5', 'eng-6']);

    expect(await each((person) => keysOf(engagements, person, 'engagementId'))).toEqual({
      ann: all,
      ben: all,
      admin: all,
      nobody: all,
    });
  });

  it('ontology/object-security-policies#conditions: user.id is the sub of the token', async () => {
    const read = (sub: string) =>
      service.call(
        'POST',
        `${ONTOLOGY}/objectSets/loadObjects`,
        { objectSet: where(accounts, 'accountId', 'acc-1'), select: ['accountId'] },
        asPerson({ sub, role: 'member' }, ROLES),
      );

    expect(JSON.parse((await read('user_ann')).text)).toMatchObject({ totalCount: '1' });

    expect(JSON.parse((await read('user_ANN')).text)).toMatchObject({ totalCount: '0' });
  });
});

describe('a User ID that holds U+0000', () => {
  it('service/authentication#people: a sub that holds U+0000 is no WorkOS user ID, so it gets 401 Default:Unauthorized, not 500', async () => {
    const body = { objectSet: accounts, select: ['accountId'], ...byKey('accountId') };

    const odd = await service.call(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      body,
      asPerson({ sub: 'user_ann\u0000', role: 'guest' }, ROLES),
    );

    expect([odd.status, JSON.parse(odd.text)]).toMatchObject([
      401,
      { errorCode: 'UNAUTHORIZED', errorName: 'Default:Unauthorized' },
    ]);
  });
});

describe('ontology/ontology-sdk/object-sets#security: an Object Set holds only the Objects that the person can view', () => {
  it.each([
    [
      'union',
      { type: 'union', objectSets: [where(accounts, 'phase', 'customer'), where(accounts, 'phase', 'prospect')] },
      ['acc-1', 'acc-2', 'acc-7'],
      ['acc-2', 'acc-7'],
    ],
    [
      'intersect',
      { type: 'intersect', objectSets: [accounts, where(accounts, 'phase', 'customer')] },
      ['acc-1', 'acc-7'],
      ['acc-7'],
    ],
    [
      'subtract',
      { type: 'subtract', objectSets: [accounts, where(accounts, 'accountId', 'acc-7')] },
      ['acc-1', 'acc-2'],
      ['acc-2'],
    ],
  ])(
    'ontology/ontology-sdk/object-sets#security: a %s holds the Objects of each person',
    async (_operation, objectSet, ann, ben) => {
      expect([
        await keysOf(objectSet, 'ann'),
        await keysOf(objectSet, 'ben'),
        await keysOf(objectSet, 'nobody'),
      ]).toEqual([page(ann), page(ben), page([])]);
    },
  );

  it('ontology/ontology-sdk/object-sets#security: a forged page token walks no hidden Object', async () => {
    const body = { objectSet: accounts, select: ['accountId'], ...byKey('accountId'), pageSize: 1 };

    const first = JSON.parse((await post('objectSets/loadObjects', body, 'ann')).text) as {
      data: { accountId: string }[];
      nextPageToken: string;
      totalCount: string;
    };

    expect([first.data.map((object) => object.accountId), first.totalCount]).toEqual([['acc-1'], '3']);

    const fields = JSON.parse(Buffer.from(first.nextPageToken, 'base64url').toString('utf8')) as { values: unknown[] };

    expect(fields.values).toEqual(['acc-1', 'acc-1']);

    const forged = (after: string) =>
      Buffer.from(JSON.stringify({ ...fields, values: [after, after] }), 'utf8').toString('base64url');

    const walked: string[] = [];
    let token: string | undefined = forged('acc-0');

    while (token !== undefined) {
      const answer = await post('objectSets/loadObjects', { ...body, pageToken: token }, 'ann');

      expect(answer.status, answer.text).toBe(200);

      const next = JSON.parse(answer.text) as { data: { accountId: string }[]; nextPageToken?: string };

      walked.push(...next.data.map((object) => object.accountId));

      token = next.nextPageToken;
    }

    expect(walked).toEqual(['acc-1', 'acc-2', 'acc-7']);

    const afterHidden = JSON.parse(
      (await post('objectSets/loadObjects', { ...body, pageToken: forged('acc-3') }, 'ann')).text,
    ) as { data: { accountId: string }[] };

    expect(afterHidden.data.map((object) => object.accountId)).toEqual(['acc-7']);
  });
});

describe('ontology/ontology-sdk/aggregations#security: an aggregation reads only the Objects that the person can view', () => {
  async function phases(person: Person): Promise<unknown> {
    const answer = await post(
      'objectSets/aggregate',
      {
        objectSet: accounts,
        groupBy: [{ type: 'exact', field: 'phase' }],
        aggregation: [{ type: 'count', name: 'count' }],
      },
      person,
    );

    const { data } = JSON.parse(answer.text) as { data: { group: { phase: string }; metrics: { value: number }[] }[] };

    return data
      .map(({ group, metrics }) => [group.phase, metrics[0]?.value] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }

  it('ontology/ontology-sdk/aggregations#security: the count and the groups of each person hold only their Objects', async () => {
    expect(await each(phases)).toEqual({
      ann: [
        ['customer', 2],
        ['prospect', 1],
      ],
      ben: [
        ['customer', 1],
        ['prospect', 1],
      ],
      admin: [
        ['customer', 3],
        ['prospect', 1],
      ],
      nobody: [],
    });

    const count = async (person: Person) =>
      JSON.parse(
        (
          await post(
            'objectSets/aggregate',
            { objectSet: accounts, groupBy: [], aggregation: [{ type: 'count', name: 'n' }] },
            person,
          )
        ).text,
      ) as unknown;

    expect(await count('ben')).toEqual({
      accuracy: 'ACCURATE',
      data: [{ group: {}, metrics: [{ name: 'n', value: 2 }] }],
    });
  });
});

describe('ontology/object-link-types/link-types#security: a Search Around leaves out each linked Object that the person cannot view', () => {
  it('ontology/object-link-types/link-types#security: by the foreign key on the Engagement, each person reaches only their Accounts', async () => {
    expect(await each((person) => keysOf(around(engagements, 'account'), person))).toEqual({
      ann: page(['acc-1', 'acc-2', 'acc-7']),
      ben: page(['acc-2', 'acc-7']),
      admin: page(['acc-1', 'acc-2', 'acc-3', 'acc-7']),
      nobody: page([]),
    });
  });

  it('ontology/object-link-types/link-types#security: from the Accounts, each person reaches only the Engagements of their Accounts', async () => {
    const reached = await each((person) => keysOf(around(accounts, 'engagements'), person, 'engagementId'));

    expect(reached).toEqual({
      ann: page(['eng-1', 'eng-2', 'eng-3', 'eng-6']),
      ben: page(['eng-3', 'eng-6']),
      admin: page(['eng-1', 'eng-2', 'eng-3', 'eng-4', 'eng-6']),
      nobody: page([]),
    });
  });

  it('ontology/object-link-types/link-types#security: by the join table from a hidden Account, the person reaches nothing', async () => {
    const fromAccount = (accountId: string) => around(where(accounts, 'accountId', accountId), 'partnerEngagements');

    expect(await each((person) => keysOf(fromAccount('acc-3'), person, 'engagementId'))).toEqual({
      ann: page([]),
      ben: page([]),
      admin: page(['eng-1']),
      nobody: page([]),
    });

    expect(await each((person) => keysOf(fromAccount('acc-1'), person, 'engagementId'))).toEqual({
      ann: page(['eng-3']),
      ben: page([]),
      admin: page(['eng-3']),
      nobody: page([]),
    });
  });

  it('ontology/object-link-types/link-types#security: by the join table, each person reaches only their Accounts', async () => {
    const from = (engagementId: string) => around(where(engagements, 'engagementId', engagementId), 'partners');

    expect(await each((person) => keysOf(from('eng-3'), person))).toEqual({
      ann: page(['acc-1', 'acc-7']),
      ben: page(['acc-7']),
      admin: page(['acc-1', 'acc-7']),
      nobody: page([]),
    });

    expect(await each((person) => keysOf(from('eng-1'), person))).toEqual({
      ann: page(['acc-2']),
      ben: page(['acc-2']),
      admin: page(['acc-2', 'acc-3']),
      nobody: page([]),
    });

    expect(await keysOf(from('eng-5'), 'admin')).toEqual(page([]));
  });
});

describe('the Ontology MCP and the client of a Function read as the person', () => {
  async function overMcp(person: Person): Promise<unknown> {
    const answer = await service.tool(
      'load_objects',
      { objectSet: accounts, select: ['accountId'], orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] } },
      PEOPLE[person],
    );

    const { structuredContent } = (answer.body as { result: { structuredContent: { data: { accountId: string }[] } } })
      .result;

    return structuredContent.data.map((object) => object.accountId);
  }

  it('load_objects of the Ontology MCP gives each person their Accounts', async () => {
    expect(await each(overMcp)).toEqual({
      ann: ['acc-1', 'acc-2', 'acc-7'],
      ben: ['acc-2', 'acc-7'],
      admin: ['acc-1', 'acc-2', 'acc-3', 'acc-7'],
      nobody: [],
    });
  });

  async function readByFunction(person: Person): Promise<unknown> {
    const applied = await service.apply(
      actionOf('readAccounts'),
      { parameters: { note: person }, options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' } },
      PEOPLE[person],
    );

    expect(applied.status).toBe(200);

    const rows = await service.db.query<{ title: string }>(
      sql("SELECT title FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2'"),
    );

    return JSON.parse(rows[0]?.title ?? 'null') as unknown;
  }

  it('ontology/functions/functions#reads service/code-layout#seams: the client of a Function reads the Accounts of the person who applies its Action', async () => {
    expect(await each(readByFunction)).toEqual({
      ann: { note: 'ann', accounts: ['acc-1', 'acc-2', 'acc-7'] },
      ben: { note: 'ben', accounts: ['acc-2', 'acc-7'] },
      admin: { note: 'admin', accounts: ['acc-1', 'acc-2', 'acc-3', 'acc-7'] },
      nobody: { note: 'nobody', accounts: [] },
    });
  });
});

describe('an Action and the history of a hidden Object', () => {
  const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

  async function stored(): Promise<unknown> {
    const rows = await service.db.query(
      sql("SELECT account_id, phase, owner_id FROM ontology_1_objects.account WHERE account_id = 'acc-3'"),
    );

    const [history] = await service.db.query<{ n: string }>(
      sql('SELECT count(*)::text AS n FROM ontology_1_engine.edit_history'),
    );

    return { rows, history: history?.n };
  }

  async function applyAsBen(actionType: string, parameters: object): Promise<unknown> {
    const answer = await service.apply(`${NS}${actionType}`, { parameters, options: EXECUTE }, PEOPLE.ben);

    const { errorInstanceId, ...body } = answer.body as Record<string, unknown>;

    return { status: answer.status, body, errorInstanceId: typeof errorInstanceId };
  }

  it.each([
    ['delete-account', { objectToDeleteParameter: 'acc-3' }],
    [
      'set-account-phase',
      { objectToModifyParameter: 'acc-3', phase: 'closed', ownerId: 'user_ben', viewers: ['member'] },
    ],
  ])(
    'ontology/object-security-policies#hidden-objects: %s of a hidden Object answers 404 as for a missing key, and writes nothing',
    async (actionType, parameters) => {
      const before = await stored();

      const hidden = await applyAsBen(actionType, parameters);

      expect(hidden).toMatchObject({ status: 404, body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound' } });

      expect(await stored()).toEqual(before);

      expect(before).toEqual({
        rows: [{ account_id: 'acc-3', phase: 'customer', owner_id: 'user_carl' }],
        history: '7',
      });

      await service.db.query(sql("DELETE FROM ontology_1_objects.engagement_partners WHERE b_account_id = 'acc-3'"));

      await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'acc-3'"));

      expect(await applyAsBen(actionType, parameters)).toEqual(hidden);
    },
  );

  it('ontology/object-edits/edit-history#security: the history of a type with a policy gives each person the entries of the Objects that they load, and the history of a type with no policy answers', async () => {
    const history = async (person: Person) => {
      const answer = await post(`objectTypes/${ACCOUNT}/editsHistory`, { sortOrder: 'oldest_first' }, person);

      const page = JSON.parse(answer.text) as {
        data: { objectPrimaryKey: { accountId: { value: string } } }[];
        totalCount: number;
      };

      return {
        status: answer.status,
        keys: page.data.map((entry) => entry.objectPrimaryKey.accountId.value),
        totalCount: page.totalCount,
      };
    };

    const entries = (keys: string[]) => ({ status: 200, keys, totalCount: keys.length });

    expect(await each(history)).toEqual({
      ann: entries(['acc-1', 'acc-2', 'acc-7']),
      ben: entries(['acc-2', 'acc-7']),
      admin: entries(['acc-1', 'acc-2', 'acc-3', 'acc-7']),
      nobody: entries([]),
    });

    expect((await post(`objectTypes/${ENGAGEMENT}/editsHistory`, {}, 'admin')).status).toBe(200);
  });
});

type Call = (person: Person) => Promise<RawAnswer>;

type SweepRow =
  | { readonly kind: 'objects'; readonly calls: readonly Call[] }
  | { readonly kind: 'metadata'; readonly calls: readonly Call[] }
  | { readonly kind: 'actions'; readonly calls: readonly Call[] };

const load =
  (objectSet: object, primaryKey = 'accountId'): Call =>
  (person) =>
    post('objectSets/loadObjects', { objectSet, select: [primaryKey], ...byKey(primaryKey) }, person);

const aggregate =
  (body: object): Call =>
  (person) =>
    post('objectSets/aggregate', { objectSet: accounts, ...body }, person);

const apply =
  (actionType: string, parameters: object, mode = 'VALIDATE_AND_EXECUTE'): Call =>
  (person) =>
    post(
      `actions/${NS}${actionType}/apply`,
      { parameters, options: { mode, returnEdits: 'ALL_V2_WITH_DELETIONS' } },
      person,
    );

const SWEEP: Readonly<Record<OntologyRouteKey, SweepRow>> = {
  'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects': {
    kind: 'objects',
    calls: [
      load(accounts),
      load({ type: 'union', objectSets: [where(accounts, 'phase', 'customer'), where(accounts, 'phase', 'prospect')] }),
      load({ type: 'intersect', objectSets: [accounts, where(accounts, 'phase', 'customer')] }),
      load({ type: 'subtract', objectSets: [accounts, where(accounts, 'accountId', 'acc-7')] }),
      load(around(engagements, 'account')),
      load(around(accounts, 'engagements'), 'engagementId'),
      load(around(where(engagements, 'engagementId', 'eng-3'), 'partners')),
      load(around(where(accounts, 'accountId', 'acc-1'), 'partnerEngagements'), 'engagementId'),
      (person) =>
        post(
          'objectSets/loadObjects',
          { objectSet: accounts, select: ['accountId'], ...byKey('accountId'), pageSize: 1 },
          person,
        ),
    ],
  },
  'POST /api/v2/ontologies/{ontology}/objectSets/aggregate': {
    kind: 'objects',
    calls: [
      aggregate({ groupBy: [], aggregation: [{ type: 'count', name: 'count' }] }),
      aggregate({ groupBy: [{ type: 'exact', field: 'phase' }], aggregation: [{ type: 'count', name: 'count' }] }),
      aggregate({ groupBy: [], aggregation: [{ type: 'approximateDistinct', name: 'owners', field: 'ownerId' }] }),
    ],
  },
  'GET /api/v2/ontologies/{ontology}/fullMetadata': {
    kind: 'metadata',
    calls: [(person) => get('fullMetadata', person)],
  },
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata': {
    kind: 'metadata',
    calls: [(person) => get(`objectTypes/${ACCOUNT}/fullMetadata`, person)],
  },
  'GET /api/v2/ontologies/{ontology}/objectTypes': {
    kind: 'metadata',
    calls: [(person) => get('objectTypes', person)],
  },
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}': {
    kind: 'metadata',
    calls: [(person) => get(`objectTypes/${ACCOUNT}`, person)],
  },
  'GET /api/v2/ontologies/{ontology}/actionTypes': {
    kind: 'metadata',
    calls: [(person) => get('actionTypes', person)],
  },
  'GET /api/v2/ontologies/{ontology}/actionTypes/{actionType}': {
    kind: 'metadata',
    calls: [(person) => get(`actionTypes/${NS}delete-account`, person)],
  },
  'GET /api/v2/ontologies/{ontology}/queryTypes': { kind: 'metadata', calls: [(person) => get('queryTypes', person)] },
  'GET /api/v2/ontologies/{ontology}/queryTypes/{queryApiName}': {
    kind: 'metadata',
    calls: [
      (person) =>
        get('queryTypes/noSuchQuery', person).then((answer) => ({ ...answer, text: withoutInstance(answer.text) })),
    ],
  },
  'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute': {
    kind: 'metadata',
    calls: [
      (person) =>
        post('queries/noSuchQuery/execute', { parameters: {} }, person).then((answer) => ({
          ...answer,
          text: withoutInstance(answer.text),
        })),
    ],
  },
  'GET /api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}': {
    kind: 'metadata',
    calls: [
      async (person) =>
        get(
          `actionTypes/byRid/${(JSON.parse((await get(`actionTypes/${NS}delete-account`, person)).text) as { rid: string }).rid}`,
          person,
        ),
    ],
  },
  'POST /api/v2/ontologies/{ontology}/actions/{action}/apply': {
    kind: 'actions',
    calls: [
      apply('delete-account', { objectToDeleteParameter: 'acc-3' }),
      apply('set-account-phase', {
        objectToModifyParameter: 'acc-3',
        phase: 'closed',
        ownerId: 'user_ben',
        viewers: ['member'],
      }),
      apply(
        'set-account-phase',
        { objectToModifyParameter: 'acc-3', phase: 'closed', ownerId: 'user_ben', viewers: ['member'] },
        'VALIDATE_ONLY',
      ),
      apply('copy-account-phase', { objectToModifyParameter: 'eng-4', account: 'acc-3' }),
    ],
  },
  'POST /api/v2/ontologies/{ontology}/actions/{action}/applyBatch': {
    kind: 'actions',
    calls: [
      (person) =>
        post(
          `actions/${NS}delete-account/applyBatch`,
          { requests: [{ parameters: { objectToDeleteParameter: 'acc-3' } }] },
          person,
        ),
    ],
  },
  'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory': {
    kind: 'objects',
    calls: [
      (person) => post(`objectTypes/${ACCOUNT}/editsHistory`, {}, person),
      (person) => post(`objectTypes/${ACCOUNT}/editsHistory`, { pageSize: 1, sortOrder: 'oldest_first' }, person),
      (person) => post(`objectTypes/${ACCOUNT}/editsHistory`, { objectPrimaryKey: { accountId: 'acc-1' } }, person),
    ],
  },
};

const TOOL_CALLS: Readonly<Record<string, Call>> = {
  load_objects: (person) =>
    service
      .tool(
        'load_objects',
        { objectSet: accounts, select: ['accountId'], orderBy: { fields: [{ field: 'accountId' }] } },
        PEOPLE[person],
      )
      .then(asRaw),
  get_edit_history: (person) => service.tool('get_edit_history', { objectType: ACCOUNT }, PEOPLE[person]).then(asRaw),
  aggregate_objects: (person) =>
    service
      .tool(
        'aggregate_objects',
        {
          objectSet: accounts,
          groupBy: [{ type: 'exact', field: 'phase' }],
          aggregation: [{ type: 'count', name: 'count' }],
        },
        PEOPLE[person],
      )
      .then(asRaw),
};

const TOOL_OWNERS: Readonly<Record<string, string>> = {
  describe_object_type: 'metadata',
  describe_action: 'metadata',
  describe_query: 'metadata',
  execute_query: 'metadata',
  apply_action: 'actions',
};

const TOOL_ACTIONS: readonly Call[] = [
  (person) =>
    service.applyOverMcp(`${NS}delete-account`, { objectToDeleteParameter: 'acc-3' }, PEOPLE[person]).then(asRaw),
  (person) =>
    service
      .applyOverMcp(`${NS}copy-account-phase`, { objectToModifyParameter: 'eng-4', account: 'acc-3' }, PEOPLE[person])
      .then(asRaw),
];

function asRaw(answer: { status: number; body: unknown }): RawAnswer {
  return {
    status: answer.status,
    contentType: 'application/json',
    text: JSON.stringify((answer.body as { result: unknown }).result),
  };
}

describe('the sweep of the read routes', () => {
  const objectRows = Object.entries(SWEEP).flatMap(([key, row]) =>
    row.kind === 'objects' ? [[key, row.calls] as const] : [],
  );

  it.each(objectRows)(
    '%s: 2 people get different Objects, and the person who sees none gets the bytes of an Ontology with no Account',
    async (_key, calls) => {
      for (const call of calls) {
        const [ann, ben, nobody] = [await call('ann'), await call('ben'), await call('nobody')];

        expect([ann.status, ben.status, nobody.status]).toEqual([200, 200, 200]);
        expect(ann.text).not.toBe(ben.text);

        await noAccounts();

        expect(stripToken((await call('nobody')).text)).toBe(stripToken(nobody.text));

        expect(stripToken((await call('admin')).text)).toBe(stripToken(nobody.text));

        await seed();
      }
    },
  );

  it.each(Object.entries(TOOL_CALLS))(
    'the MCP tool %s: 2 people get different Objects, and the person who sees none gets the bytes of no Account',
    async (_name, call) => {
      const [ann, ben, nobody] = [await call('ann'), await call('ben'), await call('nobody')];

      expect(ann.text).not.toBe(ben.text);

      await noAccounts();

      expect((await call('admin')).text).toBe(nobody.text);
    },
  );

  it('each MCP tool has a row', () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual(
      [...Object.keys(TOOL_CALLS), ...Object.keys(TOOL_OWNERS)].sort(),
    );
  });

  const actionRows = [
    ...Object.entries(SWEEP).flatMap(([key, row]) => (row.kind === 'actions' ? [[key, row.calls] as const] : [])),
    ['the MCP tool apply_action', TOOL_ACTIONS] as const,
  ];

  it.each(actionRows)(
    'service/http-api#errors ontology/object-security-policies#hidden-objects: %s of a hidden Account gets the bytes of a deleted Account',
    async (key, calls) => {
      for (const call of calls) {
        const [ben, nobody] = [await call('ben'), await call('nobody')];

        const admin = await call('admin');

        const isBatch = key.endsWith('/applyBatch');

        const actual = isBatch
          ? { statuses: [ben.status, admin.status] }
          : { notFound: [ben.text.includes('ObjectNotFound'), admin.text.includes('ObjectNotFound')] };

        expect(actual).toEqual(isBatch ? { statuses: [400, 400] } : { notFound: [true, false] });

        await noAccounts();

        expect({ status: ben.status, text: withoutInstance(ben.text) }).toEqual({
          status: (await call('ben')).status,
          text: withoutInstance((await call('ben')).text),
        });

        const missing = await call('nobody');

        expect({ status: nobody.status, text: withoutInstance(nobody.text) }).toEqual({
          status: missing.status,
          text: withoutInstance(missing.text),
        });

        await seed();
      }
    },
  );

  it.each(Object.entries(SWEEP).flatMap(([key, row]) => (row.kind === 'metadata' ? [[key, row.calls] as const] : [])))(
    '%s shows no Object: 2 people of 1 role get the same bytes',
    async (_key, calls) => {
      for (const call of calls) expect((await call('ann')).text).toBe((await call('ben')).text);
    },
  );
});

function withoutInstance(text: string): string {
  return text.replaceAll(/(errorInstanceId\W+)[0-9a-f-]{36}/g, '$1<id>');
}

function stripToken(text: string): string {
  return text.replace(/"nextPageToken":"[^"]*"/, '"nextPageToken":"<token>"');
}
