import type { OntologyIr } from '@osdk/client.unstable';
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WRITE_VERSION, type Sql } from './index.ts';
import type { Db } from './promise.test-utils.ts';
import type { RouteKey } from '../spans/index.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import {
  account,
  actionType,
  addRule,
  CLIENT_ACCOUNTS,
  CLIENT_ENGAGEMENTS,
  ENG_7,
  engagement,
  errorAnswer,
  newVersion,
  insertObjects,
  modifyRule,
  NS,
  parameterResult,
  parameterValue,
  rowsOf,
  seedClient,
  startActions,
  staticString,
  twinFunctions,
  twinIr,
  racingDb,
  type ActionsService,
} from '../actions/actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const COPY_ACCOUNT_PHASE = `${NS}copy-account-phase`;

const COPY_OWN_TITLE = `${NS}copy-own-title`;
const SET_PHASE_AND_STATUS = `${NS}set-phase-and-status`;
const SET_STATUS_WITH_ACCOUNT = `${NS}set-status-with-account`;
const SET_STATUS_AND_CREATE = `${NS}set-status-and-create`;
const SET_TITLE_AND_STATUS = `${NS}set-title-and-status`;
const SET_STATUS_IF_OPEN = `${NS}set-status-if-open`;
const SET_STATUS_IF_PROSPECT = `${NS}set-status-if-prospect`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const objectProperty = (parameterId: string, propertyTypeId: string) => ({
  type: 'objectParameterPropertyValue',
  objectParameterPropertyValue: { parameterId, propertyTypeId },
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

function withCriterion(
  block: ActionTypeBlock,
  parameterId: string,
  property: string,
  value: string,
  failureMessage: string,
): ActionTypeBlock {
  const condition = {
    type: 'comparison',
    comparison: { operator: 'EQUALS', left: objectProperty(parameterId, property), right: staticString(value) },
  };

  block.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = {
    '0': unchecked({ condition, displayMetadata: { failureMessage, typeClasses: [] } }),
  };

  return block;
}

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');
  const engagement = objectParameter(ENGAGEMENT);
  const account = objectParameter(ACCOUNT);

  const blocks: ActionTypeBlock[] = [
    actionType(COPY_OWN_TITLE, { engagement }, [
      modifyRule('engagement', { status: objectProperty('engagement', 'title') }),
    ]),
    actionType(SET_PHASE_AND_STATUS, { account, engagement, phase: stringParameter, status: stringParameter }, [
      modifyRule('account', { phase: parameterValue('phase') }),
      modifyRule('engagement', { status: parameterValue('status') }),
    ]),
    actionType(SET_STATUS_WITH_ACCOUNT, { engagement, account, status: stringParameter }, [
      modifyRule('engagement', { status: parameterValue('status') }),
    ]),
    actionType(SET_STATUS_AND_CREATE, { engagement, status: stringParameter, engagementId: stringParameter }, [
      modifyRule('engagement', { status: parameterValue('status') }),
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: staticString('Created') }),
    ]),
    actionType(SET_TITLE_AND_STATUS, { engagement, status: stringParameter }, [
      modifyRule('engagement', { title: staticString('Set twice') }),
      modifyRule('engagement', { status: parameterValue('status') }),
    ]),
    withCriterion(
      actionType(SET_STATUS_IF_OPEN, { engagement, status: stringParameter }, [
        modifyRule('engagement', { status: parameterValue('status') }),
      ]),
      'engagement',
      'status',
      'open',
      'The Engagement must be open.',
    ),
    withCriterion(
      actionType(SET_STATUS_IF_PROSPECT, { engagement, account, status: stringParameter }, [
        modifyRule('engagement', { status: parameterValue('status') }),
      ]),
      'account',
      'phase',
      'prospect',
      'The Account must be a prospect.',
    ),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const APPLIED = { status: 200, body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID } };
const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

const OBJECT_NOT_FOUND = {
  status: 404,
  body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
};

const ACCOUNTS = CLIENT_ACCOUNTS.slice(0, 2);
const ENGAGEMENTS = [...CLIENT_ENGAGEMENTS.filter(({ engagementId }) => engagementId === 'eng-2'), ENG_7];

