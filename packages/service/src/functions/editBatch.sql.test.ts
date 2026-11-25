import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/promise.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  engagement as engagementObject,
  errorAnswer,
  insertObjects,
  NS,
  rowsOf,
  seedClient,
  startActions,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { actionOf, editsIr, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SPONSORS_API_NAME = 'engagementSponsors';

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'applyEdits',
    inputs: [
      { name: 'ops', type: 'stringList' },
      { name: 'more', type: 'stringList' },
    ],
    edits: [ACCOUNT, ENGAGEMENT],
    links: [SPONSORS_API_NAME],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const types = {
  Account: { type: { type: 'object', apiName: '${ACCOUNT}' }, key: 'accountId' },
  Engagement: { type: { type: 'object', apiName: '${ENGAGEMENT}' }, key: 'engagementId' },
};

export const functions = {
  applyEdits: async (client, ops, more) => {
    const batch = createEditBatch(client);
    for (const text of [...(ops ?? []), ...(more ?? [])]) {
      const edit = JSON.parse(text);
      const { type, key } = types[edit.type];
      const ref = { $apiName: type.apiName, $primaryKey: edit.key };
      if (edit.op === 'create') batch.create(type, { [key]: edit.key, ...edit.values });
      else if (edit.op === 'update') batch.update(ref, edit.values);
      else if (edit.op === 'delete') batch.delete(ref);
      else batch.link({ $apiName: '${ENGAGEMENT}', $primaryKey: edit.key }, 'sponsors', { $apiName: '${ACCOUNT}', $primaryKey: edit.target });
    }
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, editsIr());

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

const ACCOUNT_RULE = 'ontology/action-types/action-types';
const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Mode = 'ALL' | 'ALL_V2_WITH_DELETIONS' | 'NONE';

const op = (kind: 'create' | 'update' | 'delete', key: string, values?: object) =>
  JSON.stringify({ op: kind, type: 'Account', key, values });

const creates = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => op('create', `acc-c-${from + i}`, { name: `C ${from + i}` }));

const updates = (from: number, to: number, name = 'U') =>
  Array.from({ length: to - from + 1 }, (_, i) => op('update', `acc-u-${from + i}`, { name }));

const deletes = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => op('delete', `acc-u-${from + i}`));

function apply(
  ops: string[],
  returnEdits: Mode = 'ALL_V2_WITH_DELETIONS',
  more: string[] = [],
  mode: 'VALIDATE_AND_EXECUTE' | 'VALIDATE_ONLY' = 'VALIDATE_AND_EXECUTE',
) {
  return service.apply(actionOf('applyEdits'), { parameters: { ops, more }, options: { mode, returnEdits } });
}

async function insertAccounts(count: number): Promise<void> {
  await service.db.query(
    sql(
      "INSERT INTO ontology_1_objects.account (__version, account_id, name, phase) SELECT '1', 'acc-u-' || n, 'Old ' || n, 'prospect' FROM generate_series(1, $1::int) n",
      count,
    ),
  );
}

const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };
const NO_EDITS = { status: 200, body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID } };

