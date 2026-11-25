import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildService } from '../../packages/service/build.ts';
import { attempt, outcome, type AsyncFallible, type Fallible } from '../../packages/service/src/errors/fallible.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const service = join(root, 'packages/service');

const SOURCE = ['api', 'public', 'src', 'vercel.json', 'osdk-sets.json'] as const;

const TEST_FILE = /\.(test|test-utils|fixture)\.ts$|(^|\/)__snapshots__(\/|$)/;

type Json = Record<string, unknown>;

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function* ownOptions(path: string): Fallible<Json, Error> {
  const { config, error } = ts.readConfigFile(path, (file) => ts.sys.readFile(file));

  if (error) return yield new Error(`${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);

  return (config as { compilerOptions?: Json }).compilerOptions ?? {};
}

function packageJson(): Json {
  const own = readJson(join(service, 'package.json'));
  const { overrides } = readJson(join(root, 'package.json'));

  return overrides === undefined ? own : { ...own, overrides };
}

function lockfile(pkg: Json, folder: string): void {
  const work = mkdtempSync(join(tmpdir(), 'service-lock-'));

  try {
    writeJson(join(work, 'package.json'), pkg);

    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: work,
      stdio: 'pipe',
    });

    renameSync(join(work, 'package-lock.json'), join(folder, 'npm-shrinkwrap.json'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function* makeServicePackage(folder: string): AsyncFallible<void, Error> {
  if (existsSync(folder)) return yield new Error(`${folder} exists. The service package needs a new folder.`);

  mkdirSync(folder, { recursive: true });

  for (const name of SOURCE)
    cpSync(join(service, name), join(folder, name), { recursive: true, filter: (source) => !TEST_FILE.test(source) });

  const pkg = packageJson();

  writeJson(join(folder, 'package.json'), pkg);

  const compilerOptions = {
    ...(yield* ownOptions(join(root, 'tsconfig.base.json'))),
    ...(yield* ownOptions(join(service, 'tsconfig.json'))),
  };

  writeJson(join(folder, 'tsconfig.json'), { compilerOptions, include: ['src', 'api'] });

  lockfile(pkg, folder);

  yield* attempt(
    () => buildService(join(folder, 'dist')),
    (error) => (error instanceof Error ? error : new Error(String(error))),
  );
}

if (import.meta.main) {
  const [folder, ...rest] = process.argv.slice(2);

  const made =
    folder === undefined || rest.length > 0
      ? { ok: false as const, error: new Error('Usage: node tools/packaging/service-package.ts <folder>') }
      : await outcome(() => makeServicePackage(folder));

  if (made.ok) console.log(`Made the service package in ${folder}.`);
  else {
    for (const line of (made.error as Error).message.split('\n')) console.log(`::error::${line}`);

    // oxlint-disable-next-line fallible/no-throw -- the border ends the process
    process.exit(1);
  }
}
