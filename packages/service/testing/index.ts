import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { workosPublish, workosUsers, type WorkosUser } from '../src/auth/index.ts';
import { applyEngineChanges, createDb, createPool } from '../src/db/index.ts';
import { attempt, caught, settle, type AsyncFallible, type Fallible } from '../src/errors/index.ts';
import { settingsFromEnv } from '../src/handler/index.ts';
import { createNodeServer } from '../src/node.ts';
import { closeServer, listenLocal } from './localServer.ts';
import { issuerOf, ORGANIZATION, PERSON } from './tokens.ts';
import { STUB_WORKOS_KEY, stubWorkos, type StubMembership } from './workos.ts';

/** The `run` of `@ericbragas/ontos-cli`, with the fields of its `Io` that the local service passes. */
export type CliRun = (
  args: readonly string[],
  io: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly fetch: typeof fetch;
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  },
) => Promise<number>;

export interface LocalServiceOptions {
  /** The name of the app, as `ontos --app` takes it. It is the product of the publish and of the install. */
  readonly app: string;
  /** The `run` of `@ericbragas/ontos-cli`, which publishes the app. */
  readonly cli: CliRun;
  /** The app folder, with `.ontology/deployment.json`. The default is `process.cwd()`. */
  readonly folder?: string;
  /** The role of the person of `token`: a role of the grants file. The default is `admin`. */
  readonly role?: string;
  /**
   * A superuser connection string of a Postgres on this computer. The service makes its own database on it, and `stop`
   * drops it. The default starts a Postgres container, and `stop` removes it.
   */
  readonly postgres?: string;
}

export interface LocalService {
  /** The base URL of the service, on 127.0.0.1. */
  readonly url: string;
  /** A WorkOS access token of 1 person with `role` in the test Organization, for 12 hours. */
  readonly token: string;
  /** Stops the service, and removes the database or the container that the start made. */
  stop(): Promise<void>;
}

const POSTGRES_IMAGE = 'mirror.gcr.io/library/postgres:17-alpine';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TOKEN_SECONDS = 12 * 3600;
const INSTALLER = 'user_01JLOCALINSTALLER000000000';
const INSTALLER_ROLE = 'local-installer';

const run = promisify(execFile);
const isLoopback = (url: string): boolean => LOOPBACK.has(new URL(url).hostname);

function remoteHost(postgres: string): string | undefined {
  const url = new URL(postgres);

  return [url.hostname, ...url.searchParams.getAll('host')].find((host) => !LOOPBACK.has(host));
}

const guard = { count: 0, passOn: globalThis.fetch };

function guardFetch(): () => void {
  if (guard.count++ === 0) {
    guard.passOn = globalThis.fetch;

    const passOn = guard.passOn;

    // oxlint-disable-next-line landmines/no-test-doubles -- The fence that refuses fetches off this computer while the local service runs.
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);

      if (isLoopback(url)) return passOn(input, init);

      // oxlint-disable-next-line fallible/no-throw -- D1: the fence is the typeof fetch of the app test, and a fetch caller reads its rejection of a call off this computer.
      return Promise.reject(new Error(`The local Ontology service refused a call off this computer: ${url}`));
    };
  }

  let released = false;

  return () => {
    if (released) return;

    released = true;

    // oxlint-disable-next-line landmines/no-test-doubles -- Restores that fence at the last stop.
    if (--guard.count === 0) globalThis.fetch = guard.passOn;
  };
}

interface StagingSettings {
  readonly env: Record<string, string | undefined>;
  readonly authkitDomain: string;
}

const rejection = (error: unknown): unknown => error;

type Cleanup = () => AsyncFallible<unknown, unknown>;

const outsideStep =
  (call: () => Promise<unknown>): Cleanup =>
  () =>
    attempt(call, rejection);

function* stagingSettings(folder: string): Fallible<StagingSettings, unknown> {
  const file = join(folder, '.ontology/deployment.json');

  const read = caught(
    () =>
      JSON.parse(readFileSync(file, 'utf8')) as {
        productRid?: string;
        staging?: {
          baseUrl: string;
          workosClientId: string;
          trustedGithubRepository: string;
          trustedGithubEnvironment: string;
          authkitDomain: string;
          mcp?: boolean;
        };
      },
  );

  if (!read.ok) return yield read.error;

  const deployment = read.value;
  const { productRid, staging } = deployment;

  if (productRid === undefined || staging === undefined)
    return yield new Error(
      `${file} has no productRid or no staging environment. The local service runs the staging settings.`,
    );

  return {
    authkitDomain: staging.authkitDomain,
    env: {
      PRODUCT_RID: productRid,
      ONTOLOGY_ENVIRONMENT: 'staging',
      ONTOLOGY_BASE_URL: staging.baseUrl,
      WORKOS_CLIENT_ID: staging.workosClientId,
      TRUSTED_GITHUB_REPOSITORY: staging.trustedGithubRepository,
      TRUSTED_GITHUB_ENVIRONMENT: staging.trustedGithubEnvironment,
      AUTHKIT_DOMAIN: staging.authkitDomain,
      ONTOLOGY_MCP: staging.mcp === true ? 'true' : undefined,
    },
  };
}

