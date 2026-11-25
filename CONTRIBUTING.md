# Contributing to Ontos

Thank you for contributing to Ontos. Every pull request runs deterministic formatting, linting, typechecking, dead-code, package, and test checks.

## What we welcome

We welcome pull requests in these areas.

- **Bug fixes.** Correct defects in the service engine, HTTP API, CLI, or packaging with a regression test.
- **`@osdk/*` interoperability fixes.** Align request validation, response shapes, or error codes with `@osdk/client`, `@osdk/maker`, `@osdk/cli`, or `@osdk/functions`.
- **New `IdentityProvider` adapters.** Add authentication adapters for standard OIDC providers or enterprise identity platforms alongside `dev`, `oidc`, and `workos`.
- **`Ontology MCP` improvements.** Improve Business map clarity, tool ergonomics, and MCP client interoperability.
- **Example ontologies.** Add runnable sample ontologies under `examples/` that show real domain models, Actions, Functions, and security policies.
- **Documentation improvements.** Clarify specifications, ADRs, quickstarts, and SVG architecture diagrams.
- **Companion Ontology Manager web UI proposals.** Propose designs or RFCs for a visual studio that browses Object Types, Link Types, Action Types, Object Edit History, and Object security policies.

Open an issue before you start work on major new subsystems, new HTTP routes, non-PostgreSQL storage backends, or breaking public API changes.

## Prerequisites

- Node.js 24 or newer (see `.nvmrc`)
- Bun 1.4.5 or newer
- Docker (required for PostgreSQL-backed MCP and SQL test suites)

## Setup and build

Install dependencies and build both packages (`@ericbragas/ontos-service` and `@ericbragas/ontos-cli`).

```sh
bun install
bun run build
```

## Verification commands

Run these commands before you open a pull request.

```sh
bun run check       # format:check, oxlint --type-aware, bun check, lint:dropped, knip, unit tests
bun run check:pkg   # publint and attw (--profile esm-only) on @ericbragas/ontos-service and @ericbragas/ontos-cli
bun run test:mcp    # Ontology MCP suite against Postgres 17 in Docker
bun run test:sql    # PostgreSQL engine and CLI integration tests in Docker
```

Use `bun run format` to format all files with `bun fmt`. Run `bun x oxlint --type-aware --fix` to autofix statement padding and other fixable lint rules.

## Error handling with `Fallible` and `AsyncFallible`

Production code treats expected failures as typed values using `Fallible<T, E>` and `AsyncFallible<T, E>` from `packages/service/src/errors/fallible.ts`. The model maps directly to Rust error handling.

| Ontos TypeScript                         | Rust equivalent                 | Purpose                                                             |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `Fallible<T, E>` / `AsyncFallible<T, E>` | `Result<T, E>`                  | Function return type carrying both value and typed failure union    |
| `yield* fn()`                            | `fn()?`                         | Propagate a failure to the caller without catching                  |
| `return yield err`                       | `return Err(err)`               | Return a typed failure immediately                                  |
| `invariant(cond, msg)`                   | `assert!(cond, msg)` / `panic!` | Abort on an impossible programmer defect (the only allowed throw)   |
| `attempt(fn, mapErr)` / `caught(fn)`     | Border adapter                  | Convert an external throwing or rejecting call into a typed failure |

Two checks enforce this model across the codebase.

1. `oxlint` runs `tools/oxlint/fallible.mjs` (`fallible/no-throw`, `fallible/no-catch`, `fallible/return-yield`, `fallible/no-dropped-call`, `fallible/no-yield-in-finally`, and `fallible/no-bridge-import`). Only `packages/service/src/errors/fallible/` may use `throw` and `try`/`catch`.
2. `bun run lint:dropped` (`tools/fallible/dropped-call.ts`) checks with the TypeScript type checker that every `Fallible`, `AsyncFallible`, or `FallibleStream` call runs and that every external `await` sits inside `attempt` or `caught` (unless annotated with `// D1: <reason>` at an external boundary).

## Linting and zero-debt rules

`oxlint.config.ts` enables 32 of 34 `@interfere/landmines` rules at `error` with zero allowlist debt, 6 `anti-slop` type-safety rules, and module border checks (`local/module-border`, `local/static-import`, `local/no-snapshot-cast`).

Fix the underlying code when a check fails. Do not add file allowlists, weaken lint rules, or leave unused `oxlint-disable` directives.

Read these documents for the full rules and module layout.

- [Linting and static checks](docs/linting.md)
- [Code layout](docs/service/code-layout.md)

## Pull request guidelines

- Keep each pull request focused on one change.
- Use Conventional Commit subjects (`feat(cli): ...`, `fix(service): ...`, `docs: ...`).
- Update the relevant specification in `docs/` when behavior changes.
- Ensure every test that proves a specification rule cites a valid `<doc>#<anchor>` heading checked by `tools/docs/spec-sections.ts`.
- All contributions are licensed under the Apache License, Version 2.0 (see [LICENSE](LICENSE)).
