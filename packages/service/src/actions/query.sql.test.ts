import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ONTOLOGY_RID } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { CANARY, routeSpans } from '../routeHarness.test-utils.ts';
import { rowsOf, startActions, type ActionsService } from './actions.test-utils.ts';
import { READ_TWICE_CHANNEL } from './queryApp/readTwice.fixture.ts';
import {
  ACCOUNT,
  insertQueryObjects,
  QUERY_GRANTS,
  QUERY_IR,
  QUERY_PEOPLE,
  queryFunctions,
  runQuery,
  type QueryPerson,
  type RunAnswer,
} from './queryRun.test-utils.ts';

const RUN = 'ontology/functions/query-functions#run';

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
  search = '',
): Promise<RunAnswer> {
  return runQuery(service, name, { parameters }, person, search);
}

async function valueOf(
  name: string,
  parameters: Record<string, unknown>,
  person: QueryPerson = 'admin',
): Promise<unknown> {
  const answer = await run(name, parameters, person);

  expect(answer.status, answer.text).toBe(200);

  return (answer.body as { value: unknown }).value;
}

async function workerSpans(): Promise<string[]> {
  return (await routeSpans())
    .map((span) => span.name)
    .filter((name) => ['function run', 'worker call', 'function body'].includes(name));
}

const SHAPE_RUNS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['scenarioComparison', { balance: '1200.50' }],
  ['orderComparison', { first: '10.10', second: '9.5' }],
  ['scenarioChart', {}],
  ['requiredPayments', {}],
  ['feedAccountCheck', { account: 'acc-1' }],
  ['classificationSuggestion', { accountId: 'acc-2' }],
  ['amountLeft', { budget: '42.10' }],
];

describe('the run of a Query Function', () => {
  it(`${RUN}: each of the 7 output shapes  answers its value. A Decimal is its exact string in the form of jsonValueOf, an Object is its primary key, and an optional struct field with no value has no key`, async () => {
    const answers: Record<string, unknown> = {};

    for (const [name, parameters] of SHAPE_RUNS) answers[name] = await valueOf(name, parameters);

    expect(answers).toStrictEqual({
      scenarioComparison: [
        { days: 30, balance: '1200.5', runwayDate: '2027-01-31' },
        { days: 60, balance: '-75.25', runwayDate: '2027-03-02' },
        { days: 90, balance: '12345678901234567890.12' },
      ],
      orderComparison: { cheaper: 'second', first: '10.1', second: '9.5', same: false },
      scenarioChart: {
        label: 'Runway',
        thirty: [
          { day: '2026-12-01', balance: '100.1' },
          { day: '2026-12-31', balance: '50' },
        ],
        sixty: [],
      },
      requiredPayments: [
        { account: 'acc-1', amount: '1200.5', due: '2026-12-01' },
        { account: 'acc-2', amount: '99.99', due: '2026-12-01' },
      ],
      feedAccountCheck: { balance: '1200.5', limit: '5000', warnings: [] },
      classificationSuggestion: 'acc-2',
      amountLeft: '42.1',
    });
  });

  it(`${RUN}: a T | undefined output that returns undefined answers { value: null }`, async () => {
    expect(await run('amountLeft', {})).toMatchObject({ status: 200, body: { value: null } });
  });

  it(`${RUN}: the answer of an Object output holds only its primary key, and no Property value`, async () => {
    const answer = await run('classificationSuggestion', { accountId: 'acc-1' });

    expect(answer.text).toBe('{"value":"acc-1"}');
  });
});

describe('the fields of a struct output', () => {
  it(`${RUN}: the answer of a struct output holds only the fields of its type, and not a field that the Function returns and the type does not have`, async () => {
    const answer = await run('extraField', {});

    expect([answer.status, answer.body]).toStrictEqual([200, { value: { label: 'shown' } }]);
  });
});

describe('execute_query of the Ontology MCP', () => {
  it('service/ontology-mcp#tools: execute_query gives the same value as the run route for each of the 7 output shapes , and for a null value', async () => {
    for (const [name, parameters] of [...SHAPE_RUNS, ['amountLeft', {}] as const]) {
      const route = await run(name, parameters);

      expect(route.status, route.text).toBe(200);

      const tool = await service.tool('execute_query', { query: name, parameters }, QUERY_PEOPLE.admin);

      const result = (tool.body as { result: { isError?: boolean; structuredContent: unknown } }).result;

      expect(result.isError, name).toBeFalsy();
      expect(result.structuredContent, name).toStrictEqual(route.body);
    }
  });
});

