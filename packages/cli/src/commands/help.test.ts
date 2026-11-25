import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { cli, CLI_VERSION, ROOT, tempFolder } from '../cli.test-utils.ts';
import { requestSharedBuild } from '../../../../test/sharedBuildClient.ts';
import { COMMANDS, type Command } from './index.ts';

interface SmokeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let isolatedVersion: SmokeResult;
let isolatedHelp: SmokeResult;
let isolatedDevHelp: SmokeResult;

beforeAll(async () => {
  const shared = await requestSharedBuild('cliBuild');

  const bundle = shared?.bundle ?? join(ROOT, 'packages/cli/dist/ontos.js');
  const isolated = tempFolder();

  mkdirSync(join(isolated, 'dist'), { recursive: true });

  copyFileSync(bundle, join(isolated, 'dist/ontos.js'));

  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
    name: string;
    version: string;
    type: string;
  };

  writeFileSync(
    join(isolated, 'package.json'),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: manifest.type }),
  );

  const runIsolated = (args: readonly string[]): SmokeResult => {
    const result = spawnSync(process.execPath, [join(isolated, 'dist/ontos.js'), ...args], {
      cwd: isolated,
      encoding: 'utf8',
    });

    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  isolatedVersion = runIsolated(['--version']);

  isolatedHelp = runIsolated(['--help']);

  isolatedDevHelp = runIsolated(['dev', '--help']);
}, 60_000);

describe('ontos --help and -h', () => {
  const allCommands = Object.keys(COMMANDS) as Command[];

  it('prints global help to stdout and exits 0 for --help, -h, and help', async () => {
    for (const args of [['--help'], ['-h'], ['help']]) {
      const result = await cli(args);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: ontos <command> [options]');

      for (const name of allCommands) {
        expect(result.stdout).toContain(name);
      }

      for (const flag of ['--url', '--app', '--env', '--org', '--ontology', '--json', '--version', '--help']) {
        expect(result.stdout).toContain(flag);
      }
    }
  });

  it.each(allCommands)('prints subcommand help and exits 0 for %s with --help, -h, and help %s', async (name) => {
    for (const args of [
      [name, '--help'],
      [name, '-h'],
      ['help', name],
    ]) {
      const result = await cli(args);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Usage: ontos ${name}`);
      expect(result.stdout).toContain('--help');
    }
  });

  it('refuses help for an unknown command', async () => {
    const unknownHelp = await cli(['help', 'nope']);

    expect(unknownHelp.code).toBe(1);
    expect(unknownHelp.error).toMatchObject({ message: expect.stringContaining('Usage: ontos ') });

    const unknownFlagHelp = await cli(['nope', '--help']);

    expect(unknownFlagHelp.code).toBe(1);
    expect(unknownFlagHelp.error).toMatchObject({ message: expect.stringContaining('Usage: ontos ') });
  });

  it('runs --version, --help, and dev --help in an isolated folder without node_modules (no typescript, esbuild, or @ericbragas/ontos-service loaded)', () => {
    expect(isolatedVersion.status).toBe(0);
    expect(isolatedVersion.stderr).toBe('');
    expect(JSON.parse(isolatedVersion.stdout)).toEqual({ version: CLI_VERSION });

    expect(isolatedHelp.status).toBe(0);
    expect(isolatedHelp.stderr).toBe('');
    expect(isolatedHelp.stdout).toContain('Usage: ontos <command> [options]');

    expect(isolatedDevHelp.status).toBe(0);
    expect(isolatedDevHelp.stderr).toBe('');
    expect(isolatedDevHelp.stdout).toContain('Usage: ontos dev');
  });
});