const engagementRow = (
  engagementId: string,
  accountId: string | null,
  title: string | null,
  amount: number | null,
  status: string | null,
  createdAt: string | null,
  version: string,
) => ({
  engagement_id: engagementId,
  account_id: accountId,
  title,
  amount,
  status,
  created_at: createdAt === null ? null : new Date(createdAt),
  __version: version,
});

const ENG_2_ROW = engagementRow('eng-2', 'acc-1', 'Ontology build', 48000, 'open', '2026-10-17T18:20:05.839Z', '1');

const eng7Row = (title: string, status: string, version: string) =>
  engagementRow('eng-7', 'acc-2', title, 22000, status, '2026-10-17T18:20:08.937Z', version);

const accountRow = (accountId: string, name: string, phase: string | null, version: string) => ({
  account_id: accountId,
  name,
  phase,
  __version: version,
});

const engagements = () => rowsOf(service.db, ENGAGEMENT, 'engagement_id');
const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');

const changeEngagement = (engagementId: string, assignment: string) =>
  sql(
    `UPDATE ontology_1_objects.engagement SET ${assignment}, __version = __version + 1 WHERE engagement_id = $1`,
    engagementId,
  );

const changeAccount = (accountId: string, assignment: string) =>
  sql(
    `UPDATE ontology_1_objects.account SET ${assignment}, __version = __version + 1 WHERE account_id = $1`,
    accountId,
  );

const deleteEngagement = (engagementId: string) =>
  sql('DELETE FROM ontology_1_objects.engagement WHERE engagement_id = $1', engagementId);

const REPEAT_SCHEMA = 'repeating_transaction_id';

async function repeatingTransactionId(): Promise<Db> {
  await service.db.query(sql(`CREATE SCHEMA IF NOT EXISTS ${REPEAT_SCHEMA}`));

  await service.db.query(
    sql(
      `CREATE OR REPLACE FUNCTION ${REPEAT_SCHEMA}.pg_current_xact_id() RETURNS xid8 LANGUAGE sql AS $$ SELECT '1000'::xid8 $$`,
    ),
  );

  return {
    ...service.db,
    transaction: (run) =>
      service.db.transaction(async (tx) => {
        await tx.query(sql(`SET LOCAL search_path = ${REPEAT_SCHEMA}, pg_catalog, public`));

        return run(tx);
      }),
  };
}

const ATTEMPTS = 5;

describe('the reads and the write transaction', () => {
  it('service/storage#writes: a rule-backed Action opens no snapshot, and opens its 1 write transaction after its reads', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, sql('SELECT 1'), 0);

    const answer = await service.apply(
      COPY_OWN_TITLE,
      { parameters: { engagement: 'eng-7' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.calls).not.toContain('snapshot');
    expect(raced.calls.filter((call) => call === 'transaction')).toEqual(['transaction']);
    expect(raced.calls.at(-1)).toBe('transaction');
    expect(raced.calls).toContain('query');

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'Expansion', newVersion('1'))]);
  });
});

