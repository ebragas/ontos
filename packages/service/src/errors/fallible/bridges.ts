import { settle } from './settle.ts';
import type { Result } from './types.ts';

export function caught<T>(run: () => Promise<T>): Promise<Result<T, unknown>>;
export function caught<T>(run: () => T): Result<T, unknown>;
export function caught<T>(run: () => T | Promise<T>): Result<T, unknown> | Promise<Result<T, unknown>> {
  try {
    const value = run();

    if (!(value instanceof Promise)) return { ok: true, value };

    return value.then(
      (resolved: T) => ({ ok: true, value: resolved }),
      (error: unknown) => ({ ok: false, error }),
    );
  } catch (error) {
    return { ok: false, error };
  }
}

export async function* attempt<T, E>(
  run: () => Promise<T>,
  failure: (error: unknown) => E,
): AsyncGenerator<E, T, never> {
  const result = await caught(run);

  if (result.ok) return result.value;

  return yield failure(result.error);
}

export async function* answerOf<T, E>(answer: AsyncGenerator<E, T, never> | Promise<T>): AsyncGenerator<E, T, never> {
  return answer instanceof Promise ? await answer : yield* answer;
}

export async function outcome<T, E>(run: () => AsyncGenerator<E, T, never> | Promise<T>): Promise<Result<T, unknown>> {
  const ran = await caught(() => settle(answerOf(run())));

  return ran.ok ? ran.value : ran;
}
