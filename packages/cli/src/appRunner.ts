import type { PublishRequest } from '@ericbragas/ontos-service/publish';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installedPackage, type App } from './app.ts';
import { TOKEN_VARIABLES } from './auth/keys.ts';
import { CliError } from './cliError.ts';
import { failureOf } from './errors.ts';
import { attempt, type AsyncFallible, type Fallible } from './fallible.ts';

const SUBPROCESS_SECRET_VARIABLES = new Set([
  ...TOKEN_VARIABLES,
  'NODE_AUTH_TOKEN',
  'WORKOS_API_KEY',
  'ONTOLOGY_TEST_USER_EMAIL',
  'ONTOLOGY_TEST_USER_PASSWORD',
]);

export async function* runNode(script: string, args: readonly string[], cwd: string): AsyncFallible<string, CliError> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SUBPROCESS_SECRET_VARIABLES.has(name)),
  );

  const ran = yield* attempt(
    () =>
      new Promise<{ readonly error: Error | null; readonly stdout: string; readonly stderr: string }>((done) => {
        execFile(
          process.execPath,
          [script, ...args],
          { cwd, env, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => done({ error, stdout, stderr }),
        );
      }),
    failureOf,
  );

  if (ran.error) return yield new CliError(`${script} failed: ${ran.stderr || ran.stdout || ran.error.message}`);

  return ran.stdout;
}

export function* installedBin(app: App, name: string, command: string): Fallible<string, CliError> {
  const manifest = installedPackage(app, name);

  if (!manifest) return yield new CliError(`The app does not install ${name}.`);

  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
  const script = typeof bin === 'string' ? bin : bin?.[command];

  if (!script) return yield new CliError(`${name} has no bin ${command}.`);

  return join(dirname(manifest), script);
}

export async function* makeIr(app: App): AsyncFallible<PublishRequest['ir'], CliError> {
  const input = join(app.ontology, 'src', 'ontology.mts');

  if (!existsSync(input)) return yield new CliError(`No Ontology-as-code: ${input} does not exist.`);

  const script = yield* installedBin(app, '@osdk/maker', 'maker');
  const out = mkdtempSync(join(tmpdir(), 'ontology-ir-'));

  try {
    const output = join(out, 'ontology.json');

    yield* runNode(
      script,
      [
        '--input',
        input,
        '--output',
        output,
        '--valueTypesOutput',
        join(out, 'value-types.json'),
        '--apiNamespace',
        app.apiNamespace,
        '--snapshotDir',
        join(out, 'snapshots'),
      ],
      app.ontology,
    );

    return JSON.parse(readFileSync(output, 'utf8')) as PublishRequest['ir'];
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
