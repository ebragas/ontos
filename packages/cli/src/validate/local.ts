import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGrants, type App } from '../app.ts';
import { TOKEN_VARIABLES } from '../auth/keys.ts';
import { CliError } from '../cliError.ts';
import type { Context } from '../commands/types.ts';
import { readDeploymentFile } from '../deploymentFile.ts';
import { failureOf } from '../errors.ts';
import { attempt, caught, settle, type AsyncFallible, type Fallible } from '../fallible.ts';
import type { Io } from '../io.ts';
import type { PublishOutput } from '../publish.ts';
import { findUp } from '../targets.ts';

const SERVICE_PACKAGE = '@ericbragas/ontos-service';
const STDERR_ENDS = 10;

export type ValidateOutput = PublishOutput & { readonly local?: true };

interface LocalServiceCliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface LocalServiceOptions {
  readonly app: string;
  readonly cli: (args: readonly string[], io: LocalServiceCliIo) => Promise<number>;
  readonly folder?: string;
  readonly role?: string;
}

interface LocalService {
  readonly url: string;
  readonly token: string;
  stop(): Promise<void>;
}

interface TestingModule {
  readonly startLocalService: (options: LocalServiceOptions) => Promise<LocalService>;
}

interface LoadedService {
  readonly entry: string;
  readonly tempDir: string | undefined;
}

function jsonField(text: string, path: string): string | undefined {
  const parsed = caught(() => JSON.parse(text) as unknown);

  if (!parsed.ok) return undefined;

  let value = parsed.value;

  for (const name of path.split('.'))
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;

  return typeof value === 'string' ? value : undefined;
}

function findInstalledTestingEntry(appRoot: string, version: string): string | undefined {
  const manifestPath = findUp(appRoot, join('node_modules', SERVICE_PACKAGE, 'package.json'));

  if (!manifestPath) return undefined;

  const parsed = caught(() => JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown });

  if (!parsed.ok || parsed.value.version !== version) return undefined;

  const pkgDir = dirname(manifestPath);

  for (const candidate of [join(pkgDir, 'dist', 'testing', 'index.js'), join(pkgDir, 'testing', 'index.ts')]) {
    if (!existsSync(candidate)) continue;

    const real = caught(() => realpathSync(candidate));

    if (real.ok) return real.value;
  }

  return undefined;
}

function trimStderr(text: string, secret: string | undefined): string {
  const safe = secret ? text.replaceAll(secret, '***') : text;
  const lines = safe.trim().split('\n').filter(Boolean);

  if (lines.length <= 2 * STDERR_ENDS) return lines.join('\n');

  return [
    ...lines.slice(0, STDERR_ENDS),
    `(${lines.length - 2 * STDERR_ENDS} lines left out)`,
    ...lines.slice(-STDERR_ENDS),
  ].join('\n');
}

function* runInstallStep(
  name: string,
  argv: readonly [string, ...string[]],
  cwd: string,
  env: Readonly<Record<string, string>>,
  secret: string | undefined,
): Fallible<string, CliError> {
  const [program, ...args] = argv;

  const spawned = caught(() =>
    spawnSync(program, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

  if (!spawned.ok) return yield failureOf(spawned.error);

  const result = spawned.value;

  if (result.error) return yield new CliError(`${name}: ${program} could not run.`);

  if ((result.status ?? 1) !== 0) {
    const stderr = trimStderr(result.stderr, secret);

    return yield new CliError(
      `${name}: ${program} exited with code ${result.status ?? 1}.${stderr === '' ? '' : `\n${stderr}`}`,
    );
  }

  return result.stdout.trim();
}

function* resolveTestingEntry(appRoot: string, version: string, io: Io): Fallible<LoadedService, CliError> {
  const installed = findInstalledTestingEntry(appRoot, version);

  if (installed !== undefined) return { entry: installed, tempDir: undefined };

  const made = caught(() => mkdtempSync(join(tmpdir(), 'ontology-local-service-')));

  if (!made.ok) return yield failureOf(made.error);

  const tempDir = made.value;
  const serviceDir = join(tempDir, 'service');
  const secret = io.env['NODE_AUTH_TOKEN'];
  const withheld = new Set(['NODE_AUTH_TOKEN', ...TOKEN_VARIABLES]);

  const baseEnv = Object.fromEntries(
    Object.entries(io.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !withheld.has(entry[0]),
    ),
  );

  const packEnv = secret === undefined ? baseEnv : { ...baseEnv, NODE_AUTH_TOKEN: secret };

  const setup = settle(
    (function* (): Fallible<string, CliError> {
      const dir = caught(() => mkdirSync(serviceDir, { recursive: true }));

      if (!dir.ok) return yield failureOf(dir.error);

      const packed = yield* runInstallStep(
        `Install ${SERVICE_PACKAGE}@${version}`,
        ['npm', 'pack', `${SERVICE_PACKAGE}@${version}`, '--json', '--pack-destination', tempDir],
        appRoot,
        packEnv,
        secret,
      );

      const tarball = jsonField(packed, '0.filename');

      if (!tarball)
        return yield new CliError(`Install ${SERVICE_PACKAGE}@${version}: npm pack gave no 0.filename in JSON.`);

      yield* runInstallStep(
        'Unpack the service package',
        ['tar', '-xzf', tarball, '-C', serviceDir, '--strip-components=1'],
        tempDir,
        baseEnv,
        secret,
      );

      yield* runInstallStep(
        'Name the lockfile package-lock.json',
        ['mv', 'npm-shrinkwrap.json', 'package-lock.json'],
        serviceDir,
        baseEnv,
        secret,
      );

      yield* runInstallStep(
        'Install the dependencies of the service package',
        ['npm', 'ci', '--ignore-scripts', '--omit=dev'],
        serviceDir,
        baseEnv,
        secret,
      );

      const entry = join(serviceDir, 'dist', 'testing', 'index.js');

      if (!existsSync(entry))
        return yield new CliError(`${SERVICE_PACKAGE}@${version} has no testing entry at dist/testing/index.js.`);

      return entry;
    })(),
  );

  if (!setup.ok) {
    caught(() => rmSync(tempDir, { recursive: true, force: true }));

    return yield setup.error;
  }

  return { entry: setup.value, tempDir };
}

function splitPublishStderr(stderr: string): { warnings: string[]; errorBody: unknown } {
  const warnings: string[] = [];
  let errorBody: unknown;

  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '') continue;

    const parsed = caught((): unknown => JSON.parse(trimmed));

    if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && 'warning' in parsed.value) {
      warnings.push(trimmed);
    } else if (parsed.ok) {
      errorBody = parsed.value;
    }
  }

  return { warnings, errorBody };
}