describe('the version check', () => {
  it('service/storage#writes: a change between the load and the write fails the check, and the Action runs again with the changed Object', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "title = 'Renamed'"), 1);

    const answer = await service.apply(
      COPY_OWN_TITLE,
      { parameters: { engagement: 'eng-7' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(2);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Renamed', 'Renamed', newVersion('1', '2'))]);
  });

  it('service/storage#writes: the check covers each Object that the Action writes, also the second of 2', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', 'amount = 1'), 1);

    const answer = await service.apply(
      SET_PHASE_AND_STATUS,
      {
        parameters: { account: 'acc-2', engagement: 'eng-7', phase: 'customer', status: 'won' },
        options: EXECUTE_NONE,
      },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(2);

    expect(await engagements()).toEqual([
      ENG_2_ROW,
      engagementRow('eng-7', 'acc-2', 'Expansion', 1, 'won', '2026-10-17T18:20:08.937Z', newVersion('1', '2')),
    ]);

    expect(await accounts()).toEqual([
      accountRow('acc-1', 'Acme', 'customer', '1'),
      accountRow('acc-2', 'Globex', 'customer', newVersion('1')),
    ]);
  });

  it('service/storage#writes: a change to a Property that the Action does not write fails the check', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', 'amount = 1'), 1);

    const answer = await service.apply(
      SET_ENGAGEMENT_STATUS,
      { parameters: { objectToModifyParameter: 'eng-7', status: 'won' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(2);

    expect(await engagements()).toEqual([
      ENG_2_ROW,
      engagementRow('eng-7', 'acc-2', 'Expansion', 1, 'won', '2026-10-17T18:20:08.937Z', newVersion('1', '2')),
    ]);
  });

  it('service/storage#writes: a delete of the Object fails the check, and the modify that runs again gets 404 ObjectNotFound', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      engagement('p-e-c5-o0-1', 'p-c5-o0-1', 'Probe c5-o0-1', 1, 'open', null),
    ]);

    const raced = racingDb(service.db, deleteEngagement('p-e-c5-o0-1'), 1);

    const answer = await service.apply(
      SET_ENGAGEMENT_STATUS,
      { parameters: { objectToModifyParameter: 'p-e-c5-o0-1', status: 'race-modify' }, options: EXECUTE_ALL_V2 },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_NOT_FOUND);
    expect(raced.transactions()).toBe(1);
    expect(raced.calls.at(-1)).toBe('query');

    expect(await engagements()).toEqual([]);
  });

  it('service/storage#writes: the check covers the Object that a rule deletes, and a delete that runs again deletes the modified Object', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      engagement('p-e-c5-o-50-3', 'p-c5-o-50-3', 'Probe c5-o-50-3', 1, 'open', null),
    ]);

    const raced = racingDb(service.db, changeEngagement('p-e-c5-o-50-3', "status = 'race-modify'"), 1);

    const answer = await service.apply(
      DELETE_ENGAGEMENT,
      { parameters: { objectToDeleteParameter: 'p-e-c5-o-50-3' }, options: EXECUTE_ALL_V2 },
      { db: raced.db },
    );

    expect(answer).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(ACTION_RID),
        validation: VALID,
        edits: {
          type: 'edits',
          edits: [{ type: 'deleteObject', primaryKey: 'p-e-c5-o-50-3', objectType: ENGAGEMENT }],
          addedObjectCount: 0,
          modifiedObjectsCount: 0,
          deletedObjectsCount: 1,
          addedLinksCount: 0,
          deletedLinksCount: 0,
        },
      },
    });

    expect(raced.transactions()).toBe(2);

    expect(await engagements()).toEqual([]);
  });

  it('service/storage#writes: a delete whose Object changes before each attempt gets 409 ObjectChanged, and the Object stays', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      engagement('p-e-c5-o0-1', 'p-c5-o0-1', 'Probe c5-o0-1', 1, 'open', null),
    ]);

    const raced = racingDb(service.db, changeEngagement('p-e-c5-o0-1', "status = 'race-modify'"), Infinity);

    const answer = await service.apply(
      DELETE_ENGAGEMENT,
      { parameters: { objectToDeleteParameter: 'p-e-c5-o0-1' }, options: EXECUTE_ALL_V2 },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(ATTEMPTS);

    expect(await engagements()).toEqual([
      engagementRow('p-e-c5-o0-1', 'p-c5-o0-1', 'Probe c5-o0-1', 1, 'race-modify', null, String(1 + ATTEMPTS)),
    ]);
  });
});

