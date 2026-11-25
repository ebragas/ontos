# Consumers get the Ontology SDK as a package, and the CLI makes it locally

[ADR 0006](./0006-each-app-owns-its-ontology-service-deployment.md) splits each app into its Ontology deployment repository and its consumer repositories. A consumer, such as a web app, does not hold the Ontology, so it cannot make the Ontology SDK. So the Ontology deployment repository publishes the Ontology SDK as an npm package (configurable via `ONTOS_SDK_PACKAGE_SCOPE` and `ONTOS_SDK_REGISTRY`, defaulting to `@ontos/<app>-ontology-sdk` on `https://npm.pkg.github.com`, and configurable to `https://registry.npmjs.org` or any npm-compatible registry), and each consumer pins 1 version of it. A pre-production environment publishes 1 version for each Ontology change, and a promote to production moves the npm tag `production` to that version. A consumer's `main` pins the version that has the `production` tag. Each version records the hash of the Ontology metadata and OSDK set that it came from, and the promote finds the version by that hash, because a merge into `main` makes a new commit. Consumer CI tests app code against a non-production environment, signed in as a test user of that environment's identity provider. So CI, preview builds, and production all call the service with a person's token.

The CLI makes the Ontology metadata locally, with the compile step and the converter of its own release, which esbuild bundles into the CLI. So `ontos generate-osdk` needs no network and no token, and the Ontology deployment repository does not commit the SDK.

## Considered Options

- Commit the SDK in 1 repository with the web app, with a deployment check on publish. Each new consumer then joins that repository or copies the SDK.
- A `-staging` package and a production package for each version. They hold the same code, and a consumer would need to switch packages for each build target.
- `generate-osdk` calls the service with `validateOnly`, and the repository commits the SDK. An agent with no token then needs a CI workflow to make the SDK after each Ontology change.
- Non-production trusts the GitHub tokens of listed consumer repositories, as a new caller kind. It needs a second trust list in the deployment file, a new caller kind, and a GitHub environment in each consumer repository, for a sign-in path that production never uses.
- The package version is the Ontology version number. Non-production and production count their versions apart, and a database reset makes non-production count again from production's number. npm never takes a version number twice, so the next publish after a reset would fail. Source: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish) ("that specific name and version combination can never be used again").

## Consequences

- A consumer needs no CLI and no Ontology-as-code: only the package and its pin rule.
- A production consumer cannot go live ahead of its Ontology.
- Non-production data can change from the CI of each consumer. A reset cleans it. The production identity provider environment has no test user.
- The CLI and the service share 1 converter per release. A converter change reaches the SDK and the served metadata in the same release.
- [Ontology SDK](../ontology/ontology-sdk/ontology-sdk.md#ontology-sdk-package), [Authentication](../service/authentication.md#people), and [Deployment](../service/deployment.md) state the rules.
