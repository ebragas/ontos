import { execFile } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type pg from 'pg';
import { createDb, createPool } from '../../packages/service/src/db/index.ts';
import { attempt, caught, type AsyncFallible } from '../../packages/service/src/errors/fallible.ts';
import { settingsFromEnv } from '../../packages/service/src/handler/index.ts';
import { createDb as createPromiseDb } from '../../packages/service/src/db/promise.test-utils.ts';
import { installOntology, isInstalled } from '../../packages/service/src/install.test-utils.ts';
import { workosPublish, workosUsers, type UserSource, type WorkosUser } from '../../packages/service/src/auth/index.ts';
import { createNodeServer } from '../../packages/service/src/node.ts';
import { twinGrants } from '../../packages/service/src/ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../../packages/service/src/postgres.test-utils.ts';
import {
  createTestIssuer,
  ORGANIZATION,
  type Claims,
  type TestIssuer,
} from '../../packages/service/src/tokens.test-utils.ts';
import {
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubPublish,
  stubUsers,
  stubWorkos,
  type StubEnvironment,
  type StubMembership,
  type StubWorkos,
} from '../../packages/service/src/workos.test-utils.ts';
import { closeServer, listenLocal } from '../../packages/service/src/localServer.test-utils.ts';

export { STUB_PERSON } from '../../packages/service/src/workos.test-utils.ts';

export { ORGANIZATION } from '../../packages/service/src/tokens.test-utils.ts';

const TEST_APP_MEMBER: WorkosUser = {
  id: 'user_01HTESTMEMBER000000000000M',
  email: 'member@example.com',
  first_name: 'Mem',
  last_name: 'Ber',
};

export function testAppUsers(
  roles: Readonly<Record<string, readonly string[]>> = twinGrants('0.7.0').defaultRoles,
  people: Readonly<Record<string, string>> = {},
): UserSource {
  const roleOf: Record<string, string> = { [STUB_PERSON.id]: 'admin', [TEST_APP_MEMBER.id]: 'member', ...people };

  const users = [
    STUB_PERSON,
    TEST_APP_MEMBER,
    ...Object.keys(people).map((id): WorkosUser => ({
      id,
      email: `${id.toLowerCase()}@example.com`,
      first_name: id,
      last_name: 'Person',
    })),
  ];

  const memberships = Object.entries(roleOf).map(([id, role]): StubMembership => ({
    user_id: id,
    organization_id: ORGANIZATION,
    status: 'active',
    organization_name: 'Test Organization',
    roles: [role],
  }));

  return stubUsers(users, memberships, { roles: { [ORGANIZATION]: roles } });
}

const TEST_APP_ENVIRONMENT: StubEnvironment = {
  permissions: {
    'widgets:dsync:manage': 'View and manage access for the Directory Sync widget.',
    'widgets:users-table:manage': 'View and edit access for the users table widget.',
  },
  roles: { admin: ['widgets:dsync:manage', 'widgets:users-table:manage'], member: [] },
};

function testAppWorkos(clientSecret?: string): StubWorkos {
  const memberships: StubMembership[] = [
    {
      user_id: STUB_PERSON.id,
      organization_id: ORGANIZATION,
      status: 'active',
      organization_name: 'Test Organization',
      roles: ['admin'],
    },
    {
      user_id: TEST_APP_MEMBER.id,
      organization_id: ORGANIZATION,
      status: 'active',
      organization_name: 'Test Organization',
      roles: ['member'],
    },
  ];

  return stubWorkos([STUB_PERSON, TEST_APP_MEMBER], memberships, {
    roles: {},
    environment: TEST_APP_ENVIRONMENT,
    ...(clientSecret === undefined ? {} : { clientSecret }),
  });
}

export const TEST_APP = {
  productRid: 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111',
  production: {
    baseUrl: 'https://app.ontos.example',
    workosClientId: 'client_01TESTAPP0000000000000000',
    trustedGithubRepository: 'ebragas/ontos',
    trustedGithubEnvironment: 'production',
    authkitDomain: 'test-tenant.authkit.app',
    mcp: true,
  },
};

interface RunResult {
  readonly code: number;
  readonly lines: string[];
  readonly stderr: string;
}

export interface TestService {
  readonly url: string;
  readonly audiences: string[];
  readonly issuer: TestIssuer;
  readonly oidcEnv: Readonly<Record<'ACTIONS_ID_TOKEN_REQUEST_URL' | 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', string>>;
  claims(claims: Claims): void;
  run(
    script: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): AsyncFallible<RunResult, unknown>;
  serve(env: Readonly<Record<string, string | undefined>>): AsyncFallible<string, unknown>;
  readonly workos: {
    readonly url: string;
    readonly env: Readonly<
      Record<'ONTOLOGY_TEST_USER_EMAIL' | 'ONTOLOGY_TEST_USER_PASSWORD' | 'WORKOS_API_KEY', string>
    >;
  };
  install(): AsyncFallible<void, unknown>;
  readonly workosStub?: StubWorkos;
  query<Row extends pg.QueryResultRow>(text: string, values?: readonly unknown[]): AsyncFallible<Row[], unknown>;
  stop(): AsyncFallible<void, unknown>;
}

