import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db, SnapshotDb } from '../db/promise.test-utils.ts';
import { CANARY, routeSpans } from '../routeHarness.test-utils.ts';
import { asSnapshot } from '../service.test-utils.ts';
import { startActions, type ActionsService } from './actions.test-utils.ts';
import { LOOP_FOREVER_CHANNEL } from './queryApp/loopForever.fixture.ts';
import {
  ACCOUNT,
  ENGAGEMENT,
  insertQueryObjects,
  QUERY_GRANTS,
  QUERY_IR,
  queryFunctions,
  runQuery,
  type QueryPerson,
  type RunAnswer,
} from './queryRun.test-utils.ts';

const ERRORS = 'ontology/functions/query-functions#errors';

const FUNCTION_RID = expect.stringMatching(
  /^ri\.function-registry\.main\.function\.[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

const FUNCTION_IDS = { functionRid: FUNCTION_RID, functionVersion: '1.0.0' };

let service: ActionsService;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  service = await startActions(QUERY_IR, await queryFunctions(1), QUERY_GRANTS);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await insertQueryObjects(service.db);

  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => {
  consoleLog.mockRestore();
});

function run(
  name: string,
  parameters: Record<string, unknown>,
  person: QueryPerson = 'admin',
  db?: Db,
): Promise<RunAnswer> {
  return runQuery(service, name, { parameters }, person, '', db ? { db } : {});
}

function errorOf({ status, body }: RunAnswer): { status: number; body: unknown } {
  const { errorInstanceId, ...rest } = body as { errorInstanceId: string };

  expect(errorInstanceId).toEqual(expect.any(String));

  return { status, body: rest };
}

async function workerSpans(): Promise<string[]> {
  return (await routeSpans())
    .map((span) => span.name)
    .filter((name) => ['function run', 'worker call', 'function body'].includes(name));
}

function logLineOf(answer: RunAnswer): Record<string, unknown> | undefined {
  const { errorInstanceId } = answer.body as { errorInstanceId: string };

  return consoleLog.mock.calls
    .map(([line]) =>
      typeof line === 'string' && line.startsWith('{') ? (JSON.parse(line) as Record<string, unknown>) : undefined,
    )
    .find((line) => line?.['errorInstanceId'] === errorInstanceId);
}

async function logsAndSpans(): Promise<string> {
  const spans = JSON.stringify((await routeSpans()).map((span) => [span.name, span.attributes]));

  return `${consoleLog.mock.calls.map(([line]) => String(line)).join('\n')}\n${spans}`;
}

const invalidValue = (parameterDataType: unknown, parameterId: string, parameterValue: unknown) => ({
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'InvalidQueryParameterValue',
    parameters: { parameterDataType, parameterId, parameterValue },
  },
});

