import { ApiError, attempt, caught, outsideFailure, settle, type AsyncFallible } from '../errors/index.ts';
import type { Settings } from '../handler/index.ts';
import { workosFault, type Failure } from './workosErrors.ts';
import { tracedFallible } from './workosCalls.ts';

const WORKOS_TIMEOUT_MS = 5_000;

const MAX_BODY_BYTES = 4_096;

const BODY_TIMEOUT_MS = 5_000;

export const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export async function readClientCredentialsForm(request: Request): Promise<URLSearchParams | Response> {
  const read = await caught(() => settle(readLimited(request, MAX_BODY_BYTES)));

  const form = read.ok && read.value.ok ? formOf(read.value.value) : undefined;

  return form ?? oauthError(400, 'invalid_request');
}

export async function* tokenRoute(request: Request, settings: Settings): AsyncFallible<Response, ApiError> {
  const read = await caught(() => readClientCredentialsForm(request));

  if (!read.ok) return oauthError(400, 'invalid_request');

  if (read.value instanceof Response) return read.value;

  const form = read.value;

  if (form.get('grant_type') !== 'client_credentials') return oauthError(400, 'unsupported_grant_type');

  if (settings.authkitDomain === undefined) return yield new ApiError(503, 'OntologyService:SettingMissing');

  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  const authorization = request.headers.get('authorization');

  if (authorization !== null) headers.set('authorization', authorization);

  const url = `https://${settings.authkitDomain}/oauth2/token`;
  const signal = AbortSignal.any([AbortSignal.timeout(WORKOS_TIMEOUT_MS), request.signal]);

  const spanned = await caught(() =>
    settle(
      tracedFallible('workos token', {}, async function* (live): AsyncFallible<Response, Failure> {
        const answer = yield* attempt(
          () => fetch(url, { method: 'POST', headers, body: sentForm(form), signal, redirect: 'error' }),
          outsideFailure,
        );

        live.set('http.status_code', answer.status);

        if (answer.status >= 300 && answer.status < 400) return yield workosFault(`WorkOS answered ${answer.status}.`);

        const body =
          answer.status === 204 || answer.status === 205
            ? null
            : yield* attempt(() => answer.arrayBuffer(), outsideFailure);

        return new Response(body, { status: answer.status, headers: { ...NO_STORE, ...keptHeaders(answer) } });
      }),
    ),
  );

  let cause: unknown;

  if (!spanned.ok) cause = spanned.error;
  else if (spanned.value.ok) return spanned.value.value;
  else cause = spanned.value.error instanceof ApiError ? spanned.value.error : spanned.value.error.error;

  if (request.signal.aborted) return oauthError(400, 'invalid_request');

  const fault = new ApiError(503, 'OntologyService:WorkosUnavailable');

  fault.cause = cause;

  return yield fault;
}

const RETRY_AFTER =
  /^(?:\d{1,10}|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT)$/;

function keptHeaders(answer: Response): Record<string, string> {
  const kept: Record<string, string> = {};
  const contentType = answer.headers.get('content-type');

  if (contentType !== null) kept['content-type'] = contentType;

  const retryAfter = answer.headers.get('retry-after');

  if (answer.status === 429 && retryAfter !== null && RETRY_AFTER.test(retryAfter)) kept['retry-after'] = retryAfter;

  return kept;
}

export function tokenRouteFault(status: number): Response {
  return status === 503 ? oauthError(503, 'temporarily_unavailable') : oauthError(500, 'server_error');
}

function formOf(text: string | undefined): URLSearchParams | undefined {
  if (text === undefined) return undefined;

  const form = new URLSearchParams(text);
  const names = [...form.keys()];

  return new Set(names).size === names.length ? form : undefined;
}

async function* readLimited(request: Request, limit: number): AsyncFallible<string | undefined, Failure> {
  if (request.body === null) return '';

  const body = request.body;
  const opened = caught(() => body.getReader());

  if (!opened.ok) return yield outsideFailure(opened.error);

  const reader = opened.value;
  let late = false;

  const deadline = setTimeout(() => {
    late = true;

    void caught(() => reader.cancel());
  }, BODY_TIMEOUT_MS);

  try {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;

    for (;;) {
      const { done, value } = yield* attempt(() => reader.read(), outsideFailure);

      if (late) return undefined;

      if (done) return yield* attempt(() => new Blob(chunks).text(), outsideFailure);

      size += value.byteLength;

      if (size > limit) {
        yield* attempt(() => reader.cancel(), outsideFailure);

        return undefined;
      }

      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
  }
}

const SENT_FIELDS: ReadonlySet<string> = new Set(['grant_type', 'scope', 'client_id', 'client_secret']);

function sentForm(form: URLSearchParams): URLSearchParams {
  const sent = new URLSearchParams();

  for (const [name, value] of form) {
    if (!SENT_FIELDS.has(name)) continue;

    if (name !== 'scope') {
      sent.append(name, value);

      continue;
    }

    const kept = value
      .trim()
      .split(/\s+/)
      .filter((scope) => scope !== '' && !scope.startsWith('api:'));

    if (kept.length > 0) sent.append(name, kept.join(' '));
  }

  return sent;
}

type OAuthError = 'invalid_request' | 'unsupported_grant_type' | 'temporarily_unavailable' | 'server_error';

export function oauthError(status: 400 | 500 | 503, error: OAuthError): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}
