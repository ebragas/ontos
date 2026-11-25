import type { Server } from 'node:http';
import { http, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handle, inputFromEnv, type FaultFields, type HandleInput, type Settings } from './handler/index.ts';
import { createNodeServer } from './node.ts';
import type { Db } from './db/promise.test-utils.ts';
import { STUB_ACCESS_TOKEN, stubAuthkitToken, type AuthkitTokenStub } from './authkitToken.test-utils.ts';
import { emptyDb, noDb, testEnv, testInput, testMcpSettings, testSettings } from './service.test-utils.ts';
import { createTestIssuer } from './tokens.test-utils.ts';
import { recordSpans, settle, type SpanRecorder } from './tracing.test-utils.ts';
import { closeServer, listenLocal } from './localServer.test-utils.ts';
import { fallibleOf } from './db/promise.test-utils.ts';

const CANARY_SECRET = 'CANARY-secret-7f3a';
const CLIENT_ID = 'client_01JCANARYAPP0000000000000';
const BASIC = `Basic ${btoa(`${CLIENT_ID}:${CANARY_SECRET}`)}`;
const STOCK_SCOPES = 'api:read-data api:write-data api:use-ontologies-read api:use-ontologies-write';
const FORM = 'application/x-www-form-urlencoded';

let stub: AuthkitTokenStub;
let server: Server;
let url: string;
const faults: [unknown, FaultFields][] = [];

const input: HandleInput = {
  ...testInput,
  db: fallibleOf(noDb),
  directDb: fallibleOf(emptyDb),
  settings: { ...testMcpSettings, logRequestBodies: true },
  reportFault: (error, fields) => void faults.push([error, fields]),
};

const network = setupServer();
let local: string;

beforeAll(async () => {
  server = createNodeServer(input);

  local = await listenLocal(server);

  url = `${local}/multipass/api/oauth2/token`;

  network.listen({ onUnhandledRequest: 'error' });
});

afterAll(async () => {
  network.close();

  await closeServer(server);
});

beforeEach(() => {
  stub = stubAuthkitToken();

  network.resetHandlers(
    stub.handler,
    http.all(`${local}/*`, () => passthrough()),
  );

  faults.length = 0;
});

function postToken(
  form: Record<string, string>,
  headers: Record<string, string> = { authorization: BASIC },
): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': FORM, ...headers }, body: new URLSearchParams(form) });
}

function postRaw(body: string): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': FORM, authorization: BASIC }, body });
}

