import { AsyncLocalStorage } from 'node:async_hooks';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import { getOtlpTracesEndpoint } from '@sentry/node';
import { attempt, caught, settle, type AsyncFallible } from '../src/errors/index.ts';

export const ROOT_END_CAP_MS = 60_000;
const FLUSH_CAP_MS = 3_000;

type DestinationKind = 'sentry' | 'posthog' | 'otlp';

interface Destination {
  readonly kind: DestinationKind;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface Tracing {
  readonly serve: (
    handle: () => Promise<Response>,
  ) => Promise<{ readonly response: Response; readonly flush: Promise<void> | undefined }>;
}

interface TraceSetup {
  readonly tracing: Tracing;
  readonly badVariables: readonly string[];
}

interface Parentless {
  readonly span: Span;
  readonly ended: Promise<void>;
}

interface RootWatch {
  readonly parentless: Parentless[];
}

const ROOT_ATTRIBUTE = 'route.key';

const requests = new AsyncLocalStorage<RootWatch>();

interface Destinations {
  readonly rootEnds: Map<string, () => void>;
  readonly flushAll: () => Promise<void>;
}

async function serveRequest(
  handle: () => Promise<Response>,
  destinations: Destinations | undefined,
): Promise<{ readonly response: Response; readonly flush: Promise<void> | undefined }> {
  const watch: RootWatch = { parentless: [] };

  // D1: the Vercel runtime waits for the request handler and reads its rejection, so a handler that rejects rejects here.
  const response = await requests.run(watch, handle);

  if (destinations === undefined) return { response, flush: undefined };

  const { rootEnds, flushAll } = destinations;
  const root = watch.parentless.find(({ span }) => Object.hasOwn(span.attributes, ROOT_ATTRIBUTE));

  for (const { span } of watch.parentless) if (span !== root?.span) rootEnds.delete(span.spanContext().spanId);

  if (root === undefined) return { response, flush: undefined };

  const flush = settle(within(root.ended, ROOT_END_CAP_MS)).then((ended) => {
    if (!ended.ok || !ended.value) rootEnds.delete(root.span.spanContext().spanId);

    return flushAll();
  });

  return { response, flush };
}

const OFF: Tracing = { serve: (handle) => serveRequest(handle, undefined) };

function createTraceExporter(destination: Destination): OTLPTraceExporter {
  const savedHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const savedTraceHeaders = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;

  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;

  delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;

  try {
    return new OTLPTraceExporter({ url: destination.url, headers: { ...destination.headers } });
  } finally {
    if (savedHeaders !== undefined) process.env.OTEL_EXPORTER_OTLP_HEADERS = savedHeaders;

    if (savedTraceHeaders !== undefined) process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = savedTraceHeaders;
  }
}

export function startTracing(env: NodeJS.ProcessEnv, version: string): TraceSetup {
  const { destinations, rate, badVariables } = readVariables(env);

  if (destinations.length === 0) return { tracing: OFF, badVariables };

  const destinationProcessors = destinations.map((destination) => ({
    kind: destination.kind,
    processor: new BatchSpanProcessor({
      exporter: createTraceExporter(destination),
    }),
  }));

  const rootEnds = new Map<string, () => void>();

  const rootWatcher: SpanProcessor = {
    onStart(span: Span) {
      const watch = requests.getStore();

      if (watch === undefined || !Object.hasOwn(span.attributes, ROOT_ATTRIBUTE)) return;

      if (span.parentSpanContext !== undefined && span.parentSpanContext.isRemote !== true) return;

      const { spanId } = span.spanContext();

      watch.parentless.push({ span, ended: new Promise((resolve) => rootEnds.set(spanId, resolve)) });
    },
    onEnd(span: ReadableSpan) {
      const { spanId } = span.spanContext();

      rootEnds.get(spanId)?.();

      rootEnds.delete(spanId);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };

  const ratio = new TraceIdRatioBasedSampler(rate);

  const provider = new TracerProvider({
    sampler: new ParentBasedSampler({ root: ratio, remoteParentSampled: ratio, remoteParentNotSampled: ratio }),
    resource: resourceFromAttributes({
      'service.name': 'ontology-service',
      'service.version': version,
      'deployment.environment.name': env['ONTOLOGY_ENVIRONMENT'],
      'ontology.deployment': URL.parse(env['ONTOLOGY_BASE_URL'] ?? '')?.host,
    }),
    spanProcessors: [rootWatcher, ...destinationProcessors.map(({ processor }) => processor)],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  trace.setGlobalTracerProvider(provider);

  const flushAll = () =>
    Promise.all(
      destinationProcessors.map(async ({ kind, processor }) => {
        const ran = await caught(() => settle(within(processor.forceFlush(), FLUSH_CAP_MS)));

        const flushed = ran.ok && ran.value.ok && ran.value.value;

        if (!flushed) console.log(JSON.stringify({ traceExportFailed: kind }));
      }),
    ).then(() => undefined);

  return { badVariables, tracing: { serve: (handle) => serveRequest(handle, { rootEnds, flushAll }) } };
}

export async function* within(promise: Promise<void>, ms: number): AsyncFallible<boolean, unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));

  try {
    return yield* attempt(
      () => Promise.race([promise.then(() => true), cap]),
      (error: unknown) => error,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface PostHogConfig {
  readonly region: 'us' | 'eu';
  readonly host: `https://${'us' | 'eu'}.i.posthog.com`;
  readonly token: string;
}

export function readPosthogConfig(env: NodeJS.ProcessEnv): {
  readonly config: PostHogConfig | undefined;
  readonly badVariables: string[];
} {
  const value = (name: string) => (env[name] === '' ? undefined : env[name]);
  const badVariables: string[] = [];
  const regionText = value('TRACES_POSTHOG_REGION');
  const tokenText = value('TRACES_POSTHOG_TOKEN');
  const region: 'us' | 'eu' | undefined = regionText === 'us' ? 'us' : regionText === 'eu' ? 'eu' : undefined;
  const token = tokenText?.startsWith('phc_') === true ? tokenText : undefined;

  if (regionText !== undefined && region === undefined) badVariables.push('TRACES_POSTHOG_REGION');

  if (tokenText !== undefined && token === undefined) badVariables.push('TRACES_POSTHOG_TOKEN');

  const config =
    region !== undefined && token !== undefined
      ? { region, host: `https://${region}.i.posthog.com` as const, token }
      : undefined;

  return { config, badVariables };
}

function parseOtlpHeaders(raw: string): Readonly<Record<string, string>> | undefined {
  const headers: Record<string, string> = {};

  for (const part of raw.split(',')) {
    const trimmed = part.trim();

    if (trimmed === '') continue;

    const eq = trimmed.indexOf('=');

    if (eq <= 0) return undefined;

    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();

    if (key === '') return undefined;

    const decoded = caught(() => decodeURIComponent(rawValue));

    if (!decoded.ok) return undefined;

    headers[key] = decoded.value;
  }

  return headers;
}

function otlpTracesUrl(raw: string): string | undefined {
  const parsed = URL.parse(raw);

  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined;

  if (!parsed.pathname.endsWith('/v1/traces')) {
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/v1/traces`;
  }

  return parsed.toString();
}

function readOtlpConfig(env: NodeJS.ProcessEnv): {
  readonly destination: Destination | undefined;
  readonly badVariables: string[];
} {
  const value = (name: string) => (env[name] === '' ? undefined : env[name]);
  const badVariables: string[] = [];
  const endpointText = value('OTEL_EXPORTER_OTLP_ENDPOINT');
  const headersText = value('OTEL_EXPORTER_OTLP_HEADERS');
  const url = endpointText === undefined ? undefined : otlpTracesUrl(endpointText);

  if (endpointText !== undefined && url === undefined) badVariables.push('OTEL_EXPORTER_OTLP_ENDPOINT');

  const headers = headersText === undefined ? {} : parseOtlpHeaders(headersText);

  if (headersText !== undefined && headers === undefined) badVariables.push('OTEL_EXPORTER_OTLP_HEADERS');

  const destination =
    url !== undefined && headers !== undefined ? ({ kind: 'otlp', url, headers } as const) : undefined;

  return { destination, badVariables };
}

function readVariables(env: NodeJS.ProcessEnv): { destinations: Destination[]; rate: number; badVariables: string[] } {
  const value = (name: string) => (env[name] === '' ? undefined : env[name]);
  const badVariables: string[] = [];
  const destinations: Destination[] = [];

  const sentry = value('TRACES_SENTRY');

  if (sentry !== undefined && sentry !== 'true') badVariables.push('TRACES_SENTRY');

  const endpoint = sentry === 'true' ? getOtlpTracesEndpoint(env['SENTRY_DSN'] ?? '') : undefined;

  if (endpoint !== undefined) destinations.push({ kind: 'sentry', url: endpoint.url, headers: endpoint.headers });

  const posthog = readPosthogConfig(env);

  badVariables.push(...posthog.badVariables);

  if (posthog.config !== undefined) {
    destinations.push({
      kind: 'posthog',
      url: `${posthog.config.host}/i/v1/traces`,
      headers: { Authorization: `Bearer ${posthog.config.token}` },
    });
  }

  const otlp = readOtlpConfig(env);

  badVariables.push(...otlp.badVariables);

  if (otlp.destination !== undefined) destinations.push(otlp.destination);

  const rateText = value('TRACES_SAMPLE_RATE');
  const rate = rateText === undefined ? 1 : rateText.trim() === '' ? Number.NaN : Number(rateText);

  if (!(rate >= 0 && rate <= 1)) {
    badVariables.push('TRACES_SAMPLE_RATE');

    return { destinations: [], rate: 1, badVariables };
  }

  return { destinations, rate, badVariables };
}
