# The Ontology runs as a hosted service behind the stock OSDK

Web apps, mobile apps, and AI agents must reach the same Ontology. So the Ontology runs as a standalone Ontology service backed by PostgreSQL 17. Each Ontology service deployment serves the OSDK HTTP API v2 for one product. Updated by [ADR 0011](./0011-the-ontology-mcp-accepts-only-authkit-tokens-for-its-own-url.md): the Ontology service serves the Ontology MCP. Updated by [ADR 0012](./0012-people-sign-in-with-workos-authkit-in-an-organization-and-ci-only-publishes.md): one deployment serves many Organizations, and each Ontology is 1 installation of 1 product. Apps use the stock `@osdk/client`, the generated Ontology SDK, and `@osdk/maker` for Ontology-as-code.

## Considered Options

- A library inside each app's server code, with custom `define*` functions, generator, and Ontology SDK. Mobile apps and MCP clients must then go through the web app.
- A Go or Rust service. In load tests, Go served 1.3 to 2.2 times the requests of a TypeScript service with 2 processes on reads and rule-backed Actions. The Go service process used a tenth of the TypeScript memory, but the Node.js Function runtime that Go needs used up to 465 MiB more. Rust was not faster than Go. Each needs a Node.js process for the TypeScript edit Functions and a type generator for the HTTP API types. On Vercel, the Go and Rust runtimes are Beta, and the Functions need a second Vercel Function and an exported Postgres snapshot. A container host runs the service and Node.js in one instance. TypeScript keeps OSDK types, one runtime, and the current specs.
- One service for all apps. Isolation between apps is work that one Ontology service deployment for each app does not need.

## Consequences

- [ADR 0007](./0007-consumers-get-the-ontology-sdk-as-a-package.md) states who makes the Ontology SDK and who publishes it.
- CI runs the stock `@osdk/client` against a running Ontology service. A release ships only when these tests pass.
- Each Ontology service deployment runs one pinned release in production. Updated by [ADR 0006](./0006-each-app-owns-its-ontology-service-deployment.md): the Ontology deployment repository of each app holds the pin and makes the move.
- Each app runs one Ontology service and one PostgreSQL 17 database.
- [Deployment](../service/deployment.md) and [Releases](../service/releases.md) specify how Ontology service deployments run and how releases ship.
