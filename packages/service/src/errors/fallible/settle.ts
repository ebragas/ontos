import { invariant, type Result } from './types.ts';

const CLEANUP_FAILED = 'A finally block yielded a failure while its generator ended after an earlier failure.';

export function settle<T, E>(run: Generator<E, T, never>): Result<T, E>;
export function settle<T, E>(run: AsyncGenerator<E, T, never>): Promise<Result<T, E>>;
export function settle<T, E>(
  run: Generator<E, T, never> | AsyncGenerator<E, T, never>,
): Result<T, E> | Promise<Result<T, E>> {
  if (Symbol.asyncIterator in run) return settleAsync(run);

  const step = run.next();

  if (step.done) return { ok: true, value: step.value };

  invariant(run.return(undefined as never).done, CLEANUP_FAILED);

  return { ok: false, error: step.value };
}

async function settleAsync<T, E>(run: AsyncGenerator<E, T, never>): Promise<Result<T, E>> {
  const step = await run.next();

  if (step.done) return { ok: true, value: step.value };

  invariant((await run.return(undefined as never)).done, CLEANUP_FAILED);

  return { ok: false, error: step.value };
}

export function orThrow<T, E>(run: Generator<E, T, never>): T;
export function orThrow<T, E>(run: AsyncGenerator<E, T, never>): Promise<T>;
export function orThrow<T, E>(run: Generator<E, T, never> | AsyncGenerator<E, T, never>): T | Promise<T> {
  if (Symbol.asyncIterator in run) return settle(run).then(valueOrThrow);

  return valueOrThrow(settle(run));
}

function valueOrThrow<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;

  throw result.error;
}
