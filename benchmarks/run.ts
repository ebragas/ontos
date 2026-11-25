#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startBenchEnv, type BenchEnv } from './setup.ts';

const execFileAsync = promisify(execFile);
const CLI_BIN = fileURLToPath(new URL('../packages/cli/dist/ontos.js', import.meta.url));
const ROUNDS = 5;

interface BenchResult {
  readonly name: string;
  readonly rounds: number;
  readonly iterationsPerRound: number;
  readonly totalOps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly roundMedianRangeMs: readonly [number, number];
  readonly opsPerSec: number;
  readonly errors: number;
  readonly verified: string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;

  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);

  return sorted[Math.max(0, index)] ?? 0;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

async function measure(
  name: string,
  options: { readonly warmup: number; readonly iterationsPerRound: number; readonly verified: string },
  fn: (iteration: number) => Promise<void>,
): Promise<BenchResult> {
  let seq = 0;

  for (let index = 0; index < options.warmup; index += 1) {
    seq += 1;

    await fn(seq);
  }

  const allSamples: number[] = [];
  const roundMedians: number[] = [];
  let errors = 0;
  let totalElapsedMs = 0;

  for (let round = 0; round < ROUNDS; round += 1) {
    const roundSamples: number[] = [];
    const roundStart = performance.now();

    for (let index = 0; index < options.iterationsPerRound; index += 1) {
      seq += 1;

      const t0 = performance.now();

      try {
        await fn(seq);
      } catch {
        errors += 1;
      }

      const elapsed = performance.now() - t0;

      roundSamples.push(elapsed);

      allSamples.push(elapsed);
    }

    totalElapsedMs += performance.now() - roundStart;

    roundMedians.push(median(roundSamples));
  }

  const sorted = [...allSamples].sort((a, b) => a - b);
  const sortedRounds = [...roundMedians].sort((a, b) => a - b);
  const totalOps = ROUNDS * options.iterationsPerRound;

  return {
    name,
    rounds: ROUNDS,
    iterationsPerRound: options.iterationsPerRound,
    totalOps,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    roundMedianRangeMs: [sortedRounds[0] ?? 0, sortedRounds.at(-1) ?? 0],
    opsPerSec: totalElapsedMs > 0 ? (totalOps / totalElapsedMs) * 1000 : 0,
    errors,
    verified: options.verified,
  };
}

async function postJson<T>(env: BenchEnv, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${env.baseUrl}/api/v2/ontologies/${env.ontologyRid}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) throw new Error(`HTTP ${response.status} on ${path}: ${await response.text()}`);

  return (await response.json()) as T;
}

async function runCli(flag: '--version' | '--help'): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_BIN, flag], {
    env: { PATH: process.env['PATH'] },
  });

  return stdout;
}

function fmt(value: number): string {
  return value >= 100 ? value.toFixed(1) : value.toFixed(2);
}

