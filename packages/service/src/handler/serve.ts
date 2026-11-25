import type { DbFailure } from '../db/index.ts';
import {
  ApiError,
  attempt,
  caught,
  internalError,
  outsideFailure,
  settle,
  type AsyncFallible,
  type Fault,
} from '../errors/index.ts';
import type { JsonValue } from '../ontology/index.ts';
import type { RouteAnswer, RouteInput } from './context.ts';
import { errorLogFields, errorResponse, type OnError } from './faults.ts';
import type { RouteMatch } from './routes.ts';

export type Failure = ApiError | DbFailure | Fault;

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

const flat = <T>(ran: Result<Result<T>>): Result<T> => (ran.ok ? ran.value : ran);

export async function* answered(answer: RouteAnswer): AsyncFallible<Response, Failure> {
  if (answer instanceof Promise) return yield* attempt(() => answer, outsideFailure);

  const ran = await settle(answer);

  if (!ran.ok) return yield ran.error;

  return ran.value;
}

export function border<T>(run: () => AsyncFallible<T, Failure>, failed: (error: unknown) => T): Promise<T> {
  return settle(bordered(run)).then((ran) => (ran.ok ? ran.value : failed(ran.error)));
}

export async function* bordered<T>(run: () => AsyncFallible<T, Failure>): AsyncFallible<T, unknown> {
  const ran = flat(
    await caught(async () => {
      const settled = await settle(run());

      return settled.ok ? settled : { ok: false as const, error: thrown(settled.error) };
    }),
  );

  if (!ran.ok) return yield ran.error;

  return ran.value;
}

export function thrown(failure: Failure): unknown {
  return failure instanceof ApiError ? failure : failure.error;
}

const DEFAULT_MAX_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);
const DEFAULT_BODY_TIMEOUT_MS = 30_000;

interface BodyLimits {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

type ChunkRead =
  { readonly done: true; readonly value?: undefined } | { readonly done: false; readonly value: Uint8Array };

type ReadStep =
  | { readonly kind: 'read'; readonly result: ChunkRead }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' };

export function serve(
  request: Request,
  match: RouteMatch,
  run: (readInput: () => AsyncFallible<RouteInput, ApiError | Fault>) => AsyncFallible<Response, Failure>,
  onError: OnError,
  errorHeaders: (status: number) => Record<string, string> = () => ({}),
  bodyLimits: BodyLimits = {},
): Promise<Response> {
  const readInput = async function* (): AsyncFallible<RouteInput, ApiError | Fault> {
    return {
      params: match.params,
      query: new URL(request.url).searchParams,
      body: yield* readJson(request, bodyLimits),
      signal: request.signal,
    };
  };

  return border(
    () => run(readInput),
    (error) => {
      const apiError = error instanceof ApiError ? error : internalError();
      const fields = errorLogFields(apiError, crypto.randomUUID(), match);

      onError(error, fields, apiError.status);

      return errorResponse(apiError, fields.errorInstanceId, { ...apiError.headers, ...errorHeaders(apiError.status) });
    },
  );
}

async function* readJson(
  request: Request,
  limits: BodyLimits = {},
): AsyncFallible<JsonValue | undefined, ApiError | Fault> {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = limits.timeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const contentLength = request.headers.get('content-length');

  if (contentLength !== null) {
    const declared = Number(contentLength);

    if (Number.isFinite(declared) && declared > maxBytes) {
      await caught(() => request.body?.cancel() ?? Promise.resolve());

      return yield new ApiError(413, 'PayloadTooLarge', { maxBytes });
    }
  }

  const { body } = request;

  if (body === null) return undefined;

  const reader = body.getReader();
  const timedOut = Promise.withResolvers<ReadStep>();
  const timer = setTimeout(() => timedOut.resolve({ kind: 'timeout' }), timeoutMs);

  timer.unref?.();

  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  try {
    for (;;) {
      const step = await caught(() => {
        const reading = caught(() => reader.read()).then((ran): ReadStep =>
          ran.ok ? { kind: 'read', result: ran.value } : { kind: 'error', error: ran.error },
        );

        return Promise.race<ReadStep>([reading, timedOut.promise]);
      });

      if (!step.ok) {
        await caught(() => reader.cancel());

        return yield outsideFailure(step.error);
      }

      if (step.value.kind === 'error') {
        await caught(() => reader.cancel());

        return yield outsideFailure(step.value.error);
      }

      if (step.value.kind === 'timeout') {
        await caught(() => reader.cancel());

        return yield new ApiError(408, 'RequestTimeout', { timeoutMs });
      }

      const { done, value } = step.value.result;

      if (done) break;

      total += value.byteLength;

      if (total > maxBytes) {
        await caught(() => reader.cancel());

        return yield new ApiError(413, 'PayloadTooLarge', { maxBytes });
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);

    reader.releaseLock();
  }

  text += decoder.decode();

  if (text === '') return undefined;

  const parsed = caught((): JsonValue => JSON.parse(text));

  if (!parsed.ok) return yield new ApiError(400, 'Default:InvalidArgument');

  return parsed.value;
}
