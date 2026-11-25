import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../publish/publish.test-utils.ts';
import { unchecked, USE } from '../ontology/stored.test-utils.ts';
import { workosUsers } from './index.ts';
import { ORGANIZATION, SERVICE_USER } from '../tokens.test-utils.ts';
import { STUB_APPLICATION, STUB_PERSON, STUB_WORKOS_KEY, stubUsers, stubWorkos } from '../workos.test-utils.ts';
import {
  CLIENT_ACCOUNTS,
  CLIENT_ENGAGEMENTS,
  errorAnswer,
  NS,
  ONTOLOGY_RID,
  PERSON,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
  type Answer,
} from '../actions/actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;

const SET_ENGAGEMENT_STATUS_RID = 'ri.actions.main.action-type.7c2cbf1f-5c5b-55c9-83a7-f16211226ef9';

const historyOn = (store: string, storeAllPreviousProperties: boolean) => ({
  type: 'config',
  config: { store, storeAllPreviousProperties },
});

function testIr(storeAllEngagement = false): OntologyIr {
  const ir = twinIr('0.6.3');

  for (const [apiName, storeAll] of [
    [ENGAGEMENT, storeAllEngagement],
    [ACCOUNT, true],
  ] as const) {
    const block = ir.ontology.objectTypes[apiName];

    if (!block) throw new Error(`The twin 0.6.3 IR has no ${apiName}.`);

    block.entityMetadata = unchecked({
      ...block.entityMetadata,
      editsHistory: historyOn(apiName, storeAll),
    });
  }

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const OTHER_PERSON = 'user_01JOTHERPERSON0000000000000';

const OTHER_USERS = stubUsers(
  [STUB_PERSON, { ...STUB_PERSON, id: OTHER_PERSON, email: 'other@example.com' }],
  [PERSON, OTHER_PERSON].map((user) => ({
    user_id: user,
    organization_id: ORGANIZATION,
    status: 'active' as const,
    roles: ['member'],
  })),
  { roles: { [ORGANIZATION]: { member: [USE] } } },
);

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const setStatus = (engagementId: string, status: string) =>
  service.apply(SET_ENGAGEMENT_STATUS, {
    parameters: { objectToModifyParameter: engagementId, status },
    options: EXECUTE_NONE,
  });

const operationIdOf = (answer: Answer): string => (answer.body as { operationId: string }).operationId;

interface Page {
  readonly data: readonly Record<string, unknown>[];
  readonly totalCount?: number;
  readonly nextPageToken?: string;
}

async function page(objectType: string, body: unknown): Promise<Page> {
  const answer = await service.editsHistory(objectType, body);

  expect(answer.status).toBe(200);

  return answer.body as Page;
}

const ACCOUNTS = CLIENT_ACCOUNTS.slice(0, 2);

const ENGAGEMENTS = CLIENT_ENGAGEMENTS.filter(({ engagementId }) =>
  ['eng-1', 'eng-2', 'eng-4'].includes(engagementId as string),
);

const keysOf = (page: Page) =>
  page.data.map((entry) => [
    (entry['objectPrimaryKey'] as Record<string, { value: unknown }>)['engagementId']?.value,
    entry['operationId'],
  ]);

const rid = (n: number) => `ri.actions.main.action.${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const op = (n: number) => `ri.actions.main.action.${String(n).repeat(8)}-0000-4000-8000-000000000000`;

const entryOf = (engagementId: string, operationId: string) => ({
  objectPrimaryKey: { engagementId },
  operationId,
  actionTypeRid: SET_ENGAGEMENT_STATUS_RID,
  userId: PERSON,
  edit: {
    type: 'modifyEdit',
    properties: { status: 'won' },
    previousProperties: { status: 'open' },
    includesAllPreviousValues: false,
  },
});

async function insertEntry(engagementId: string, createdAt: string, operationId: string): Promise<void> {
  await service.db.query({
    text: 'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, created_at, entry) VALUES ($1, $2, $3, $4)',
    values: [ENGAGEMENT, engagementId, createdAt, JSON.stringify(entryOf(engagementId, operationId))],
  });
}

const answerOf = (engagementId: string, timestamp: string, operationId: string) => {
  const entry = entryOf(engagementId, operationId);

  return {
    ...entry,
    objectPrimaryKey: { engagementId: { type: 'stringValue', value: engagementId } },
    timestamp,
    edit: { ...entry.edit, includesAllPreviousValues: false },
  };
};

const T1 = '2026-10-20T10:00:00Z';
const T2 = '2026-10-20T11:00:00.5Z';
const T3 = '2026-10-20T12:00:00.123456Z';
const T3_MS = '2026-10-20T12:00:00.123Z';

describe('the route', () => {
  it('ontology/object-edits/edit-history#reading: with objectPrimaryKey, the route returns the entries of 1 Object', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const first = await setStatus('eng-2', 'won');

    await setStatus('eng-1', 'lost');

    const result = await page(ENGAGEMENT, {
      objectPrimaryKey: { engagementId: 'eng-2' },
    });

    expect(result).toEqual({
      data: [
        {
          objectPrimaryKey: { engagementId: { type: 'stringValue', value: 'eng-2' } },
          operationId: operationIdOf(first),
          actionTypeRid: SET_ENGAGEMENT_STATUS_RID,
          userId: PERSON,
          timestamp: expect.stringMatching(UTC_TIME),
          edit: {
            type: 'modifyEdit',
            properties: { status: 'won' },
            previousProperties: { status: 'open' },
            includesAllPreviousValues: false,
          },
        },
      ],
      totalCount: 1,
    });

    const [row] = await service.db.query<{ created_at: Date }>(
      sql("SELECT created_at FROM ontology_1_engine.edit_history WHERE primary_key = 'eng-2'"),
    );

    expect(Date.parse(result.data[0]?.['timestamp'] as string)).toBe(row?.created_at.getTime());
  });

  it('ontology/object-edits/edit-history#reading: with no objectPrimaryKey, the route returns the entries of all Objects of the type, and of no other type', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const first = await setStatus('eng-2', 'won');

    const second = await setStatus('eng-1', 'lost');

    await service.apply(SET_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'acc-1', phase: 'churned' },
      options: EXECUTE_NONE,
    });

    const result = await page(ENGAGEMENT, {});

    expect(keysOf(result)).toEqual([
      ['eng-1', operationIdOf(second)],
      ['eng-2', operationIdOf(first)],
    ]);

    expect(result.totalCount).toBe(2);
  });

  it('ontology/object-edits/edit-history#reading: the route returns each kind of edit: a createEdit and a deleteEdit hold no includesAllPreviousValues', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(CREATE_ENGAGEMENT, {
      parameters: {
        engagementId: 'eng-7',
        accountId: 'acc-2',
        title: 'Expansion',
        amount: 22000,
      },
      options: EXECUTE_NONE,
    });

    await service.apply(DELETE_ENGAGEMENT, {
      parameters: { objectToDeleteParameter: 'eng-7' },
      options: EXECUTE_NONE,
    });

    const result = await page(ENGAGEMENT, {
      objectPrimaryKey: { engagementId: 'eng-7' },
    });

    expect(result.data.map((entry) => entry['edit'])).toEqual([
      {
        type: 'deleteEdit',
        previousProperties: {
          engagementId: 'eng-7',
          accountId: 'acc-2',
          title: 'Expansion',
          amount: 22000,
          status: 'open',
          createdAt: expect.stringMatching(UTC_TIME),
        },
      },
      {
        type: 'createEdit',
        properties: {
          accountId: 'acc-2',
          title: 'Expansion',
          amount: 22000,
          status: 'open',
          createdAt: expect.stringMatching(UTC_TIME),
        },
      },
    ]);
  });

  describe('ontology/object-edits/edit-history#entries: a create entry has no primary key in properties', () => {
    const CREATED = {
      accountId: 'acc-2',
      title: 'Expansion',
      amount: 22000,
      status: 'open',
      createdAt: expect.stringMatching(UTC_TIME),
    };

    const create = () =>
      service.apply(CREATE_ENGAGEMENT, {
        parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
        options: EXECUTE_NONE,
      });

    const storedProperties = async () => {
      const [row] = await service.db.query<{ entry: { edit: { properties: Record<string, unknown> } } }>(
        sql(`SELECT entry FROM ontology_1_engine.edit_history WHERE primary_key = 'eng-7'`),
      );

      return row?.entry.edit.properties;
    };

    it('ontology/object-edits/edit-history#entries: the route gives the create of a new Object with no engagementId, and the primary key in objectPrimaryKey', async () => {
      await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

      await create();

      const result = await page(ENGAGEMENT, { objectPrimaryKey: { engagementId: 'eng-7' } });

      expect(result.data).toEqual([
        expect.objectContaining({
          objectPrimaryKey: { engagementId: { type: 'stringValue', value: 'eng-7' } },
          edit: { type: 'createEdit', properties: CREATED },
        }),
      ]);
    });

    it('ontology/object-edits/edit-history#entries: the route gives the create of an old stored entry with no engagementId', async () => {
      await service.db.query({
        text: 'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, created_at, entry) VALUES ($1, $2, $3, $4)',
        values: [
          ENGAGEMENT,
          'eng-8',
          T1,
          JSON.stringify({
            objectPrimaryKey: { engagementId: 'eng-8' },
            operationId: op(1),
            actionTypeRid: SET_ENGAGEMENT_STATUS_RID,
            userId: PERSON,
            edit: { type: 'createEdit', properties: { engagementId: 'eng-8', title: 'Old' } },
          }),
        ],
      });

      const result = await page(ENGAGEMENT, { objectPrimaryKey: { engagementId: 'eng-8' } });

      expect(result.data.map((entry) => entry['edit'])).toEqual([{ type: 'createEdit', properties: { title: 'Old' } }]);
    });

    it('ontology/object-edits/edit-history#entries: a read with no objectPrimaryKey gives the same properties', async () => {
      await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

      await create();

      const result = await page(ENGAGEMENT, {});

      expect(result.data.map((entry) => entry['edit'])).toEqual([{ type: 'createEdit', properties: CREATED }]);
    });

    it('ontology/object-edits/edit-history#entries: the stored row still holds engagementId', async () => {
      await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

      await create();

      expect(await storedProperties()).toEqual({ engagementId: 'eng-7', ...CREATED });
    });

    it('ontology/object-edits/edit-history#entries: a delete entry keeps the primary key in previousProperties, and a modify entry is unchanged', async () => {
      await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

      await create();

      await setStatus('eng-7', 'won');

      await service.apply(DELETE_ENGAGEMENT, {
        parameters: { objectToDeleteParameter: 'eng-7' },
        options: EXECUTE_NONE,
      });

      const result = await page(ENGAGEMENT, {
        objectPrimaryKey: { engagementId: 'eng-7' },
        includeAllPreviousProperties: true,
      });

      const [remove, modify] = result.data.map((entry) => entry['edit'] as Record<string, unknown>);

      expect(remove).toEqual({
        type: 'deleteEdit',
        previousProperties: expect.objectContaining({ engagementId: 'eng-7', status: 'won' }),
      });

      expect(modify).toEqual({
        type: 'modifyEdit',
        properties: { status: 'won' },
        previousProperties: { status: 'open' },
        includesAllPreviousValues: false,
      });
    });

    it('ontology/object-edits/edit-history#entries: get_edit_history over the Ontology MCP gives the same create entry', async () => {
      await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

      await create();

      const answer = await service.tool('get_edit_history', {
        objectType: ENGAGEMENT,
        objectPrimaryKey: { engagementId: 'eng-7' },
      });

      const { result } = answer.body as { result: { structuredContent: { data: { edit: unknown }[] } } };

      expect(result.structuredContent.data.map((entry) => entry.edit)).toEqual([
        { type: 'createEdit', properties: CREATED },
      ]);
    });
  });

  it('ontology/object-edits/edit-history#reading: the timestamp of an entry is its time in UTC, in milliseconds, with no trailing zeros', async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-1', T2, op(2));

    await insertEntry('eng-1', T3, op(3));

    const result = await page(ENGAGEMENT, { sortOrder: 'oldest_first' });

    expect(result.data.map((entry) => entry['timestamp'])).toEqual([T1, T2, T3_MS]);
  });
});

describe('the order', () => {
  it('ontology/object-edits/edit-history#reading: the route returns the newest entries first by default', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const first = await setStatus('eng-2', 'won');

    const second = await setStatus('eng-2', 'lost');

    const third = await setStatus('eng-2', 'open');

    const result = await page(ENGAGEMENT, {
      objectPrimaryKey: { engagementId: 'eng-2' },
    });

    expect(result.data.map((entry) => entry['operationId'])).toEqual([
      operationIdOf(third),
      operationIdOf(second),
      operationIdOf(first),
    ]);

    expect(result.data.map((entry) => (entry['edit'] as { properties: unknown }).properties)).toEqual([
      { status: 'open' },
      { status: 'lost' },
      { status: 'won' },
    ]);
  });

  it('ontology/object-edits/edit-history#reading: sortOrder is newest_first or oldest_first', async () => {
    await insertEntry('eng-1', T2, op(2));

    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-1', T3, op(3));

    expect(keysOf(await page(ENGAGEMENT, { sortOrder: 'newest_first' }))).toEqual([
      ['eng-1', op(3)],
      ['eng-1', op(2)],
      ['eng-1', op(1)],
    ]);

    expect(keysOf(await page(ENGAGEMENT, { sortOrder: 'oldest_first' }))).toEqual([
      ['eng-1', op(1)],
      ['eng-1', op(2)],
      ['eng-1', op(3)],
    ]);
  });

  it('ontology/object-edits/edit-history#reading: another sortOrder gets 400 Default:InvalidArgument', async () => {
    const answer = await service.editsHistory(ENGAGEMENT, {
      sortOrder: 'newest',
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: {},
      },
    });
  });

  it('ontology/object-edits/edit-history#reading: the route sorts the entries by time, then by primary key, then by Action ID, in the direction of sortOrder', async () => {
    await insertEntry('eng-2', T2, op(1));

    await insertEntry('eng-1', T2, op(2));

    await insertEntry('eng-2', T2, op(3));

    await insertEntry('eng-3', T1, op(4));

    await insertEntry('eng-1', T3, op(0));

    await insertEntry('eng-a', T2, op(5));

    await insertEntry('eng-B', T2, op(6));

    const oldest = [
      ['eng-3', op(4)],
      ['eng-1', op(2)],
      ['eng-2', op(1)],
      ['eng-2', op(3)],
      ['eng-B', op(6)],
      ['eng-a', op(5)],
      ['eng-1', op(0)],
    ];

    expect(keysOf(await page(ENGAGEMENT, { sortOrder: 'oldest_first' }))).toEqual(oldest);

    expect(keysOf(await page(ENGAGEMENT, {}))).toEqual([...oldest].reverse());
  });

  it('ontology/object-edits/edit-history#reading: 2 entries with 1 time and 1 Action ID sort by primary key', async () => {
    await insertEntry('eng-a', T1, op(1));

    await insertEntry('eng-7', T1, op(1));

    await insertEntry('eng-B', T1, op(1));

    await insertEntry('eng-2', T1, op(1));

    expect(keysOf(await page(ENGAGEMENT, { sortOrder: 'oldest_first' }))).toEqual([
      ['eng-2', op(1)],
      ['eng-7', op(1)],
      ['eng-B', op(1)],
      ['eng-a', op(1)],
    ]);
  });
});

describe('the request fields', () => {
  it('ontology/object-edits/edit-history#reading: each field is optional: an empty body gives the entries of all Objects of the type', async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-2', T2, op(2));

    expect(await page(ENGAGEMENT, {})).toEqual({
      data: [answerOf('eng-2', T2, op(2)), answerOf('eng-1', T1, op(1))],
      totalCount: 2,
    });
  });

  it('ontology/object-edits/edit-history#reading: the request takes objectPrimaryKey, filters, sortOrder, includeAllPreviousProperties, pageSize, and pageToken together', async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-1', T2, op(2));

    await insertEntry('eng-1', T3, op(3));

    await insertEntry('eng-2', T2, op(4));

    const body = {
      objectPrimaryKey: { engagementId: 'eng-1' },
      filters: { type: 'timestampFilter', startTime: T1, endTime: T3 },
      sortOrder: 'oldest_first',
      includeAllPreviousProperties: false,
      pageSize: 2,
    };

    const first = await page(ENGAGEMENT, body);

    expect(first.data).toEqual([answerOf('eng-1', T1, op(1)), answerOf('eng-1', T2, op(2))]);
    expect(first.nextPageToken).toEqual(expect.any(String));

    expect(await page(ENGAGEMENT, { ...body, pageToken: first.nextPageToken })).toEqual({
      data: [answerOf('eng-1', T3_MS, op(3))],
      totalCount: 1,
    });
  });

  it('ontology/object-edits/edit-history#reading: a field of the wrong shape gets 400 Default:InvalidArgument', async () => {
    const invalid = {
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: {},
      },
    };

    for (const body of [
      [],
      { objectPrimaryKey: 'eng-1' },
      { objectPrimaryKey: { title: 'Pilot' } },
      { includeAllPreviousProperties: 'yes' },
      { pageSize: 1.5 },
      { pageToken: 7 },
    ]) {
      expect(errorAnswer(await service.editsHistory(ENGAGEMENT, body))).toEqual(invalid);
    }
  });
});

describe('the primary key', () => {
  const invalid = {
    status: 400,
    body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: {} },
  };

  beforeEach(async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-2', T2, op(2));
  });

  it('ontology/object-edits/edit-history#reading: objectPrimaryKey takes a stringValue of PrimaryKeyValueV2', async () => {
    expect(
      await page(ENGAGEMENT, { objectPrimaryKey: { engagementId: { type: 'stringValue', value: 'eng-1' } } }),
    ).toEqual({
      data: [answerOf('eng-1', T1, op(1))],
      totalCount: 1,
    });
  });

  it('ontology/object-edits/edit-history#reading: an objectPrimaryKey that is not a stringValue of the primary key gets 400 Default:InvalidArgument', async () => {
    for (const objectPrimaryKey of [
      { engagementId: { type: 'integerValue', value: 1 } },
      { engagementId: { type: 'stringValue', value: 1 } },
      { engagementId: { value: 'eng-1' } },
      { title: { type: 'stringValue', value: 'Pilot' } },
    ]) {
      expect(errorAnswer(await service.editsHistory(ENGAGEMENT, { objectPrimaryKey }))).toEqual(invalid);
    }
  });

  it('ontology/object-edits/edit-history#reading: objectPrimaryKey also takes the plain value', async () => {
    expect(await page(ENGAGEMENT, { objectPrimaryKey: { engagementId: 'eng-2' } })).toEqual({
      data: [answerOf('eng-2', T2, op(2))],
      totalCount: 1,
    });
  });

  it('ontology/object-edits/edit-history#reading: each entry gives objectPrimaryKey in the tagged form, from the plain value that the row stores', async () => {
    const [row] = await service.db.query<{ entry: { objectPrimaryKey: unknown } }>(
      sql("SELECT entry FROM ontology_1_engine.edit_history WHERE primary_key = 'eng-1'"),
    );

    expect(row?.entry.objectPrimaryKey).toEqual({ engagementId: 'eng-1' });

    const result = await page(ENGAGEMENT, { sortOrder: 'oldest_first' });

    expect(result.data.map((entry) => entry['objectPrimaryKey'])).toEqual([
      { engagementId: { type: 'stringValue', value: 'eng-1' } },
      { engagementId: { type: 'stringValue', value: 'eng-2' } },
    ]);
  });
});

describe('the filters', () => {
  beforeEach(async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-2', T2, op(2));

    await insertEntry('eng-1', T3, op(3));
  });

  it('ontology/object-edits/edit-history#reading: timestampFilter with startTime gives the entries at or after it', async () => {
    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: { type: 'timestampFilter', startTime: T2 },
        }),
      ),
    ).toEqual([
      ['eng-1', op(3)],
      ['eng-2', op(2)],
    ]);
  });

  it('ontology/object-edits/edit-history#reading: timestampFilter with endTime gives the entries at or before it', async () => {
    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: { type: 'timestampFilter', endTime: T2 },
        }),
      ),
    ).toEqual([
      ['eng-2', op(2)],
      ['eng-1', op(1)],
    ]);
  });

  it('ontology/object-edits/edit-history#reading: timestampFilter with startTime and endTime gives the entries between them, and with neither gives all', async () => {
    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: { type: 'timestampFilter', startTime: T2, endTime: T2 },
        }),
      ),
    ).toEqual([['eng-2', op(2)]]);

    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: {
            type: 'timestampFilter',
            startTime: '2026-10-20T10:30:00+00:00',
            endTime: '2026-10-20T11:30:00Z',
          },
        }),
      ),
    ).toEqual([['eng-2', op(2)]]);

    expect(await page(ENGAGEMENT, { filters: { type: 'timestampFilter' } })).toEqual(
      expect.objectContaining({ totalCount: 3 }),
    );
  });

  it('ontology/object-edits/edit-history#reading: timestampFilter compares the time in milliseconds, as the entry shows it in timestamp', async () => {
    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: { type: 'timestampFilter', startTime: T3_MS, endTime: T3_MS },
        }),
      ),
    ).toEqual([['eng-1', op(3)]]);

    expect(
      await page(ENGAGEMENT, { filters: { type: 'timestampFilter', startTime: '2026-10-20T12:00:00.1234Z' } }),
    ).toEqual(expect.objectContaining({ totalCount: 0 }));
  });

  it('ontology/object-edits/edit-history#reading: operationIdsFilter gives the entries of the Action IDs in operationIds', async () => {
    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: { type: 'operationIdsFilter', operationIds: [op(3), op(1)] },
        }),
      ),
    ).toEqual([
      ['eng-1', op(3)],
      ['eng-1', op(1)],
    ]);

    expect(
      await page(ENGAGEMENT, {
        filters: { type: 'operationIdsFilter', operationIds: [] },
      }),
    ).toEqual({ data: [], totalCount: 0 });
  });

  it('ontology/object-edits/edit-history#reading: operationIdsFilter gives the entries of an Action that an apply returned', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const applied = await setStatus('eng-4', 'won');

    expect(
      keysOf(
        await page(ENGAGEMENT, {
          filters: {
            type: 'operationIdsFilter',
            operationIds: [operationIdOf(applied)],
          },
        }),
      ),
    ).toEqual([['eng-4', operationIdOf(applied)]]);
  });

  it('ontology/object-edits/edit-history#reading: another filter, or a filter of the wrong shape, gets 400 Default:InvalidArgument', async () => {
    const invalid = {
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'Default:InvalidArgument',
        parameters: {},
      },
    };

    for (const filters of [
      { type: 'userFilter', userId: PERSON },
      [{ type: 'timestampFilter' }],
      { type: 'timestampFilter', startTime: 'yesterday' },
      { type: 'timestampFilter', endTime: 1_760_000_000 },
      { type: 'operationIdsFilter' },
      { type: 'operationIdsFilter', operationIds: [7] },
    ]) {
      expect(errorAnswer(await service.editsHistory(ENGAGEMENT, { filters }))).toEqual(invalid);
    }
  });
});

describe('the pages', () => {
  it('ontology/object-edits/edit-history#reading: the page token continues after the last entry of its page, also when 2 entries have 1 time and 1 primary key', async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-2', T2, op(2));

    await insertEntry('eng-2', T2, op(3));

    await insertEntry('eng-3', T2, op(4));

    await insertEntry('eng-1', T3, op(5));

    const read: unknown[] = [];
    let token: string | undefined;
    let pages = 0;

    do {
      const result = await page(ENGAGEMENT, {
        pageSize: 3,
        ...(token === undefined ? {} : { pageToken: token }),
      });

      read.push(...keysOf(result));

      token = result.nextPageToken;

      pages += 1;
    } while (token !== undefined && pages < 10);

    expect(pages).toBe(2);

    expect(read).toEqual([
      ['eng-1', op(5)],
      ['eng-3', op(4)],
      ['eng-2', op(3)],
      ['eng-2', op(2)],
      ['eng-1', op(1)],
    ]);
  });

  it('ontology/object-edits/edit-history#reading: the page token holds the time to the microsecond', async () => {
    await insertEntry('eng-1', '2026-10-20T12:00:00.000001Z', op(1));

    await insertEntry('eng-1', '2026-10-20T12:00:00.000002Z', op(2));

    const first = await page(ENGAGEMENT, {
      sortOrder: 'oldest_first',
      pageSize: 1,
    });

    expect(first.data.map((entry) => [entry['timestamp'], entry['operationId']])).toEqual([
      ['2026-10-20T12:00:00Z', op(1)],
    ]);

    const second = await page(ENGAGEMENT, {
      sortOrder: 'oldest_first',
      pageSize: 1,
      pageToken: first.nextPageToken,
    });

    expect(second.data.map((entry) => [entry['timestamp'], entry['operationId']])).toEqual([
      ['2026-10-20T12:00:00Z', op(2)],
    ]);
  });

  it('ontology/object-edits/edit-history#reading: the page token holds values, not a position, so a new entry does not move the next page', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const first = await setStatus('eng-2', 'won');

    const second = await setStatus('eng-2', 'lost');

    const third = await setStatus('eng-2', 'open');

    const one = await page(ENGAGEMENT, { pageSize: 2 });

    expect(one.data.map((entry) => entry['operationId'])).toEqual([operationIdOf(third), operationIdOf(second)]);

    await setStatus('eng-2', 'won');

    const two = await page(ENGAGEMENT, {
      pageSize: 2,
      pageToken: one.nextPageToken,
    });

    expect(two.data.map((entry) => entry['operationId'])).toEqual([operationIdOf(first)]);
    expect(two.nextPageToken).toBeUndefined();
  });

  it('ontology/object-edits/edit-history#reading: a token that the Ontology service cannot read gets 400 InvalidPageToken', async () => {
    for (const pageToken of [
      'not a token',
      Buffer.from('{"values":[]}').toString('base64url'),
      Buffer.from('[1,2,3]').toString('base64url'),
    ]) {
      expect(errorAnswer(await service.editsHistory(ENGAGEMENT, { pageToken }))).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPageToken',
          parameters: { pageToken },
        },
      });
    }
  });

  const insert101 = () =>
    service.db.query({
      text: `INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, created_at, entry)
             SELECT $1, 'eng-' || n, timestamptz '2026-10-20T10:00:00Z' + n * interval '1 second',
                    jsonb_build_object('objectPrimaryKey', jsonb_build_object('engagementId', 'eng-' || n), 'operationId', 'ri.actions.main.action.' || lpad(n::text, 8, '0') || '-0000-4000-8000-000000000000',
                                       'actionTypeRid', $2::text, 'userId', $3::text,
                                       'edit', jsonb_build_object('type', 'createEdit', 'properties', jsonb_build_object('engagementId', 'eng-' || n)))
             FROM generate_series(1, 101) AS n`,
      values: [ENGAGEMENT, SET_ENGAGEMENT_STATUS_RID, PERSON],
    });

  it('ontology/object-edits/edit-history#reading: the default pageSize is 100', async () => {
    await insert101();

    const first = await page(ENGAGEMENT, {});

    expect(first.data).toHaveLength(100);
    expect(first.totalCount).toBe(100);
    expect(first.data[0]?.['operationId']).toBe(rid(101));

    const second = await page(ENGAGEMENT, { pageToken: first.nextPageToken });

    expect(second.data.map((entry) => entry['operationId'])).toEqual([rid(1)]);
  });

  it('ontology/object-edits/edit-history#reading: the maximum pageSize is 100, and a larger pageSize becomes 100', async () => {
    await insert101();

    for (const pageSize of [101, 150, 10_000]) {
      const result = await page(ENGAGEMENT, { pageSize });

      expect(result.data).toHaveLength(100);
      expect(result.nextPageToken).toEqual(expect.any(String));
    }
  });

  it('ontology/object-edits/edit-history#reading: the response has data, totalCount, and nextPageToken, and totalCount counts the entries of the page only', async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-2', T2, op(2));

    await insertEntry('eng-3', T3, op(3));

    const first = (await service.editsHistory(ENGAGEMENT, { pageSize: 2 })).body as Page;

    expect(Object.keys(first).sort()).toEqual(['data', 'nextPageToken', 'totalCount']);

    expect(first).toEqual({
      data: [answerOf('eng-3', T3_MS, op(3)), answerOf('eng-2', T2, op(2))],
      totalCount: 2,
      nextPageToken: expect.any(String),
    });

    expect(await page(ENGAGEMENT, { pageSize: 2, pageToken: first.nextPageToken })).toEqual({
      data: [answerOf('eng-1', T1, op(1))],
      totalCount: 1,
    });
  });

  it('ontology/object-edits/edit-history#reading: a full last page has no nextPageToken', async () => {
    await insertEntry('eng-1', T1, op(1));

    await insertEntry('eng-2', T2, op(2));

    expect(await page(ENGAGEMENT, { pageSize: 2 })).toEqual({
      data: [answerOf('eng-2', T2, op(2)), answerOf('eng-1', T1, op(1))],
      totalCount: 2,
    });
  });

  it('service/http-api#errors: a pageSize of 0 or less gets 400 InvalidPageSize on editsHistory', async () => {
    for (const pageSize of [0, -1]) {
      expect(errorAnswer(await service.editsHistory(ENGAGEMENT, { pageSize }))).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidPageSize',
          parameters: { pageSize },
        },
      });
    }
  });
});

describe('the previous values', () => {
  beforeEach(() => seedClient(service.db, ACCOUNTS, ENGAGEMENTS));

  const setPhase = () =>
    service.apply(SET_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'acc-1', phase: 'churned' },
      options: EXECUTE_NONE,
    });

  const editOf = async (objectType: string, body: unknown) =>
    (await page(objectType, body)).data.map((entry) => entry['edit']);

  it('ontology/object-edits/edit-history#reading: with includeAllPreviousProperties: true and storeAllPreviousProperties: true, a modify holds the previous values of all Properties', async () => {
    await setPhase();

    expect(await editOf(ACCOUNT, { includeAllPreviousProperties: true })).toEqual([
      {
        type: 'modifyEdit',
        properties: { phase: 'churned' },
        previousProperties: {
          accountId: 'acc-1',
          name: 'Acme',
          phase: 'customer',
        },
        includesAllPreviousValues: true,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#reading: with no includeAllPreviousProperties, or false, a modify holds the previous values of the changed Properties only', async () => {
    await setPhase();

    const changedOnly = [
      {
        type: 'modifyEdit',
        properties: { phase: 'churned' },
        previousProperties: { phase: 'customer' },
        includesAllPreviousValues: false,
      },
    ];

    expect(await editOf(ACCOUNT, {})).toEqual(changedOnly);

    expect(await editOf(ACCOUNT, { includeAllPreviousProperties: false })).toEqual(changedOnly);
  });

  it('ontology/object-edits/edit-history#reading: with includeAllPreviousProperties: true and no storeAllPreviousProperties, a modify holds the previous values of the changed Properties only', async () => {
    await setStatus('eng-2', 'won');

    expect(await editOf(ENGAGEMENT, { includeAllPreviousProperties: true })).toEqual([
      {
        type: 'modifyEdit',
        properties: { status: 'won' },
        previousProperties: { status: 'open' },
        includesAllPreviousValues: false,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#reading: an entry keeps the storeAllPreviousProperties setting of its write, also after a publish that turns it on', async () => {
    await setStatus('eng-2', 'won');

    await service.publish(testIr(true), twinFunctions('0.6.3'));

    try {
      expect(await editOf(ENGAGEMENT, { includeAllPreviousProperties: true })).toEqual([
        {
          type: 'modifyEdit',
          properties: { status: 'won' },
          previousProperties: { status: 'open' },
          includesAllPreviousValues: false,
        },
      ]);
    } finally {
      await service.publish(testIr(), twinFunctions('0.6.3'));
    }
  });

  it('ontology/object-edits/edit-history#reading: an entry with no stored setting holds the previous values of the changed Properties only', async () => {
    const entry = {
      objectPrimaryKey: { accountId: 'acc-1' },
      operationId: op(1),
      actionTypeRid: SET_ENGAGEMENT_STATUS_RID,
      userId: PERSON,
      edit: {
        type: 'modifyEdit',
        properties: { phase: 'churned' },
        previousProperties: { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
      },
    };

    await service.db.query({
      text: 'INSERT INTO ontology_1_engine.edit_history (object_type, primary_key, entry) VALUES ($1, $2, $3)',
      values: [ACCOUNT, 'acc-1', JSON.stringify(entry)],
    });

    expect(await editOf(ACCOUNT, { includeAllPreviousProperties: true })).toEqual([
      {
        type: 'modifyEdit',
        properties: { phase: 'churned' },
        previousProperties: { phase: 'customer' },
        includesAllPreviousValues: false,
      },
    ]);
  });
});

describe('who can read', () => {
  it('every caller who can view the Object can read its history', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const applied = await setStatus('eng-2', 'won');

    const answer = await service.editsHistory(
      ENGAGEMENT,
      { objectPrimaryKey: { engagementId: 'eng-2' } },
      { claims: { sub: OTHER_PERSON }, users: OTHER_USERS },
    );

    expect(answer.status).toBe(200);

    expect((answer.body as Page).data).toEqual([
      expect.objectContaining({
        operationId: operationIdOf(applied),
        userId: PERSON,
      }),
    ]);
  });

  it('issue (ticket rule): the history of an Object Type with history off is an empty page', async () => {
    const answer = await service.apply(CREATE_STRUCT_PROBE, {
      parameters: {
        probeId: 'sp-1',
        relationship: { label: 'partner', since: '2024-01-15' },
        measures: { flag: true, count: 3 },
      },
      options: EXECUTE_NONE,
    });

    expect(answer.status).toBe(200);

    expect(await page(STRUCT_PROBE, {})).toEqual({ data: [], totalCount: 0 });
  });

  it('issue (ticket rule): the history of an Object that never existed is an empty page', async () => {
    await insertEntry('eng-1', T1, op(1));

    expect(await page(ENGAGEMENT, { objectPrimaryKey: { engagementId: 'eng-404' } })).toEqual({
      data: [],
      totalCount: 0,
    });
  });

  it('service/http-api#errors: an unknown Object Type gets 404 ObjectTypeNotFound on editsHistory', async () => {
    const answer = await service.editsHistory(`${NS}Unknown`, {});

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'ObjectTypeNotFound',
        parameters: { objectType: `${NS}Unknown` },
      },
    });
  });
});

describe('the versions of the Objects', () => {
  it('service/storage#writes: no apply answer, Object, page token, or Object Edit History entry holds a version', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const answers: unknown[] = [];
    const versions: string[] = [];

    for (const status of ['won', 'lost']) {
      answers.push(
        await service.apply(SET_ENGAGEMENT_STATUS, {
          parameters: { objectToModifyParameter: 'eng-2', status },
          options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
        }),
      );

      const [row] = await service.db.query<{ version: string }>(
        sql("SELECT __version::text AS version FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2'"),
      );

      versions.push(row?.version ?? '');
    }

    const first = await page(ENGAGEMENT, { pageSize: 1 });

    expect(first.nextPageToken).toEqual(expect.any(String));

    const objects = await service.loadObjects({ objectSet: { type: 'base', objectType: ENGAGEMENT }, pageSize: 1 });

    const objectToken = (objects.body as Page).nextPageToken;

    expect(objectToken).toEqual(expect.any(String));

    answers.push(first, await page(ENGAGEMENT, { pageSize: 1, pageToken: first.nextPageToken }), objects);

    const tokens = [first.nextPageToken, objectToken].map((token) =>
      Buffer.from(token ?? '', 'base64url').toString('latin1'),
    );

    const entries = await service.db.query(sql('SELECT entry FROM ontology_1_engine.edit_history'));

    expect(entries).toHaveLength(2);

    const text = JSON.stringify([answers, tokens, entries]);

    expect(versions).toHaveLength(2);

    for (const version of versions) expect(text).not.toContain(version);
  });
});

describe('an edit by a service user', () => {
  it('ontology/object-edits/edit-history#entries: an apply by a service user records its client ID, which a person and the service user read, and which Users.get names while its application exists, and for up to 60 seconds after', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const workos = stubWorkos(
      [STUB_PERSON],
      [{ user_id: PERSON, organization_id: ORGANIZATION, status: 'active', roles: ['member'] }],
      {
        roles: { [ORGANIZATION]: { member: [USE] } },
        applications: { [SERVICE_USER]: { ...STUB_APPLICATION, scopes: [USE] } },
      },
    );

    const users = workosUsers(STUB_WORKOS_KEY, { fetch: workos.fetch });
    const ontology = `/api/v2/ontologies/${ONTOLOGY_RID}`;

    const applied = await service.call(
      'POST',
      `${ontology}/actions/${SET_ENGAGEMENT_STATUS}/apply`,
      { parameters: { objectToModifyParameter: 'eng-2', status: 'won' }, options: EXECUTE_NONE },
      { service: true, users },
    );

    expect(applied.status).toBe(200);

    const operationId = (JSON.parse(applied.text) as { operationId: string }).operationId;

    const expected = {
      data: [
        {
          objectPrimaryKey: { engagementId: { type: 'stringValue', value: 'eng-2' } },
          operationId,
          actionTypeRid: SET_ENGAGEMENT_STATUS_RID,
          userId: 'client_01JSERV1CEUSER0000000000AB',
          timestamp: expect.stringMatching(UTC_TIME),
          edit: {
            type: 'modifyEdit',
            properties: { status: 'won' },
            previousProperties: { status: 'open' },
            includesAllPreviousValues: false,
          },
        },
      ],
      totalCount: 1,
    };

    const history = `${ontology}/objectTypes/${ENGAGEMENT}/editsHistory`;

    for (const reader of [{ users }, { service: true as const, users }]) {
      const read = await service.call('POST', history, { objectPrimaryKey: { engagementId: 'eng-2' } }, reader);

      expect(read.status).toBe(200);
      expect(JSON.parse(read.text)).toEqual(expected);
    }

    const named = await service.call('GET', `/api/v2/admin/users/${SERVICE_USER}`, undefined, { users });

    expect([named.status, JSON.parse(named.text)]).toEqual([
      200,
      {
        id: SERVICE_USER,
        username: SERVICE_USER,
        givenName: 'Nightly sync',
        realm: 'workos',
        status: 'ACTIVE',
        attributes: {},
      },
    ]);

    workos.setApplication(SERVICE_USER, undefined);

    expect((await service.call('GET', `/api/v2/admin/users/${SERVICE_USER}`, undefined, { users })).status).toBe(200);

    const fresh = workosUsers(STUB_WORKOS_KEY, { fetch: workos.fetch });

    expect((await service.call('GET', `/api/v2/admin/users/${SERVICE_USER}`, undefined, { users: fresh })).status).toBe(
      404,
    );

    expect(
      JSON.parse(
        (await service.call('POST', history, { objectPrimaryKey: { engagementId: 'eng-2' } }, { users })).text,
      ),
    ).toEqual(expected);
  });
});
