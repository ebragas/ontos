import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  mcpSettings,
  connectV1,
  connectV2,
  recordingFetch,
  startMcpService,
  v1Transport,
  type Exchange,
  type McpService,
} from './mcp.test-utils.ts';

const SERVICE_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

let service: McpService;

beforeAll(async () => {
  service = await startMcpService();
});

afterAll(() => service?.stop());

const INSTRUCTIONS = [
  'To read data, call `describe_object_type`, then `load_objects` or `aggregate_objects`.',
  'A derived Property is computed when you read it. Name it in `select`.',
  'To compute a value, such as a total, call `describe_query`, then `execute_query`.',
  'To change data, call `describe_action`, then `apply_action`.',
  'After a timeout or a lost connection, call `get_edit_history` on the Objects before you call `apply_action` again.',
];

describe('service/ontology-mcp#server-instructions: the initialize answer holds the 5 sentences in this order: read, derived Property, compute a value, change, after a timeout', () => {
  it('service/ontology-mcp#server-instructions service/testing#mcp-tests: the stock client of 2025-11-25 gets the 5 sentences, in this order', async () => {
    const { client } = await connectV1(service);

    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS.join('\n'));
      expect(client.getServerVersion()).toEqual({ name: 'ontology', version: SERVICE_VERSION });
    } finally {
      await client.close();
    }
  });

  it('service/ontology-mcp#server-instructions: the stock client of 2026-07-28 gets the same 5 sentences', async () => {
    const client = await connectV2(service, { pin: '2026-07-28' });

    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getInstructions()).toBe(INSTRUCTIONS.join('\n'));
    } finally {
      await client.close();
    }
  });

  it.each([
    ['service/ontology-mcp#server-instructions', 0],
    ['service/ontology-mcp#server-instructions', 1],
    ['service/ontology-mcp#server-instructions', 2],
    ['service/ontology-mcp#server-instructions', 3],
    ['service/ontology-mcp#server-instructions', 4],
  ])('%s: sentence %i is literal', async (_rule, index) => {
    const { client } = await connectV1(service);

    try {
      expect(client.getInstructions()?.split('\n')[index]).toBe(INSTRUCTIONS[index]);
    } finally {
      await client.close();
    }
  });
});

