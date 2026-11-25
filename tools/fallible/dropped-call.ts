#!/usr/bin/env node
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import ts from 'typescript';
import {
  attempt,
  settle,
  type AsyncFallible,
  type Fallible,
  type Result,
} from '../../packages/service/src/errors/fallible.ts';
import { checkProgram, type Hit, type Report } from './checker.ts';
import { DEFAULT_EXCLUDED, DEFAULT_SCOPE, resolveScopePaths, scopeOf, TEST_FILE } from './scope.ts';

const PROJECTS = ['tsconfig.json', 'packages/service/tsconfig.json', 'packages/cli/tsconfig.json'];

interface ProjectResult {
  readonly hits: readonly Hit[];
  readonly calls: readonly string[];
  readonly files: readonly string[];
}

const WORKER_KIND = 'dropped-call-worker';

interface WorkerInput {
  readonly kind: typeof WORKER_KIND;
  readonly root: string;
  readonly projects: readonly string[];
  readonly scope: readonly string[];
  readonly excluded: readonly string[];
}

function isWorkerInput(value: unknown): value is WorkerInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === WORKER_KIND &&
    'root' in value &&
    typeof value.root === 'string' &&
    'projects' in value &&
    Array.isArray(value.projects) &&
    'scope' in value &&
    Array.isArray(value.scope) &&
    'excluded' in value &&
    Array.isArray(value.excluded)
  );
}

type WorkerOutput =
  { readonly ok: true; readonly results: readonly ProjectResult[] } | { readonly ok: false; readonly message: string };

function* parseProject(root: string, project: string): Fallible<ts.ParsedCommandLine, Error> {
  const configPath = path.join(root, project);
  const errors: ts.Diagnostic[] = [];

  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (error) => errors.push(error) },
  );

  const problems = [...errors, ...(config?.errors ?? [])];

  if (!config || problems.length > 0)
    return yield new Error(
      `${configPath}: ${problems.map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; ') || 'not readable'}`,
    );

  return config;
}

function* checkProjects(
  root: string,
  projects: readonly string[],
  inScope: (file: string) => boolean,
  parsed?: ReadonlyMap<string, ts.ParsedCommandLine>,
): Fallible<ProjectResult[], Error> {
  const results: ProjectResult[] = [];

  for (const project of projects) {
    const config = parsed?.get(project) ?? (yield* parseProject(root, project));
    const program = ts.createProgram(config.fileNames, config.options);
    const own = new Set(config.fileNames.map((name) => path.resolve(name)));

    results.push(checkProgram(program, own, inScope));
  }

  return results;
}

function combineResults(root: string, scope: readonly string[], results: readonly ProjectResult[]): Report {
  const hits = new Map<string, Hit>();
  const files = new Set<string>();
  const calls = new Set<string>();

  for (const result of results) {
    for (const file of result.files) files.add(file);

    for (const call of result.calls) calls.add(call);

    for (const hit of result.hits)
      hits.set(`${hit.file}:${hit.line}:${hit.column}`, { ...hit, file: path.relative(root, hit.file) });
  }

  const sorted = [...hits.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );

  const nonTestFiles = [...files].filter((file) => !TEST_FILE.test(file));

  const unmatched = scope
    .filter((entry) =>
      entry.endsWith(path.sep)
        ? !nonTestFiles.some((file) => file.startsWith(entry))
        : TEST_FILE.test(entry) || !files.has(entry),
    )
    .map((entry) => path.relative(root, entry) + (entry.endsWith(path.sep) ? '/' : ''));

  return { hits: sorted, files: files.size, calls: calls.size, unmatched };
}

export function* droppedCalls(
  root: string,
  projects: readonly string[] = PROJECTS,
  scopeEntries: readonly string[] = DEFAULT_SCOPE,
): Fallible<Report, Error> {
  const scope = resolveScopePaths(root, scopeEntries);
  const excluded = DEFAULT_EXCLUDED.map((entry) => path.resolve(root, entry));
  const inScope = scopeOf(scope, excluded);
  const results = yield* checkProjects(root, projects, inScope);

  return combineResults(root, scope, results);
}

function packProjects(
  parsed: readonly { readonly project: string; readonly count: number }[],
  buckets: number,
): string[][] {
  const bins: { projects: string[]; load: number }[] = Array.from({ length: buckets }, () => ({
    projects: [],
    load: 0,
  }));

  for (const item of [...parsed].sort((a, b) => b.count - a.count)) {
    let best = bins[0];

    for (const bin of bins) if (best && bin.load < best.load) best = bin;

    if (best) {
      best.projects.push(item.project);

      best.load += item.count;
    }
  }

  return bins.map((bin) => bin.projects).filter((group) => group.length > 0);
}