const rejection = (error: unknown): unknown => error;

export async function* startTestService(
  baseUrl: string,
  users?: UserSource,
  clientSecret?: string,
): AsyncFallible<TestService, unknown> {
  const workosStub = users ? undefined : testAppWorkos(clientSecret);
  const callers = users ?? workosUsers(STUB_WORKOS_KEY, { fetch: (workosStub as StubWorkos).fetch });
  const port = workosStub ? workosPublish(STUB_WORKOS_KEY, { fetch: workosStub.fetch }) : stubPublish();
  const postgres: TestPostgres = yield* attempt(() => startPostgres({ template: 'engine' }), rejection);
  const pool: pg.Pool = createPool(postgres.url);

  const env = {
    PRODUCT_RID: TEST_APP.productRid,
    ONTOLOGY_ENVIRONMENT: 'production',
    ONTOLOGY_BASE_URL: baseUrl,
    WORKOS_CLIENT_ID: TEST_APP.production.workosClientId,
    TRUSTED_GITHUB_REPOSITORY: TEST_APP.production.trustedGithubRepository,
    TRUSTED_GITHUB_ENVIRONMENT: TEST_APP.production.trustedGithubEnvironment,
    AUTHKIT_DOMAIN: TEST_APP.production.authkitDomain,
    ONTOLOGY_MCP: TEST_APP.production.mcp === true ? 'true' : undefined,
  };

  const settings = settingsFromEnv(env);
  const issuer = yield* attempt(() => createTestIssuer(settings.auth, TEST_APP.production.authkitDomain), rejection);

  const service: Server = createNodeServer({
    db: createDb(pool),
    directDb: createDb(pool),
    settings,
    keys: issuer.keys,
    users: callers,
    workos: port,
  });

  const more: Server[] = [];
  const url = yield* attempt(() => listenLocal(service), rejection);
  const audiences: string[] = [];
  let claims: Claims = {};

  const oidc = createServer((request, response) => {
    const audience = new URL(request.url ?? '/', 'http://localhost').searchParams.get('audience');

    if (request.headers.authorization !== 'Bearer request-token' || audience === null) {
      response.writeHead(401).end();

      return;
    }

    audiences.push(audience);

    void issuer.github({ aud: audience, ...claims }).then((value) => response.end(JSON.stringify({ value })));
  });

  const oidcUrl = `${yield* attempt(() => listenLocal(oidc), rejection)}/token?api-version=2.0`;
  const oidcEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: oidcUrl, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };

  const workosEnv = {
    ONTOLOGY_TEST_USER_EMAIL: 'ci+app@example.com',
    ONTOLOGY_TEST_USER_PASSWORD: 'app-test-password',
    WORKOS_API_KEY: 'sk_test_app',
  };

  const workos = standInWorkos(issuer, workosEnv, workosStub);
  const workosUrl = yield* attempt(() => listenLocal(workos), rejection);
  const unstubbed = globalThis.fetch;

  if (workosStub) globalThis.fetch = authkitTokens(issuer, workosStub, unstubbed);

  return {
    url,
    ...(workosStub ? { workosStub } : {}),
    audiences,
    issuer,
    oidcEnv,
    claims: (next) => {
      claims = next;
    },
    async *run(script, args, extra = {}): AsyncFallible<RunResult, unknown> {
      const env = { ...process.env, ...oidcEnv, ...extra };

      return yield* attempt(
        () =>
          new Promise<RunResult>((resolve) => {
            execFile(process.execPath, [script, ...args], { env }, (error, stdout, stderr) => {
              resolve({ code: error ? Number(error.code) : 0, lines: stdout.trim().split('\n'), stderr });
            });
          }),
        rejection,
      );
    },
    async *serve(extra): AsyncFallible<string, unknown> {
      const server = createNodeServer({
        db: createDb(pool),
        directDb: createDb(pool),
        settings: settingsFromEnv({ ...env, ...extra }),
        keys: issuer.keys,
        users: callers,
        workos: port,
      });

      more.push(server);

      return yield* attempt(() => listenLocal(server), rejection);
    },
    workos: { url: workosUrl, env: workosEnv },
    async *install(): AsyncFallible<void, unknown> {
      yield* attempt(async () => {
        const db = createPromiseDb(pool);

        if (!(await isInstalled(db, TEST_APP.productRid))) {
          await installOntology(db, {
            rid: TEST_APP.productRid,
            product: 'app',
            apiName: 'app',
            displayName: 'app',
            organization: ORGANIZATION,
          });
        }
      }, rejection);
    },
    async *query<Row extends pg.QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): AsyncFallible<Row[], unknown> {
      return yield* attempt(async () => (await pool.query<Row>(text, [...values])).rows, rejection);
    },
    async *stop(): AsyncFallible<void, unknown> {
      globalThis.fetch = unstubbed;

      yield* attempt(() => Promise.all([service, ...more, oidc, workos].map(closeServer)), rejection);

      yield* attempt(() => pool.end(), rejection);

      yield* attempt(() => postgres.stop(), rejection);
    },
  };
}