describe('the Objects that the check does not cover', () => {
  it('service/storage#writes: a copy does not check the source Object of the copied Property, and writes the phase that it loaded (trial c6-o0-1)', async () => {
    await insertObjects(service.db, ACCOUNT, [account('p-c6-o0-1', 'Probe c6-o0-1', 'customer')]);

    await insertObjects(service.db, ENGAGEMENT, [
      engagement('p-e-c6-o0-1', 'p-c6-o0-1', 'Probe c6-o0-1', 1, 'open', '2026-10-17T20:30:52.042Z'),
    ]);

    const raced = racingDb(service.db, changeAccount('p-c6-o0-1', "phase = 'phase-new'"), Infinity);

    const answer = await service.apply(
      COPY_ACCOUNT_PHASE,
      { parameters: { objectToModifyParameter: 'p-e-c6-o0-1', account: 'p-c6-o0-1' }, options: EXECUTE_ALL_V2 },
      { db: raced.db },
    );

    expect(answer).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(ACTION_RID),
        validation: VALID,
        edits: {
          type: 'edits',
          edits: [{ type: 'modifyObject', primaryKey: 'p-e-c6-o0-1', objectType: ENGAGEMENT }],
          addedObjectCount: 0,
          modifiedObjectsCount: 1,
          deletedObjectsCount: 0,
          addedLinksCount: 0,
          deletedLinksCount: 0,
        },
      },
    });

    expect(raced.transactions()).toBe(1);

    expect(await engagements()).toEqual([
      engagementRow(
        'p-e-c6-o0-1',
        'p-c6-o0-1',
        'Probe c6-o0-1',
        1,
        'customer',
        '2026-10-17T20:30:52.042Z',
        newVersion('1'),
      ),
    ]);

    expect(await accounts()).toEqual([accountRow('p-c6-o0-1', 'Probe c6-o0-1', 'phase-new', '2')]);
  });

  it('service/storage#writes: an Object parameter that nothing reads is not checked', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeAccount('acc-2', "phase = 'customer'"), Infinity);

    const answer = await service.apply(
      SET_STATUS_WITH_ACCOUNT,
      { parameters: { engagement: 'eng-7', account: 'acc-2', status: 'won' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(1);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'won', newVersion('1'))]);

    expect(await accounts()).toEqual([
      accountRow('acc-1', 'Acme', 'customer', '1'),
      accountRow('acc-2', 'Globex', 'customer', '2'),
    ]);
  });
});

function recreatingDb(times: number, status = 'open'): { readonly db: Db; readonly transactions: () => number } {
  let transactions = 0;

  const recreate = async () => {
    expect(
      await service.apply(DELETE_ENGAGEMENT, {
        parameters: { objectToDeleteParameter: 'eng-7' },
        options: EXECUTE_NONE,
      }),
    ).toEqual(APPLIED);

    const created = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
      options: EXECUTE_NONE,
    });

    expect(created).toEqual(APPLIED);

    if (status !== 'open')
      await service.db.query(
        sql('UPDATE ontology_1_objects.engagement SET status = $1 WHERE engagement_id = $2', status, 'eng-7'),
      );
  };

  const db: Db = {
    query: <Row extends object>(statement: Sql) => service.db.query<Row>(statement),
    stream: <Row extends object>(statement: Sql) => service.db.stream<Row>(statement),
    snapshot: (run) => service.db.snapshot(run),
    transaction: async (run) => {
      transactions += 1;

      if (transactions <= times) await recreate();

      return service.db.transaction(run);
    },
  };

  return { db, transactions: () => transactions };
}

async function eng7(): Promise<{ readonly version: unknown; readonly row: Record<string, unknown> }> {
  const [row] = (await engagements()).filter(({ engagement_id }) => engagement_id === 'eng-7');

  const { __version: version, ...rest } = row ?? {};

  return { version, row: rest };
}

describe('a delete and a create of the same primary key', () => {
  const SET_WON = { parameters: { engagement: 'eng-7', status: 'won' }, options: EXECUTE_NONE };

  it('service/storage#writes: the Object that a create makes again fails the check of an Action that loaded the deleted Object, in each attempt', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = recreatingDb(Infinity);

    const answer = await service.apply(SET_STATUS_IF_OPEN, SET_WON, { db: raced.db });

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(ATTEMPTS);

    expect((await eng7()).row.status).toBe('open');
  });

  it('service/storage#writes: when the new Object has other Property values, the attempt that runs again checks the criteria against it, and fails them', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = recreatingDb(1, 'lost');

    const answer = await service.apply(SET_STATUS_IF_OPEN, SET_WON, { db: raced.db });

    expect(answer).toMatchObject({ status: 200, body: { validation: { result: 'INVALID' } } });
    expect(raced.transactions()).toBe(1);

    expect((await eng7()).row.status).toBe('lost');
  });

  it('service/storage#writes: after a second delete and create, the edit saves only on the Object that the third attempt loaded and checked', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = recreatingDb(2);

    const answer = await service.apply(SET_STATUS_IF_OPEN, SET_WON, { db: raced.db });

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(3);

    expect((await eng7()).row.status).toBe('won');
  });
});

