import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTrace, type FinishedSpan } from './index.ts';
import { recordSpans, settle, type SpanRecorder } from '../tracing.test-utils.ts';
import { connectV1, connectV2, startMcpService, type McpService } from '../mcp/mcp.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';
const LOAD_OBJECTS = 'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects';

let service: McpService;
let recorder: SpanRecorder;

beforeAll(async () => {
  recorder = recordSpans();

  service = await startMcpService();
});

afterAll(async () => {
  recorder?.stop();

  await service?.stop();
});

type Leg = 'v1' | 'v2';

const LEGS: readonly Leg[] = ['v1', 'v2'];

async function toolCallTrace(
  leg: Leg,
  name: string,
  args: Record<string, unknown>,
  refusal?: string,
): Promise<FinishedSpan[]> {
  recorder.reset();

  const client = leg === 'v1' ? (await connectV1(service)).client : await connectV2(service, { pin: '2026-07-28' });

  const called = client.callTool({ name, arguments: args });

  if (refusal === undefined) await called;
  else await expect(called).rejects.toThrow(refusal);

  await client.close();

  await settle();

  const spans = recorder.spans();

  const roots = spans.filter(
    (span) => span.parentSpanId === undefined && span.attributes['mcp.method.name'] === 'tools/call',
  );

  expect(roots).toHaveLength(1);

  return spans.filter((span) => span.traceId === roots[0]?.traceId);
}

const named = (spans: readonly FinishedSpan[], name: string): FinishedSpan[] =>
  spans.filter((span) => span.name === name);

const routeSpans = (spans: readonly FinishedSpan[]): FinishedSpan[] =>
  spans.filter((span) => span.name.startsWith('mcp route'));

function descends(spans: readonly FinishedSpan[], span: FinishedSpan, ancestor: FinishedSpan): boolean {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));

  for (
    let parent = byId.get(span.parentSpanId ?? '');
    parent !== undefined;
    parent = byId.get(parent.parentSpanId ?? '')
  ) {
    if (parent.spanId === ancestor.spanId) return true;
  }

  return false;
}

describe.each(LEGS)('a tools/call through the %s client', (leg) => {
  it('service/observability#traces: load_objects gives 1 mcp tool span with 1 mcp route child, named by its route key, with the spans of that route', async () => {
    const spans = await toolCallTrace(leg, 'load_objects', {
      ontology: 'twin',
      objectSet: { type: 'base', objectType: ACCOUNT },
    });

    expect(checkTrace(spans)).toEqual([]);

    const root = spans.find((span) => span.parentSpanId === undefined);
    const tools = named(spans, 'mcp tool');

    expect(tools).toHaveLength(1);

    const [tool] = tools as [FinishedSpan];

    expect(tool.parentSpanId).toBe(root?.spanId);

    expect(tool.attributes).toMatchObject({
      'mcp.tool.name': 'load_objects',
      'gen_ai.tool.name': 'load_objects',
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'mcp.transport': 'http',
      'network.transport': 'tcp',
      'sentry.op': 'mcp.server',
    });

    const [route, ...others] = routeSpans(spans);

    expect(others).toEqual([]);
    expect(route?.name).toBe(`mcp route ${LOAD_OBJECTS}`);
    expect(route?.parentSpanId).toBe(tool.spanId);
    expect(route?.attributes).toMatchObject({ 'route.key': LOAD_OBJECTS, 'http.status_code': 200 });
    expect(named(spans, 'sql').some((sql) => route !== undefined && descends(spans, sql, route))).toBe(true);
    expect(spans.filter((span) => span.name === 'sql' && span.parentSpanId === root?.spanId)).toEqual([]);
  });

  it('service/observability#traces: the mcp route span takes the key of the route that the tool runs, not the tool name', async () => {
    const spans = routeSpans(await toolCallTrace(leg, 'get_edit_history', { ontology: 'twin', objectType: ACCOUNT }));

    expect(spans.map((span) => span.name)).toEqual([
      'mcp route POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory',
    ]);
  });

  it('service/observability#traces: the mcp route span of a route that fails holds the status of its error', async () => {
    const spans = await toolCallTrace(leg, 'get_edit_history', { ontology: 'twin', objectType: 'NoSuchType' });

    expect(checkTrace(spans)).toEqual([]);
    expect(routeSpans(spans).map((span) => span.attributes['http.status_code'])).toEqual([404]);
  });

  it.each([
    ['describe_object_type', {}],
    ['describe_object_type', { objectType: ACCOUNT }],
    ['describe_object_type', { objectType: 'NoSuchType' }],
    ['describe_action', {}],
    ['describe_action', { actionType: 'com.example.twin.set-account-phase' }],
  ])(
    'service/ontology-mcp#tools/d391cc55 service/ontology-mcp#tools/c7f7e05b service/code-layout#modules/26236b9d: %s %j answers from the compiled Ontology in ctx, so its mcp tool span has no mcp route span',
    async (name, args) => {
      const spans = await toolCallTrace(leg, name, { ontology: 'twin', ...args });

      expect(checkTrace(spans)).toEqual([]);
      expect(named(spans, 'mcp tool')).toHaveLength(1);
      expect(routeSpans(spans)).toEqual([]);
    },
  );

  it('service/observability#traces: a tools/call of an unknown tool gets no mcp tool span, because the MCP SDK refuses it before the tool runs', async () => {
    const spans = await toolCallTrace(leg, 'no_such_tool', {}, 'Tool no_such_tool not found');

    expect(checkTrace(spans)).toEqual([]);
    expect(spans.map((span) => span.name).filter((name) => name.startsWith('mcp '))).toEqual([]);
  });
});

describe('the mcp module', () => {
  const mcpDir = fileURLToPath(new URL('../mcp/', import.meta.url));

  const spanValueImports = (file: string): string[] =>
    [
      ...readFileSync(`${mcpDir}${file}`, 'utf8').matchAll(
        /\b(?:import|export)\b[^;]*?['"][^'"]*\/spans(?:\/[^'"]*)?['"]/g,
      ),
    ]
      .map(([statement]) => statement)
      .filter((statement) => !/^(?:import|export)\s+type\b/.test(statement))
      .map((statement) => `${file}: ${statement}`);

  it('service/observability#traces: no file of mcp/ imports a value from spans, so the mcp module records no span', () => {
    const files = readdirSync(mcpDir).filter(
      (file) => file.endsWith('.ts') && !/\.(test|test-utils|fixture)\.ts$/.test(file),
    );

    expect(files).toContain('tools.ts');
    expect(files.flatMap(spanValueImports)).toEqual([]);
  });
});
