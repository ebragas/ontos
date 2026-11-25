import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import {
  ApiError,
  attempt,
  caught,
  invariant,
  outsideFailure,
  type AsyncFallible,
  type Fault,
} from '../errors/index.ts';
import type { CallTool, McpInput } from '../handler/index.ts';
import { createMcpServer } from './server.ts';

export { mcpLogFields } from './tools.ts';

let modernHandler: ReturnType<typeof createMcpHandler> | undefined;

function modern(): ReturnType<typeof createMcpHandler> {
  return (modernHandler ??= createMcpHandler(({ authInfo }) => serverOf(authInfo), {
    legacy: 'reject',
    responseMode: 'json',
  }));
}

function serverOf(authInfo: AuthInfo | undefined): McpServer {
  const server = authInfo?.extra?.['server'];

  invariant(server instanceof McpServer, 'The MCP request has no server of its own.');

  return server;
}

export async function* mcp(input: McpInput, callTool: CallTool): AsyncFallible<Response, ApiError | Fault> {
  const { request, body } = input;

  if (request.method !== 'POST') {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      { status: 405, headers: { allow: 'POST' } },
    );
  }

  const parsedBody = body ?? null;

  if (yield* attempt(() => isLegacyRequest(request, parsedBody), outsideFailure))
    return yield* legacy(request, parsedBody, callTool);

  const message = parsedBody as { readonly method?: unknown; readonly id?: unknown } | null;

  if (message?.method === 'subscriptions/listen') {
    return Response.json(
      { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'Method not found' } },
      { status: 404 },
    );
  }

  const authInfo: AuthInfo = { token: '', clientId: '', scopes: [], extra: { server: createMcpServer(callTool) } };

  return yield* attempt(() => modern().fetch(request, { parsedBody, authInfo }), outsideFailure);
}

async function* legacy(
  request: Request,
  parsedBody: unknown,
  callTool: CallTool,
): AsyncFallible<Response, ApiError | Fault> {
  const server = createMcpServer(callTool);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  yield* attempt(() => server.connect(transport), outsideFailure);

  const answered = await caught(() => {
    const headers = new Headers(request.headers);

    headers.set('accept', 'application/json, text/event-stream');

    return transport.handleRequest(new Request(request.url, { method: 'POST', headers }), { parsedBody });
  });

  await caught(() => transport.close());

  await caught(() => server.close());

  if (!answered.ok) return yield outsideFailure(answered.error);

  return answered.value;
}
