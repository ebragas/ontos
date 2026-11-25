---
status: specified
---

# Out of scope

The Ontology service leaves out each item of this list. Read the list before a design starts. Each item links to the rule that holds it. An item leaves the list when maintainers decide to build its feature.

## Contract

### Modeling

- Object Edit History entries for Link edits. See [Entries](../ontology/object-edits/edit-history.md#entries).
- Markings and Mandatory control Properties. See [Access](./authentication.md#access).
- Conditional overrides on an Action Type, and submission criteria that check the person beyond the 3 person values. See [Action Types](../ontology/action-types/action-types.md#out-of-scope) and [Submission criteria](../ontology/action-types/submission-criteria.md#out-of-scope).
- A struct Property that is an array. See [Structs](../ontology/object-link-types/properties.md#structs).
- The [Query Function](../ontology/functions/query-functions.md#outputs) outputs of an Object Set, a Map, a Set, a 2D or 3D aggregation, a Long, a Float, and an Interface. Each union other than `T | undefined` is out too. See [Query Functions](../ontology/functions/query-functions.md#out-of-scope).

### Function-backed Actions

- A required list input. See [Parameters](../ontology/action-types/action-types.md#parameters).
- Allowed values other than a union of string literals, a `required` override, and a list length. See [Function-backed Actions](../ontology/functions/functions.md#function-backed-actions) and [Functions](../ontology/functions/functions.md#out-of-scope).
- A struct list parameter of a rule-backed Action, and a field of a struct that is an Object reference, a struct, or a list. See [Action Types](../ontology/action-types/action-types.md#out-of-scope).
- A list of an inline object type as a Function input. The CLI writes a custom type only for a named TypeScript interface, which gives the same parameter shape. See [Action Types](../ontology/action-types/action-types.md#out-of-scope).

### Clients

- `batchApplyAction` (the `applyBatch` route). It gets 400 `Default:InvalidArgument`. See [Action Types](../ontology/action-types/action-types.md#out-of-scope).
- `$startsWith` as a prefix of the whole value. It matches the words of the query, in order and next to each other, starting at any word of the value, with the last word as a prefix. See [Text search](../ontology/ontology-sdk/object-sets.md#text-search).

### Not served

- The Ontology API name in the `{ontology}` path segment, and the `branch`, `transactionId`, and `scenarioRid` query parameters. See [Requests](./http-api.md#requests).
- `snapshot` paging: the Ontology service ignores it. See [Paging](../ontology/ontology-sdk/object-sets.md#paging).

### Operations

- Non-PostgreSQL storage backends. Ontos targets PostgreSQL 17, as [Storage](./storage.md) and [Deployment](./deployment.md#projects-and-environments) specify.
- A change or a removal of an Object Edit History entry. The history of a deleted Object stays. See [Keeping](../ontology/object-edits/edit-history.md#keeping).
- Custom roles of an Organization in v1.0. The product owns each default role, and the Ontology service creates no WorkOS custom role. See [Organizations](./authentication.md#organizations).

## Related

- [Releases](./releases.md#public-contract)
- [Scope](../ontology/README.md#scope)
