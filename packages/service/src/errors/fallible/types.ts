export type Fallible<T, E> = Generator<E, T, never>;

export type AsyncFallible<T, E> = AsyncGenerator<E, T, never>;

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type FallibleStream<T, E> = AsyncGenerator<T, E | undefined, undefined>;

export function invariant(condition: unknown, message: string, cause?: unknown): asserts condition {
  if (condition) return;

  const defect = cause === undefined ? new Error(message) : new Error(message, { cause });

  Error.captureStackTrace(defect, invariant);

  throw defect;
}
