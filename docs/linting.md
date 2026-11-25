# Linting and static checks

This repository uses deterministic static checks to keep both humans and coding agents honest and fast. A rule that runs in milliseconds catches bad structure, fake tests, hidden throws, and dead exports before code review starts.

Every check runs with zero allowlist debt. If a rule fails, fix the code instead of adding a file allowlist or weakening the rule.

## Run the checks

Run the full local gate before you open a pull request:

```sh
bun run check
```

`bun run check` runs six commands in order and stops on the first failure:

1. `bun run format:check` checks formatting with `bun fmt --check`.
2. `bun run lint` runs `oxlint --type-aware --report-unused-disable-directives-severity=error`.
3. `bun run typecheck` runs `bun check --no-script` across the root, `packages/service`, and `packages/cli` TypeScript projects.
4. `bun run lint:dropped` runs `./tools/fallible/dropped-call.ts` to verify that every fallible generator call runs and every outside `await` sits inside `attempt` or `caught`.
5. `bun run knip` fails on any unused file, export, type, or dependency.
6. `bun run test:unit` runs the Vitest unit project.

Use these commands during development:

- Run `bun run format` to format all files with `bun fmt`.
- Run `bun run lint` to run Oxlint with type-aware rules and fail on unused disable directives.
- Run `bun x oxlint --type-aware --fix` to autofix statement padding and other fixable rules.

## Format with `bun fmt`

`bun fmt` is Bun's native formatter. It formats the full repository in tens of milliseconds with zero extra formatter dependencies. CI runs `bun run format:check` (`bun fmt --check`) and rejects any unformatted file.

## Lint with `oxlint --type-aware`

`oxlint.config.ts` enables the `typescript` and `oxc` plugins with `categories: { correctness: 'error' }`, strict TypeScript rules such as `typescript/no-explicit-any` and `typescript/no-non-null-assertion`, `oxc/no-accumulating-spread`, and strict `no-unused-vars` (including `_`-prefixed identifiers).

The `lint` script passes `--type-aware` (powered by `oxlint-tsgolint`) and `--report-unused-disable-directives-severity=error`. Any stale `oxlint-disable` comment fails the build immediately.

## Enforce repository discipline with `@interfere/landmines`

`oxlint.config.ts` loads `@interfere/landmines` (`0.3.1`) under the `landmines` plugin and enables 32 of its 34 rules at `error` with zero `allow` debt maps.

### Correctness and suspicious (`recommended`)

All 18 rules in `recommended` (`correctness` and `suspicious`) run at `error`:

- **Correctness:** `no-conditional-expect`, `no-silent-catch`, `strict-msw`, `no-stale-render-assertion`, `no-project-max-workers`, `no-self-container-query`.
- **Suspicious:** `no-test-doubles`, `no-fixed-sleep`, `no-unsignaled-poll`, `no-shared-signal`, `no-flake-masking`, `no-parameter-branch`, `no-imported-mutation`, `no-elapsed-time-bound`, `no-cold-start-in-test`, `no-cold-import-in-test`, `no-styling-class-assertion`, `no-clipboard-read-text`.

These rules forbid mocking the system under test, sleeping in tests, polling against wall-clock deadlines, raising test timeouts to hide flakes, branching inside `test.each`, and measuring process cold starts inside an `it` block.

### Pedantic

Four of the five `pedantic` rules run at `error`:

- `landmines/max-file-lines` caps non-test source files at 500 lines.
- `landmines/max-exports-per-module` caps non-test source modules at 6 exported names (`export * from` counts as 1).
- `landmines/max-files-per-directory` caps any directory at 20 direct non-test source files.
- `landmines/no-prefix-cluster` rejects 3 or more sibling modules that share a `<prefix>-` stem instead of a subdirectory.

`landmines/declared-test-inputs` stays `off`. Its implementation checks `turbo.json` `tasks.test.inputs` for Turborepo monorepos. This repository runs Vitest directly from the root without Turborepo, so package manifests have no `test` script and no `turbo.json`.

### Style

Two of the three `style` rules run at `error`:

- `landmines/padding-between-statements` separates statements with blank lines outside compact declaration, import, assignment, and assertion groups. It autofixes with `oxlint --fix`.
- `landmines/no-inline-hex-encoding` rejects per-byte `toString(16).padStart(2, '0')` loops.

`landmines/no-explicit-return-types` stays `off`. Generator functions that return `Fallible<T, E>` or `AsyncFallible<T, E>` must declare their return type explicitly so TypeScript tracks the exact yielded failure union `E` and prevents accidental widening.

### Restriction

All 8 `restriction` rules run at `error`:

- `landmines/no-comments` rejects prose comments and allows functional directives (`oxlint-disable`, `@ts-expect-error`), single-line `// WARNING:`, `// SAFETY:`, and `// D1:` markers, and TSDoc on public package entrypoints (`clientConfig.ts`, `publish/index.ts`, `publish/convert.ts`, `packages/service/testing/`, and `packages/cli/src/index.ts`).
- `landmines/colocated-tests` keeps every test beside its subject.
- `landmines/test-file-names` enforces `.test.ts`, `.test-utils.ts`, and `.fixture.ts` naming.
- `landmines/test-dir-only-cross-functional` restricts `test/` to cross-functional harnesses.
- `landmines/package-exports` forbids wildcard source exports in `package.json`.
- `landmines/no-scripts-directory` forbids `scripts/` directories. Repository tools live under `tools/` by ownership (`tools/fallible/`, `tools/packaging/`, `tools/ops/`, `tools/docs/`, `tools/oxlint/`).
- `landmines/no-github-scripts` forbids `.ts`, `.sh`, and `.py` files under `.github/`.
- `landmines/package-scripts` enforces standard script names and forbids `node <file>.ts` or `bun <file>.ts` script commands in `package.json`. Executable entrypoints declare `#!/usr/bin/env node` with mode `0755`.

