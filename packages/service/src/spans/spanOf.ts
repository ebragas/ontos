import { context, trace } from '@opentelemetry/api';
import { settle, type AsyncFallible } from '../errors/index.ts';
import type { SpanName, StartAttributes } from './catalog.ts';
import type { LiveSpan } from './span.ts';
import { endedWith, open, type AnyLiveSpan } from './spanCore.ts';

type Settled = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

export function spanOf<N extends SpanName, T, E>(
  name: N,
  attributes: StartAttributes<N>,
  errorOf: (failure: E) => unknown,
  run: (s: LiveSpan<N>) => AsyncFallible<T, E>,
): AsyncFallible<T, E>;
export async function* spanOf(
  name: SpanName,
  attributes: Readonly<Record<string, unknown>>,
  errorOf: (failure: unknown) => unknown,
  run: (s: AnyLiveSpan) => AsyncFallible<unknown, unknown>,
): AsyncFallible<unknown, unknown> {
  const { target, active, live } = open(name, attributes);
  const settling = new Promise<Settled>((resolve) => resolve(context.with(active, () => settle(run(live)))));

  // D1: spanOf rethrows the error of its run, or of errorOf, as the same error, as span() does, and a caller that reads it with a `try` reads it.
  const ran = await endedWith(target, settling, (result) => (result.ok ? undefined : { error: errorOf(result.error) }));

  if (ran.ok) return ran.value;

  return yield ran.error;
}

export function activeTraceId(): string | undefined {
  const active = trace.getActiveSpan();

  return active?.isRecording() === true ? active.spanContext().traceId : undefined;
}