async function main(): Promise<void> {
  const env = await startBenchEnv();

  const results: BenchResult[] = [];

  try {
    results.push(
      await measure(
        'Cold start: applyEngineChanges fast-path',
        { warmup: 5, iterationsPerRound: 20, verified: '0 pending changes, 0 errors' },
        () => env.runEngineChangesFastPath(),
      ),
    );

    results.push(
      await measure(
        'loadObjects (10 rows)',
        { warmup: 5, iterationsPerRound: 40, verified: '10 rows returned per call' },
        async () => {
          const res = await postJson<{ data: unknown[] }>(env, '/objectSets/loadObjects', {
            objectSet: { type: 'base', objectType: env.itemType },
            pageSize: 10,
          });

          if (res.data.length !== 10) throw new Error(`Expected 10 rows, got ${res.data.length}`);
        },
      ),
    );

    results.push(
      await measure(
        'loadObjects (1,000 rows)',
        { warmup: 3, iterationsPerRound: 15, verified: '1,000 rows returned per call' },
        async () => {
          const res = await postJson<{ data: unknown[] }>(env, '/objectSets/loadObjects', {
            objectSet: { type: 'base', objectType: env.itemType },
            pageSize: 1000,
          });

          if (res.data.length !== 1000) throw new Error(`Expected 1000 rows, got ${res.data.length}`);
        },
      ),
    );

    results.push(
      await measure(
        'loadObjects (text search, 1,000 rows)',
        { warmup: 5, iterationsPerRound: 30, verified: '100 matching rows returned per call' },
        async () => {
          const res = await postJson<{ data: unknown[] }>(env, '/objectSets/loadObjects', {
            objectSet: {
              type: 'filter',
              objectSet: { type: 'base', objectType: env.itemType },
              where: { type: 'containsAnyTerm', field: 'title', value: 'Horizon' },
            },
            pageSize: 200,
          });

          if (res.data.length !== 100) throw new Error(`Expected 100 text matches, got ${res.data.length}`);
        },
      ),
    );

    results.push(
      await measure(
        'loadObjects (object security policy, 1,000 rows)',
        { warmup: 5, iterationsPerRound: 40, verified: '50 policy-filtered user_dev rows per call' },
        async () => {
          const res = await postJson<{ data: { ownerId: string }[] }>(env, '/objectSets/loadObjects', {
            objectSet: { type: 'base', objectType: env.securedItemType },
            pageSize: 50,
          });

          if (res.data.length !== 50 || res.data.some((row) => row.ownerId !== 'user_dev'))
            throw new Error(`Policy check failed: ${res.data.length} rows`);
        },
      ),
    );

    results.push(
      await measure(
        'aggregate (grouped count+sum, 1,000 rows)',
        { warmup: 5, iterationsPerRound: 30, verified: '10 groups summing to 1,000 rows' },
        async () => {
          const res = await postJson<{ data: { metrics: { name: string; value?: number }[] }[] }>(
            env,
            '/objectSets/aggregate',
            {
              objectSet: { type: 'base', objectType: env.itemType },
              groupBy: [{ type: 'exact', field: 'category' }],
              aggregation: [
                { type: 'count', name: 'count' },
                { type: 'sum', field: 'amount', name: 'total' },
              ],
            },
          );

          const total = res.data.reduce(
            (sum, group) => sum + Number(group.metrics.find((m) => m.name === 'count')?.value ?? 0),
            0,
          );

          if (res.data.length !== 10 || total !== 1000)
            throw new Error(`Expected 10 groups summing to 1000, got ${res.data.length}/${total}`);
        },
      ),
    );

    const beforeSingle = await env.countItems();

    results.push(
      await measure(
        'apply (1 edit, rule-backed)',
        { warmup: 5, iterationsPerRound: 20, verified: '105 rows committed to Postgres' },
        async (seq) => {
          await postJson(env, '/actions/com.ontos.bench.create-item/apply', {
            parameters: {
              itemId: `single-${seq}`,
              title: `Single item ${seq}`,
              category: 'cat-0',
              amount: 42,
              ownerId: 'user_dev',
            },
          });
        },
      ),
    );

    const afterSingle = await env.countItems();

    if (afterSingle - beforeSingle !== 105)
      throw new Error(`Expected +105 rows from single apply, saw +${afterSingle - beforeSingle}`);

    results.push(
      await measure(
        'apply (100 batched edits, Function-backed)',
        { warmup: 2, iterationsPerRound: 6, verified: '3,200 rows committed (32 x 100)' },
        async (seq) => {
          await postJson(env, '/actions/com.ontos.bench.create-batch/apply', {
            parameters: { prefix: `b100-${seq}`, count: 100 },
          });
        },
      ),
    );

    const afterBatch100 = await env.countItems();

    if (afterBatch100 - afterSingle !== 3_200)
      throw new Error(`Expected +3200 rows from 100-batch apply, saw +${afterBatch100 - afterSingle}`);

    results.push(
      await measure(
        'apply (500 batched edits, Function-backed)',
        { warmup: 1, iterationsPerRound: 4, verified: '10,500 rows committed (21 x 500)' },
        async (seq) => {
          await postJson(env, '/actions/com.ontos.bench.create-batch/apply', {
            parameters: { prefix: `b500-${seq}`, count: 500 },
          });
        },
      ),
    );

    const afterBatch500 = await env.countItems();

    if (afterBatch500 - afterBatch100 !== 10_500)
      throw new Error(`Expected +10500 rows from 500-batch apply, saw +${afterBatch500 - afterBatch100}`);

    const concurrentCallLatencies: number[] = [];
    let concurrentErrors = 0;

    results.push(
      await measure(
        'Concurrent Function Actions (16 parallel waves)',
        { warmup: 1, iterationsPerRound: 4, verified: '320/320 concurrent calls succeeded (0 starvation)' },
        async (wave) => {
          const calls = Array.from({ length: 16 }, async (_, slot) => {
            const t0 = performance.now();

            try {
              await postJson(env, '/actions/com.ontos.bench.update-item/apply', {
                parameters: {
                  itemId: `item-${String(slot).padStart(4, '0')}`,
                  amount: wave * 100 + slot,
                },
              });
            } catch {
              concurrentErrors += 1;

              throw new Error(`Concurrent call failed on wave ${wave} slot ${slot}`);
            }

            if (wave > 1) concurrentCallLatencies.push(performance.now() - t0);
          });

          await Promise.all(calls);
        },
      ),
    );

    results.push(
      await measure(
        'ontos CLI cold startup (--version)',
        { warmup: 2, iterationsPerRound: 5, verified: 'exit 0 + JSON version output on every spawn' },
        async () => {
          const out = await runCli('--version');

          const parsed = JSON.parse(out) as { version?: unknown };

          if (typeof parsed.version !== 'string') throw new Error(`Unexpected --version output: ${out}`);
        },
      ),
    );

    results.push(
      await measure(
        'ontos CLI cold startup (--help)',
        { warmup: 2, iterationsPerRound: 5, verified: 'exit 0 + usage output on every spawn' },
        async () => {
          const out = await runCli('--help');

          if (!out.includes('ontos')) throw new Error(`Unexpected --help output: ${out}`);
        },
      ),
    );

    const sortedConcurrent = [...concurrentCallLatencies].sort((a, b) => a - b);

    const machine = {
      os: `${platform()} ${release()} (${process.arch})`,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      ramGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      loadAvg: loadavg().map((n) => Number(n.toFixed(2))),
      node: process.version,
      postgres: env.postgresVersion,
    };

    console.log('\n## Environment');

    console.log(JSON.stringify(machine, null, 2));

    console.log('\n## Benchmark Results\n');

    console.log(
      '| Benchmark | Rounds x Iters | p50 (ms) | p95 (ms) | p99 (ms) | Round Median Range (ms) | ops/s | Errors |',
    );

    console.log('|---|---:|---:|---:|---:|---|---:|---:|');

    for (const r of results) {
      const range = `${fmt(r.roundMedianRangeMs[0])} - ${fmt(r.roundMedianRangeMs[1])}`;

      console.log(
        `| ${r.name} | ${r.rounds} x ${r.iterationsPerRound} | ${fmt(r.p50Ms)} | ${fmt(r.p95Ms)} | ${fmt(r.p99Ms)} | ${range} | ${fmt(r.opsPerSec)} | ${r.errors} |`,
      );
    }

    console.log(
      `\nConcurrent per-call latency (320 calls across 20 waves of 16): p50=${fmt(percentile(sortedConcurrent, 50))} ms, p95=${fmt(percentile(sortedConcurrent, 95))} ms, p99=${fmt(percentile(sortedConcurrent, 99))} ms, errors=${concurrentErrors}`,
    );

    console.log('\n## JSON');

    console.log(
      JSON.stringify(
        {
          machine,
          results,
          concurrentPerCall: {
            calls: sortedConcurrent.length,
            p50Ms: percentile(sortedConcurrent, 50),
            p95Ms: percentile(sortedConcurrent, 95),
            p99Ms: percentile(sortedConcurrent, 99),
            errors: concurrentErrors,
          },
        },
        null,
        2,
      ),
    );

    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0) + concurrentErrors;

    if (totalErrors > 0) process.exitCode = 1;
  } finally {
    await env.stop();
  }
}

await main();
