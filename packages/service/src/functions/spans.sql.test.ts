import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { FinishedSpan } from '../spans/index.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { routeSpans, routeTraceProblems } from '../routeHarness.test-utils.ts';
import { NS, seedClient, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const APPLY = 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply';
const LOAD_OBJECTS = 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects';
const reportId = { name: 'reportId', type: 'string' as const };

const FUNCTIONS: TestFunction[] = [
  { apiName: 'readAccount', inputs: [reportId], edits: [ACCOUNT] },
  { apiName: 'readParallel', inputs: [reportId], edits: [ACCOUNT] },
  { apiName: 'readMissingType', inputs: [reportId], edits: [ACCOUNT] },
  { apiName: 'leaveTimer', inputs: [reportId], edits: [ACCOUNT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
const thread = () => process.getBuiltinModule('node:worker_threads').threadId;

function report(client, reportId) {
  const batch = createEditBatch(client);
  batch.create(Account, { accountId: reportId, name: String(thread()) });
  return batch.getEdits();
}

export const functions = {
  readAccount: async (client, reportId) => {
    await client(Account).fetchOne('acc-1');
    return report(client, reportId);
  },
  readParallel: async (client, reportId) => {
    await Promise.all([
      client(Account).fetchOne('acc-1'),
      client(Account).fetchOne('acc-2'),
      client(Account).fetchOne('acc-3'),
      client(Account).fetchPage(),
    ]);
    return report(client, reportId);
  },
  readMissingType: async (client, reportId) => {
    await client({ type: 'object', apiName: 'missing-type' }).fetchPage().catch(() => undefined);
    return report(client, reportId);
  },
  // A timer that the call leaves open retires the worker, so the next call starts a new worker.
  leaveTimer: async (client, reportId) => {
    setTimeout(() => undefined, 60_000);
    return report(client, reportId);
  },
};
`;

const RULE_BIND = 'service/observability#traces';
const RULE_TIMES = 'service/observability#traces';
const RULE_SPANS = 'service/observability#traces';
const RULE_LOG = 'service/observability#logs';

let service: ActionsService;
let log: MockInstance<typeof console.log>;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);

  log?.mockRestore();

  log = vi.spyOn(console, 'log');
});

async function apply(apiName: string, id: string): Promise<string> {
  const answer = await service.apply(actionOf(apiName), {
    parameters: { reportId: id },
    options: { mode: 'VALIDATE_AND_EXECUTE' },
  });

  expect(answer.status).toBe(200);

  const rows = await service.db.query<{ name: string }>(
    sql(`SELECT name FROM ontology_1_objects.account WHERE account_id = '${id}'`),
  );

  return rows[0]?.name ?? '';
}

async function applyTraces(): Promise<FinishedSpan[][]> {
  const spans = await routeSpans();

  const roots = spans.filter((s) => s.name === APPLY).sort((a, b) => (a.start < b.start ? -1 : 1));

  return roots.map((root) => spans.filter((s) => s.traceId === root.traceId));
}

const named = (spans: readonly FinishedSpan[], name: string): FinishedSpan[] => spans.filter((s) => s.name === name);

const one = (spans: readonly FinishedSpan[], name: string): FinishedSpan => {
  const found = named(spans, name);

  expect(found, name).toHaveLength(1);

  return found[0] as FinishedSpan;
};

const childrenOf = (spans: readonly FinishedSpan[], parent: FinishedSpan): FinishedSpan[] =>
  spans.filter((s) => s.parentSpanId === parent.spanId);

const descendantsOf = (spans: readonly FinishedSpan[], parent: FinishedSpan): FinishedSpan[] =>
  childrenOf(spans, parent).flatMap((child) => [child, ...descendantsOf(spans, child)]);

const inside = (child: FinishedSpan, parent: FinishedSpan): boolean =>
  child.start >= parent.start && child.end <= parent.end;

describe('the spans of a Function run', () => {
  it(`${RULE_BIND}: 2 requests on 1 warm worker each get the function client spans of their own Function run`, async () => {
    const first = await apply('readAccount', 'report-1');

    const second = await apply('readAccount', 'report-2');

    expect(second).toBe(first);

    const traces = await applyTraces();

    expect(traces).toHaveLength(2);

    for (const spans of traces) {
      const run = one(spans, 'function run');
      const clients = named(spans, `function client ${LOAD_OBJECTS}`);

      expect(clients).toHaveLength(1);

      for (const client of clients) expect(client.parentSpanId).toBe(run.spanId);
    }
  });

  it(`${RULE_TIMES}: worker call has a bundle load child on a new worker, and a function body child on each call, inside its time`, async () => {
    await apply('leaveTimer', 'report-0');

    const cold = await apply('readAccount', 'report-1');

    const warm = await apply('readAccount', 'report-2');

    expect(warm).toBe(cold);

    const [, coldSpans = [], warmSpans = []] = await applyTraces();

    const coldCall = one(coldSpans, 'worker call');

    expect(
      childrenOf(coldSpans, coldCall)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['bundle load', 'function body']);

    for (const child of childrenOf(coldSpans, coldCall)) expect(inside(child, coldCall), child.name).toBe(true);

    expect(one(coldSpans, 'bundle load').end).toBeLessThanOrEqual(one(coldSpans, 'function body').start);

    const warmCall = one(warmSpans, 'worker call');

    expect(childrenOf(warmSpans, warmCall).map((s) => s.name)).toEqual(['function body']);
    expect(inside(one(warmSpans, 'function body'), warmCall)).toBe(true);
  });

  it(`${RULE_SPANS}: function run has worker wait and worker call, and function client is named by its route key, with its SQL spans`, async () => {
    await apply('readAccount', 'report-1');

    const [spans = []] = await applyTraces();

    const root = one(spans, APPLY);

    expect(root.attributes['action.api_name']).toBe(actionOf('readAccount'));

    const run = one(spans, 'function run');

    expect(run.attributes['action.api_name']).toBe(actionOf('readAccount'));

    expect(
      childrenOf(spans, run)
        .filter((s) => !s.name.startsWith('function client '))
        .map((s) => s.name),
    ).toEqual(['worker wait', 'worker call']);

    const client = one(spans, `function client ${LOAD_OBJECTS}`);

    expect(client.attributes).toMatchObject({ 'route.key': LOAD_OBJECTS, 'http.status_code': 200 });

    const sqlSpans = named(descendantsOf(spans, client), 'sql');

    expect(sqlSpans.map((s) => s.attributes['sql.template'])).toContainEqual(
      expect.stringContaining('"ontology_1_objects"."account"'),
    );

    for (const s of spans) {
      expect(typeof s.attributes['sentry.op'], s.name).toBe('string');
      expect(s.attributes['sentry.op'], s.name).not.toBe('default');
    }
  });

  it(`${RULE_SPANS}: concurrent client reads inside 1 Function run produce 4 function client spans and a valid trace`, async () => {
    await apply('readParallel', 'report-parallel');

    const [spans = []] = await applyTraces();

    const run = one(spans, 'function run');
    const clients = named(spans, `function client ${LOAD_OBJECTS}`);

    expect(clients).toHaveLength(4);

    for (const client of clients) expect(client.parentSpanId).toBe(run.spanId);

    expect(routeTraceProblems(spans)).toEqual([]);
  });
});

describe('the function run span of an edit run', () => {
  it('service/observability#traces: has function.api_name, function.kind edit, and action.api_name', async () => {
    await apply('readAccount', 'report-1');

    const [spans = []] = await applyTraces();

    expect(one(spans, 'function run').attributes).toMatchObject({
      'function.api_name': 'readAccount',
      'function.kind': 'edit',
      'action.api_name': actionOf('readAccount'),
    });
  });
});

describe('the error line of a failed call of a Function client', () => {
  it(`${RULE_LOG}: holds the traceId of the request that runs the Function, also on a warm worker`, async () => {
    const first = await apply('readMissingType', 'report-1');

    const second = await apply('readMissingType', 'report-2');

    expect(second).toBe(first);

    const traces = await applyTraces();

    const lines = log.mock.calls
      .map(([line]) =>
        typeof line === 'string' && line.startsWith('{') ? (JSON.parse(line) as Record<string, unknown>) : undefined,
      )
      .filter((line) => line?.['route'] === LOAD_OBJECTS && line['errorInstanceId'] !== undefined);

    expect(lines.map((line) => line?.['traceId'])).toEqual(traces.map((spans) => one(spans, APPLY).traceId));
  });
});