describe('Fix 4: the 2 answer shapes of returnEdits', () => {
  it.each(['ALL_V2_WITH_DELETIONS', 'ALL'] as const)(
    `${ACCOUNT_RULE}#apply: an empty apply with %s gives no edits key`,
    async (mode) => {
      expect(await apply([], mode)).toEqual(NO_EDITS);
    },
  );

  it.each(['ALL_V2_WITH_DELETIONS', 'ALL'] as const)(
    `${ACCOUNT_RULE}#apply: a create and a delete of acc-new with %s give no edits key`,
    async (mode) => {
      expect(await apply([op('create', 'acc-new', { name: 'New' }), op('delete', 'acc-new')], mode)).toEqual(NO_EDITS);
    },
  );

  it(`${ACCOUNT_RULE}#apply: 1 update of acc-1 with ALL gives the edits`, async () => {
    const answer = await apply([op('update', 'acc-1', { name: 'Acme 2' })], 'ALL');

    expect(answer.body).toMatchObject({
      edits: {
        type: 'edits',
        edits: [{ type: 'modifyObject', primaryKey: 'acc-1', objectType: ACCOUNT }],
        modifiedObjectsCount: 1,
        addedObjectCount: 0,
      },
    });
  });

  it(`${ACCOUNT_RULE}#apply: 5,000 creates give the list, and 5,001 give largeScaleEdits`, async () => {
    const list = await apply(creates(1, 5000));

    expect(list.status).toBe(200);

    const edits = (list.body as { edits: { edits: unknown[]; addedObjectCount: number; type: string } }).edits;

    expect([edits.type, edits.edits.length, edits.addedObjectCount]).toEqual(['edits', 5000, 5000]);

    await service.clear();

    await seedClient(service.db);

    expect(await apply(creates(1, 5001))).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(ACTION_RID),
        validation: VALID,
        edits: { type: 'largeScaleEdits', editedObjectTypes: [ACCOUNT] },
      },
    });
  });

  it(`${ACCOUNT_RULE}#apply: 5,001 updates give largeScaleEdits`, async () => {
    await insertAccounts(5001);

    expect((await apply(updates(1, 5001))).body).toMatchObject({
      edits: { type: 'largeScaleEdits', editedObjectTypes: [ACCOUNT] },
    });
  });

  it(`${ACCOUNT_RULE}#apply: 2,500 creates and 2,501 updates give largeScaleEdits`, async () => {
    await insertAccounts(2501);

    expect((await apply([...creates(1, 2500), ...updates(1, 2501)])).body).toMatchObject({
      edits: { type: 'largeScaleEdits', editedObjectTypes: [ACCOUNT] },
    });
  });

  it(`${ACCOUNT_RULE}#apply: 10,000 updates of 5,000 Accounts give the list, as the count is of Objects`, async () => {
    await insertAccounts(5000);

    const answer = await apply(updates(1, 5000, 'First'), 'ALL_V2_WITH_DELETIONS', updates(1, 5000, 'Second'));

    const edits = (answer.body as { edits: { edits: unknown[]; modifiedObjectsCount: number; type: string } }).edits;

    expect([answer.status, edits.type, edits.edits.length, edits.modifiedObjectsCount]).toEqual([
      200,
      'edits',
      5000,
      5000,
    ]);
  });

  describe(`${ACCOUNT_RULE}#apply: each other apply keeps the full list`, () => {
    const listOf = (answer: { status: number; body: unknown }) => {
      const edits = (answer.body as { edits: { type: string; edits: unknown[] } }).edits;

      return [answer.status, edits.type, edits.edits.length];
    };

    it('5,001 creates with ALL', async () => {
      expect(listOf(await apply(creates(1, 5001), 'ALL'))).toEqual([200, 'edits', 5001]);
    });

    it('5,001 deletes of inserted Accounts with ALL_V2_WITH_DELETIONS', async () => {
      await insertAccounts(5001);

      expect(listOf(await apply(deletes(1, 5001)))).toEqual([200, 'edits', 5001]);
    });

    it('5,001 creates and 1 Link edit of eng-1 to acc-1', async () => {
      const link = JSON.stringify({ op: 'link', type: 'Engagement', key: 'eng-1', target: 'acc-1' });

      expect(listOf(await apply([...creates(1, 5001), link]))).toEqual([200, 'edits', 5002]);
    });

    it('5,000 Account creates and 1 Engagement create', async () => {
      const engagement = JSON.stringify({
        op: 'create',
        type: 'Engagement',
        key: 'eng-c-1',
        values: { accountId: 'acc-1', title: 'C 1' },
      });

      expect(listOf(await apply([...creates(1, 5000), engagement]))).toEqual([200, 'edits', 5001]);
    });
  });

  it(`${ACCOUNT_RULE}#apply: returnEdits NONE with 5,001 creates gives no edits key`, async () => {
    expect(await apply(creates(1, 5001), 'NONE')).toEqual(NO_EDITS);
  });
});

const link = (engagement: string, account: string) =>
  JSON.stringify({ op: 'link', type: 'Engagement', key: engagement, target: account });

const START_ACCOUNTS = [
  { __version: '1', account_id: 'acc-1', name: 'Acme', phase: 'customer' },
  { __version: '1', account_id: 'acc-2', name: 'Globex', phase: 'prospect' },
  { __version: '1', account_id: 'acc-3', name: 'Initech', phase: 'customer' },
];

const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');

const historyEntries = async () =>
  (
    await service.db.query<{
      primary_key: string;
      entry: { edit: { type: string; properties?: Record<string, unknown> } };
    }>(sql('SELECT primary_key, entry FROM ontology_1_engine.edit_history ORDER BY primary_key'))
  ).map((row) => [row.primary_key, row.entry.edit] as const);

const SEQUENCE = 'ontology/functions/edit-functions#apply';

const UNSUPPORTED_SEQUENCE = {
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'ApplyActionFailed',
    parameters: {
      originalErrorName: 'Ontos:UnsupportedEditSequence',
      userErrorMessage: 'The Action could not apply because of an unsupported edit sequence.',
      builderErrorMessage:
        'The Action produced more than one conflicting edit for the same Object. Change the Action rules or Function to emit a single edit sequence per Object.',
    },
  },
};

