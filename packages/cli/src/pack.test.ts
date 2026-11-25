import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkedApp } from './apps.test-utils.ts';
import { cli, CLI_VERSION, once, ROOT } from './cli.test-utils.ts';
import { installCli, packCli, run } from './pack.test-utils.ts';

let packed: { files: string[]; folder: string };
let errorComparison: { library: unknown; command: ReturnType<typeof spawnSync> };

const packageRuns = once(async () => {
  const ontos = join(packed.folder, 'node_modules', '.bin', 'ontos');

  const version = await run(ontos, ['--version'], process.cwd());

  const npxVersion = await run('npx', ['--no', '--', 'ontos', '--version'], packed.folder);

  const root = linkedApp();

  const generated = await run(ontos, ['generate-osdk'], root);

  return {
    version,
    npxVersion,
    generated,
    index: readFileSync(join(root, 'ontology/osdk-output/ontology/index.ts'), 'utf8'),
  };
});

const strictCheck = once(async () => {
  const { folder } = packed;

  writeFileSync(
    join(folder, 'check.mts'),
    [
      "import { run, type Io, type TokenStore } from '@ericbragas/ontos-cli';",
      "let stdout = '';",
      'const io: Io = { cwd: process.cwd(), env: process.env, stdout: (text) => { stdout += text; }, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };',
      'const store: TokenStore | undefined = io.tokenStore;',
      "const code: number = await run(['--version'], io);",
      'const keys: Record<keyof Io, true> = { cwd: true, env: true, stdout: true, stderr: true, fetch: true, sleep: true, tokenStore: true, isTty: true };',
      '// @ts-expect-error registry is not a field of the public Io',
      "await run(['--version'], { registry: {} });",
      '// @ts-expect-error terminal is not a field of the public Io',
      "await run(['--version'], { terminal: {} });",
      '// @ts-expect-error self is not a field of the public Io',
      "await run(['--version'], { self: [] });",
      'export { code, keys, store, stdout };',
    ].join('\n'),
  );

  const tsconfig = {
    compilerOptions: {
      strict: true,
      target: 'es2024',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      noEmit: true,
      typeRoots: [join(ROOT, 'node_modules/@types')],
      types: ['node'],
    },
    files: ['check.mts'],
  };

  writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify(tsconfig));

  return run(process.execPath, [join(folder, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], folder).then(
    () => undefined,
    (error: unknown) => error,
  );
});

beforeAll(async () => {
  const { file, files } = await packCli();

  const folder = await installCli(file);

  packed = { files, folder };

  writeFileSync(
    join(folder, 'error.mjs'),
    [
      "import { run } from '@ericbragas/ontos-cli';",
      "let stderr = '';",
      "const code = await run(['nope'], { stderr: (text) => { stderr += text; } });",
      'console.log(JSON.stringify({ code, stderr }));',
    ].join('\n'),
  );

  const [libraryText] = await Promise.all([
    run(process.execPath, ['error.mjs'], folder),
    packageRuns().catch(() => undefined),
    strictCheck().catch(() => undefined),
  ]);

  const command = spawnSync(join(folder, 'node_modules', '.bin', 'ontos'), ['nope'], {
    cwd: folder,
    encoding: 'utf8',
  });

  errorComparison = { library: JSON.parse(libraryText) as unknown, command };
}, 300_000);

describe('the packed CLI', () => {
  it('service/cli#commands: ontos --version prints the CLI version', async () => {
    const result = await cli(['--version']);

    expect(result.code).toBe(0);
    expect(result.output).toEqual({ version: CLI_VERSION });
  });

  it('service/cli#commands, service/cli#package, service/code-layout#packages, service/code-layout#typescript: the npm pack file holds only the bundle and its declarations, its ontos command runs --version, and it runs generate-osdk with no service, on the exact typescript of its pin', async () => {
    const { files, folder } = packed;

    const { version, npxVersion, generated, index } = await packageRuns();

    expect(files).toEqual([
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
      'dist/ontos.d.ts',
      'dist/ontos.js',
      'package.json',
    ]);

    expect(JSON.parse(version)).toEqual({ version: CLI_VERSION });
    expect(JSON.parse(npxVersion)).toEqual({ version: CLI_VERSION });

    const json = (path: string): unknown => JSON.parse(readFileSync(join(folder, 'node_modules', path), 'utf8'));
    const { dependencies } = json('@ericbragas/ontos-cli/package.json') as { dependencies: { typescript: string } };

    expect(json('typescript/package.json')).toMatchObject({ name: 'typescript', version: dependencies.typescript });
    expect(JSON.parse(generated)).toEqual({ osdkOutput: 'ontology/osdk-output/ontology', passes: 2 });
    expect(index).toContain('closeAccountAction');
  });

  it('service/cli#library-entry: the installed package exports only run, which runs a command line with each io field optional', async () => {
    const { folder } = packed;

    writeFileSync(
      join(folder, 'entry.mjs'),
      [
        "import * as cli from '@ericbragas/ontos-cli';",
        "let stdout = '';",
        "const code = await cli.run(['--version'], { stdout: (text) => { stdout += text; } });",
        'console.log(JSON.stringify({ exports: Object.keys(cli), code, stdout }));',
        "const bare = await cli.run(['--version']);",
        'console.log(JSON.stringify({ bare, exitCode: process.exitCode ?? null }));',
      ].join('\n'),
    );

    const [first, second, third] = (await run(process.execPath, ['entry.mjs'], folder))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);

    expect(first).toEqual({ exports: ['run'], code: 0, stdout: `${JSON.stringify({ version: CLI_VERSION })}\n` });
    expect(second).toEqual({ version: CLI_VERSION });
    expect(third).toEqual({ bare: 0, exitCode: null });
  });

  it('service/cli#library-entry: run prints the same JSON error on stderr as the ontos command, and gives the same exit code', () => {
    const { library, command } = errorComparison;

    expect(library).toEqual({ code: command.status, stderr: command.stderr });
    expect(command.status).toBe(1);
  });

  it('service/cli#library-entry: the exports map has only the package root and package.json, so an import of dist/ontos.js fails', async () => {
    const { folder } = packed;

    const manifest = JSON.parse(
      readFileSync(join(folder, 'node_modules/@ericbragas/ontos-cli/package.json'), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.exports)).toEqual(['.', './package.json']);

    writeFileSync(
      join(folder, 'deep.mjs'),
      "await import('@ericbragas/ontos-cli/dist/ontos.js').then(() => console.log('imported'), (error) => console.log(error.code));",
    );

    expect((await run(process.execPath, ['deep.mjs'], folder)).trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('service/cli#library-entry: the package ships declarations, so a strict tsc of a file that imports run and Io passes', async () => {
    expect(await strictCheck()).toBeUndefined();
  });
});
