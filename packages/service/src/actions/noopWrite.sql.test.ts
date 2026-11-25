import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import {
  errorAnswer,
  NS,
  recordingDb,
  seedClient,
  startActions,
  type ActionsService,
  type Answer,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PAST_DEADLINE = {
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ActionDeadlineExceeded', parameters: {} },
};

const ABORTED = {
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ActionRequestAborted', parameters: {} },
};

const FUNCTIONS: TestFunction[] = [
  { apiName: 'noop', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] },
  { apiName: 'deleteMissing', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const account = (accountId) => ({ $apiName: '${ACCOUNT}', $primaryKey: accountId });

export const functions = {
  noop: async () => [],
  deleteMissing: async (client, accountId) => {
    const batch = createEditBatch(client);
    batch.delete(account(accountId));
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

afterEach(() => {
  vi.useRealTimers();
});

const answerOf = (answer: Answer) => (answer.status === 200 ? answer : errorAnswer(answer));

function writeTransactionStatements(statements: readonly string[]): string[] {
  const begin = statements.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');

  if (begin === -1) return [];

  const end = statements.indexOf('COMMIT', begin);

  return statements.slice(begin, end === -1 ? undefined : end + 1);
}

describe('a function-backed Action with 0 written edits', () => {
  it('ontology/action-types/action-types#apply: opens 0 write transactions when the Function returns 0 edits', async () => {
    const recorded = recordingDb(service.url);

    try {
      const answer = await service.apply(
        actionOf('noop'),
        { parameters: { accountId: 'acc-1' }, options: EXECUTE_ALL_V2 },
        { db: recorded.db },
      );

      expect(answerOf(answer)).toEqual({
        status: 200,
        body: {
          operationId: expect.stringMatching(ACTION_RID),
          validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
        },
      });
    } finally {
      await recorded.pool.end();
    }

    expect(writeTransactionStatements(recorded.statements)).toEqual([]);
  });

  it('ontology/functions/edit-functions#apply: opens 0 write transactions when the Function deletes only an Object not present in the snapshot', async () => {
    const recorded = recordingDb(service.url);

    try {
      const answer = await service.apply(
        actionOf('deleteMissing'),
        { parameters: { accountId: 'acc-missing' }, options: EXECUTE_ALL_V2 },
        { db: recorded.db },
      );

      expect(answerOf(answer)).toEqual({
        status: 200,
        body: {
          operationId: expect.stringMatching(ACTION_RID),
          validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
          edits: {
            type: 'edits',
            edits: [{ type: 'deleteObject', primaryKey: 'acc-missing', objectType: ACCOUNT }],
            addedObjectCount: 0,
            modifiedObjectsCount: 0,
            deletedObjectsCount: 1,
            addedLinksCount: 0,
            deletedLinksCount: 0,
          },
        },
      });
    } finally {
      await recorded.pool.end();
    }

    expect(writeTransactionStatements(recorded.statements)).toEqual([]);
  });

  it('service/storage#writes: still returns 400 ActionDeadlineExceeded when past deadline with 0 written edits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    const arrived = Date.now();

    vi.setSystemTime(arrived);

    let transactions = 0;

    const db: Db = {
      query: <Row extends object>(statement: Sql) => service.db.query<Row>(statement),
      stream: (statement) => service.db.stream(statement),
      snapshot: async (run) => {
        const result = await service.db.snapshot(run);

        vi.setSystemTime(arrived + 120_000);

        return result;
      },
      transaction: (run) => {
        transactions += 1;

        return service.db.transaction(run);
      },
    };

    const answer = await service.apply(
      actionOf('noop'),
      { parameters: { accountId: 'acc-1' }, options: EXECUTE_ALL_V2 },
      { db },
    );

    expect(answerOf(answer)).toEqual(PAST_DEADLINE);
    expect(transactions).toBe(0);
  });

  it('service/storage#writes: still returns 400 ActionRequestAborted when aborted with 0 written edits', async () => {
    const controller = new AbortController();
    let transactions = 0;

    const db: Db = {
      query: <Row extends object>(statement: Sql) => service.db.query<Row>(statement),
      stream: (statement) => service.db.stream(statement),
      snapshot: async (run) => {
        const result = await service.db.snapshot(run);

        controller.abort();

        return result;
      },
      transaction: (run) => {
        transactions += 1;

        return service.db.transaction(run);
      },
    };

    const answer = await service.apply(
      actionOf('noop'),
      { parameters: { accountId: 'acc-1' }, options: EXECUTE_ALL_V2 },
      { db, signal: controller.signal },
    );

    expect(answerOf(answer)).toEqual(ABORTED);
    expect(transactions).toBe(0);
  });
});
