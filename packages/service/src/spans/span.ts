import { context } from '@opentelemetry/api';
import { caught } from '../errors/index.ts';
import type { SpanName, StartAttributes } from './catalog.ts';
import type { CATALOG, ValueOf } from './catalogData.ts';
import { endedWith, finish, open, traced, type AnyLiveSpan } from './spanCore.ts';

export * from './spanOf.ts';

type Catalog = typeof CATALOG;

type RecordedChild<N extends SpanName> = Catalog[N] extends {
  readonly records: readonly (infer R extends SpanName)[];
}
  ? R
  : never;

type LaterKey<N extends SpanName> = keyof Catalog[N]['later'] & string;

type LaterValue<N extends SpanName, K extends LaterKey<N>> = ValueOf<Catalog[N]['later'][K]>;

interface Interval {
  readonly start: number;
  readonly end: number;
}

export type LiveSpan<N extends SpanName> = {
  readonly set: <K extends LaterKey<N>>(key: K, value: LaterValue<N, K>) => void;
  readonly bind: <F extends (...args: never[]) => unknown>(fn: F) => F;
} & ([RecordedChild<N>] extends [never]
  ? unknown
  : { readonly record: (child: RecordedChild<N>, times: Interval) => void });

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === 'function';

type AttributesArg<N extends SpanName> = StartAttributes<N> | (() => StartAttributes<N>);

export function span<N extends SpanName, T>(
  name: N,
  attributes: AttributesArg<N>,
  run: (s: LiveSpan<N>) => Promise<T>,
): Promise<T>;
export function span<N extends SpanName, T>(
  name: N,
  attributes: AttributesArg<N>,
  run: (s: LiveSpan<N>) => AsyncIterable<T>,
): AsyncIterableIterator<T>;
export function span<N extends SpanName, T>(name: N, attributes: AttributesArg<N>, run: (s: LiveSpan<N>) => T): T;
export function span(
  name: SpanName,
  attributes: Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>>),
  run: (s: AnyLiveSpan) => unknown,
): unknown {
  const { target, active, live } = open(name, attributes);
  const ran = caught(() => ({ value: context.with(active, run, undefined, live) }));

  if (!ran.ok) {
    finish(target, true, ran.error);

    // oxlint-disable-next-line fallible/no-throw -- D1: span() rethrows to a caller that reads the throw with a `try`.
    throw ran.error;
  }

  const result = ran.value.value;

  if (isPromiseLike(result)) return endedWith(target, Promise.resolve(result));

  if (isAsyncIterable(result)) return traced(target, active, result);

  finish(target, false);

  return result;
}
