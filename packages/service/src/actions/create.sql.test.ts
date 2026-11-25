import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renamed, twinObjectType, unchecked } from '../ontology/stored.test-utils.ts';
import {
  account,
  countingDb,
  errorAnswer,
  newVersion,
  insertObjects,
  NO_PRIMARY_KEY,
  NS,
  parameterResult,
  rowsOf,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CREATE_ACCOUNT = `${NS}create-account`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const CREATE_ENGAGEMENT_PAIR = `${NS}create-engagement-pair`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

function engagementPair(): ActionTypeBlock {
  const block = structuredClone(twinIr('0.4.0').ontology.actionTypes[CREATE_ENGAGEMENT]);
  const validation = block?.actionType.actionTypeLogic.validation.parameterValidations['engagementId'];

  if (!block || !validation)
    throw new Error('The twin 0.4.0 IR has no create-engagement with the parameter engagementId.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = CREATE_ENGAGEMENT_PAIR;

  metadata.parameters['otherEngagementId'] = unchecked({
    id: 'otherEngagementId',
    type: { type: 'string', string: {} },
    displayMetadata: { displayName: 'Other Engagement ID', description: '', typeClasses: [] },
  });

  metadata.parameterOrdering.push('otherEngagementId');

  actionTypeLogic.validation.parameterValidations['otherEngagementId'] = structuredClone(validation);

  actionTypeLogic.logic.rules.push(
    unchecked({
      type: 'addObjectRule',
      addObjectRule: {
        objectTypeId: ENGAGEMENT,
        propertyValues: {
          engagementId: { type: 'parameterId', parameterId: 'otherEngagementId' },
          title: { type: 'parameterId', parameterId: 'title' },
        },
        structFieldValues: {},
      },
    }),
  );

  return block;
}

function testIr(): OntologyIr {
  const ir = twinIr('0.4.0');

  ir.ontology.actionTypes[CREATE_ENGAGEMENT_PAIR] = engagementPair();

  return ir;
}

const FUNCTIONS = twinFunctions('0.4.0');

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), FUNCTIONS);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ACTION_RID = new RegExp(`^ri\\.actions\\.main\\.action\\.${UUID}$`);

const ACTION_RID_V4 =
  /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CLOCK_MARGIN_MS = 5_000;

const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };

const PROBE_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'closed'),
];

const engagementRow = (
  engagementId: string,
  accountId: string | null,
  title: string,
  amount: number | null,
  status: string | null,
  createdAt: unknown,
) => ({
  engagement_id: engagementId,
  account_id: accountId,
  title,
  amount,
  status,
  created_at: typeof createdAt === 'string' ? new Date(createdAt) : createdAt,
  __version: '1',
});

