import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { settle } from '../../packages/service/src/errors/fallible.ts';
import { checkProgram, type Hit } from './checker.ts';
import { droppedCalls as droppedCallsFallible, droppedCallsParallel } from './dropped-call.ts';
import { isInScope, scopeOf } from './scope.ts';

function droppedCalls(...args: Parameters<typeof droppedCallsFallible>) {
  const result = settle(droppedCallsFallible(...args));

  if (!result.ok) throw result.error;

  return result.value;
}

const helper = fileURLToPath(new URL('../../packages/service/src/errors/fallible.ts', import.meta.url));

const LIB = `
import type { Fallible as Of, AsyncFallible as AsyncOf } from '${helper}';
export { all, attempt, caught, orThrow, settle } from '${helper}';
export type Fallible<T> = Of<T, string>;
export type AsyncFallible<T> = AsyncOf<T, string>;
export function* check(n: number): Fallible<number> { if (n < 0) return yield 'negative'; return n; }
export async function* load(n: number): AsyncFallible<number> { if (n < 0) return yield 'negative'; return n; }
export const sink = (value: unknown): void => { void value; };
export type Rows = AsyncGenerator<number, string | undefined, undefined>;
export async function* rows(n: number): Rows { if (n < 0) return 'negative'; yield n; return undefined; }
export async function* doubled(source: Rows): Rows { for (;;) { const step = await source.next(); if (step.done) return step.value; yield step.value * 2; } }
export async function* plain(n: number): AsyncGenerator<number, void, undefined> { yield n; }
export const identity = <T>(value: T): T => value;
`;

const IMPORTS =
  "import { all, attempt, caught, check, doubled, identity, load, orThrow, plain, rows, settle, sink, type AsyncFallible, type Fallible, type Rows } from './lib.ts';\n";