async function answerOf(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

describe('the token route', () => {
  it('service/authentication#the-token-route: needs no bearer token, and serves a Basic header and a body with the client secret', async () => {
    const basic = await answerOf(await postToken({ grant_type: 'client_credentials' }));

    const post = await answerOf(
      await postToken({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CANARY_SECRET }, {}),
    );

    expect([basic, post]).toEqual([
      { status: 200, body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 } },
      { status: 200, body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 } },
    ]);
  });

  it('service/authentication#the-token-route: refuses each grant other than client_credentials with 400 unsupported_grant_type, and calls no WorkOS', async () => {
    const answers = [];

    for (const form of [
      { grant_type: 'authorization_code', code: 'x' },
      { grant_type: 'refresh_token', refresh_token: 'x' },
      { grant_type: 'password' },
      {},
    ]) {
      answers.push(await answerOf(await postToken(form)));
    }

    expect(answers).toEqual([
      { status: 400, body: { error: 'unsupported_grant_type' } },
      { status: 400, body: { error: 'unsupported_grant_type' } },
      { status: 400, body: { error: 'unsupported_grant_type' } },
      { status: 400, body: { error: 'unsupported_grant_type' } },
    ]);

    expect(stub.calls).toEqual([]);
  });

  it('service/authentication#the-token-route: removes each api: scope, keeps each other scope in its order, and sends no scope when none is left', async () => {
    await postToken({ grant_type: 'client_credentials', scope: STOCK_SCOPES });

    await postToken({ grant_type: 'client_credentials', scope: 'ontology:read api:read-data ontology:write' });

    await postToken({ grant_type: 'client_credentials' });

    expect(stub.calls.map((call) => call.form)).toEqual([
      [['grant_type', 'client_credentials']],
      [
        ['grant_type', 'client_credentials'],
        ['scope', 'ontology:read ontology:write'],
      ],
      [['grant_type', 'client_credentials']],
    ]);
  });

  it('service/authentication#the-token-route: sends the Authorization header and the 4 known form fields to the token route of the AuthKit domain', async () => {
    await postToken({ grant_type: 'client_credentials', scope: `${STOCK_SCOPES} ontology:read` });

    await postToken({ client_id: CLIENT_ID, grant_type: 'client_credentials', client_secret: CANARY_SECRET }, {});

    expect(stub.calls).toEqual([
      {
        url: 'https://test-app.authkit.app/oauth2/token',
        method: 'POST',
        authorization: BASIC,
        contentType: FORM,
        form: [
          ['grant_type', 'client_credentials'],
          ['scope', 'ontology:read'],
        ],
      },
      {
        url: 'https://test-app.authkit.app/oauth2/token',
        method: 'POST',
        authorization: null,
        contentType: FORM,
        form: [
          ['client_id', CLIENT_ID],
          ['grant_type', 'client_credentials'],
          ['client_secret', CANARY_SECRET],
        ],
      },
    ]);
  });

  it('service/authentication#the-token-route: drops each other form field, such as Grant_Type or username, with no error', async () => {
    const body = [
      'grant_type=client_credentials',
      'Grant_Type=password',
      'GRANT_TYPE=refresh_token',
      'grant_type%5B%5D=password',
      'grant_type+=password',
      'username=a',
      'password=b',
      'refresh_token=c',
      'audience=d',
      `client_id=${CLIENT_ID}`,
    ].join('&');

    expect(await answerOf(await postRaw(body))).toEqual({
      status: 200,
      body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 },
    });

    expect(stub.calls.map((call) => call.form)).toEqual([
      [
        ['grant_type', 'client_credentials'],
        ['client_id', CLIENT_ID],
      ],
    ]);
  });

  it('service/authentication#the-token-route: returns the status and the body of the WorkOS answer', async () => {
    stub.answer = () =>
      Response.json({ error: 'invalid_client', error_description: 'Invalid client secret.' }, { status: 401 });

    const refused = await answerOf(await postToken({ grant_type: 'client_credentials' }));

    stub.answer = () =>
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });

    const gateway = await postToken({ grant_type: 'client_credentials' });

    stub.answer = () => Response.json(STUB_ACCESS_TOKEN);

    const passed = await answerOf(await postToken({ grant_type: 'client_credentials' }));

    expect({ refused, gateway: { status: gateway.status, text: await gateway.text() }, passed }).toEqual({
      refused: { status: 401, body: { error: 'invalid_client', error_description: 'Invalid client secret.' } },
      gateway: { status: 502, text: '<html>Bad gateway</html>' },
      passed: { status: 200, body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 } },
    });
  });

  it('service/authentication#the-token-route: answers 503 temporarily_unavailable on a network error of WorkOS', async () => {
    stub.answer = () => 'network error';

    expect(await answerOf(await postToken({ grant_type: 'client_credentials' }))).toEqual({
      status: 503,
      body: { error: 'temporarily_unavailable' },
    });
  });

  describe('when WorkOS gives no answer in 5 seconds', () => {
    let answer: { status: number; body: unknown };
    let waited = 0;
    let recordedFaults: string[] = [];

    beforeAll(async () => {
      faults.length = 0;

      stub.answer = () => 'no answer';

      const start = Date.now();

      answer = await answerOf(await postToken({ grant_type: 'client_credentials' }));

      waited = Date.now() - start;

      recordedFaults = faults.map(([, fields]) => fields.errorName);
    });

    it('service/authentication#the-token-route: answers 503 temporarily_unavailable when WorkOS gives no answer in 5 seconds', () => {
      expect(answer).toEqual({ status: 503, body: { error: 'temporarily_unavailable' } });
      expect(recordedFaults).toEqual(['OntologyService:WorkosUnavailable']);
      expect(waited).toBeGreaterThanOrEqual(5_000);
    });
  });

  it('service/code-layout#seams: the route gets the raw request: a form body that is not JSON reaches WorkOS as it was sent, and a Basic header gets no bearer check', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': FORM, authorization: BASIC },
      body: 'grant_type=client_credentials&scope=%7B%22not%22%3A+json',
    });

    expect(await answerOf(response)).toEqual({
      status: 200,
      body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 },
    });

    expect(stub.calls.map((call) => call.form)).toEqual([
      [
        ['grant_type', 'client_credentials'],
        ['scope', '{"not": json'],
      ],
    ]);
  });

  it('service/authentication#the-token-route: refuses a parameter that the body holds more than once with 400 invalid_request, and calls no WorkOS', async () => {
    const answers = [];

    for (const body of [
      'grant_type=client_credentials&grant_type=refresh_token&refresh_token=X',
      'grant_type=client_credentials&grant_type=password&username=a&password=b',
      'grant_type=client_credentials&scope=a&scope=b',
      `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CANARY_SECRET}&client_secret=x`,
    ]) {
      answers.push(await answerOf(await postRaw(body)));
    }

    expect(answers).toEqual([
      { status: 400, body: { error: 'invalid_request' } },
      { status: 400, body: { error: 'invalid_request' } },
      { status: 400, body: { error: 'invalid_request' } },
      { status: 400, body: { error: 'invalid_request' } },
    ]);

    expect(stub.calls).toEqual([]);
  });

  it('service/authentication#the-token-route: reads a form body of at most 4096 bytes, and refuses 1 byte more with 400 invalid_request', async () => {
    const start = `grant_type=client_credentials&client_id=`;

    const atLimit = await answerOf(await postRaw(start + 'a'.repeat(4096 - start.length)));

    const over = await answerOf(await postRaw(start + 'a'.repeat(4097 - start.length)));

    expect({ atLimit, over }).toEqual({
      atLimit: { status: 200, body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 } },
      over: { status: 400, body: { error: 'invalid_request' } },
    });

    expect(stub.calls.map((call) => call.form[1]?.[1].length)).toEqual([4056]);
  });

  it('service/authentication#the-token-route: refuses a body that it cannot read with 400 invalid_request, and calls no WorkOS', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('grant_type=client_credentials'));

        controller.error(new Error('the client went away'));
      },
    });

    const request = new Request('http://localhost/multipass/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': FORM },
      body: failing,
      duplex: 'half',
    } as RequestInit);

    expect(await answerOf(await handle(request, input))).toEqual({ status: 400, body: { error: 'invalid_request' } });

    expect(stub.calls).toEqual([]);
  });

  describe('the deadline of the body read', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));

    afterEach(() => vi.useRealTimers());

    function slowRequest(
      first: string,
      rest?: { text: string; afterMs: number },
    ): { request: Request; cancelled: () => boolean } {
      let cancelled = false;

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(first));

          if (rest === undefined) return;

          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(rest.text));

            controller.close();
          }, rest.afterMs);
        },
        cancel: () => void (cancelled = true),
      });

      const request = new Request('http://localhost/multipass/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': FORM, authorization: BASIC },
        body,
        duplex: 'half',
      } as RequestInit);

      return { request, cancelled: () => cancelled };
    }

    it('service/authentication#the-token-route: refuses a body that does not end in 5 seconds with 400 invalid_request and no-store, cancels the read, and calls no WorkOS', async () => {
      const slow = slowRequest('grant_type=client_cred');
      const pending = handle(slow.request, input);

      await vi.advanceTimersByTimeAsync(4_999);

      let settled = false;

      void pending.then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      const response = await pending;

      expect({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        pragma: response.headers.get('pragma'),
        body: await response.json(),
      }).toEqual({
        status: 400,
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'invalid_request' },
      });

      expect({ cancelled: slow.cancelled(), calls: stub.calls, faults }).toEqual({
        cancelled: true,
        calls: [],
        faults: [],
      });
    });

    it('service/authentication#the-token-route: counts the deadline from the start of the read, so a body that sends 1 byte each second gets 400 invalid_request at 5 seconds', async () => {
      let cancelled = false;
      let next: ReturnType<typeof setTimeout> | undefined;

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const drip = (): void => {
            controller.enqueue(new TextEncoder().encode('a'));

            next = setTimeout(drip, 1_000);
          };

          drip();
        },
        cancel: () => {
          cancelled = true;

          clearTimeout(next);
        },
      });

      const request = new Request('http://localhost/multipass/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': FORM, authorization: BASIC },
        body,
        duplex: 'half',
      } as RequestInit);

      let settled = false;
      const pending = handle(request, input).finally(() => (settled = true));

      await vi.advanceTimersByTimeAsync(4_999);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);

      const response = await pending;

      expect({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        pragma: response.headers.get('pragma'),
        body: await response.json(),
      }).toEqual({
        status: 400,
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'invalid_request' },
      });

      expect({ cancelled, calls: stub.calls, faults }).toEqual({ cancelled: true, calls: [], faults: [] });
    });

    it('service/authentication#the-token-route: serves a body that ends just before the deadline', async () => {
      const slow = slowRequest('grant_type=client_cred', { text: 'entials', afterMs: 4_990 });
      const pending = handle(slow.request, input);

      await vi.advanceTimersByTimeAsync(4_990);

      vi.useRealTimers();

      expect(await answerOf(await pending)).toEqual({
        status: 200,
        body: { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 },
      });

      expect(stub.calls.map((call) => call.form)).toEqual([[['grant_type', 'client_credentials']]]);
    });
  });

  it('service/authentication#the-token-route: follows no redirect of WorkOS, so no other URL gets the client secret, and answers 503 temporarily_unavailable', async () => {
    const answers = [];

    for (const location of ['https://test-app.authkit.app/oauth2/other', 'https://other.example/steal']) {
      stub.answer = () => new Response(null, { status: 307, headers: { location } });

      answers.push(
        await answerOf(
          await postToken({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CANARY_SECRET }, {}),
        ),
      );
    }

    expect(answers).toEqual([
      { status: 503, body: { error: 'temporarily_unavailable' } },
      { status: 503, body: { error: 'temporarily_unavailable' } },
    ]);

    expect(stub.calls).toHaveLength(2);
    expect(stub.redirected).toEqual([]);

    expect(faults.map(([, fields]) => fields.errorName)).toEqual([
      'OntologyService:WorkosUnavailable',
      'OntologyService:WorkosUnavailable',
    ]);
  });

  it('service/authentication#the-token-route: answers 503 temporarily_unavailable to a 3xx of WorkOS with no Location', async () => {
    const answers = [];

    for (const status of [300, 304, 308]) {
      stub.answer = () => new Response(null, { status });

      answers.push(await answerOf(await postToken({ grant_type: 'client_credentials' })));
    }

    expect(answers).toEqual([
      { status: 503, body: { error: 'temporarily_unavailable' } },
      { status: 503, body: { error: 'temporarily_unavailable' } },
      { status: 503, body: { error: 'temporarily_unavailable' } },
    ]);

    expect(faults.map(([, fields]) => fields.errorName)).toEqual([
      'OntologyService:WorkosUnavailable',
      'OntologyService:WorkosUnavailable',
      'OntologyService:WorkosUnavailable',
    ]);
  });

  it('service/authentication#the-token-route: returns a 204 or a 205 of WorkOS with its status and no body, and reports no fault', async () => {
    const answers = [];

    for (const status of [204, 205]) {
      stub.answer = () => new Response(null, { status });

      const response = await postToken({ grant_type: 'client_credentials' });

      answers.push({ status: response.status, text: await response.text() });
    }

    expect(answers).toEqual([
      { status: 204, text: '' },
      { status: 205, text: '' },
    ]);

    expect(faults).toEqual([]);
  });

  it('service/authentication#the-token-route: each answer has Cache-Control no-store and Pragma no-cache, and keeps only the Content-Type of WorkOS', async () => {
    const workosHeaders = {
      'cache-control': 'max-age=60',
      pragma: 'public',
      'x-request-id': 'workos-1',
      'set-cookie': 'session=1',
      'retry-after': '30',
    };

    const headersOf = async (form: Record<string, string>) => {
      const response = await postToken(form);

      await response.arrayBuffer();

      return Object.fromEntries(
        [...response.headers].filter(
          ([name]) => !['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(name),
        ),
      );
    };

    stub.answer = () => Response.json(STUB_ACCESS_TOKEN, { headers: workosHeaders });

    const passed = await headersOf({ grant_type: 'client_credentials' });

    stub.answer = () => Response.json({ error: 'invalid_client' }, { status: 401, headers: workosHeaders });

    const refused = await headersOf({ grant_type: 'client_credentials' });

    const wrongGrant = await headersOf({ grant_type: 'password' });

    stub.answer = () => 'network error';

    const unavailable = await headersOf({ grant_type: 'client_credentials' });

    const json = { 'cache-control': 'no-store', pragma: 'no-cache', 'content-type': 'application/json' };

    expect({ passed, refused, wrongGrant, unavailable }).toEqual({
      passed: json,
      refused: json,
      wrongGrant: json,
      unavailable: json,
    });
  });

  it('service/authentication#the-token-route: a 429 of WorkOS keeps a Retry-After of seconds or an HTTP date, drops each other value, and reports no fault', async () => {
    const DATE = 'Sun, 06 Nov 1994 08:49:37 GMT';

    const headersOf = async (retryAfter: string) => {
      stub.answer = () =>
        Response.json(
          { error: 'rate_limited' },
          {
            status: 429,
            headers: {
              'retry-after': retryAfter,
              'x-request-id': 'workos-1',
              'set-cookie': 'session=1',
              'cache-control': 'max-age=60',
            },
          },
        );

      const response = await postToken({ grant_type: 'client_credentials' });

      await response.arrayBuffer();

      return {
        status: response.status,
        headers: Object.fromEntries(
          [...response.headers].filter(
            ([name]) => !['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(name),
          ),
        ),
      };
    };

    const json = { 'cache-control': 'no-store', pragma: 'no-cache', 'content-type': 'application/json' };
    const values = ['30', DATE, '30, 60', '-1', '1.5', 'soon 2020', 'Sun, 06 Nov 1994 08:49:37 GMT x', '1'.repeat(11)];
    const answers: Record<string, Awaited<ReturnType<typeof headersOf>>> = {};

    for (const value of values) answers[value] = await headersOf(value);

    expect(answers).toEqual({
      '30': { status: 429, headers: { ...json, 'retry-after': '30' } },
      [DATE]: { status: 429, headers: { ...json, 'retry-after': DATE } },
      '30, 60': { status: 429, headers: json },
      '-1': { status: 429, headers: json },
      '1.5': { status: 429, headers: json },
      'soon 2020': { status: 429, headers: json },
      'Sun, 06 Nov 1994 08:49:37 GMT x': { status: 429, headers: json },
      ['1'.repeat(11)]: { status: 429, headers: json },
    });

    expect(faults).toEqual([]);
  });
});

