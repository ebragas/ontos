import { SpanStatusCode } from '@opentelemetry/api';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool, REGISTRY_SCHEMA, sharedEngineChanges } from '../db/index.ts';
import { ENGINE_CHANGES_LOCK } from '../db/engineChanges.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { Handle, HandleInput } from './index.ts';
import { startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { newDatabaseUrl, onNewConnection } from '../publish/publish.test-utils.ts';
import { testInput, testMcpSettings, testSettings } from '../service.test-utils.ts';
import { createTestIssuer, PERSON, type TestIssuer } from '../tokens.test-utils.ts';
import { recordSpans, settle, type SpanRecorder } from '../tracing.test-utils.ts';
import type { FinishedSpan } from '../spans/index.ts';

let issuer: TestIssuer;
let token: string;

const ontologies = () =>
  new Request('http://localhost/api/v2/ontologies', { headers: { authorization: `Bearer ${token}` } });

let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;

async function statusOf(answer: Promise<Response>): Promise<number> {
  const response = await answer;

  await response.text();

  return response.status;
}

async function newHandle(): Promise<Handle> {
  vi.resetModules();

  return (await import('./index.ts')).handle;
}

const DOWN = 'postgresql://ontology_service:direct@127.0.0.1:1/neondb';

const DOWN_ERROR = 'connect ECONNREFUSED 127.0.0.1:1';

const METHODS = ['query', 'stream', 'transaction', 'snapshot'] as const;

class Database {
  private readonly pool: pg.Pool;
  readonly db: Db;
  private readonly spies: readonly MockInstance[];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    this.pool = createPool(url);
    this.db = createDb(this.pool);
    this.spies = METHODS.map((method) => vi.spyOn(this.db, method));
  }

  get calls(): number {
    return this.spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  }

  get transactions(): number {
    return this.spies[METHODS.indexOf('transaction')]?.mock.calls.length ?? 0;
  }

  async applied(): Promise<string[]> {
    const [found] = await onNewConnection<{ table: string | null }>(
      this.url,
      `SELECT to_regclass('${REGISTRY_SCHEMA}.engine_changes')::text AS table`,
    );

    if (!found?.table) return [];

    return (
      await onNewConnection<{ id: string }>(
        this.url,
        `SELECT id FROM ${REGISTRY_SCHEMA}.engine_changes ORDER BY xmin::text::bigint, id`,
      )
    ).map(({ id }) => id);
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

const ENGINE_CHANGE_IDS = sharedEngineChanges.map((change) => change.id);

let postgres: TestPostgres;
let installed: InstalledOntology;
const opened: Database[] = [];

function open(url: string): Database {
  const database = new Database(url);

  opened.push(database);

  return database;
}

const down = (): Database => open(DOWN);

async function empty(): Promise<Database> {
  return open(await newDatabaseUrl(postgres.url, { empty: true }));
}

async function holdEngineChanges(database: Database): Promise<() => Promise<void>> {
  const holder = new pg.Client({ connectionString: database.url });

  await holder.connect();

  const { rows } = await holder.query<{ table: string | null }>(
    `SELECT to_regclass('${REGISTRY_SCHEMA}.engine_changes')::text AS table`,
  );

  if (rows[0]?.table) {
    await holder.query('BEGIN');

    await holder.query(`LOCK TABLE ${REGISTRY_SCHEMA}.engine_changes IN ACCESS EXCLUSIVE MODE`);
  } else {
    await holder.query('SELECT pg_advisory_lock($1)', [ENGINE_CHANGES_LOCK]);
  }

  let released: Promise<void> | undefined;

  return () => (released ??= holder.end());
}

let direct: Database;
let pooled: Database;
let input: HandleInput;

function use(directDatabase: Database, pooledDatabase: Database): void {
  direct = directDatabase;

  pooled = pooledDatabase;

  input = { ...testInput, db: fallibleOf(pooled.db), directDb: fallibleOf(direct.db), keys: issuer.keys };
}

beforeAll(async () => {
  await import('./index.ts');

  issuer = await createTestIssuer(testSettings.auth);

  token = await issuer.workos();

  postgres = await startPostgres();

  installed = await startInstalled();
});

afterAll(async () => {
  await installed?.stop();

  await postgres?.stop();
});

beforeEach(() => {
  use(down(), down());

  consoleLog = vi.spyOn(console, 'log');

  consoleError = vi.spyOn(console, 'error');
});

afterEach(async () => {
  consoleLog.mockRestore();

  consoleError.mockRestore();

  await Promise.all(opened.splice(0).map((database) => database.end()));
});

describe('the cold start', () => {
  it('service/storage#engine-changes: applies the engine changes once, through the direct connection, before the first answer', async () => {
    const database = await empty();

    use(database, open(database.url));

    const handle = await newHandle();

    expect(await statusOf(handle(ontologies(), input))).toBe(200);

    expect(await direct.applied()).toEqual(ENGINE_CHANGE_IDS);

    expect(direct.transactions).toBe(sharedEngineChanges.length);

    expect(await statusOf(handle(ontologies(), input))).toBe(200);

    expect(direct.transactions).toBe(sharedEngineChanges.length);
    expect(pooled.calls).toBe(2);
  });

  it('service/storage#engine-changes: answers each authenticated request with 503 when the engine changes fail', async () => {
    const handle = await newHandle();

    expect(await statusOf(handle(ontologies(), input))).toBe(503);

    expect(await statusOf(handle(ontologies(), input))).toBe(503);

    expect(direct.calls).toBe(2);
  });

  it('service/storage#engine-changes: tries the engine changes again at the next request after a failure, and applies them once they succeed', async () => {
    const handle = await newHandle();

    expect(await statusOf(handle(ontologies(), input))).toBe(503);

    const database = await empty();

    use(database, open(database.url));

    expect(await statusOf(handle(ontologies(), input))).toBe(200);

    expect(await statusOf(handle(ontologies(), input))).toBe(200);

    expect(await direct.applied()).toEqual(ENGINE_CHANGE_IDS);

    expect(direct.transactions).toBe(sharedEngineChanges.length);
  });

  it('service/storage#engine-changes service/observability#logs: writes 1 request log line for each 503, with the error fields of its answer and the stack of the failure', async () => {
    const handle = await newHandle();

    const answers = [await handle(ontologies(), input), await handle(ontologies(), input)];

    const ids = await Promise.all(
      answers.map(async (answer) => ((await answer.json()) as { errorInstanceId: string }).errorInstanceId),
    );

    const lines = consoleLog.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const stack = expect.stringContaining(DOWN_ERROR);
    const traceId = expect.stringMatching(/^[0-9a-f]{32}$/);

    expect(lines).toEqual([
      {
        errorInstanceId: ids[0],
        route: 'GET /api/v2/ontologies',
        routeParams: {},
        errorName: 'OntologyService:EngineChangesFailed',
        parameters: {},
        stack,
        traceId,
        userId: PERSON,
        callerKind: 'person',
      },
      {
        errorInstanceId: ids[1],
        route: 'GET /api/v2/ontologies',
        routeParams: {},
        errorName: 'OntologyService:EngineChangesFailed',
        parameters: {},
        stack,
        traceId,
        userId: PERSON,
        callerKind: 'person',
      },
    ]);
  });

  it('service/observability#error-reports: reports each 503 to reportFault, with the failure and the errorInstanceId of its answer', async () => {
    const handle = await newHandle();

    const reportFault = vi.fn<NonNullable<HandleInput['reportFault']>>();

    const answer = await handle(ontologies(), { ...input, reportFault });

    const { errorInstanceId } = (await answer.json()) as { errorInstanceId: string };

    expect(reportFault.mock.calls).toEqual([
      [
        expect.objectContaining({ message: DOWN_ERROR }),
        {
          errorInstanceId,
          errorName: 'OntologyService:EngineChangesFailed',
          route: 'GET /api/v2/ontologies',
          userId: PERSON,
          callerKind: 'person',
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          rootSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
    ]);
  });

  it('holds a second request that arrives during the cold start until the engine changes end, and applies them once', async () => {
    const database = await empty();

    use(database, open(database.url));

    const release = await holdEngineChanges(direct);

    const handle = await newHandle();

    const recorder = recordSpans();
    const coldStartOpen: boolean[] = [];

    const record = (response: Response) => {
      coldStartOpen.push(recorder.open().some((span) => span.name === 'cold start'));

      return response;
    };

    try {
      const first = handle(ontologies(), input).then(record);
      const second = handle(ontologies(), input).then(record);

      await recorder.started('cold start', 2);

      await release();

      expect(await statusOf(first)).toBe(200);

      expect(await statusOf(second)).toBe(200);

      expect(coldStartOpen).toEqual([false, false]);

      expect(await direct.applied()).toEqual(ENGINE_CHANGE_IDS);

      expect(direct.transactions).toBe(sharedEngineChanges.length);
    } finally {
      recorder.stop();

      await release();
    }
  });

  it('service/storage#engine-changes: the 503 answer has the error OntologyService:EngineChangesFailed in the OSDK error shape', async () => {
    const handle = await newHandle();

    for (let request = 0; request < 2; request++) {
      const response = await handle(ontologies(), input);

      expect(response.status).toBe(503);

      expect(await response.json()).toEqual({
        errorCode: 'INTERNAL',
        errorName: 'OntologyService:EngineChangesFailed',
        errorInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        parameters: {},
      });
    }
  });

  it('schedules 1 background Function worker pre-warm at cold start when onBackground is given, and spawns none without it', async () => {
    use(open(installed.url), open(installed.url));

    const spawned: import('node:worker_threads').Worker[] = [];
    const onWorker = (worker: import('node:worker_threads').Worker) => void spawned.push(worker);

    process.on('worker', onWorker);

    try {
      const withoutBg = await newHandle();

      expect(await statusOf(withoutBg(ontologies(), input))).toBe(200);

      expect(spawned).toHaveLength(0);

      const pending: Promise<void>[] = [];

      const withBg = await newHandle();

      expect(await statusOf(withBg(ontologies(), { ...input, onBackground: (p) => void pending.push(p) }))).toBe(200);

      expect(pending).toHaveLength(1);

      await Promise.all(pending);

      expect(spawned).toHaveLength(1);

      expect(await statusOf(withBg(ontologies(), { ...input, onBackground: (p) => void pending.push(p) }))).toBe(200);

      expect(pending).toHaveLength(1);
    } finally {
      process.off('worker', onWorker);

      await Promise.all(spawned.map((worker) => worker.terminate()));
    }
  });
});

describe('the trace of the cold start', () => {
  let recorder: SpanRecorder;

  beforeAll(() => {
    recorder = recordSpans();
  });

  beforeEach(() => {
    recorder.reset();

    use(open(installed.url), open(installed.url));
  });

  afterAll(() => recorder.stop());

  const ended = async (): Promise<FinishedSpan[]> => {
    await settle();

    return recorder.spans();
  };

  const rootOf = (spans: readonly FinishedSpan[], traceId: string) =>
    spans.find((span) => span.traceId === traceId && span.parentSpanId === undefined);

  const childNames = (spans: readonly FinishedSpan[], parent: FinishedSpan | undefined) =>
    spans.filter((span) => parent !== undefined && span.parentSpanId === parent.spanId).map((span) => span.name);

  const coldStarts = (spans: readonly FinishedSpan[]) => spans.filter((span) => span.name === 'cold start');

  async function twoDuringOneColdStart(handle: Handle, first: Request, second: Request): Promise<[Response, Response]> {
    const release = await holdEngineChanges(direct);

    const answers = Promise.all([handle(first, input), handle(second, input)]);

    await recorder.started('cold start', 2);

    await release();

    const [one, two] = await answers;

    await Promise.all([one.text(), two.text()]);

    return [one, two];
  }

  it('service/observability#traces: 2 requests during 1 cold start get the roles ran and joined, ontology.cold_start on both roots, and only the run holds the compile', async () => {
    const handle = await newHandle();

    const [one, two] = await twoDuringOneColdStart(handle, ontologies(), ontologies());

    expect([one.status, two.status]).toEqual([200, 200]);

    const spans = await ended();

    const [ran, joined] = ['ran', 'joined'].map((role) =>
      coldStarts(spans).find((span) => span.attributes['cold_start.role'] === role),
    );

    expect(coldStarts(spans)).toHaveLength(2);
    expect(childNames(spans, ran).filter((name) => !name.startsWith('sql'))).toEqual(['ontology compile']);
    expect(childNames(spans, joined)).toEqual([]);
    expect(spans.filter((span) => span.name === 'ontology compile')).toHaveLength(1);

    for (const coldStart of [ran, joined]) {
      const root = rootOf(spans, coldStart?.traceId ?? '');

      expect(coldStart?.parentSpanId).toBe(root?.spanId);
      expect(root?.attributes).toMatchObject({ 'route.key': 'GET /api/v2/ontologies', 'ontology.cold_start': true });
    }

    expect(new Set(spans.map((span) => span.traceId)).size).toBe(2);
  });

  it('service/observability#traces: a request after the cold start passed gets no cold start span, and its root has no ontology.cold_start', async () => {
    const handle = await newHandle();

    await (await handle(ontologies(), input)).text();

    await settle();

    recorder.reset();

    await (await handle(ontologies(), input)).text();

    const spans = await ended();

    expect(coldStarts(spans)).toEqual([]);
    expect(spans.filter((span) => span.name === 'ontology compile')).toEqual([]);

    const [root] = spans.filter((span) => span.parentSpanId === undefined);

    expect(root?.attributes).not.toHaveProperty('ontology.cold_start');
  });

  it('service/observability#traces service/observability#error-reports: a matched request whose cold start fails records 1 trace with a root, and its 503 line and fault report hold the trace ID', async () => {
    use(down(), pooled);

    const handle = await newHandle();

    const reportFault = vi.fn<NonNullable<HandleInput['reportFault']>>();

    const response = await handle(ontologies(), { ...input, reportFault });

    expect(response.status).toBe(503);

    await response.text();

    const spans = await ended();

    const roots = spans.filter((span) => span.parentSpanId === undefined);

    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);

    expect(roots.map((span) => span.attributes)).toEqual([
      {
        'route.key': 'GET /api/v2/ontologies',
        'route.access': 'organization',
        'user.id': PERSON,
        'caller.kind': 'person',
        'ontology.cold_start': true,
        'http.status_code': 503,
        'sentry.op': 'http.server',
      },
    ]);

    const [coldStart] = coldStarts(spans);

    expect({
      parent: coldStart?.parentSpanId,
      role: coldStart?.attributes['cold_start.role'],
      status: coldStart?.status.code,
      type: coldStart?.attributes['error.type'],
    }).toEqual({
      parent: roots[0]?.spanId,
      role: 'ran',
      status: SpanStatusCode.ERROR,
      type: 'Error',
    });

    const traceId = roots[0]?.traceId;
    const lines = consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

    expect(lines).toEqual([expect.objectContaining({ errorName: 'OntologyService:EngineChangesFailed', traceId })]);

    expect(reportFault.mock.calls).toEqual([
      [expect.anything(), expect.objectContaining({ traceId, rootSpanId: roots[0]?.spanId })],
    ]);
  });

  it('service/observability#traces: the request after a failed cold start runs it again, with the role ran', async () => {
    const live = direct;

    use(down(), pooled);

    const handle = await newHandle();

    await (await handle(ontologies(), input)).text();

    use(live, pooled);

    await settle();

    recorder.reset();

    await (await handle(ontologies(), input)).text();

    const spans = await ended();

    expect(coldStarts(spans).map((span) => span.attributes['cold_start.role'])).toEqual(['ran']);
  });
});

describe('the cold start runs only before work that uses the database', () => {
  let mcpInput: HandleInput;
  let recorder: SpanRecorder;

  beforeAll(() => {
    recorder = recordSpans();
  });

  function useWithMcp(directDatabase: Database, pooledDatabase: Database): void {
    use(directDatabase, pooledDatabase);

    mcpInput = { ...input, settings: testMcpSettings, keys: issuer.keys };
  }

  beforeEach(() => {
    recorder.reset();

    useWithMcp(direct, pooled);
  });

  afterAll(() => recorder.stop());

  const calls = () => direct.calls + pooled.calls;
  const NONE = 0;

  async function rpc(method: string, params: object = {}, token = true): Promise<Request> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    };

    if (token) headers['authorization'] = `Bearer ${await issuer.authkit()}`;

    return new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  it('service/storage#engine-changes: an MCP request with no token gets 401 with WWW-Authenticate, and no database call', async () => {
    const handle = await newHandle();

    const response = await handle(await rpc('initialize', {}, false), mcpInput);

    expect([response.status, response.headers.get('www-authenticate')]).toEqual([
      401,
      'Bearer resource_metadata="http://localhost/api/oauth-protected-resource"',
    ]);

    expect(calls()).toEqual(NONE);
  });

  it('service/storage#engine-changes: the OAuth metadata, the client config, and a path with no route answer with no database call', async () => {
    const handle = await newHandle();

    const answers = await Promise.all(
      ['/api/oauth-protected-resource', '/api/ontology-service/v1/client-config', '/no-route'].map((path) =>
        handle(new Request(`http://localhost${path}`), mcpInput),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 404]);
    expect(calls()).toEqual(NONE);
  });

  it('service/storage#engine-changes: a user route runs no cold start: with no token, it gets 401, not 503', async () => {
    const handle = await newHandle();

    expect(await statusOf(handle(new Request('http://localhost/api/v2/admin/users/getCurrent'), mcpInput))).toBe(401);

    expect(calls()).toEqual(NONE);
  });

  it('service/storage#engine-changes: MCP initialize and tools/list with a valid token answer with no database call', async () => {
    const handle = await newHandle();

    const initialize = await handle(
      await rpc('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
      mcpInput,
    );

    const list = await handle(await rpc('tools/list'), mcpInput);

    expect([initialize.status, list.status]).toEqual([200, 200]);

    expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);

    expect(calls()).toEqual(NONE);
  });

  it('service/storage#engine-changes service/observability#traces: the first tool call runs the cold start, with the role ran, in its mcp tool span', async () => {
    const database = await empty();

    useWithMcp(database, open(database.url));

    const handle = await newHandle();

    const response = await handle(
      await rpc('tools/call', { name: 'describe_object_type', arguments: { objectType: 'Account' } }),
      mcpInput,
    );

    await response.text();

    expect(await direct.applied()).toEqual(ENGINE_CHANGE_IDS);

    await settle();

    const spans = recorder.spans();
    const [coldStart] = spans.filter((span) => span.name === 'cold start');
    const tool = spans.find((span) => span.name === 'mcp tool');
    const root = spans.find((span) => span.parentSpanId === undefined);

    expect({
      role: coldStart?.attributes['cold_start.role'],
      parent: coldStart?.parentSpanId,
      coldStart: root?.attributes['ontology.cold_start'],
    }).toEqual({ role: 'ran', parent: tool?.spanId, coldStart: true });
  });

  it('service/storage#engine-changes service/observability#traces: 2 concurrent first tool calls run the cold start once, with the roles ran and joined, each in its mcp tool span', async () => {
    useWithMcp(open(installed.url), open(installed.url));

    const release = await holdEngineChanges(direct);

    const handle = await newHandle();

    const toolCall = () => rpc('tools/call', { name: 'describe_object_type', arguments: { objectType: 'Account' } });

    const answers = Promise.all([
      toolCall().then((request) => handle(request, mcpInput)),
      toolCall().then((request) => handle(request, mcpInput)),
    ]);

    await recorder.started('cold start', 2);

    await release();

    const responses = await answers;

    await Promise.all(responses.map((response) => response.text()));

    await settle();

    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    expect(await direct.applied()).toEqual(ENGINE_CHANGE_IDS);

    expect(direct.transactions).toBe(0);

    const spans = recorder.spans();
    const coldStarts = spans.filter((span) => span.name === 'cold start');

    const summary = coldStarts
      .map((coldStart) => {
        const root = spans.find((span) => span.traceId === coldStart.traceId && span.parentSpanId === undefined);

        return {
          role: coldStart.attributes['cold_start.role'],
          parent: spans.find((span) => span.spanId === coldStart.parentSpanId)?.name,
          rootColdStart: root?.attributes['ontology.cold_start'],
        };
      })
      .sort((a, b) => String(a.role).localeCompare(String(b.role)));

    expect(summary).toEqual([
      { role: 'joined', parent: 'mcp tool', rootColdStart: true },
      { role: 'ran', parent: 'mcp tool', rootColdStart: true },
    ]);
  });

  it('service/storage#engine-changes service/ontology-mcp#errors: a tool call whose cold start fails gets the 503 OntologyService:EngineChangesFailed as its result, 1 log line with the error fields, and 1 fault report of the failure', async () => {
    const handle = await newHandle();

    const reportFault = vi.fn<NonNullable<HandleInput['reportFault']>>();

    const response = await handle(
      await rpc('tools/call', { name: 'describe_object_type', arguments: { objectType: 'Account' } }),
      { ...mcpInput, reportFault },
    );

    const { result } = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };

    expect(response.status).toBe(200);
    expect(result.isError).toBe(true);

    const text = result.content.map((part) => part.text).join('\n');

    expect(text).toContain('OntologyService:EngineChangesFailed');
    expect(pooled.calls).toBe(0);

    expect(reportFault.mock.calls).toEqual([
      [
        expect.objectContaining({ message: DOWN_ERROR }),
        expect.objectContaining({ errorName: 'OntologyService:EngineChangesFailed', route: 'POST /api/mcp' }),
      ],
    ]);

    const lines = consoleLog.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toEqual([
      expect.objectContaining({
        errorName: 'OntologyService:EngineChangesFailed',
        stack: expect.stringContaining(DOWN_ERROR),
      }),
    ]);
  });

  it('service/storage#engine-changes: an unauthenticated request to GET /api/v2/ontologies, an ontology route, or publish gets 401 with no cold start and no database call', async () => {
    const handle = await newHandle();

    const cases = [
      new Request('http://localhost/api/v2/ontologies'),
      new Request('http://localhost/api/v2/ontologies', { headers: { authorization: 'Bearer not-a-jwt' } }),
      new Request('http://localhost/api/v2/ontologies/ri.ontology.main.ontology.x/objectTypes'),
      new Request('http://localhost/api/ontology-service/v1/publish', { method: 'POST', body: '{}' }),
    ];

    for (const request of cases) {
      const response = await handle(request, mcpInput);

      expect(response.status).toBe(401);

      await response.text();
    }

    expect(calls()).toEqual(NONE);
  });

  it('service/storage#engine-changes: an authenticated ontology route runs the cold start first: with the database down, it gets 503', async () => {
    const handle = await newHandle();

    const response = await handle(
      new Request('http://localhost/api/v2/ontologies/ri.ontology.main.ontology.x/objectTypes', {
        headers: { authorization: `Bearer ${token}` },
      }),
      mcpInput,
    );

    expect([response.status, ((await response.json()) as { errorName: string }).errorName]).toEqual([
      503,
      'OntologyService:EngineChangesFailed',
    ]);
  });

  it('service/storage#engine-changes: an authenticated publish route runs the cold start first: with the database down, it gets 503', async () => {
    const handle = await newHandle();

    const response = await handle(
      new Request('http://localhost/api/ontology-service/v1/publish', {
        method: 'POST',
        headers: { authorization: `Bearer ${await issuer.github()}` },
        body: '{}',
      }),
      mcpInput,
    );

    expect([response.status, ((await response.json()) as { errorName: string }).errorName]).toEqual([
      503,
      'OntologyService:EngineChangesFailed',
    ]);
  });
});