const DROPS: Record<string, [code: string, hits: number]> = {
  'imported-statement': ['export function f(): void { check(1); }', 1],
  'same-file-generator': [
    'function* local(): Fallible<number> { return 1; }\nexport function f(): void { local(); }',
    1,
  ],
  'through-variable': ['const ref = check;\nexport function f(): void { ref(1); }', 1],
  'through-property': ['const fake = { load: check };\nexport function f(): void { fake.load(1); }', 1],
  'forEach-callback': ['export function f(xs: number[]): void { xs.forEach((x) => check(x)); }', 1],
  'map-statement': ['export function f(xs: number[]): void { xs.map((x) => check(x)); }', 1],
  'into-unknown': ['export function f(): void { sink(check(1)); }', 1],
  'variable-into-unknown': ['export function f(): void { const v = check(1); sink(v); }', 1],
  'yield-without-star': ['export function* f(): Generator<unknown, void, unknown> { yield check(1); }', 1],
  'assigned-never-used': ['export function f(): void { const unused = check(1); }', 1],
  'ternary-statement': ['export function f(flag: boolean): void { flag ? check(1) : check(2); }', 2],
  'conditional-branch': ['export function f(flag: boolean): void { if (flag) check(1); }', 1],
  void: ['export function f(): void { void check(1); }', 1],
  'array-element': ['export function f(): void { const all = [check(1), check(2)]; sink(all); }', 2],
  template: ['export function f(): string { return `${String(check(1))}`; }', 1],
  'generic-identity': ['export function f(): void { identity(check(1)); }', 1],
  'forEach-by-reference': ['export function f(xs: number[]): void { xs.forEach(check); }', 1],
  'void-alias': ['const hide: (n: number) => void = check;\nexport function f(): void { hide(1); }', 1],
  'truthiness-only': ['export function f(): boolean { const notRun = check(1); return notRun !== undefined; }', 1],
  'awaited-generator': ['export async function f(): Promise<void> { await load(1); }', 1],
  'async-statement': ['export async function f(): Promise<void> { load(1); }', 1],
  'map-set': ["export function f(m: Map<string, unknown>): void { m.set('a', check(1)); }", 1],
  'return-into-unknown': ['export function f(): unknown { return check(1); }', 1],
  'for-of-element-dropped': [
    'export function f(xs: number[]): void { for (const run of xs.map((x) => check(x))) sink(run); }',
    1,
  ],
  'class-field': ['export class C { readonly run = check(1); }', 1],
  'promise-all-of-async-map': [
    'export async function f(xs: number[]): Promise<void> { await Promise.all(xs.map(async (x) => load(x))); }',
    2,
  ],
  'bare-async-map': ['export function f(xs: number[]): void { xs.map(async (x) => load(x)); }', 1],
  'promise-all-of-calls': [
    'export async function f(): Promise<unknown> { return Promise.all([load(1), load(2)]); }',
    2,
  ],
  'spread-into-dropped-array': ['export function f(xs: number[]): void { sink([...xs.map((x) => check(x))]); }', 1],
  'stream-statement': ['export function f(): void { rows(1); }', 1],
  'stream-never-read': ['export function f(): void { const read = rows(1); sink(read); }', 1],
  'stream-for-await': ['export async function f(): Promise<void> { for await (const row of rows(1)) sink(row); }', 1],
  'stream-variable-for-await': [
    'export async function f(): Promise<void> { const read = rows(1); for await (const row of read) sink(row); }',
    1,
  ],
  'stream-for-await-inside-caught': [
    'export function f(): Promise<unknown> { return caught(async () => { for await (const row of rows(1)) sink(row); }); }',
    1,
  ],
  'stream-parameter-for-await-inside-caught': [
    'export function f(read: Rows): Promise<unknown> { return caught(async () => { for await (const row of read) sink(row); }); }',
    1,
  ],
  'stream-yield-star-statement': [
    'export async function* f(): AsyncGenerator<number, void, undefined> { yield* rows(1); }',
    1,
  ],
  'stream-yield-star-never-read': [
    'export async function* f(): Rows { const failure = yield* rows(1); sink(1); return undefined; }',
    1,
  ],
  'stream-parameter-yield-star-statement': [
    'export async function* f(read: Rows): AsyncGenerator<number, void, undefined> { yield* read; }',
    1,
  ],
  'stream-void-yield-star': [
    'export async function* f(): AsyncGenerator<number, void, undefined> { void (yield* rows(1)); }',
    1,
  ],
  'promise-all-of-map': [
    'export async function f(xs: number[]): Promise<unknown> { return Promise.all(xs.map((x) => load(x))); }',
    2,
  ],
  'logical-and-assign-void': [
    'export function f(): void { let hide: (n: number) => void = () => {}; hide &&= check; hide(1); }',
    1,
  ],
  'logical-or-assign-void': [
    'export function f(): void { let hide: (n: number) => void = () => {}; hide ||= check; hide(1); }',
    1,
  ],
  'nullish-assign-void': [
    'export function f(): void { let hide: (n: number) => void = () => {}; hide ??= check; hide(1); }',
    1,
  ],
  'tagged-template-void': [
    'function tag(_strings: TemplateStringsArray, fn: (n: number) => void): void { fn(1); }\nexport function f(): void { tag`${check}`; }',
    1,
  ],
};