function runWorker(input: WorkerInput): Promise<Result<readonly ProjectResult[], Error>> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: input });
    let done = false;

    const finish = (result: Result<readonly ProjectResult[], Error>): void => {
      if (done) return;

      done = true;

      resolve(result);
    };

    worker.on('message', (message: WorkerOutput) => {
      finish(message.ok ? { ok: true, value: message.results } : { ok: false, error: new Error(message.message) });
    });

    worker.on('error', (error) => {
      finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
    });

    worker.on('exit', (code) => {
      finish({ ok: false, error: new Error(`dropped-call worker exited with code ${code}`) });
    });
  });
}

export async function* droppedCallsParallel(
  root: string,
  projects: readonly string[] = PROJECTS,
  maxWorkers = Math.min(2, availableParallelism()),
  scopeEntries: readonly string[] = DEFAULT_SCOPE,
): AsyncFallible<Report, Error> {
  const workers = Math.max(1, Math.min(maxWorkers, projects.length));

  if (workers === 1) return yield* droppedCalls(root, projects, scopeEntries);

  const scope = resolveScopePaths(root, scopeEntries);
  const excluded = DEFAULT_EXCLUDED.map((entry) => path.resolve(root, entry));
  const inScope = scopeOf(scope, excluded);
  const parsedMap = new Map<string, ts.ParsedCommandLine>();
  const sizes: { project: string; count: number }[] = [];

  for (const project of projects) {
    const config = yield* parseProject(root, project);

    parsedMap.set(project, config);

    sizes.push({ project, count: config.fileNames.length });
  }

  const [localBucket, ...workerBuckets] = packProjects(sizes, workers);

  const workerPromises = workerBuckets.map((bucket) =>
    runWorker({ kind: WORKER_KIND, root, projects: bucket, scope, excluded }),
  );

  const localResults = yield* checkProjects(root, localBucket ?? [], inScope, parsedMap);

  const workerOutputs = yield* attempt(
    () => Promise.all(workerPromises),
    (error) => (error instanceof Error ? error : new Error(String(error))),
  );

  const allResults: ProjectResult[] = [...localResults];

  for (const output of workerOutputs) {
    if (!output.ok) return yield output.error;

    allResults.push(...output.value);
  }

  return combineResults(root, scope, allResults);
}

async function* main(args: string[]): AsyncFallible<number, Error> {
  let maxWorkers: number | undefined;
  const positional: string[] = [];
  const unknownFlags: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--workers=')) {
      const raw = arg.slice('--workers='.length);

      if (!/^[1-9]\d*$/.test(raw)) {
        console.error(`dropped-call: invalid worker count in ${arg}`);

        return 2;
      }

      maxWorkers = Number(raw);
    } else if (arg.startsWith('-')) {
      unknownFlags.push(arg);
    } else {
      positional.push(arg);
    }
  }

  if (unknownFlags.length > 0) {
    console.error(`dropped-call: unknown flag ${unknownFlags.join(' ')}`);

    return 2;
  }

  const root = path.resolve(positional[0] ?? '.');
  const report = yield* droppedCallsParallel(root, PROJECTS, maxWorkers);

  for (const hit of report.hits) console.log(`${hit.file}:${hit.line}:${hit.column} ${hit.message}`);

  const dropped = report.hits.filter((hit) => hit.kind === 'drop').length;

  console.log(
    `dropped-call: ${dropped} dropped of ${report.calls} fallible call(s), and ${report.hits.length - dropped} outside call(s), in ${report.files} files of ${PROJECTS.length} projects`,
  );

  for (const entry of report.unmatched) console.error(`dropped-call: the scope entry ${entry} matches no checked file`);

  if (report.unmatched.length > 0) return 2;

  if (report.calls === 0) {
    console.error('dropped-call: found no fallible call, so the type test may be wrong for this repo');

    return 2;
  }

  return report.hits.length > 0 ? 1 : 0;
}

if (!isMainThread && parentPort && isWorkerInput(workerData)) {
  const ran = settle(
    checkProjects(workerData.root, workerData.projects, scopeOf(workerData.scope, workerData.excluded)),
  );

  const output: WorkerOutput = ran.ok ? { ok: true, results: ran.value } : { ok: false, message: ran.error.message };

  parentPort.postMessage(output);
} else if (import.meta.main) {
  const ran = await settle(main(process.argv.slice(2)));

  if (!ran.ok) console.error(ran.error);

  process.exitCode = ran.ok ? ran.value : 1;
}
