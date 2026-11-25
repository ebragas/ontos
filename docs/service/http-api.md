---
status: specified
---

# HTTP API

The HTTP API is the OSDK-compatible REST surface that the [Ontology service](./ontology-service.md) serves. App code calls it through the stock `@osdk/client`, and the [CLI](./cli.md) calls it through `@osdk/foundry.ontologies`.

## Contract

### Routes

- The Ontology service serves these OSDK v2 HTTP routes:

| Route                                                                 | Method | Caller                                                                                         | Specified in                                                                                         |
| --------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/api/v2/ontologies`                                                  | GET    | The CLI, the Ontology MCP, and a consumer, to find the Ontologies of the caller's Organization | [Organizations](./authentication.md#organizations)                                                   |
| `/api/v2/ontologies/{ontology}/fullMetadata`                          | GET    | The [CLI](./cli.md), for the whole Ontology metadata of the current Ontology version           | [Publish](./publish.md)                                                                              |
| `/api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata` | GET    | The client, for the metadata of each Object Type that it reads                                 | [Properties](../ontology/object-link-types/properties.md#ontology-metadata), [Publish](./publish.md) |
| `/api/v2/ontologies/{ontology}/actionTypes/{actionType}`              | GET    | The client, before the first apply of an Action Type                                           | [Action Types](../ontology/action-types/action-types.md)                                             |
| `/api/v2/ontologies/{ontology}/objectSets/loadObjects`                | POST   | The client: `fetchPage`, `fetchOne`, `asyncIter`, `$link`, and `pivotTo`                       | [Object Sets](../ontology/ontology-sdk/object-sets.md)                                               |
| `/api/v2/ontologies/{ontology}/objectSets/aggregate`                  | POST   | The client: `aggregate`                                                                        | [Aggregations](../ontology/ontology-sdk/aggregations.md)                                             |
| `/api/v2/ontologies/{ontology}/actions/{action}/apply`                | POST   | The client: `applyAction`                                                                      | [Action Types](../ontology/action-types/action-types.md#apply)                                       |
| `/api/v2/ontologies/{ontology}/actions/{action}/applyBatch`           | POST   | The client: `batchApplyAction`                                                                 | [Action Types](../ontology/action-types/action-types.md#out-of-scope)                                |
| `/api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory` | POST   | The CLI, and app server code, through `@osdk/foundry.ontologies`                               | [Object Edit History](../ontology/object-edits/edit-history.md)                                      |
| `/api/v2/ontologies/{ontology}/objectTypes`                           | GET    | App server code and generic UIs, through `@osdk/foundry.ontologies`                            | [Metadata routes](#metadata-routes)                                                                  |
| `/api/v2/ontologies/{ontology}/objectTypes/{objectType}`              | GET    | Same                                                                                           | [Metadata routes](#metadata-routes)                                                                  |
| `/api/v2/ontologies/{ontology}/actionTypes`                           | GET    | Same                                                                                           | [Metadata routes](#metadata-routes)                                                                  |
| `/api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}`     | GET    | Same                                                                                           | [Metadata routes](#metadata-routes)                                                                  |
| `/api/v2/ontologies/{ontology}/queryTypes`                            | GET    | Same                                                                                           | [Metadata routes](#metadata-routes)                                                                  |
| `/api/v2/ontologies/{ontology}/queryTypes/{queryApiName}`             | GET    | The client, and app server code                                                                | [Metadata routes](#metadata-routes)                                                                  |
| `/api/v2/ontologies/{ontology}/queries/{queryApiName}/execute`        | POST   | The client: `executeFunction`                                                                  | [Query Functions](../ontology/functions/query-functions.md#run)                                      |
| `/api/v2/admin/users/{userId}`                                        | GET    | The CLI and app server code, through `@osdk/foundry.admin`                                     | [Authentication](./authentication.md#user-ids)                                                       |
| `/api/v2/admin/users/getBatch`                                        | POST   | Same                                                                                           | [Authentication](./authentication.md#user-ids)                                                       |
| `/api/v2/admin/users/getCurrent`                                      | GET    | App server code and test harnesses, through `@osdk/foundry.admin`                              | [Authentication](./authentication.md#user-ids)                                                       |

- Each other route gets HTTP 404 with an empty body.

### Requests

- The `{ontology}` path segment is the Ontology RID of an Ontology that the caller's Organization owns, as [Organizations](./authentication.md#organizations) specifies. Any other value gets 404 `OntologyNotFound`. The service accepts only the RID, because every caller gets the RID from List Ontologies and sends it.
- The `{actionType}` and `{action}` path segments take the published Action Type API name, such as `com.example.crm.edit-company`. The Ontology SDK constant holds it in `unsanitizedApiName`. Its camelCase `apiName`, such as `com.example.crm.editCompany`, gets 404 `ActionTypeNotFound`. The stock client sends the published name. A direct call with `@osdk/foundry.ontologies`, such as `ActionTypesV2.get`, must pass `unsanitizedApiName`.
- The `fullMetadata` routes ignore the `preview` query parameter and return the same response whether `preview` is omitted, `true`, or `false`.
- A request with a `branch`, `transactionId`, or `scenarioRid` query parameter gets 400 `Default:InvalidArgument`, because the Ontology service has no branches, transactions, or scenarios.
- A Decimal in a request is a JSON string or a JSON number, as [Properties](../ontology/object-link-types/properties.md#base-types) specifies. Each Decimal in an answer is a JSON string, never a JSON number. This holds for `loadObjects`, each `sum`, `avg`, `min`, and `max` of `aggregate`, and Object Edit History, for a Decimal Property, an array element, and a struct field.
- On serverless deployments with a 4.5 MB request body cap (such as Vercel Functions), a larger request gets the host's 413 error rather than the Ontology API error shape.
- The Ontology service streams each `loadObjects`, `aggregate`, and `editsHistory` response, so buffered response size limits do not apply to these responses. A page can always hold 1 Object, whatever its size.
- The Ontology service does not stream the answer of an apply, so buffered response size limits apply to it. [Bulk writes](../ontology/functions/edit-functions.md#bulk-writes) gives the size of a large validation answer.

### Metadata routes

- List Ontologies gives `data`: the `OntologyV2` of each Ontology that the caller's Organization owns, with its `rid`, `apiName`, `displayName`, and `description`, in the code point order of their API names. It has no pages. Source: `ListOntologiesV2Response` of `@osdk/foundry.ontologies` 2.87.0.
- `fullMetadata` gives, in its `ontology` block, the `rid`, `apiName`, `displayName`, and `description` of the List Ontologies entry of that Ontology. The Ontology service has no Ontology description, so both routes give `""`.
- `objectTypes` lists the `ObjectTypeV2` of each Object Type of the current Ontology version, in the code point order of their API names. Source: `ObjectTypeV2.list` of `@osdk/foundry.ontologies` 2.87.0.
- `actionTypes` lists the `ActionTypeV2` of each Action Type of the current Ontology version, in the code point order of their API names. Source: `ActionTypeV2.list` of `@osdk/foundry.ontologies` 2.87.0.
- Each list of Object Types and Action Types takes `pageSize` and `pageToken`. The default and the maximum `pageSize` are 500, and a larger `pageSize` gets pages of 500.
- A `pageSize` that is not an integer gets 400 `Default:InvalidArgument`, with `parameters: {}`. A `pageSize` of 0 or less gets 400 `InvalidPageSize`, as [Errors](#errors) specifies.
- A page token holds the API name of the last entry of its page. A token that the Ontology service cannot read gets 400 `InvalidPageToken`, with `pageToken`. Source for the parameter: `InvalidPageToken` of `@osdk/foundry.core` 2.87.0.
- `objectTypes/{objectType}` gives the `ObjectTypeV2` of that Object Type. An unknown Object Type gets 404 `ObjectTypeNotFound`, with `objectType`.
- `actionTypes/byRid/{actionTypeRid}` gives the `ActionTypeV2` of the Action Type with that RID. An unknown RID gets 404 `ActionTypeNotFound`, with `rid`. Source for the parameters: `ActionTypeNotFound` of `@osdk/foundry.ontologies` 2.87.0.
- `queryTypes` lists the `QueryTypeV2` of each [Query Function](../ontology/functions/query-functions.md#ontology-metadata) of the caller's view, in the code point order of their API names. It takes `pageSize` and `pageToken`, with a default and maximum `pageSize` of 100.
- `queryTypes/{queryApiName}` gives the `QueryTypeV2` of that Query Function. An unknown name, a Query Function that the caller cannot see, and an edit Function get 404 `QueryNotFound`, with `query`. A `version` other than the `version` of the `QueryTypeV2`, as [Query Functions](../ontology/functions/query-functions.md#ontology-metadata) specifies, gets 404 `QueryVersionNotFound`, with `apiName` and `version`. An unknown or hidden name gets `QueryNotFound` first. No `version` gives the `QueryTypeV2`. Source: `_errors.d.ts` of `@osdk/foundry.ontologies` 2.87.0.
- The Object Type routes ignore `includeDatasources`. Each `datasources` list is empty, as in `fullMetadata`, except for an Object Type with a derived property, as [Derived properties](../ontology/object-link-types/derived-properties.md#ontology-metadata) specifies.

### Errors

- An error body has the OSDK API fields: `errorCode`, `errorName`, `errorInstanceId`, and `parameters`. It has no `message` field.
- A type that the permissions of the caller do not open gets the error of an unknown type, as [Access](./authentication.md#access) specifies.
- The HTTP API returns these error shapes:

| Case                                                                                                                    | Status | `errorName`                          | `parameters`                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| An unknown Ontology                                                                                                     | 404    | `OntologyNotFound`                   | `ontologyRid`. A tool error of the [Ontology MCP](./ontology-mcp.md#errors) gives `apiName` and `ontologies`                       |
| An unknown Object Type                                                                                                  | 404    | `ObjectTypeNotFound`                 | `objectType`                                                                                                                       |
| An unknown Action Type                                                                                                  | 404    | `ActionTypeNotFound`                 | `actionType`                                                                                                                       |
| A `where` on an unknown Property or struct field                                                                        | 404    | `PropertiesNotFound`                 | `objectType`, `properties`                                                                                                         |
| A `pageSize` of 0 or less                                                                                               | 400    | `InvalidPageSize`                    | `pageSize`                                                                                                                         |
| A `duration` group with `weeks`, `months`, `quarters`, or `years` and a value other than 1                              | 400    | `InvalidDurationGroupByValue`        | `{}`                                                                                                                               |
| A parameter value of the wrong type                                                                                     | 400    | `InvalidParameterValue`              | `parameterBaseType` (for example `String`), `parameterId`, `parameterValue`                                                        |
| An Object parameter value that is not of the base type of the primary key                                               | 400    | `InvalidPropertyValue`               | `propertyBaseType` (for example `String`), `property` (the primary key Property), `propertyValue`                                  |
| An unknown parameter                                                                                                    | 400    | `ParametersNotFound`                 | `actionType`, `unknownParameterIds`, `configuredParameterIds`                                                                      |
| The Object of an Object parameter of a rule-backed Action does not exist                                                | 404    | `ObjectNotFound`                     | `primaryKey: {}`                                                                                                                   |
| A create with no primary key value                                                                                      | 400    | `ApplyActionFailed`                  | `originalErrorName: "Ontos:InvalidPrimaryKeyPropertyType"`, `userErrorMessage`, `builderErrorMessage`                              |
| A `null` value for a list parameter                                                                                     | 400    | `ApplyActionFailed`                  | `originalErrorName: "Ontos:SingletonValueForListParameter"`, `userErrorMessage`, `builderErrorMessage`                             |
| An edit Function writes a value of the wrong type, such as a bad struct field value                                     | 400    | `ApplyActionFailed`                  | `originalErrorName: "Ontos:InvalidActionPropertyFormat"`, `userErrorMessage`, `builderErrorMessage`                                |
| An edit Function returns a create of 1 Object after its create or its update, or a create or an update after its delete | 400    | `ApplyActionFailed`                  | `originalErrorName: "Ontos:UnsupportedEditSequence"`, `userErrorMessage`, `builderErrorMessage`                                    |
| A create with a primary key that exists                                                                                 | 409    | `ObjectAlreadyExists`                | `{}`                                                                                                                               |
| A checked Object version changed in the last attempt of the Action, as [Storage](./storage.md#writes) specifies         | 409    | `ObjectChanged`                      | `{}`                                                                                                                               |
| A Function throws an `Error`                                                                                            | 400    | `FunctionExecutionFailed`            | `functionRid`, `functionVersion`, `message`. The Ontology service sends no `stacktrace`.                                           |
| A Function throws a `UserFacingError`                                                                                   | 400    | `FunctionEncounteredUserFacingError` | `functionRid`, `functionVersion`, `message`, and `parameterId` as [Functions](../ontology/functions/functions.md#errors) specifies |
| The Object of an Object parameter of a function-backed Action does not exist                                            | 400    | `FunctionExecutionFailed`            | `functionRid`, `functionVersion`, `message: "Object not found"`. The Ontology service sends no `stacktrace`.                       |

- An Object that the [security policies](../ontology/object-security-policies.md) hide from the caller gets the same answer as a missing Object, on each route of this table. [Hidden Objects](../ontology/object-security-policies.md#hidden-objects) gives the 2 exceptions.
- When an `{actionType}` or `{action}` path segment misses, and it equals the camelCase `apiName` of an Action Type, with or without the API namespace, the 404 `ActionTypeNotFound` also has `publishedApiName`: the published name of that Action Type. The camelCase rule is `camelize` of `@osdk/generator` 2.92.0.
- Two errors carry the reason in `parameters.message`: `FunctionEncounteredUserFacingError` and `FunctionExecutionFailed`. An app that shows the reason of a failed Action reads `parameters.message` for both.
- A `loadObjects` filter that matches no Object gets 200 with `data: []`, not an error. So `fetchOne` of a missing primary key throws in the client, not in the Ontology service, as [Object Sets](../ontology/ontology-sdk/object-sets.md#paging) specifies.
- An edit Function value that breaks any [value rule](../ontology/object-link-types/properties.md#value-rules-on-write), such as an unknown struct field or `""`, gets 400 `ApplyActionFailed` with `originalErrorName: "Ontos:InvalidActionPropertyFormat"`.
- A value of a rule-backed Action that breaks any value rule, such as `""`, gets the same error.
- The `parameters` of that error also hold `objectType` and `property`. `property` is the Property API name, or the struct field path such as `relationship.since`. `userErrorMessage` is `"The Action could not apply because a Property value is invalid."`. `builderErrorMessage` names the rule that the value breaks.
- For a value of a Function edit, `builderErrorMessage` is `"The Function assigned a value whose type does not match the Property."`.
- [Functions](../ontology/functions/functions.md#errors) specifies each Function error, and the errors for the time limit and the heap limit.
- A text search query on a Property that is not [Searchable](../ontology/object-link-types/properties.md#searchable) gets 400 `PropertiesNotSearchable`, with `propertyApiNames`.
- `min`, `max`, `sum`, or `avg` on a String Property gets 400 `Default:InvalidArgument`, with `parameters: { metric, property, propertyBaseType }`, for example `{ metric: "min", property: "name", propertyBaseType: "String" }`.
- A request derived property gets these errors, and the Ontology service reads no data for each of them. [Derived properties](../ontology/object-link-types/derived-properties.md) specifies each case. Source: `_errors.d.ts` of `@osdk/foundry.ontologies` 2.87.0 for the names and the parameters.

| Case                                                             | Status | `errorName`                             | `parameters`                            |
| ---------------------------------------------------------------- | ------ | --------------------------------------- | --------------------------------------- |
| A definition with a wrong shape or type                          | 400    | `InvalidDerivedPropertyDefinition`      | `objectType`, `derivedProperty`         |
| A name that the Object Set already has, or that repeats          | 400    | `DerivedPropertyApiNamesNotUnique`      | `derivedPropertyApiNames`               |
| A collect `limit` below 1 or over 100                            | 400    | `InvalidDerivedPropertyCollectionLimit` | `limit`, `minLimit: 1`, `maxLimit: 100` |
| A `methodInput` outside a `selection`                            | 400    | `Default:InvalidArgument`               | `{ feature: "methodInput" }`            |
| An unknown or hidden Link side in a hop, as for a `searchAround` | 404    | `LinkTypeNotFound`                      | `objectType`, `linkType`                |

- A filter that is out of scope gets 400 `PropertyFiltersNotSupported`, with `property` and `propertyFilters`.
- Any other feature that is out of scope gets 400 `Default:InvalidArgument`, with `parameters: { feature }` that names the feature.
- A request body that is not JSON gets 400 `Default:InvalidArgument`, with `parameters: {}`. The Ontology service reads the body after the token check, so a request with no valid token gets the token error first.
- A write that breaks a [Uniqueness constraint](../ontology/object-link-types/properties.md#uniqueness-constraints) gets 409 `PropertyValueAlreadyExists`, with `errorCode: "CONFLICT"` and `parameters: { objectType, constraint, properties }`.
- An apply past its deadline gets 400 `ActionDeadlineExceeded`, with `parameters: {}`, as [Storage](./storage.md#writes) specifies.
- A fault of the Ontology service, such as a database error, gets 500 `Default:Internal`.
- A fault after the first byte of a streamed answer, such as a lost database connection, ends the body with a network error. The client gets status 200 and no complete body, and can send the same request again.
- [Authentication](./authentication.md) specifies the errors for a missing or bad token.

### RIDs

- Each RID follows the OSDK resource identifier format (`ri.<service>.<instance>.<type>.<UUID>`):

| Resource                                                                                                                        | Form                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Ontology                                                                                                                        | `ri.ontology.main.ontology.<UUID>`, which [install](./publish.md#install) makes |
| Object Type                                                                                                                     | `ri.ontology.main.object-type.<UUID>`                                           |
| Property                                                                                                                        | `ri.ontology.main.property.<UUID>`                                              |
| Datasource of the [derived properties](../ontology/object-link-types/derived-properties.md#ontology-metadata) of an Object Type | `ri.ontology.main.datasource.<UUID>`, with the UUID of the Object Type RID      |
| Link Type                                                                                                                       | `ri.ontology.main.relation.<UUID>`, the same on both sides                      |
| Action Type                                                                                                                     | `ri.actions.main.action-type.<UUID>`                                            |
| Action                                                                                                                          | `ri.actions.main.action.<UUID>`                                                 |
| Function                                                                                                                        | `ri.function-registry.main.function.<UUID>`                                     |
| Object                                                                                                                          | `ri.phonograph2-objects.main.object.<UUID>`                                     |

- Each UUID except the Ontology's and the Action's is a UUID version 5. Its namespace is the UUID of the product RID of the [deployment file](./deployment.md#deployment-files). Its name is `object-type:<Object Type API name>`, `property:<Object Type API name>.<Property API name>`, `relation:<linkType.id in the IR>`, `action-type:<Action Type API name>`, `function:<Function API name>`, or `object:<Object Type API name>:<primary key>`. Source: [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-5).
- The UUID of an Action RID is a random UUID version 4, new for each Action. Source: [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-4).
- So each RID except an Action RID and the Ontology RID is the same in each environment, in each Ontology of the product, and on each publish, and the committed [Ontology SDK](../ontology/ontology-sdk/ontology-sdk.md) does not change. API names never change, as the [design rules](../ontology/design-rules.md#schema-evolution) specify.

## Serves

- [Object Sets](../ontology/ontology-sdk/object-sets.md)
- [Aggregations](../ontology/ontology-sdk/aggregations.md)
- [Action Types](../ontology/action-types/action-types.md)
- [Object Edit History](../ontology/object-edits/edit-history.md)
- [Ontology SDK](../ontology/ontology-sdk/ontology-sdk.md)

## Related

- [Ontology service](./ontology-service.md)
- [Authentication](./authentication.md)
- [Publish](./publish.md)
