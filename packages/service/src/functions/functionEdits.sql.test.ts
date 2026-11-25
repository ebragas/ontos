import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Edit } from '../actions/index.ts';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { ScriptedFunctions, withFunctions, type ScriptedAnswer } from './functions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  errorAnswer,
  insertObjects,
  newVersion,
  NS,
  rowsOf,
  startActions,
  twinIr,
  type ActionsService,
  type ObjectRow,
} from '../actions/actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const PROBE_VERSION_CHECK = `${NS}probe-version-check-action`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;

let service: ActionsService;
let scripted: ScriptedFunctions;

beforeAll(async () => {
  scripted = new ScriptedFunctions(
    twinIr('0.6.3'),
    `closeAccount: (client, account) => answer(client, { args: [account.$primaryKey] }),
  probeVersionCheck: async (client, account, engagementId, mode) => {
    const Engagement = { type: 'object', apiName: '${ENGAGEMENT}' };
    const readStatus = async () => (await client(Engagement).where({ engagementId }).fetchPage()).data[0]?.status;
    const read = mode === 'read-only' || mode === 'read-edit' ? await readStatus() : mode === 'param-unedited' ? account.phase : undefined;
    return answer(client, { args: [account.$primaryKey, engagementId, mode], read });
  },`,
  );

  const { ir, functions } = await withFunctions([], scripted.source);

  service = await startActions(ir, functions);
});

afterAll(() => {
  scripted?.close();

  return service?.stop();
});

beforeEach(async () => {
  scripted.reset();

  await service.clear();
});

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

function applied(edits: readonly { type: string; primaryKey: string; objectType: string }[]) {
  const count = (type: string) => edits.filter((edit) => edit.type === type).length;

  return {
    status: 200,
    body: {
      operationId: expect.stringMatching(ACTION_RID),
      validation: VALID,
      edits: {
        type: 'edits',
        edits,
        addedObjectCount: count('addObject'),
        modifiedObjectsCount: count('modifyObject'),
        deletedObjectsCount: count('deleteObject'),
        addedLinksCount: 0,
        deletedLinksCount: 0,
      },
    },
  };
}

const TRIALS = {
  'c1-fn-3': '2026-10-17T20:29:40.661Z',
  'c2-fn-1': '2026-10-17T20:29:40.982Z',
  'c3-fn-1': '2026-10-17T20:29:41.901Z',
  'c4-fn-1': '2026-10-17T20:29:42.761Z',
} as const;

type Trial = keyof typeof TRIALS;

const accountId = (trial: Trial) => `p-${trial}`;
const engagementId = (trial: Trial) => `p-e-${trial}`;

async function seedTrial(trial: Trial): Promise<void> {
  const account: ObjectRow = { accountId: accountId(trial), name: `Probe ${trial}`, phase: 'customer' };

  const engagement: ObjectRow = {
    engagementId: engagementId(trial),
    accountId: accountId(trial),
    title: `Probe ${trial}`,
    amount: 1,
    status: 'open',
    createdAt: TRIALS[trial],
  };

  await insertObjects(service.db, ACCOUNT, [account]);

  await insertObjects(service.db, ENGAGEMENT, [engagement]);
}

const accountRow = (trial: Trial, phase: string, version: string) => ({
  account_id: accountId(trial),
  name: `Probe ${trial}`,
  phase,
  __version: version,
});

const engagementRow = (trial: Trial, status: string, version: string) => ({
  engagement_id: engagementId(trial),
  account_id: accountId(trial),
  title: `Probe ${trial}`,
  amount: 1,
  status,
  created_at: new Date(TRIALS[trial]),
  __version: version,
});

const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');
const engagements = () => rowsOf(service.db, ENGAGEMENT, 'engagement_id');

const changeEngagement = (trial: Trial) =>
  sql(
    "UPDATE ontology_1_objects.engagement SET status = 'race-modify', __version = __version + 1 WHERE engagement_id = $1",
    engagementId(trial),
  );

