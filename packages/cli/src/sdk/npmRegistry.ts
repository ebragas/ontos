import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_VARIABLES } from '../auth/keys.ts';
import { CliError } from '../cliError.ts';
import { failureOf, formatCommand, parseCommandJson } from '../errors.ts';
import { attempt, caught, settle, type AsyncFallible } from '../fallible.ts';
import type { Registry } from '../io.ts';

interface Finished {
  readonly error: Error | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function* run(command: string, args: readonly string[], cwd?: string): AsyncFallible<string, CliError> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !TOKEN_VARIABLES.includes(name)));

  const { error, stdout, stderr } = yield* attempt(
    () =>
      new Promise<Finished>((resolve) =>
        execFile(command, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
          resolve({ error, stdout, stderr }),
        ),
      ),
    failureOf,
  );

  if (error)
    return yield new CliError(`${command} ${args.join(' ')} failed: ${(stderr || stdout || error.message).trim()}`);

  return stdout;
}

const npm = (args: readonly string[], cwd: string): AsyncFallible<string, CliError> => run('npm', args, cwd);

const newestFirst = (a: string, b: string): number => {
  const [x, y] = [a, b].map((version) => version.split(/[.+-]/).slice(0, 3).map(Number));

  for (let at = 0; at < 3; at += 1) if ((x?.[at] ?? 0) !== (y?.[at] ?? 0)) return (y?.[at] ?? 0) - (x?.[at] ?? 0);

  return 0;
};

export const npmRegistry: Registry = {
  async *find(
    name: string,
    ontologyHash: string,
    cwd: string,
    registry: string,
  ): AsyncFallible<string | undefined, CliError> {
    const viewArgs = ['view', `${name}@>=0.0.0`, 'version', '--json', '--registry', registry];

    const viewed = await settle(npm(viewArgs, cwd));

    if (!viewed.ok) {
      if (/\bE404\b/.test(viewed.error.message)) return undefined;

      return yield viewed.error;
    }

    if (!viewed.value.trim()) return undefined;

    const parsed = yield* parseCommandJson(formatCommand('npm', viewArgs), viewed.value);
    const versions = (Array.isArray(parsed) ? (parsed as string[]) : [parsed as string]).sort(newestFirst);
    const made = caught(() => mkdtempSync(join(tmpdir(), 'ontology-sdk-versions-')));

    if (!made.ok) return yield failureOf(made.error);

    const folder = made.value;

    const found = await settle(versionOf(name, ontologyHash, versions, folder, cwd, registry));

    const removed = caught(() => rmSync(folder, { recursive: true, force: true }));

    if (!removed.ok) return yield failureOf(removed.error);

    if (!found.ok) return yield found.error;

    return found.value;
  },
  async *publish(folder: string, cwd: string): AsyncFallible<void, CliError> {
    yield* npm(['publish', folder], cwd);
  },
  async *tag(name: string, version: string, tag: string, cwd: string, registry: string): AsyncFallible<void, CliError> {
    yield* npm(['dist-tag', 'add', `${name}@${version}`, tag, '--registry', registry], cwd);
  },
};

async function* versionOf(
  name: string,
  ontologyHash: string,
  versions: readonly string[],
  folder: string,
  cwd: string,
  registry: string,
): AsyncFallible<string | undefined, CliError> {
  for (const version of versions) {
    const packArgs = ['pack', `${name}@${version}`, '--json', '--pack-destination', folder, '--registry', registry];
    const output = yield* npm(packArgs, cwd);
    const packed = yield* parseCommandJson(formatCommand('npm', packArgs), output);
    const first = Array.isArray(packed) ? (packed[0] as { filename?: unknown } | undefined) : undefined;

    if (typeof first?.filename !== 'string') return yield new CliError(`npm pack ${name}@${version} wrote no file.`);

    const tarArgs = ['-xzOf', join(folder, first.filename), 'package/package.json'];
    const text = yield* run('tar', tarArgs);
    const manifest = yield* parseCommandJson(formatCommand('tar', tarArgs), text);

    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      (manifest as { ontologyHash?: unknown }).ontologyHash === ontologyHash
    )
      return version;
  }

  return undefined;
}