const CLIENT_ENGAGEMENT_ROWS = [
  engagementRow('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won', '2026-10-17T18:20:05.687Z'),
  engagementRow('eng-2', 'acc-1', 'Ontology build', 48000, 'open', '2026-10-17T18:20:05.839Z'),
  engagementRow('eng-3', 'acc-1', 'Support retainer', 6000, 'open', '2026-10-17T18:20:05.991Z'),
  engagementRow('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
  engagementRow('eng-5', 'acc-3', 'Data audit', 9000, 'won', '2026-10-17T18:20:06.284Z'),
  engagementRow('eng-6', 'acc-3', 'Migration', 30000, 'open', '2026-10-17T18:20:06.436Z'),
];

const accountRow = (accountId: string, name: string, phase: string | null) => ({
  account_id: accountId,
  name,
  phase,
  __version: '1',
});

const PROBE_ACCOUNT_ROWS = [
  accountRow('acc-1', 'Acme', 'customer'),
  accountRow('acc-2', 'Globex', 'prospect'),
  accountRow('acc-3', 'Initech', 'closed'),
];

const engagements = () => rowsOf(service.db, ENGAGEMENT, 'engagement_id');
const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');

const OBJECT_ALREADY_EXISTS = {
  status: 409,
  body: { errorCode: 'CONFLICT', errorName: 'ObjectAlreadyExists', parameters: {} },
};

describe('a create-engagement apply', () => {
  const CLIENT_15 = {
    parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
  };

  it('ontology/action-types/rules#rule-kinds, ontology/action-types/rules#values: creates 1 Engagement, with the value of its parameter in each Property that a parameterId value maps', async () => {
    await seedClient(service.db);

    const before = new Date();

    await service.apply(CREATE_ENGAGEMENT, CLIENT_15);

    const after = new Date();

    expect(await engagements()).toEqual([
      ...CLIENT_ENGAGEMENT_ROWS,
      { ...engagementRow('eng-7', 'acc-2', 'Expansion', 22000, 'open', expect.any(Date)), __version: newVersion() },
    ]);

    const [created] = (await engagements()).filter((row) => row.engagement_id === 'eng-7');

    const createdAt = (created?.created_at as Date | undefined)?.getTime();

    expect(createdAt).toBeGreaterThanOrEqual(before.getTime() - CLOCK_MARGIN_MS);
    expect(createdAt).toBeLessThanOrEqual(after.getTime() + CLOCK_MARGIN_MS);
  });

  it('ontology/action-types/submission-criteria#contract, ontology/action-types/action-types#apply, service/http-api#rids: answers VALID with no criterion result, the RID of the Action as operationId, and the addObject edit with its counts', async () => {
    await seedClient(service.db);

    const answer = await service.apply(CREATE_ENGAGEMENT, CLIENT_15);

    expect(answer).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(ACTION_RID),
        validation: VALID,
        edits: {
          type: 'edits',
          edits: [{ type: 'addObject', primaryKey: 'eng-7', objectType: ENGAGEMENT }],
          addedObjectCount: 1,
          modifiedObjectsCount: 0,
          deletedObjectsCount: 0,
          addedLinksCount: 0,
          deletedLinksCount: 0,
        },
      },
    });
  });
});

describe('create-account applies', () => {
  const PROBE_5 = {
    parameters: { accountId: 'p-null', name: 'Probe null phase' },
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
  };

  const PROBE_6 = {
    parameters: { accountId: 'p-a', name: 'Probe phase a', phase: 'a' },
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
  };

  it('ontology/action-types/rules#values: a parameter with no value gives its mapped Property no value', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    await service.apply(CREATE_ACCOUNT, PROBE_5);

    await service.apply(CREATE_ACCOUNT, PROBE_6);

    expect(await accounts()).toEqual([
      ...PROBE_ACCOUNT_ROWS,
      { ...accountRow('p-a', 'Probe phase a', 'a'), __version: newVersion() },
      { ...accountRow('p-null', 'Probe null phase', null), __version: newVersion() },
    ]);
  });

  it('service/http-api#rids: gives each Action a new Action RID, with a random UUID version 4', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const first = await service.apply(CREATE_ACCOUNT, PROBE_5);

    const second = await service.apply(CREATE_ACCOUNT, PROBE_6);

    for (const answer of [first, second]) {
      expect(answer).toEqual({
        status: 200,
        body: { operationId: expect.stringMatching(ACTION_RID_V4), validation: VALID },
      });
    }

    const operationId = (answer: { body: unknown }) => (answer.body as { operationId: string }).operationId;

    expect(operationId(first)).not.toBe(operationId(second));
  });
});

describe('an apply that writes nothing returns no operationId', () => {
  it('ontology/action-types/action-types#apply: a VALIDATE_ONLY apply returns no operationId, and writes nothing', async () => {
    await seedClient(service.db);

    const answer = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { title: 'Validate only' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            accountId: parameterResult('VALID', false),
            amount: parameterResult('VALID', false),
            title: parameterResult('VALID', true),
            engagementId: parameterResult('VALID', false),
          },
        },
      },
    });

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });

  it('ontology/action-types/action-types#apply: an INVALID apply returns no operationId, and writes nothing', async () => {
    await insertObjects(service.db, ACCOUNT, PROBE_ACCOUNTS);

    const answer = await service.apply(CREATE_ACCOUNT, {
      parameters: { accountId: 'p-noname' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [],
          parameters: {
            phase: parameterResult('VALID', false),
            accountId: parameterResult('VALID', false),
            name: parameterResult('INVALID', true),
          },
        },
      },
    });

    expect(await accounts()).toEqual(PROBE_ACCOUNT_ROWS);
  });
});

