import type { CliError } from './cliError.ts';
import { failureOf } from './errors.ts';
import { answerOf, attempt, type AsyncFallible } from './fallible.ts';
import type { Io } from './io.ts';

export type Try<T> =
  | { readonly value: T }
  | { readonly failure: CliError; readonly transient: boolean; readonly retryAfterMs?: number | undefined };

export const transientStatus = (status: number): boolean => status === 429 || status >= 500;

export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim() ?? '';

  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const date = /[a-z]/i.test(value) ? Date.parse(value) : NaN;

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export interface RetryBound {
  readonly retries: number;
  readonly maxWaitMs?: number;
}

export async function* retry<T, E, S = CliError>(
  io: Pick<Io, 'sleep'>,
  bound: RetryBound,
  once: () => AsyncFallible<Try<T>, E> | Promise<Try<T>>,
  sleepFailure?: (error: unknown) => S,
): AsyncFallible<T, E | CliError | S> {
  let waited = 0;

  for (let retries = 0; ; retries += 1) {
    const result = yield* answerOf(once());

    if ('value' in result) return result.value;

    const wait = result.retryAfterMs ?? 1000 * 2 ** retries;

    if (!result.transient || retries === bound.retries || waited + wait > (bound.maxWaitMs ?? Infinity))
      return yield result.failure;

    waited += wait;

    yield* attempt(
      () => io.sleep(wait),
      (error): CliError | S => (sleepFailure ? sleepFailure(error) : failureOf(error)),
    );
  }
}