describe('service/ontology-mcp#route: each POST gets 1 JSON response, a GET with no token gets 401, and a GET with the token gets 405', () => {
  const posts = (exchanges: Exchange[]) => exchanges.filter((exchange) => exchange.method === 'POST');

  it('service/ontology-mcp#route service/testing#mcp-tests: the 2025-11-25 client gets application/json on each POST, and 405 on its GET', async () => {
    const exchanges: Exchange[] = [];
    const gets = () => exchanges.filter((exchange) => exchange.method === 'GET');

    const { client } = await connectV1(service, { fetch: recordingFetch(exchanges) });

    try {
      expect(await client.ping()).toEqual({});

      await vi.waitFor(() => expect(gets()).toHaveLength(1));
    } finally {
      await client.close();
    }

    expect(posts(exchanges).map((exchange) => [exchange.rpc, exchange.status, exchange.contentType])).toEqual([
      ['initialize', 200, 'application/json'],
      ['notifications/initialized', 202, null],
      ['ping', 200, 'application/json'],
    ]);

    expect(gets().map((exchange) => exchange.status)).toEqual([405]);
    expect(exchanges.some((exchange) => exchange.contentType?.startsWith('text/event-stream'))).toBe(false);
  });

  it('service/ontology-mcp#route: the 2026-07-28 client gets application/json on its POST, and no GET', async () => {
    const exchanges: Exchange[] = [];

    const client = await connectV2(service, { pin: '2026-07-28', fetch: recordingFetch(exchanges) });

    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS.join('\n'));
    } finally {
      await client.close();
    }

    expect(exchanges.map((exchange) => [exchange.method, exchange.rpc, exchange.status, exchange.contentType])).toEqual(
      [['POST', 'server/discover', 200, 'application/json']],
    );
  });

  it('service/ontology-mcp#route: the 2.x client with its default handshake, 2025-11-25, gets application/json too', async () => {
    const exchanges: Exchange[] = [];

    const client = await connectV2(service, { fetch: recordingFetch(exchanges) });

    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');

      expect(await client.ping()).toEqual({});
    } finally {
      await client.close();
    }

    expect(
      posts(exchanges)
        .filter((exchange) => exchange.status === 200)
        .map((exchange) => exchange.contentType),
    ).toEqual(['application/json', 'application/json']);
  });

  it('service/ontology-mcp#route: a GET with the token gets 405 and Allow: POST, with a JSON-RPC error', async () => {
    const response = await fetch(service.url, {
      headers: { authorization: `Bearer ${service.token}`, accept: 'text/event-stream' },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');

    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  it('service/ontology-mcp#route: a GET with no token gets the 401 of the token check, with the WWW-Authenticate header, not 405', async () => {
    const response = await fetch(service.url, { headers: { accept: 'text/event-stream' } });

    expect(response.status).toBe(401);

    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://localhost/api/oauth-protected-resource"',
    );

    expect(response.headers.get('allow')).toBeNull();
  });
});

describe('service/ontology-mcp#route: the tool list does not change, so the route opens no subscriptions/listen stream', () => {
  const tools = { onChanged: () => undefined };

  it('service/ontology-mcp#route: the 2026-07-28 client sees tools.listChanged false, and opens no listen stream', async () => {
    const exchanges: Exchange[] = [];

    const client = await connectV2(service, {
      pin: '2026-07-28',
      listChanged: { tools },
      fetch: recordingFetch(exchanges),
    });

    try {
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
      expect(client.autoOpenedSubscription).toBeUndefined();

      expect((await client.listTools()).tools).toHaveLength(8);
    } finally {
      await client.close();
    }

    expect(exchanges.map((exchange) => [exchange.rpc, exchange.contentType])).toEqual([
      ['server/discover', 'application/json'],
      ['tools/list', 'application/json'],
    ]);
  });

  it('service/ontology-mcp#route: the 2025-11-25 clients see tools.listChanged false', async () => {
    const { client: v1 } = await connectV1(service);

    const v2 = await connectV2(service, { listChanged: { tools } });

    try {
      expect(v1.getServerCapabilities()?.tools?.listChanged).toBe(false);
      expect(v2.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      expect(v2.getServerCapabilities()?.tools?.listChanged).toBe(false);
    } finally {
      await v1.close();

      await v2.close();
    }
  });

  it('service/ontology-mcp#route: a subscriptions/listen gets 404 with -32601 in JSON, not a stream, and the client goes on', async () => {
    const exchanges: Exchange[] = [];

    const client = await connectV2(service, { pin: '2026-07-28', fetch: recordingFetch(exchanges) });

    try {
      await expect(client.listen({ toolsListChanged: true })).rejects.toThrow(
        '{"jsonrpc":"2.0","id":"listen:0","error":{"code":-32601,"message":"Method not found"}}',
      );

      expect((await client.listTools()).tools).toHaveLength(8);
    } finally {
      await client.close();
    }

    expect(exchanges.map((exchange) => [exchange.rpc, exchange.status, exchange.contentType])).toEqual([
      ['server/discover', 200, 'application/json'],
      ['subscriptions/listen', 404, 'application/json'],
      ['tools/list', 200, 'application/json'],
    ]);
  });
});

describe('service/ontology-mcp#route: the route keeps no session state', () => {
  it('service/ontology-mcp#route: no answer carries a session ID, in either revision', async () => {
    const exchanges: Exchange[] = [];

    const v1 = await connectV1(service, { fetch: recordingFetch(exchanges) });

    await v1.client.ping();

    await v1.client.close();

    const v2 = await connectV2(service, { pin: '2026-07-28', fetch: recordingFetch(exchanges) });

    await v2.close();

    expect(exchanges.length).toBeGreaterThanOrEqual(4);
    expect(exchanges.map((exchange) => exchange.sessionId)).toEqual(exchanges.map(() => null));
  });

  it('service/ontology-mcp#route: a ping with no initialize before it gets its result', async () => {
    const transport = v1Transport(service);

    const answer = new Promise<JSONRPCMessage>((resolve) => {
      transport.onmessage = resolve;
    });

    await transport.start();

    try {
      await transport.send({ jsonrpc: '2.0', id: 'no-initialize', method: 'ping' });

      expect(await answer).toEqual({ jsonrpc: '2.0', id: 'no-initialize', result: {} });
    } finally {
      await transport.close();
    }
  });

  it('service/ontology-mcp#route: a second client connects after the first closed, with no state from the first', async () => {
    const first = await connectV1(service);

    await first.client.close();

    const second = await connectV1(service);

    try {
      expect(await second.client.ping()).toEqual({});
    } finally {
      await second.client.close();
    }
  });
});

describe('service/ontology-mcp#route: the route does no check of the Origin header', () => {
  it('service/ontology-mcp#route: a call with Origin https://claude.ai passes', async () => {
    const { client } = await connectV1(service, { headers: { origin: 'https://claude.ai' } });

    try {
      expect(await client.ping()).toEqual({});
    } finally {
      await client.close();
    }
  });

  it('service/ontology-mcp#route: a call with Origin https://chatgpt.com in the 2026-07-28 revision passes', async () => {
    const client = await connectV2(service, { pin: '2026-07-28', headers: { origin: 'https://chatgpt.com' } });

    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS.join('\n'));
    } finally {
      await client.close();
    }
  });
});