describe('the submission criteria on each attempt', () => {
  it('service/storage#writes: the attempt that runs again checks the criteria against the changed Object, and fails them', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'lost'"), 1);

    const answer = await service.apply(
      SET_STATUS_IF_OPEN,
      { parameters: { engagement: 'eng-7', status: 'won' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [{ configuredFailureMessage: 'The Engagement must be open.', result: 'INVALID' }],
          parameters: {
            engagement: parameterResult('VALID', true, [{ type: 'objectQueryResult' }]),
            status: parameterResult('VALID', false),
          },
        },
      },
    });

    expect(raced.transactions()).toBe(1);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'lost', '2')]);
  });

  it('service/observability#traces: a rule-backed VALIDATE_ONLY apply holds no apply.object_edits', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-7', status: 'won' },
      options: { mode: 'VALIDATE_ONLY' },
    });

    expect(answer).toMatchObject({ status: 200, body: { validation: { result: 'VALID' } } });

    const counts = (await routeSpans())
      .filter((span) => span.name === 'apply attempt')
      .map((span) => span.attributes['apply.object_edits']);

    expect(counts).toEqual([undefined]);
  });

  it('service/observability#traces: the attempt that reaches the write holds apply.object_edits, and the INVALID attempt after it has none', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'lost'"), 1);

    const answer = await service.apply(
      SET_STATUS_IF_OPEN,
      { parameters: { engagement: 'eng-7', status: 'won' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toMatchObject({ status: 200, body: { validation: { result: 'INVALID' } } });

    const attempts = (await routeSpans())
      .filter((span) => span.name === 'apply attempt')
      .map((span) => ({
        attempt: span.attributes['apply.attempt'],
        objectEdits: span.attributes['apply.object_edits'],
      }));

    expect(attempts).toEqual([
      { attempt: 1, objectEdits: 1 },
      { attempt: 2, objectEdits: undefined },
    ]);
  });

  it('service/storage#writes: an Object parameter that only the criteria read is not checked', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeAccount('acc-2', "name = 'Globex 2'"), Infinity);

    const answer = await service.apply(
      SET_STATUS_IF_PROSPECT,
      { parameters: { engagement: 'eng-7', account: 'acc-2', status: 'won' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(1);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'won', newVersion('1'))]);

    expect(await accounts()).toEqual([
      accountRow('acc-1', 'Acme', 'customer', '1'),
      accountRow('acc-2', 'Globex 2', 'prospect', '2'),
    ]);
  });
});

