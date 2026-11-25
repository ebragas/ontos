import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { errorAnswer, NS, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const accountInput = [{ name: 'accountId', type: 'string' as const }];

const FUNCTIONS: TestFunction[] = [
  'throwError',
  'throwUserFacing',
  'throwNamedUserFacing',
  'refuseNamed',
  'refuseUnknown',
  'refuseNonString',
  'failNamed',
  'throwString',
  'throwObject',
  'callFetch',
  'throwInTimer',
  'throwAfterReturn',
  'createAccount',
  'waitAndCreate',
].map((apiName) => ({
  apiName,
  inputs: accountInput,
  edits: [ACCOUNT],
}));

const SOURCE = `
import { createEditBatch, UserFacingError } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
function edits(client, accountId) {
  const batch = createEditBatch(client);
  batch.create(Account, { accountId, name: 'never written' });
  return batch.getEdits();
}

export const functions = {
  throwError: async (client, accountId) => { edits(client, accountId); throw new Error('test plain error'); },
  throwUserFacing: async (client, accountId) => { edits(client, accountId); throw new UserFacingError('test user-facing error'); },
  // Not the class of @osdk/functions: only its name says that it is a UserFacingError.
  throwNamedUserFacing: async (client, accountId) => {
    edits(client, accountId);
    const error = new Error('named user-facing error');
    error.name = 'UserFacingError';
    throw error;
  },
  // The 3 refusals and the plain Error set parameterId, to check the Functions "Errors" rule.
  refuseNamed: async (client, accountId) => { edits(client, accountId); throw Object.assign(new UserFacingError('accountId must match'), { parameterId: 'accountId' }); },
  refuseUnknown: async (client, accountId) => { edits(client, accountId); throw Object.assign(new UserFacingError('accountId must match'), { parameterId: 'acountId' }); },
  refuseNonString: async (client, accountId) => { edits(client, accountId); throw Object.assign(new UserFacingError('accountId must match'), { parameterId: ['accountId'] }); },
  failNamed: async (client, accountId) => { edits(client, accountId); throw Object.assign(new Error('test parameter plain error'), { parameterId: 'accountId' }); },
  throwString: async (client, accountId) => { edits(client, accountId); throw 'a thrown string'; },
  throwObject: async (client, accountId) => { edits(client, accountId); throw { code: 7 }; },
  callFetch: async (client, accountId) => { await fetch('https://example.com/'); return edits(client, accountId); },
  // A throw outside the call stack of the Function, before it returns.
  throwInTimer: async (client, accountId) => {
    setTimeout(() => { throw new Error('a throw in a timer'); }, 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return edits(client, accountId);
  },
  // A throw after the Function returned, while the worker is idle.
  throwAfterReturn: async (client, accountId) => {
    setTimeout(() => { throw new Error('a throw after the return'); }, 50);
    return [];
  },
  createAccount: async (client, accountId) => edits(client, accountId),
  waitAndCreate: async (client, accountId) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return edits(client, accountId);
  },
};
`;

let service: ActionsService;
let log: MockInstance<typeof console.log>;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  log = vi.spyOn(console, 'log');
});

afterEach(() => log.mockRestore());

function apply(apiName: string) {
  return service.apply(actionOf(apiName), {
    parameters: { accountId: 'fn-acc-1' },
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
  });
}

const THROW_ERROR_RID = 'ri.function-registry.main.function.83b3e286-0305-5ac2-a7e4-858816749f85';

const FUNCTION_RID =
  /^ri\.function-registry\.main\.function\.[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function functionError(errorName: string, message: string) {
  return {
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName,
      parameters: { functionRid: expect.stringMatching(FUNCTION_RID), functionVersion: '1.0.0', message },
    },
  };
}

function logLineOf(answer: { body: unknown }): Record<string, unknown> | undefined {
  const { errorInstanceId } = answer.body as { errorInstanceId: string };

  return log.mock.calls
    .map(([line]) =>
      typeof line === 'string' && line.startsWith('{') ? (JSON.parse(line) as Record<string, unknown>) : undefined,
    )
    .find((line) => line?.['errorInstanceId'] === errorInstanceId);
}