const USES: Record<string, string> = {
  'yield-star': 'export function* f(): Fallible<number> { return yield* check(1); }',
  'variable-then-yield-star': 'export function* f(): Fallible<number> { const run = check(1); return yield* run; }',
  'async-yield-star': 'export async function* f(): AsyncFallible<number> { return yield* load(1); }',
  'ternary-into-yield-star':
    'export function* f(flag: boolean): Fallible<number> { return yield* (flag ? check(1) : check(2)); }',
  settle: 'export function f(): unknown { return settle(check(1)); }',
  orThrow: 'export function f(): number { return orThrow(check(1)); }',
  'async-orThrow': 'export async function f(): Promise<number> { return await orThrow(load(1)); }',
  'concise-return': 'export const f = (): Fallible<number> => check(1);',
  'inferred-return': 'export function f() { return check(1); }',
  'manual-next': 'export function f(): void { check(1).next(); }',
  'typed-parameter':
    'function runs(run: Fallible<number>): number { return orThrow(run); }\nexport function f(): number { return runs(check(1)); }',
  'typed-map-then-yield-star':
    "export function* f(): Fallible<number> { const m = new Map<string, Fallible<number>>(); m.set('a', check(1)); const run = m.get('a'); return run ? yield* run : 0; }",
  'typed-class-field':
    'export class C { readonly run: Fallible<number> = check(1); *go(): Fallible<number> { return yield* this.run; } }',
  'yield-star-through-identity': 'export function* f(): Fallible<number> { return yield* identity(check(1)); }',
  'map-by-reference':
    'export function* f(xs: number[]): Fallible<number[]> { const runs = xs.map(check); const out: number[] = []; for (const run of runs) out.push(yield* run); return out; }',
  'map-into-yield-star':
    'export function* f(xs: number[]): Fallible<void> { for (const run of xs.map((x) => check(x))) yield* run; }',
  'for-of-array-literal':
    'export async function* f(): AsyncFallible<void> { for (const run of [load(1), load(2)]) yield* run; }',
  'all-of-calls': 'export async function* f(): AsyncFallible<number[]> { return yield* all([load(1), load(2)]); }',
  'all-of-map':
    'export async function* f(xs: number[]): AsyncFallible<number[]> { return yield* all(xs.map((x) => load(x))); }',
  'all-of-spread':
    'export async function* f(xs: number[]): AsyncFallible<number[]> { return yield* all([...xs.map((x) => load(x)), load(0)]); }',
  'all-of-variable':
    'export async function* f(): AsyncFallible<number[]> { const runs = [load(1), load(2)]; return yield* all(runs); }',
  'stream-into-typed-parameter': 'export function f(): Rows { return doubled(rows(1)); }',
  'stream-yield-star': 'export async function* f(): Rows { return yield* rows(1); }',
  'stream-yield-star-kept':
    'export async function* f(): Rows { const failure = yield* rows(1); if (failure !== undefined) sink(failure); return failure; }',
  'stream-parameter-yield-star-kept': 'export async function* f(read: Rows): Rows { return yield* read; }',
  'stream-with-no-returned-value':
    'export function f(): Promise<unknown> { return caught(async () => { for await (const n of plain(1)) sink(n); }); }',
  'await-of-helper-call':
    "export async function f(): Promise<unknown> { const settled = await settle(load(1)); return [settled, await caught(() => fetch('https://example.com'))]; }",
};

const OUTSIDE: Record<string, [code: string, hits: number]> = {
  'bare-await-fetch': ["export async function f(): Promise<void> { await fetch('https://example.com'); }", 1],
  'await-inside-attempt': [
    "export async function* f(): AsyncFallible<Response> { return yield* attempt(async () => await fetch('https://example.com'), String); }",
    0,
  ],
  'await-inside-caught': [
    "export function f(): Promise<unknown> { return caught(async () => await fetch('https://example.com')); }",
    0,
  ],
  'await-of-fallible': ['export async function f(): Promise<void> { await load(1); }', 0],
  'for-await-stream': [
    'export async function f(lines: AsyncIterable<string>): Promise<void> { for await (const line of lines) sink(line); }',
    1,
  ],
  'for-await-inside-attempt': [
    'export async function* f(lines: AsyncIterable<string>): AsyncFallible<void> { yield* attempt(async () => { for await (const line of lines) sink(line); }, String); }',
    0,
  ],
  'nested-callback': [
    'export function f(urls: string[]): void { urls.forEach(async (url) => { await fetch(url); }); }',
    1,
  ],
  'nested-callback-inside-attempt': [
    'export async function* f(urls: string[]): AsyncFallible<Response[]> { return yield* attempt(() => Promise.all(urls.map(async (url) => await fetch(url))), String); }',
    0,
  ],
  'await-not-a-promise': ['export async function f(): Promise<number> { return await 1; }', 0],
};

