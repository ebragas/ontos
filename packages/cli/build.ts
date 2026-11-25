#!/usr/bin/env node
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ENTRY = fileURLToPath(new URL('src/index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const externalServiceRoot: Plugin = {
  name: 'external-service-root',
  setup(plugin) {
    plugin.onResolve({ filter: /^@ericbragas\/ontos-service$/ }, () => ({
      path: '@ericbragas/ontos-service',
      external: true,
    }));
  },
};

export const BUILD_OPTIONS: BuildOptions = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['typescript', 'esbuild'],
  plugins: [externalServiceRoot],
  legalComments: 'eof',
  banner: {
    js: "import { createRequire as __ontosCreateRequire } from 'node:module'; const require = __ontosCreateRequire(import.meta.url);",
  },
  logLevel: 'error',
};

export async function buildTo(outfile: string): Promise<void> {
  const { outputFiles } = await build({ ...BUILD_OPTIONS, outfile, write: false });

  const [bundle] = outputFiles;

  if (!bundle || outputFiles.length !== 1) throw new Error(`esbuild wrote ${outputFiles.length} files, not 1.`);

  if (!outfile.endsWith('.js'))
    throw new Error(`The bundle file ${outfile} does not end in .js, so its declarations have no file name.`);

  mkdirSync(dirname(outfile), { recursive: true });

  replace(outfile, bundle.contents, 0o755);

  replace(`${outfile.slice(0, -'.js'.length)}.d.ts`, declarations(), 0o644);

  if (basename(dirname(outfile)) === 'dist') {
    const pkgDir = dirname(dirname(outfile));

    for (const legal of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
      copyFileSync(join(REPO_ROOT, legal), join(pkgDir, legal));
    }
  }
}

function replace(file: string, contents: string | Uint8Array, mode: number): void {
  const temporary = `${file}.${process.pid}.tmp`;

  writeFileSync(temporary, contents);

  chmodSync(temporary, mode);

  renameSync(temporary, file);
}

export function declarations(): string {
  const { config } = ts.readConfigFile(fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)), (file) =>
    ts.sys.readFile(file),
  );

  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, dirname(ENTRY));

  const program = ts.createProgram([ENTRY], {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
  });

  let text: string | undefined;

  const { diagnostics } = program.emit(program.getSourceFile(ENTRY), (file, data) => {
    if (file.endsWith('/index.d.ts')) text = data;
  });

  const errors = [...ts.getPreEmitDiagnostics(program), ...diagnostics];

  if (errors.length > 0)
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      }),
    );

  if (text === undefined) throw new Error('tsc wrote no declarations of src/index.ts.');

  text = text.replace(/^#!.*\n/, '');

  if (/^\s*(import|export .* from)\b|\bimport\(/m.test(text))
    throw new Error(`The declarations of src/index.ts import another file:\n${text}`);

  return text;
}

if (import.meta.main) {
  await buildTo(fileURLToPath(new URL('dist/ontos.js', import.meta.url)));
}
