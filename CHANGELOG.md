# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-24

Initial Apache-2.0 open-source release of Ontos (`@ericbragas/ontos-service` and `@ericbragas/ontos-cli`).

### Added

- **Ontology service (`@ericbragas/ontos-service`):**
  - PostgreSQL-backed semantic and kinetic Ontology engine serving the OSDK HTTP API v2 (`loadObjects`, `aggregate`, `apply`, `editsHistory`, `fullMetadata`, `executeQuery`, `ontologies`, and Admin user routes).
  - Full support for Object Types, Properties, Value Types, Derived Properties, Uniqueness Constraints, Link Types, Object Sets, Aggregations, Rule-backed Actions, Function-backed Actions (isolated Node worker pool), Query Functions, Object Edit History, Schema Migrations, and Object and Property Security Policies.
  - Ontology MCP server at `/api/mcp` with 8 tools including the `describe_object_type` Business map, Streamable HTTP transport, and RFC 9728 OAuth protected resource metadata.
  - Pluggable identity provider architecture supporting `dev` (local development), `oidc` (any standard OIDC/JWKS issuer), and `workos` (WorkOS AuthKit + Organizations) authentication modes, with production fail-closed guard on `dev` mode.
  - Compiled ESM package exports (`.`, `./client-config`, `./publish`, `./convert`, `./testing`) verified by `publint` and `@arethetypeswrong/cli`.
  - Optional OpenTelemetry OTLP trace export (`OTEL_EXPORTER_OTLP_ENDPOINT`), Sentry (`SENTRY_DSN`), and PostHog tracing.
- **Ontos CLI (`@ericbragas/ontos-cli`):**
  - `ontos` binary with fast lazy-loaded startup (~44 ms cold start for `--help` and `--version`).
  - `ontos init` project scaffolding and `ontos dev` local PostgreSQL server command.
  - `ontos.yml` configuration support and direct `--url` targeting without `--app`.
  - Full workflow commands: `login`, `logout`, `install`, `describe`, `objects`, `aggregate`, `apply`, `history`, `validate`, `publish`, and `generate-osdk`.
- **Quality, security, and performance:**
  - Strict static analysis with `oxlint --type-aware`, 32 `@interfere/landmines` rules at zero debt, 6 `anti-slop` rules, `Fallible`/`AsyncFallible` yielded-error enforcement, and `knip` dead-code checks.
  - Precomputed Unicode text-search tables, `edit_history` database indexes, hardened request limits, and reproducible benchmarks in `benchmarks/BASELINE.md`.
  - Multi-stage `Dockerfile`, `docker-compose.yml` 5-minute quickstart, `.env.example`, and `examples/quickstart/` starter project.
  - Architecture specifications (`docs/service/`, `docs/ontology/`), ADRs (`docs/adr/`), and SHA-pinned GitHub Actions CI and Changesets release workflows.
