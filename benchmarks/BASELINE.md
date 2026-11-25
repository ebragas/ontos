# Ontos V1.0 Benchmark Baseline

Recorded as the `v1.0.0` baseline (2026-11-24) using production builds (`bun run build`) executed under Node.js `v24.22.2` (matching `.nvmrc` and CI) via `fnm exec --using=24 node ./benchmarks/run.ts`.

## Environment

| Property                | Value                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| OS / Architecture       | `darwin 27.2.0 (arm64)`                                                                                                  |
| CPU                     | Apple M5 Max (18 cores)                                                                                                  |
| Memory                  | 128 GB                                                                                                                   |
| Load average at capture | `4.45, 4.39, 4.44` (18 cores)                                                                                            |
| Node.js                 | `v24.22.2` (matches `.nvmrc` `24` and CI)                                                                                |
| PostgreSQL              | `17.12` (`mirror.gcr.io/library/postgres:17-alpine`, default `fsync=on`, `synchronous_commit=on`, `max_connections=200`) |
| Service pool            | `max: 20`, loopback HTTP (`127.0.0.1`), `ONTOS_AUTH_MODE=dev`                                                            |

## Results

All benchmarks ran 5 measured rounds after warmup with 0 errors across every iteration.

| Benchmark                                          | Rounds x Iters | p50 (ms) | p95 (ms) | p99 (ms) | Round Median Range (ms) |  ops/s | Errors |
| -------------------------------------------------- | -------------: | -------: | -------: | -------: | ----------------------- | -----: | -----: |
| Cold start: `applyEngineChanges` fast-path         |         5 x 20 |     0.50 |     0.77 |     0.84 | 0.47 - 0.53             | 1861.3 |      0 |
| `loadObjects` (10 rows)                            |         5 x 40 |     1.95 |     3.27 |     5.34 | 1.71 - 2.33             |  467.9 |      0 |
| `loadObjects` (1,000 rows)                         |         5 x 15 |     6.74 |     8.47 |    11.05 | 6.38 - 6.95             |  144.3 |      0 |
| `loadObjects` (text search, 1,000 rows)            |         5 x 30 |     3.71 |     4.66 |     5.21 | 3.57 - 4.03             |  264.6 |      0 |
| `loadObjects` (object security policy, 1,000 rows) |         5 x 40 |     2.14 |     3.32 |     4.15 | 1.90 - 2.64             |  448.0 |      0 |
| `aggregate` (grouped count+sum, 1,000 rows)        |         5 x 30 |     1.33 |     2.23 |     2.92 | 1.26 - 1.46             |  667.7 |      0 |
| `apply` (1 edit, rule-backed)                      |         5 x 20 |     2.57 |     4.22 |     4.86 | 2.43 - 2.81             |  373.5 |      0 |
| `apply` (100 batched edits, Function-backed)       |          5 x 6 |     6.23 |    10.46 |    15.62 | 5.63 - 7.35             |  149.3 |      0 |
| `apply` (500 batched edits, Function-backed)       |          5 x 4 |    12.85 |    28.09 |    29.75 | 12.48 - 15.27           |  65.94 |      0 |
| Concurrent Function Actions (16 parallel waves)    |          5 x 4 |    24.06 |    25.99 |    27.52 | 21.95 - 25.05           |  42.18 |      0 |
| `ontos` CLI cold startup (`--version`)             |          5 x 5 |    46.20 |    53.55 |    53.79 | 44.99 - 51.89           |  21.21 |      0 |
| `ontos` CLI cold startup (`--help`)                |          5 x 5 |    45.58 |    47.19 |    48.09 | 45.48 - 46.18           |  21.87 |      0 |

Concurrent per-call latency across 320 calls (20 measured waves of 16 parallel calls): p50 `17.28 ms`, p95 `24.01 ms`, p99 `25.60 ms`, 0 errors, 0 worker-pool timeouts.

## Verification and Limiter Analysis

1. **Work verification:** Every `loadObjects` call asserted exact returned row counts (`10`, `1,000`, `100` text matches, and `50` rows all matching `ownerId === 'user_dev'`). Every `aggregate` call asserted 10 groups summing to 1,000. Database `SELECT count(*)` confirmed `+105` rows committed by single `apply`, `+3,200` rows by 100-edit batched `apply`, and `+10,500` rows by 500-edit batched `apply`. All 320 concurrent Function-backed Action calls returned HTTP 200 with 0 errors. Every CLI spawn exited 0 and returned valid version JSON or usage text.
2. **Cold start (`applyEngineChanges` fast-path):** 0.50 ms p50 (range 0.47 - 0.53 ms), bound by registry `SELECT` roundtrips over loopback TCP to Docker PostgreSQL.
3. **`loadObjects` vs `aggregate`:** `aggregate` (1.33 ms p50) runs a single `pg` query returning 10 compact JSON groups. `loadObjects (10 rows)` (1.95 ms p50) streams through `pg-query-stream` (`batchSize: 1_000`) and a batched chunked `ReadableStream` response body. `loadObjects (1,000 rows)` (6.74 ms p50, 144.3 ops/s, down from 15.06 ms before cursor and JSON chunk batching) fetches all 1,000 rows in one portal batch and serializes them in batched chunks; remaining time is bound by PostgreSQL row scan, `JSON.stringify`, and client JSON parsing.
4. **Text search cold table initialization:** Precomputed static tables in `packages/service/src/objectSets/compile/unicodeData.ts` decode in `0.68 ms` on Node.js `v24.22.2` (`0.71 ms` in a second fresh process), down from `106 ms` for the prior synchronous 1,114,111 code-point scan. Warm text search over 1,000 rows runs at 3.71 ms p50, bound by PostgreSQL regex evaluation over 1,000 rows.
5. **`apply` scaling:** Single-edit `apply` (2.57 ms p50) is bound by one PostgreSQL durable transaction (`fsync=on`) plus loopback HTTP roundtrip. Batched 500-edit `apply` (12.85 ms p50, roughly 26 microseconds per inserted row) amortizes the single transaction and worker IPC across 500 `unnest`/batch inserts.
6. **Concurrent Function-backed Actions (16 parallel):** Bound by the 2-worker Function pool (`MAX_WORKERS = 2`), executing 16 concurrent calls in 8 serial turns per worker at 24.06 ms/wave (~665 calls/s aggregate throughput, 17.28 ms per-call p50) with 0 queue starvation, aided by single-roundtrip snapshot startup and skipping `SELECT count(*)` on internal input loads.
7. **`ontos` CLI cold startup:** 46.20 ms p50 for `--version` and 45.58 ms p50 for `--help` on Node.js `v24.22.2` (under load average 4.45). A bare `node -e ""` boot on Node.js `v24.22.2` measures `24.09 ms` median (15 runs, range `22.48 - 25.77 ms`), so the lazy CLI entrypoint adds ~22 ms of ESM parse and execution overhead.
