# Ontos Benchmarks

This directory holds a reproducible end-to-end benchmark harness for `@ericbragas/ontos-service` and `@ericbragas/ontos-cli` against PostgreSQL 17 in Docker.

## Prerequisites

- Docker running locally (pulls `mirror.gcr.io/library/postgres:17-alpine`)
- Node.js 24 or newer (recorded baseline uses Node.js 26.13.1)
- Production builds present (`bun run build`)

## Run

Build both packages and run the executable entrypoint from the repository root:

```sh
bun run build
./benchmarks/run.ts
```

You can also run it with `bun benchmarks/run.ts`. The script starts a fresh PostgreSQL 17 container with default durability (`fsync=on`, `synchronous_commit=on`), starts the built `@ericbragas/ontos-service` HTTP server on `127.0.0.1` in `dev` auth mode, publishes and installs a benchmark Ontology, seeds 1,000 `Item` rows and 1,000 `SecuredItem` rows, runs `ANALYZE`, executes every benchmark with warmup and 5 measured rounds, and removes the container on exit.

## Workloads

1. **Cold start (`applyEngineChanges` fast-path):** Calls `applyEngineChanges(directDb)` against an already-migrated database with one installed Ontology at the newest engine-change count.
2. **`loadObjects` (10 rows, 1,000 rows, text search, object security policy):** Sends real HTTP `POST /objectSets/loadObjects` requests against the 1,000-row dataset and validates returned row counts and policy ownership on every response.
3. **`aggregate`:** Sends `POST /objectSets/aggregate` grouping 1,000 `Item` objects into 10 categories with `count` and `sum(amount)`, verifying all 10 groups sum to 1,000.
4. **`apply` (1 edit, 100 batched edits, 500 batched edits):** Runs rule-backed single-object creation (`create-item`) and Function-backed batched creation (`create-batch`) and verifies the exact row count committed in PostgreSQL after each stage.
5. **Concurrent Function-backed Actions (16 parallel calls):** Sends 20 measured waves of 16 parallel `update-item` requests. Each call runs inside the `worker_threads` Function pool, performs a `handleTrusted` object read, and commits an `updateObject` edit on a distinct row.
6. **`ontos` CLI cold startup (`--version`, `--help`):** Spawns fresh Node.js processes against `packages/cli/dist/ontos.js` and validates exit code 0 and output format on every spawn.

## Methodology

- Every workload runs warmup iterations before measurement so V8 JIT, connection pools, PostgreSQL buffers, and Function workers are warm (CLI startup spawns a fresh process per iteration).
- Each workload runs 5 measured rounds and reports p50, p95, p99 across all measured iterations, the min-to-max range of per-round medians, throughput (`ops/s`), and error count.
- Every iteration verifies HTTP status 200 (or exit code 0) and validates response contents or committed database row counts so failed or skipped work cannot produce numbers.
- Recorded baseline numbers live in [BASELINE.md](./BASELINE.md).