describe('an unsupported sequence of edits of 1 Object', () => {
  it(`${SEQUENCE}, service/http-api#errors: 2 creates of 1 key get 400 ApplyActionFailed, and write nothing`, async () => {
    const pair = [op('create', 'acc-new', { name: 'New' }), op('create', 'acc-new', { name: 'Again' })];

    expect(errorAnswer(await apply(pair))).toEqual(UNSUPPORTED_SEQUENCE);

    expect(await accounts()).toEqual(START_ACCOUNTS);

    expect(await historyEntries()).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: 2 creates of 1 key with VALIDATE_ONLY get the same 400', async () => {
    const pair = [op('create', 'acc-new', { name: 'New' }), op('create', 'acc-new', { name: 'Again' })];

    expect(errorAnswer(await apply(pair, 'NONE', [], 'VALIDATE_ONLY'))).toEqual(UNSUPPORTED_SEQUENCE);

    expect(await accounts()).toEqual(START_ACCOUNTS);
  });

  it.each([
    ['a delete, then an update', [op('delete', 'acc-1'), op('update', 'acc-1', { name: 'Late' })]],
    ['a delete, then a create', [op('delete', 'acc-1'), op('create', 'acc-1', { name: 'Late' })]],
    ['an update, then a create', [op('update', 'acc-1', { name: 'Early' }), op('create', 'acc-1', { name: 'Late' })]],
  ])(`${SEQUENCE}: %s of acc-1 gets the same body, and acc-1 keeps its values and its entries`, async (_name, ops) => {
    const before = await historyEntries();

    expect(errorAnswer(await apply(ops))).toEqual(UNSUPPORTED_SEQUENCE);

    expect(await accounts()).toEqual(START_ACCOUNTS);

    expect(await historyEntries()).toEqual(before);
  });

  it('ontology/functions/edit-functions#apply: a delete and a delete, and a create, a delete, and an update, keep 400 FunctionExecutionFailed', async () => {
    const refused = (message: string) => ({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: {
          functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
          functionVersion: '1.0.0',
          message,
        },
      },
    });

    expect(errorAnswer(await apply([op('delete', 'acc-1'), op('delete', 'acc-1')]))).toEqual(
      refused(`The Function edits ${ACCOUNT} acc-1 after it deletes it.`),
    );

    const createDeleteUpdate = [
      op('create', 'acc-new'),
      op('delete', 'acc-new'),
      op('update', 'acc-new', { name: 'Late' }),
    ];

    expect(errorAnswer(await apply(createDeleteUpdate))).toEqual(
      refused(`The Function edits ${ACCOUNT} acc-new after it deletes it.`),
    );

    expect(await accounts()).toEqual(START_ACCOUNTS);
  });

  it('ontology/functions/edit-functions#apply: a Link edit after the delete of an existing Object keeps 400 ApplyActionFailed with parameters {}, and writes nothing', async () => {
    const answer = await apply([op('delete', 'acc-1'), link('eng-1', 'acc-1')]);

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ApplyActionFailed', parameters: {} },
    });

    expect(await accounts()).toEqual(START_ACCOUNTS);

    expect(await historyEntries()).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: a Link edit of an Object that the run created and then deleted keeps 400 FunctionExecutionFailed, and writes nothing', async () => {
    const answer = await apply([op('create', 'acc-new'), op('delete', 'acc-new'), link('eng-1', 'acc-new')]);

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: {
          functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
          functionVersion: '1.0.0',
          message: `The Function edits ${ACCOUNT} acc-new after it deletes it.`,
        },
      },
    });

    expect(await accounts()).toEqual(START_ACCOUNTS);
  });
});

