import type { Plugin } from 'esbuild';
import { join } from 'node:path';
import { CliError } from '../cliError.ts';
import { attempt, invariant, type AsyncFallible } from '../fallible.ts';
import type { CliDiscoveredFunction } from './discover.ts';

const dropFs: Plugin = {
  name: 'drop-fs',
  setup(b) {
    b.onResolve({ filter: /^fs$/ }, () => ({ path: 'fs', external: true, sideEffects: false }));
  },
};

export async function* bundleFunctions(
  projectFolder: string,
  discovered: readonly CliDiscoveredFunction[],
): AsyncFallible<string, CliError> {
  const entries = discovered.map((fn, index) => {
    const { functionName, filePath } = fn.locator.typescript;

    return { name: functionName, local: `f${index}`, path: join(projectFolder, filePath) };
  });

  const contents = [
    `export { createClient } from '@osdk/client';`,
    ...entries.map(({ local, path }) => `import ${local} from ${JSON.stringify(path)};`),
    `export const functions = { ${entries.map(({ name, local }) => `${JSON.stringify(name)}: ${local}`).join(', ')} };`,
  ].join('\n');

  const { build } = yield* attempt(
    () => import('esbuild'),
    (error) => new CliError(`Failed to load esbuild: ${(error as Error).message}`),
  );

  const result = yield* attempt(
    () =>
      build({
        stdin: { contents, resolveDir: projectFolder, sourcefile: 'functions.ts', loader: 'ts' },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2024',
        plugins: [dropFs],
        metafile: true,
        write: false,
        logLevel: 'silent',
      }),
    (error) => new CliError(`The Function bundle failed: ${(error as Error).message}`),
  );

  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));

  if (imports.length > 0)
    return yield new CliError(
      `The Function bundle imports ${imports.join(', ')}. A Function bundle holds each package that it uses, and no native module.`,
    );

  const [output] = result.outputFiles;

  invariant(output, 'esbuild wrote no Function bundle.');

  return output.text;
}