describe('the reads of a run', () => {
  it(`${RUN}: a Property value that a policy hides from the caller reads as null, and one that it shows reads as its value`, async () => {
    expect(JSON.parse(String(await valueOf('readAccount', { accountId: 'acc-3' }, 'ann')))).toEqual({
      name: null,
      phase: null,
    });

    expect(JSON.parse(String(await valueOf('readAccount', { accountId: 'acc-1' }, 'ann')))).toEqual({
      name: 'Name acc-1',
      phase: 'customer',
    });
  });

  it(`${RUN}: an Object that a policy hides from the caller is not found by the Function's client`, async () => {
    expect(await valueOf('readEngagement', { engagementId: 'eng-1' }, 'gus')).toBeNull();

    expect(await valueOf('readEngagement', { engagementId: 'eng-1' }, 'ann')).toBe('eng-1');
  });

  it(`${RUN}: an Object input that a policy hides from the caller stops the run before the body of the Function runs, and the answer holds none of its values`, async () => {
    const answer = await run('engagementTitle', { engagement: 'eng-1' }, 'gus');

    expect(answer.status).toBe(400);
    expect(answer.text).not.toContain('Discovery workshop');

    expect(await workerSpans()).not.toContain('function body');

    expect(await valueOf('engagementTitle', { engagement: 'eng-1' }, 'ann')).toBe('Discovery workshop');
  });

  it(`${RUN}: all reads of 1 run see 1 snapshot, also after another connection commits a change between 2 reads`, async () => {
    const channel = new BroadcastChannel(READ_TWICE_CHANNEL);
    const firstRead = new Promise((resolve) => (channel.onmessage = resolve));

    try {
      const answer = valueOf('readTwice', { accountId: 'acc-1' });

      await firstRead;

      await service.db.query(sql("UPDATE ontology_1_objects.account SET phase = 'changed' WHERE account_id = 'acc-1'"));

      channel.postMessage('changed');

      expect(JSON.parse(String(await answer))).toEqual({ first: 'customer', second: 'customer' });
    } finally {
      channel.close();
    }

    expect(JSON.parse(String(await valueOf('readAccount', { accountId: 'acc-1' })))).toMatchObject({
      phase: 'changed',
    });
  });
});

describe('a run writes nothing', () => {
  it(`${RUN}: a Function whose client tries the apply route gets 403, and no Object and no history entry changes`, async () => {
    const before = await rowsOf(service.db, ACCOUNT, 'account_id');

    const answer = JSON.parse(String(await valueOf('tryEdit', { ontology: ONTOLOGY_RID, accountId: 'acc-1' }))) as {
      status: number;
      body: { errorName: string };
    };

    expect([answer.status, answer.body.errorName]).toEqual([403, 'Default:PermissionDenied']);

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual(before);

    expect(await service.db.query(sql('SELECT count(*)::int AS count FROM ontology_1_engine.edit_history'))).toEqual([
      { count: 0 },
    ]);
  });
});

describe("the run route from a Function's client", () => {
  it('ontology/functions/functions#reads: gets 403 Default:PermissionDenied, as the apply route does, with the same answer for a known and an unknown name', async () => {
    const { known, unknown } = JSON.parse(String(await valueOf('callRun', { ontology: ONTOLOGY_RID }))) as Record<
      'known' | 'unknown',
      { status: number; body: { errorInstanceId: string } }
    >;

    const withoutId = ({ status, body }: { status: number; body: { errorInstanceId: string } }) => ({
      status,
      body: { ...body, errorInstanceId: '<id>' },
    });

    expect(withoutId(known)).toEqual({
      status: 403,
      body: {
        errorCode: 'PERMISSION_DENIED',
        errorName: 'Default:PermissionDenied',
        errorInstanceId: '<id>',
        parameters: {},
      },
    });

    expect(withoutId(unknown)).toEqual(withoutId(known));
  });
});

