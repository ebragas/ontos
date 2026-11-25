import type { Server } from 'node:http';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2Transport,
  type ListChangedHandlers,
} from '@modelcontextprotocol/client';
import type { OntologyIr } from '@osdk/client.unstable';
import type pg from 'pg';
import { createPool } from '../db/index.ts';
import { createDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { HandleInput, Settings } from '../handler/index.ts';
import { createNodeServer } from '../node.ts';
import { installOntology } from '../install.test-utils.ts';
import type { GrantsFile } from '../ontology/index.ts';
import type { PublishedFunctions } from '../publish/index.ts';
import { ONTOLOGY_RID, stored, twinGrants } from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { AUTHKIT_DOMAIN, createTestIssuer, now, ORGANIZATION, type TestIssuer } from '../tokens.test-utils.ts';
import { onNewConnection } from '../publish/publish.test-utils.ts';
import { publishTwin } from '../../twin/seed/seed.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { closeServer, listenLocal } from '../localServer.test-utils.ts';

const APP = { repository: 'example/twin', environment: 'publish' };

export const mcpSettings: Settings = {
  productRid: ONTOLOGY_RID,
  environment: 'mcp-test',
  auth: { workosClientId: 'mcp-test', baseUrl: 'http://localhost', app: APP },
  authkitDomain: AUTHKIT_DOMAIN,
  mcp: true,
};

type ServeInput = Partial<Pick<HandleInput, 'db' | 'reportFault'>>;

export interface McpService {
  readonly baseUrl: string;
  readonly url: URL;
  readonly token: string;
  readonly issuer: TestIssuer;
  readonly db: Db;
  serve(settings: Settings, input?: ServeInput): Promise<string>;
  stop(): Promise<void>;
}

async function serviceRoleUrl(postgres: TestPostgres): Promise<string> {
  const name = `${postgres.role}_service`;

  await onNewConnection(
    postgres.url,
    `CREATE ROLE ${name} LOGIN PASSWORD '${name}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  await onNewConnection(postgres.url, `GRANT CREATE ON DATABASE ${postgres.role} TO ${name}`);

  const url = new URL(postgres.url);

  url.username = name;
  url.password = name;

  return url.toString();
}

export interface PublishedOntology {
  readonly ir: OntologyIr;
  readonly grants: GrantsFile;
  readonly functions?: PublishedFunctions;
}

export async function startMcpService(ontology?: PublishedOntology): Promise<McpService> {
  const postgres: TestPostgres = await startPostgres();

  const pool: pg.Pool = createPool(await serviceRoleUrl(postgres));

  const db = createDb(pool);

  const issuer = await createTestIssuer(mcpSettings.auth);

  const servers: Server[] = [];

  const serve = async (settings: Settings, input: ServeInput = {}): Promise<string> => {
    const server = createNodeServer({
      db: fallibleOf(db),
      directDb: fallibleOf(db),
      settings,
      keys: issuer.keys,
      users: roleUsers((ontology?.grants ?? twinGrants('0.7.0')).defaultRoles),
      workos: stubPublish(),
      ...input,
    });

    servers.push(server);

    return listenLocal(server);
  };

  const baseUrl = await serve(mcpSettings);

  if (ontology) await publishOntology(baseUrl, await issuer.github({ exp: now() + 3600 }), ontology);
  else await publishTwin({ baseUrl, publishToken: () => issuer.github({ exp: now() + 3600 }) }, '0.7.0');

  await installOntology(db, {
    rid: ONTOLOGY_RID,
    product: 'twin',
    apiName: 'twin',
    displayName: 'twin',
    organization: ORGANIZATION,
  });

  return {
    baseUrl,
    url: new URL('/api/mcp', baseUrl),
    token: await issuer.authkit({ exp: now() + 3600 }),
    issuer,
    db,
    serve,
    stop: async () => {
      await Promise.all(servers.map(closeServer));

      await pool.end();

      await postgres.stop();
    },
  };
}

async function publishOntology(
  baseUrl: string,
  token: string,
  { ir, grants, functions }: PublishedOntology,
): Promise<void> {
  const response = await fetch(new URL('/api/ontology-service/v1/publish', baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      product: 'twin',
      ir,
      ...(functions ? { functions } : {}),
      schemaMigrations: { migrations: [] },
      osdkSet: stored(ir).osdkSet,
      grants,
      validateOnly: false,
    }),
  });

  if (response.status !== 200) throw new Error(`The publish gave ${response.status}: ${await response.text()}`);
}

export interface Exchange {
  readonly method: string;
  readonly rpc: string | undefined;
  readonly status: number;
  readonly contentType: string | null;
  readonly sessionId: string | null;
}

export function recordingFetch(exchanges: Exchange[]): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);

    const text = await request.clone().text();

    const response = await fetch(request);

    exchanges.push({
      method: request.method,
      rpc: text === '' ? undefined : (JSON.parse(text) as { method?: string }).method,
      status: response.status,
      contentType: response.headers.get('content-type'),
      sessionId: response.headers.get('mcp-session-id'),
    });

    return response;
  };
}

export interface ClientOptions {
  readonly token?: string | undefined;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof globalThis.fetch;
}

function headersOf(options: ClientOptions, token: string): Record<string, string> {
  return { authorization: `Bearer ${options.token ?? token}`, ...options.headers };
}

export async function connectV1(
  service: McpService,
  options: ClientOptions = {},
): Promise<{ client: V1Client; transport: V1Transport }> {
  const client = new V1Client({ name: 'mcp-test-v1', version: '1.0.0' });
  const transport = v1Transport(service, options);

  await client.connect(transport);

  return { client, transport };
}

export function v1Transport(service: McpService, options: ClientOptions = {}): V1Transport {
  return new V1Transport(service.url, {
    requestInit: { headers: headersOf(options, service.token) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export async function connectV2(
  service: McpService,
  options: ClientOptions & { readonly pin?: '2026-07-28'; readonly listChanged?: ListChangedHandlers } = {},
): Promise<V2Client> {
  const client = new V2Client(
    { name: 'mcp-test-v2', version: '1.0.0' },
    {
      ...(options.pin ? { versionNegotiation: { mode: { pin: options.pin } } } : {}),
      ...(options.listChanged ? { listChanged: options.listChanged } : {}),
    },
  );

  const transport = new V2Transport(service.url, {
    requestInit: { headers: headersOf(options, service.token) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  await client.connect(transport);

  return client;
}
