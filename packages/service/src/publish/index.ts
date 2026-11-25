import type { DbFailure } from '../db/index.ts';
import type { AsyncFallible } from '../errors/index.ts';
import { spanOf, type LiveSpan, type SpanName, type StartAttributes } from '../spans/index.ts';

export type { RoleSlug, WorkosPort, WorkosRoles, WorkosStep } from './workosSteps.ts';

export * from './pure/publicApi.ts';

function errorOf(failure: unknown): unknown {
  return failure instanceof Error ? failure : (failure as DbFailure).error;
}

/** Runs `run` in a new span of the catalog. A failure of `run` ends the span as failed, with the error type that a throw of its error gives, and passes on. */
export function inSpan<N extends SpanName, T, E>(
  name: N,
  attributes: StartAttributes<N>,
  run: (live: LiveSpan<N>) => AsyncFallible<T, E>,
): AsyncFallible<T, E> {
  return spanOf(name, attributes, errorOf, run);
}
