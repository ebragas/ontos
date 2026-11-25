import { z } from 'zod';
import {
  ApiError,
  attempt,
  caught,
  outsideFailure,
  type AsyncFallible,
  type Fallible,
  type Fault,
} from '../errors/index.ts';
import { spanOf, type LiveSpan, type SpanName, type StartAttributes } from '../spans/index.ts';
import { workosFault, workosUnavailable, type Failure } from './workosErrors.ts';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

const DEFAULT_RETRY_AFTER_SECONDS = '10';

type WorkosRead = NonNullable<StartAttributes<'workos read'>['workos.read']>;

export function tracedFallible<N extends SpanName, T>(
  name: N,
  attributes: StartAttributes<N>,
  run: (live: LiveSpan<N>) => AsyncFallible<T, Failure>,
): AsyncFallible<T, Failure> {
  return spanOf(name, attributes, (failure: Failure) => (failure instanceof ApiError ? failure : failure.error), run);
}

export function fetchOrUnavailable(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  client?: AbortSignal,
): Promise<Response> {
  // oxlint-disable-next-line fallible/no-catch -- rejection adapter wrapped by attempt() in callers
  return fetch(url, init).catch((error: unknown) => {
    // oxlint-disable-next-line fallible/no-throw -- rejection adapter wrapped by attempt() in callers
    throw client?.aborted ? error : workosUnavailable();
  });
}

function textOrUnavailable(response: Response, client?: AbortSignal): Promise<string> {
  // oxlint-disable-next-line fallible/no-catch -- rejection adapter wrapped by attempt() in callers
  return response.text().catch((error: unknown) => {
    // oxlint-disable-next-line fallible/no-throw -- rejection adapter wrapped by attempt() in callers
    throw client?.aborted ? error : workosUnavailable();
  });
}

export function jsonOrUndefined(response: Response): Promise<unknown> {
  // oxlint-disable-next-line fallible/no-catch -- rejection adapter wrapped by attempt() in callers
  return response.json().catch(() => undefined);
}

function retryAfter(value: string | null): string {
  return value !== null && /^\d+$/.test(value) ? value : DEFAULT_RETRY_AFTER_SECONDS;
}

function workosRateLimited(value: string | null): ApiError {
  return new ApiError(503, 'OntologyService:WorkosRateLimited', {}, { 'retry-after': retryAfter(value) });
}

function* workosJson(text: string, kind: string): Fallible<unknown, Fault> {
  const parsed = caught((): unknown => JSON.parse(text));

  if (!parsed.ok) return yield workosFault(`WorkOS gave the ${kind} read a body that is not JSON.`);

  return parsed.value;
}

function* workosShape<T>(schema: z.ZodType<T>, body: unknown, kind: string): Fallible<T, Fault> {
  const parsed = schema.safeParse(body);

  if (!parsed.success) return yield workosFault(`WorkOS gave the ${kind} read a body of another shape.`);

  return parsed.data;
}

export type WorkosReader = <T>(
  kind: WorkosRead,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  client?: AbortSignal,
) => AsyncFallible<T | undefined, Failure>;

export function workosReader(apiKey: string, apiUrl: string, fetch: typeof globalThis.fetch): WorkosReader {
  return async function* <T>(
    kind: WorkosRead,
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    client?: AbortSignal,
  ): AsyncFallible<T | undefined, Failure> {
    const body = yield* tracedFallible('workos read', { 'workos.read': kind }, async function* (live): AsyncFallible<
      unknown,
      Failure
    > {
      const response = yield* attempt(
        () =>
          fetchOrUnavailable(
            fetch,
            `${apiUrl}${path}`,
            { headers: { authorization: `Bearer ${apiKey}` }, signal },
            client,
          ),
        outsideFailure,
      );

      live.set('http.status_code', response.status);

      if (response.status === 404) return undefined;

      if (response.status === 429) return yield workosRateLimited(response.headers.get('retry-after'));

      if (response.status >= 500) return yield workosUnavailable();

      if (!response.ok) return yield workosFault(`WorkOS answered ${response.status} to the ${kind} read.`);

      const text = yield* attempt(() => textOrUnavailable(response, client), outsideFailure);

      return yield* workosJson(text, kind);
    });

    if (body === undefined || body === null) return undefined;

    return yield* workosShape(schema, body, kind);
  };
}