describe('service/ontology-mcp#route: the token check, as a client sees it', () => {
  it('service/ontology-mcp#route service/code-layout#seams: a client with no token gets 401 with the WWW-Authenticate header, and does not connect', async () => {
    const exchanges: Exchange[] = [];
    const wwwAuthenticate: (string | null)[] = [];
    const record = recordingFetch(exchanges);

    const client = new Client({
      name: 'no-token',
      version: '1.0.0',
    });

    const transport = new StreamableHTTPClientTransport(service.url, {
      fetch: async (input, init) => {
        const response = await record(input, init);

        wwwAuthenticate.push(response.headers.get('www-authenticate'));

        return response;
      },
    });

    await expect(client.connect(transport)).rejects.toThrow();

    expect(exchanges.map((exchange) => exchange.status)).toEqual([401]);
    expect(wwwAuthenticate).toEqual(['Bearer resource_metadata="http://localhost/api/oauth-protected-resource"']);
  });

  it('service/ontology-mcp#route: a token for the MCP URL of the request host, not of the base URL, gets 401', async () => {
    const token = await service.issuer.authkit({ aud: service.url.href });

    await expect(connectV1(service, { token })).rejects.toThrow();
  });

  it('service/ontology-mcp#route: the metadata route names the MCP URL of the base URL as resource', async () => {
    const response = await fetch(new URL('/api/oauth-protected-resource', service.baseUrl));

    expect(await response.json()).toEqual({
      resource: 'http://localhost/api/mcp',
      authorization_servers: ['https://test-app.authkit.app'],
    });
  });

  it('with no AUTHKIT_DOMAIN, the client gets 404 and does not connect', async () => {
    const { authkitDomain, ...off } = mcpSettings;

    void authkitDomain;

    const baseUrl = await service.serve(off);

    const exchanges: Exchange[] = [];

    const client = await connectV1(
      { ...service, url: new URL('/api/mcp', baseUrl) },
      { fetch: recordingFetch(exchanges) },
    ).catch(() => undefined);

    expect(client).toBeUndefined();
    expect(exchanges.map((exchange) => exchange.status)).toEqual([404]);

    expect((await fetch(new URL('/api/oauth-protected-resource', baseUrl))).status).toBe(404);
  });
});