describe('a Query Function that the caller cannot run', () => {
  it(`${RUN} service/http-api#metadata-routes: an unknown name, a hidden Query Function, a Query Function whose Object Type is hidden, and an edit Function get the same 404 QueryNotFound, before any input check, and no Function code runs`, async () => {
    const cases: [string, QueryPerson][] = [
      ['noSuchQuery', 'ann'],
      ['secretSummary', 'ann'],
      ['readEngagement', 'ada'],
      ['editAccount', 'ann'],
    ];

    const answers: { status: number; body: string }[] = [];

    for (const [name, person] of cases) {
      const answer = await run(name, { noSuchInput: 1 }, person);

      answers.push({
        status: answer.status,
        body: answer.text.replaceAll(name, '<name>').replace(/"errorInstanceId":"[^"]*"/, '"errorInstanceId":"<id>"'),
      });
    }

    expect(answers[0]).toEqual({
      status: 404,
      body: '{"errorCode":"NOT_FOUND","errorName":"QueryNotFound","errorInstanceId":"<id>","parameters":{"query":"<name>"}}',
    });

    expect(answers).toEqual(cases.map(() => answers[0]));

    expect(await workerSpans()).toEqual([]);

    expect(await valueOf('secretSummary', {}, 'admin')).toBe('secret');

    expect(await valueOf('readEngagement', { engagementId: 'eng-1' }, 'ann')).toBe('eng-1');
  });
});

describe('the trace and the request log of a run', () => {
  it('service/observability#traces: function run has function.api_name and function.kind, and no action.api_name. No span and no log line holds an input or the value', async () => {
    const answer = await run('echo', { text: CANARY });

    expect(answer).toMatchObject({ status: 200, body: { value: CANARY } });

    const spans = await routeSpans();

    const functionRun = spans.find((span) => span.name === 'function run');

    expect(functionRun?.attributes).toMatchObject({ 'function.api_name': 'echo', 'function.kind': 'query' });
    expect(functionRun?.attributes).not.toHaveProperty('action.api_name');

    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining(['worker wait', 'worker call', 'function body']),
    );

    expect(JSON.stringify(spans.map((span) => [span.name, span.attributes]))).not.toContain(CANARY);

    const lines = consoleLog.mock.calls.map(([line]) => String(line));

    expect(lines.some((line) => line.includes('"ontologyVersion"'))).toBe(true);
    expect(lines.join('\n')).not.toContain(CANARY);
  });

  it(`${RUN}: a value that is not of the output type is not answered. The answer, the spans, and the request log hold none of it`, async () => {
    const answer = await run('wrongOutput', { text: CANARY });

    expect(answer.status).not.toBe(200);
    expect(answer.text).not.toContain(CANARY);

    expect(JSON.stringify((await routeSpans()).map((span) => span.attributes))).not.toContain(CANARY);

    expect(consoleLog.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain(CANARY);
  });
});

describe('the version of a run', () => {
  it(`${RUN}: with no version, or the version 0.0.0, the route runs the caller's current Ontology version`, async () => {
    expect(await valueOf('appVersion', {})).toBe('1');

    await service.publish(QUERY_IR, await queryFunctions(2), QUERY_GRANTS);

    expect(await valueOf('appVersion', {})).toBe('2');

    expect(await run('appVersion', {}, 'admin', '?version=0.0.0')).toMatchObject({ status: 200, body: { value: '2' } });
  });

  it(`${RUN}: a version other than 0.0.0 gets 404 QueryVersionNotFound with the apiName and the version, and no Function code runs`, async () => {
    const answer = await run('appVersion', {}, 'admin', '?version=1.0.0');

    expect([answer.status, answer.body]).toEqual([
      404,
      {
        errorCode: 'NOT_FOUND',
        errorName: 'QueryVersionNotFound',
        errorInstanceId: expect.any(String),
        parameters: { apiName: 'appVersion', version: '1.0.0' },
      },
    ]);

    expect(await workerSpans()).toEqual([]);
  });

  it(`${RUN} service/http-api#metadata-routes: a Query Function of a version whose stored metadata has no query types gets 404 QueryNotFound from GET queryTypes/{name} and from the run route, and no Function code runs`, async () => {
    await service.publish(QUERY_IR, await queryFunctions(1), QUERY_GRANTS);

    await service.db.query(
      sql(
        `UPDATE ontology_registry.product_versions SET metadata = metadata || '{"queryTypes":{}}' WHERE version = (SELECT max(version) FROM ontology_registry.product_versions)`,
      ),
    );

    const metadata = await service.call(
      'GET',
      `/api/v2/ontologies/${ONTOLOGY_RID}/queryTypes/appVersion`,
      undefined,
      QUERY_PEOPLE.admin,
    );

    const answer = await run('appVersion', {});

    expect([metadata.status, JSON.parse(metadata.text)]).toEqual([
      404,
      expect.objectContaining({ errorName: 'QueryNotFound', parameters: { query: 'appVersion' } }),
    ]);

    expect([answer.status, answer.body]).toEqual([
      404,
      expect.objectContaining({ errorName: 'QueryNotFound', parameters: { query: 'appVersion' } }),
    ]);

    expect(await workerSpans()).toEqual([]);
  });
});
