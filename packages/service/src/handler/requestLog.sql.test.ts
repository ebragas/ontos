import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { context, ROOT_CONTEXT, trace, TraceFlags, type Context, type ProxyTracerProvider } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ApiError } from '../errors/index.ts';
import { orThrow } from '../errors/fallible.ts';
import {
  handle,
  handleTrusted,
  settingsFromEnv,
  type HandleInput,
  type ReportFault,
  type Settings,
  type TrustedInput,
} from './index.ts';
import { ONTOLOGY_RID, startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { workosUsers } from '../auth/index.ts';
import { WORKOS_API } from '../auth/users.ts';
import { createDb, createPool, openReader, quoteName, type Db } from '../db/index.ts';
import { openOntology, tableName } from '../ontology/index.ts';
import { grantsOf, NS, stored, twinFunctions, twinIr, USE } from '../ontology/stored.test-utils.ts';
import { insertObjects } from '../publish/publish.test-utils.ts';
import { readerOf, timeLeft, trustedSnapshot } from '../service.test-utils.ts';
import { AUTHKIT_DOMAIN, ORGANIZATION, PERSON } from '../tokens.test-utils.ts';
import { routeRecording, settle } from '../tracing.test-utils.ts';
import { promiseOf, rejecting } from '../db/promise.test-utils.ts';

const base = 'http://localhost';
const rid = ONTOLOGY_RID;
const APPLY = 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply';
const LOAD_OBJECTS = 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects';
const AGGREGATE = 'POST /api/v2/ontologies/{ontology}/objectSets/aggregate';
const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const SET_STATUS = `${NS}set-engagement-status`;
const CLOSE_ACCOUNT = `${NS}close-account-action`;
const TRACE_ID = expect.stringMatching(/^[0-9a-f]{32}$/);
const SPAN_ID = expect.stringMatching(/^[0-9a-f]{16}$/);

const SENT = {
  parameterValue: 'sent-parameter-value',
  propertyValue: 'sent-property-value',
  primaryKey: 'sent-primary-key',
  pageToken: 'sent-page-token',
};

const IR = twinIr('0.4.0');
const VALIDATED = { outcome: 'validated', lockWaitMs: 0, changes: [], versionBefore: 1, versionAfter: 1 };

const PUBLISH_BODY = {
  ir: IR,
  functions: twinFunctions('0.4.0'),
  product: 'twin',
  schemaMigrations: { migrations: [] },
  osdkSet: stored(IR).osdkSet,
  grants: grantsOf(IR),
  validateOnly: true,
};

const ENGAGEMENTS = { type: 'base', objectType: ENGAGEMENT };

const AGGREGATE_BODY = {
  objectSet: ENGAGEMENTS,
  groupBy: [{ type: 'exact', field: 'engagementId' }],
  aggregation: [{ type: 'count', name: 'count' }],
};

const PAGED_BODY = {
  objectSet: {
    type: 'filter',
    objectSet: ENGAGEMENTS,
    where: { type: 'not', value: { type: 'eq', field: 'title', value: SENT.propertyValue } },
  },
  pageSize: 1,
};

let installed: InstalledOntology;
let consoleLog: MockInstance<typeof console.log>;
let tokens: { readonly person: string; readonly publish: string; readonly mcp: string };
let publisher: string;
let input: HandleInput;

function envOf(settings: Settings): Record<string, string> {
  return {
    PRODUCT_RID: settings.productRid,
    ONTOLOGY_ENVIRONMENT: settings.environment,
    WORKOS_CLIENT_ID: settings.auth.workosClientId,
    AUTHKIT_DOMAIN,
    ONTOLOGY_BASE_URL: settings.auth.baseUrl,
    TRUSTED_GITHUB_REPOSITORY: settings.auth.app.repository,
    TRUSTED_GITHUB_ENVIRONMENT: settings.auth.app.environment,
  };
}

let fallibleDb: Db;
let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  installed = await startInstalled();

  pool = createPool(installed.url, { max: 1 });

  fallibleDb = createDb(pool);

  const { issuer, settings } = installed;

  tokens = { person: await issuer.workos(), publish: await issuer.github(), mcp: await issuer.authkit() };

  publisher = `repo:${settings.auth.app.repository}:environment:${settings.auth.app.environment}`;

  input = { ...installed.input, settings: settingsFromEnv(envOf(settings)) };

  const engagements = Array.from({ length: 2_500 }, (_, i) => ({
    engagementId: `e-${i}`,
    accountId: 'a',
    title: `t${i}`,
    amount: i,
    status: `s${i}`,
    createdAt: null,
  }));

  await insertObjects(promiseOf(installed.input.db), ENGAGEMENT, engagements);

  await insertObjects(promiseOf(installed.input.db), ACCOUNT, [
    { accountId: SENT.primaryKey, name: 'Account', phase: 'open' },
  ]);
});