## Catch type-level slop with `anti-slop`

`tools/oxlint/anti-slop/` runs 6 rules from `dmmulroy/anti-slop` at `error`:

- `anti-slop/no-chained-type-assertions` blocks double casts such as `x as unknown as T`.
- `anti-slop/no-reflect-get` and `anti-slop/no-reflect-apply` block `Reflect` escapes around the type checker.
- `anti-slop/no-unknown-type-aliases` blocks aliases that hide `unknown` behind a domain-sounding name.
- `anti-slop/no-reduce-accumulator-copy` blocks quadratic spreads inside `.reduce()`.
- `anti-slop/no-widen-then-assert` blocks widening a typed value only to assert it back.

## Enforce yielded failures with `fallible` and `dropped-call`

Production code in `packages/service/src/`, `packages/service/api/`, `packages/service/testing/`, `packages/cli/src/`, and `tools/{fallible,packaging,ops,docs}/` treats expected failures as typed values using `Fallible<T, E>` and `AsyncFallible<T, E>` (defined in `packages/service/src/errors/fallible.ts`).

The model maps directly to Rust error handling:

| Ontos TypeScript                         | Rust equivalent                 | Purpose                                                             |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `Fallible<T, E>` / `AsyncFallible<T, E>` | `Result<T, E>`                  | Function return type carrying both value and typed failure union    |
| `yield* fn()`                            | `fn()?`                         | Propagate a failure to the caller without catching                  |
| `return yield err`                       | `return Err(err)`               | Return a typed failure immediately                                  |
| `invariant(cond, msg)`                   | `assert!(cond, msg)` / `panic!` | Abort on an impossible programmer defect (the only allowed throw)   |
| `attempt(fn, mapErr)` / `caught(fn)`     | Border adapter                  | Convert an external throwing or rejecting call into a typed failure |

Two layers enforce this model completely:

1. **Syntactic rules (`tools/oxlint/fallible.mjs`):** `fallible/no-throw`, `fallible/no-catch`, `fallible/return-yield`, `fallible/no-dropped-call`, `fallible/no-yield-in-finally`, and `fallible/no-bridge-import` run in Oxlint. Only `packages/service/src/errors/fallible/` may use `throw` and `try`/`catch`.
2. **Type-checked call checker (`tools/fallible/dropped-call.ts`):** `bun run lint:dropped` uses the TypeScript type checker to catch any `Fallible`, `AsyncFallible`, or `FallibleStream` call that no caller runs via `yield*`, `settle`, `step`, or `mapStream`. It also rejects any `await` or `for await` of an external Promise outside `attempt` or `caught`, unless the line directly above carries an explicit `// D1: <reason>` boundary marker where external callers require a rejected Promise.

## Enforce module borders and pure files

`tools/oxlint/local.mjs` and `tools/oxlint/borders.ts` enforce the module architecture of `packages/service` and `packages/cli`:

- `local/module-border` requires every cross-module import inside `packages/service/src/` to enter through `<module>/index.ts` and restricts runtime value imports to the directed dependency table `runtimeImports`. Type-only imports (`import type`) may cross from any module's `index.ts`.
- `local/static-import` forbids dynamic `import()` in production code so static border checks see every dependency. Only `functions/worker.ts` (for base64 Function bundles) and `handler/routes.ts` (for lazy `mcp` and `publish` entries) have narrow allow rules.
- `local/no-snapshot-cast` forbids forging a `SnapshotDb` with `as SnapshotDb`. Only `Db.snapshot` constructs one.
- `no-restricted-imports` and `no-restricted-properties` enforce package ownership (only `db` imports `pg`, only `decimal/index.ts` imports `big.js`, only `packages/service/src/spans/` and `packages/service/api/_tracing.ts` import `@opentelemetry/api`, only `api/` imports Vercel/Sentry/PostHog) and keep pure compiler/planner directories (`errors/`, `objectSets/compile/`, `actions/pure/`, pure `ontology/`, and pure `publish/`) free of Node I/O, `pg`, and runtime spans.

## Typecheck and check dead code

- **`bun run typecheck`** runs `bun check --no-script` across `.`, `packages/service`, and `packages/cli`. Multi-core native typechecking finishes in under 300 ms across all three projects.
- **`bun run knip`** checks `knip.jsonc` and fails if any file, exported symbol, exported type, or `package.json` dependency is unused.

## Read and fix failures

Each check prints the file path, line number, rule name, and required action:

- **`landmines(...)` failure:** Read the diagnostic message directly. Every Landmines rule states what to replace the pattern with (for example, move a process spawn into `beforeAll`, replace a wall-clock poll with a `Promise.withResolvers()` signal, or split a file over 500 lines).
- **`local/module-border` or `no-restricted-imports` failure:** Import another service module through its `index.ts`, switch to `import type` when only types are needed, or move I/O out of a pure file into its impure caller.
- **`dropped-call:` failure:** Add `yield*` to run a dropped fallible call, wrap an external Promise inside `attempt(() => ..., mapError)`, or consume a `FallibleStream` with `step` or `mapStream`.
- **`knip` failure:** Delete the unused export, file, or dependency instead of adding a `knip.jsonc` ignore entry.
