---
status: specified
---

# Ontology SDK

The Ontology SDK is the typed TypeScript code that the OSDK generator writes from an app's Ontology metadata. App code uses it with the stock `@osdk/client` to read Objects and apply Actions. Source: Ontology SDK overview.

## Contract

- The app writes its Ontology SDK with the OSDK generator, `osdk unstable typescript generate --ontologyPath`, from the Ontology metadata produced by Ontos's own converter, which the CLI and the Ontology service of 1 release share, so the Ontology SDK and the served metadata always match. Source: `@osdk/cli` generate command.
- The [CLI](../../service/cli.md) makes the Ontology metadata locally, with the compile step and the converter of its own release. It makes it from the IR, the discovered Functions, and the product RID of the [deployment file](../../service/deployment.md#deployment-files). It needs no network and no token. Source: Ontology SDK overview ("The OSDK is generated locally and regenerated whenever those definitions change").
- The CLI makes the Ontology SDK in 2 passes, because a [Function](../functions/functions.md) imports its Object Types from the Ontology SDK. The first pass uses no Functions, so each function-backed Action Type has no parameters. Then the CLI bundles the Functions against that Ontology SDK, and the second pass uses them. Our rule.
- The Ontology SDK holds each [Query Function](../functions/query-functions.md) of the Ontology metadata, so an app runs it with `client(query).executeFunction(...)`. `ontos generate-osdk` writes it with the stock generator, and `tsc` passes on a call with an optional input and a Decimal output. It holds no edit Function, as [Ontology metadata](../functions/functions.md#ontology-metadata) specifies. Our rule.
- The Ontology SDK has one file for each Object Type and Action Type. Source: `@osdk/generator` example output.
- The Ontology SDK holds types and API-name constants only. Each runtime value holds only small constants, such as the entity kind, the API name, and the primary key name and type. Source: `@osdk/generator` example output.
- The CLI adds 1 module to the Ontology SDK after the OSDK generator runs: `ontology-service`, at the package export `./ontology-service`. The OSDK generated files do not change. Deviation: standard OSDK packages hold types and API-name constants only; Ontos adds `./ontology-service` for runtime lookup maps such as `$actionTypesByRid` and `$environments`.
- The `ontology-service` module exports `$actionTypesByRid`: for each Action Type RID, the generated Action constant and the Action Type display name. Object Edit History names each Action Type only by RID. Our rule.
- The `ontology-service` module exports `$environments`: for each environment of the deployment file, its `baseUrl` and its `workosClientId`. These values are not secret. Our rule.
- When `domain/index.ts` exists at the root of the [Ontology deployment repository](../../../GLOSSARY.md), the CLI also adds the package export `./domain`. It copies each `.ts` file under `domain/` other than `*.test.ts`, `*.test-utils.ts`, and `*.fixture.ts`. It compiles those files into `dist/domain/` with declarations and leaves the OSDK generated files unchanged. When `domain/index.ts` does not exist, the CLI adds no `./domain` export. Our rule.
- Each file in `domain/` can import only relative files inside `domain/` and type-only imports from `@osdk/client`. `generate-osdk`, `validate`, and `publish` refuse each other import. Refused imports include a relative path that leaves `domain/`, a non-peer package, a runtime import of `@osdk/client`, and a computed dynamic `import()`. Each refusal names the file and the specifier. [Functions](../functions/functions.md) in the same repository import `domain/` by relative path or through `@ontology/sdk/domain`. Our rule.
- The Ontology SDK of a product works with each Ontology of that product, in staging and in production, because each derived RID comes from the product RID. The consumer gets the Ontology RID from List Ontologies, and gives it to `createClient` at runtime. The generated `$ontologyRid` holds the product RID, and the consumer does not use it. Source: `generateMetadata.ts` (`$ontologyRid`).
- The OSDK generated Ontology SDK files hold no logic. The stock `@osdk/client` sends each read and each Action to the [Ontology service](../../service/ontology-service.md) over the OSDK HTTP API v2. Source: TypeScript OSDK migration.
- The Ontology SDK imports `@osdk/client` by its package name. Source: `@osdk/generator` example output.
- The app pins the exact `@osdk/client` and `@osdk/cli` versions of its [OSDK set](../../service/releases.md#osdk-sets). Our rule.
- `generate-osdk` writes the Ontology SDK to `<osdkOutput>/ontology/`, with the `osdkOutput` of `ontos.yml` (or optional `foundry.yml` fallback), with the package name `ontology`. It compiles the TypeScript into `dist/`, and the `package.json` exports `./dist/index.js` and `./dist/ontology-service.js`. Deviation: the local `package.json` omits `./experimental/ontology-metadata`, `dependencies`, `devDependencies`, and `peerDependencies` so it stays static.
- `generate-osdk` changes no file of the app outside `<osdkOutput>/ontology/`. The app's `package.json` keeps its exact pins. Our rule.
- The app adds the Ontology SDK as `@ontology/sdk` with a `file:` dependency on `<osdkOutput>/ontology/`. Deviation: npm has no `link:` protocol, so npm installs a `file:` dependency on a folder as a symlink. Our rule.
- npm needs a `package.json` in `<osdkOutput>/ontology/` before `npm ci` links the folder. Each CI job runs `npm ci` before `generate-osdk`. So the app commits the static `<osdkOutput>/ontology/package.json` and ignores every other file in `<osdkOutput>/ontology/`. `generate-osdk` writes the same static bytes to that `package.json`, so a run leaves the Git working tree clean. Our rule.
- The Ontology deployment repository does not commit the Ontology SDK. The CLI writes it on each run. Source: Ontology SDK overview ("without republishing an SDK version between each change").
- So each CI job that runs `ontos validate` or `ontos publish` runs `ontos generate-osdk` first. The CLI bundles the Functions against the Ontology SDK, and a new checkout has none. Our rule.
- Browser code and server code both use the Ontology SDK. Source: TypeScript OSDK migration. Only server code can call the Ontology service, as [Ontology service](../../service/ontology-service.md) specifies.
- The Object Set methods are in [Object Sets](./object-sets.md). The aggregation methods are in [Aggregations](./aggregations.md).

### Ontology SDK package

- The [Ontology deployment repository](../../../GLOSSARY.md) publishes the Ontology SDK as an npm package to the configured registry (`ONTOS_SDK_REGISTRY`, default `https://npm.pkg.github.com`, configurable to `https://registry.npmjs.org` or any npm-compatible registry) under the configured scope (`ONTOS_SDK_PACKAGE_SCOPE`, default `@ontos`, forming `<scope>/<app>-ontology-sdk`), so that each [consumer](../../../GLOSSARY.md) can install it. Source: Add OSDK to an existing TypeScript project. Our rule.
- After each publish to staging, `ontos publish` publishes 1 version of the package, with the dist-tag `staging`, when no version has the `ontologyHash` of the current Ontology version. When a version has it, `ontos publish` publishes none and moves no tag. So a run again after a lost response or a failed package publish adds the missing version. Our rule.
- Passing `ontos publish --skip-sdk-package` skips package publishing and tag updates (useful for local development or replays that do not release a new Ontology SDK package). Our rule.
- The version is `0.0.<n>`, where `<n>` is the GitHub run number of the workflow. GitHub numbers each run of a workflow once, so each version is new and higher, and no person sets it. Source: [Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables) (`GITHUB_RUN_NUMBER`: "A unique number for each run of a particular workflow in a repository").
- The `package.json` of the published Ontology SDK package declares each package of its [OSDK set](../../service/releases.md#osdk-sets) that the Ontology SDK imports as a peer dependency, at the exact version of that set. Today this is only `@osdk/client`. It has no `dependencies`, so a consumer installs the exact `@osdk/client` version that the SDK was generated for. Our rule.
- The `package.json` of each version holds `ontologyHash`, the SHA-256 of canonical JSON with object keys in sorted order. The 4 base parts are the Ontology metadata, the [OSDK set](../../service/releases.md#osdk-sets), the `ontology-service` module, and the `package.json` fields that the CLI writes. Those fields exclude the name, the version, and the hash. When `domain/index.ts` exists, the input adds the sorted relative paths and bytes of the collected `domain/` files. When `domain/index.ts` does not exist, the input holds only the 4 base parts. Our rule.
- The `ontology-service` module text holds the base URL and the WorkOS client ID of each environment. A change to 1 of these values or to `domain/` gives a new hash and a new version. That holds even when the Ontology metadata does not change. None of the parts has a random value, so the same inputs always give the same hash. Our rule.
- After a publish to production that passes, `ontos publish` moves the dist-tags `production` and `latest` to the version whose `ontologyHash` is the hash of the current Ontology version of production. A promote publishes no new version. When no version has that hash, `ontos publish` fails, and names the hash. Our rule.
- Only a production publish moves `latest`, because Dependabot takes the `latest` dist-tag as the version to update to. So a consumer gets a Dependabot pull request only for a production version. Our rule.
- An Ontology service deployment with no staging environment has no Ontology SDK package. Its `ontos publish` publishes no package and moves no tag. Our rule.
- The staging SDK and the production SDK of 1 Ontology change are the same package, because they have the same Ontology metadata and OSDK set. When staging and production run releases whose converters give different Ontology metadata, the hashes differ, and the production publish fails until both run 1 release. Our rule.
- Each branch of a consumer pins 1 exact version of the package, and the builds of that branch use it: `staging` pins the newest staging version, and `main` pins the version with the `production` tag. Our rule.
- The `main` branch of a consumer pins the version that has the `production` tag. The release job of the consumer refuses each other version, because a lower version can hold a part that production no longer serves, and a higher version can hold a part that production does not serve yet. After a promote, the consumer changes its pin to the new `production` version. Our rule.

## Out of scope

- SDKs for Python, Java, and the OpenAPI spec. Source: Ontology SDK overview.

## Related

- [Ontology service](../../service/ontology-service.md)
- [Ontology-as-code](../../service/ontology-as-code.md)
- [Object Sets](./object-sets.md)
- [Aggregations](./aggregations.md)
