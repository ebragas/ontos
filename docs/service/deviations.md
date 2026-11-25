---
status: specified
---

# Deviations

This document lists intentional behavioral differences between Ontos and upstream `@osdk/*` defaults or conventions. Read the list before a design starts. Each item links to the rule that holds it.

## Contract

### Modeling

- An Object Type has at most 1,500 Properties, where OSDK docs state 2,000. See [Parts](../ontology/object-link-types/object-types.md#parts).
- An Object Type API name has no dot in its part, and its part starts with an uppercase letter, where `@osdk/maker` accepts both. See [API names](../ontology/object-link-types/object-types.md#api-names).
- An Action Type API name has no dot, where `@osdk/maker` accepts one. See [API names](../ontology/action-types/action-types.md#api-names).
- A string value has at most 1,000,000 bytes, where OSDK docs state 12 MB. See [Value rules on write](../ontology/object-link-types/properties.md#value-rules-on-write).
- A Function edit with an unknown struct field fails strictly rather than dropping the unknown field. See [Value rules on write](../ontology/object-link-types/properties.md#value-rules-on-write).
- Publish refuses marking properties that `@osdk/maker` defines. See [Contract](./ontology-as-code.md#contract).
- A rule-backed Action writes a Decimal struct field. See [Structs](../ontology/object-link-types/properties.md#structs).
- A value type holds more than 1 constraint. See [Constraints](../ontology/object-link-types/value-types.md#constraints).
- The version of a value type is a label, and a publish can change the constraints of a version. See [Declaration](../ontology/object-link-types/value-types.md#declaration).
- A publish that sets or changes a value type fails on bad stored values immediately in the publish transaction. See [Check at publish](../ontology/object-link-types/value-types.md#check-at-publish).
- The Ontology service supports derived aggregations on a Decimal Property of an Object Type, whereas `@osdk/maker` 0.91.0 refuses them inside `defineObject`. See [Forms](../ontology/object-link-types/derived-properties.md#forms) and [OSDK workarounds](./osdk-workarounds.md).
- A count and a distinct count of a derived property give Integer, where OSDK gives Long. See [Types](../ontology/object-link-types/derived-properties.md#types).
- A derived `sum` of an Integer gives Double, where OSDK gives Long. See [Types](../ontology/object-link-types/derived-properties.md#types).
- A derived `avg` of a Decimal gives a Decimal with the scale of the Property, where OSDK gives Double. See [Types](../ontology/object-link-types/derived-properties.md#types).
- A derived `approximatePercentile` gives Double, where OSDK gives the type of the source. See [Types](../ontology/object-link-types/derived-properties.md#types).
- A derived `sum` of a Decimal keeps the scale of the Property. See [Types](../ontology/object-link-types/derived-properties.md#types).
- A type class with the kind `unique` defines a Uniqueness constraint. See [Uniqueness constraints](../ontology/object-link-types/properties.md#uniqueness-constraints).
- Each Object Type uses a generated ID as its primary key. See [Object Types](../ontology/design-rules.md#object-types).

### Action parameters

- The Ontology metadata returns the fields of a struct and of a struct list in declaration order. See [Parameters](../ontology/action-types/action-types.md#parameters).
- A `VALIDATE_ONLY` apply with a `null` list gets 400 `ApplyActionFailed`, not 500. See [Parameters](../ontology/action-types/action-types.md#parameters).
- A struct list above 10,000 rows gets an `array` constraint with no entries. See [Parameters](../ontology/action-types/action-types.md#parameters).
- An Action edits at most 10,000 Objects. See [Apply](../ontology/action-types/action-types.md#apply).

### Function-backed Actions

- A Function `config` `apiName` that does not match the file name stops `validate` and `publish`. See [Code](../ontology/functions/functions.md#code).
- A parameter gets allowed values from string literals in the Function signature. See [Function-backed Actions](../ontology/functions/functions.md#function-backed-actions).
- A `VALIDATE_ONLY` apply runs the Function, compiles its edits, and checks each Object that an edit changes. See [Function-backed Actions](../ontology/functions/functions.md#function-backed-actions).
- The Ontology metadata lists only Query Functions as query types. See [Ontology metadata](../ontology/functions/query-functions.md#ontology-metadata) of Query Functions.
- A Query Function has no `config` export; its file name is its API name. See [Code](../ontology/functions/query-functions.md#code).
- The Query Function route runs only the current Ontology version. See [Run](../ontology/functions/query-functions.md#run).
- An `InvalidQueryOutputValue` error holds no `outputValue`, where `@osdk/foundry.ontologies` lists it. See [Errors](../ontology/functions/query-functions.md#errors).
- Discovered Functions key each `editedLinks` entry by the Link Type API name, not by the RID. See [Discovery](../ontology/functions/functions.md#discovery).
- A `FunctionEncounteredUserFacingError` can include `parameterId`, where OSDK has only `functionRid`, `functionVersion`, and `message`. See [Errors](../ontology/functions/functions.md#errors).
- A Function error omits `stacktrace` to avoid leaking runtime internals. See [Errors](../ontology/functions/functions.md#errors).
- A TypeScript Function takes a `Decimal` input, a branded string that the app declares, where `@osdk/functions` has no `Decimal` type. See [Discovery](../ontology/functions/functions.md#discovery).
- A struct list Function input supports a `Decimal` field. See [Discovery](../ontology/functions/functions.md#discovery).
- The Ontology service refuses a Function edit that violates a value type constraint. See [Checks on write](../ontology/object-link-types/value-types.md#checks-on-write).

### Reads

- A text search on a Property that is not Searchable gets 400 `PropertiesNotSearchable`. See [Searchable](../ontology/object-link-types/properties.md#searchable).
- `min`, `max`, `sum`, or `avg` on a String gets 400, not 500. See [Metrics](../ontology/ontology-sdk/aggregations.md#metrics).
- A `sum`, `avg`, `min`, or `max` of a Decimal is an exact string, where OSDK types numeric metrics as doubles. See [Metrics](../ontology/ontology-sdk/aggregations.md#metrics).
- A `duration` group-by returns only ranges that have Objects, omitting empty ranges between them. See [Group-bys](../ontology/ontology-sdk/aggregations.md#group-bys).
- A `where` clause on an unknown struct field gets 404 `PropertiesNotFound`, not 500. See [Where clauses](../ontology/ontology-sdk/object-sets.md#where-clauses).
- Text search runs as a PostgreSQL filter using `pg_trgm` rather than an external Lucene index. See [Text search](../ontology/ontology-sdk/object-sets.md#text-search).
- A text search gets 400 when the text search queries of 1 Object Set have more than 16 words in all, or 1 value has more than 256 characters. See [Text search](../ontology/ontology-sdk/object-sets.md#text-search).
- The service ignores `snapshot` when it pages, where OSDK documents a consistent snapshot view when `snapshot` is true. See [Paging](../ontology/ontology-sdk/object-sets.md#paging).
- A deployment setting (`ONTOLOGY_LOAD_DERIVED_PROPERTIES`) returns each Object Type derived property to a load with no `select`. See [Reads](../ontology/object-link-types/derived-properties.md#reads).

### Permissions

- Agents on the Ontology MCP get each type that the person's permissions open. See [Agents](../ontology/design-rules.md#agents).
- Each Object Type and Action Type names 1 permission in the grants file. See [Permissions](../ontology/design-rules.md#permissions).
- A Person attribute comes from Objects, not from the identity provider. See [Permissions](../ontology/design-rules.md#permissions).
- A policy reads a group name as a permission slug, not as a group UUID. See [Conditions](../ontology/object-security-policies.md#conditions).
- Equals compares 2 sets, where OSDK requires 1 value on each side. See [Conditions](../ontology/object-security-policies.md#conditions).
- Publish refuses `not` in a policy. See [Conditions](../ontology/object-security-policies.md#conditions).

### Object Edit History

- A create entry omits keys for Properties with no value. See [Entries](../ontology/object-edits/edit-history.md#entries).
- The history of a deleted Object stays readable. See [Keeping](../ontology/object-edits/edit-history.md#keeping).

### Ontology SDK

- The OSDK generator runs on the metadata produced by the service's own converter. See [Contract](../ontology/ontology-sdk/ontology-sdk.md#contract).
- The Ontology SDK includes 1 extra module, `ontology-service`, alongside types and API-name constants. See [Contract](../ontology/ontology-sdk/ontology-sdk.md#contract).
- The `package.json` of the Ontology SDK omits `./experimental/ontology-metadata`. See [Contract](../ontology/ontology-sdk/ontology-sdk.md#contract).
- Local development links the Ontology SDK with a `file:` dependency. See [Contract](../ontology/ontology-sdk/ontology-sdk.md#contract).
- The Ontology SDK publishes to a configurable npm registry (`ONTOS_SDK_REGISTRY`, defaulting to `https://npm.pkg.github.com`, configurable to `https://registry.npmjs.org` or any npm-compatible registry) under a configurable scope (`ONTOS_SDK_PACKAGE_SCOPE`, defaulting to `@ontos`). See [Ontology SDK package](../ontology/ontology-sdk/ontology-sdk.md#ontology-sdk-package).
- The Ontology SDK declares the exact `@osdk/client` of its OSDK set as a peer dependency. See [Ontology SDK package](../ontology/ontology-sdk/ontology-sdk.md#ontology-sdk-package).

### Clients

- The `{ontology}` path segment takes only the Ontology RID, not the API name. See [Requests](./http-api.md#requests).
- The `ontology` block of `fullMetadata` returns an empty `description` (`""`). See [Metadata routes](./http-api.md#metadata-routes).
- A 404 `ActionTypeNotFound` can add `publishedApiName`, where OSDK sends only `actionType`. See [Errors](./http-api.md#errors).
- A write that breaks a Uniqueness constraint gets 409 `PropertyValueAlreadyExists`. See [Uniqueness constraints](../ontology/object-link-types/properties.md#uniqueness-constraints).
- The `DELETED` status of the users routes means a former member of the Organization, not a deleted user. See [User IDs](./authentication.md#user-ids).
- A `User` holds the configured identity provider user ID and email. See [User IDs](./authentication.md#user-ids).
- A GitHub CI caller gets no `User` from `Users.getCurrent`. See [User IDs](./authentication.md#user-ids).

### Operations

- Operators inspect logs, OpenTelemetry traces, and fault reports in their configured observability stack rather than built-in monitoring dashboards. See [Scope](./observability.md#scope).
- The `ontos` CLI runs `@osdk/maker` and sends the IR directly to the publish route. See [Inputs](./cli.md#inputs).
- Installing an Ontology uses `POST /api/ontology-service/v1/ontologies` outside the OSDK HTTP API v2. See [Install](./publish.md#install).

## Related

- [Out of scope](./out-of-scope.md)
- [Ontology design rules](../ontology/design-rules.md)
