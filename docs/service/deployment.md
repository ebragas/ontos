---
status: specified
---

# Ontology service deployment

An Ontology service deployment is the [Ontology service](./ontology-service.md) for one app backed by PostgreSQL 17. You can self-host it with the repository's multi-stage `Dockerfile` and `docker-compose.yml` (Node 24 Alpine running `packages/service/dist/node.js` with `dev`, `oidc`, or `workos` auth, documented in `.env.example`), or deploy it serverless on Vercel with Neon Postgres and WorkOS AuthKit. Each app owns its deployment, and this repo publishes [releases](./releases.md), as [ADR 0006](../adr/0006-each-app-owns-its-ontology-service-deployment.md) decides.

## Contract

### App stack

- An app calls its Ontology service deployment with the stock `@osdk/client` or the `ontos` CLI. Our rule.
- Business data lives in the Ontology backed by PostgreSQL 17, and user identity lives in the configured identity provider (`dev`, `oidc`, or `workos`). Our rule.

### Projects and environments

- Each Ontology service deployment backs an environment with PostgreSQL 17. The Ontology service connects as its configured PostgreSQL role (for example `ontology_service`). Our rule.
- For multi-environment deployments, staging and production run against separate PostgreSQL databases (or Neon branches) and separate identity provider environments so staging tests never touch production data. Our rule.
- When hosting on Vercel, each environment receives `DATABASE_URL`, `DATABASE_URL_DIRECT`, and its identity provider settings, with up to 4 GB memory and `maxDuration: 800` in `vercel.json` for [Function](../ontology/functions/functions.md#runtime) workers. Deployment Protection must be off so callers and `client-config` reach the service's own token checks. Sources: [Vercel Functions limits](https://vercel.com/docs/functions/limitations), [Deployment Protection](https://vercel.com/docs/deployment-protection).
- When resetting a staging database from production, redeploy or restart service instances so cold-start engine changes apply, [remap](./storage.md#remap) copied installations to their staging [Mirror Organizations](../../GLOSSARY.md), and run `ontos generate-osdk` followed by `ontos publish --env staging --skip-sdk-package` to upgrade copied installations without publishing a duplicate SDK package. Our rule.

### Domains

- When using `--app <name>` without `--url`, the CLI maps production to `https://<app>.<domain>` and staging to `https://<app>-staging.<domain>`, where `<domain>` comes from `ONTOS_BASE_DOMAIN` (default `ontos.example`). Passing `--url <url>` targets any custom or self-hosted HTTP(S) origin directly. Our rule.
- In production, always terminate TLS in front of the service. When fronting Vercel with Cloudflare, set the `CNAME` record to "DNS only". Source: [Cloudflare with Vercel](https://vercel.com/kb/guide/cloudflare-with-vercel).

### Deployment files

- An app can store non-secret deployment settings in `.ontology/deployment.json` in its Ontology repository for `ontos validate --local` and SDK `$environments` metadata. Our rule.
- A deployment file holds only non-secret settings: the product RID (`productRid`), an optional flag allowing pre-releases, optional `logRequestBodies`, `loadDerivedProperties`, and `traces` settings, and per-environment `baseUrl`, `workosClientId`, `authkitDomain`, `mcp`, `trustedGithubRepository`, and `trustedGithubEnvironment`. Our rule.
- A CLI ignores unknown keys in a deployment file and warns about them, so a CLI of the same major version can read files written for a newer minor version. Our rule.
- The app name is not in the deployment file. Pass `--url`, `--app`, or set `ONTOLOGY_APP` in `.env`, as [CLI](./cli.md#targets) specifies.
- The product RID, `productRid`, uses the OSDK form `ri.ontology.main.ontology.<UUID>`. It is shared across staging and production and serves as the namespace for derived RIDs, as [HTTP API](./http-api.md#rids) specifies. Our rule.
- An Ontology service deployment has no fixed Ontology RID. Install creates the RID of each Ontology, as [Publish](./publish.md#install) specifies. Consumers read the RID from List Ontologies and pass it to `createClient` at runtime.
- `loadDerivedProperties` (`ONTOLOGY_LOAD_DERIVED_PROPERTIES=true`) causes loads with no `select` and no `loadOntologyDefinedDerivedProperties` to include Object Type derived properties, as [Derived properties](../ontology/object-link-types/derived-properties.md#reads) specifies. Our rule.
- The Ontology service reads its configuration from environment variables. When a required variable for the selected auth mode is missing or empty, it connects to no database and answers each request with HTTP status 503 and `OntologyService:SettingMissing` (except [The token route](./authentication.md#the-token-route), which returns 503 with its OAuth error). Our rule.

| Variable                     | Value                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PRODUCT_RID`                | The product RID (defaulted automatically in `dev` mode)                                                          |
| `ONTOLOGY_ENVIRONMENT`       | `development`, `staging`, or `production`                                                                        |
| `ONTOLOGY_BASE_URL`          | The base URL of the environment, used as the audience for OIDC/GitHub publish tokens                             |
| `DATABASE_URL`               | The pooled PostgreSQL connection string                                                                          |
| `DATABASE_URL_DIRECT`        | The direct PostgreSQL connection string for publish and engine changes (falls back to `DATABASE_URL` when unset) |
| `WORKOS_CLIENT_ID`           | Required in `workos` mode: the WorkOS client ID of the environment                                               |
| `AUTHKIT_DOMAIN`             | Required in `workos` mode: the AuthKit domain of the environment (no scheme or port)                             |
| `WORKOS_API_KEY`             | Required in `workos` mode: the API key of the WorkOS environment                                                 |
| `TRUSTED_GITHUB_REPOSITORY`  | Optional in `oidc` mode, required in `workos` mode: trusted GitHub repo (`owner/name`) for publish               |
| `TRUSTED_GITHUB_ENVIRONMENT` | Optional in `oidc` mode, required in `workos` mode: trusted GitHub environment for publish                       |
| `SENTRY_DSN`                 | Optional DSN for Sentry fault reporting in the Vercel adapter                                                    |

- The Ontology service also reads optional runtime and authentication-mode variables (see `.env.example` and [Authentication modes](./authentication.md#authentication-modes)):

| Variable                           | Value                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ONTOS_AUTH_MODE`                  | `dev`, `oidc`, or `workos` (default `workos` when unset). In `dev` mode, only `DATABASE_URL` is required; in `oidc` mode, `ONTOS_OIDC_ISSUER` replaces WorkOS variables |
| `ONTOS_DEV_TOKEN`                  | Static bearer token for `ONTOS_AUTH_MODE=dev` (default `ontos-dev-token`)                                                                                               |
| `ONTOS_MAX_BODY_BYTES`             | Optional positive integer overriding the default JSON request body limit                                                                                                |
| `ONTOLOGY_MCP`                     | `true` turns the [Ontology MCP](./ontology-mcp.md) on (defaults to `true` in `dev` mode)                                                                                |
| `LOG_REQUEST_BODIES`               | `true` includes request bodies in structured request logs, as [Logs](./observability.md#logs) specifies                                                                 |
| `ONTOLOGY_LOAD_DERIVED_PROPERTIES` | `true` enables default loading of Object Type derived properties                                                                                                        |

- The tracing layer (`packages/service/api/_tracing.ts`) reads optional trace export variables. A missing variable turns its destination off, or keeps the sample rate at 1. Our rule.

| Variable                      | Value                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL or `/v1/traces` endpoint of any OpenTelemetry OTLP/HTTP collector                   |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Optional comma-separated `key=value` headers sent to the OTLP collector                      |
| `TRACES_SENTRY`               | `true` exports spans to Sentry, as [Trace export](./observability.md#trace-export) specifies |
| `TRACES_POSTHOG_REGION`       | `us` or `eu` for PostHog span export                                                         |
| `TRACES_POSTHOG_TOKEN`        | PostHog project token (`phc_...`) paired with `TRACES_POSTHOG_REGION`                        |
| `TRACES_SAMPLE_RATE`          | Number from 0 to 1 controlling the share of requests that record a trace                     |

### Setup

- To scaffold a new Ontology repository locally, run `ontos init [dir]`. It creates `ontos.yml`, `package.json` pinned to the current OSDK set and `@ericbragas/ontos-cli` / `@ericbragas/ontos-service` versions, `ontology/src/ontology.mts`, `ontology/src/grants.json`, `.ontology/schema-migrations.json`, and `.gitignore`. Our rule.
- To run locally with Docker Compose, start PostgreSQL 17 and the Ontos service with `docker compose up` (using `.env.example` as a template) or run `ontos dev` against any local PostgreSQL database. Our rule.
- For production deployments, provision PostgreSQL 17, configure `ONTOS_AUTH_MODE=oidc` or `ONTOS_AUTH_MODE=workos` with your identity provider settings, and store database and provider credentials in your deployment platform's secret manager. Never commit secrets to Git. Our rule.

### Rollout

- Deploy a new `@ericbragas/ontos-service` release by updating the pinned `@ericbragas/ontos-service` and `@ericbragas/ontos-cli` versions (or container image tag), running the smoke checks (`client-config` returns `200`, `GET /api/v2/ontologies` without a token returns `401`, and MCP smoke checks pass when enabled), and then running `ontos generate-osdk` and `ontos publish` for any Ontology schema changes. Our rule.
- Run at most 1 publish job per environment at a time (for example via a GitHub Actions `concurrency` group per branch without canceling in-progress jobs) so concurrent publishes never race. Our rule.
- Keep `ontos.yml` (or optional `foundry.yml` fallback), `.ontology/schema-migrations.json`, `<ONTOLOGY path>/src/ontology.mts`, and `<ONTOLOGY path>/src/grants.json` under version control, and validate pull requests with `ontos generate-osdk` and `ontos validate`. Our rule.

### Managed files

- Each Ontology repository owns its CI workflows and configuration files (`ontos.yml` or optional `foundry.yml` fallback, `package.json`, `.ontology/schema-migrations.json`, and optional `.ontology/deployment.json`). Our rule.
- Pull request validation runs `ontos generate-osdk` followed by `ontos validate` (with `--local` for offline validation against the pinned release, or `--base <ref>` to detect CLI pin vs. Ontology schema changes). When `--base <ref>` sees both a CLI version bump and an Ontology schema change (`ontos.yml`/`foundry.yml`, `.ontology/schema-migrations.json`, `<TYPESCRIPT_FUNCTIONS path>/`, or `<ONTOLOGY path>/` outside `osdkOutput` and `src/grants.json`), it exits 1 so release upgrades and schema changes land separately. Our rule.
- Publish jobs run `ontos generate-osdk` followed by `ontos publish` (passing `--skip-sdk-package` when no external SDK package publish is needed). Our rule.

### Rollback

- Rolling back the service deploys an earlier release version of `@ericbragas/ontos-service` (or container image). Rollbacks do not undo Ontology publishes, so the earlier release must support the newest stored product version, OSDK set, and IR concepts, as [Releases](./releases.md#compatibility-with-earlier-releases) specifies. Our rule.
- When an earlier release does not support the newest stored IR or OSDK set, publish a compatible Ontology version first or roll forward with a patched release. Our rule.

### Secrets

- Store runtime secrets (`DATABASE_URL`, `DATABASE_URL_DIRECT`, `WORKOS_API_KEY`, `ONTOS_PUBLISH_TOKEN`, or OIDC credentials) exclusively in your deployment platform's secret store or GitHub Actions environments. Never commit secrets to the repository or print them in logs. Our rule.
- Restrict publish credentials strictly to trusted CI workflows and operators, because Edit Functions and Query Functions run inside Node.js `worker_threads` in the service process (see `SECURITY.md`). Our rule.
- Rotate any secret immediately if it may have leaked by provisioning a replacement, updating the deployment environment, and revoking the old secret. Our rule.

### Backups

- Maintain regular PostgreSQL backups or point-in-time recovery (PITR) for production databases. To restore a single Ontology from a point-in-time copy without affecting other Ontologies, use `tools/ops/restore-ontology.ts`, as [Restore](./storage.md#restore) specifies. Our rule.

## Related

- [Ontology service](./ontology-service.md)
- [Releases](./releases.md)
- [Authentication](./authentication.md)
- [Publish](./publish.md)
- [Storage](./storage.md)
- [CLI](./cli.md)
- [ADR 0006: Each app owns its Ontology service deployment](../adr/0006-each-app-owns-its-ontology-service-deployment.md)
