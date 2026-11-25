import { ApiError, caught, invariant, outsideFailure, settle, type AsyncFallible } from '../errors/index.ts';
import { READ_LIMIT_MS, workosUnavailable, type Failure } from './workosErrors.ts';

export * from './workosErrors.ts';

const FRESH_MS = 60_000;

const USABLE_MS = 300_000;

const MAX_ENTRIES = 1_000;

function workosFailed(error: Failure): boolean {
  return (
    error instanceof ApiError &&
    (error.errorName === 'OntologyService:WorkosUnavailable' || error.errorName === 'OntologyService:WorkosRateLimited')
  );
}

type Read<T> = (signal: AbortSignal) => AsyncFallible<T, Failure>;

export interface Limit {
  readonly signal: AbortSignal;
  start(): void;
}

export async function* withinLimit<T>(
  reads: (limit: Limit) => AsyncFallible<T, Failure>,
  signal?: AbortSignal,
): AsyncFallible<T, Failure> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const limit: Limit = {
    signal: controller.signal,
    start: () => {
      timer ??= setTimeout(() => controller.abort(workosUnavailable()), READ_LIMIT_MS);
    },
  };

  const stop = () => controller.abort(signal?.reason);

  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });

  try {
    return yield* reads(limit);
  } finally {
    clearTimeout(timer);

    signal?.removeEventListener('abort', stop);
  }
}

interface KeptAnswers<T> {
  get(key: string, read: Read<T>, limit: Limit): AsyncFallible<T, Failure>;
  readonly size: number;
}

interface Kept<T> {
  readonly value: T;
  readonly at: number;
}

export type OnBackground = (pending: Promise<void>) => void;

interface KeptOptions<T> {
  readonly freshMs?: number;
  readonly usableMs?: number;
  readonly maxEntries?: number;
  readonly fallback?: (value: T) => boolean;
  readonly onBackground?: OnBackground | undefined;
}

export function keptAnswers<T>(options: KeptOptions<T> = {}): KeptAnswers<T> {
  const freshMs = options.freshMs ?? FRESH_MS;
  const usableMs = options.usableMs ?? USABLE_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const fallback = options.fallback ?? (() => true);
  const { onBackground } = options;

  invariant(freshMs <= usableMs, 'freshMs must not exceed usableMs.');

  invariant(maxEntries >= 1, 'maxEntries must be at least 1.');

  const kept = new Map<string, Kept<T>>();
  const reading = new Map<string, Promise<Done>>();

  const removeOld = (): void => {
    for (const [key, answer] of kept) {
      if (Date.now() - answer.at <= usableMs) return;

      kept.delete(key);
    }
  };

  const readOnce = (key: string, read: Read<T>): Promise<Done> => {
    const shared = reading.get(key);

    if (shared) return shared;

    const limit = new AbortController();

    const timer = setTimeout(
      () => limit.abort(new Error('The WorkOS read had no answer in 5 seconds.')),
      READ_LIMIT_MS,
    );

    timer.unref?.();

    const call = settle(read(limit.signal))
      .then((result): Done => {
        if (!result.ok) return result;

        kept.delete(key);

        kept.set(key, { value: result.value, at: Date.now() });

        while (kept.size > maxEntries) {
          const oldest = kept.keys().next().value;

          if (oldest === undefined) break;

          kept.delete(oldest);
        }

        return { ok: true };
      })
      .finally(() => {
        clearTimeout(timer);

        reading.delete(key);
      });

    reading.set(key, call);

    void caught(() => call);

    return call;
  };

  return {
    async *get(key: string, read: Read<T>, limit: Limit): AsyncFallible<T, Failure> {
      removeOld();

      const known = kept.get(key);

      if (known) {
        const age = Date.now() - known.at;

        if (age < freshMs) return known.value;

        if (age <= usableMs && fallback(known.value)) {
          const alreadyReading = reading.has(key);
          const call = readOnce(key, read);

          if (!alreadyReading) onBackground?.(caught(() => call).then(() => undefined));

          return known.value;
        }
      }

      const call = readOnce(key, read);

      queueMicrotask(() => limit.start());

      const waited = await settle(waitFor(call, limit.signal));

      if (waited.ok) {
        const answer = kept.get(key);

        invariant(answer, `The WorkOS read of ${key} kept no answer.`);

        return answer.value;
      }

      const last = kept.get(key);

      if (workosFailed(waited.error) && last && Date.now() - last.at <= usableMs && fallback(last.value))
        return last.value;

      return yield waited.error;
    },
    get size() {
      return kept.size;
    },
  };
}

type Done = { readonly ok: true } | { readonly ok: false; readonly error: Failure };

async function* waitFor(call: Promise<Done>, limit: AbortSignal): AsyncFallible<void, Failure> {
  const stopped = Promise.withResolvers<Done>();
  const stop = () => stopped.resolve({ ok: false, error: outsideFailure(limit.reason) });

  if (limit.aborted) stop();
  else limit.addEventListener('abort', stop, { once: true });

  try {
    const raced = await caught(() => Promise.race([stopped.promise, call]));

    if (!raced.ok) return yield outsideFailure(raced.error);

    if (!raced.value.ok) return yield raced.value.error;
  } finally {
    limit.removeEventListener('abort', stop);
  }
}

export async function* allOf<T>(
  runs: readonly (AsyncFallible<T, Failure> | undefined)[],
): AsyncFallible<(T | undefined)[], Failure> {
  const settling = runs.map((run) => (run === undefined ? Promise.resolve(undefined) : settle(run)));

  await caught(() => Promise.allSettled(settling));

  const results = await caught(() => Promise.all(settling));

  if (!results.ok) return yield outsideFailure(results.error);

  const values: (T | undefined)[] = [];

  for (const result of results.value) {
    if (result === undefined) values.push(undefined);
    else if (result.ok) values.push(result.value);
    else return yield result.error;
  }

  return values;
}
