#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import ts from 'typescript';

const service = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(service, '../..');
const TEST_FILE = /\.(test|test-utils|fixture)\.ts$/;

const { dependencies } = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const WORKER_URL = "new URL('./worker.ts', import.meta.url)";

const workerJs: Plugin = {
  name: 'worker-js',
  setup(plugin) {
    plugin.onLoad({ filter: /src\/functions\/pool\.ts$/ }, ({ path }) => {
      const text = readFileSync(path, 'utf8');

      if (text.split(WORKER_URL).length !== 2) throw new Error(`${path} names its worker other than ${WORKER_URL}.`);

      return { contents: text.replace(WORKER_URL, "new URL('./worker.js', import.meta.url)"), loader: 'ts' };
    });
  },
};

function baseCompilerOptions(): ts.CompilerOptions {
  const { config } = ts.readConfigFile(join(service, '../../tsconfig.base.json'), (file) => ts.sys.readFile(file));

  return ts.parseJsonConfigFileContent(config, ts.sys, service).options;
}

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !TEST_FILE.test(entry))
    .map((entry) => join(folder, entry));
}

function emitServiceDeclarations(out: string): void {
  const srcRoot = join(service, 'src');
  const typesOut = join(out, 'types');

  const program = ts.createProgram(sourceFiles(srcRoot), {
    ...baseCompilerOptions(),
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: srcRoot,
    outDir: typesOut,
  });

  const { diagnostics } = program.emit();

  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      }),
    );
  }

  writeFileSync(join(out, 'index.d.ts'), "export * from './types/index.js';\n");

  writeFileSync(join(out, 'client-config.d.ts'), "export * from './types/handler/clientConfig.js';\n");

  writeFileSync(join(out, 'publish.d.ts'), "export * from './types/publish/index.js';\n");

  writeFileSync(join(out, 'convert.d.ts'), "export * from './types/publish/convert.js';\n");
}

function testingDeclarations(entry: string): string {
  const program = ts.createProgram([entry], {
    ...baseCompilerOptions(),
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  });

  let text: string | undefined;

  const { diagnostics } = program.emit(program.getSourceFile(entry), (file, data) => {
    if (file.endsWith('/index.d.ts')) text = data;
  });

  if (diagnostics.length > 0 || text === undefined) throw new Error(`tsc wrote no declarations of ${entry}.`);

  if (/^import /m.test(text)) throw new Error(`The declarations of ${entry} import another file.`);

  return text;
}

export async function buildTesting(out: string): Promise<void> {
  mkdirSync(out, { recursive: true });

  await build({
    entryPoints: { index: join(service, 'testing/index.ts'), worker: join(service, 'src/functions/worker.ts') },
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    external: Object.keys(dependencies),
    plugins: [workerJs],
    logLevel: 'error',
  });

  writeFileSync(join(out, 'index.d.ts'), testingDeclarations(join(service, 'testing/index.ts')));
}

export async function buildService(out: string): Promise<void> {
  rmSync(out, { recursive: true, force: true });

  mkdirSync(out, { recursive: true });

  const external = Object.keys(dependencies);

  await Promise.all([
    build({
      entryPoints: {
        index: join(service, 'src/index.ts'),
        'client-config': join(service, 'src/handler/clientConfig.ts'),
        publish: join(service, 'src/publish/index.ts'),
      },
      outdir: out,
      bundle: true,
      splitting: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      external,
      plugins: [workerJs],
      logLevel: 'error',
    }),
    build({
      entryPoints: { convert: join(service, 'src/publish/convert.ts') },
      outdir: out,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      external,
      logLevel: 'error',
    }),
    build({
      entryPoints: { node: join(service, 'src/node.ts') },
      outdir: out,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      external,
      plugins: [workerJs],
      logLevel: 'error',
    }),
    build({
      entryPoints: { worker: join(service, 'src/functions/worker.ts') },
      outdir: out,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      external,
      logLevel: 'error',
    }),
    buildTesting(join(out, 'testing')),
  ]);

  emitServiceDeclarations(out);

  for (const legal of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    copyFileSync(join(repoRoot, legal), join(dirname(out), legal));
  }
}

if (import.meta.main) {
  await buildService(join(service, 'dist'));
}