let hits: Hit[];
let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'dropped-call-'));

  const converted = join(folder, 'converted');
  const other = join(folder, 'other');

  mkdirSync(converted);

  mkdirSync(other);

  const lib = join(converted, 'lib.ts');
  const files = [lib];

  writeFileSync(lib, LIB);

  for (const [name, code] of [
    ...[...Object.entries(DROPS), ...Object.entries(OUTSIDE)].map(([name, [code]]) => [name, code] as const),
    ...Object.entries(USES),
  ]) {
    const file = join(converted, `${name}.ts`);

    writeFileSync(file, IMPORTS + code + '\n');

    files.push(file);
  }

  writeFileSync(
    join(other, 'local-drop.ts'),
    "import type { Fallible } from '../converted/lib.ts';\nfunction* local(): Fallible<number> { return 1; }\nexport function f(): void { local(); }\n",
  );

  writeFileSync(
    join(other, 'converted-callee-drop.ts'),
    "import { check } from '../converted/lib.ts';\nexport function f(): void { check(1); }\n",
  );

  writeFileSync(
    join(other, 'outside-await.ts'),
    "export async function f(): Promise<void> { await fetch('https://example.com'); }\n",
  );

  writeFileSync(
    join(other, 'converted-stream-variable.ts'),
    "import { rows, sink } from '../converted/lib.ts';\nexport async function f(): Promise<void> { const read = rows(1); for await (const row of read) sink(row); }\n",
  );

  writeFileSync(
    join(other, 'converted-stream-call.ts'),
    "import { rows, sink } from '../converted/lib.ts';\nexport async function f(): Promise<void> { for await (const row of (rows(1))) sink(row); }\n",
  );

  files.push(
    join(other, 'local-drop.ts'),
    join(other, 'converted-callee-drop.ts'),
    join(other, 'outside-await.ts'),
    join(other, 'converted-stream-variable.ts'),
    join(other, 'converted-stream-call.ts'),
  );

  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    types: ['node'],
    typeRoots: [fileURLToPath(new URL('../../node_modules/@types', import.meta.url))],
  });

  const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));

  expect(errors).toEqual([]);

  hits = checkProgram(program, new Set(files), (file) => file.startsWith(converted)).hits;
});

const hitsIn = (name: string, dir = 'converted', kind?: Hit['kind']): Hit[] =>
  hits.filter((hit) => hit.file === join(folder, dir, `${name}.ts`) && (kind === undefined || hit.kind === kind));

describe('the dropped-call check', () => {
  it.each(Object.entries(DROPS))('catches the drop form %s', (name, [, count]) => {
    expect(hitsIn(name, 'converted', 'drop')).toHaveLength(count);
  });

  it.each(Object.entries(OUTSIDE))('reports the outside calls of the await form %s', (name, [, count]) => {
    expect(hitsIn(name, 'converted', 'outside')).toHaveLength(count);
  });

  it.each(Object.keys(USES))('leaves the correct use %s alone', (name) => {
    expect(hitsIn(name)).toEqual([]);
  });

  it('checks a file that is not converted only for a call of a converted callee', () => {
    expect(hitsIn('local-drop', 'other')).toEqual([]);
    expect(hitsIn('outside-await', 'other')).toEqual([]);

    expect(hitsIn('converted-callee-drop', 'other').map((hit) => hit.message)).toEqual([
      'the fallible call check(...) is dropped as a statement. Run it with `yield*`.',
    ]);

    expect(hitsIn('converted-stream-variable', 'other')).toHaveLength(1);
    expect(hitsIn('converted-stream-call', 'other')).toHaveLength(1);
  });
});

