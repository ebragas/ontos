import { context, diag, DiagLogLevel, ROOT_CONTEXT } from '@opentelemetry/api';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Caller } from '../auth/index.ts';
import { UserId } from '../auth/caller.ts';
import { ApiError } from '../errors/index.ts';
import type { CompiledObjectType } from '../ontology/index.ts';
import {
  activeRoot,
  apiNameOf,
  checkTrace,
  mcpMethodOf,
  mcpToolOf,
  rootSpan,
  span,
  sqlTemplate,
  tracedUser,
  type FinishedSpan,
  type LiveSpan,
  type RouteKey,
} from './index.ts';
import { recordSpans, settle as tick, type SpanRecorder } from '../tracing.test-utils.ts';

const sql = (text: string) => ({ text, values: ['CANARY-sql'] });
const textOf = (text: string): string => sqlTemplate(sql(text)).text;

describe('sqlTemplate', () => {
  it('service/observability#traces: replaces each string and number literal with ?', () => {
    expect(textOf("select * from t where a = 'x' and b = 42")).toBe('select * from t where a = ? and b = ?');
  });

  it('service/observability#traces: replaces a dollar-quoted body with ?', () => {
    expect(textOf('$f$ secret $f$')).toBe('?');
    expect(textOf('do $$ begin perform 1; end $$')).toBe('do ?');
  });

  it('service/observability#traces: records only the verb of a DDL statement', () => {
    expect(textOf('CREATE TABLE "pub"."t" (a text default \'secret\')')).toBe('CREATE TABLE');
    expect(textOf('  alter table "pub"."t" add column b int default 7')).toBe('ALTER TABLE');
    expect(textOf('create unique index if not exists "i" on "t" ("a")')).toBe('CREATE UNIQUE INDEX');
    expect(textOf('comment on table "t" is \'secret\'')).toBe('COMMENT');
  });

  it('service/observability#traces: keeps parameters, identifiers with digits, and quoted identifiers', () => {
    expect(textOf('select "a1", t2.b from "it\'s" t2 where c = $1 and d = $12')).toBe(
      'select "a1", t2.b from "it\'s" t2 where c = $1 and d = $12',
    );
  });

  it('service/observability#traces: replaces escape strings, doubled quotes, decimals, and exponents, and drops comments', () => {
    expect(textOf("select E'a\\'b', 'it''s', 3.5, .5e-3 -- secret\nfrom t /* secret */")).toBe(
      'select ?, ?, ?, ? \nfrom t ',
    );

    expect(textOf('select 1 /* a /* b */ secret */ from t')).toBe('select ?  from t');
  });

  it('service/observability#traces: replaces hexadecimal, octal, and binary literals', () => {
    expect(textOf('select 0x1F, 0o17, 0b1010, 1_000')).toBe('select ?, ?, ?, ?');
  });

  it('service/observability#traces: keeps at most 4096 characters', () => {
    expect(textOf(`select ${'a'.repeat(4993)}`)).toHaveLength(4096);
  });
});

let recorder: SpanRecorder;

beforeAll(() => {
  recorder = recordSpans();
});

beforeEach(() => recorder.reset());

afterAll(() => recorder.stop());

const names = () => recorder.spans().map((s) => s.name);

const only = (): FinishedSpan => {
  const spans = recorder.spans();

  expect(spans).toHaveLength(1);

  return spans[0] as FinishedSpan;
};

const OK = 0;
const ERROR = 2;

