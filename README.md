# Ontos

[![CI](https://github.com/ebragas/ontos/actions/workflows/ci.yml/badge.svg)](https://github.com/ebragas/ontos/actions/workflows/ci.yml) [![License Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](.nvmrc) [![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-336791.svg)](docker-compose.yml)

Ontos is an open-source semantic and kinetic Ontology service built on PostgreSQL 17. It models business data as Object Types, Properties, and Link Types, applies transactional writes through rule-backed and Function-backed Action Types, and serves an Ontology MCP endpoint so AI agents read a live Business map and act safely.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ontos-hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/ontos-hero-light.svg" />
  <img alt="Ontos five-layer exploded isometric architecture: Service Surfaces, Semantic Graph, Kinetic Layer, Governance, and PostgreSQL 17" src="docs/assets/ontos-hero-light.svg" width="100%" />
</picture>

## Why Ontos?

Decades of data warehousing, analytics, and machine learning taught that 99% of getting value from new technology is building a trustworthy domain model of the business. AI faces the same constraint today. Model intelligence is no longer the limiting factor for most knowledge work. Deterministic constraints, self-serve discovery, and verifiable execution are.

- **Both semantic and kinetic.** Analytical semantic layers (from SSAS and Cube to newer tools like NVIDIA Auto Ontology) solve shared terminology and discovery, so everyone agrees on what a metric means. An operational Ontology adds the kinetic layer so apps, people, and AI agents act under deterministic rules (such as refusing to cancel an order after it ships) in one shared service instead of scattered prompts or isolated MCP tools.
- **Immutable governance and auditability.** Every read and write runs under caller permissions, Object security policies, Property security policies, and append-only Object Edit History rather than unconstrained SQL.
- **Proven modeling patterns on open-source PostgreSQL 17.** Ontos follows Palantir's publicly documented Ontology modeling practices and serves the OSDK HTTP API v2 so applications use the Apache-2.0 `@osdk/client`, `@osdk/maker`, `@osdk/cli`, and `@osdk/functions` packages without forks or patches on standard PostgreSQL 17. Ontos is an independent project and is not affiliated with or endorsed by Palantir Technologies.
- **Deterministic engineering discipline.** Production code models expected failures explicitly with `AsyncFallible`, enforces zero-debt static analysis, verifies behavior with 8,500+ tests against real PostgreSQL 17 and live MCP JSON-RPC, and maintains 100% Vercel DeepSec coverage across all 179 non-test candidate files.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ontos-architecture-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/ontos-architecture-light.svg" />
  <img alt="Ontos service architecture showing Applications via OSDK Client, Ontos CLI, and MCP Clients calling the Ontos Service over HTTP, backed by PostgreSQL 17 and an optional Identity Provider" src="docs/assets/ontos-architecture-light.svg" width="100%" />
</picture>

Read [Service specifications](docs/service/README.md) for full request routing, caller authentication models, single-transaction publishing, storage, and TLA+ statechart diagrams.

## Engineering highlights

Measured on Node.js `v24.22.2` and PostgreSQL `17.12` in [`benchmarks/BASELINE.md`](benchmarks/BASELINE.md) across 5 measured rounds with 0 errors.

| Metric                                          | Result                | Source                                                                     |
| ----------------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| Cold-start `applyEngineChanges` fast-path (p50) | `0.50 ms`             | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| `loadObjects` 10-row query (p50)                | `1.95 ms`             | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| `loadObjects` 1,000-row query (p50)             | `6.74 ms`             | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| Grouped `aggregate` over 1,000 rows (p50)       | `1.33 ms`             | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| Rule-backed `apply` single edit (p50)           | `2.57 ms`             | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| Function-backed `apply` 500-edit batch (p50)    | `12.85 ms`            | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| `ontos` CLI cold startup (`--version`, p50)     | `46.20 ms`            | [benchmarks/BASELINE.md](benchmarks/BASELINE.md)                           |
| Automated test coverage                         | `8,500+` tests        | Unit, real PostgreSQL 17 SQL, and live MCP JSON-RPC                        |
| Static analysis                                 | Zero-debt error rules | Oxlint type-aware, 32 `@interfere/landmines` rules, `lint:dropped`, `knip` |
| Security static review                          | `100%` coverage       | Vercel DeepSec across `179/179` non-test files, `0` findings               |

## Capabilities

- **Semantic layer.** Define Object Types, Properties (all base types, arrays, structs, Value Types, uniqueness constraints, and Derived Properties), Link Types (one-to-many and many-to-many), Object Sets, full-text search, and grouped Aggregations.
- **Kinetic layer.** Run rule-backed Action Types, submission criteria, Function-backed Action Types in an isolated Node.js worker pool, Query Functions, optimistic concurrency via Object versions, and append-only Object Edit History.
- **Governance.** Enforce permission-scoped views in `grants.json`, Object security policies, Property security policies, and Person attributes.
- **Ontology MCP.** Serve Streamable HTTP MCP at `/api/mcp` with 8 tools, including the `describe_object_type` Business map, RFC 9728 OAuth protected resource metadata, and caller-scoped permissions.
- **Pluggable authentication.** Select `dev` for local development, `oidc` for any OIDC/JWKS Identity provider, or `workos` for WorkOS AuthKit and Organizations. `dev` mode refuses to start when `ONTOLOGY_ENVIRONMENT`, `NODE_ENV`, or `VERCEL_ENV` is `production` or `prod`.
- **Single-transaction publishing.** Publish Ontology-as-code from `@osdk/maker` with schema migrations and upgrade every installation in one PostgreSQL transaction.

## Five-minute quickstart

Start PostgreSQL, scaffold a starter Ontology, publish it, apply an Action, read Objects, and inspect the Ontology MCP Business map.

### Prerequisites

- Docker (for PostgreSQL 17)
- Node.js 24 or newer (or Bun 1.4.5 or newer for local repository development)

### 1. Start PostgreSQL

Start the PostgreSQL 17 container from this repository.

```sh
docker compose up -d postgres
```

To run both PostgreSQL and the containerized Ontos service in `dev` mode on port `8080`, run `docker compose up -d` and skip step 3.

### 2. Scaffold an Ontology project

Create a starter project with `ontos init` or copy [`examples/quickstart/`](examples/quickstart/).

```sh
npx @ericbragas/ontos-cli init my-ontology
cd my-ontology
npm install
```

### 3. Start the local service

Start Ontos in `dev` mode against PostgreSQL.

```sh
export DATABASE_URL=postgres://ontos:ontos@127.0.0.1:5432/ontos
export ONTOS_DEV_TOKEN=ontos-dev-token
npx ontos dev
```

Leave this terminal open. Run the next steps in a second terminal with `export ONTOLOGY_TOKEN=ontos-dev-token`. For interactive sessions against remote deployments, `ontos login` stores credentials in `~/.config/ontos/tokens`.

### 4. Publish and install the Ontology

Publish the starter `Task` Object Type and `create-task` Action Type, then install the product into the local Organization. Omit `--skip-sdk-package` and set `ONTOS_SDK_REGISTRY` and `ONTOS_SDK_PACKAGE_SCOPE` when publishing a generated Ontology SDK package to an npm registry.

```sh
export ONTOLOGY_TOKEN=ontos-dev-token
npx ontos publish --url http://127.0.0.1:8080 --skip-sdk-package
npx ontos install 127.0.0.1-8080 --api-name tasks --display-name Tasks --url http://127.0.0.1:8080
```

### 5. Apply an Action and read Objects

Create a `Task` Object with `ontos apply` and read it back with `ontos objects`.

```sh
npx ontos apply com.example.tasks.create-task \
  --parameters '{"taskId":"task-1","title":"Ship Ontos v1","completed":false}' \
  --url http://127.0.0.1:8080

npx ontos objects com.example.tasks.Task --url http://127.0.0.1:8080
```

### 6. Query the Ontology MCP Business map

Call `describe_object_type` over Streamable HTTP at `POST /api/mcp` with no `objectType` argument to inspect the Business map.

```sh
curl -sS -X POST http://127.0.0.1:8080/api/mcp \
  -H "Authorization: Bearer ${ONTOLOGY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "describe_object_type",
      "arguments": {}
    }
  }'
```

## Roadmap

These capabilities are planned after `v1.0.0`.

- **Separate human and agent permissions.** Define distinct authorization boundaries for Actions that a person applies directly and Actions that an AI agent applies on their behalf.
- **Proposed Actions and human approval.** Let AI agents stage proposed Actions for human review before the Ontology service commits their edits.
- **Action History.** Record first-class immutable Action audit logs alongside Object Edit History so operators inspect every attempted and committed Action.
- **Exception and rejection logging.** Record rule exceptions that humans approve and proposed agent Actions that humans reject. These records turn operational edge cases into structured signals that improve the Ontology over time.
- **External-system Action writes.** Support Actions that write into external operational systems (such as accounting or ERP platforms) and keep Ontology Objects in sync.
- **Source-to-Object ingestion pipelines.** Map external data sources directly into typed Ontology Objects.

## Design decisions

- [Architecture Decision Records (`docs/adr/`)](docs/adr/) record the core choices on storage, single-transaction upgrades, Ontology SDK packaging, authorization, and observability.
- [Linting and static checks (`docs/linting.md`)](docs/linting.md) document the `Fallible` and `AsyncFallible` error model, `@interfere/landmines` zero-debt rules, `anti-slop` checks, and module border enforcement.
- [V1.0 benchmark baseline (`benchmarks/BASELINE.md`)](benchmarks/BASELINE.md) provides reproducible PostgreSQL 17 and CLI latency numbers.
- [Ontology MCP specification (`docs/service/ontology-mcp.md`)](docs/service/ontology-mcp.md) defines the 8 tools, Business map format, and OAuth protected resource flow.
- [Glossary (`GLOSSARY.md`)](GLOSSARY.md) holds the canonical definition of every Ontology and service term.

## Workspace layout

| Folder                | Contents                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/service`    | `@ericbragas/ontos-service` Ontology engine (`src/`), standalone HTTP server (`dist/node.js`), and Vercel adapter |
| `packages/cli`        | `@ericbragas/ontos-cli` `ontos` binary and programmatic `run(args, io?)` library entrypoint                       |
| `examples/quickstart` | Standalone starter Ontology matching `ontos init`                                                                 |
| `benchmarks`          | Reproducible PostgreSQL and CLI latency benchmark suite and [V1.0 baseline](benchmarks/BASELINE.md)               |
| `docs`                | Service specifications, Ontology specifications, ADRs, linting guide, TLA+ statechart diagrams, and SVG assets    |
| `tools`               | Fallible call checker, Oxlint plugins, packaging scripts, restore operations, and documentation checkers          |

## Development

Install dependencies, build both packages, and run the verification suite with Bun.

```sh
bun install
bun run build
bun run check       # format, oxlint --type-aware, typecheck, lint:dropped, knip, unit tests
bun run check:pkg   # publint and attw (--profile esm-only)
bun run test:mcp    # Ontology MCP tests (requires Docker)
bun run test:sql    # PostgreSQL integration tests (requires Docker)
```

## Documentation

- [Service specifications](docs/service/README.md) cover the HTTP API, authentication (`dev`, `oidc`, `workos`), CLI, Ontology MCP, storage, publishing, observability, and deployment.
- [Ontology specifications](docs/ontology/README.md) cover Object Types, Properties, Link Types, Object Sets, Aggregations, Action Types, Functions, Object Edit History, Schema Migrations, and Object security policies.

## Community and license

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Apache License 2.0](LICENSE) and [Third-Party Notices](NOTICE)
