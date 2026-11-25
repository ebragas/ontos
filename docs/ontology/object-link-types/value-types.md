---
status: specified
---

# Value types

A value type is a named base type with constraints, which 1 or more Properties use. Each value of such a Property must pass each constraint. Source: Value types.

## Contract

### Declaration

- An app declares a value type with the stock `defineValueType` of `@osdk/maker`, and puts it on a Property with `valueType`. Source: `@osdk/maker`.

```ts
const taskStatus = defineValueType({
  apiName: 'taskStatus',
  displayName: 'Task status',
  version: '1.1.0',
  type: {
    type: 'string',
    constraints: [
      {
        constraint: { type: 'oneOf', oneOf: { values: ['open', 'done'], useIgnoreCase: false } },
        failureMessage: { message: 'Use open or done.' },
      },
    ],
  },
});
defineObject({ apiName: 'Task', /* ... */ properties: { status: { type: 'string', valueType: taskStatus } } });
```

- The IR holds each value type in `valueTypes.valueTypes`, as `{ metadata, versions }`. A Property names its value type in `valueType`, and holds a copy of its constraints in `dataConstraints.propertyTypeConstraints`. Source: `@osdk/maker`.
- A value type has an API name, a display name, an optional description, a version, a status, a base type, and a list of constraints. Each constraint has an optional failure message. Source: `@osdk/maker`.
- The base type of a value type is String, Boolean, Integer, Double, Decimal, Date, Timestamp, or an array of 1 of them. A Decimal value type has no precision and no scale. Its Property has them, as [Properties](./properties.md#base-types) specifies. Our rule.
- The base type of a Property is the base type of its value type. An array Property takes only an array value type, and a Property that is not an array takes only a value type that is not an array. A struct Property has no value type. Our rule.
- A publish holds 1 definition of each value type, with exactly 1 version. Our rule.
- The version is a label. A publish can change the constraints of a value type and keep its version. Deviation: OSDK makes the base type and the constraints of a version immutable (Value type versions: "The base type metadata and the constraints that define the validation rules for the type are immutable."). We read the version as a label, because the Ontology-as-code is the 1 source of the value type. [Check at publish](#check-at-publish) checks the stored values against each change.
- The status of a value type is `active` or `deprecated`, from the IR. The [Ontology metadata](#ontology-metadata) and the [Ontology MCP](../../service/ontology-mcp.md#tools) show it. It has no other effect. Our rule.
- A value type with no constraint compiles, and accepts each value. Our rule.
- A Boolean enum option `NULL_VALUE` has no effect. Compile keeps no option for it, so the metadata `options` and the words hold no `null`. A null value gets no value type check, as [Checks on write](#checks-on-write) specifies. Our rule.
- Publish refuses each of these with 400 `Default:InvalidArgument`, and its `feature` names the value type and the fault. The compile step throws `CompileError`, so the CLI shows the same error before a deploy. Our rule.
  - 2 definitions of 1 value type, or a definition with 0 or 2 versions.
  - A base type outside the list above.
  - An `isRid` constraint, a struct constraint, or a struct value type on a Property.
  - An enum with `useIgnoreCase: true`.
  - A constraint kind that does not fit its base type, such as an enum on a Date. [Constraints](#constraints) gives the base types of each kind.
  - A regex that JavaScript `RegExp` does not compile.
  - A bound or an option that is not a value of the base type, and a minimum above the maximum.
  - A Property `valueType` whose API name or version the IR does not define.
  - A Property whose base type differs from the base type of its value type.
  - A `propertyTypeConstraints` copy that differs from the constraints of the definition, or a `propertyTypeConstraints` on a Property with no value type.

### Constraints

- A value passes a value type when it passes each constraint of the value type. The check reads the constraints in order, and the first constraint that the value fails names the error. Deviation: `@osdk/client.unstable` notes `CreateValueTypeFailure` ("Multiple data constraints are disallowed for now."). Ontos accepts a list of constraints, because `@osdk/maker` writes a list and 1 rule can need both a length and a regex.
- These are the constraint kinds. The words column gives the plain words of each kind, after "Each value". The [Ontology MCP](../../service/ontology-mcp.md#tools) and the error of [Checks on write](#checks-on-write) use these words. Source of the kinds: Value type constraints. Our rule for the words.

| Kind                 | Base types                                | A value passes when                                                                                                            | Words                                                                                                                                                                            |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enum                 | String, Boolean, Integer, Double, Decimal | It equals 1 option                                                                                                             | `is one of "open", "done"`                                                                                                                                                       |
| Range                | Integer, Double, Decimal, Date, Timestamp | It is at least the minimum and at most the maximum. Each bound is optional.                                                    | `is at least 0 and at most 100`, `is at least 0`, `is at most 100`                                                                                                               |
| Length               | String                                    | Its length is at least the minimum and at most the maximum. Each bound is optional.                                            | `has 6 to 12 characters`, `has at least 6 characters`, `has at most 12 characters`                                                                                               |
| Regex, full match    | String                                    | The pattern matches the whole value                                                                                            | `matches the regex [A-Z]{3}-\d+ in full`                                                                                                                                         |
| Regex, partial match | String                                    | The pattern matches a part of the value                                                                                        | `contains a match of the regex [A-Z]{3}`                                                                                                                                         |
| UUID                 | String                                    | It is 8, 4, 4, 4, and 12 hex digits, with a `-` between the groups                                                             | `is a UUID`                                                                                                                                                                      |
| Array                | An array of each base type above          | Its size is in the bounds, its elements are unique when the constraint says so, and each element passes the element constraint | `is a list of 1 to 5 elements, with no element 2 times, and each element is one of "a", "b"`, `is a list of at least 1 elements`, `is a list of at most 5 elements`, `is a list` |

- Both bounds of a range and of a length are inclusive. So a range with the minimum `0` and the maximum `100` accepts `0` and `100`. Our rule.
- A length counts UTF-16 code units, the JavaScript `value.length`, as the `text` allowed values of a parameter do. So `"😀"` has a length of 2. Our rule.
- A UUID matches `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`, in any case and of any version. Our rule.
- An enum and a range compare by the exact value of the base type, as [Properties](./properties.md#base-types) specifies. A Decimal compares exactly, so `"1.5"` equals the option `"1.50"`, and `"9007199254740993"` is above the maximum `"9007199254740992"`. An Integer and a Double compare as numbers. A Date compares as its ISO 8601 text, and a Timestamp compares by its point in time. Our rule.
- A regex is a JavaScript `RegExp` with no flags. A full match is the default: the check wraps the pattern as `^(?:pattern)$`. With `usePartialMatch: true`, the pattern has no anchors. Our rule.
- The `text` allowed values of a [parameter](../action-types/action-types.md#parameters) and the `regex` condition of the [submission criteria](../action-types/submission-criteria.md#conditions) use the same engine and the full match. There, a pattern that does not compile matches no value. Our rule.
- An array value type takes only array constraints. Its element constraint is 1 constraint of another kind, on the element base type. With unique elements, no 2 elements have the same value. 2 Decimals compare after the padding of [Checks on write](#checks-on-write). 2 Timestamps compare by their point in time. Our rule.
- The words write each option and each bound in its JSON form, so a String, a Decimal, a Date, and a Timestamp are in double quotes: `is at least "2026-01-01"`. Each count reads "characters" or "elements", also for 1. The array words join their parts: the size, then `, with no element 2 times` for unique elements, then `, and each element ` with the words of the element constraint. Our rule.

### Checks on write

- The Ontology service checks each value of a Property with a value type on each write. This includes a rule edit of a rule-backed Action and an edit of a Function. Deviation: Ontos strictly refuses a Function edit that breaks a value type, because the stock client types the value from the value type and a bad stored value breaks that type for each app. Our rule.
- The value type check runs after the [value rules on write](./properties.md#value-rules-on-write), on the checked value. So a Decimal is checked in its form padded to the scale of its Property, and an array value is checked as a whole. A null value gets no value type check. Our rule.
- A list parameter with no value in the request writes `[]` with no value type check, so a Property with a minimum size of 1 stores `[]`. A list that the request sends gets the check, also `[]`. Our rule.
- A value that breaks a constraint gets 400 `ApplyActionFailed` with `originalErrorName: "Ontos:InvalidActionPropertyFormat"`, `objectType`, and `property`. The Action writes nothing. Our rule.
- `builderErrorMessage` is always the default text: `The value of Property <property> of Object Type <objectType> breaks the value type <valueType>: each value <words>.` An example is `The value of Property status of Object Type Task breaks the value type taskStatus: each value is one of "open", "done".` Our rule.
- `userErrorMessage` is the failure message of the constraint, such as `Use open or done.`. A constraint with no failure message gives the default text. Source: Use value types ("displays the value type's **Failure validation message**"). Our rule for the default text.
- A rule edit and a Function edit get the same error and the same messages. These messages replace the messages of a value rule in [HTTP API](../../service/http-api.md#errors). A Function edit that breaks a value rule of its base type keeps the text of [HTTP API](../../service/http-api.md#errors). Our rule.
- A parameter keeps its own allowed values, and the value type adds no allowed values to it. So a rule-backed Action whose parameter has no allowed values, and that writes a bad value, fails at the write check. Our rule.

### Check at publish

- A publish that gives a Property a value type, or changes its value type, checks each stored value of that Property with the [stored-data checks](../object-edits/schema-migrations.md#stored-data-checks). A change of the API name, the base type, or the constraints is a change of the value type. A change of the base type also changes the base type of the Property, so that Property holds no stored values, and the check finds no bad Object. Our rule.
- A publish that makes a Property required and sets or changes its value type runs the required check first. The value type check runs only when each Object has a value. A Move into a required Property with a value type follows the same order. Our rule.
- A new version label, failure message, display name, description, or status alone runs no check. A publish that removes the value type of a Property runs no check. Our rule.
- The check reads each stored value that is not null and not `[]`, in the form of a read, and checks it as [Checks on write](#checks-on-write) does. A stored `[]` gets no check, because the publish cannot tell a list that an Action left unset, which [Checks on write](#checks-on-write) does not check, from a list that a request sent. So a publish that only raises the maximum size of a list with a minimum size of 1 passes over a stored `[]`. Our rule.
- A stored value that breaks the value type fails the publish with 400 `Default:InvalidArgument`, with `parameters: { change, objectType, property, valueType, badObjects, primaryKeys }`, as [Stored-data checks](../object-edits/schema-migrations.md#stored-data-checks) specifies. With good data, the publish passes. Deviation: Ontos fails the publish immediately rather than letting invalid stored values persist, because a bad stored value breaks the type that the stock client gives each app. Our rule.
- `change` names the value type change, with the API name of the value type of the new version:
  - `Set the value type taskStatus on Property status of Object Type Task`
  - `Change the value type taskStatus of Property status of Object Type Task`
  - `Remove the value type taskStatus from Property status of Object Type Task`, which runs no check.
- An example with 11 bad Objects:

```json
{
  "errorCode": "INVALID_ARGUMENT",
  "errorName": "Default:InvalidArgument",
  "parameters": {
    "change": "Set the value type taskStatus on Property status of Object Type Task",
    "objectType": "Task",
    "property": "status",
    "valueType": "taskStatus",
    "badObjects": 11,
    "primaryKeys": ["t-01", "t-02", "t-03", "t-04", "t-05", "t-06", "t-07", "t-08", "t-09", "t-10"],
    "ontologyRid": "ri.ontology.main.ontology.<UUID>"
  }
}
```

- A Move into a Property with another value type checks the values of the old Property against the value type of the new Property. `change` is the text of the Move, such as `Move Property state to status of Object Type Task`. `property` is the old Property. Our rule.
- A Drop of the Property, or a Drop of all Objects of the Object Type, runs no check. Our rule.
- A new Property, a new Object Type, and a base type change hold no stored values for the value type, so they run no check. Our rule.
- A publish that checks a value type takes the `SHARE` lock on the table of the Object Type, also when it changes no column, as [Applying](../../service/publish.md#applying) specifies. So a write that waits for that lock, while the publish commits, gets 409 `ObjectChanged`, as [Storage](../../service/storage.md#writes) specifies, and each stored value that the check reads still passes after the commit. Our rule.

### Ontology metadata

- `fullMetadata` gives `valueTypes`, a map from API name to `OntologyValueType`, with each value type that a Property of the metadata uses. It gives no value type that no Property uses. Source of the shape: `OntologyValueType` of `@osdk/foundry.ontologies` 2.87.0. Our rule.
- Each `OntologyValueType` holds `apiName`, `displayName`, `description` when the IR has one, `rid`, `status`, `fieldType`, `version`, and `constraints`. Source: `OntologyValueType` of `@osdk/foundry.ontologies` 2.87.0.
- `status` is `ACTIVE` or `DEPRECATED`. Our rule.
- `rid` has the form `ri.type-registry.main.value-type.<UUID>`. The UUID follows the rule of the other RIDs of [HTTP API](../../service/http-api.md#rids), with the name `value-type:<API name>`. Source of the form: the examples of `@osdk/docs-spec-platform` 0.5.0.
- `fieldType` is the base type, such as `{ type: "string" }`, `{ type: "decimal" }`, or `{ type: "array", subType: { type: "string" } }`. Source: `ValueTypeFieldType` of `@osdk/foundry.ontologies` 2.87.0.
- Each constraint has the flat API v2 form: `{ type: "enum", options }`, `{ type: "range", minimumValue, maximumValue }`, `{ type: "length", minimumLength, maximumLength }`, `{ type: "regex", pattern, partialMatch }`, `{ type: "uuid" }`, and `{ type: "array", minimumSize, maximumSize, uniqueValues, valueConstraint }`. An absent bound has no key. API v2 has no failure message, so the metadata gives none. Source: `ValueTypeConstraint` of `@osdk/foundry.ontologies` 2.87.0.
- Each Property with a value type gives `valueTypeApiName`. Source: `PropertyV2` of `@osdk/foundry.ontologies` 2.87.0.
- A caller who cannot see an Object Type gets no value type that only the Properties of that Object Type use, as [Access](../../service/authentication.md#access) specifies for the Object Type. Our rule.
- So the stock generator of each [OSDK set](../../service/releases.md#osdk-sets) types a String enum Property as a union, such as `"open" | "done"`. It types a Boolean enum Property as its literal, such as `true`. Each other value type keeps its base type. Our rule.

## Out of scope

- RID constraints (`isRid`). Source: Value type constraints.
- Struct value types and struct field constraints. Source: Value type constraints.
- Case-insensitive enums (`useIgnoreCase: true`). Source: Value type constraints.
- A value type on an Action parameter, a Function input, or a struct field. A parameter keeps its own allowed values. Source: Use value types.
- Transforms, such as lowercasing a value. The Ontology service stores each value as the write gives it, or refuses it.
- The 2 preview routes of value types, `GET /api/v2/ontologies/{ontology}/valueTypes/{valueType}` and the list. Source: Get Ontology Value Type ("This endpoint is in preview and may be modified or removed at any time").

## Related

- [Properties](./properties.md)
- [Schema migrations](../object-edits/schema-migrations.md#stored-data-checks)
