import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { errorAnswer, NS, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const FUNCTIONS: TestFunction[] = [
  { apiName: 'fillHeap', inputs: [{ name: 'accountId', type: 'string' }], edits: [ACCOUNT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

export const functions = {
  fillHeap: async (client, accountId) => {
    const batch = createEditBatch(client);
    batch.create(Account, { accountId, name: 'never written' });
    const kept = [];
    for (;;) kept.push(new Array(1e5).fill({ accountId }));
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

beforeEach(() => service.clear());

const FUNCTION_RID = expect.stringMatching(
  /^ri\.function-registry\.main\.function\.[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

it(
  'ontology/functions/functions#errors, ontology/functions/functions#runtime, service/testing#conformance-tests: ' +
    'a Function that runs over its heap limit gets 400 FunctionExecutionFailed, and the Action writes nothing',
  async () => {
    const answer = await service.apply(actionOf('fillHeap'), {
      parameters: { accountId: 'fn-acc-1' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: {
          functionRid: FUNCTION_RID,
          functionVersion: '1.0.0',
          message: 'The Function ran over its heap limit.',
        },
      },
    });

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
  },
);