afterAll(async () => {
  await pool?.end();

  await installed?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => consoleLog.mockRestore());

function lines(...alsoSent: string[]): unknown[] {
  const text = consoleLog.mock.calls.map(([line]) => String(line));

  for (const value of [...Object.values(SENT), ...alsoSent]) expect(text.join('\n')).not.toContain(value);

  return text.map((line) => JSON.parse(line));
}

function publishRequest(): Request {
  return new Request(`${base}/api/ontology-service/v1/publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.publish}` },
    body: JSON.stringify(PUBLISH_BODY),
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`${base}/api/v2/ontologies/${rid}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.person}` },
    body: JSON.stringify(body),
  });
}

async function failed(request: Request, status: number, handleInput: HandleInput = input): Promise<string> {
  const response = await handle(request, handleInput);

  const body = (await response.json()) as { errorInstanceId: string };

  expect(response.status).toBe(status);

  return body.errorInstanceId;
}

async function realPageToken(): Promise<string> {
  const response = await handle(post('/objectSets/loadObjects', PAGED_BODY), input);

  const { nextPageToken } = (await response.json()) as { nextPageToken?: string };

  consoleLog.mockClear();

  if (nextPageToken === undefined) throw new Error('The first page has no nextPageToken.');

  return nextPageToken;
}

function sql<Row extends object>(text: string): Promise<Row[]> {
  return promiseOf(installed.input.db).query<Row>({ text, values: [] });
}

async function withEngagementsMoved<T>(run: () => Promise<T>): Promise<T> {
  const name = tableName(ENGAGEMENT);

  await sql(`ALTER TABLE ontology_1_objects.${quoteName(name)} RENAME TO ${quoteName(`${name}_moved`)}`);

  try {
    return await run();
  } finally {
    await sql(`ALTER TABLE ontology_1_objects.${quoteName(`${name}_moved`)} RENAME TO ${quoteName(name)}`);
  }
}

async function trustedInput(): Promise<Omit<TrustedInput, 'db'>> {
  const caller = { user: PERSON, kind: 'person' as const, organization: ORGANIZATION, permissions: [USE] };

  const view = await rejecting(openOntology(installed.input.db, rid, caller));

  const { reader } = await orThrow(openReader(fallibleDb, view.schemas, view.personAttributes, caller));

  return { reader, ontology: view.ontology, caller, checkWrite: timeLeft };
}

async function trusted(request: Request): Promise<Response> {
  const rest = await trustedInput();

  return promiseOf(installed.input.db).snapshot((db) => handleTrusted(request, { db: trustedSnapshot(db), ...rest }));
}

