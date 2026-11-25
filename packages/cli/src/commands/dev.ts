import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as OntosService from '@ericbragas/ontos-service';
import { CliError } from '../cliError.ts';
import { DEFAULT_DEV_PRODUCT_RID, isProductRid } from '../deploymentFile.ts';
import { failureOf } from '../errors.ts';
import { attempt, caught, type AsyncFallible, type Fallible } from '../fallible.ts';
import type { Io } from '../io.ts';
import type { Flags } from '../main.ts';
import { cliSettings } from '../targets.ts';
import type { Result } from './types.ts';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DEV_TOKEN = 'ontos-dev-token';

type ServiceModule = Pick<typeof OntosService, 'createNodeServer' | 'createPool' | 'inputFromEnv'>;

interface DevOptions {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly token: string;
  readonly productRid: string;
}

interface TrackedPool {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

function isServiceModule(value: unknown): value is ServiceModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'inputFromEnv' in value &&
    typeof value.inputFromEnv === 'function' &&
    'createPool' in value &&
    typeof value.createPool === 'function' &&
    'createNodeServer' in value &&
    typeof value.createNodeServer === 'function'
  );
}

function resolveServiceFromCwd(cwd: string): string | undefined {
  const resolved = caught(() => createRequire(join(cwd, 'package.json')).resolve('@ericbragas/ontos-service'));

  return resolved.ok ? resolved.value : undefined;
}

async function* loadService(cwd: string): AsyncFallible<ServiceModule, CliError> {
  const fromCwd = resolveServiceFromCwd(cwd);

  const loaded = yield* attempt(
    (): Promise<unknown> =>
      fromCwd !== undefined ? import(pathToFileURL(fromCwd).href) : import('@ericbragas/ontos-service'),
    (error) =>
      new CliError(
        `Could not load @ericbragas/ontos-service: ${error instanceof Error ? error.message : String(error)}. Install @ericbragas/ontos-service to run ontos dev.`,
      ),
  );

  if (!isServiceModule(loaded)) {
    return yield new CliError(
      'Loaded @ericbragas/ontos-service module is missing inputFromEnv, createPool, or createNodeServer.',
    );
  }

  return loaded;
}

