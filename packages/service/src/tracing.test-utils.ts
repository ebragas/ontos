import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { FinishedSpan } from './spans/index.ts';

export interface SpanRecorder {
  readonly spans: () => FinishedSpan[];
  readonly open: () => OpenSpan[];
  readonly started: (name: string, count: number) => Promise<void>;
  readonly reset: () => void;
  readonly guard: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
  readonly strayFetches: () => string[];
  readonly stop: () => void;
}

export type OpenSpan = Pick<FinishedSpan, 'name' | 'traceId' | 'spanId' | 'parentSpanId'>;

const nanoseconds = ([seconds, nanos]: readonly [number, number]): bigint =>
  BigInt(seconds) * 1_000_000_000n + BigInt(nanos);

function finished(span: ReadableSpan): FinishedSpan {
  const { traceId, spanId } = span.spanContext();

  return {
    name: span.name,
    traceId,
    spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    start: nanoseconds(span.startTime),
    end: nanoseconds(span.endTime),
    status: span.status,
    attributes: span.attributes,
    events: span.events.length,
  };
}

export function recordSpans(): SpanRecorder {
  const exporter = new InMemorySpanExporter();
  const open = new Map<string, OpenSpan>();
  const parentless = new Map<string, ReadableSpan>();
  const strays: string[] = [];
  const startCounts = new Map<string, number>();
  const waiters = new Set<{ readonly name: string; readonly count: number; readonly resolve: () => void }>();

  const starts: SpanProcessor = {
    onStart: (span) => {
      const { traceId, spanId } = span.spanContext();

      open.set(spanId, { name: span.name, traceId, spanId, parentSpanId: span.parentSpanContext?.spanId });

      if (span.parentSpanContext === undefined || span.parentSpanContext.isRemote === true)
        parentless.set(spanId, span);

      const count = (startCounts.get(span.name) ?? 0) + 1;

      startCounts.set(span.name, count);

      for (const waiter of waiters) {
        if (waiter.name !== span.name || waiter.count > count) continue;

        waiters.delete(waiter);

        waiter.resolve();
      }
    },
    onEnd: (span) => void open.delete(span.spanContext().spanId),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };

  const alwaysOn = new AlwaysOnSampler();

  const provider = new TracerProvider({
    sampler: new ParentBasedSampler({
      root: alwaysOn,
      remoteParentSampled: alwaysOn,
      remoteParentNotSampled: alwaysOn,
    }),
    spanProcessors: [starts, new SimpleSpanProcessor({ exporter })],
  });

  trace.disable();

  context.disable();

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  trace.setGlobalTracerProvider(provider);

  return {
    spans: () => exporter.getFinishedSpans().map(finished),
    open: () => [...open.values()],
    started: (name, count) =>
      new Promise((resolve) => {
        if ((startCounts.get(name) ?? 0) >= count) resolve();
        else waiters.add({ name, count, resolve });
      }),
    reset: () => {
      exporter.reset();

      open.clear();

      startCounts.clear();

      parentless.clear();

      strays.length = 0;
    },
    guard: (fetch) => (input, init) => {
      const active = trace.getActiveSpan();
      const span = active === undefined ? undefined : parentless.get(active.spanContext().spanId);

      if (span === undefined || span.attributes['route.key'] !== span.name) return fetch(input, init);

      const problem = `${span.name}: a fetch ran with no active span other than the root`;

      strays.push(problem);

      return Promise.reject(new Error(problem));
    },
    strayFetches: () => [...strays],
    stop: () => {
      trace.disable();

      context.disable();
    },
  };
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let activeRecorder: SpanRecorder | undefined;

export const routeRecording: { readonly recorder?: SpanRecorder | undefined } = {
  get recorder() {
    return activeRecorder;
  },
};

export function setRouteRecorder(recorder: SpanRecorder | undefined): void {
  activeRecorder = recorder;
}
