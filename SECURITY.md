# Security Policy

## Supported versions

Security fixes apply to the latest minor release of the active major version.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Do not open a public GitHub issue for a security vulnerability.

Report vulnerabilities privately through GitHub Security Advisories for `ebragas/ontos`:

- https://github.com/ebragas/ontos/security/advisories/new

Include these details in your report:

1. The affected package (`@ericbragas/ontos-service`, `@ericbragas/ontos-cli`, or Docker image) and version.
2. The authentication mode (`dev`, `oidc`, or `workos`) and deployment configuration.
3. Steps to reproduce the issue, including any request payloads or proof-of-concept scripts.
4. Your assessment of impact.

## Response timeline

- **Acknowledgement:** within 48 hours of receipt.
- **Triage and severity assessment:** within 5 business days.
- **Fix and coordinated disclosure:** target 14 days for critical or high severity issues, and 30 days for medium or low severity issues.

We credit reporters in the release notes and security advisory unless you ask to stay anonymous.

## Trust boundaries for self-hosted deployments

- **Publish credentials equal host code execution:** Edit Functions and Query Functions execute inside Node.js `worker_threads`, not inside a hostile-tenant OS, container, or VM sandbox. Anyone who can call `POST /api/ontology-service/v1/publish` supplies JavaScript that runs inside the service process boundary. Restrict publish credentials (`ONTOS_PUBLISH_TOKEN`, `ONTOS_PUBLISH_OIDC_*`, or `TRUSTED_GITHUB_REPOSITORY` + `TRUSTED_GITHUB_ENVIRONMENT`) strictly to trusted CI pipelines and trusted operators.
- **Development auth guard:** `ONTOS_AUTH_MODE=dev` is strictly for local development and tests. The service refuses to start in `dev` mode whenever `ONTOLOGY_ENVIRONMENT`, `NODE_ENV`, or `VERCEL_ENV` is set to `production` or `prod`.
- **Production transport and credentials:** In production, run with `ONTOS_AUTH_MODE=oidc` or `ONTOS_AUTH_MODE=workos` behind TLS and never expose raw PostgreSQL credentials.