async function* asAdmin<T>(
  adminUrl: string,
  query: (admin: pg.Client) => AsyncFallible<T, unknown>,
): AsyncFallible<T, unknown> {
  const made = caught(() => new pg.Client({ connectionString: adminUrl }));

  if (!made.ok) return yield made.error;

  const admin = made.value;

  yield* attempt(() => admin.connect(), rejection);

  const ran = await settle(query(admin));

  const ended = await caught(() => admin.end());

  if (!ended.ok) return yield ended.error;

  if (!ran.ok) return yield ran.error;

  return ran.value;
}

async function* startContainer(name: string): AsyncFallible<string, unknown> {
  yield* attempt(
    () =>
      run('docker', [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-e',
        'POSTGRES_PASSWORD=local',
        '-p',
        '127.0.0.1::5432',
        POSTGRES_IMAGE,
        '-c',
        'max_connections=500',
      ]),
    rejection,
  );

  const { stdout } = yield* attempt(() => run('docker', ['port', name, '5432/tcp']), rejection);
  const port = stdout.trim().split('\n')[0]?.split(':').pop();
  const url = `postgresql://postgres:local@127.0.0.1:${port}/postgres`;

  for (let tries = 0; ; tries++) {
    const ready = await settle(asAdmin(url, (admin) => attempt(() => admin.query('SELECT 1'), rejection)));

    if (ready.ok) return url;

    if (tries >= 300)
      return yield new Error(`The Postgres container ${name} took no connection in 30 seconds.`, {
        cause: ready.error,
      });

    yield* attempt(() => new Promise<void>((resolve) => setTimeout(resolve, 100)), rejection);
  }
}

async function* stopAll(cleanups: Cleanup[]): AsyncFallible<void, unknown> {
  const failures: unknown[] = [];

  for (const cleanup of cleanups.splice(0).reverse()) {
    const done = await settle(cleanup());

    if (!done.ok) failures.push(done.error);
  }

  if (failures.length === 1) return yield failures[0];

  if (failures.length > 1)
    return yield new AggregateError(failures, `${failures.length} steps of the stop of the local service failed.`);
}

function stopperOf(cleanups: Cleanup[]): () => Promise<void> {
  return async () => {
    const stopped = await settle(stopAll(cleanups));

    // oxlint-disable-next-line fallible/no-throw -- D1: stop is the public testing API, and an app test reads its rejection, a failed step or the AggregateError of several.
    if (!stopped.ok) throw stopped.error;
  };
}

interface Started {
  readonly url: string;
  readonly token: string;
}