function formatOrigin(host: string, port: number): string {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${formattedHost}:${port}`;
}

function* parsePort(value: string | undefined): Fallible<number, CliError> {
  if (value === undefined) return DEFAULT_PORT;

  if (!/^\d+$/.test(value)) {
    return yield new CliError(
      `--port must be a whole number from 0 to 65535, not ${value.trim() === '' ? 'an empty string' : value}.`,
    );
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return yield new CliError(`--port must be a whole number from 0 to 65535, not ${value}.`);
  }

  return parsed;
}

function* resolveDevOptions(flags: Flags, io: Pick<Io, 'cwd' | 'env'>): Fallible<DevOptions, CliError> {
  const settings = cliSettings(io);
  const port = yield* parsePort(flags.port);
  const host = flags.host ?? DEFAULT_HOST;

  if (host.trim() === '') return yield new CliError('--host must be a non-empty hostname or IP address.');

  const databaseUrl = flags['database-url'] ?? settings['DATABASE_URL'];

  if (!databaseUrl) {
    return yield new CliError('No database URL: pass --database-url <url>, or set DATABASE_URL.');
  }

  const token = flags.token ?? settings['ONTOS_DEV_TOKEN'] ?? DEFAULT_DEV_TOKEN;

  if (token === '') return yield new CliError('--token must be a non-empty string.');

  const productRid = flags['product-rid'] ?? settings['PRODUCT_RID'] ?? DEFAULT_DEV_PRODUCT_RID;

  if (!isProductRid(productRid)) {
    return yield new CliError('--product-rid must have the form ri.ontology.main.ontology.<UUID>.');
  }

  return { port, host, databaseUrl, token, productRid };
}

function listenOn(
  server: Server,
  port: number,
  host: string,
  onBound: (boundPort: number) => void,
): Promise<{ readonly ok: true; readonly port: number } | { readonly ok: false; readonly error: Error }> {
  return new Promise((resolve) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);

      resolve({ ok: false, error });
    };

    const onListening = (): void => {
      server.off('error', onError);

      const boundPort = (server.address() as AddressInfo).port;

      onBound(boundPort);

      resolve({ ok: true, port: boundPort });
    };

    server.once('error', onError);

    server.once('listening', onListening);

    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());

    server.closeAllConnections();
  });
}

async function closePools(pools: readonly TrackedPool[]): Promise<void> {
  await caught(() => Promise.all(pools.map((pool) => caught(() => pool.end()))));
}

function formatStartup(
  info: {
    readonly url: string;
    readonly mcpUrl: string;
    readonly token: string;
    readonly productRid: string;
    readonly database: string;
  },
  io: Pick<Io, 'isTty'>,
  json: boolean,
): string {
  if (json || !io.isTty) {
    return `${JSON.stringify({ status: 'listening', ...info })}\n`;
  }

  return [
    'Ontos dev server listening',
    `  URL:         ${info.url}`,
    `  MCP:         ${info.mcpUrl}`,
    `  Dev token:   ${info.token}`,
    `  Product RID: ${info.productRid}`,
    `  Database:    ${info.database}`,
    '',
    'Press Ctrl+C to stop.',
    '',
  ].join('\n');
}

export async function* runDev(io: Io, flags: Flags): AsyncFallible<Result, CliError> {
  const options = yield* resolveDevOptions(flags, io);
  const service = yield* loadService(io.cwd);

  const pools: TrackedPool[] = [];
  let baseUrl = formatOrigin(options.host, options.port);

  const input = service.inputFromEnv(
    {
      DATABASE_URL: options.databaseUrl,
      ONTOS_AUTH_MODE: 'dev',
      ONTOS_DEV_TOKEN: options.token,
      PORT: String(options.port),
      ONTOLOGY_BASE_URL: baseUrl,
      PRODUCT_RID: options.productRid,
    },
    (connectionString) => {
      const pool = service.createPool(connectionString);

      pools.push(pool);

      return pool;
    },
  );

  if ('missing' in input) {
    await caught(() => closePools(pools));

    return yield new CliError(
      input.reason ?? `Cannot start dev server; missing settings: ${input.missing.join(', ')}.`,
    );
  }

  const probePool = pools[0];

  if (probePool !== undefined) {
    const probed = await caught(() => probePool.query('SELECT 1'));

    if (!probed.ok) {
      await caught(() => closePools(pools));

      return yield new CliError(
        `Cannot connect to PostgreSQL: ${probed.error instanceof Error ? probed.error.message : String(probed.error)}`,
      );
    }
  }

  const serverInput = {
    ...input,
    settings: {
      ...input.settings,
      auth: {
        ...input.settings.auth,
        get baseUrl(): string {
          return baseUrl;
        },
      },
    },
  };

  const server = service.createNodeServer(serverInput);

  const bound = yield* attempt(
    () =>
      listenOn(server, options.port, options.host, (boundPort) => {
        baseUrl = formatOrigin(options.host, boundPort);
      }),
    failureOf,
  );

  if (!bound.ok) {
    await caught(() => closePools(pools));

    return yield failureOf(bound.error);
  }

  const url = baseUrl;
  const mcpUrl = `${url}/api/mcp`;

  io.stdout(
    formatStartup(
      { url, mcpUrl, token: options.token, productRid: options.productRid, database: 'connected' },
      io,
      flags.json === true,
    ),
  );

  const stopped = Promise.withResolvers<undefined>();
  let closing: Promise<void> | undefined;

  const stop = (): Promise<void> =>
    (closing ??= closeServer(server)
      .finally(() => closePools(pools))
      .then(() => {
        stopped.resolve(undefined);
      }));

  const removeStop = io.onStop(stop);

  yield* attempt(() => stopped.promise, failureOf);

  removeStop();

  return { output: undefined, code: 0, printed: true };
}