describe('the D1 marker of the dropped-call check', () => {
  it('skips an outside call that has the marker directly above its statement', () => {
    const root = mkdtempSync(join(tmpdir(), 'dropped-call-d1-'));

    mkdirSync(join(root, 'src/conv'), { recursive: true });

    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    );

    const marker = '// D1: the border of an entry.\n';
    const call = 'await Promise.resolve(1);\nexport {};\n';

    writeFileSync(join(root, 'src/conv/marked.ts'), marker + call);

    writeFileSync(join(root, 'src/conv/gap.ts'), `${marker}\n${call}`);

    writeFileSync(join(root, 'src/conv/plain.ts'), call);

    const report = droppedCalls(root, ['tsconfig.json'], ['src/conv/']);

    expect(report.hits.map((hit) => hit.file).sort()).toEqual(['src/conv/gap.ts', 'src/conv/plain.ts']);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('the scope of the dropped-call check', () => {
  it('checks each file of a folder entry, and names an entry that matches no checked file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dropped-call-root-'));

    const drop =
      'type Fallible<T> = Generator<string, T, never>;\nfunction* g(): Fallible<number> { return 1; }\nexport function f(): void { g(); }\n';

    for (const dir of ['src/conv/deep', 'src/other']) mkdirSync(join(root, dir), { recursive: true });

    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    );

    for (const file of ['src/conv/deep/a.ts', 'src/other/b.ts']) writeFileSync(join(root, file), drop);

    const report = droppedCalls(root, ['tsconfig.json'], ['src/conv/', 'src/missing.ts']);

    expect(report.hits.map((hit) => hit.file)).toEqual(['src/conv/deep/a.ts']);
    expect(report.unmatched).toEqual(['src/missing.ts']);

    rmSync(root, { recursive: true, force: true });
  });
});

describe('scopeOf', () => {
  it('matches exact files and folders while excluding sibling prefixes, excluded files, and test files, matching isInScope', () => {
    const base = join(tmpdir(), 'dropped-call-scope');
    const scope = [join(base, 'src/exact.ts'), join(base, 'src/conv') + sep];
    const excluded = [join(base, 'src/conv/worker.ts')];
    const inScope = scopeOf(scope, excluded);

    const cases: [string, boolean][] = [
      [join(base, 'src/exact.ts'), true],
      [join(base, 'src/conv/a.ts'), true],
      [join(base, 'src/conv/deep/b.ts'), true],
      [join(base, 'src/conv/worker.ts'), false],
      [join(base, 'src/conv-other/a.ts'), false],
      [join(base, 'src/other.ts'), false],
      [join(base, 'src/conv/a.test.ts'), false],
      [join(base, 'src/conv/a.test-utils.ts'), false],
      [join(base, 'src/conv/a.fixture.ts'), false],
      [join(base, 'src/exact.test.ts'), false],
    ];

    for (const [file, expected] of cases) {
      expect(inScope(file)).toBe(expected);
      expect(inScope(file)).toBe(isInScope(scope, file, excluded));
    }

    for (const [file, expected] of cases) expect(inScope(file)).toBe(expected);
  });
});

