import { context, SpanStatusCode, trace, type Context, type HrTime, type Span } from '@opentelemetry/api';
import { ApiError, caught } from '../errors/index.ts';
import { BRANDS } from './brandTypes.ts';
import { isRouteKey, type SpanName } from './catalog.ts';
import { CATALOG, type Entry, type Kind } from './catalogData.ts';

const TRACER = 'ontology-service';

const clock = (): number => performance.timeOrigin + performance.now();

function hrTime(ms: number): HrTime {
  const seconds = Math.floor(ms / 1000);

  return [seconds, Math.min(999_999_999, Math.round((ms - seconds * 1000) * 1e6))];
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

export const DROPPED = 'spans.dropped_attributes';

export interface AnyLiveSpan {
  set(key: string, value: unknown): void;
  bind<F extends (...args: never[]) => unknown>(fn: F): F;
  record(child: SpanName, times: Interval): void;
}

function fits(kind: Kind, value: unknown): boolean {
  if (typeof kind !== 'string') return typeof value === 'string' && kind.includes(value);

  switch (kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'routeKey':
      return isRouteKey(value);
    default:
      return value instanceof BRANDS[kind];
  }
}

const otelValue = (value: unknown): string | number | boolean =>
  typeof value === 'object' && value !== null && 'text' in value
    ? String(value.text)
    : (value as string | number | boolean);

function filteredAttributes(
  values: Readonly<Record<string, unknown>>,
  kinds: Readonly<Record<string, Kind>>,
  fixed: Readonly<Record<string, string>> = {},
): { readonly attributes: Record<string, string | number | boolean>; readonly dropped: number } {
  const attributes: Record<string, string | number | boolean> = { ...fixed };
  let dropped = 0;

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;

    const kind = Object.hasOwn(kinds, key) ? kinds[key] : undefined;

    if (kind !== undefined && fits(kind, value)) attributes[key] = otelValue(value);
    else dropped += 1;
  }

  if (dropped > 0) attributes[DROPPED] = dropped;

  return { attributes, dropped };
}

function attributeFilter(
  target: Span,
  initialDrops = 0,
): (values: Readonly<Record<string, unknown>>, kinds: Readonly<Record<string, Kind>>) => void {
  let dropped = initialDrops;

  return (values, kinds) => {
    let drops = 0;

    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;

      const kind = Object.hasOwn(kinds, key) ? kinds[key] : undefined;

      if (kind !== undefined && fits(kind, value)) target.setAttribute(key, otelValue(value));
      else drops += 1;
    }

    if (drops === 0) return;

    dropped += drops;

    target.setAttribute(DROPPED, dropped);
  };
}

export function finish(target: Span, failed: boolean, error?: unknown): void {
  if (failed) fail(target, error);

  target.end(hrTime(clock()));
}

function fail(target: Span, error: unknown): void {
  target.setStatus({ code: SpanStatusCode.ERROR });

  target.setAttribute(
    'error.type',
    error instanceof ApiError ? error.errorName : error instanceof Error ? error.constructor.name : 'NonError',
  );
}

export function endedWith<T>(
  target: Span,
  pending: Promise<T>,
  failureOf?: (value: T) => { readonly error: unknown } | undefined,
): Promise<T> {
  return caught(() => pending).then((ran) => {
    if (!ran.ok) {
      finish(target, true, ran.error);

      return pending;
    }

    if (failureOf === undefined) {
      finish(target, false);

      return pending;
    }

    const judging = Promise.resolve(ran.value).then(failureOf);

    return caught(() => judging).then((judged) => {
      if (!judged.ok) {
        finish(target, true, judged.error);

        return judging.then(() => pending);
      }

      finish(target, judged.value !== undefined, judged.value?.error);

      return pending;
    });
  });
}

export function traced<T>(target: Span, active: Context, source: AsyncIterable<T>): AsyncIterableIterator<T> {
  const iterator = context.with(active, () => source[Symbol.asyncIterator]());
  let ended = false;

  const end = (failed: boolean, error?: unknown): void => {
    if (ended) return;

    ended = true;

    finish(target, failed, error);
  };

  const step = (next: () => Promise<IteratorResult<T>>, close: boolean): Promise<IteratorResult<T>> => {
    const pending = new Promise<IteratorResult<T>>((resolve) => resolve(context.with(active, next)));

    return caught(() => pending).then((ran) => {
      if (!ran.ok) end(true, ran.error);
      else if (ran.value.done === true || close) end(false);

      return pending;
    });
  };

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => step(() => iterator.next(), false),
    return: (value?: unknown) =>
      step(() => iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined }), true),
    // oxlint-disable-next-line fallible/no-throw -- D1: the iterator that span returns takes the throw of its caller, as the iterator protocol says, and a caller reads its rejection.
    throw: (error?: unknown) => step(() => iterator.throw?.(error) ?? Promise.reject(error as Error), false),
  };
}

interface OpenSpan {
  readonly target: Span;
  readonly active: Context;
  readonly live: AnyLiveSpan;
}

export function open(
  name: SpanName,
  attributes: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>),
): OpenSpan {
  const parent = context.active();
  const entry: Entry = Object.hasOwn(CATALOG, name) ? CATALOG[name] : { start: {}, later: {}, requires: [] };
  const tracer = trace.getTracer(TRACER);
  const started = clock();

  let target: Span;
  let dropped: number;

  if (typeof attributes === 'function') {
    target = tracer.startSpan(
      name,
      {
        startTime: hrTime(started),
        ...(entry.fixed === undefined ? {} : { attributes: { ...entry.fixed } }),
      },
      parent,
    );

    if (target.isRecording()) {
      const resolved = filteredAttributes(attributes(), entry.start, entry.fixed);

      dropped = resolved.dropped;

      target.setAttributes(resolved.attributes);
    } else {
      dropped = 0;
    }
  } else {
    const key = attributes['route.key'];
    const named = entry.named === true && isRouteKey(key);
    const filtered = filteredAttributes(attributes, entry.start, entry.fixed);

    dropped = filtered.dropped;

    target = tracer.startSpan(
      named ? (name === 'root' ? key : `${name} ${key}`) : name,
      { startTime: hrTime(started), attributes: filtered.attributes },
      parent,
    );
  }

  const filter = attributeFilter(target, dropped);
  const active = trace.setSpan(parent, target);

  const live: AnyLiveSpan = {
    set: (later: string, value: unknown) => filter({ [later]: value }, entry.later),
    bind: (fn) => context.bind(active, fn),
    record: (child, times) => {
      const end = clock();
      const from = Math.min(Math.max(times.start, started), end);
      const fixed = Object.hasOwn(CATALOG, child) ? CATALOG[child].fixed : undefined;

      tracer
        .startSpan(
          child,
          { startTime: hrTime(from), ...(fixed === undefined ? {} : { attributes: { ...fixed } }) },
          active,
        )
        .end(hrTime(Math.min(Math.max(times.end, from), end)));
    },
  };

  return { target, active, live };
}
