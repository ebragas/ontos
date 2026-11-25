import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type { App } from '../app.ts';
import { CliError } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { caught, type Fallible } from '../fallible.ts';

const CLI_PACKAGE = '@ericbragas/ontos-cli';
const SCHEMA_MIGRATIONS = '.ontology/schema-migrations.json';
const ONTOS_YML = 'ontos.yml';
const FOUNDRY_YML = 'foundry.yml';

export interface AppLayout {
  readonly ontology: string;
  readonly functions: string | undefined;
  readonly osdkOutput: string | undefined;
}

export type ValidationMode =
  | { readonly kind: 'remote' }
  | { readonly kind: 'local'; readonly fromRelease: string; readonly toRelease: string }
  | {
      readonly kind: 'mixed';
      readonly fromRelease: string;
      readonly toRelease: string;
      readonly ontologyFiles: readonly string[];
    };

function* readPackageJson(folder: string): Fallible<string, CliError> {
  const file = join(folder, 'package.json');

  if (!existsSync(file)) return yield new CliError('This folder has no package.json.');

  const text = caught(() => readFileSync(file, 'utf8'));

  if (!text.ok) return yield failureOf(text.error);

  return text.value;
}

function* parsePackageJson(text: string): Fallible<Record<string, unknown>, CliError> {
  const parsed = caught((): unknown => JSON.parse(text));

  if (!parsed.ok) return yield new CliError(`package.json is not valid JSON: ${(parsed.error as Error).message}`);

  const value = parsed.value;

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return yield new CliError('package.json does not hold a JSON object.');

  return value as Record<string, unknown>;
}

function cliPin(json: Record<string, unknown>): string | undefined {
  for (const field of ['dependencies', 'devDependencies']) {
    const entries = json[field];

    if (typeof entries === 'object' && entries !== null && Object.hasOwn(entries, CLI_PACKAGE)) {
      const pin = (entries as Record<string, unknown>)[CLI_PACKAGE];

      return typeof pin === 'string' ? pin : undefined;
    }
  }

  return undefined;
}

const toPosix = (path: string): string =>
  posix.normalize(path.split(sep).join('/')).replace(/^\.\//, '').replace(/\/$/, '');

const isUnder = (file: string, folder: string): boolean =>
  folder === '.' || folder === '' || file === folder || file.startsWith(`${folder}/`);

export function ontologySchemaFiles(changedPaths: readonly string[], layout: AppLayout): string[] {
  const ontology = toPosix(layout.ontology);
  const functions = layout.functions === undefined ? undefined : toPosix(layout.functions);
  const osdkOutput = layout.osdkOutput === undefined ? undefined : toPosix(layout.osdkOutput);
  const grants = posix.join(ontology, 'src/grants.json');
  const hits = new Set<string>();

  for (const raw of changedPaths) {
    const file = toPosix(raw);

    if (file === ONTOS_YML || file === FOUNDRY_YML || file === SCHEMA_MIGRATIONS) {
      hits.add(file);

      continue;
    }

    if (functions !== undefined && isUnder(file, functions)) {
      hits.add(file);

      continue;
    }

    if (isUnder(file, ontology)) {
      if (file === grants) continue;

      if (osdkOutput !== undefined && isUnder(file, osdkOutput)) continue;

      hits.add(file);
    }
  }

  return [...hits].sort();
}

export function classifyValidationMode({
  fromRelease,
  toRelease,
  changedPaths,
  layout,
}: {
  readonly fromRelease: string | undefined;
  readonly toRelease: string | undefined;
  readonly changedPaths: readonly string[];
  readonly layout: AppLayout;
}): ValidationMode {
  if (fromRelease === undefined || toRelease === undefined || fromRelease === toRelease) return { kind: 'remote' };

  const ontologyFiles = ontologySchemaFiles(changedPaths, layout);

  if (ontologyFiles.length > 0) return { kind: 'mixed', fromRelease, toRelease, ontologyFiles };

  return { kind: 'local', fromRelease, toRelease };
}

function appLayout(app: App): AppLayout {
  return {
    ontology: toPosix(relative(app.root, app.ontology)),
    functions: app.functions === undefined ? undefined : toPosix(relative(app.root, app.functions)),
    osdkOutput: app.osdkOutput === undefined ? undefined : toPosix(app.osdkOutput),
  };
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function* runGit(cwd: string, args: readonly string[]): Fallible<GitResult, CliError> {
  const spawned = caught(() =>
    spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }),
  );

  if (!spawned.ok) return yield failureOf(spawned.error);

  const result = spawned.value;

  if (result.error) return yield new CliError(`git could not run: ${result.error.message}`);

  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function* gitOutput(
  cwd: string,
  args: readonly string[],
  onError: (stderr: string) => string,
): Fallible<string, CliError> {
  const ran = yield* runGit(cwd, args);

  if (ran.status !== 0) return yield new CliError(onError(ran.stderr.trim()));

  return ran.stdout;
}

export function* readGitValidationMode(app: App, baseRef: string): Fallible<ValidationMode, CliError> {
  const top = (yield* gitOutput(
    app.root,
    ['rev-parse', '--show-toplevel'],
    (err) => `ontos validate --base needs a Git repository: ${err || 'git rev-parse failed'}`,
  )).trim();

  const realTop = caught(() => realpathSync(top));
  const realRoot = caught(() => realpathSync(app.root));

  if (!realTop.ok) return yield failureOf(realTop.error);

  if (!realRoot.ok) return yield failureOf(realRoot.error);

  const prefix = toPosix(relative(realTop.value, realRoot.value));

  yield* gitOutput(
    app.root,
    ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
    () =>
      `Base commit ${baseRef} is not in this Git checkout. Check out with fetch-depth: 0, or pass a valid Git commit or ref to --base.`,
  );

  const mergeBase = (yield* gitOutput(
    app.root,
    ['merge-base', baseRef, 'HEAD'],
    (err) => `Could not find merge base with ${baseRef}: ${err}`,
  )).trim();

  const basePkgPath = prefix === '' || prefix === '.' ? 'package.json' : `${prefix}/package.json`;
  const hasBasePkg = yield* runGit(app.root, ['cat-file', '-e', `${mergeBase}:${basePkgPath}`]);
  let fromRelease: string | undefined;

  if (hasBasePkg.status === 0) {
    const basePkgText = yield* gitOutput(
      app.root,
      ['show', `${mergeBase}:${basePkgPath}`],
      (err) => `Could not read ${basePkgPath} at ${mergeBase}: ${err}`,
    );

    fromRelease = cliPin(yield* parsePackageJson(basePkgText));
  }

  let toRelease: string | undefined;

  if (existsSync(join(app.root, 'package.json'))) {
    toRelease = cliPin(yield* parsePackageJson(yield* readPackageJson(app.root)));
  }

  const diffRaw = yield* gitOutput(
    app.root,
    ['-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', '-z', mergeBase],
    (err) => `Could not diff against ${baseRef}: ${err}`,
  );

  const untrackedRaw = yield* gitOutput(
    app.root,
    ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
    (err) => `Could not list untracked files: ${err}`,
  );

  const allPaths = [...diffRaw.split('\0'), ...untrackedRaw.split('\0')].filter(Boolean);

  const scoped =
    prefix === '' || prefix === '.'
      ? allPaths
      : allPaths.filter((path) => path.startsWith(`${prefix}/`)).map((path) => path.slice(prefix.length + 1));

  return classifyValidationMode({ fromRelease, toRelease, changedPaths: scoped, layout: appLayout(app) });
}
