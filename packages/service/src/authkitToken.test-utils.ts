import { http, HttpResponse, type HttpHandler } from 'msw';
import { AUTHKIT_DOMAIN } from './tokens.test-utils.ts';
import { routeRecording } from './tracing.test-utils.ts';

interface TokenCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly form: readonly (readonly [string, string])[];
}

type TokenAnswer = Response | 'network error' | 'no answer';

export const STUB_ACCESS_TOKEN = { access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 3600 } as const;

export interface AuthkitTokenStub {
  readonly handler: HttpHandler;
  readonly calls: TokenCall[];
  readonly redirected: TokenCall[];
  answer: () => TokenAnswer;
}

export function stubAuthkitToken(domain: string = AUTHKIT_DOMAIN): AuthkitTokenStub {
  const calls: TokenCall[] = [];
  const redirected: TokenCall[] = [];

  const respond = async (request: Request): Promise<Response> => {
    const body = await request.text();

    calls.push(callOf(request, body));

    const answer = stub.answer();

    if (answer === 'network error') return HttpResponse.error();

    if (answer === 'no answer') return waitForAbort(request.signal);

    const location = answer.headers.get('location');

    if (answer.status < 300 || answer.status >= 400 || location === null || request.redirect === 'manual')
      return answer;

    if (request.redirect === 'error') return HttpResponse.error();

    redirected.push(
      callOf(new Request(new URL(location, request.url), { method: request.method, headers: request.headers }), body),
    );

    return Response.json({ access_token: 'redirect-target-token', token_type: 'Bearer', expires_in: 3600 });
  };

  const stub: AuthkitTokenStub = {
    calls,
    redirected,
    answer: () => Response.json(STUB_ACCESS_TOKEN),
    handler: http.post(`https://${domain}/oauth2/token`, async ({ request }) => {
      const guarded = routeRecording.recorder?.guard((input) => respond(input as Request)) ?? respond;

      return guarded(request).catch(() => HttpResponse.error());
    }),
  };

  return stub;
}

function callOf(request: Request, body: string): TokenCall {
  return {
    url: request.url,
    method: request.method,
    authorization: request.headers.get('authorization'),
    contentType: request.headers.get('content-type'),
    form: [...new URLSearchParams(body)],
  };
}

function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(HttpResponse.error()), { once: true }),
  );
}
