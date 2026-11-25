import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lintProbe } from './lintProbe.test-utils.ts';

const lintText = lintProbe();

const checked = 'packages/cli/src/branchHead.ts';
const excluded = 'packages/cli/src/targets.test.ts';

async function broken(file: string, code: string): Promise<string[]> {
  return (await lintText(file, code)).map((f) => f.rule).filter((rule) => rule.startsWith('fallible/'));
}

const PROBES: Record<string, string> = {
  'fallible/no-throw': "export function f(): void {\n  throw new Error('x');\n}\n",
  'fallible/no-catch':
    'export const f = (p: Promise<number>): Promise<number | undefined> => p.catch(() => undefined);\n',
  'fallible/return-yield':
    "export function* f(): Fallible<number> {\n  yield 'refused';\n  return 1;\n}\ntype Fallible<T> = Generator<string, T, never>;\n",
  'fallible/no-dropped-call':
    'function* g(): Fallible<number> {\n  return 1;\n}\nexport function f(): void {\n  g();\n}\ntype Fallible<T> = Generator<string, T, never>;\n',
  'fallible/no-yield-in-finally':
    "export function* f(): Generator<string, void, unknown> {\n  try {\n    return;\n  } finally {\n    yield 'cleanup';\n  }\n}\n",
  'fallible/no-bridge-import': "import type { Db } from '../../service/src/dbBridge/index.ts';\nexport type A = Db;\n",
};

const FORMS: [rule: string, form: string, code: string][] = [
  [
    'fallible/no-throw',
    'a Promise alias',
    "const P = Promise;\nexport const f = (): Promise<never> => P.reject(new Error('x'));\n",
  ],
  [
    'fallible/no-throw',
    'Promise.withResolvers',
    "export const f = (): void => Promise.withResolvers<number>().reject(new Error('x'));\n",
  ],
  ['fallible/no-throw', 'process.exit', 'export const f = (): never => process.exit(1);\n'],
  [
    'fallible/no-throw',
    'gen.throw',
    "export const f = (gen: Generator<number>): unknown => gen.throw(new Error('x'));\n",
  ],
  ['fallible/no-throw', 'a renamed orThrow', "import { orThrow as ot } from './fallible.ts';\nexport const f = ot;\n"],
  [
    'fallible/no-catch',
    'a computed catch',
    "export const f = (p: Promise<number>): Promise<number | undefined> => p['catch'](() => undefined);\n",
  ],
  [
    'fallible/no-catch',
    'an uncaughtException listener',
    "export const f = (): unknown => process.on('uncaughtException', () => undefined);\n",
  ],
  [
    'fallible/return-yield',
    'an explicit Generator with TNext never',
    "export function* f(): Generator<string, number, never> {\n  yield 'refused';\n  return 1;\n}\n",
  ],
  [
    'fallible/return-yield',
    'an alias whose name does not end in Fallible',
    'export type Step<T> = Generator<string, T, never>;\n',
  ],
  [
    'fallible/no-bridge-import',
    'a value import',
    "import { createDb } from '../dbBridge/index.ts';\nexport const f = createDb;\n",
  ],
  ['fallible/no-bridge-import', 'a re-export', "export { transact } from '../dbBridge/index.ts';\n"],
  [
    'fallible/no-bridge-import',
    'a dynamic import',
    "export const f = (): Promise<unknown> => import('../dbBridge/index.ts');\n",
  ],
  [
    'fallible/return-yield',
    'a renamed import of a fallible type',
    "import type { Fallible as Step } from './fallible.ts';\nexport type A = Step<number, string>;\n",
  ],
];

describe('the rules of yielded failures', () => {
  it.each(Object.entries(PROBES))(
    '%s refuses its probe in a production file, and skips test files',
    async (rule, code) => {
      expect(await broken(checked, code)).toEqual([rule]);

      expect(await broken(excluded, code)).toEqual([]);
    },
  );

  it.each(FORMS)('%s refuses %s', async (rule, _form, code) => {
    expect(await broken(checked, code)).toEqual([rule]);
  });

  it('allows the failure of a fallible function with return yield, and its call with yield*', async () => {
    const code =
      "function* g(): Fallible<number> {\n  return yield 'refused';\n}\nexport function* f(): Fallible<number> {\n  return yield* g();\n}\ntype Fallible<T> = Generator<string, T, never>;\n";

    expect(await broken(checked, code)).toEqual([]);
  });

  it('allows a throw and a catch only in the helper, the border of the convention', async () => {
    const code =
      "export function f(): void {\n  try {\n    throw new Error('x');\n  } catch (error) {\n    void error;\n  }\n}\n";

    expect(await broken('packages/service/src/errors/fallible.ts', code)).toEqual([]);

    expect(await broken(checked, code)).toEqual(['fallible/no-throw', 'fallible/no-catch']);
  });

  it('refuses any import in the helper outside its own fallible/ files, even a type import', async () => {
    const rules = async (code: string) =>
      (await lintText('packages/service/src/errors/fallible.ts', code)).map((f) => f.rule);

    expect(await rules("import type { ApiError } from './index.ts';\n\nexport type A = ApiError;\n")).toEqual([
      'no-restricted-imports',
    ]);

    expect(await rules("import { createHash } from 'node:crypto';\n\nexport const a = createHash;\n")).toEqual([
      'no-restricted-imports',
    ]);
  });
});

describe('the helper of yielded failures', () => {
  it('imports only its own fallible/ files and no external or service modules', () => {
    const barrel = readFileSync(new URL('./errors/fallible.ts', import.meta.url), 'utf8');
    const barrelImports = [...barrel.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');

    expect(barrelImports.length).toBeGreaterThan(0);
    expect(barrelImports.every((specifier) => specifier.startsWith('./fallible/'))).toBe(true);

    for (const file of ['types.ts', 'settle.ts', 'bridges.ts', 'combinators.ts']) {
      const source = readFileSync(new URL(`./errors/fallible/${file}`, import.meta.url), 'utf8');
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');

      expect(specifiers.every((specifier) => /^\.\/[^/]+\.ts$/.test(specifier))).toBe(true);
      expect(source.match(/\bimport\s*\(|\brequire\s*\(/g)).toBeNull();
    }
  });
});