describe('the 5 attempts', () => {
  it('service/storage#writes: a failed attempt writes nothing, so the attempt that runs again creates its Engagement 1 time', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "title = 'Renamed'"), 1);

    const answer = await service.apply(
      SET_STATUS_AND_CREATE,
      { parameters: { engagement: 'eng-7', status: 'won', engagementId: 'eng-8' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(2);

    expect(await engagements()).toEqual([
      ENG_2_ROW,
      eng7Row('Renamed', 'won', newVersion('1', '2')),
      engagementRow('eng-8', null, 'Created', null, null, null, newVersion()),
    ]);
  });

  it('service/storage#writes, service/http-api#errors: when each of the 5 attempts fails the check, the Action gets 409 ObjectChanged and writes nothing', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'race-a'"), Infinity);

    const answer = await service.apply(
      SET_STATUS_AND_CREATE,
      { parameters: { engagement: 'eng-7', status: 'race-b', engagementId: 'eng-8' }, options: EXECUTE_ALL_V2 },
      { db: raced.db },
    );

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(ATTEMPTS);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'race-a', String(1 + ATTEMPTS))]);
  });

  it('service/storage#writes: when only the last of the 5 attempts passes the check, the Action applies', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'race-a'"), ATTEMPTS - 1);

    const answer = await service.apply(
      SET_ENGAGEMENT_STATUS,
      { parameters: { objectToModifyParameter: 'eng-7', status: 'race-b' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(ATTEMPTS);

    expect(await engagements()).toEqual([
      ENG_2_ROW,
      eng7Row('Expansion', 'race-b', newVersion('1', '2', '3', '4', '5')),
    ]);
  });

  it('service/observability#traces: a rule-backed apply with 5 attempts gives 5 apply attempt spans, numbered 1 to 5, the first 4 with error.type', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'race-a'"), ATTEMPTS - 1);

    const answer = await service.apply(
      SET_ENGAGEMENT_STATUS,
      { parameters: { objectToModifyParameter: 'eng-7', status: 'race-b' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);

    const spans = await routeSpans();

    const route: RouteKey = 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply';
    const root = spans.find((span) => span.name === route);

    expect(root).toBeDefined();
    expect(root?.attributes['action.api_name']).toBe(SET_ENGAGEMENT_STATUS);

    const attempts = spans
      .filter((span) => span.name === 'apply attempt')
      .map((span) => ({
        parent: span.parentSpanId,
        attempt: span.attributes['apply.attempt'],
        errorType: span.attributes['error.type'],
        status: span.status.code,
      }));

    const failed = { parent: root?.spanId, errorType: 'ObjectChanged', status: SpanStatusCode.ERROR };

    expect(attempts).toEqual([
      { ...failed, attempt: 1 },
      { ...failed, attempt: 2 },
      { ...failed, attempt: 3 },
      { ...failed, attempt: 4 },
      { parent: root?.spanId, attempt: 5, errorType: undefined, status: SpanStatusCode.UNSET },
    ]);
  });

  it('service/observability#traces: each of the 5 attempts of a rule-backed apply that modifies 1 Object and creates 1 holds apply.object_edits 2', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'race-a'"), ATTEMPTS - 1);

    const answer = await service.apply(
      SET_STATUS_AND_CREATE,
      { parameters: { engagement: 'eng-7', status: 'race-b', engagementId: 'eng-8' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);

    const counts = (await routeSpans())
      .filter((span) => span.name === 'apply attempt')
      .map((span) => span.attributes['apply.object_edits']);

    expect(counts).toEqual([2, 2, 2, 2, 2]);
  });

  it('service/storage#writes: a retry of a modify whose value comes from a parameter writes the same edit, and the last Action to commit wins', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const raced = racingDb(service.db, changeEngagement('eng-7', "status = 'race-a'"), 1);

    const answer = await service.apply(
      SET_ENGAGEMENT_STATUS,
      { parameters: { objectToModifyParameter: 'eng-7', status: 'race-b' }, options: EXECUTE_NONE },
      { db: raced.db },
    );

    expect(answer).toEqual(APPLIED);
    expect(raced.transactions()).toBe(2);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'race-b', newVersion('1', '2'))]);
  });

  it('service/storage#writes: 3 concurrent modifies of eng-2 all apply, and eng-2 has the status of 1 of them', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const statuses = ['race-a', 'race-b', 'race-c'];

    const answers = await Promise.all(
      statuses.map((status) =>
        service.apply(SET_ENGAGEMENT_STATUS, {
          parameters: { objectToModifyParameter: 'eng-2', status },
          options: EXECUTE_NONE,
        }),
      ),
    );

    expect(answers).toEqual([APPLIED, APPLIED, APPLIED]);

    const [eng2] = await engagements();

    expect(eng2).toEqual({ ...ENG_2_ROW, status: expect.stringMatching(/^race-[abc]$/), __version: newVersion('1') });
  });
});

