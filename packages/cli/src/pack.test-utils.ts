import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestSharedBuild } from '../../../test/sharedBuildClient.ts';
import { ROOT } from './cli.test-utils.ts';

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`${command} ${args.join(' ')} exited with ${String(error.code)}: ${stderr || stdout}`));
      else resolve(stdout);
    });
  });
}

export async function packCli(): Promise<{ file: string; files: string[] }> {
  const shared = await requestSharedBuild('cliPack');

  if (shared) return { file: shared.file, files: [...shared.files] };

  await run('npm', ['run', 'build', '-w', 'packages/cli'], ROOT);

  const destination = mkdtempSync(join(tmpdir(), 'ontology-cli-pack-'));

  const [packed] = JSON.parse(
    await run('npm', ['pack', '-w', 'packages/cli', '--pack-destination', destination, '--json'], ROOT),
  ) as { filename: string; files: { path: string }[] }[];

  if (!packed) throw new Error('npm pack wrote no file.');

  return { file: join(destination, packed.filename), files: packed.files.map(({ path }) => path).sort() };
}

export async function installCli(file: string): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), 'ontology-cli-install-'));

  writeFileSync(join(folder, 'package.json'), '{"name":"app","private":true}\n');

  await run('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', file], folder);

  return folder;
}

export { run };