describe('span', () => {
  it('service/observability#traces: a run that returns a value ends the span once, and span returns the value', () => {
    expect(span('publish plan', {}, () => 7)).toBe(7);
    expect(names()).toEqual(['publish plan']);
  });

  it('service/observability#traces: a promise that resolves ends the span when it settles', async () => {
    const result = span('publish read', {}, async () => {
      await tick();

      return 'read';
    });

    expect(names()).toEqual([]);

    await expect(result).resolves.toBe('read');

    expect(only().status.code).toBe(OK);
  });

  it('service/observability#traces: a promise that rejects ends the span when it settles', async () => {
    const result = span('publish store', {}, async () => {
      await tick();

      throw new TypeError('CANARY-message');
    });

    expect(names()).toEqual([]);

    await expect(result).rejects.toThrow('CANARY-message');

    expect(only().status.code).toBe(ERROR);
  });

  it('service/observability#traces: an iterable that ends ends the span after its last item', async () => {
    const items = span('sql', {}, async function* () {
      yield 1;

      await tick();

      yield 2;
    });

    const iterator = items[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: 1 });

    expect(names()).toEqual([]);

    expect(await iterator.next()).toEqual({ done: false, value: 2 });

    expect(names()).toEqual([]);

    expect(await iterator.next()).toEqual({ done: true, value: undefined });

    expect(only().status.code).toBe(OK);
  });

  it('service/observability#traces: an iterable that throws ends the span with the error', async () => {
    const items = span('sql', {}, async function* () {
      yield 1;

      throw new ApiError(404, 'ObjectNotFound', { primaryKey: 'CANARY-key' });
    });

    const seen: number[] = [];

    await expect(async () => {
      for await (const item of items) seen.push(item);
    }).rejects.toThrow(ApiError);

    expect(seen).toEqual([1]);
    expect(only().attributes).toEqual({ 'error.type': 'ObjectNotFound', 'sentry.op': 'db.query' });
  });

  it('service/observability#traces: an iterable whose next() throws before it returns a promise rejects, and ends the span with the error', async () => {
    const items = span('sql', {}, (): AsyncIterable<number> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<number>> => {
          throw new SyntaxError('sync-next');
        },
      }),
    }));

    await expect(items.next()).rejects.toThrow('sync-next');

    expect(only().status.code).toBe(ERROR);
    expect(only().attributes).toEqual({ 'error.type': 'SyntaxError', 'sentry.op': 'db.query' });
  });

  it('service/observability#traces: an iterable that a stream destroys with an error ends the span with the error', async () => {
    const stream = Readable.from(
      span('sql', {}, async function* () {
        yield 'a';

        yield 'b';
      }),
    );

    stream.on('error', () => {});

    for await (const chunk of stream) {
      expect(chunk).toBe('a');

      stream.destroy(new URIError('destroyed'));

      break;
    }

    await tick();

    expect(only().status.code).toBe(ERROR);
    expect(only().attributes).toEqual({ 'error.type': 'URIError', 'sentry.op': 'db.query' });
  });

  it('service/observability#traces: an error that an outer generator throws into yield* of an iterable reaches the iterable', async () => {
    const outer = (async function* () {
      yield* span('sql', {}, async function* () {
        try {
          yield 'first';
        } catch (error) {
          yield `inner caught ${(error as Error).name}:${(error as Error).message}`;
        }
      });
    })();

    expect(await outer.next()).toEqual({ done: false, value: 'first' });

    expect(await outer.throw(new EvalError('outer-throw'))).toEqual({
      done: false,
      value: 'inner caught EvalError:outer-throw',
    });

    expect(names()).toEqual([]);
  });

  it('service/observability#traces: an iterable that the caller closes with return() ends the span once', async () => {
    let closed = false;

    const items = span('sql', {}, async function* () {
      try {
        yield 1;

        yield 2;
      } finally {
        closed = true;
      }
    });

    for await (const item of items) if (item === 1) break;

    expect(closed).toBe(true);
    expect(only().status.code).toBe(OK);
  });

  it('service/observability#traces: each return shape calls end on its span exactly 1 time', async () => {
    const errors: string[] = [];

    diag.setLogger(
      {
        error: (message) => void errors.push(message),
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        verbose: () => undefined,
      },
      DiagLogLevel.ERROR,
    );

    try {
      span('publish plan', {}, () => 1);

      await span('publish read', {}, async () => 1);

      await span('publish store', {}, async () => Promise.reject(new TypeError('x'))).catch(() => undefined);

      const done = span('sql', {}, async function* () {
        yield 1;
      });

      for await (const item of done) void item;

      await done.return?.(undefined);

      await (async () => {
        for await (const item of span('lock wait' as 'sql', {}, async function* () {
          yield 1;

          throw new TypeError('x');
        }))
          void item;
      })().catch(() => undefined);

      for await (const item of span('upgrade step' as 'sql', {}, async function* () {
        yield 1;

        yield 2;
      }))
        if (item === 1) break;
    } finally {
      diag.disable();
    }

    expect(names()).toEqual(['publish plan', 'publish read', 'publish store', 'sql', 'lock wait', 'upgrade step']);
    expect(errors).toEqual([]);
  });

  it('service/observability#traces: a span started inside run, a promise, or an iterable is a child of the span', async () => {
    span('function run', {}, () => span('worker wait', {}, () => 1));

    await span('upgrade installation', {}, async () => {
      await tick();

      await span('lock wait', {}, async () => tick());
    });

    for await (const item of span('mcp tool', {}, async function* () {
      await tick();

      yield span('bundle load', {}, () => 1);
    }))
      void item;

    const spans = recorder.spans();
    const byName = new Map(spans.map((s) => [s.name, s]));

    expect(byName.get('worker wait')?.parentSpanId).toBe(byName.get('function run')?.spanId);
    expect(byName.get('lock wait')?.parentSpanId).toBe(byName.get('upgrade installation')?.spanId);
    expect(byName.get('bundle load')?.parentSpanId).toBe(byName.get('mcp tool')?.spanId);
    expect(byName.get('function run')?.parentSpanId).toBeUndefined();
  });

  it('service/observability#traces: 200 real nested traces each pass the trace check', async () => {
    for (let index = 0; index < 200; index += 1) {
      await span(
        'root',
        { 'route.key': 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects', 'route.access': 'ontology' },
        async () => {
          await span('ontology view', {}, async () => span('ontology compile', {}, () => 1));

          for await (const item of span('sql', {}, async function* () {
            yield span('sql connection wait', {}, () => 1);
          }))
            void item;
        },
      );
    }

    const traces = Map.groupBy(recorder.spans(), (s) => s.traceId);

    expect(traces.size).toBe(200);
    expect([...traces.values()].flatMap((spans) => checkTrace(spans))).toEqual([]);
  });

  it('service/observability#traces: an mcp tool span holds the attribute names of the Sentry MCP dashboards and of the OpenTelemetry MCP spans', () => {
    span('mcp tool', { 'mcp.tool.name': 'load_objects', 'gen_ai.tool.name': 'load_objects' }, () => 1);

    expect(only().attributes).toEqual({
      'mcp.tool.name': 'load_objects',
      'gen_ai.tool.name': 'load_objects',
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'mcp.transport': 'http',
      'network.transport': 'tcp',
      'sentry.op': 'mcp.server',
    });
  });

  it('service/observability#traces: s.set adds a later attribute', () => {
    span('ontology view', {}, (s) => {
      s.set('ontology.cache.hit', false);

      s.set('ontology.version', 3);
    });

    expect(only().attributes).toEqual({ 'ontology.cache.hit': false, 'ontology.version': 3, 'sentry.op': 'cache.get' });
  });

  it('service/observability#traces: a named span takes the route key as its name', () => {
    span('root', { 'route.key': 'GET /api/v2/ontologies/{ontology}/objectTypes', 'route.access': 'ontology' }, () => {
      span('mcp route', { 'route.key': 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects' }, () => 1);
    });

    expect(names()).toEqual([
      'mcp route POST /api/v2/ontologies/{ontology}/objectSets/loadObjects',
      'GET /api/v2/ontologies/{ontology}/objectTypes',
    ]);
  });
});

describe('s.bind and live.record', () => {
  const LOAD_OBJECTS = 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects';
  const APPLY = 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply';
  const clock = (): number => performance.timeOrigin + performance.now();
  const ms = (nanoseconds: bigint): number => Number(nanoseconds) / 1e6;

  const byName = (name: string): FinishedSpan => {
    const found = recorder.spans().filter((s) => s.name === name);

    expect(found, name).toHaveLength(1);

    return found[0] as FinishedSpan;
  };

  it('service/observability#traces: s.bind runs a function in the context of its span, also when it is called from another context', () => {
    span('root', { 'route.key': APPLY }, () =>
      span('function run', {}, (s) => {
        const bridge = s.bind((key: RouteKey) => span('function client', { 'route.key': key }, () => 1));

        expect(context.with(ROOT_CONTEXT, () => bridge(LOAD_OBJECTS))).toBe(1);
      }),
    );

    expect(byName(`function client ${LOAD_OBJECTS}`).parentSpanId).toBe(byName('function run').spanId);
  });

  it('service/observability#traces: live.record adds a child with explicit times, and keeps it inside the time of the worker call span', async () => {
    let given = { start: 0, end: 0 };

    await span('worker call', {}, async (s) => {
      await new Promise((resolve) => setTimeout(resolve, 5));

      const now = clock();

      given = { start: now - 4, end: now - 2 };

      s.record('bundle load', given);

      s.record('function body', { start: now - 60_000, end: now + 60_000 });
    });

    const call = byName('worker call');
    const load = byName('bundle load');
    const body = byName('function body');

    expect([load.parentSpanId, body.parentSpanId]).toEqual([call.spanId, call.spanId]);
    expect(ms(load.start)).toBeCloseTo(given.start, 3);
    expect(ms(load.end)).toBeCloseTo(given.end, 3);
    expect(body.start).toBe(call.start);
    expect(body.end).toBeLessThanOrEqual(call.end);
    expect(load.attributes['sentry.op']).toBe('resource.script');
    expect(body.attributes['sentry.op']).toBe('function');
    expect(checkTrace(recorder.spans())).toEqual([]);
  });

  it('service/observability#traces: tsc refuses live.record on each span other than worker call, and a child that it does not record', () => {
    const refused = (run: LiveSpan<'function run'>, call: LiveSpan<'worker call'>): void => {
      // @ts-expect-error Only the worker call span records a child.
      run.record('function body', { start: 0, end: 1 });

      // @ts-expect-error The worker call span records only the bundle load and the function body.
      call.record('sql', { start: 0, end: 1 });
    };

    expect(typeof refused).toBe('function');
  });
});

describe('the error rule', () => {
  it('service/observability#traces: an ApiError gives its errorName as error.type, the status ERROR, and no event, message, or stack', () => {
    expect(() =>
      span('apply attempt', { 'apply.attempt': 1 }, () => {
        throw new ApiError(404, 'ObjectNotFound', { primaryKey: 'CANARY-key' });
      }),
    ).toThrow(ApiError);

    const ended = only();

    expect(ended.status).toEqual({ code: ERROR });
    expect(ended.attributes).toEqual({ 'apply.attempt': 1, 'error.type': 'ObjectNotFound', 'sentry.op': 'function' });
    expect(ended.events).toBe(0);
  });

  it('service/observability#traces: a thrown value that is not an Error gives the error.type NonError', () => {
    expect(() =>
      span('publish plan', {}, () => {
        throw { constructor: { name: 'CANARY-type' } };
      }),
    ).toThrow();

    expect(() =>
      span('publish plan', {}, () => {
        throw 'CANARY-text';
      }),
    ).toThrow();

    expect(recorder.spans().map((s) => s.attributes)).toEqual([
      { 'error.type': 'NonError', 'sentry.op': 'function' },
      { 'error.type': 'NonError', 'sentry.op': 'function' },
    ]);
  });

  it('service/observability#traces: another error gives its class name as error.type, and no event, message, or stack', async () => {
    await expect(
      span('publish read', {}, async () => {
        throw new TypeError('CANARY-message');
      }),
    ).rejects.toThrow(TypeError);

    const ended = only();

    expect(ended.status).toEqual({ code: ERROR });
    expect(ended.attributes).toEqual({ 'error.type': 'TypeError', 'sentry.op': 'function' });
    expect(ended.events).toBe(0);

    expect(
      JSON.stringify(ended, (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value)),
    ).not.toContain('CANARY');
  });
});

describe('the attribute filter', () => {
  it('service/observability#traces: drops an undeclared key and a value of the wrong kind, and counts each drop', () => {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The test sends an undeclared key and a value of the wrong kind on purpose.
    const attrs = { 'workos.read': 'CANARY-kind', token: 'CANARY-token' } as unknown as { 'workos.read': 'user' };

    span('workos read', attrs, () => 1);

    expect(only().attributes).toEqual({ 'sentry.op': 'http.client', 'spans.dropped_attributes': 2 });
  });

  it('service/observability#traces: drops a later value of the wrong kind or key, and counts it with the drops at the start', () => {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The test sends a value of the wrong kind on purpose.
    span('ontology view', { 'sql.held': true } as unknown as Record<string, never>, (s) => {
      s.set('ontology.version', 4);

      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The test sets a value of the wrong kind on purpose.
      s.set('ontology.version', 'CANARY-version' as unknown as number);

      s.set('sql.held' as 'ontology.version', 1);
    });

    expect(only().attributes).toEqual({
      'ontology.version': 4,
      'sentry.op': 'cache.get',
      'spans.dropped_attributes': 3,
    });
  });

  it('service/observability#traces: drops and counts a concrete path in place of a route key, and keeps it out of the name', () => {
    const path = 'GET /api/v2/ontologies/CANARYrid/objects/Employee/CANARYpk' as RouteKey;

    span('root', { 'route.key': path }, () => {
      span('mcp route', { 'route.key': path.replace('GET', 'POST') as RouteKey }, () => 1);
    });

    expect(recorder.spans().map((s) => [s.name, s.attributes])).toEqual([
      ['mcp route', { 'sentry.op': 'handler', 'spans.dropped_attributes': 1 }],
      ['root', { 'sentry.op': 'http.server', 'spans.dropped_attributes': 1 }],
    ]);
  });

  it('service/observability#traces: a brand kind takes only the value of its maker, and a literal kind takes only its literals', () => {
    const caller: Caller = { user: UserId.parse('user_01'), kind: 'person' };
    const objectType = { apiName: 'Account' } as CompiledObjectType;

    span('root', { 'route.key': 'GET /api/v2/admin/users/getCurrent', 'route.access': 'users' }, (s) => {
      s.set('user.id', tracedUser(caller));

      s.set('http.status_code', 200);

      s.set('mcp.method.name', 'tools/call');

      s.set('mcp.tool.name', 'load_objects');
    });

    span('function run', { 'action.api_name': apiNameOf(objectType) }, () => 1);

    span('sql', { 'sql.template': sqlTemplate({ text: "select 'CANARY'", values: [] }), 'sql.held': true }, () => 1);

    expect(recorder.spans().map((s) => s.attributes)).toEqual([
      {
        'route.key': 'GET /api/v2/admin/users/getCurrent',
        'route.access': 'users',
        'sentry.op': 'http.server',
        'user.id': 'user_01',
        'http.status_code': 200,
        'mcp.method.name': 'tools/call',
        'mcp.tool.name': 'load_objects',
      },
      { 'action.api_name': 'Account', 'sentry.op': 'function' },
      { 'sql.template': 'select ?', 'sql.held': true, 'sentry.op': 'db.query' },
    ]);
  });

  it('service/observability#traces: tsc refuses a plain string in each brand kind, a string not in a literal union, a name not in the catalog, and a key not declared for the name', () => {
    const fromRequest: string = 'CANARY-request';

    void span(
      'sql',
      {
        // @ts-expect-error A plain string is no SQL template.
        'sql.template': fromRequest,
      },
      () => 1,
    );

    void span(
      'function run',
      {
        // @ts-expect-error A plain string is no API name.
        'action.api_name': fromRequest,
      },
      () => 1,
    );

    span('root', { 'route.key': 'GET /api/v2/admin/users/getCurrent' }, (s) => {
      // @ts-expect-error A plain string is no traced user.
      s.set('user.id', fromRequest);

      // @ts-expect-error A plain string is no route key.
      s.set('route.key', fromRequest);
    });

    void span(
      'workos read',
      {
        // @ts-expect-error A string not in the literal union.
        'workos.read': 'users list',
      },
      () => 1,
    );

    // @ts-expect-error A name not in the catalog.
    void span('unknown span', {}, () => 1);

    void span(
      'lock wait',
      {
        // @ts-expect-error A key not declared for the name.
        'lock.key': 1,
      },
      () => 1,
    );

    const dropped = recorder.spans().map((s) => [s.name, s.attributes['spans.dropped_attributes']]);

    expect(dropped).toEqual([
      ['sql', 1],
      ['function run', 1],
      ['GET /api/v2/admin/users/getCurrent', 2],
      ['workos read', 1],
      ['unknown span', undefined],
      ['lock wait', 1],
    ]);

    expect(recorder.spans().flatMap((s) => checkTrace([s]))).toEqual([
      'sql: 1 dropped attribute',
      'function run: 1 dropped attribute',
      'function run: no child worker wait',
      'function run: no child worker call',
      'GET /api/v2/admin/users/getCurrent: 2 dropped attributes',
      'workos read: 1 dropped attribute',
      'unknown span: not in the span catalog',
      'lock wait: 1 dropped attribute',
    ]);
  });
});

describe('the trace check', () => {
  const at = (
    name: string,
    spanId: string,
    parentSpanId: string | undefined,
    start: bigint,
    end: bigint,
    attributes: FinishedSpan['attributes'] = {},
  ): FinishedSpan => ({
    name,
    traceId: 't1',
    spanId,
    parentSpanId,
    start,
    end,
    status: { code: OK },
    attributes,
    events: 0,
  });

  const root = at('POST /api/v2/ontologies/{ontology}/actions/{action}/apply', 'r', undefined, 0n, 100n);
  const run = at('function run', 'f', 'r', 10n, 90n);
  const wait = at('worker wait', 'w', 'f', 10n, 20n);
  const call = at('worker call', 'c', 'f', 20n, 90n);
  const body = at('function body', 'b', 'c', 30n, 80n);
  const good = [body, call, wait, run, root];

  it('service/observability#traces: passes a trace with 1 root, each parent, each child inside its parent, and each required span', () => {
    expect(checkTrace(good)).toEqual([]);
    expect(checkTrace(good, { rootRequires: ['function run'] })).toEqual([]);

    const remoteRoot = at(
      'POST /api/v2/ontologies/{ontology}/actions/{action}/apply',
      'r',
      'b7ad6b7169203331',
      0n,
      100n,
    );

    expect(checkTrace([body, call, wait, run, remoteRoot])).toEqual([]);
  });

  it('service/observability#traces: finds a second root, a lost parent, a child outside its parent, and a second trace', () => {
    const problems = checkTrace([
      ...good,
      at('response.body', 'x', 'gone', 10n, 20n),
      at('GET /api/v2/ontologies', 'y', undefined, 0n, 5n),
      at('GET /api/v2/ontologies', 'y2', 'ext', 0n, 5n),
      { ...at('lock wait', 'z', 'r', 50n, 101n), traceId: 't2' },
    ]);

    expect(problems).toEqual([
      'response.body: its parent is not in the trace',
      'GET /api/v2/ontologies: a second root',
      'GET /api/v2/ontologies: a second root',
      'lock wait: not in the trace of the root',
      'lock wait: ends after its parent',
    ]);

    expect(checkTrace([at('lock wait', 'z', undefined, 5n, 4n)])).toEqual(['lock wait: ends before it starts']);
  });

  it('service/observability#traces: finds each missing required span of the catalog and of the route', () => {
    expect(checkTrace([body, call, run, root])).toEqual(['function run: no child worker wait']);
    expect(checkTrace([wait, call, run, root])).toEqual(['worker call: no child function body']);

    expect(checkTrace([root], { rootRequires: ['token check', 'function run'] })).toEqual([
      'POST /api/v2/ontologies/{ontology}/actions/{action}/apply: no child token check',
      'POST /api/v2/ontologies/{ontology}/actions/{action}/apply: no child function run',
    ]);
  });

  it('service/observability#traces: finds a trace with no root', () => {
    expect(checkTrace([])).toEqual(['no root span']);

    expect(checkTrace([run])).toEqual([
      'no root span',
      'function run: its parent is not in the trace',
      'function run: no child worker wait',
      'function run: no child worker call',
    ]);
  });

  it('service/observability#traces: skips the required children of a span that ended with an error', () => {
    expect(checkTrace([{ ...run, status: { code: ERROR } }, root])).toEqual([]);
  });

  it('service/observability#traces: fails on a drop count above 0', () => {
    expect(checkTrace([at('lock wait', 'z', undefined, 0n, 1n, { 'spans.dropped_attributes': 1 })])).toEqual([
      'lock wait: 1 dropped attribute',
    ]);

    expect(checkTrace([at('lock wait', 'z', undefined, 0n, 1n, { 'spans.dropped_attributes': 0 })])).toEqual([]);
  });

  it('service/observability#traces: finds a CANARY value in a name or an attribute', () => {
    expect(
      checkTrace([at('GET /api/v2/admin/users/{userId}', 'r', undefined, 0n, 1n, { 'user.id': 'user_CANARY' })]),
    ).toEqual(['GET /api/v2/admin/users/{userId}: holds a CANARY value']);

    expect(checkTrace([at('sql', 'r', undefined, 0n, 1n, { 'sql.template': ['x', 'CANARY'] })])).toEqual([
      'sql: holds a CANARY value',
    ]);
  });

  it('service/observability#traces: resolves a named span by its route key, and refuses a name with a value in its path', () => {
    const mcpTool = at('mcp tool', 'm', 'r', 1n, 9n);
    const mcpRoute = at('mcp route POST /api/v2/ontologies/{ontology}/objectSets/loadObjects', 'n', 'm', 2n, 8n);

    expect(checkTrace([mcpRoute, mcpTool, { ...root, name: 'POST /api/mcp' }])).toEqual([]);

    expect(
      checkTrace([at('GET /api/v2/ontologies/ri.ontology.main.ontology.1/objectTypes', 'r', undefined, 0n, 1n)]),
    ).toEqual(['GET /api/v2/ontologies/ri.ontology.main.ontology.1/objectTypes: not in the span catalog']);
  });
});

describe('activeRoot and rootSpan traceparent', () => {
  it('service/observability#traces: activeRoot returns the root inside rootSpan and undefined outside, and rootSpan adopts valid traceparent', async () => {
    expect(activeRoot()).toBeUndefined();

    const action = { apiName: 'edit-account' } as CompiledObjectType;

    const { ids } = await rootSpan(
      { 'route.key': 'POST /api/v2/ontologies/{ontology}/actions/{action}/apply', 'route.access': 'ontology' },
      async () => {
        activeRoot()?.set('action.api_name', apiNameOf(action));

        return new Response(null, { status: 200 });
      },
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );

    expect(activeRoot()).toBeUndefined();
    expect(ids?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(only().parentSpanId).toBe('b7ad6b7169203331');
    expect(only().attributes['action.api_name']).toBe('edit-account');
  });
});

describe('the MCP literals of the root span', () => {
  it('a known JSON-RPC method keeps its name, and each other method is other', () => {
    expect(['tools/call', 'ping', 'resources/list', 'CANARY'].map(mcpMethodOf)).toEqual([
      'tools/call',
      'ping',
      'other',
      'other',
    ]);
  });

  it('a tool of the Ontology MCP keeps its name, and each other tool has none', () => {
    expect(['load_objects', 'apply_action', 'CANARY'].map(mcpToolOf)).toEqual([
      'load_objects',
      'apply_action',
      undefined,
    ]);
  });
});