describe('an input that the run route refuses', () => {
  it(`${ERRORS}: an unknown input gives 400 UnknownParameter with unknownParameters and expectedParameters, before a missing input`, async () => {
    expect(errorOf(await run('orderComparison', { first: '1', thirdValue: '2' }))).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'UnknownParameter',
        parameters: { unknownParameters: ['thirdValue'], expectedParameters: ['first', 'second'] },
      },
    });
  });

  it(`${ERRORS}: a required input with no value, or with null, gives 400 MissingParameter with parameters, before a value of the wrong type`, async () => {
    const missing = {
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'MissingParameter', parameters: { parameters: ['first'] } },
    };

    expect(errorOf(await run('orderComparison', { second: 'not a Decimal' }))).toEqual(missing);

    expect(errorOf(await run('orderComparison', { first: null, second: 'not a Decimal' }))).toEqual(missing);

    expect(errorOf(await run('orderComparison', {}))).toEqual({
      ...missing,
      body: { ...missing.body, parameters: { parameters: ['first', 'second'] } },
    });
  });

  it(`${ERRORS}: a body with no parameters object gives 400 Default:InvalidArgument`, async () => {
    for (const body of [{}, { parameters: [] }, { parameters: 'text' }]) {
      expect(errorOf(await runQuery(service, 'echo', body))).toEqual({
        status: 400,
        body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: {} },
      });
    }
  });

  it(`${ERRORS}: a wrong type, a bad Decimal string, a list of the wrong type, a bad primary key, and a value outside the string literals each give 400 InvalidQueryParameterValue, and the Function does not run`, async () => {
    const tags = { type: 'union', unionTypes: [{ type: 'array', subType: { type: 'string' } }, { type: 'null' }] };

    const answers = [
      await run('echo', { text: 5 }),
      await run('orderComparison', { first: '1.2.3', second: '1' }),
      await run('pickPhase', { phase: 'customer', tags: 'a' }),
      await run('feedAccountCheck', { account: 5 }),
      await run('pickPhase', { phase: 'churned', tags: [] }),
    ];

    expect(answers.map(errorOf)).toEqual([
      invalidValue({ type: 'string' }, 'text', 5),
      invalidValue({ type: 'string' }, 'first', '1.2.3'),
      invalidValue(tags, 'tags', 'a'),
      invalidValue({ type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT }, 'account', 5),
      invalidValue({ type: 'string' }, 'phase', 'churned'),
    ]);

    expect(await workerSpans()).toEqual([]);

    expect(await run('pickPhase', { phase: 'prospect', tags: ['a', 'b'] })).toMatchObject({
      status: 200,
      body: { value: 'prospect:2' },
    });
  });

  it(`${ERRORS}: a list input with null runs as an empty list, as with [] and with no value, for a list of Objects and a list of a base type`, async () => {
    for (const [name, other, expected] of [
      ['pickPhase', { phase: 'customer' }, 'customer:0'],
      ['accountCount', {}, 'accounts:0'],
    ] as const) {
      const list = name === 'pickPhase' ? 'tags' : 'accounts';

      const answers = [
        await run(name, { ...other, [list]: null }),
        await run(name, { ...other, [list]: [] }),
        await run(name, other),
      ];

      expect(answers.map(({ status, body }) => ({ status, body }))).toStrictEqual(
        answers.map(() => ({ status: 200, body: { value: expected } })),
      );
    }
  });

  it(`${ERRORS}: a null element of a list input still gives 400 InvalidQueryParameterValue`, async () => {
    const tags = { type: 'union', unionTypes: [{ type: 'array', subType: { type: 'string' } }, { type: 'null' }] };

    const accounts = {
      type: 'union',
      unionTypes: [
        { type: 'array', subType: { type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT } },
        { type: 'null' },
      ],
    };

    expect(errorOf(await run('pickPhase', { phase: 'customer', tags: ['a', null] }))).toEqual(
      invalidValue(tags, 'tags', ['a', null]),
    );

    expect(errorOf(await run('accountCount', { accounts: [null] }))).toEqual(
      invalidValue(accounts, 'accounts', [null]),
    );
  });

  it(`${ERRORS} service/observability#logs: the answer holds parameterValue, and no span and no request log line holds it`, async () => {
    const answer = await run('echo', { text: [CANARY] });

    expect(errorOf(answer)).toEqual(invalidValue({ type: 'string' }, 'text', [CANARY]));

    expect(logLineOf(answer)?.['parameters']).toEqual({
      parameterDataType: { type: 'string' },
      parameterId: 'text',
      parameterValue: '<redacted>',
    });

    expect(await logsAndSpans()).not.toContain(CANARY);
  });
});