const changeAccount = (trial: Trial) =>
  sql(
    "UPDATE ontology_1_objects.account SET phase = 'race-phase', __version = __version + 1 WHERE account_id = $1",
    accountId(trial),
  );

const CHANGE_NO_ROW = sql('SELECT 1');

const locator = (objectType: string, primaryKey: string) => ({ objectType, primaryKey });

const modify = (objectType: string, primaryKey: string, properties: Record<string, string>): Edit => ({
  type: 'modifyObject',
  object: locator(objectType, primaryKey),
  properties: new Map(Object.entries(properties)),
});

function probeVersionCheck(change: Sql): ScriptedAnswer {
  return async ({ args, read }) => {
    const [account, engagement, mode] = args;

    await service.db.query(change);

    switch (mode) {
      case 'read-only':
        return [modify(ACCOUNT, String(account), { phase: `read: ${String(read)}` })];
      case 'param-unedited':
        return [modify(ENGAGEMENT, String(engagement), { status: `param: ${String(read)}` })];
      case 'blind-edit':
        return [modify(ENGAGEMENT, String(engagement), { status: 'blind' })];
      case 'read-edit':
        return [modify(ENGAGEMENT, String(engagement), { status: `read-edit: ${String(read)}` })];
      default:
        throw new Error('The test gave an unknown mode.');
    }
  };
}

const probeRequest = (trial: Trial, mode: string) => ({
  parameters: { account: accountId(trial), engagementId: engagementId(trial), mode, delayMs: 2500 },
  options: EXECUTE_ALL_V2,
});

type Call = 'query' | 'stream' | 'transaction' | 'snapshot';

function recordingDb(): { readonly db: Db; readonly calls: Call[] } {
  const calls: Call[] = [];

  const db: Db = {
    query: (statement) => {
      calls.push('query');

      return service.db.query(statement);
    },
    stream: (statement) => {
      calls.push('stream');

      return service.db.stream(statement);
    },
    transaction: (run) => {
      calls.push('transaction');

      return service.db.transaction(run);
    },
    snapshot: (run) => {
      calls.push('snapshot');

      return service.db.snapshot(run);
    },
  };

  return { db, calls };
}

describe('the Objects that the version check covers', () => {
  it('ontology/functions/edit-functions#version-check: a blind edit of an Object that changed during the run gets 409 ObjectChanged, also when the Function never read it', async () => {
    await seedTrial('c3-fn-1');

    scripted.once(probeVersionCheck(changeEngagement('c3-fn-1')));

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c3-fn-1', 'blind-edit'));

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);

    expect(await accounts()).toEqual([accountRow('c3-fn-1', 'customer', '1')]);

    expect(await engagements()).toEqual([engagementRow('c3-fn-1', 'race-modify', '2')]);
  });

  it('ontology/functions/edit-functions#version-check: an edit of an Object that the Function read, and that changed during the run, gets 409 ObjectChanged', async () => {
    await seedTrial('c4-fn-1');

    scripted.once(probeVersionCheck(changeEngagement('c4-fn-1')));

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c4-fn-1', 'read-edit'));

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);

    expect(await accounts()).toEqual([accountRow('c4-fn-1', 'customer', '1')]);

    expect(await engagements()).toEqual([engagementRow('c4-fn-1', 'race-modify', '2')]);
  });

  it('ontology/functions/edit-functions#version-check: the check covers an Object that the Function deletes', async () => {
    await seedTrial('c3-fn-1');

    scripted.once(async () => {
      await service.db.query(changeEngagement('c3-fn-1'));

      return [{ type: 'deleteObject', object: locator(ENGAGEMENT, engagementId('c3-fn-1')) }];
    });

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c3-fn-1', 'blind-edit'));

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);

    expect(await engagements()).toEqual([engagementRow('c3-fn-1', 'race-modify', '2')]);
  });

  it('ontology/functions/edit-functions#version-check: when the Objects did not change during the run, the Function edits apply and give each edited Object a new version', async () => {
    await seedTrial('c4-fn-1');

    scripted.once(probeVersionCheck(CHANGE_NO_ROW));

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c4-fn-1', 'read-edit'));

    expect(answer).toEqual(
      applied([{ type: 'modifyObject', primaryKey: engagementId('c4-fn-1'), objectType: ENGAGEMENT }]),
    );

    expect(await engagements()).toEqual([engagementRow('c4-fn-1', 'read-edit: open', newVersion('1'))]);
  });
});