function authkitTokens(issuer: TestIssuer, stub: StubWorkos, passOn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);

    if (request.url !== `https://${TEST_APP.production.authkitDomain}/oauth2/token`) return passOn(input, init);

    return request.text().then((text) => {
      const form = new URLSearchParams(text);

      const [clientId = '', secret] = Buffer.from(
        (request.headers.get('authorization') ?? '').replace(/^Basic /, ''),
        'base64',
      )
        .toString('utf8')
        .split(':')
        .map(decodeURIComponent);

      const application = stub.applications()[clientId];

      if (
        form.get('grant_type') !== 'client_credentials' ||
        application === undefined ||
        secret === undefined ||
        stub.clientSecret(clientId) !== secret
      ) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }

      return issuer
        .m2m({
          sub: clientId,
          client_id: clientId,
          org_id: application.organization_id,
          scope: application.scopes.join(' '),
        })
        .then((access_token) => Response.json({ access_token, token_type: 'Bearer', expires_in: 3600 }));
    });
  };
}

function standInWorkos(
  issuer: TestIssuer,
  env: { ONTOLOGY_TEST_USER_EMAIL: string; ONTOLOGY_TEST_USER_PASSWORD: string; WORKOS_API_KEY: string },
  stub?: StubWorkos,
): Server {
  const answer = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  return createServer((request, response) => {
    if (stub && request.url?.startsWith('/connect/applications')) {
      if (request.headers.authorization !== `Bearer ${env.WORKOS_API_KEY}`)
        return answer(response, 401, { message: 'Unauthorized' });

      let text = '';

      request.on('data', (chunk: Buffer) => (text += chunk.toString()));

      request.on('end', () => {
        const init = {
          method: request.method ?? 'GET',
          headers: { authorization: `Bearer ${STUB_WORKOS_KEY}`, 'content-type': 'application/json' },
          ...(text === '' ? {} : { body: text }),
        };

        void caught(() => stub.fetch(`https://api.workos.com${request.url ?? ''}`, init)).then((reply) =>
          reply.ok
            ? reply.value
                .text()
                .then((replyText) =>
                  response.writeHead(reply.value.status, { 'content-type': 'application/json' }).end(replyText),
                )
            : response.destroy(),
        );
      });

      return;
    }

    if (request.method === 'GET') {
      const known =
        request.url === '/organizations/external_id/ontology-test-app' &&
        request.headers.authorization === `Bearer ${env.WORKOS_API_KEY}`;

      answer(response, known ? 200 : 404, known ? { id: ORGANIZATION, external_id: 'ontology-test-app' } : {});

      return;
    }

    let text = '';

    request.on('data', (chunk: Buffer) => (text += chunk.toString()));

    request.on('end', () => {
      const form = new URLSearchParams(text);

      if (
        form.get('client_id') !== TEST_APP.production.workosClientId ||
        form.get('client_secret') !== env.WORKOS_API_KEY
      )
        return answer(response, 401, { error: 'invalid_client' });

      if (form.get('grant_type') === 'password') {
        if (
          form.get('email') !== env.ONTOLOGY_TEST_USER_EMAIL ||
          form.get('password') !== env.ONTOLOGY_TEST_USER_PASSWORD
        )
          return answer(response, 400, { code: 'invalid_credentials' });

        void issuer
          .workos({ org_id: undefined, role: undefined })
          .then((access_token) =>
            answer(response, 200, { access_token, refresh_token: 'refresh-of-the-password-grant' }),
          );

        return;
      }

      if (
        form.get('grant_type') === 'refresh_token' &&
        form.get('refresh_token') === 'refresh-of-the-password-grant' &&
        form.get('organization_id') === ORGANIZATION
      ) {
        void issuer
          .workos({ role: 'admin' })
          .then((access_token) =>
            answer(response, 200, { access_token, refresh_token: 'refresh-of-the-organization' }),
          );

        return;
      }

      answer(response, 400, { error: 'invalid_grant' });
    });
  });
}