describe('an unknown input', () => {
  it(`${ERRORS} service/observability#logs: the answer and the request log line keep the unknown input name in unknownParameters, and no span holds it`, async () => {
    const answer = await run('echo', { text: 'a', txet: 1 });

    const parameters = { unknownParameters: ['txet'], expectedParameters: ['text'] };

    expect(errorOf(answer)).toMatchObject({ status: 400, body: { errorName: 'UnknownParameter', parameters } });

    expect(logLineOf(answer)).toEqual({
      userId: 'user_admin',
      callerKind: 'person',
      traceId: expect.any(String),
      ontologyVersion: 1,
      errorInstanceId: (answer.body as { errorInstanceId: string }).errorInstanceId,
      route: 'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute',
      routeParams: { ontology: expect.any(String), queryApiName: 'echo' },
      errorName: 'UnknownParameter',
      parameters,
      stack: expect.stringContaining('UnknownParameter'),
    });

    const spans = JSON.stringify((await routeSpans()).map((span) => [span.name, span.attributes]));

    expect(spans).not.toContain('txet');
  });
});

describe('an Object input whose Object the caller does not get', () => {
  it(`${ERRORS}: an Object that does not exist gives 400 InvalidQueryParameterValue for that input, and the Function does not run`, async () => {
    const answer = await run('feedAccountCheck', { account: 'acc-404' });

    expect(errorOf(answer)).toEqual(
      invalidValue({ type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT }, 'account', 'acc-404'),
    );

    expect(await workerSpans()).not.toContain('function body');
  });

  it(`${ERRORS}: an Object that a policy hides from the caller gives the same answer as an Object that does not exist, and the Function does not run`, async () => {
    const hidden = await run('engagementTitle', { engagement: 'eng-1' }, 'gus');

    const unknown = await run('engagementTitle', { engagement: 'eng-2' }, 'gus');

    const engagement = { type: 'object', objectApiName: ENGAGEMENT, objectTypeApiName: ENGAGEMENT };

    expect(errorOf(hidden)).toEqual(invalidValue(engagement, 'engagement', 'eng-1'));
    expect(errorOf(unknown)).toEqual(invalidValue(engagement, 'engagement', 'eng-2'));

    expect(hidden.text.replace('eng-1', 'eng-2').replace(/"errorInstanceId":"[^"]*"/, '')).toBe(
      unknown.text.replace(/"errorInstanceId":"[^"]*"/, ''),
    );

    expect(await workerSpans()).not.toContain('function body');
  });
});

describe('a Query Function that throws', () => {
  it(`${ERRORS}: a UserFacingError gives 409 QueryEncounteredUserFacingError with functionRid, functionVersion, and message, and no parameterId`, async () => {
    expect(errorOf(await run('refuse', { text: 'a' }))).toEqual({
      status: 409,
      body: {
        errorCode: 'CONFLICT',
        errorName: 'QueryEncounteredUserFacingError',
        parameters: { ...FUNCTION_IDS, message: 'The text is refused.' },
      },
    });
  });

  it(`${ERRORS} service/observability#logs: another thrown value gives 400 QueryRuntimeError with no stacktrace, the request log holds the stack, and no span or log line holds an input`, async () => {
    const answer = await run('fail', { text: CANARY });

    expect(errorOf(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'QueryRuntimeError',
        parameters: { ...FUNCTION_IDS, message: 'a plain error', parameters: {} },
      },
    });

    expect(logLineOf(answer)?.['stack']).toMatch(/^Error: a plain error\n\s+at fail /);
    expect(answer.text).not.toContain(CANARY);

    expect(await logsAndSpans()).not.toContain(CANARY);
  });

  it(`${ERRORS}: the message and the logged stack of a thrown value hold only what the Function read as the caller, so no Property value that a policy hides`, async () => {
    const shown = JSON.stringify({ name: null, phase: null });

    for (const userFacing of [true, false]) {
      const answer = await run('failWithAccount', { accountId: 'acc-3', userFacing }, 'ann');

      expect((answer.body as { parameters: { message: string } }).parameters.message).toBe(shown);
      expect(String(logLineOf(answer)?.['stack'])).not.toContain('Name acc-3');
      expect(answer.text).not.toContain('Name acc-3');
    }
  });
});