describe('the request log', () => {
  it('service/observability#logs: a request with no error has no error field', async () => {
    const response = await handle(publishRequest(), input);

    await response.text();

    expect(response.status).toBe(200);
    expect(lines()).toEqual([{ userId: publisher, callerKind: 'publish', publish: VALIDATED, traceId: TRACE_ID }]);
  });

  it('service/observability#logs: holds the errorInstanceId of the error body, the route, and the stack, on an error', async () => {
    const response = await handle(
      new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, { method: 'POST' }),
      input,
    );

    const body = (await response.json()) as { errorInstanceId: string };

    expect(lines()).toEqual([
      {
        traceId: TRACE_ID,
        errorInstanceId: body.errorInstanceId,
        route: LOAD_OBJECTS,
        routeParams: { ontology: rid },
        errorName: 'MissingCredentials',
        parameters: {},
        stack: expect.stringContaining('MissingCredentials'),
      },
    ]);
  });

  it('service/observability#logs: InvalidParameterValue keeps parameterId, and redacts parameterValue', async () => {
    const errorInstanceId = await failed(
      post(`/actions/${CREATE_ENGAGEMENT}/apply`, { parameters: { amount: SENT.parameterValue } }),
      400,
    );

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId,
        route: APPLY,
        routeParams: { ontology: rid, action: CREATE_ENGAGEMENT },
        errorName: 'InvalidParameterValue',
        parameters: { parameterBaseType: 'Double', parameterId: 'amount', parameterValue: '<redacted>' },
        stack: expect.stringContaining('InvalidParameterValue'),
      },
    ]);
  });

  it('service/observability#logs: ParametersNotFound keeps its ID lists', async () => {
    const errorInstanceId = await failed(
      post(`/actions/${CREATE_ENGAGEMENT}/apply`, { parameters: { amont: 1 } }),
      400,
    );

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId,
        route: APPLY,
        routeParams: { ontology: rid, action: CREATE_ENGAGEMENT },
        errorName: 'ParametersNotFound',
        parameters: {
          actionType: CREATE_ENGAGEMENT,
          unknownParameterIds: ['amont'],
          configuredParameterIds: ['accountId', 'amount', 'engagementId', 'title'],
        },
        stack: expect.stringContaining('ParametersNotFound'),
      },
    ]);
  });

  it('service/observability#logs: ObjectNotFound redacts primaryKey', async () => {
    const errorInstanceId = await failed(
      post(`/actions/${SET_STATUS}/apply`, { parameters: { objectToModifyParameter: SENT.primaryKey, status: 'won' } }),
      404,
    );

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId,
        route: APPLY,
        routeParams: { ontology: rid, action: SET_STATUS },
        errorName: 'ObjectNotFound',
        parameters: { primaryKey: '<redacted>' },
        stack: expect.stringContaining('ObjectNotFound'),
      },
    ]);
  });

  it('service/observability#logs: InvalidPageToken redacts pageToken', async () => {
    const errorInstanceId = await failed(
      post('/objectSets/loadObjects', { objectSet: ENGAGEMENTS, pageToken: SENT.pageToken }),
      400,
    );

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId,
        route: LOAD_OBJECTS,
        routeParams: { ontology: rid },
        errorName: 'InvalidPageToken',
        parameters: { pageToken: '<redacted>' },
        stack: expect.stringContaining('InvalidPageToken'),
      },
    ]);
  });

  it('service/observability#logs: InvalidPropertyValue redacts propertyValue', async () => {
    const where = { type: 'eq', field: 'amount', value: SENT.propertyValue };

    const errorInstanceId = await failed(
      post('/objectSets/loadObjects', { objectSet: { type: 'filter', objectSet: ENGAGEMENTS, where } }),
      400,
    );

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId,
        route: LOAD_OBJECTS,
        routeParams: { ontology: rid },
        errorName: 'InvalidPropertyValue',
        parameters: { property: 'amount', propertyBaseType: 'Double', propertyValue: '<redacted>' },
        stack: expect.stringContaining('InvalidPropertyValue'),
      },
    ]);
  });

  it('service/observability#logs: Default:InvalidArgument of a where keeps field, and redacts the refused query', async () => {
    const where = { type: 'in', field: 'amount', value: SENT.propertyValue };
    const request = post('/objectSets/loadObjects', { objectSet: { type: 'filter', objectSet: ENGAGEMENTS, where } });

    const response = await handle(request, input);

    const body = (await response.json()) as { errorInstanceId: string; parameters: unknown };

    expect(response.status).toBe(400);
    expect(body.parameters).toEqual({ field: 'where', query: where });

    expect(lines()).toEqual([
      expect.objectContaining({
        errorInstanceId: body.errorInstanceId,
        errorName: 'Default:InvalidArgument',
        parameters: { field: 'where', query: '<redacted>' },
      }),
    ]);
  });

  it('service/observability#logs: FunctionExecutionFailed keeps functionRid, functionVersion, and message, and the stack is the stack of the Function', async () => {
    const response = await handle(
      post(`/actions/${CLOSE_ACCOUNT}/apply`, { parameters: { account: SENT.primaryKey, reason: 'test-throw' } }),
      input,
    );

    const body = (await response.json()) as { errorInstanceId: string; parameters: unknown };

    expect(response.status).toBe(400);

    expect(body.parameters).toEqual({
      functionRid: expect.stringMatching(/^ri\./),
      functionVersion: '1.0.0',
      message: 'test plain error',
    });

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId: body.errorInstanceId,
        route: APPLY,
        routeParams: { ontology: rid, action: CLOSE_ACCOUNT },
        errorName: 'FunctionExecutionFailed',
        parameters: body.parameters,
        stack: expect.stringMatching(/^Error: test plain error\n/),
      },
    ]);
  });

  it('service/observability#logs: a fault of the route has the errorName Default:Internal, empty parameters, and the stack of the fault', async () => {
    const errorInstanceId = await withEngagementsMoved(() =>
      failed(post('/objectSets/aggregate', AGGREGATE_BODY), 500),
    );

    expect(lines()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        errorInstanceId,
        route: AGGREGATE,
        routeParams: { ontology: rid },
        errorName: 'Default:Internal',
        parameters: {},
        stack: expect.stringContaining('does not exist'),
      },
    ]);
  });

  it('service/observability#logs: with the setting off, holds no token and no request body', async () => {
    const request = new Request(`${base}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: '{"secret":"body"}',
    });

    await (await handle(request, input)).text();

    expect(consoleLog.mock.calls.join('\n')).not.toMatch(/secret/);
  });

  it('service/observability#logs: with the setting off, the line of a success holds no argument value', async () => {
    const pageToken = await realPageToken();

    const response = await handle(post('/objectSets/loadObjects', { ...PAGED_BODY, pageToken }), input);

    await response.text();

    expect(response.status).toBe(200);
    expect(lines(pageToken)).toEqual([{ userId: PERSON, callerKind: 'person', traceId: TRACE_ID, ontologyVersion: 1 }]);
  });
});

describe('a path with no route', () => {
  it('service/observability#logs: gets 404 and 1 request log line with no field', async () => {
    expect((await handle(new Request(`${base}/api/v2/nothing`), input)).status).toBe(404);

    expect(lines()).toEqual([{}]);
  });
});

describe('the request body setting', () => {
  let withBodies: HandleInput;

  beforeAll(() => {
    withBodies = { ...input, settings: settingsFromEnv({ ...envOf(installed.settings), LOG_REQUEST_BODIES: 'true' }) };
  });

  const linesWithBodies = () => consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

  it('service/deployment#deployment-files service/observability#logs: with LOG_REQUEST_BODIES true, the line of a publish holds its body', async () => {
    const response = await handle(publishRequest(), withBodies);

    await response.text();

    expect(response.status).toBe(200);

    expect(linesWithBodies()).toEqual([
      { userId: publisher, callerKind: 'publish', traceId: TRACE_ID, publish: VALIDATED, body: PUBLISH_BODY },
    ]);
  });

  it('service/observability#logs: the line of a success on an OSDK route holds its body', async () => {
    const pageToken = await realPageToken();

    const body = { ...PAGED_BODY, pageToken };

    const response = await handle(post('/objectSets/loadObjects', body), withBodies);

    await response.text();

    expect(response.status).toBe(200);

    expect(linesWithBodies()).toEqual([
      { userId: PERSON, callerKind: 'person', traceId: TRACE_ID, ontologyVersion: 1, body },
    ]);
  });

  it('service/observability#logs: the line of an error holds the body, and its parameters stay redacted', async () => {
    const errorInstanceId = await failed(
      post(`/actions/${CREATE_ENGAGEMENT}/apply`, { parameters: { amount: SENT.parameterValue } }),
      400,
      withBodies,
    );

    expect(linesWithBodies()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        ontologyVersion: 1,
        body: { parameters: { amount: 'sent-parameter-value' } },
        errorInstanceId,
        route: APPLY,
        routeParams: { ontology: rid, action: CREATE_ENGAGEMENT },
        errorName: 'InvalidParameterValue',
        parameters: { parameterBaseType: 'Double', parameterId: 'amount', parameterValue: '<redacted>' },
        stack: expect.stringContaining('InvalidParameterValue'),
      },
    ]);
  });

  it('service/observability#logs: the line of a success on /api/mcp holds its JSON-RPC body', async () => {
    const message = { jsonrpc: '2.0', id: 1, method: 'ping' };

    const request = new Request(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.mcp}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify(message),
    });

    const response = await handle(request, {
      ...withBodies,
      settings: settingsFromEnv({ ...envOf(installed.settings), LOG_REQUEST_BODIES: 'true', ONTOLOGY_MCP: 'true' }),
    });

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    expect(linesWithBodies()).toEqual([
      {
        userId: PERSON,
        callerKind: 'person',
        traceId: TRACE_ID,
        mcp: {
          clientId: 'https://claude.ai/.well-known/oauth-client-metadata.json',
          method: 'ping',
          protocolVersion: '2025-11-25',
        },
        body: { jsonrpc: '2.0', id: 1, method: 'ping' },
      },
    ]);
  });

  it('service/observability#logs: with the setting on, the line of a request that fails the token check holds no body', async () => {
    const request = new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      method: 'POST',
      body: '{"where":{"type":"eq","field":"stage","value":"sent"}}',
    });

    const response = await handle(request, withBodies);

    expect(response.status).toBe(401);

    const body = (await response.json()) as { errorInstanceId: string };

    expect(linesWithBodies()).toEqual([
      {
        traceId: TRACE_ID,
        errorInstanceId: body.errorInstanceId,
        route: LOAD_OBJECTS,
        routeParams: { ontology: rid },
        errorName: 'MissingCredentials',
        parameters: {},
        stack: expect.stringContaining('MissingCredentials'),
      },
    ]);
  });

  it('service/observability#logs: with the setting on, the line holds the body and not the token', async () => {
    const response = await handle(publishRequest(), withBodies);

    await response.text();

    expect(response.status).toBe(200);
    expect(consoleLog.mock.calls.join('\n')).not.toContain(tokens.publish);

    expect(linesWithBodies()).toEqual([
      { userId: publisher, callerKind: 'publish', traceId: TRACE_ID, publish: VALIDATED, body: PUBLISH_BODY },
    ]);
  });
});

describe("the error line of a request of a Function's client", () => {
  it('service/observability#logs: writes no line for a request that succeeds', async () => {
    const response = await trusted(new Request(`${base}/api/v2/ontologies/${rid}/fullMetadata`));

    await response.text();

    expect(response.status).toBe(200);
    expect(lines()).toEqual([]);
  });

  it('service/observability#logs: a failed read writes 1 line with the errorInstanceId, the route, the redacted parameters, and the stack', async () => {
    const request = new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, {
      method: 'POST',
      body: JSON.stringify({ objectSet: ENGAGEMENTS, pageToken: SENT.pageToken }),
    });

    const response = await trusted(request);

    expect(response.status).toBe(400);

    const { errorInstanceId } = (await response.json()) as { errorInstanceId: string };

    expect(lines()).toEqual([
      {
        errorInstanceId,
        route: LOAD_OBJECTS,
        routeParams: { ontology: rid },
        errorName: 'InvalidPageToken',
        parameters: { pageToken: '<redacted>' },
        traceId: TRACE_ID,
        stack: expect.stringContaining('InvalidPageToken'),
      },
    ]);
  });

  it('service/observability#logs: a fault writes 1 line with Default:Internal and the stack of the fault', async () => {
    const request = new Request(`${base}/api/v2/ontologies/${rid}/objectSets/aggregate`, {
      method: 'POST',
      body: JSON.stringify(AGGREGATE_BODY),
    });

    const response = await withEngagementsMoved(() => trusted(request));

    expect(response.status).toBe(500);

    const { errorInstanceId } = (await response.json()) as { errorInstanceId: string };

    expect(lines()).toEqual([
      {
        errorInstanceId,
        route: AGGREGATE,
        routeParams: { ontology: rid },
        errorName: 'Default:Internal',
        parameters: {},
        traceId: TRACE_ID,
        stack: expect.stringContaining('does not exist'),
      },
    ]);
  });
});

describe('the fault reports', () => {
  let reportFault: Mock<ReportFault>;

  beforeEach(() => {
    reportFault = vi.fn<ReportFault>();
  });

  async function reported(request: Request, status: number, handleInput: HandleInput = input): Promise<string> {
    return failed(request, status, { ...handleInput, reportFault });
  }

  it('service/observability#error-reports reports a fault of a route once, with the errorInstanceId of its 500, the route, the Ontology version, and the user ID', async () => {
    const errorInstanceId = await withEngagementsMoved(() =>
      reported(post('/objectSets/aggregate', AGGREGATE_BODY), 500),
    );

    expect(reportFault.mock.calls).toEqual([
      [
        expect.objectContaining({ message: expect.stringContaining('does not exist') }),
        {
          errorInstanceId,
          errorName: 'Default:Internal',
          route: AGGREGATE,
          ontologyVersion: 1,
          userId: PERSON,
          callerKind: 'person',
          traceId: TRACE_ID,
          rootSpanId: SPAN_ID,
        },
      ],
    ]);
  });

  it('service/observability#error-reports: reports an ApiError that gets a 5xx', async () => {
    let reads = 0;

    const network = setupServer(
      http.all(`${WORKOS_API}/*`, () => {
        reads += 1;

        return new HttpResponse(null, { status: 500 });
      }),
    );

    network.listen({ onUnhandledRequest: 'error' });

    try {
      const errorInstanceId = await reported(post('/objectSets/loadObjects', { objectSet: ENGAGEMENTS }), 503, {
        ...input,
        users: workosUsers('sk_test_request_log'),
      });

      expect(reportFault.mock.calls).toEqual([
        [
          expect.objectContaining({
            constructor: ApiError,
            status: 503,
            errorName: 'OntologyService:WorkosUnavailable',
          }),
          {
            errorInstanceId,
            errorName: 'OntologyService:WorkosUnavailable',
            route: LOAD_OBJECTS,
            userId: PERSON,
            callerKind: 'person',
            traceId: TRACE_ID,
            rootSpanId: SPAN_ID,
          },
        ],
      ]);

      expect(reads).toBeGreaterThan(0);
    } finally {
      network.close();
    }
  });

  it('service/observability#error-reports: reports no error that gets a 4xx', async () => {
    await reported(
      post(`/actions/${SET_STATUS}/apply`, { parameters: { objectToModifyParameter: 'deal-1', status: 'won' } }),
      404,
    );

    await reported(new Request(`${base}/api/v2/ontologies/${rid}/objectSets/loadObjects`, { method: 'POST' }), 401);

    expect(reportFault).not.toHaveBeenCalled();
  });

  it('service/observability#error-reports: reports nothing for a request with no fault', async () => {
    const response = await handle(publishRequest(), { ...input, reportFault });

    await response.text();

    expect(response.status).toBe(200);
    expect(reportFault).not.toHaveBeenCalled();
  });
});

describe('the fault report of a body that a fault ends after its first byte', () => {
  let reportFault: Mock<ReportFault>;
  let bodyPending: Mock<NonNullable<HandleInput['bodyPending']>>;

  beforeEach(() => {
    reportFault = vi.fn<ReportFault>();

    bodyPending = vi.fn<NonNullable<HandleInput['bodyPending']>>();
  });

  async function endActiveBackends(): Promise<number> {
    const ended = await sql<{ ok: boolean }>(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
    );

    return ended.length;
  }

  async function served(): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; settled: Promise<void> }> {
    const response = await handle(post('/objectSets/aggregate', AGGREGATE_BODY), {
      ...input,
      reportFault,
      bodyPending,
    });

    expect(response.status).toBe(200);
    expect(bodyPending).toHaveBeenCalledTimes(1);

    const [[settled]] = bodyPending.mock.calls as [[Promise<void>]];
    const reader = readerOf(response);

    expect((await reader.read()).done).toBe(false);

    return { reader, settled };
  }

  async function cut(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
    expect(await endActiveBackends()).toBeGreaterThan(0);

    try {
      for (;;) if ((await reader.read()).done) return undefined;
    } catch (error) {
      return error;
    }
  }

  it('service/observability#error-reports: reports the fault once, with the route, the Ontology version, and the user ID, and no errorInstanceId', async () => {
    const { reader, settled } = await served();

    const failure = await cut(reader);

    await settled;

    expect(failure).toBeInstanceOf(Error);

    expect(reportFault.mock.calls).toEqual([
      [
        expect.any(Error),
        {
          errorName: 'Default:Internal',
          route: AGGREGATE,
          ontologyVersion: 1,
          userId: PERSON,
          callerKind: 'person',
          traceId: TRACE_ID,
          rootSpanId: SPAN_ID,
        },
      ],
    ]);
  });

  it('service/observability#error-reports: reports nothing when the client stops reading', async () => {
    const { reader, settled } = await served();

    expect(await endActiveBackends()).toBeGreaterThan(0);

    await reader.cancel();

    await settled;

    expect(reportFault).not.toHaveBeenCalled();
  });

  it('settles after a report that throws, and does not reject', async () => {
    const reporter: { fault: ReportFault } = {
      fault: () => {
        throw new Error('the report failed');
      },
    };

    reportFault = vi.spyOn(reporter, 'fault');

    const { reader, settled } = await served();

    expect(await cut(reader)).toBeInstanceOf(Error);

    await expect(settled).resolves.toBeUndefined();

    expect(reportFault).toHaveBeenCalledTimes(1);
  });

  it('gives bodyPending a promise that settles at once for a 500 with a static body, and reports that fault once', async () => {
    await withEngagementsMoved(() =>
      failed(post('/objectSets/aggregate', AGGREGATE_BODY), 500, { ...input, reportFault, bodyPending }),
    );

    await bodyPending.mock.calls[0]?.[0];

    expect(bodyPending).toHaveBeenCalledTimes(1);
    expect(reportFault).toHaveBeenCalledTimes(1);
    expect(reportFault.mock.calls[0]?.[1]).toHaveProperty('errorInstanceId');
  });
});

describe('the trace ID with no tracer provider', () => {
  let provider: ReturnType<ProxyTracerProvider['getDelegate']>;

  beforeAll(() => {
    provider = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();

    trace.disable();

    context.disable();

    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(() => {
    context.disable();

    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

    trace.setGlobalTracerProvider(provider);
  });

  it('service/observability#logs: the line has no traceId, and a fault report has no trace ID', async () => {
    const reportFault = vi.fn<ReportFault>();

    const response = await handle(publishRequest(), input);

    await response.text();

    expect(response.status).toBe(200);

    await withEngagementsMoved(() =>
      failed(post('/objectSets/aggregate', AGGREGATE_BODY), 500, { ...input, reportFault }),
    );

    expect(lines()[0]).toEqual({ userId: publisher, callerKind: 'publish', publish: VALIDATED });
    expect(reportFault.mock.calls[0]?.[1]).not.toHaveProperty('traceId');
    expect(reportFault.mock.calls[0]?.[1]).not.toHaveProperty('rootSpanId');
  });
});

describe('the trace ID with a tracer provider', () => {
  const recorder = () => {
    if (routeRecording.recorder === undefined) throw new Error('The sql project registers no span recorder.');

    return routeRecording.recorder;
  };

  const root = () =>
    recorder()
      .spans()
      .find((span) => span.parentSpanId === undefined && span.attributes['route.key'] !== undefined);

  it('service/observability#logs: traceId of the line is the trace ID of the root span', async () => {
    const response = await handle(publishRequest(), input);

    await response.text();

    await settle();

    expect(root()?.traceId).toMatch(/^[0-9a-f]{32}$/);

    expect(lines()).toEqual([
      { userId: publisher, callerKind: 'publish', publish: VALIDATED, traceId: root()?.traceId },
    ]);
  });

  describe("the error line of a request of a Function's client", () => {
    const traceIdOfLine = async (parent: Context): Promise<unknown> => {
      const request = new Request(`${base}/api/v2/ontologies/${rid}/objectSets/aggregate`, {
        method: 'POST',
        body: JSON.stringify(AGGREGATE_BODY),
      });

      const response = await withEngagementsMoved(() => context.with(parent, () => trusted(request)));

      await response.text();

      expect(response.status).toBe(500);

      return (lines()[0] as Record<string, unknown> | undefined)?.['traceId'];
    };

    const unsampled = (): Context =>
      trace.setSpan(
        ROOT_CONTEXT,
        trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: TraceFlags.NONE }),
      );

    it('service/observability#logs: holds the traceId of a root span that records', async () => {
      const parent = trace.getTracer('requestLog').startSpan('the apply of a Function');

      try {
        expect(await traceIdOfLine(trace.setSpan(ROOT_CONTEXT, parent))).toBe(parent.spanContext().traceId);
      } finally {
        parent.end();
      }
    });

    it('service/observability#logs: holds no traceId under a root span that the sampler left out', async () => {
      expect(await traceIdOfLine(unsampled())).toBeUndefined();
    });
  });

  it('a fault report holds the trace ID and the span ID of the root span', async () => {
    const reportFault = vi.fn<ReportFault>();

    const errorInstanceId = await withEngagementsMoved(() =>
      failed(post('/objectSets/aggregate', AGGREGATE_BODY), 500, { ...input, reportFault }),
    );

    await settle();

    expect(root()?.spanId).toMatch(/^[0-9a-f]{16}$/);

    expect(reportFault.mock.calls.map(([, fields]) => fields)).toEqual([
      {
        errorInstanceId,
        errorName: 'Default:Internal',
        route: AGGREGATE,
        ontologyVersion: 1,
        userId: PERSON,
        callerKind: 'person',
        traceId: root()?.traceId,
        rootSpanId: root()?.spanId,
      },
    ]);
  });
});
