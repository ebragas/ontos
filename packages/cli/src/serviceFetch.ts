import { CliError, errorBodyOf } from './cliError.ts';
import { attempt, caught, settle, type AsyncFallible } from './fallible.ts';
import type { Io } from './io.ts';
import { retry, retryAfterMs, type RetryBound, type Try } from './retry.ts';

const READ_BOUND = { retries: 6, maxWaitMs: 63_000 };

const TRANSIENT = new Set([502, 503, 504]);

const TOO_MANY_REQUESTS = 429;

const READ_POST = /\/objectSets\/(?:loadObjects|aggregate)$|\/objectTypes\/[^/]+\/editsHistory$/;

const isRead = ({ method, url }: Request): boolean =>
  method === 'GET' || (method === 'POST' && READ_POST.test(new URL(url).pathname));

function boundOf(request: Request): RetryBound | undefined {
  return isRead(request) ? READ_BOUND : undefined;
}

function causeOf(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;

  return cause instanceof Error ? cause.message : String(cause);
}

const rejection = (error: unknown): unknown => error;

const refusal = (request: Request, status: number, text: string): CliError =>
  new CliError(`${request.method} ${new URL(request.url).pathname} gave ${status}.`, errorBodyOf(status, text));

async function* send(io: Pick<Io, 'fetch' | 'sleep'>, request: Request): AsyncFallible<Response, unknown> {
  const { origin, pathname } = new URL(request.url);
  const bound = boundOf(request);

  if (!bound) {
    const response = yield* attempt(() => io.fetch(request), rejection);

    if (TRANSIENT.has(response.status) || response.status === TOO_MANY_REQUESTS) {
      const text = yield* attempt(() => response.text(), rejection);

      return yield refusal(request, response.status, text);
    }

    return response;
  }

  let tries = 0;

  return yield* retry<Response, never, unknown>(
    io,
    bound,
    async (): Promise<Try<Response>> => {
      tries += 1;

      const failure = (message: string, status: number | null): CliError =>
        new CliError(message, { errorName: 'TransientFailure', message, status, url: `${origin}${pathname}`, tries });

      const sent = await caught(async () => {
        const response = await io.fetch(request.clone());

        return { response, text: response.status === TOO_MANY_REQUESTS ? await response.text() : undefined };
      });

      if (!sent.ok)
        return { failure: failure(`Cannot reach ${origin}: ${causeOf(sent.error)}.`, null), transient: true };

      const { response, text } = sent.value;

      if (text !== undefined) return { failure: refusal(request, response.status, text), transient: false };

      if (!TRANSIENT.has(response.status)) return { value: response };

      return {
        failure: failure(`${origin} gave ${response.status}.`, response.status),
        transient: true,
        retryAfterMs: retryAfterMs(response),
      };
    },
    rejection,
  );
}

export function serviceFetch(io: Pick<Io, 'fetch' | 'sleep'>): typeof fetch {
  return async (input, init) => {
    const sent = await settle(send(io, new Request(input, init)));

    // oxlint-disable-next-line fallible/no-throw -- D1: the stock OSDK client reads the rejection of the typeof fetch that it calls.
    if (!sent.ok) throw sent.error;

    return sent.value;
  };
}