async function* runLocalValidation(
  context: Context,
  app: App,
  entry: string,
  role: string | undefined,
): AsyncFallible<ValidateOutput, CliError> {
  // oxlint-disable-next-line local/static-import -- loads the local testing module from a resolved file URL
  const module = yield* attempt(() => import(pathToFileURL(entry).href) as Promise<TestingModule>, failureOf);
  let publishStdout = '';
  let publishStderr = '';
  let publishCode = 0;

  const nestedCli: LocalServiceOptions['cli'] = async (args, cliIo) => {
    const ran = await caught(() =>
      context.run(args, {
        ...context.io,
        cwd: cliIo.cwd,
        env: cliIo.env,
        fetch: cliIo.fetch,
        stdout: (text) => {
          publishStdout += text;

          cliIo.stdout(text);
        },
        stderr: (text) => {
          publishStderr += text;

          cliIo.stderr(text);
        },
      }),
    );

    publishCode = ran.ok ? ran.value : 1;

    return publishCode;
  };

  const started = await caught(() =>
    module.startLocalService({
      app: context.target.app,
      cli: nestedCli,
      folder: app.root,
      ...(role === undefined ? {} : { role }),
    }),
  );

  if (!started.ok) {
    const { errorBody } = splitPublishStderr(publishStderr);
    const message = started.error instanceof Error ? started.error.message : String(started.error);

    if (publishCode !== 0 && errorBody !== undefined) return yield new CliError(message, errorBody);

    return yield new CliError(message);
  }

  const local = started.value;
  const removeStop = context.io.onStop(() => local.stop());

  const stopped = await caught(() => local.stop());

  removeStop();

  if (!stopped.ok) return yield failureOf(stopped.error);

  const { warnings } = splitPublishStderr(publishStderr);

  for (const line of warnings) context.io.stderr(`${line}\n`);

  const parsed = caught(() => JSON.parse(publishStdout) as PublishOutput);

  if (!parsed.ok) return yield new CliError('Local publish printed no JSON output.');

  const { changes, metadata } = parsed.value;

  return { local: true, changes, metadata };
}

export async function* validateLocal(context: Context, app: App): AsyncFallible<ValidateOutput, CliError> {
  const grants = yield* readGrants(app);
  const { file: deployment } = yield* readDeploymentFile(app.root);

  if (deployment.staging === undefined) {
    return yield new CliError(
      '.ontology/deployment.json has no staging environment. The local service runs the staging settings.',
    );
  }

  const role = Object.hasOwn(grants.defaultRoles, 'admin') ? 'admin' : Object.keys(grants.defaultRoles)[0];
  const loaded = yield* resolveTestingEntry(app.root, context.version, context.io);

  const ran = await settle(runLocalValidation(context, app, loaded.entry, role));

  const { tempDir } = loaded;

  if (tempDir !== undefined) caught(() => rmSync(tempDir, { recursive: true, force: true }));

  if (!ran.ok) return yield ran.error;

  return ran.value;
}
