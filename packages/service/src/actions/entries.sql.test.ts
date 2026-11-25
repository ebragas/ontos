import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName, type Sql } from '../db/index.ts';
import type { Db, SnapshotDb } from '../db/promise.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import { tableName } from '../ontology/index.ts';
import { asSnapshot } from '../service.test-utils.ts';
import { actionTypeRid, ridNamespace } from '../ontology/rids.ts';
import { unchecked, USE } from '../ontology/stored.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import { STUB_PERSON, stubUsers } from '../workos.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  actionType,
  addRule,
  CLIENT_ACCOUNTS,
  CLIENT_ENGAGEMENTS,
  countingDb,
  deleteRule,
  errorAnswer,
  insertObjects,
  manyToManyLink,
  modifyRule,
  NS,
  ONTOLOGY_RID,
  parameterValue,
  PERSON,
  rowsOf,
  seedClient,
  startActions,
  staticString,
  twinIr,
  type ActionsService,
  type ObjectRow,
} from './actions.test-utils.ts';
import { orThrow } from '../errors/fallible.ts';

const FUNCTIONS: readonly TestFunction[] = [
  {
    apiName: 'closeAndDelete',
    inputs: [
      { name: 'account', type: 'object', objectType: `${NS}Account` },
      { name: 'reason', type: 'string', required: false },
    ],
    edits: [`${NS}Account`, `${NS}Engagement`],
  },
  {
    apiName: 'closeAfterRead',
    inputs: [
      { name: 'account', type: 'object', objectType: `${NS}Account` },
      { name: 'reason', type: 'string', required: false },
    ],
    edits: [`${NS}Account`, `${NS}Engagement`],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Engagement = { type: 'object', apiName: '${NS}Engagement' };
const engagement = (engagementId) => ({ $apiName: '${NS}Engagement', $primaryKey: engagementId });

export const functions = {
  closeAndDelete: async (client, account) => {
    const batch = createEditBatch(client);
    batch.update(account, { phase: 'closed' });
    batch.delete(engagement('eng-4'));
    return batch.getEdits();
  },
  closeAfterRead: async (client) => {
    await client(Engagement).fetchPage();
    const batch = createEditBatch(client);
    batch.update(engagement('eng-2'), { status: 'won' });
    return batch.getEdits();
  },
};
`;

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;
const CLOSE_AND_DELETE = actionOf('closeAndDelete');
const CLOSE_AFTER_READ = actionOf('closeAfterRead');

const REPLACE_ENGAGEMENT = `${NS}replace-engagement`;
const SET_TITLE_AND_STATUS = `${NS}set-title-and-status`;
const SPONSOR_ENGAGEMENT = `${NS}sponsor-engagement`;
const SPONSOR_ACCOUNT = `${NS}sponsor-account`;
const ADD_SPONSOR = `${NS}add-sponsor`;
const STAMP_ENGAGEMENT = `${NS}stamp-engagement`;
const CLEAR_STATUS = `${NS}clear-status`;
const MOVE_ENGAGEMENT = `${NS}move-engagement`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const CURRENT_TIME = { type: 'currentTime', currentTime: {} };
const CURRENT_USER = { type: 'currentUser', currentUser: {} };

const addSponsorRule = (sourceObject: string, targetObject: string) => ({
  type: 'addLinkRule',
  addLinkRule: { linkTypeId: 'engagement-sponsors', sourceObject, targetObject },
});

interface TestParameter {
  readonly type: unknown;
  readonly allowedValues: unknown;
  readonly required: unknown;
}

const stringParameter: TestParameter = {
  type: { type: 'string', string: {} },
  allowedValues: { type: 'text', text: { type: 'text', text: {} } },
  required: { type: 'notRequired', notRequired: {} },
};

const objectParameter = (objectTypeId: string): TestParameter => ({
  type: { type: 'objectReference', objectReference: { objectTypeId } },
  allowedValues: { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
  required: { type: 'required', required: {} },
});

const historyOn = (store: string, storeAllPreviousProperties: boolean) => ({
  type: 'config',
  config: { store, storeAllPreviousProperties },
});

function testIr(history: boolean): OntologyIr {
  const ir = twinIr('0.6.3');

  if (history) {
    for (const [apiName, storeAll] of [
      [ENGAGEMENT, false],
      [ACCOUNT, true],
    ] as const) {
      const block = ir.ontology.objectTypes[apiName];

      if (!block) throw new Error(`The twin 0.6.3 IR has no ${apiName}.`);

      block.entityMetadata = unchecked({ ...block.entityMetadata, editsHistory: historyOn(apiName, storeAll) });
    }
  }

  const sponsors = manyToManyLink(
    'engagement-sponsors',
    { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
    { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
  );

  ir.ontology.linkTypes[sponsors.linkType.id] = sponsors;

  const engagement = objectParameter(ENGAGEMENT);
  const account = objectParameter(ACCOUNT);

  const blocks: ActionTypeBlock[] = [
    actionType(REPLACE_ENGAGEMENT, { engagement, old: engagement, account, engagementId: stringParameter }, [
      modifyRule('engagement', { status: staticString('closed') }),
      deleteRule('old'),
      addRule(ENGAGEMENT, {
        engagementId: parameterValue('engagementId'),
        accountId: staticString('acc-1'),
        title: staticString('Replacement'),
        createdAt: CURRENT_TIME,
      }),
      modifyRule('account', { phase: staticString('renewed') }),
    ]),
    actionType(SET_TITLE_AND_STATUS, { engagement, status: stringParameter }, [
      modifyRule('engagement', { title: staticString('Renamed') }),
      modifyRule('engagement', { status: parameterValue('status') }),
    ]),
    actionType(SPONSOR_ENGAGEMENT, { engagement, account }, [
      modifyRule('engagement', { status: staticString('sponsored') }),
      addSponsorRule('engagement', 'account'),
    ]),
    actionType(SPONSOR_ACCOUNT, { engagement, account }, [
      modifyRule('account', { phase: staticString('sponsor') }),
      addSponsorRule('engagement', 'account'),
    ]),
    actionType(ADD_SPONSOR, { engagement, account }, [addSponsorRule('engagement', 'account')]),
    actionType(STAMP_ENGAGEMENT, { engagement }, [modifyRule('engagement', { title: CURRENT_USER })]),
    actionType(CLEAR_STATUS, { engagement, status: stringParameter }, [
      modifyRule('engagement', { status: parameterValue('status') }),
    ]),
    actionType(MOVE_ENGAGEMENT, { engagement, accountId: stringParameter }, [
      modifyRule('engagement', { accountId: parameterValue('accountId') }),
    ]),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;
let historyPublished = false;

async function turnHistoryOn(): Promise<void> {
  if (historyPublished) return;

  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, testIr(true));

  await service.publish(ir, functions);

  historyPublished = true;
}

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, testIr(false));

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
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

const ACCOUNTS = CLIENT_ACCOUNTS.slice(0, 2);

const ENGAGEMENTS = CLIENT_ENGAGEMENTS.filter(({ engagementId }) =>
  ['eng-1', 'eng-2', 'eng-4'].includes(engagementId as string),
);

const NO_AMOUNT: ObjectRow = {
  engagementId: 'eng-9',
  accountId: 'acc-1',
  title: 'No amount',
  createdAt: '2026-10-17T18:20:07.123Z',
};

const NO_PHASE: ObjectRow = { accountId: 'acc-4', name: 'Hooli' };

interface HistoryRow {
  readonly object_type: string;
  readonly primary_key: string;
  readonly created_at: Date;
  readonly entry: Record<string, unknown>;
}

const historyRows = (): Promise<HistoryRow[]> =>
  service.db.query<HistoryRow>(
    sql('SELECT * FROM ontology_1_engine.edit_history ORDER BY created_at, object_type, primary_key'),
  );

const entries = async () => (await historyRows()).map((row) => row.entry);

const edits = async () => (await entries()).map((entry) => entry['edit']);

function actionTypeRidOf(apiName: string): string {
  return actionTypeRid(orThrow(ridNamespace(ONTOLOGY_RID)), apiName);
}

const SET_ENGAGEMENT_STATUS_RID = 'ri.actions.main.action-type.7c2cbf1f-5c5b-55c9-83a7-f16211226ef9';

const operationIdOf = (body: unknown): string => (body as { operationId: string }).operationId;

describe('turning history on', () => {
  it('ontology/object-edits/edit-history#turning-it-on: an Action before the publish that turns history on makes no entry, and an Action after it makes 1', async () => {
    expect(historyPublished).toBe(false);

    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const before = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'race-a' },
      options: EXECUTE_NONE,
    });

    expect(before.status).toBe(200);

    expect(await historyRows()).toEqual([]);

    await turnHistoryOn();

    expect(await historyRows()).toEqual([]);

    const after = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'race-b' },
      options: EXECUTE_NONE,
    });

    expect(after.status).toBe(200);

    expect(await entries()).toEqual([
      expect.objectContaining({
        operationId: operationIdOf(after.body),
        edit: {
          type: 'modifyEdit',
          properties: { status: 'race-b' },
          previousProperties: { status: 'race-a' },
          includesAllPreviousValues: false,
        },
      }),
    ]);
  });
});

describe('the entries of 1 Action', () => {
  beforeEach(turnHistoryOn);

  const REPLACE = {
    parameters: { engagement: 'eng-1', old: 'eng-4', account: 'acc-2', engagementId: 'eng-8' },
    options: EXECUTE_NONE,
  };

  it('1 table holds the entries of all Object Types, 1 row for each entry, with the columns object_type, primary_key, created_at, and entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const answer = await service.apply(REPLACE_ENGAGEMENT, REPLACE);

    expect(answer.status).toBe(200);

    const rows = await historyRows();

    expect(rows.map((row) => [row.object_type, row.primary_key])).toEqual(
      expect.arrayContaining([
        [ENGAGEMENT, 'eng-1'],
        [ENGAGEMENT, 'eng-4'],
        [ENGAGEMENT, 'eng-8'],
        [ACCOUNT, 'acc-2'],
      ]),
    );

    expect(rows).toHaveLength(4);

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'entry', 'object_type', 'primary_key']);
      expect(row.created_at).toBeInstanceOf(Date);

      expect(Object.keys(row.entry).sort()).toEqual([
        'actionTypeRid',
        'edit',
        'objectPrimaryKey',
        'operationId',
        'userId',
      ]);
    }

    const created = rows.find((row) => row.primary_key === 'eng-8');

    expect(created?.entry['edit']).toEqual({
      type: 'createEdit',
      properties: {
        engagementId: 'eng-8',
        accountId: 'acc-1',
        title: 'Replacement',
        createdAt: expect.stringMatching(UTC_TIME),
      },
    });
  });

  it('ontology/object-edits/edit-history#entries: each create, modify, and delete of an Object of a tracked Object Type makes 1 entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(REPLACE_ENGAGEMENT, REPLACE);

    const rows = await historyRows();

    expect(
      rows
        .map((row) => [row.object_type, row.primary_key, (row.entry['edit'] as { type: string }).type] as const)
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])),
    ).toEqual([
      [ACCOUNT, 'acc-2', 'modifyEdit'],
      [ENGAGEMENT, 'eng-1', 'modifyEdit'],
      [ENGAGEMENT, 'eng-4', 'deleteEdit'],
      [ENGAGEMENT, 'eng-8', 'createEdit'],
    ]);
  });

  it('ontology/object-edits/edit-history#entries: 2 Modify object rules on 1 Object make 1 entry, with the values of both rules', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(SET_TITLE_AND_STATUS, {
      parameters: { engagement: 'eng-2', status: 'won' },
      options: EXECUTE_NONE,
    });

    expect(await historyRows()).toEqual([expect.objectContaining({ object_type: ENGAGEMENT, primary_key: 'eng-2' })]);

    expect(await edits()).toEqual([
      {
        type: 'modifyEdit',
        properties: { title: 'Renamed', status: 'won' },
        previousProperties: { title: 'Ontology build', status: 'open' },
        includesAllPreviousValues: false,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a function-backed Action makes 1 entry for each Object edit, with the previous values of its snapshot', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const answer = await service.apply(CLOSE_AND_DELETE, {
      parameters: { account: 'acc-1', reason: 'churned' },
      options: EXECUTE_NONE,
    });

    expect(answer.status).toBe(200);

    const rows = await historyRows();

    expect(
      rows.map((row) => [row.primary_key, row.entry['operationId'], row.entry['actionTypeRid'], row.entry['edit']]),
    ).toEqual([
      [
        'acc-1',
        operationIdOf(answer.body),
        actionTypeRidOf(CLOSE_AND_DELETE),
        {
          type: 'modifyEdit',
          properties: { phase: 'closed' },
          previousProperties: { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
          includesAllPreviousValues: true,
        },
      ],
      [
        'eng-4',
        operationIdOf(answer.body),
        actionTypeRidOf(CLOSE_AND_DELETE),
        {
          type: 'deleteEdit',
          previousProperties: {
            engagementId: 'eng-4',
            accountId: 'acc-2',
            title: 'Pilot',
            amount: 15000,
            status: 'lost',
            createdAt: '2026-10-17T18:20:06.135Z',
          },
        },
      ],
    ]);
  });

  it('ontology/object-edits/edit-history#entries: an edit of an Object Type with no history makes no entry', async () => {
    const answer = await service.apply(CREATE_STRUCT_PROBE, {
      parameters: {
        probeId: 'sp-1',
        relationship: { label: 'partner', since: '2024-01-15' },
        measures: { flag: true, count: 3 },
      },
      options: EXECUTE_NONE,
    });

    expect(answer.status).toBe(200);

    expect(await rowsOf(service.db, STRUCT_PROBE, 'probe_id')).toHaveLength(1);

    expect(await historyRows()).toEqual([]);
  });

  it('ontology/object-edits/edit-history#entries, ontology/action-types/action-types#apply: an entry holds the primary key, the Action ID that the apply returned as operationId, the Action Type RID, the user ID, the time, and 1 edit', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const before = Date.now();

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'won' },
      options: EXECUTE_NONE,
    });

    const after = Date.now();

    expect(operationIdOf(answer.body)).toMatch(ACTION_RID);

    const rows = await historyRows();

    expect(rows).toEqual([
      {
        object_type: ENGAGEMENT,
        primary_key: 'eng-2',
        created_at: expect.any(Date),
        entry: {
          objectPrimaryKey: { engagementId: 'eng-2' },
          operationId: operationIdOf(answer.body),
          actionTypeRid: SET_ENGAGEMENT_STATUS_RID,
          userId: PERSON,
          edit: {
            type: 'modifyEdit',
            properties: { status: 'won' },
            previousProperties: { status: 'open' },
            includesAllPreviousValues: false,
          },
        },
      },
    ]);

    const time = rows[0]?.created_at.getTime() ?? 0;

    expect(time).toBeGreaterThanOrEqual(before - 5_000);
    expect(time).toBeLessThanOrEqual(after + 5_000);
  });

  it('ontology/object-edits/edit-history#entries, ontology/action-types/action-types#apply: the entries of 1 Action have its Action ID, and 2 Actions have 2 Action IDs', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const first = await service.apply(REPLACE_ENGAGEMENT, REPLACE);

    const second = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'won' },
      options: EXECUTE_NONE,
    });

    expect(operationIdOf(first.body)).not.toBe(operationIdOf(second.body));

    const rows = await historyRows();

    const actionOf = (row: HistoryRow) => [row.entry['operationId'], row.entry['actionTypeRid']];

    expect(rows.filter((row) => row.primary_key !== 'eng-2').map(actionOf)).toEqual(
      Array(4).fill([operationIdOf(first.body), actionTypeRidOf(REPLACE_ENGAGEMENT)]),
    );

    expect(rows.filter((row) => row.primary_key === 'eng-2').map(actionOf)).toEqual([
      [operationIdOf(second.body), SET_ENGAGEMENT_STATUS_RID],
    ]);
  });

  it('ontology/object-edits/edit-history#entries: the edit of an entry is a createEdit, a modifyEdit, or a deleteEdit', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(REPLACE_ENGAGEMENT, REPLACE);

    const kinds = (await edits()).map((edit) => (edit as { type: string }).type);

    expect(new Set(kinds)).toEqual(new Set(['createEdit', 'modifyEdit', 'deleteEdit']));
  });

  it('ontology/object-edits/edit-history#entries: a create holds the new Property values', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

    const [row] = await service.db.query<{ created_at: string }>(
      sql(
        "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-7'",
      ),
    );

    expect(await entries()).toEqual([
      expect.objectContaining({
        objectPrimaryKey: { engagementId: 'eng-7' },
        edit: {
          type: 'createEdit',
          properties: {
            engagementId: 'eng-7',
            accountId: 'acc-2',
            title: 'Expansion',
            amount: 22000,
            status: 'open',
            createdAt: row?.created_at,
          },
        },
      }),
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a create holds no key for a Property with no value', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion' },
      options: EXECUTE_NONE,
    });

    expect(await edits()).toEqual([
      {
        type: 'createEdit',
        properties: {
          engagementId: 'eng-7',
          accountId: 'acc-2',
          title: 'Expansion',
          status: 'open',
          createdAt: expect.stringMatching(UTC_TIME),
        },
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a modify holds the new values and the previous values of the changed Properties only', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
      options: EXECUTE_NONE,
    });

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-7', status: 'won' },
      options: EXECUTE_NONE,
    });

    expect((await edits())[1]).toEqual({
      type: 'modifyEdit',
      properties: { status: 'won' },
      previousProperties: { status: 'open' },
      includesAllPreviousValues: false,
    });
  });

  it('ontology/object-edits/edit-history#entries: a modify of a Property with no value holds no previous value for it', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await insertObjects(service.db, ENGAGEMENT, [NO_AMOUNT]);

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-9', status: 'open' },
      options: EXECUTE_NONE,
    });

    expect(await edits()).toEqual([
      { type: 'modifyEdit', properties: { status: 'open' }, previousProperties: {}, includesAllPreviousValues: false },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a rule that sets a Property to its current value holds it as a changed Property', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'open' },
      options: EXECUTE_NONE,
    });

    expect(await edits()).toEqual([
      {
        type: 'modifyEdit',
        properties: { status: 'open' },
        previousProperties: { status: 'open' },
        includesAllPreviousValues: false,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a modify that clears a Property holds null as its new value', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(CLEAR_STATUS, { parameters: { engagement: 'eng-1' }, options: EXECUTE_NONE });

    expect(await edits()).toEqual([
      {
        type: 'modifyEdit',
        properties: { status: null },
        previousProperties: { status: 'won' },
        includesAllPreviousValues: false,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a delete holds the previous Property values', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(DELETE_ENGAGEMENT, { parameters: { objectToDeleteParameter: 'eng-4' }, options: EXECUTE_NONE });

    expect(await entries()).toEqual([
      expect.objectContaining({
        objectPrimaryKey: { engagementId: 'eng-4' },
        edit: {
          type: 'deleteEdit',
          previousProperties: {
            engagementId: 'eng-4',
            accountId: 'acc-2',
            title: 'Pilot',
            amount: 15000,
            status: 'lost',
            createdAt: '2026-10-17T18:20:06.135Z',
          },
        },
      }),
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a delete holds no key for a Property with no value', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await insertObjects(service.db, ENGAGEMENT, [NO_AMOUNT]);

    await service.apply(DELETE_ENGAGEMENT, { parameters: { objectToDeleteParameter: 'eng-9' }, options: EXECUTE_NONE });

    expect(await edits()).toEqual([
      {
        type: 'deleteEdit',
        previousProperties: {
          engagementId: 'eng-9',
          accountId: 'acc-1',
          title: 'No amount',
          createdAt: '2026-10-17T18:20:07.123Z',
        },
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: with storeAllPreviousProperties: true, a modify holds the previous values of all Properties', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(SET_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'acc-1', phase: 'churned' },
      options: EXECUTE_NONE,
    });

    expect(await entries()).toEqual([
      expect.objectContaining({
        objectPrimaryKey: { accountId: 'acc-1' },
        edit: {
          type: 'modifyEdit',
          properties: { phase: 'churned' },
          previousProperties: { accountId: 'acc-1', name: 'Acme', phase: 'customer' },
          includesAllPreviousValues: true,
        },
      }),
    ]);
  });

  it('ontology/object-edits/edit-history#entries: with storeAllPreviousProperties: true, a Property with no previous value has no key', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await insertObjects(service.db, ACCOUNT, [NO_PHASE]);

    await service.apply(SET_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'acc-4', phase: 'prospect' },
      options: EXECUTE_NONE,
    });

    expect(await edits()).toEqual([
      {
        type: 'modifyEdit',
        properties: { phase: 'prospect' },
        previousProperties: { accountId: 'acc-4', name: 'Hooli' },
        includesAllPreviousValues: true,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: the time of each entry is the time of its insert in the write transaction, later than the current time value of a rule', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const delayed = delayedDb(service.db, 300);

    const answer = await service.apply(REPLACE_ENGAGEMENT, REPLACE, { db: delayed.db });

    expect(answer.status).toBe(200);

    const rows = await historyRows();

    const [time] = rows.map((row) => row.created_at.getTime());

    expect(rows.map((row) => row.created_at.getTime())).toEqual(Array(4).fill(time));
    expect(time).toBeGreaterThanOrEqual(delayed.writeTime()?.getTime() ?? Infinity);
    expect(time).toBeLessThanOrEqual(delayed.endTime()?.getTime() ?? -Infinity);

    const created = rows.find((row) => row.primary_key === 'eng-8')?.entry['edit'] as {
      properties: { createdAt: string };
    };

    expect(created.properties.createdAt).toMatch(UTC_TIME);
    expect(new Date(created.properties.createdAt).getTime()).toBeLessThanOrEqual((delayed.openedAt() ?? 0) - 300);
  });

  it('ontology/object-edits/edit-history#entries: an Action that waits on a lock and commits later has a later entry time, also when its transaction opened first', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const aOpened = Promise.withResolvers<undefined>();
    const bWrote = Promise.withResolvers<undefined>();

    const aDb = withTransaction(service.db, (run) =>
      service.db.transaction(async (tx) => {
        await tx.query(sql('SELECT 1'));

        aOpened.resolve(undefined);

        await bWrote.promise;

        return run(tx);
      }),
    );

    const bDb = withTransaction(service.db, (run) =>
      service.db.transaction(async (tx) => {
        const result = await run(tx);

        bWrote.resolve(undefined);

        await lockWait();

        return result;
      }),
    );

    const parameters = { engagement: 'eng-1', account: 'acc-1' };
    const a = service.apply(SPONSOR_ENGAGEMENT, { parameters, options: EXECUTE_NONE }, { db: aDb });

    await aOpened.promise;

    expect((await service.apply(SPONSOR_ACCOUNT, { parameters, options: EXECUTE_NONE }, { db: bDb })).status).toBe(200);

    expect((await a).status).toBe(200);

    const [row] = await service.db.query<{ later: boolean }>(
      sql(`SELECT a.created_at > b.created_at AS later FROM ontology_1_engine.edit_history a, ontology_1_engine.edit_history b
           WHERE a.primary_key = 'eng-1' AND b.primary_key = 'acc-1'`),
    );

    expect(row?.later).toBe(true);
  });

  it('ontology/object-edits/edit-history#entries: a Link edit makes no entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const linked = await service.apply(ADD_SPONSOR, {
      parameters: { engagement: 'eng-1', account: 'acc-2' },
      options: EXECUTE_NONE,
    });

    expect(linked.status).toBe(200);

    expect(await service.db.query(sql('SELECT * FROM ontology_1_objects.engagement_sponsors'))).toHaveLength(1);

    expect(await historyRows()).toEqual([]);

    await service.apply(SPONSOR_ENGAGEMENT, {
      parameters: { engagement: 'eng-2', account: 'acc-1' },
      options: EXECUTE_NONE,
    });

    expect(await historyRows()).toEqual([expect.objectContaining({ object_type: ENGAGEMENT, primary_key: 'eng-2' })]);

    expect(await edits()).toEqual([
      {
        type: 'modifyEdit',
        properties: { status: 'sponsored' },
        previousProperties: { status: 'open' },
        includesAllPreviousValues: false,
      },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a rule-backed Action that changes the foreign key of a one-to-many Link makes a modify of that Property, in the entry of the Object that holds the key', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const moved = await service.apply(MOVE_ENGAGEMENT, {
      parameters: { engagement: 'eng-1', accountId: 'acc-2' },
      options: EXECUTE_NONE,
    });

    expect(moved.status).toBe(200);

    expect(await historyRows()).toEqual([expect.objectContaining({ object_type: ENGAGEMENT, primary_key: 'eng-1' })]);

    expect(await edits()).toEqual([
      {
        type: 'modifyEdit',
        properties: { accountId: 'acc-2' },
        previousProperties: { accountId: 'acc-1' },
        includesAllPreviousValues: false,
      },
    ]);
  });

  it('service/authentication#user-ids: the current user value and the entry record the user ID, the sub of the token', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(
      STAMP_ENGAGEMENT,
      { parameters: { engagement: 'eng-1' }, options: EXECUTE_NONE },
      { claims: { sub: OTHER_PERSON }, users: OTHER_USERS },
    );

    const [stamped] = (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).filter(
      (row) => row['engagement_id'] === 'eng-1',
    );

    expect(stamped?.['title']).toBe(OTHER_PERSON);

    expect(await entries()).toEqual([
      expect.objectContaining({
        userId: OTHER_PERSON,
        edit: {
          type: 'modifyEdit',
          properties: { title: OTHER_PERSON },
          previousProperties: { title: 'Discovery workshop' },
          includesAllPreviousValues: false,
        },
      }),
    ]);
  });
});

describe('the write transaction of the entries', () => {
  beforeEach(turnHistoryOn);

  const REPLACE = {
    parameters: { engagement: 'eng-1', old: 'eng-4', account: 'acc-2', engagementId: 'eng-8' },
    options: EXECUTE_NONE,
  };

  it('ontology/object-edits/edit-history#entries: an Action writes its edits and its entries in 1 transaction', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const counted = countingDb(service.db, false);

    await service.apply(REPLACE_ENGAGEMENT, REPLACE, { db: counted.db });

    expect(counted.transactions()).toBe(1);

    expect(await historyRows()).toHaveLength(4);

    const xmins = await service.db.query<{ xmin: string }>(
      sql(`SELECT xmin::text AS xmin FROM ontology_1_engine.edit_history
           UNION SELECT xmin::text FROM ontology_1_objects.engagement WHERE engagement_id IN ('eng-1', 'eng-8')
           UNION SELECT xmin::text FROM ontology_1_objects.account WHERE account_id = 'acc-2'`),
    );

    expect(xmins).toHaveLength(1);
  });

  it('ontology/object-edits/edit-history#entries: a failed Action writes no entry: a create of an existing primary key after a modify', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const counted = countingDb(service.db, false);

    const failed = await service.apply(
      REPLACE_ENGAGEMENT,
      { ...REPLACE, parameters: { ...REPLACE.parameters, engagementId: 'eng-2' } },
      { db: counted.db },
    );

    expect(errorAnswer(failed)).toEqual({
      status: 409,
      body: { errorCode: 'CONFLICT', errorName: 'ObjectAlreadyExists', parameters: {} },
    });

    expect(counted.transactions()).toBe(1);

    expect(await historyRows()).toEqual([]);

    expect(
      (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => [row['engagement_id'], row['status']]),
    ).toEqual([
      ['eng-1', 'won'],
      ['eng-2', 'open'],
      ['eng-4', 'lost'],
    ]);
  });

  it('ontology/object-edits/edit-history#entries: a failed Action writes no entry: a create with no primary key, and a VALIDATE_ONLY apply writes none', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const failed = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { title: 'No primary key' },
      options: EXECUTE_NONE,
    });

    expect(failed.status).toBe(400);

    const validateOnly = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'won' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(validateOnly.status).toBe(200);

    expect(await historyRows()).toEqual([]);
  });

  it('service/storage#writes: the write transaction writes the edits and the entries, and when it does not commit, none of them commit', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const failing = countingDb(service.db, true);

    const failed = await service.apply(REPLACE_ENGAGEMENT, REPLACE, { db: failing.db });

    expect(errorAnswer(failed)).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(failing.transactions()).toBe(1);

    expect(await historyRows()).toEqual([]);

    expect(
      (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => [row['engagement_id'], row['status']]),
    ).toEqual([
      ['eng-1', 'won'],
      ['eng-2', 'open'],
      ['eng-4', 'lost'],
    ]);

    const answer = await service.apply(REPLACE_ENGAGEMENT, REPLACE);

    expect(answer.status).toBe(200);

    expect(await historyRows()).toHaveLength(4);

    expect(
      (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => [row['engagement_id'], row['status']]),
    ).toEqual([
      ['eng-1', 'closed'],
      ['eng-2', 'open'],
      ['eng-8', null],
    ]);
  });
});

describe('keeping the entries', () => {
  beforeEach(turnHistoryOn);

  it('ontology/object-edits/edit-history#keeping: an entry never changes: a later modify and a delete of its Object add entries and keep it as it is', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'won' },
      options: EXECUTE_NONE,
    });

    const first = await service.db.query(sql('SELECT xmin::text AS xmin, * FROM ontology_1_engine.edit_history'));

    expect(first).toHaveLength(1);

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-2', status: 'lost' },
      options: EXECUTE_NONE,
    });

    await service.apply(DELETE_ENGAGEMENT, { parameters: { objectToDeleteParameter: 'eng-2' }, options: EXECUTE_NONE });

    const all = await service.db.query(
      sql('SELECT xmin::text AS xmin, * FROM ontology_1_engine.edit_history ORDER BY created_at'),
    );

    expect(all).toHaveLength(3);
    expect(all[0]).toEqual(first[0]);
  });

  it('ontology/object-edits/edit-history#keeping: the history of a deleted Object stays, and a new Object with the same primary key continues it', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const create = {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
      options: EXECUTE_NONE,
    };

    await service.apply(CREATE_ENGAGEMENT, create);

    await service.apply(DELETE_ENGAGEMENT, { parameters: { objectToDeleteParameter: 'eng-7' }, options: EXECUTE_NONE });

    expect(await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).toHaveLength(3);

    expect((await edits()).map((edit) => (edit as { type: string }).type)).toEqual(['createEdit', 'deleteEdit']);

    await service.apply(CREATE_ENGAGEMENT, {
      ...create,
      parameters: { ...create.parameters, title: 'Expansion again' },
    });

    const rows = await historyRows();

    expect(rows.map((row) => [row.object_type, row.primary_key, (row.entry['edit'] as { type: string }).type])).toEqual(
      [
        [ENGAGEMENT, 'eng-7', 'createEdit'],
        [ENGAGEMENT, 'eng-7', 'deleteEdit'],
        [ENGAGEMENT, 'eng-7', 'createEdit'],
      ],
    );

    expect((rows[2]?.entry['edit'] as { properties: Record<string, unknown> } | undefined)?.properties['title']).toBe(
      'Expansion again',
    );
  });
});

describe('the time columns', () => {
  beforeEach(turnHistoryOn);

  it('service/storage#schema-and-access: each time column in the schemas of the Ontology service is timestamptz', async () => {
    const columns = await service.db.query<{ name: string; type: string }>(
      sql(`SELECT table_schema || '.' || table_name || '.' || column_name AS name, udt_name AS type FROM information_schema.columns
           WHERE table_schema IN ('ontology_registry', 'ontology_1_objects', 'ontology_1_engine') AND udt_name ~ '^_?(timestamp|timestamptz|time|timetz)$'
           ORDER BY 1`),
    );

    expect(columns).toEqual([
      { name: 'ontology_1_engine.edit_history.created_at', type: 'timestamptz' },
      { name: 'ontology_1_objects.engagement.created_at', type: 'timestamptz' },
      { name: 'ontology_registry.engine_changes.applied_at', type: 'timestamptz' },
      { name: 'ontology_registry.product_versions.published_at', type: 'timestamptz' },
    ]);
  });

  it('service/storage#schema-and-access: the Ontology service writes the current time value in UTC, also when the session time zone is another zone', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const zoned = zonedDb(service.db, 'America/Los_Angeles');

    await service.apply(
      CREATE_ENGAGEMENT,
      { parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion' }, options: EXECUTE_NONE },
      { db: zoned },
    );

    const [row] = await service.db.query<{ value: string; history: string }>(
      sql(`SELECT to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value,
                  h.entry -> 'edit' -> 'properties' ->> 'createdAt' AS history
           FROM ontology_1_objects.engagement e, ontology_1_engine.edit_history h WHERE e.engagement_id = 'eng-7' AND h.primary_key = 'eng-7'`),
    );

    expect(row?.history).toMatch(UTC_TIME);
    expect(row?.value).toBe(row?.history);
  });
});

function delayedDb(
  db: Db,
  ms: number,
): {
  readonly db: Db;
  readonly writeTime: () => Date | undefined;
  readonly endTime: () => Date | undefined;
  readonly openedAt: () => number | undefined;
} {
  let writeTime: Date | undefined;
  let endTime: Date | undefined;
  let openedAt: number | undefined;

  const wrapped = withTransaction(db, async (run) => {
    await new Promise((resolve) => setTimeout(resolve, ms));

    return db.transaction(async (tx) => {
      const [row] = await tx.query<{ now: Date }>(sql('SELECT now() AS now'));

      writeTime = row?.now;

      openedAt = Date.now();

      const result = await run(tx);

      const [end] = await tx.query<{ now: Date }>(sql('SELECT clock_timestamp() AS now'));

      endTime = end?.now;

      return result;
    });
  });

  return { db: wrapped, writeTime: () => writeTime, endTime: () => endTime, openedAt: () => openedAt };
}

function withTransaction(db: Db, transaction: Db['transaction']): Db {
  return {
    query: <Row extends object>(query: Sql) => db.query<Row>(query),
    stream: <Row extends object>(query: Sql) => db.stream<Row>(query),
    snapshot: (run) => db.snapshot(run),
    transaction,
  };
}

async function lockWait(): Promise<void> {
  const waiting = sql("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");

  while ((await service.db.query(waiting)).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
}

function zonedDb(db: Db, zone: string): Db {
  return {
    query: <Row extends object>(query: Sql) => db.query<Row>(query),
    stream: <Row extends object>(query: Sql) => db.stream<Row>(query),
    snapshot: (run) => db.snapshot(run),
    transaction: (run) =>
      db.transaction(async (tx) => {
        await tx.query(sql(`SET LOCAL TIME ZONE '${zone}'`));

        return run(tx);
      }),
  };
}

describe('an aborted request', () => {
  beforeEach(turnHistoryOn);

  const ABORTED = {
    status: 400,
    body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ActionRequestAborted', parameters: {} },
  };

  const SET_ENG_2 = { parameters: { objectToModifyParameter: 'eng-2', status: 'won' }, options: EXECUTE_NONE };

  const statuses = async () =>
    (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => [row['engagement_id'], row['status']]);

  const UNCHANGED = [
    ['eng-1', 'won'],
    ['eng-2', 'open'],
    ['eng-4', 'lost'],
  ];

  function abortingDb(client: AbortController): ReturnType<typeof countingDb> {
    const counted = countingDb(service.db, false);

    const db: Db = {
      ...counted.db,
      query: async <Row extends object>(statement: Sql) => {
        const rows = await counted.db.query<Row>(statement);

        client.abort();

        return rows;
      },
    };

    return { ...counted, db };
  }

  it('a rule-backed apply that the client aborts after the reads gets 400 ActionRequestAborted, and writes no edit and no entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const client = new AbortController();
    const aborting = abortingDb(client);

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, SET_ENG_2, { db: aborting.db, signal: client.signal });

    expect(errorAnswer(answer)).toEqual(ABORTED);
    expect(aborting.transactions()).toBe(0);

    expect(await statuses()).toEqual(UNCHANGED);

    expect(await historyRows()).toEqual([]);
  });

  it('a rule-backed apply that the client aborted before it arrived writes no edit and no entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const counted = countingDb(service.db, false);

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, SET_ENG_2, {
      db: counted.db,
      signal: AbortSignal.abort(),
    });

    expect(errorAnswer(answer)).toEqual(ABORTED);
    expect(counted.transactions()).toBe(0);

    expect(await statuses()).toEqual(UNCHANGED);

    expect(await historyRows()).toEqual([]);
  });

  it('a function-backed apply that the client aborts during the Function run gets 400 ActionRequestAborted, and writes no edit and no entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const client = new AbortController();
    const counted = countingDb(service.db, false);
    const engagements = `${quoteName('ontology_1_objects')}.${quoteName(tableName(ENGAGEMENT))}`;

    const abortAtRead = (db: SnapshotDb): SnapshotDb =>
      asSnapshot({
        ...db,
        query: <Row extends object>(statement: Sql) => {
          if (statement.text.includes(engagements)) client.abort();

          return db.query<Row>(statement);
        },
        stream: <Row extends object>(statement: Sql) => {
          if (statement.text.includes(engagements)) client.abort();

          return db.stream<Row>(statement);
        },
      });

    const db: Db = { ...counted.db, snapshot: (run) => counted.db.snapshot((tx) => run(abortAtRead(tx))) };

    const answer = await service.apply(
      CLOSE_AFTER_READ,
      { parameters: { account: 'acc-1', reason: 'churned' }, options: EXECUTE_NONE },
      { db, signal: client.signal },
    );

    expect(client.signal.aborted).toBe(true);
    expect(errorAnswer(answer)).toEqual(ABORTED);
    expect(counted.transactions()).toBe(0);

    expect(await statuses()).toEqual(UNCHANGED);

    expect(await historyRows()).toEqual([]);
  });

  it('service/storage#writes: an apply over the MCP that the client aborts after the reads gets the isError result 400 ActionRequestAborted, and writes no edit and no entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const client = new AbortController();
    const aborting = abortingDb(client);

    const answer = await service.applyOverMcp(SET_ENGAGEMENT_STATUS, SET_ENG_2.parameters, {
      db: aborting.db,
      signal: client.signal,
    });

    expect(answer.status).toBe(200);

    const { result } = answer.body as {
      result: {
        isError?: boolean;
        structuredContent: Record<string, unknown>;
        content: { type: string; text: string }[];
      };
    };

    expect(result.isError).toBe(true);

    const { errorInstanceId, ...error } = result.structuredContent;

    expect(error).toEqual(ABORTED.body);
    expect(errorInstanceId).toEqual(expect.any(String));
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    expect(aborting.transactions()).toBe(0);

    expect(await statuses()).toEqual(UNCHANGED);

    expect(await historyRows()).toEqual([]);
  });

  it('service/storage#writes: an apply over the MCP that the client aborted before it arrived writes no edit and no entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const counted = countingDb(service.db, false);

    const answer = await service.applyOverMcp(SET_ENGAGEMENT_STATUS, SET_ENG_2.parameters, {
      db: counted.db,
      signal: AbortSignal.abort(),
    });

    expect(answer.status).toBe(200);

    const { result } = answer.body as { result: { isError?: boolean; structuredContent: { errorName: string } } };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.errorName).toBe('ActionRequestAborted');
    expect(counted.transactions()).toBe(0);

    expect(await statuses()).toEqual(UNCHANGED);

    expect(await historyRows()).toEqual([]);
  });

  it('an apply with a signal that does not abort writes its edit and its entry', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, SET_ENG_2, { signal: new AbortController().signal });

    expect(answer.status).toBe(200);

    expect(await statuses()).toEqual([
      ['eng-1', 'won'],
      ['eng-2', 'won'],
      ['eng-4', 'lost'],
    ]);

    expect(await historyRows()).toHaveLength(1);
  });
});