describe('the allowed sequences of edits of 1 Object', () => {
  const ALLOWED = 'ontology/functions/edit-functions#apply';
  const answerEdits = (answer: { body: unknown }) => (answer.body as { edits?: { edits: unknown[] } }).edits?.edits;

  it(`${ALLOWED}: 2 updates of acc-1 give 1 modifyObject edit, with the second values`, async () => {
    const answer = await apply([
      op('update', 'acc-1', { name: 'First', phase: 'x' }),
      op('update', 'acc-1', { name: 'Second' }),
    ]);

    expect(answer.status).toBe(200);
    expect(answerEdits(answer)).toEqual([{ type: 'modifyObject', primaryKey: 'acc-1', objectType: ACCOUNT }]);

    expect(await historyEntries()).toEqual([
      [
        'acc-1',
        expect.objectContaining({
          type: 'modifyEdit',
          properties: { name: 'Second', phase: 'x' },
          previousProperties: { name: 'Acme', phase: 'customer' },
        }),
      ],
    ]);
  });

  it(`${ALLOWED}: a create, then an update, of acc-new give 1 addObject edit with the update values`, async () => {
    const answer = await apply([
      op('create', 'acc-new', { name: 'New' }),
      op('update', 'acc-new', { name: 'Updated' }),
    ]);

    expect(answer.status).toBe(200);
    expect(answerEdits(answer)).toEqual([{ type: 'addObject', primaryKey: 'acc-new', objectType: ACCOUNT }]);

    expect(await historyEntries()).toEqual([
      [
        'acc-new',
        expect.objectContaining({ type: 'createEdit', properties: expect.objectContaining({ name: 'Updated' }) }),
      ],
    ]);
  });

  it(`${ALLOWED}: an update, then a delete, of acc-1 give 1 deleteObject edit, and the Object is gone`, async () => {
    const answer = await apply([op('update', 'acc-1', { name: 'Early' }), op('delete', 'acc-1')]);

    expect(answer.status).toBe(200);
    expect(answerEdits(answer)).toEqual([{ type: 'deleteObject', primaryKey: 'acc-1', objectType: ACCOUNT }]);

    expect((await accounts()).map((row) => row.account_id)).toEqual(['acc-2', 'acc-3']);

    expect(await historyEntries()).toEqual([['acc-1', expect.objectContaining({ type: 'deleteEdit' })]]);
  });

  it(`${ALLOWED}: a create, then a delete, of acc-new leave no Object and no entry`, async () => {
    const answer = await apply([op('create', 'acc-new', { name: 'New' }), op('delete', 'acc-new')]);

    expect(answer).toEqual(NO_EDITS);

    expect(await accounts()).toEqual(START_ACCOUNTS);

    expect(await historyEntries()).toEqual([]);
  });

  it(`${ALLOWED}: each refused sequence on 2 different Objects is allowed, because the refusal is for 1 Object`, async () => {
    const answer = await apply([
      op('create', 'acc-n1', { name: 'N1' }),
      op('create', 'acc-n2', { name: 'N2' }),
      op('delete', 'acc-3'),
      op('update', 'acc-1', { name: 'U' }),
      op('create', 'acc-n3', { name: 'N3' }),
      op('delete', 'acc-2'),
      op('create', 'acc-n4', { name: 'N4' }),
    ]);

    expect(answer.status).toBe(200);

    const kinds = (answerEdits(answer) as { type: string; primaryKey: string }[]).map((e) => [e.type, e.primaryKey]);

    expect(kinds).toEqual([
      ['addObject', 'acc-n1'],
      ['addObject', 'acc-n2'],
      ['deleteObject', 'acc-3'],
      ['modifyObject', 'acc-1'],
      ['addObject', 'acc-n3'],
      ['deleteObject', 'acc-2'],
      ['addObject', 'acc-n4'],
    ]);
  });
});

const APPLY_EDITS = actionOf('applyEdits');
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

const deleteEngagement = (key: string) => JSON.stringify({ op: 'delete', type: 'Engagement', key });

function applyWith(
  parameters: { ops?: readonly string[]; more?: readonly string[] },
  options: object = EXECUTE,
  db?: Db,
) {
  return service.apply(APPLY_EDITS, { parameters, options }, db ? { db } : {});
}

const engagementRows = (...keys: string[]) =>
  service.db.query(
    sql(
      'SELECT engagement_id, account_id, title, __version FROM ontology_1_objects.engagement WHERE engagement_id = ANY($1) ORDER BY engagement_id',
      keys,
    ),
  );

const engagementEntries = async () =>
  (
    await service.db.query<{ primary_key: string; entry: { edit: { type: string } } }>(
      sql(
        'SELECT primary_key, entry FROM ontology_1_engine.edit_history WHERE object_type = $1 ORDER BY primary_key',
        ENGAGEMENT,
      ),
    )
  ).map((row) => [row.primary_key, row.entry.edit.type]);

const deleted = (...keys: string[]) => ({
  status: 200,
  body: {
    operationId: expect.stringMatching(ACTION_RID),
    validation: VALID,
    edits: {
      type: 'edits',
      edits: keys.map((primaryKey) => ({ type: 'deleteObject', primaryKey, objectType: ENGAGEMENT })),
      addedObjectCount: 0,
      modifiedObjectsCount: 0,
      deletedObjectsCount: keys.length,
      addedLinksCount: 0,
      deletedLinksCount: 0,
    },
  },
});

const RACED = engagementObject('eng-absent', 'acc-1', 'Created by another Action', 1000, 'open', null);