describe('the Objects that the version check does not cover', () => {
  it('ontology/functions/edit-functions#version-check: an Object that the Function only reads is not checked, and both writes apply', async () => {
    await seedTrial('c1-fn-3');

    scripted.once(probeVersionCheck(changeEngagement('c1-fn-3')));

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c1-fn-3', 'read-only'));

    expect(answer).toEqual(applied([{ type: 'modifyObject', primaryKey: accountId('c1-fn-3'), objectType: ACCOUNT }]));

    expect(await accounts()).toEqual([accountRow('c1-fn-3', 'read: open', newVersion('1'))]);

    expect(await engagements()).toEqual([engagementRow('c1-fn-3', 'race-modify', '2')]);
  });

  it('ontology/functions/edit-functions#version-check: an Object parameter that the Function does not edit is not checked, also when the Function copies its value into an edit', async () => {
    await seedTrial('c2-fn-1');

    scripted.once(probeVersionCheck(changeAccount('c2-fn-1')));

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c2-fn-1', 'param-unedited'));

    expect(answer).toEqual(
      applied([{ type: 'modifyObject', primaryKey: engagementId('c2-fn-1'), objectType: ENGAGEMENT }]),
    );

    expect(await accounts()).toEqual([accountRow('c2-fn-1', 'race-phase', '2')]);

    expect(await engagements()).toEqual([engagementRow('c2-fn-1', 'param: customer', newVersion('1'))]);
  });
});

describe('a failed version check', () => {
  it('ontology/functions/edit-functions#version-check: when 1 checked version changed, the Action writes none of its edits', async () => {
    await seedTrial('c4-fn-1');

    scripted.once(async () => {
      await service.db.query(changeEngagement('c4-fn-1'));

      return [
        modify(ACCOUNT, accountId('c4-fn-1'), { phase: 'edited' }),
        modify(ENGAGEMENT, engagementId('c4-fn-1'), { status: 'edited' }),
        { type: 'addObject', object: locator(ACCOUNT, 'p-new'), properties: new Map([['name', 'New']]) },
      ];
    });

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c4-fn-1', 'read-edit'));

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);

    expect(await accounts()).toEqual([accountRow('c4-fn-1', 'customer', '1')]);

    expect(await engagements()).toEqual([engagementRow('c4-fn-1', 'race-modify', '2')]);
  });

  it('service/storage#writes, ontology/functions/edit-functions#version-check: the Function runs 1 time in 1 snapshot, and the Action does not run again after a failed check', async () => {
    await seedTrial('c4-fn-1');

    scripted.always(probeVersionCheck(changeEngagement('c4-fn-1')));

    const recorded = recordingDb();

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c4-fn-1', 'read-edit'), { db: recorded.db });

    expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);
    expect(scripted.runs).toBe(1);
    expect(recorded.calls.filter((call) => call !== 'query')).toEqual(['snapshot', 'transaction']);

    expect(await engagements()).toEqual([engagementRow('c4-fn-1', 'race-modify', '2')]);
  });
});