describe('droppedCallsParallel', () => {
  it('matches synchronous droppedCalls across multiple projects at 1, 2, and 3 workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dropped-call-parallel-'));

    try {
      const tsconfig = JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
        },
        include: ['src/**/*.ts'],
      });

      const drop =
        'type Fallible<T> = Generator<string, T, never>;\nfunction* g(): Fallible<number> { return 1; }\nexport function f(): void { g(); }\n';

      const ok =
        'type Fallible<T> = Generator<string, T, never>;\nfunction* g(): Fallible<number> { return 1; }\nexport function* f(): Fallible<number> { return yield* g(); }\n';

      for (const dir of ['a/src', 'b/src', 'c/src']) mkdirSync(join(root, dir), { recursive: true });

      for (const dir of ['a', 'b', 'c']) writeFileSync(join(root, dir, 'tsconfig.json'), tsconfig);

      writeFileSync(join(root, 'a/src/drop.ts'), drop);

      writeFileSync(join(root, 'a/src/d1.ts'), '// D1: entry border.\nawait Promise.resolve(1);\nexport {};\n');

      writeFileSync(join(root, 'b/src/drop.ts'), drop);

      writeFileSync(
        join(root, 'b/src/outside.ts'),
        'export async function f(): Promise<void> { await Promise.resolve(1); }\n',
      );

      writeFileSync(join(root, 'c/src/ok.ts'), ok);

      const projects = ['a/tsconfig.json', 'b/tsconfig.json', 'c/tsconfig.json'];
      const scope = ['a/src/', 'b/src/drop.ts', 'c/src/', 'a/src/missing.ts'];
      const syncReport = droppedCalls(root, projects, scope);

      const results = await Promise.all(
        [1, 2, 3].map((workers) => settle(droppedCallsParallel(root, projects, workers, scope))),
      );

      for (const result of results) {
        expect(result.ok).toBe(true);

        if (!result.ok) throw result.error;

        expect(result.value).toEqual(syncReport);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('yields an Error when a project tsconfig is missing in parallel mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dropped-call-parallel-err-'));

    try {
      const result = await settle(droppedCallsParallel(root, ['a/tsconfig.json', 'missing/tsconfig.json'], 2));

      expect(result.ok).toBe(false);

      if (result.ok) throw new Error('Expected droppedCallsParallel to fail.');

      expect(result.error.message).toContain('tsconfig.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the dropped-call CLI flags', () => {
  interface CliRun {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  const script = fileURLToPath(new URL('./dropped-call.ts', import.meta.url));
  const invalidFlags = ['--workers=0', '--workers=-1', '--workers=abc', '--workers=2.5', '--workers='] as const;

  const runCli = (args: readonly string[]): Promise<CliRun> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args]);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));

      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));

      child.on('error', reject);

      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  let invalidRuns: Map<string, CliRun>;
  let unknownRun: CliRun;
  let workerRuns: { one: CliRun; two: CliRun };

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'dropped-call-cli-'));

    try {
      const ok =
        'type Fallible<T> = Generator<string, T, never>;\nfunction* g(): Fallible<number> { return 1; }\nexport function* f(): Fallible<number> { return yield* g(); }\n';

      const drop =
        'type Fallible<T> = Generator<string, T, never>;\nfunction* g(): Fallible<number> { return 1; }\nexport function f(): void { g(); }\n';

      const dirs = [
        'tools/fallible',
        'tools/packaging',
        'tools/ops',
        'tools/docs',
        'packages/service/src',
        'packages/service/api',
        'packages/service/testing',
        'packages/cli/src',
      ];

      for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });

      const baseOptions = {
        strict: true,
        noEmit: true,
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
      };

      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: baseOptions, include: ['tools/**/*.ts'] }),
      );

      writeFileSync(
        join(root, 'packages/service/tsconfig.json'),
        JSON.stringify({ compilerOptions: baseOptions, include: ['src/**/*.ts', 'api/**/*.ts', 'testing/**/*.ts'] }),
      );

      writeFileSync(
        join(root, 'packages/cli/tsconfig.json'),
        JSON.stringify({ compilerOptions: baseOptions, include: ['src/**/*.ts'] }),
      );

      writeFileSync(join(root, 'tools/fallible/a.ts'), ok);

      writeFileSync(join(root, 'tools/packaging/a.ts'), ok);

      writeFileSync(join(root, 'tools/ops/a.ts'), ok);

      writeFileSync(join(root, 'tools/docs/a.ts'), ok);

      writeFileSync(join(root, 'packages/service/src/a.ts'), drop);

      writeFileSync(join(root, 'packages/service/api/index.ts'), ok);

      writeFileSync(join(root, 'packages/service/testing/index.ts'), ok);

      writeFileSync(join(root, 'packages/cli/src/a.ts'), ok);

      const [invalidEntries, bogus, one, two] = await Promise.all([
        Promise.all(invalidFlags.map(async (flag) => [flag, await runCli([flag])] as const)),
        runCli(['--bogus']),
        runCli(['--workers=1', root]),
        runCli(['--workers=2', root]),
      ]);

      invalidRuns = new Map(invalidEntries);

      unknownRun = bogus;

      workerRuns = { one, two };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(invalidFlags)('refuses invalid worker flag %s with exit 2', (flag) => {
    const run = invalidRuns.get(flag);

    if (!run) throw new Error(`Missing run for ${flag}`);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`dropped-call: invalid worker count in ${flag}`);
  });

  it('refuses an unknown flag with exit 2', () => {
    expect(unknownRun.status).toBe(2);
    expect(unknownRun.stderr).toContain('dropped-call: unknown flag --bogus');
  });

  it('accepts --workers=1 and --workers=2 on a 3-project root with identical output', () => {
    const { one, two } = workerRuns;

    expect(one.status).toBe(1);
    expect(two.status).toBe(1);
    expect(two.stdout).toBe(one.stdout);
    expect(two.stdout).toContain('packages/service/src/a.ts:3:29');
  });
});