const RACED_ROW = [
  { engagement_id: 'eng-absent', account_id: 'acc-1', title: 'Created by another Action', __version: '1' },
];

function racingDb(after: 'snapshot' | 'read'): Db {
  const insert = () => insertObjects(service.db, ENGAGEMENT, [RACED]);
  let snapshotted = false;

  return {
    query: async <Row extends object>(statement: Parameters<Db['query']>[0]) => {
      const rows = await service.db.query<Row>(statement);

      if (after === 'read' && snapshotted) {
        snapshotted = false;

        await insert();
      }

      return rows;
    },
    stream: (statement) => service.db.stream(statement),
    snapshot: async (run) => {
      const result = await service.db.snapshot(run);

      snapshotted = true;

      if (after === 'snapshot') await insert();

      return result;
    },
    transaction: (run) => service.db.transaction(run),
  };
}

describe('a delete of an Object that the snapshot of the run did not see', () => {
  it('ontology/functions/edit-functions#apply: a delete of an absent Engagement gives 200, lists and counts the delete, and writes no row and no entry', async () => {
    expect(await applyWith({ ops: [deleteEngagement('eng-absent')] })).toEqual(deleted('eng-absent'));

    expect(await engagementRows('eng-absent')).toEqual([]);

    expect(await engagementEntries()).toEqual([]);

    expect(await service.editsHistory(ENGAGEMENT, { objectPrimaryKey: { engagementId: 'eng-absent' } })).toEqual({
      status: 200,
      body: { data: [], totalCount: 0 },
    });
  });

  it('ontology/functions/edit-functions#apply: the same delete in VALIDATE_ONLY gives VALID, with no operationId', async () => {
    const parameter = { evaluatedConstraints: [{ type: 'arraySize' }], required: false, result: 'VALID' };

    expect(
      await applyWith({ ops: [deleteEngagement('eng-absent')] }, { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' }),
    ).toEqual({
      status: 200,
      body: { validation: { ...VALID, parameters: { ops: parameter, more: parameter } } },
    });
  });

  it('ontology/functions/edit-functions#apply: with ALL the delete counts and is not listed, and with NONE the answer has no edits', async () => {
    const all = await applyWith(
      { ops: [deleteEngagement('eng-absent')] },
      { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL' },
    );

    expect(all).toMatchObject({ status: 200, body: { edits: { type: 'edits', edits: [], deletedObjectsCount: 1 } } });

    const none = await applyWith(
      { ops: [deleteEngagement('eng-absent')] },
      { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    );

    expect(none).toEqual({ status: 200, body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID } });
  });

  it('ontology/functions/edit-functions#apply: deletes of eng-1 and eng-absent count 2, delete eng-1 with 1 entry, and make no entry for eng-absent', async () => {
    expect(await applyWith({ ops: [deleteEngagement('eng-1'), deleteEngagement('eng-absent')] })).toEqual(
      deleted('eng-1', 'eng-absent'),
    );

    expect(await engagementRows('eng-1', 'eng-absent')).toEqual([]);

    expect(await engagementEntries()).toEqual([['eng-1', 'deleteEdit']]);
  });

  it('ontology/functions/edit-functions#apply: an insert of the key after the snapshot and before the read after the run gets 409 ObjectChanged, and the Object stays', async () => {
    expect(
      errorAnswer(await applyWith({ ops: [deleteEngagement('eng-absent')] }, EXECUTE, racingDb('snapshot'))),
    ).toEqual({
      status: 409,
      body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} },
    });

    expect(await engagementRows('eng-absent')).toEqual(RACED_ROW);

    expect(await engagementEntries()).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: an insert of the key after the read after the run and before the write gives 200 with the delete, and the Object stays', async () => {
    expect(await applyWith({ ops: [deleteEngagement('eng-absent')] }, EXECUTE, racingDb('read'))).toEqual(
      deleted('eng-absent'),
    );

    expect(await engagementRows('eng-absent')).toEqual(RACED_ROW);

    expect(await engagementEntries()).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: 5,001 deletes in ops and 5,000 in more of absent Engagements get 400 OntologyEditsExceededLimit', async () => {
    const ops = Array.from({ length: 5001 }, (_, i) => deleteEngagement(`eng-x-${i + 1}`));
    const more = Array.from({ length: 5000 }, (_, i) => deleteEngagement(`eng-y-${i + 1}`));

    expect(errorAnswer(await applyWith({ ops, more }))).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'OntologyEditsExceededLimit',
        parameters: { editsCount: 10001, editsLimit: 10000 },
      },
    });
  });
});