describe('the version of an edited Object', () => {
  it('service/storage#writes: a write gives each Object that it edits a new version, and keeps the version of each other Object', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    expect(
      await service.apply(SET_PHASE_AND_STATUS, {
        parameters: { account: 'acc-2', engagement: 'eng-7', phase: 'customer', status: 'won' },
        options: EXECUTE_NONE,
      }),
    ).toEqual(APPLIED);

    expect(await accounts()).toEqual([
      accountRow('acc-1', 'Acme', 'customer', '1'),
      accountRow('acc-2', 'Globex', 'customer', newVersion('1')),
    ]);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'won', newVersion('1'))]);

    const written = (await eng7()).version as string;

    expect(
      await service.apply(SET_TITLE_AND_STATUS, {
        parameters: { engagement: 'eng-7', status: 'lost' },
        options: EXECUTE_NONE,
      }),
    ).toEqual(APPLIED);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Set twice', 'lost', newVersion('1', written))]);
  });

  it('service/storage#writes: an Object whose version is a counter from before the rule gets a version that it never had, from a modify and from a delete and a create', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    await service.db.query(sql("UPDATE ontology_1_objects.engagement SET __version = 3 WHERE engagement_id = 'eng-7'"));

    const counter = ['1', '2', '3'];

    expect(
      await service.apply(SET_STATUS_IF_OPEN, {
        parameters: { engagement: 'eng-7', status: 'open' },
        options: EXECUTE_NONE,
      }),
    ).toEqual(APPLIED);

    const modified = (await eng7()).version as string;

    expect(modified).toEqual(newVersion(...counter));

    expect(
      await service.apply(DELETE_ENGAGEMENT, {
        parameters: { objectToDeleteParameter: 'eng-7' },
        options: EXECUTE_NONE,
      }),
    ).toEqual(APPLIED);

    const created = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-7', accountId: 'acc-2', title: 'Expansion', amount: 22000 },
      options: EXECUTE_NONE,
    });

    expect(created).toEqual(APPLIED);

    expect((await eng7()).version).toEqual(newVersion(...counter, modified));
  });

  it('service/storage#writes: a version is random over the non-negative bigint range: 1000 versions differ, and the highest is at least 2^62', async () => {
    const rows = await service.db.query<{ version: string }>(
      sql(`SELECT ${WRITE_VERSION} AS version FROM generate_series(1, 1000)`),
    );

    const versions = rows.map(({ version }) => BigInt(version));

    expect(new Set(versions).size).toBe(1000);
    expect(versions.every((version) => version >= 0n)).toBe(true);
    expect(versions.some((version) => version >= 2n ** 62n)).toBe(true);
  });

  it('service/storage#writes: 2 writes of 1 Object with the same transaction ID give 2 versions, each a non-negative bigint', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const repeating = await repeatingTransactionId();

    const versions: unknown[] = [];

    for (const status of ['won', 'lost']) {
      expect(
        await service.apply(
          SET_ENGAGEMENT_STATUS,
          { parameters: { objectToModifyParameter: 'eng-7', status }, options: EXECUTE_NONE },
          { db: repeating },
        ),
      ).toEqual(APPLIED);

      versions.push((await eng7()).version);
    }

    expect(versions).toEqual([newVersion('1'), newVersion('1', versions[0] as string)]);
  });

  it('service/storage#writes: a write after the transaction ID counter moved back does not repeat the version of the Object, so the check of an Action that loaded that version fails with 409 ObjectChanged', async () => {
    await seedClient(service.db, ACCOUNTS, ENGAGEMENTS);

    const repeating = await repeatingTransactionId();

    const set = (status: string, db: Db) =>
      service.apply(
        SET_ENGAGEMENT_STATUS,
        { parameters: { objectToModifyParameter: 'eng-7', status }, options: EXECUTE_NONE },
        { db },
      );

    expect(await set('race-a', repeating)).toEqual(APPLIED);

    const raced = racingDb(service.db, () => set('race-c', repeating), Infinity);

    const answer = await set('race-b', raced.db);

    expect(answer).toMatchObject({ status: 409 });
    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(raced.transactions()).toBe(ATTEMPTS);

    expect(await engagements()).toEqual([ENG_2_ROW, eng7Row('Expansion', 'race-c', newVersion('1'))]);
  });
});
