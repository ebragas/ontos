# The twin test Ontology and its IRs

- `ontology/<version>/ontology.ts` defines a version of Ontos's self-contained synthetic test Ontology.
- `ir/<version>.json` is the IR that `@osdk/maker` generates from it. Do not edit an IR by hand. Run the command below again.
- `ontology/<version>/grants.json` holds the grants file for that version: the 7 permissions of the test Ontology, the permission of each type, and the default roles `admin` and `member`. `admin` holds `ontology:install` and each permission of the test Ontology. `member` holds `accounts:read`, `accounts:write`, `engagements:read`, and `probes:read`. `twinGrants(version)` in `packages/service/src/ontology/stored.test-utils.ts` reads it with 1 parser.

## Versions

| Version | Entities                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------- |
| 0.4.0   | `Account`, `Engagement`, their Link Type, rule-backed Action Types, and `closeAccount`             |
| 0.6.3   | Adds `StructProbe`, struct Properties, and the `setRelationship` and `probeVersionCheck` Functions |
| 0.7.0   | Adds schema evolution coverage on top of 0.6.3                                                     |

The base twin files keep Object Edit History off. Tests that exercise edit history enable it on their own copy of the Ontology.

## Generate an IR

Use `@osdk/maker` 0.91.0 and `@osdk/maker-experimental` 0.87.0 from the OSDK set `client-2.92.0` in `packages/service/osdk-sets.json` (installed in root `devDependencies`). Node 24+ loads the `.ts` input with no loader.

Run this command from the repository root. Replace `0.4.0` with the target version.

```sh
npx maker --input packages/service/twin/ontology/0.4.0/ontology.ts --output packages/service/twin/ir/0.4.0.json --apiNamespace com.example.twin.
```

- `--apiNamespace com.example.twin.` applies the `com.example.twin.` API namespace to the generated IR.
- Repeated runs of the command give the same file for each version. `@osdk/maker` writes a random `linkId` only for a `uuid` mapping with no `linkId`, and the test Ontology has no such mapping.
- The IR of a function-backed Action has a placeholder `functionRule` and no parameters. The parameters come from the Function metadata.

## Additional test IRs

- `ontology/policies/ontology.ts` (`ir/policies.json`): twin 0.6.3 with the object security policy `own` on `Account`, 2 additional `Account` Properties, and the many-to-many Link Type `engagementPartners`.
- `ontology/property-policies/ontology.ts` (`ir/property-policies.json`): the policies Ontology with property security policies `pay` and `ops` on `Account`, the group `plain` with no policy, and the object security policy `staff` plus property security policy `deal` on `Engagement`.
- `ontology/attributes/ontology.ts` (`ir/attributes.json`): `CrewMember`, `Crew`, and `Jobsite`, with policies that read the Person attributes `jobsiteIds` and `memberIds`.
- `ontology/jobsite/ontology.ts` (`ir/jobsite.json`): the policy test Ontology of [Testing: Policy twin](../../../docs/service/testing.md#policy-twin), adding `DailyLog`, `Jobsite.budget`, Object Edit History on `Jobsite` and `DailyLog`, `create-daily-log` (with `user` parameter `authorId`), and `edit-jobsite`. `seed/jobsite.ts` holds its people, grants file, and seed data.
- `ontology/value-types/ontology.ts` (`ir/value-types.json`): `Task` with 3 value types on 3 Properties: the String enum `taskStatus` on `status`, the deprecated Decimal range `money` on `budget`, and the array `tags` on `labels`.
- `ontology/derived/ontology.ts` (`ir/derived.json`): Object Types for derived property tests (`Balance`, counts, `Invoice`, `Account`, and `Transaction`).
- `ontology/uniqueness/ontology.ts` (`ir/uniqueness.json`): the 2 Object Types of [Properties: Uniqueness constraints](../../../docs/ontology/object-link-types/properties.md#uniqueness-constraints), `Invoice` (`invoiceNumber` and `numberPerYear`) and `Membership` (`onePersonPerRole`).

Regenerate any additional IR from the repository root with the same `npx maker` command, substituting its directory name:

```sh
npx maker --input packages/service/twin/ontology/<name>/ontology.ts --output packages/service/twin/ir/<name>.json --apiNamespace com.example.twin.
```

## The twin Functions

`functions/0.4.0.json` and `functions/0.4.0.bundle.js` hold the discovered Function metadata and Function bundle for version 0.4.0. `functions/0.6.3.json` and `functions/0.6.3.bundle.js` hold the discovered Function metadata and Function bundle shared by 0.6.3 and 0.7.0. `twinFunctions()` in `packages/service/src/ontology/stored.test-utils.ts` joins the JSON and the bundle of a version into `PublishedFunctions`.

| Function            | Versions            | Purpose                                                                     |
| ------------------- | ------------------- | --------------------------------------------------------------------------- |
| `closeAccount`      | 0.4.0, 0.6.3, 0.7.0 | Edits `Account` and `Engagement` and exercises `UserFacingError` handling   |
| `setRelationship`   | 0.6.3, 0.7.0        | Edits `StructProbe` struct Properties and exercises runtime edit validation |
| `probeVersionCheck` | 0.6.3, 0.7.0        | Exercises Function reads, edits, and version conflict handling              |

- `editedLinks` is `{}` for each twin Function because no twin `Edits` type edits a Link. Keys in `editedLinks` use Link Type API names, as [Functions: Discovery](../../../docs/ontology/functions/functions.md#discovery) describes.

## Generate a Function bundle

- `functions/src/` holds the synthetic TypeScript source of each twin Function. Each file imports `functions/src/sdk.ts`, a small stand-in for a generated Ontology SDK.
- `functions/bundle.ts` bundles the Functions of each version with esbuild 0.28.2, `@osdk/client` 2.92.0, and `@osdk/functions` 1.30.0. The bundle exports `functions`, a map from each API name to its Function, and `createClient`. The 0.4.0 bundle holds `closeAccount`. The 0.6.3 bundle holds all 3 Functions.
- Each bundle holds no runtime imports, so it loads from its text alone. The script uses the `browser` builds, which use the global `fetch`. `@osdk/functions` re-exports `@osdk/aliases`, whose browser build references `fs`; no twin Function uses an alias, so esbuild tree-shakes it away and the script fails if any import remains.

Run this command from the repository root after any change to `functions/src/` or its bundled dependencies:

```sh
node packages/service/twin/functions/bundle.ts
```

2 runs of the command produce identical files. `functions/bundle.test.ts` checks that each committed bundle matches the output of the script. Third-party license notices for the bundled dependencies live in root `NOTICE` and `THIRD_PARTY_NOTICES.md`.
