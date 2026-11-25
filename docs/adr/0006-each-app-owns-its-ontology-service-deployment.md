# Each app owns its Ontology service deployment

An Ontology deployment repository owns its Ontology service deployment: its deployment configuration, its CI workflows, its secrets, and its Ontology-as-code. The Ontology Service repository only builds, tests, and publishes releases of `@ericbragas/ontos-service` and `@ericbragas/ontos-cli`.

The Ontology deployment repository holds no consumer. Each consumer, such as a web app, has its own consumer repository and installs the Ontology SDK package produced by the Ontology deployment repository. So 1 Ontology can serve many consumers.

A release reaches each app as 2 packages on npm, `@ericbragas/ontos-cli` and `@ericbragas/ontos-service`, with the same version. The `release` workflow publishes them only after CI passes. The version that an Ontology deployment repository pins is the release of its environment.

## Considered Options

- 1 app repository holds the Ontology-as-code, the deployment, and the web app. Each new consumer, such as an MCP client, then joins that repository or copies the Ontology SDK, and each consumer change runs in the repository that can publish and deploy.
- The Ontology Service repository owns each deployment. A change to the deployment of an app then needs a change to the service repository, and the service repository holds the secrets of each app.
- A reusable workflow in the service repository checks out a tag and deploys directly. Each app's CI then deploys from a source checkout instead of a published package.
- The CLI carries the service code unconditionally. Each install of the CLI then bundles the service source, and the CLI is no longer a thin client.

## Consequences

- A change to the deployment of an app needs no change to the Ontology Service repository. Moving to a new release is a version bump in the app's Ontology deployment repository. A rollback is a revert.
- The Ontology Service repository holds no secret of any app. Database URLs, identity provider keys, and hosting tokens live only in the app's own deployment environment.
- No workflow of the Ontology Service repository can publish to an app or apply its Actions.
- This decision updates [ADR 0003](./0003-hosted-ontology-service.md): the Ontology deployment repository, not the Ontology Service repository, moves its Ontology service deployment to a new release.
- [Ontology service deployment](../service/deployment.md) and [Releases](../service/releases.md) state the rules.