describe('a Function that throws', () => {
  it(
    'ontology/functions/functions#errors, service/http-api#rids, ontology/functions/functions#runtime: ' +
      'a thrown Error gets 400 FunctionExecutionFailed with the Function RID and the version 1.0.0, and writes nothing',
    async () => {
      const answer = await apply('throwError');

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'FunctionExecutionFailed',
          parameters: { functionRid: THROW_ERROR_RID, functionVersion: '1.0.0', message: 'test plain error' },
        },
      });

      expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
    },
  );

  it('ontology/functions/functions#errors: a UserFacingError, found by its name, gets 400 FunctionEncounteredUserFacingError', async () => {
    expect(errorAnswer(await apply('throwUserFacing'))).toEqual(
      functionError('FunctionEncounteredUserFacingError', 'test user-facing error'),
    );

    expect(errorAnswer(await apply('throwNamedUserFacing'))).toEqual(
      functionError('FunctionEncounteredUserFacingError', 'named user-facing error'),
    );

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
  });

  it('ontology/functions/functions#errors, service/http-api#errors: a UserFacingError with the parameterId of an Action parameter gets it in parameters, and writes nothing', async () => {
    const refused = functionError('FunctionEncounteredUserFacingError', 'accountId must match');

    expect(errorAnswer(await apply('refuseNamed'))).toEqual({
      ...refused,
      body: { ...refused.body, parameters: { ...refused.body.parameters, parameterId: 'accountId' } },
    });

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
  });

  it('ontology/functions/functions#errors: an unknown or non-string parameterId, or a parameterId on a plain Error, adds nothing', async () => {
    expect(errorAnswer(await apply('refuseUnknown'))).toEqual(
      functionError('FunctionEncounteredUserFacingError', 'accountId must match'),
    );

    expect(errorAnswer(await apply('refuseNonString'))).toEqual(
      functionError('FunctionEncounteredUserFacingError', 'accountId must match'),
    );

    expect(errorAnswer(await apply('failNamed'))).toEqual(
      functionError('FunctionExecutionFailed', 'test parameter plain error'),
    );

    expect(
      Object.keys((errorAnswer(await apply('throwUserFacing')).body as { parameters: object }).parameters).sort(),
    ).toEqual(['functionRid', 'functionVersion', 'message']);
  });

  it('ontology/functions/functions#errors: a Function error holds no stacktrace, and the request log holds the stack of the Function', async () => {
    const answer = await apply('throwError');

    expect(Object.keys((answer.body as { parameters: object }).parameters).sort()).toEqual([
      'functionRid',
      'functionVersion',
      'message',
    ]);

    const stack = logLineOf(answer)?.['stack'];

    expect(stack).toMatch(/^Error: test plain error\n\s+at throwError /);
  });

  it('ontology/functions/functions#errors: a thrown value that is not an Error gets 400 FunctionExecutionFailed with the value as a string', async () => {
    expect(errorAnswer(await apply('throwString'))).toEqual(
      functionError('FunctionExecutionFailed', 'a thrown string'),
    );

    expect(errorAnswer(await apply('throwObject'))).toEqual(
      functionError('FunctionExecutionFailed', '[object Object]'),
    );
  });
});

describe('a throw outside the call stack of a Function', () => {
  it('ontology/functions/functions#runtime: a throw in a timer before the Function returns gets 400 FunctionExecutionFailed, and writes nothing', async () => {
    expect(errorAnswer(await apply('throwInTimer'))).toEqual(
      functionError('FunctionExecutionFailed', 'a throw in a timer'),
    );

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
  });

  it('ontology/functions/functions#runtime: a throw after the Function returned does not fail a later call', async () => {
    expect((await apply('throwAfterReturn')).status).toBe(200);

    expect((await apply('waitAndCreate')).status).toBe(200);

    expect((await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row['account_id'])).toEqual(['fn-acc-1']);
  });
});

describe('a Function that calls fetch', () => {
  it('ontology/functions/functions#code: the call fails the Function, so the app gets 400 FunctionExecutionFailed and nothing is written', async () => {
    expect(errorAnswer(await apply('callFetch'))).toEqual(
      functionError('FunctionExecutionFailed', 'A V1 Function cannot call fetch.'),
    );

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
  });
});

describe('the Function version of a later Ontology version', () => {
  it('ontology/functions/functions#errors: after a second publish, a Function error has the version 2.0.0', async () => {
    const { ir, functions } = await withFunctions(
      [...FUNCTIONS, { apiName: 'throwErrorToo', inputs: accountInput, edits: [ACCOUNT] }],
      SOURCE,
    );

    await service.publish(ir, functions);

    expect(errorAnswer(await apply('throwError'))).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: { functionRid: THROW_ERROR_RID, functionVersion: '2.0.0', message: 'test plain error' },
      },
    });
  });
});