describe('the primary key of a create', () => {
  it('ontology/action-types/action-types#parameters, service/http-api#errors: a create with no primary key value passes validation, and its apply fails with 400 ApplyActionFailed', async () => {
    await seedClient(service.db);

    const validated = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { title: 'Validate only' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(validated.status).toBe(200);

    expect(validated.body).toMatchObject({
      validation: { result: 'VALID', parameters: { engagementId: parameterResult('VALID', false) } },
    });

    const applied = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { title: 'No primary key' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(errorAnswer(applied)).toEqual(NO_PRIMARY_KEY);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });

  it('service/http-api#errors, ontology/object-link-types/object-types#parts: a create with the primary key of an existing Engagement fails with 409 ObjectAlreadyExists, and the existing Engagement keeps its values', async () => {
    await seedClient(service.db);

    const answer = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-1', title: 'Duplicate' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(errorAnswer(answer)).toEqual(OBJECT_ALREADY_EXISTS);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });
});

describe('a failed Action writes nothing', () => {
  it('ontology/action-types/action-types#apply: when the second create of an Action fails, the Action fails and writes neither Engagement', async () => {
    await seedClient(service.db);

    const exists = await service.apply(CREATE_ENGAGEMENT_PAIR, {
      parameters: { engagementId: 'eng-8', otherEngagementId: 'eng-1', title: 'Pair' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(errorAnswer(exists)).toEqual(OBJECT_ALREADY_EXISTS);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);

    const noKey = await service.apply(CREATE_ENGAGEMENT_PAIR, {
      parameters: { engagementId: 'eng-8', title: 'Pair' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(errorAnswer(noKey)).toEqual(NO_PRIMARY_KEY);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });
});

describe('the write transaction', () => {
  const PAIR = {
    parameters: { engagementId: 'eng-8', otherEngagementId: 'eng-9', title: 'Pair' },
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
  };

  it('ontology/action-types/action-types#apply: writes the 2 Engagements of 1 Action in 1 write transaction', async () => {
    await seedClient(service.db);

    const counted = countingDb(service.db, false);

    const answer = await service.apply(CREATE_ENGAGEMENT_PAIR, PAIR, { db: counted.db });

    expect(answer).toEqual({
      status: 200,
      body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID },
    });

    expect(counted.transactions()).toBe(1);

    expect(await engagements()).toEqual([
      ...CLIENT_ENGAGEMENT_ROWS,
      { ...engagementRow('eng-8', null, 'Pair', null, 'open', expect.any(Date)), __version: newVersion() },
      { ...engagementRow('eng-9', null, 'Pair', null, null, null), __version: newVersion() },
    ]);

    await service.clear();

    await seedClient(service.db);

    const failing = countingDb(service.db, true);

    const failed = await service.apply(CREATE_ENGAGEMENT_PAIR, PAIR, { db: failing.db });

    expect(errorAnswer(failed)).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(failing.transactions()).toBe(1);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });
});

describe('the writes of an Object table', () => {
  const NOTE = `${NS}Note`;

  it('service/storage#ownership: only the apply route writes an Object table: a publish creates a table with no row and keeps the rows of the others, and the apply adds the Engagement', async () => {
    await seedClient(service.db);

    const next = testIr();

    next.ontology.objectTypes[NOTE] = renamed(twinObjectType('Account'), NOTE);

    await service.publish(next, FUNCTIONS);

    expect(await rowsOf(service.db, NOTE, 'account_id')).toEqual([]);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);

    await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(await engagements()).toEqual([
      ...CLIENT_ENGAGEMENT_ROWS,
      { ...engagementRow('eng-7', 'acc-2', 'Expansion', 22000, 'open', expect.any(Date)), __version: newVersion() },
    ]);
  });
});
