# Service specifications

This tree holds the formal engineering contracts that specify how the Ontology service delivers the concepts in [`docs/ontology/`](../ontology/README.md). Each specification uses ASD-STE100 Simplified Technical English and follows the structure rules in [`docs/ontology/README.md`](../ontology/README.md). The [`spec-sections.ts`](../../tools/docs/spec-sections.ts) checker verifies that every specification section referenced by the 8,500+ test suite matches a heading in these files. If you want an overview or the five-minute quickstart, start with [`README.md`](../../README.md).

## Core service, API, and authentication

| Specification                             | Scope                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Ontology service](./ontology-service.md) | Multi-installation product hosting over the OSDK HTTP API v2 with stock `@osdk/client` packages.              |
| [HTTP API](./http-api.md)                 | OSDK HTTP API v2 routes, pagination, error shapes, and request validation served by the Ontology service.     |
| [Ontology MCP](./ontology-mcp.md)         | Streamable HTTP MCP server at `/api/mcp`, 8 caller-scoped tools, Business map, and RFC 9728 OAuth metadata.   |
| [CLI](./cli.md)                           | `ontos` commands for scaffolding, local `dev` hosting, publishing, installing, reading Objects, and Actions.  |
| [Authentication](./authentication.md)     | Pluggable `dev`, `oidc`, and `workos` identity provider modes, Organizations, permissions, and token refresh. |

## Authoring, storage, and publishing

| Specification                             | Scope                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Ontology-as-code](./ontology-as-code.md) | Authoring Ontologies with `@osdk/maker` TypeScript definitions and rejecting out-of-scope constructs.        |
| [Storage](./storage.md)                   | PostgreSQL 17 tables, indexes, engine changes, transactional Action writes, and Object Edit History storage. |
| [Publish](./publish.md)                   | Publishing product IRs, validating migrations, upgrading every installation in 1 transaction, and installs.  |

## Operations, releases, and quality

| Specification                                  | Scope                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Ontology service deployment](./deployment.md) | Self-hosting with Docker and Node.js or deploying serverless on Vercel with PostgreSQL 17 and environment setup. |
| [Releases](./releases.md)                      | Semantic version tags, package publishing, pre-releases, and pinning releases per Ontology service deployment.   |
| [Observability](./observability.md)            | Structured JSON request logs, OpenTelemetry traces, span catalog, and optional error reporting.                  |
| [Testing](./testing.md)                        | Unit, conformance, MCP, SQL, and smoke test suites plus local testing for Ontology deployment repositories.      |
| [Code layout](./code-layout.md)                | Monorepo package boundaries, internal module seams, dependency rules, and imported OSDK packages.                |

## Interoperability and boundaries

| Specification                             | Scope                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [OSDK workarounds](./osdk-workarounds.md) | Log of upstream `@osdk/*` limits and the workarounds Ontos applies without forking Apache-2.0 packages.    |
| [Deviations](./deviations.md)             | Intentional behavioral differences between Ontos and upstream `@osdk/*` defaults, linked to each rule.     |
| [Out of scope](./out-of-scope.md)         | OSDK and platform capabilities that the Ontology service intentionally omits, linked to each spec section. |

## Formal verification diagrams (`diagrams/`)

These interactive TLA+ statechart models check concurrency, crash-recovery, and cache invariants against TLC.

| Model                                                          | What it verifies                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [Publish in 1 transaction](./diagrams/publish-model.html)      | Publish, install, restore, and WorkOS default-role reconcile invariants across single-transaction upgrades and crash faults.    |
| [Write path model](./diagrams/write-model.html)                | Action transaction outcomes under optimistic version conflicts, timeouts, shutdowns, and post-`COMMIT` connection drops.        |
| [Kept WorkOS answers](./diagrams/kept-answers-model.html)      | Multi-instance caller permission caching, 60-second refresh windows, fallback windows, and revocation behavior on WorkOS error. |
| [Default roles in WorkOS](./diagrams/default-roles-model.html) | Historical pre-ADR 0015 default-role publish and upgrade model with removal and hold states (superseded by the publish model).  |