describe('the 1 Edit type and the 1 writer', () => {
  it('service/code-layout#seams: a Function modify of a primary key that does not exist gets 404 ObjectNotFound, as a rule modify does', async () => {
    await seedTrial('c4-fn-1');

    scripted.once(() => [modify(ENGAGEMENT, 'p-e-missing', { status: 'edited' })]);

    const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c4-fn-1', 'blind-edit'));

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
    });

    expect(await accounts()).toEqual([accountRow('c4-fn-1', 'customer', '1')]);

    expect(await engagements()).toEqual([engagementRow('c4-fn-1', 'open', '1')]);
  });

  it('ontology/functions/edit-functions#version-check: a Function modify or delete of an Object that another Action created during the run gets 409 ObjectChanged', async () => {
    const created: ObjectRow = {
      engagementId: 'p-e-new',
      accountId: accountId('c4-fn-1'),
      title: 'Created during the run',
      amount: 1,
      status: 'open',
    };

    for (const edit of [
      modify(ENGAGEMENT, 'p-e-new', { status: 'edited' }),
      { type: 'deleteObject', object: locator(ENGAGEMENT, 'p-e-new') } as const,
    ]) {
      await service.clear();

      await seedTrial('c4-fn-1');

      scripted.once(async () => {
        await insertObjects(service.db, ENGAGEMENT, [created]);

        return [edit];
      });

      const answer = await service.apply(PROBE_VERSION_CHECK, probeRequest('c4-fn-1', 'blind-edit'));

      expect(errorAnswer(answer)).toEqual(OBJECT_CHANGED);

      expect((await engagements()).map((row) => [row['engagement_id'], row['status'], row['__version']])).toEqual([
        ['p-e-c4-fn-1', 'open', '1'],
        ['p-e-new', 'open', '1'],
      ]);
    }
  });

  it('service/code-layout#seams: the writer writes a Function modify as it writes the same rule modify', async () => {
    await seedTrial('c1-fn-3');

    await seedTrial('c2-fn-1');

    const rule = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: engagementId('c1-fn-3'), status: 'won' },
      options: EXECUTE_ALL_V2,
    });

    scripted.once(() => [modify(ENGAGEMENT, engagementId('c2-fn-1'), { status: 'won' })]);

    const fn = await service.apply(PROBE_VERSION_CHECK, probeRequest('c2-fn-1', 'blind-edit'));

    expect(rule).toEqual(
      applied([{ type: 'modifyObject', primaryKey: engagementId('c1-fn-3'), objectType: ENGAGEMENT }]),
    );

    expect(fn).toEqual(
      applied([{ type: 'modifyObject', primaryKey: engagementId('c2-fn-1'), objectType: ENGAGEMENT }]),
    );

    expect(await engagements()).toEqual([
      engagementRow('c1-fn-3', 'won', newVersion('1')),
      engagementRow('c2-fn-1', 'won', newVersion('1')),
    ]);
  });

  it('service/code-layout#seams: the writer writes each Object edit kind of a Function, and the answer lists each edit', async () => {
    await seedTrial('c1-fn-3');

    await seedTrial('c2-fn-1');

    scripted.once(() => [
      {
        type: 'addObject',
        object: locator(ACCOUNT, 'p-new'),
        properties: new Map([
          ['name', 'New'],
          ['phase', 'prospect'],
        ]),
      },
      modify(ACCOUNT, accountId('c1-fn-3'), { phase: 'closed' }),
      { type: 'deleteObject', object: locator(ENGAGEMENT, engagementId('c2-fn-1')) },
    ]);

    const answer = await service.apply(CLOSE_ACCOUNT_ACTION, {
      parameters: { account: accountId('c1-fn-3') },
      options: EXECUTE_ALL_V2,
    });

    const listed = [
      { type: 'addObject', primaryKey: 'p-new', objectType: ACCOUNT },
      { type: 'modifyObject', primaryKey: accountId('c1-fn-3'), objectType: ACCOUNT },
      { type: 'deleteObject', primaryKey: engagementId('c2-fn-1'), objectType: ENGAGEMENT },
    ];

    const expected = applied(listed);

    expect(answer).toEqual({
      ...expected,
      body: { ...expected.body, edits: { ...expected.body.edits, edits: expect.arrayContaining(listed) } },
    });

    expect((answer.body as { edits: { edits: unknown[] } }).edits.edits).toHaveLength(listed.length);

    expect(await accounts()).toEqual([
      accountRow('c1-fn-3', 'closed', newVersion('1')),
      accountRow('c2-fn-1', 'customer', '1'),
      { account_id: 'p-new', name: 'New', phase: 'prospect', __version: newVersion() },
    ]);

    expect(await engagements()).toEqual([engagementRow('c1-fn-3', 'open', '1')]);
  });
});