async function* start(options: LocalServiceOptions, cleanups: Cleanup[]): AsyncFallible<Started, unknown> {
  const { app, cli, folder = process.cwd(), role = 'admin', postgres } = options;
  const remote = caught(() => (postgres === undefined ? undefined : remoteHost(postgres)));

  if (!remote.ok) return yield remote.error;

  if (remote.value !== undefined)
    return yield new Error(`The local service takes only a Postgres on this computer, not ${remote.value}.`);

  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  const release = guardFetch();

  cleanups.push(outsideStep(() => Promise.resolve(release())));

  const { env, authkitDomain } = yield* stagingSettings(folder);

  let adminUrl = postgres;

  if (adminUrl === undefined) {
    const container = `ontology-local-${id}`;

    cleanups.push(outsideStep(() => run('docker', ['rm', '-f', container])));

    adminUrl = yield* startContainer(container);
  }

  const name = `local_${id}`;

  yield* asAdmin(adminUrl, async function* (admin): AsyncFallible<void, unknown> {
    yield* attempt(() => admin.query(`CREATE ROLE ${name} LOGIN SUPERUSER PASSWORD '${name}'`), rejection);

    yield* attempt(() => admin.query(`CREATE DATABASE ${name} OWNER ${name}`), rejection);
  });

  if (postgres !== undefined) {
    cleanups.push(() =>
      asAdmin(postgres, async function* (admin): AsyncFallible<void, unknown> {
        yield* attempt(() => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`), rejection);

        yield* attempt(() => admin.query(`DROP ROLE IF EXISTS ${name}`), rejection);
      }),
    );
  }

  const pool = createPool(
    Object.assign(new URL(adminUrl), { username: name, password: name, pathname: `/${name}` }).toString(),
  );

  cleanups.push(outsideStep(() => pool.end()));

  const settings = caught(() => settingsFromEnv(env));

  if (!settings.ok) return yield settings.error;

  const issuer = yield* issuerOf(settings.value.auth, authkitDomain);
  const person: WorkosUser = { id: PERSON, email: `ci+${app}@example.com`, first_name: 'CI', last_name: app };

  const installer: WorkosUser = {
    id: INSTALLER,
    email: `installer+${app}@example.com`,
    first_name: 'Installer',
    last_name: app,
  };

  const membership = (user: WorkosUser, slug: string): StubMembership => ({
    user_id: user.id,
    organization_id: ORGANIZATION,
    status: 'active',
    organization_name: `${app} test`,
    roles: [slug],
  });

  const stubbed = caught(() =>
    stubWorkos([person, installer], [membership(person, role), membership(installer, INSTALLER_ROLE)], {
      roles: { [ORGANIZATION]: { [INSTALLER_ROLE]: ['ontology:install'] } },
      environment: { permissions: {}, roles: {} },
    }),
  );

  if (!stubbed.ok) return yield stubbed.error;

  const workos = stubbed.value;
  const db = createDb(pool);

  const applied = await settle(applyEngineChanges(db));

  if (!applied.ok) return yield applied.error.error;

  const service = createNodeServer({
    db,
    directDb: db,
    settings: settings.value,
    keys: issuer.keys,
    users: workosUsers(STUB_WORKOS_KEY, { fetch: workos.fetch }),
    workos: workosPublish(STUB_WORKOS_KEY, { fetch: workos.fetch }),
  });

  const url = yield* attempt(() => listenLocal(service), rejection);

  cleanups.push(outsideStep(() => closeServer(service)));

  const oidc: Server = createServer((request, response) => {
    const audience = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('audience');

    if (request.headers.authorization !== 'Bearer local-request-token' || audience === null)
      return void response.writeHead(401).end();

    void issuer
      .github({ aud: audience, ref: 'refs/heads/staging' })
      .then((value) => response.end(JSON.stringify({ value })));
  });

  const oidcUrl = yield* attempt(() => listenLocal(oidc), rejection);

  cleanups.push(outsideStep(() => closeServer(oidc)));

  const shell = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !['GITHUB_ACTIONS', 'ONTOLOGY_TOKEN', 'ONTOLOGY_APP'].includes(name),
    ),
  );

  let output = '';

  const code = yield* attempt(
    () =>
      cli(['publish', '--app', app, '--env', 'staging', '--url', url, '--skip-sdk-package'], {
        cwd: folder,
        env: {
          ...shell,
          ACTIONS_ID_TOKEN_REQUEST_URL: `${oidcUrl}/token?api-version=2.0`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'local-request-token',
        },
        fetch: globalThis.fetch,
        stdout: (text) => void (output += text),
        stderr: (text) => void (output += text),
      }),
    rejection,
  );

  if (code !== 0) return yield new Error(`ontos publish of ${app} failed: ${output.trim()}`);

  if (!(role in workos.environment().roles)) {
    return yield new Error(
      `The grants file of ${app} has no role ${role}. Its roles: ${Object.keys(workos.environment().roles).join(', ')}.`,
    );
  }

  const installerToken = yield* attempt(() => issuer.workos({ sub: INSTALLER, role: INSTALLER_ROLE }), rejection);

  const installed = yield* attempt(
    () =>
      fetch(`${url}/api/ontology-service/v1/ontologies`, {
        method: 'POST',
        headers: { authorization: `Bearer ${installerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ product: app, apiName: app, displayName: app }),
      }),
    rejection,
  );

  if (!installed.ok) {
    const text = yield* attempt(() => installed.text(), rejection);

    return yield new Error(`The install of ${app} gave HTTP ${installed.status}: ${text}`);
  }

  yield* attempt(() => installed.text(), rejection);

  const token = yield* attempt(
    () => issuer.workos({ sub: PERSON, role, exp: Math.floor(Date.now() / 1000) + TOKEN_SECONDS }),
    rejection,
  );

  return { url, token };
}

/**
 * Starts 1 Ontology service on a free port of this computer, publishes the app with its grants file through the CLI,
 * and installs it for the test Organization. Each start gets its own database, so 2 starts can share 1 Postgres.
 */
export async function startLocalService(options: LocalServiceOptions): Promise<LocalService> {
  const cleanups: Cleanup[] = [];

  const started = await caught(() => settle(start(options, cleanups)));

  const ended = started.ok ? started.value : started;

  if (ended.ok) return { ...ended.value, stop: stopperOf(cleanups) };

  await settle(stopAll(cleanups));

  // oxlint-disable-next-line fallible/no-throw -- D1: startLocalService is the public testing API, and an app test reads its rejection, such as the pg error of a failed engine change.
  throw ended.error;
}
