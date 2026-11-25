import { settle } from './settle.ts';
import type { FallibleStream } from './types.ts';

export function* each<T, U, E>(
  items: Iterable<T>,
  run: (item: T, index: number) => Generator<E, U, never>,
): Generator<E, U[], never> {
  const values: U[] = [];
  let index = 0;

  for (const item of items) {
    values.push(yield* run(item, index));

    index += 1;
  }

  return values;
}

export async function* all<T, E>(runs: readonly AsyncGenerator<E, T, never>[]): AsyncGenerator<E, T[], never> {
  const settling = runs.map((run) => settle(run));

  await Promise.allSettled(settling);

  const values: T[] = [];

  for (const result of await Promise.all(settling)) {
    if (!result.ok) return yield result.error;

    values.push(result.value);
  }

  return values;
}

export async function* mapStream<T, U, E>(
  source: FallibleStream<T, E>,
  each: (item: T) => U | undefined,
): FallibleStream<U, E> {
  let ended = false;

  try {
    for (;;) {
      const next = await source.next();

      if (next.done) {
        ended = true;

        return next.value;
      }

      const item = each(next.value);

      if (item !== undefined) yield item;
    }
  } finally {
    if (!ended) await source.return(undefined);
  }
}

export async function* step<T, E>(
  source: FallibleStream<T, E>,
): AsyncGenerator<E, { readonly done: false; readonly value: T } | { readonly done: true }, never> {
  const next = await source.next();

  if (!next.done) return { done: false, value: next.value };

  if (next.value !== undefined) return yield next.value;

  return { done: true };
}