describe('the outputs of the token route', () => {
  let recorder: SpanRecorder;
  let logs: MockInstance<typeof console.log>;
  let errors: MockInstance<typeof console.error>;
  let warnings: MockInstance<typeof console.warn>;

  beforeAll(() => {
    recorder = recordSpans();
  });

  afterAll(() => recorder.stop());

  beforeEach(() => {
    recorder.reset();

    logs = vi.spyOn(console, 'log');

    errors = vi.spyOn(console, 'error');

    warnings = vi.spyOn(console, 'warn');
  });

  afterEach(() => vi.restoreAllMocks());

  async function outputs(): Promise<string> {
    await settle();

    const lines = [...logs.mock.calls, ...errors.mock.calls, ...warnings.mock.calls].map((args) =>
      args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : JSON.stringify(arg))).join(' '),
    );

    const spans = JSON.stringify(recorder.spans(), (_, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    );

    const reports = faults.map(
      ([error, fields]) =>
        `${error instanceof Error ? `${error.message} ${error.stack} ${String(error.cause)}` : String(error)} ${JSON.stringify(fields)}`,
    );

    return [...lines, spans, ...reports].join('\n');
  }

  it('service/observability#logs service/code-layout#seams: with the request body log on, no log line, span, or report holds the client secret or the Authorization header', async () => {
    const sent: [Record<string, string>, Record<string, string>][] = [
      [{ grant_type: 'client_credentials', scope: STOCK_SCOPES }, { authorization: BASIC }],
      [{ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CANARY_SECRET }, {}],
      [{ grant_type: 'password', client_secret: CANARY_SECRET }, { authorization: BASIC }],
    ];

    const answers: [number, TokenAnswerName][] = [];

    for (const name of ['passes', 'refused', 'network error', 'answer that is not JSON'] as const) {
      stub.answer = () => STUB_ANSWERS[name]();

      for (const [form, headers] of sent) answers.push([(await postToken(form, headers)).status, name]);
    }

    expect(answers.map(([status]) => status)).toEqual([200, 200, 400, 401, 401, 400, 503, 503, 400, 502, 502, 400]);

    const text = await outputs();

    expect(text).not.toContain(CANARY_SECRET);
    expect(text).not.toContain(BASIC.slice('Basic '.length));
    expect(text).not.toContain('CANARY');

    const lines = logs.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

    expect(lines).toHaveLength(12);
    expect(lines.filter((line) => 'body' in line)).toEqual([]);

    expect(
      recorder
        .spans()
        .filter((span) => span.parentSpanId === undefined)
        .map((span) => span.attributes['route.access']),
    ).toEqual(Array(12).fill('token'));

    expect(faults.map(([, fields]) => fields.errorName)).toEqual([
      'OntologyService:WorkosUnavailable',
      'OntologyService:WorkosUnavailable',
    ]);
  });

  const logLines = () => logs.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

  async function faultOf(settings: Settings) {
    const reported: FaultFields[] = [];

    const response = await handle(
      new Request('http://localhost/multipass/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: 'grant_type=client_credentials',
      }),
      {
        ...input,
        settings,
        reportFault: (_, fields) => void reported.push(fields),
      },
    );

    const answer = {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: await response.json(),
    };

    const [line] = logLines();

    logs.mockClear();

    return { answer, line, reported };
  }

  it('service/authentication#the-token-route: a failure of WorkOS, a missing AuthKit domain, and each other error write the error fields, get 1 report with the fault name, and answer the OAuth error with no Retry-After', async () => {
    stub.answer = () => 'network error';

    const workos = await faultOf(input.settings);

    const callsAfterWorkos = stub.calls.length;
    const { authkitDomain, ...noDomain } = testSettings;

    void authkitDomain;

    const missing = await faultOf(noDomain);

    const callsAfterMissing = stub.calls.length;

    const broken = await faultOf(
      Object.defineProperty({ ...testMcpSettings }, 'authkitDomain', {
        get: () => {
          throw new Error('a bug of the route');
        },
      }) as Settings,
    );

    const shape = ({ answer, line, reported }: Awaited<ReturnType<typeof faultOf>>) => ({
      answer,
      line: {
        errorName: line?.errorName,
        route: line?.route,
        errorInstanceId: typeof line?.errorInstanceId,
        stack: typeof line?.stack,
      },
      reported: reported.map((fields) => ({ errorName: fields.errorName, route: fields.route })),
    });

    const line = (errorName: string) => ({
      errorName,
      route: 'POST /multipass/api/oauth2/token',
      errorInstanceId: 'string',
      stack: 'string',
    });

    expect({ callsAfterWorkos, callsAfterMissing, callsAfterBroken: stub.calls.length }).toEqual({
      callsAfterWorkos: 1,
      callsAfterMissing: 1,
      callsAfterBroken: 1,
    });

    expect([workos, missing, broken].map(shape)).toEqual([
      {
        answer: { status: 503, retryAfter: null, body: { error: 'temporarily_unavailable' } },
        line: line('OntologyService:WorkosUnavailable'),
        reported: [{ errorName: 'OntologyService:WorkosUnavailable', route: 'POST /multipass/api/oauth2/token' }],
      },
      {
        answer: { status: 503, retryAfter: null, body: { error: 'temporarily_unavailable' } },
        line: line('OntologyService:SettingMissing'),
        reported: [{ errorName: 'OntologyService:SettingMissing', route: 'POST /multipass/api/oauth2/token' }],
      },
      {
        answer: { status: 500, retryAfter: null, body: { error: 'server_error' } },
        line: line('Default:Internal'),
        reported: [{ errorName: 'Default:Internal', route: 'POST /multipass/api/oauth2/token' }],
      },
    ]);
  });

  it('a fault report that throws goes to the border of the request, which reports it 1 more time, and the answer rejects with it', async () => {
    stub.answer = () => 'network error';

    const reported: [string, string][] = [];

    const pending = handle(
      new Request('http://localhost/multipass/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: 'grant_type=client_credentials',
      }),
      {
        ...input,
        reportFault: (error, fields) => {
          reported.push([fields.errorName, error instanceof Error ? error.message : String(error)]);

          throw new Error('report failed');
        },
      },
    );

    await expect(pending).rejects.toThrow('report failed');

    expect(reported.map(([errorName]) => errorName)).toEqual(['OntologyService:WorkosUnavailable', 'Default:Internal']);
    expect(reported[1]?.[1]).toBe('report failed');
  });

  it('service/authentication#the-token-route service/observability#logs service/deployment#deployment-files: with no AUTHKIT_DOMAIN in the deployment, the token route answers its OAuth 503, and each other route the OSDK 503 SettingMissing', async () => {
    const env = {
      ...testEnv,
      DATABASE_URL: 'postgresql://localhost/pooled',
      DATABASE_URL_DIRECT: 'postgresql://localhost/direct',
      WORKOS_API_KEY: 'sk_test',
    };

    const missing = inputFromEnv({ ...env, AUTHKIT_DOMAIN: undefined }, () => ({}) as never);
    const reported: FaultFields[] = [];

    const send = (request: Request) =>
      handle(request, { ...missing, reportFault: (_, fields) => void reported.push(fields) });

    const token = await send(
      new Request('http://localhost/multipass/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: 'grant_type=client_credentials',
      }),
    );

    expect({
      status: token.status,
      retryAfter: token.headers.get('retry-after'),
      cacheControl: token.headers.get('cache-control'),
      pragma: token.headers.get('pragma'),
      body: await token.json(),
    }).toEqual({
      status: 503,
      retryAfter: null,
      cacheControl: 'no-store',
      pragma: 'no-cache',
      body: { error: 'temporarily_unavailable' },
    });

    const [tokenLine] = logLines();

    expect({
      errorName: tokenLine?.errorName,
      route: tokenLine?.route,
      errorInstanceId: typeof tokenLine?.errorInstanceId,
      stack: String(tokenLine?.stack).includes('AUTHKIT_DOMAIN'),
    }).toEqual({
      errorName: 'OntologyService:SettingMissing',
      route: 'POST /multipass/api/oauth2/token',
      errorInstanceId: 'string',
      stack: true,
    });

    expect(
      reported.map((fields) => ({
        errorName: fields.errorName,
        route: fields.route,
        errorInstanceId: fields.errorInstanceId,
      })),
    ).toEqual([
      {
        errorName: 'OntologyService:SettingMissing',
        route: 'POST /multipass/api/oauth2/token',
        errorInstanceId: tokenLine?.errorInstanceId,
      },
    ]);

    logs.mockClear();

    reported.length = 0;

    const other = await send(new Request('http://localhost/api/v2/ontologies'));

    expect(other.status).toBe(503);

    expect(await other.json()).toEqual({
      errorCode: 'INTERNAL',
      errorName: 'OntologyService:SettingMissing',
      errorInstanceId: expect.any(String),
      parameters: {},
    });

    expect(reported.map((fields) => fields.errorName)).toEqual(['OntologyService:SettingMissing']);
  });

  it('service/observability#logs: a fault has the errorInstanceId of its log line in its report, and the OAuth body has no errorInstanceId', async () => {
    stub.answer = () => 'network error';

    const { answer, line, reported } = await faultOf(input.settings);

    expect(answer.body).toEqual({ error: 'temporarily_unavailable' });
    expect(reported.map((fields) => fields.errorInstanceId)).toEqual([line?.errorInstanceId]);
    expect(line?.errorInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('service/observability#logs service/observability#traces: the token route checks no token, so its line and its root span hold no user ID and no caller kind', async () => {
    expect((await postToken({ grant_type: 'client_credentials' })).status).toBe(200);

    await settle();

    const lines = logs.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    const root = recorder.spans().find((span) => span.parentSpanId === undefined);

    expect({
      lines: lines.map((line) => [line['userId'], line['callerKind']]),
      root: [root?.attributes['user.id'], root?.attributes['caller.kind']],
    }).toEqual({
      lines: [[undefined, undefined]],
      root: [undefined, undefined],
    });
  });

  it('service/observability#traces: a 200 has a workos token span with its status under the root, and no span holds a URL', async () => {
    expect((await postToken({ grant_type: 'client_credentials' })).status).toBe(200);

    await settle();

    const spans = recorder.spans();
    const root = spans.find((span) => span.parentSpanId === undefined);

    const call = spans
      .filter((span) => span.name === 'workos token')
      .map((span) => ({ parent: span.parentSpanId === root?.spanId, attributes: span.attributes }));

    expect(call).toEqual([{ parent: true, attributes: { 'http.status_code': 200, 'sentry.op': 'http.client' } }]);

    const text = JSON.stringify(spans, (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value));

    expect(text).not.toContain('authkit.app');
    expect(text).not.toContain('https://');
  });
});

describe('the token route and the instance', () => {
  let logs: MockInstance<typeof console.log>;
  let errors: MockInstance<typeof console.error>;

  beforeEach(() => {
    logs = vi.spyOn(console, 'log');

    errors = vi.spyOn(console, 'error');
  });

  afterEach(() => {
    logs.mockRestore();

    errors.mockRestore();
  });

  const tokenRequest = (signal?: AbortSignal) =>
    new Request('http://localhost/multipass/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': FORM, authorization: BASIC },
      body: 'grant_type=client_credentials',
      ...(signal ? { signal } : {}),
    });

  function deadDb(kind: 'fails' | 'never settles'): { readonly db: Db; calls: number } {
    const state = { calls: 0 };

    const answer = <T>(): Promise<T> => {
      state.calls++;

      return kind === 'fails' ? Promise.reject(new Error('the database is down')) : new Promise<T>(() => undefined);
    };

    const db: Db = {
      query: answer,
      stream: () => ({ [Symbol.asyncIterator]: () => ({ next: answer }) }),
      transaction: answer,
      snapshot: answer,
    };

    return {
      db,
      get calls() {
        return state.calls;
      },
    };
  }

  async function newHandle(): Promise<typeof handle> {
    vi.resetModules();

    return (await import('./handler/index.ts')).handle;
  }

  for (const kind of ['fails', 'never settles'] as const) {
    it(`service/authentication#the-token-route service/storage#engine-changes: the first request of an instance, to the token route, runs no cold start, and a database that ${kind} does not change its answer`, async () => {
      const fresh = await newHandle();

      const direct = deadDb(kind);
      const pooled = deadDb(kind);

      const response = await fresh(tokenRequest(), {
        ...input,
        directDb: fallibleOf(direct.db),
        db: fallibleOf(pooled.db),
        reportFault: () => undefined,
      });

      expect({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.json(),
        calls: [direct.calls, pooled.calls],
      }).toEqual({
        status: 200,
        cacheControl: 'no-store',
        body: STUB_ACCESS_TOKEN,
        calls: [0, 0],
      });

      expect(stub.calls).toHaveLength(1);
    });
  }

  it('service/storage#engine-changes: after a token request, the first authenticated OSDK API request of the instance still runs the cold start, and gets its 503', async () => {
    const fresh = await newHandle();

    const issuer = await createTestIssuer(testSettings.auth);

    const direct = deadDb('fails');
    const instance = { ...input, directDb: fallibleOf(direct.db), keys: issuer.keys, reportFault: () => undefined };

    expect((await fresh(tokenRequest(), instance)).status).toBe(200);

    const apiResponse = await fresh(
      new Request('http://localhost/api/v2/ontologies', {
        headers: { authorization: `Bearer ${await issuer.workos()}` },
      }),
      instance,
    );

    expect([
      apiResponse.status,
      ((await apiResponse.json()) as { errorName: string }).errorName,
      direct.calls > 0,
    ]).toEqual([503, 'OntologyService:EngineChangesFailed', true]);
  });

  it('service/authentication#the-token-route: a client that stops the request during the stub call gets 400 invalid_request, and no fault is reported', async () => {
    stub.answer = () => 'no answer';

    const stop = new AbortController();
    const reported: unknown[] = [];
    const pending = handle(tokenRequest(stop.signal), { ...input, reportFault: (error) => void reported.push(error) });

    while (stub.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    stop.abort();

    const response = await pending;

    expect({
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      pragma: response.headers.get('pragma'),
      body: await response.json(),
      reported,
    }).toEqual({
      status: 400,
      cacheControl: 'no-store',
      pragma: 'no-cache',
      body: { error: 'invalid_request' },
      reported: [],
    });

    const lines = logs.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

    expect(lines.map((line) => line['errorName'])).toEqual([undefined]);
  });

  const env = {
    ...testEnv,
    DATABASE_URL: 'postgresql://localhost/pooled',
    DATABASE_URL_DIRECT: 'postgresql://localhost/direct',
    WORKOS_API_KEY: 'sk_test',
  };

  for (const [name, value] of [
    ['AUTHKIT_DOMAIN', ''],
    ['WORKOS_API_KEY', undefined],
    ['DATABASE_URL', undefined],
    ['WORKOS_CLIENT_ID', ''],
  ] as const) {
    it(`service/authentication#the-token-route service/deployment#deployment-files: with ${name} ${value === undefined ? 'missing' : 'empty'}, the token route answers 503 temporarily_unavailable with no-store, and 1 report of SettingMissing`, async () => {
      const missing = inputFromEnv({ ...env, [name]: value }, () => ({}) as never);

      expect('missing' in missing && missing.missing).toEqual([name]);

      const reported: FaultFields[] = [];

      const response = await handle(tokenRequest(), {
        ...missing,
        reportFault: (_, fields) => void reported.push(fields),
      });

      expect({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: await response.json(),
        reported: reported.map((fields) => fields.errorName),
      }).toEqual({
        status: 503,
        cacheControl: 'no-store',
        body: { error: 'temporarily_unavailable' },
        reported: ['OntologyService:SettingMissing'],
      });

      expect(stub.calls).toEqual([]);
    });
  }
});

type TokenAnswerName = keyof typeof STUB_ANSWERS;

const STUB_ANSWERS = {
  passes: () => Response.json(STUB_ACCESS_TOKEN),
  refused: () => Response.json({ error: 'invalid_client' }, { status: 401 }),
  'network error': () => 'network error' as const,
  'answer that is not JSON': () =>
    new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
};