async function withTimeLimit<T>(run: (overLimit: () => Promise<void>) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const channel = new BroadcastChannel(LOOP_FOREVER_CHANNEL);

  try {
    const looping = new Promise((resolve) => (channel.onmessage = resolve));

    return await run(async () => {
      await looping;

      await vi.runOnlyPendingTimersAsync();
    });
  } finally {
    channel.close();

    vi.useRealTimers();
  }
}

describe('the limits of a run', () => {
  it(`${ERRORS} ontology/functions/functions#runtime: the time limit gives 400 QueryTimeExceededLimit with functionRid and functionVersion, and the next run gets a worker`, async () => {
    const answer = await withTimeLimit(async (overLimit) => {
      const looped = run('loopForever', {});

      await overLimit();

      return looped;
    });

    expect(errorOf(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'QueryTimeExceededLimit', parameters: FUNCTION_IDS },
    });

    expect(await run('echo', { text: 'next' })).toMatchObject({ status: 200, body: { value: 'next' } });
  });

  it(`${ERRORS} ontology/functions/functions#runtime: the heap limit gives 400 QueryMemoryExceededLimit with functionRid and functionVersion, and the next run gets a worker`, async () => {
    expect(errorOf(await run('fillHeap', {}))).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'QueryMemoryExceededLimit', parameters: FUNCTION_IDS },
    });

    expect(await run('echo', { text: 'next' })).toMatchObject({ status: 200, body: { value: 'next' } });
  });
});

describe('a returned value that is not of the output type', () => {
  it(`${ERRORS}: gives 400 InvalidQueryOutputValue with outputDataType, functionRid, and functionVersion, and no outputValue. The answer, the spans, and the request log hold none of it`, async () => {
    const answer = await run('wrongOutput', { text: CANARY });

    expect(errorOf(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidQueryOutputValue',
        parameters: { outputDataType: { type: 'string' }, ...FUNCTION_IDS },
      },
    });

    expect(answer.text).not.toContain(CANARY);

    expect(await logsAndSpans()).not.toContain(CANARY);
  });
});

function failingDb(): Db {
  const { db } = service;
  const reads = (sql: Sql) => sql.text.includes('FROM "ontology_1_objects"."account"');
  const failure = () => new Error('The test fails each read of the Account table in the snapshot.');

  const watch = (snapshot: SnapshotDb): SnapshotDb =>
    asSnapshot({
      query: <Row extends object>(sql: Sql) => (reads(sql) ? Promise.reject(failure()) : snapshot.query<Row>(sql)),
      stream: <Row extends object>(sql: Sql) =>
        reads(sql)
          ? (async function* (): AsyncGenerator<Row> {
              yield* [];

              throw failure();
            })()
          : snapshot.stream<Row>(sql),
      snapshot: (run) => snapshot.snapshot(run),
      transaction: (run) => snapshot.transaction(run),
    });

  return {
    ...db,
    query: (q) => db.query(q),
    stream: (q) => db.stream(q),
    transaction: (run) => db.transaction(run),
    snapshot: (run) => db.snapshot((s) => run(watch(s))),
  };
}

describe("a 5xx in a read of the Function's client", () => {
  it(`${ERRORS}: gives 500 Default:Internal when the Function then throws, returns a value, or loads an Object input`, async () => {
    const internal = { status: 500, body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} } };

    const answers = [
      await run('classificationSuggestion', { accountId: 'acc-1' }, 'admin', failingDb()),
      await run('readAccount', { accountId: 'acc-1' }, 'admin', failingDb()),
      await run('feedAccountCheck', { account: 'acc-1' }, 'admin', failingDb()),
    ];

    expect(answers.map(errorOf)).toEqual([internal, internal, internal]);

    expect(await run('readAccount', { accountId: 'acc-1' })).toMatchObject({ status: 200 });
  });
});
