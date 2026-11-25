---
status: specified
---

# Action Types

An Action Type is the definition of a set of edits to Objects, property values, and Links that a user applies at once. An Action is one transaction that applies those edits. Source: Action types overview.

## Contract

### Parts

- An Action Type has an API name, a display name, a description, parameters, [rules](./rules.md), and [submission criteria](./submission-criteria.md). Source: Action types overview.
- The description is the text that people and agents read. Our rule.
- The app defines each Action Type with `defineAction` or a `define*Action` helper of `@osdk/maker`. Source: `@osdk/maker` README.
- The app defines a function-backed Action with `defineFunctionBackedAction` of `@osdk/maker-experimental`. [Functions](../functions/functions.md#function-backed-actions) specifies it.

### API names

- An Action Type API name is the fully qualified API name: the API namespace, then the part that the app writes, such as `com.example.crm.complete-task`. [Object Types](../object-link-types/object-types.md#api-names) gives the source and the length rule.
- The part after the API namespace has lowercase letters and digits, in segments that hyphens separate, such as `complete-task`. It has no dot. [Object Types](../object-link-types/object-types.md#api-names) gives the split at the last dot and the API namespace pattern. Deviation: `@osdk/maker` 0.91.0 also accepts a dot ("must contain lowercase alphanumeric segments separated by hyphens or dots"). The OSDK generator names each Ontology SDK export by the text after the last dot, so `complete.task` gives the export `task`. Sources: `build/esm/api/defineAction.js` of `@osdk/maker` 0.91.0, `build/esm/GenerateContext/EnhancedBase.js` of `@osdk/generator` 2.92.0 (`fqApiName.slice(last + 1)`).
- 1 IR has 1 API namespace, because `@osdk/maker` puts 1 `--apiNamespace` in front of each Object Type and Action Type API name. Source: [Ontology-as-code](../../service/ontology-as-code.md). The Ontology service refuses an Ontology whose Object Types and Action Types do not all have the same API namespace. With no Object Type, the API namespace is that of the first Action Type. So it refuses `com.example.twin.complete.task` next to the Object Type `com.example.twin.Account`. Our rule.
- An Action Type API name is unique across the Action Types of the Ontology. Our rule.
- The Ontology SDK constant of an Action Type has the camelCase `apiName`, such as `com.example.crm.completeTask`, and the published API name in `unsanitizedApiName`. The routes take only the published name, as [HTTP API](../../service/http-api.md#requests) specifies.

### Permissions

- The [permission](../../../GLOSSARY.md) of an Action Type, with the permissions of the Object Types that it names, decides who can see it, validate it, and apply it. The submission criteria decide whether an apply succeeds. Our rule.
- A caller can see, validate, and apply an Action Type only when it holds the permission of the Action Type and the permission of each Object Type that the Action Type names. The Ontology service checks this at each request, because a custom role can hold any set of permissions. Source: Action type permissions ("the user submitting the action must be able to view the edited object types and link types"). Our rule for the parameter types: a caller who sees an Action Type can always use it.
- Publish checks the same rule for each default role, as [Grants check](../../service/publish.md#grants-check) specifies. Our rule.
- An Action Type names these Object Types: the Object Type of each `object` and `objectList` parameter, the Object Type of each `addObjectRule`, and both Object Types of each Link rule. A function-backed Action Type also names each Object Type of the Provenance of its Function, and both Object Types of each Link Type of that Provenance. Our rule.
- No Object Type has an edit grant, because Actions are the only way to change Objects. An apply needs no other permission check, because a caller that sees an Action Type holds the permission of each Object Type that it names. The [security policies](../object-security-policies.md) still decide which Objects the apply can load, as [Security](#security) specifies. Our rule.

### Parameters

- A parameter is an input of an Action Type. Each parameter has an ID and a type. Source: Parameters overview.
- The Ontology metadata gives the description of each parameter as the `description` of its `ActionParameterV2`, for a rule-backed and a function-backed Action. A function-backed Action takes it from the `@param` tag of its Function input, as [Functions](../functions/functions.md#discovery) specifies. Our rule.
- A parameter type is a [supported base type](../object-link-types/properties.md#base-types) other than Struct, a list of one, a struct parameter, an Object reference, or a list of Object references. Source: Scale and property limits.
- A function-backed Action can also have a struct list parameter: a list of structs. It comes from a Function input that is a list of an interface of the Function's code, such as `rows: Row[]`. An optional input, such as `rows?: Row[]`, gives the same parameter. Our rule.
- Each field of a struct list has 1 of the base types of a struct parameter field: String, Boolean, Integer, Double, Decimal, Date, or Timestamp. Publish refuses a field of another type, such as an Object reference, a struct, or a list. The error names the field and its type. Our rule.
- A struct parameter has named fields, each with a base type. It gives the value of a [struct Property](../object-link-types/properties.md#structs), with the same fields and base types. Source: Actions on structs ("The base type of the struct parameter field _must_ match the base type of a mapped struct property field").
- Each struct parameter field of a rule-backed Action is optional. `@osdk/maker` writes no `structFieldValidations` to the IR. Source: `convertActionValidation.ts`.
- Each struct parameter field of a function-backed Action takes `required` from the Function signature. A field that the TypeScript type does not mark optional is required. A missing required field gets 400 `InvalidParameterValue`, and the Function does not run. Our rule.
- A struct value misses a field when it has no key for it. A required field with the value `null` is not missing. The parameter then gets `INVALID` in the validation result. Its `struct` constraint gives that field `result: "INVALID"`, and the Function does not run. Our rule.
- An optional field with the value `null` passes. The Function gets the struct with no key for that field. Our rule.
- The Ontology metadata gives a struct parameter the data type `{ type: "struct", fields: [{ name, fieldType, required }] }`. Each `required` is the setting of its field from the 2 rules above: `false` on a rule-backed Action. Source: `wireActionTypeV2ToSdkActionMetadata.ts`.
- The Ontology metadata gives a struct list parameter the data type `{ type: "array", subType: { type: "struct", fields: [{ name, fieldType, required }] } }`, with `required: false`. Each field takes `required` from the Function signature, as a field of a struct parameter does. Our rule.
- The Ontology metadata gives the fields of a struct parameter and of a struct list parameter in the order of their declaration. That is the order of the Function signature, or of the IR on a rule-backed Action. Our rule.
- Each list input of a function-backed Action is optional, whatever its TypeScript type says. So the Ontology SDK types it as optional, and `VALIDATE_ONLY` and apply accept a call that leaves it out. Source: `convertFunctionBackedAction` (`listLength: {}`).
- A call that leaves out a list input of a function-backed Action passes, and so does a call that sends `[]`. The Function gets `[]` in both cases. Our rule.
- To require a list, refuse an empty list in the Function with a `UserFacingError`. The Function gets `[]` for an omitted list, so a default value of the input, such as `= ["x"]`, never applies. Our rule.
- A Function that read an omitted list input as `undefined`, to mean "not given", treats `[]` as "not given" instead. A Function cannot tell `[]` from an omitted list. So an input that clears a value needs its own parameter, such as a list of the names to clear. Our rule.
- A call that sends `null` for a list parameter gets 400 `ApplyActionFailed`. This holds for each list kind, on a rule-backed and a function-backed Action. Its `parameters` are `originalErrorName: "Ontos:SingletonValueForListParameter"`, `userErrorMessage: "The Action could not apply because of an invalid list parameter."`, and `builderErrorMessage: "A list parameter received a single value instead of a list."`. The Action writes nothing, and a Function does not run. This holds in both `VALIDATE_AND_EXECUTE` and `VALIDATE_ONLY` modes.
- The Ontology service first checks for an unknown parameter, which gets 400 `ParametersNotFound`. Then it checks the value of each parameter. A `null` list, and each other value that gives a 400, stops the check with that 400. A 400 comes before any `INVALID` result. When 2 parameters each give a 400, the answer gives 1 of them, and which one is not specified. Our rule.
- A list of a base type or of Object references with a `null` element gets 400 `InvalidParameterValue`. It holds the parameter ID, the whole list as `parameterValue`, and the base type of an element as `parameterBaseType`. Examples are `String`, and `OntologyObject<com.example.twin.RowProbe>` for a list of RowProbe Objects. Our rule.
- An element of the wrong base type in a list of a base type gets the same 400, with the whole list as `parameterValue`. An element of a list of Object references that is not a String gets 400 `InvalidPropertyValue`, as an Object parameter value does. Our rule.
- A value of a list of a base type or of Object references that is not a JSON array gets 400 `InvalidParameterValue`. It holds the parameter ID, the value, and the base type of an element as `parameterBaseType`. Our rule.
- A value of a struct list that is not a JSON array gets 400 `InvalidParameterValue`, with the parameter ID, the value, and `parameterBaseType: "Struct"`. Our rule.
- The Ontology service checks each element of a struct list as a struct value, in list order. It gives the 400 of the first element that gives a 400. The error has no element index. Our rule.
- A 400 of a later element wins over the `INVALID` result of an earlier element, such as a required field with the value `null`. When 1 element has 2 faults, the error names 1 of them, and which one is not specified. Our rule.
- An element of a struct list gets 400 `InvalidParameterValue` when it is `null`, or when it is not a JSON object. It gets the same 400 when it has a field that the struct list does not have, or no key for a required field. The error holds the parameter ID and the element as `parameterValue`, and no `parameterBaseType`. Our rule.
- A field value of the wrong base type in an element gets 400 `InvalidParameterValue`. It holds `parameterId: "<parameter>.<field>"`, such as `rows.count`, the base type of the field, such as `Integer`, and the field value. A number with a fraction for an Integer field is such a value. Our rule.
- The validation result gives a struct list parameter the constraint `{ type: "array", entries }`, with 1 `{ type: "struct", structFields }` entry for each element, in list order. Each field of an entry has `result`, `evaluatedConstraints: []`, and `required`. A required field of an element with the value `null` gives `result: "INVALID"` in the entry of that element, and the parameter is `INVALID`. An omitted list and `[]` give `entries: []`. Our rule.
- A list parameter with no list length in the IR and no allowed values constraint, within its limit, gets the bare constraint `{ type: "arraySize" }`. It comes last: after the `array` constraint of a struct list, and after the `objectQueryResult` constraint of a list of Object references. Our rule.
- Each other list parameter keeps `arraySize` with `gte` from the minimum length of the IR, and `lte` from the maximum length or from the limit. It comes before each other constraint, and it is present only when 1 of these bounds exists. Our rule.
- The Ontology service refuses a struct parameter value with a field that the struct parameter does not have, or a value that is not a JSON object. The error is 400 `InvalidParameterValue` with the parameter ID. Our rule.
- A struct field value with the wrong base type gets 400 `InvalidParameterValue` with `parameterId: "<parameter>.<field>"`, such as `relationship.since`. Our rule.
- A Decimal parameter takes a JSON number or a Decimal string, as [Properties](../object-link-types/properties.md#base-types) specifies. A value that is not a Decimal gets 400 `InvalidParameterValue` with `parameterBaseType: "Decimal"`. A value with a leading `+` or an exponent passes, such as `"+1.5"` or `"1.5e3"`. Our rule.
- The rules, the submission criteria, and the Function get a Decimal parameter value as its plain exact string, the [plain form](../object-link-types/properties.md#base-types). So `0.0825` gives `"0.0825"`, and `"1.50"` gives `"1.5"`. This holds for each element of a list, and for each Decimal field of a struct parameter or of a struct list. Our rule.
- A Decimal parameter that declares a precision and a scale gets no fit check at the parameter check. The fit check runs only when a rule or a Function edit writes the value, as [Value rules on write](../object-link-types/properties.md#value-rules-on-write) specifies. So `"1299.955"` passes the check of a parameter of scale 2, and its write gets the 400 of that section. Our rule.
- A list parameter holds at most 1,000 Objects, or at most 10,000 values of a base type. Source: Scale and property limits.
- A struct list holds at most 10,000 structs. A longer struct list gives `INVALID`, with the constraints `[{ type: "array", entries: [] }, { type: "arraySize" }]`, and the Function does not run. The check of each element runs first. Omitting per-element entries above the limit prevents response bloat while `arraySize` already identifies the violation. Our rule.
- The Ontology service refuses an Action that omits a required parameter. A list parameter can set a minimum and a maximum length. Source: `ParameterRequiredConfiguration`.
- The `required` setting of each parameter of a rule-backed Action comes from the IR. `@osdk/maker` makes a parameter required when the author sets `required` in its `parameterConfiguration`, or when its Property has `noNulls: true` and is not an array. Source: `defineAction.ts`.
- For the parameter of an array Property, `@osdk/maker` writes a list length, unless the author sets `required`. The minimum length is 1 when the Property has `noEmptyCollections: true`. Otherwise the list length has no limit. A list parameter is required when its minimum length is 1 or more. Source: `defineAction.ts`.
- When a list parameter has no value, the Action writes `[]` to each Property that the parameter maps to. Source: Required properties ("Actions will write an empty array" when "the parameter is not set"). The write gets no value type check for that `[]`, as [Checks on write](../object-link-types/value-types.md#checks-on-write) specifies.
- So the primary key parameter of a Create object rule is optional unless the author makes it required. A create with no primary key value passes validation, and the apply fails with 400 `ApplyActionFailed`, as in the HTTP API. Our rule.
- The Ontology service refuses an Action with a parameter value outside its allowed values. Source: Filter parameter results ("The value selected is also validated before the action is executed").

These are the supported allowed values. `@osdk/maker` writes the default kind for each parameter type. Source: `@osdk/maker` `ActionParameterAllowedValues.ts`, `defineAction.ts`.

| Kind          | Parameter types          | Allows                                                                                                  |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `oneOf`       | Any base type            | A value from a list. With `otherValueAllowed`, also any other value.                                    |
| `range`       | Integer, Double, Decimal | A number between an optional minimum and an optional maximum                                            |
| `text`        | String                   | A string with an optional minimum length, maximum length, and regex                                     |
| `datetime`    | Date, Timestamp          | A value between an optional minimum and an optional maximum                                             |
| `boolean`     | Boolean                  | `true` or `false`                                                                                       |
| `objectQuery` | Object reference         | An Object of the parameter's Object Type                                                                |
| `struct`      | Struct parameter         | A struct value with the parameter's fields                                                              |
| `user`        | String                   | The User ID of an active member of the caller's Organization. The Ontology service refuses `fromGroups` |

- The Ontology service checks each element of a list parameter against the allowed values. Our rule.
- `range` and `oneOf` compare a Decimal by its exact value, as [Properties](../object-link-types/properties.md#base-types) specifies. So a `range` with the maximum `9007199254740992` gives `INVALID` for `"9007199254740993"`. A `oneOf` option `"1.50"` accepts `"1.5"` and the number `1.5`. This holds in `VALIDATE_ONLY` and in `VALIDATE_AND_EXECUTE`. Our rule.
- Each static Decimal of the IR must be a Decimal: a Decimal `range` bound, a `oneOf` option of a Decimal parameter, and a static value that a [submission criterion](./submission-criteria.md#conditions) compares with a Decimal. Publish refuses an Action Type with one that is not a Decimal, and the compile step throws `CompileError` with a message that names the value. Publish also refuses a static Decimal whose plain form has more than 1,000 characters, such as `1e1000`. The compile step keeps each static Decimal in its plain form, so an apply never parses the Ontology. Our rule.
- The Ontology metadata of a parameter with `oneOf` allowed values has `validation: { defaultValidation: { allowedValues: { type: "oneOf", options, otherValuesAllowed } } }`. Each option is a `ParameterAllowedValueOption` that holds the value, with an empty `displayName`. Source: `ActionParameterV2` of `@osdk/foundry.ontologies` 2.87.0.
- `@osdk/maker` writes the `struct` kind for each struct parameter. Source: `defineAction.ts`.
- The Ontology service ignores the form-only settings of a parameter: render hints, visibility, sections, and order. Our rule.
- A parameter of a rule-backed Action can have a default value. The IR holds it in `parameterValidations.<id>.defaultValidation.display.prefill`. `@osdk/maker` writes the `defaultValue` of the parameter there. Source: `convertActionValidation.js` of `@osdk/maker` 0.91.0 (`prefill: p.defaultValue`).
- The Ontology service compiles the default value kind `objectParameterPropertyValue`: a Property of the Object in an Object reference parameter of the same Action Type. `defineModifyObjectAction` of `@osdk/maker` gives this default value to each parameter of a Property that is not a struct, with the Property that the parameter maps to. It writes no default value for a struct parameter to the IR. Source: `setObjectPropertyDefaults.js` and `convertActionValidation.js` of `@osdk/maker` 0.91.0.
- Publish refuses each other default value kind, and names it: `staticValue`, `staticObject`, `staticObjectV2`, `interfaceParameterPropertyValue`, `interfaceParameterPropertyValueV2`, `objectQueryPrefill`, `objectQueryPropertyValue`, `objectSetRidPrefill`, `parameterTransformPrefill`, and `redacted`. Our rule. Source of the kinds: `ParameterPrefill` of `@osdk/client.unstable` 2.92.0.

- The Ontology service checks a value of the `user` kind against the kept member list of the caller's Organization, as [Authentication](../../service/authentication.md#user-ids) specifies, at each apply and at each `VALIDATE_ONLY` apply. So a new member or a new service user can be refused, and a removed one can stay valid, for up to 60 seconds, or 5 minutes while WorkOS fails. A value that is not the User ID of an active member gets the same answer as any value outside its allowed values. Our rule.
- A value of the `user` kind can also be the client ID of a [service user](../../../GLOSSARY.md) of the caller's Organization. Its check reads the kept application list of the Organization, as `Users.get` does for a service user, as [Authentication](../../service/authentication.md#user-ids) specifies. A client ID of another Organization gets the same answer as any value outside its allowed values. Our rule.
- The member check reads WorkOS as `Users.get` does, so a WorkOS fault gets the answer that [Authentication](../../service/authentication.md#user-ids) gives for a fault of a user read. Our rule.
- The Ontology service runs the member check after each other parameter check, and before it loads the Object of each Object parameter. A request that gets an HTTP error from those checks, or an `INVALID` parameter from them, makes no WorkOS read. A validation result of such a request shows each `user` parameter that passes its other checks as `VALID`, because no member check ran. So a request that gets 404 `ObjectNotFound` for a missing Object of an Object parameter can read WorkOS first. Our rule, because WorkOS allows 1,000 reads per 10 seconds for each environment, as [Authentication](../../service/authentication.md#user-ids) says.
- 1 request holds at most 500 distinct values of the `user` kind, the bound of `Users.getBatch`. A request with more makes no WorkOS read. When each other parameter check passes, its validation result has `INVALID` for each `user` parameter that holds a User ID. That is the result of a value outside its allowed values. Our rule, for the same WorkOS limit.
- Publish never forces the `user` kind on a String parameter. Our rule.

### Apply

1. The Ontology service checks each parameter value against its type, its required setting, and its allowed values.
2. It evaluates the [submission criteria](./submission-criteria.md).
3. It runs the [rules](./rules.md) and compiles one edit for each Object.
4. It writes the edits in one transaction, as [Storage](../../service/storage.md#writes) specifies.

- The client sends `mode` and `returnEdits` in `options`. `VALIDATE_ONLY` runs steps 1 and 2 and writes nothing. A function-backed Action also runs its Function, as a deviation in [Functions](../functions/functions.md#function-backed-actions). Our rule.
- A `VALIDATE_AND_EXECUTE` apply that passes validation returns `operationId`, the [RID](../../service/http-api.md#rids) of the Action. Each [Object Edit History](../object-edits/edit-history.md) entry of the Action holds this RID as its Action ID. A `VALIDATE_ONLY` apply and an `INVALID` apply return no `operationId`. Our rule.
- A failed step 1 or 2 gives HTTP 200 with `validation.result: "INVALID"`. A missing required parameter is such a failure. A valid `VALIDATE_AND_EXECUTE` apply gives `validation.result: "VALID"`, with `parameters: {}` and `submissionCriteria: []`. A `VALIDATE_ONLY` apply and an `INVALID` apply give 1 entry in `parameters` for each parameter, with its `result`, `evaluatedConstraints`, and `required`. Our rule.
- For a rule-backed Action, an omitted parameter and a parameter with the value `null` are 2 different requests. For a list parameter, `null` is an error, as [Parameters](#parameters) specifies. A call omits a parameter when its `parameters` object has no key for it. The stock `@osdk/client` sends the value `null` when the app passes `null`, and sends no key when the app passes `undefined`. Source: `toDataValue` of `@osdk/client` 2.92.0 ("Sending null over the wire clears the data, whereas undefined is dropped at request time").
- An omitted optional parameter with a default value takes its default value. A parameter that is not a list has no value when the call sends `null`, also when it has a default value. A list parameter with the value `null` gets the error of [Parameters](#parameters). [Rules](./rules.md#values) specifies what each one writes. Our rule.
- In a `VALIDATE_ONLY` apply, when the default value of a parameter gives a value, the entry of the parameter also has `defaultValue` with that value. The entry has it also when the call sends `null` for a parameter that is not a list, or when the call sends a value. Our rule.
- A value that the service cannot read, an unknown parameter, and a failure after validation each get an HTTP error. [HTTP API](../../service/http-api.md#errors) lists them. Source: same section.
- The `returnEdits` answer holds no Property value, so it holds no Decimal. Its `addObject` and `modifyObject` edits give only `primaryKey` and `objectType`, and a primary key is a String. Source: `AddObject` and `ModifyObject` in `build/esm/v2/_components.d.ts` of `@osdk/foundry.ontologies` 2.87.0.
- `returnEdits: ALL` lists the created and modified Objects, and only counts the deleted Objects in `deletedObjectsCount`. `ALL_V2_WITH_DELETIONS` also lists each deleted Object. `NONE` returns no edits. Our rule.
- An apply whose edits compile to no edit gives no `edits` key, with `ALL` and with `ALL_V2_WITH_DELETIONS`, as with `NONE`. It still gives `operationId`. Our rule.
- An apply with `ALL_V2_WITH_DELETIONS` can create or update more than 5,000 Objects of 1 Object Type, with no delete and no Link edit. Then it gives `edits: { type: "largeScaleEdits", editedObjectTypes: [<that API name>] }`, with no list and no counts. The count is of edited Objects after the edits compile, not of rows. Our rule.
- Each other apply keeps `edits` with the full list. Examples are an apply with `ALL`, with a delete, with a Link edit, or with more than 1 Object Type. Our rule.
- With `$returnEdits`, the stock `@osdk/client` 2.92.0 gives the `largeScaleEdits` value as it is. It gives `undefined` for an answer with no `edits` key. Source: `build/esm/actions/applyAction.js` of `@osdk/client` 2.92.0.
- An Action edits at most 10,000 Objects of at most 50 Object Types. A larger Action gets 400 `OntologyEditsExceededLimit`, with `editsCount` and `editsLimit`, such as `{ editsCount: 10001, editsLimit: 10000 }`. Sources: Scale and property limits, Errors ("This may happen if your Action is modifying too many objects"). Our rule.
- Before step 4, the Ontology service checks that the request did not abort, and that its deadline did not pass. Such a request writes nothing. The abort check applies only when the platform passes a disconnect signal, and no adapter passes one in v1.0, as [HTTP entry](../../service/code-layout.md#http-entry) says. Step 4 ends at the deadline. [Storage](../../service/storage.md#writes) specifies both. Our rule.
- A rule-backed Action does not run again after 409 `ObjectChanged` from a changed Ontology version, as [Storage](../../service/storage.md#writes) specifies. Each attempt uses the view of its request, so another attempt cannot pass. The next request opens the new view. Our rule.
- A rule-backed Action that a [Uniqueness constraint](../object-link-types/properties.md#uniqueness-constraints) refuses runs 1 attempt. It gets 409 `PropertyValueAlreadyExists`, and the Ontology service does not run it again, because a clash is a fact of the data, not a race. Our rule.
- When a step fails, the Action fails and writes nothing. Source: Action types overview ("a single transaction").
- [Object Edit History](../object-edits/edit-history.md) specifies the record of each edit.

### Security

- An apply loads each Object of its parameters through the [object security policy](../object-security-policies.md) of its type, so it loads no hidden Object. Source: Action type permissions ("Row and column access controls [...] filter what a user can read when invoking an action").
- A modify or a Link edit of an Object that an object security policy hides from the person gets 404 `ObjectNotFound`. That is the same answer as a missing Object, and it writes nothing. A delete of such an Object gets the answer of a delete of a missing Object, and writes nothing. That answer is 404 `ObjectNotFound` for a rule-backed Action, and success for a function-backed Action, as [Edit Functions](../functions/edit-functions.md#apply) specifies. Our rule.
- The writer locks each modified or deleted Object, and writes only when its version is the version that the person's load saw. Our rule.
- An apply reads each Property value of a loaded Object as the person sees it, so a value that a property security policy hides is null. Our rule.
- An Action can write a value that the person cannot view, such as a value of a Property that a property security policy hides from them. Source: Action type permissions ("These controls do not extend to the action's write.").
- A create of a new primary key is allowed, also when the person cannot view the new Object. Source: Action type permissions ("This means that it is possible for users to create objects that they cannot view.").
- A create of a primary key that a hidden Object holds gets 409 `ObjectAlreadyExists`, the same answer as for a visible Object. This is 1 of the 2 exceptions to [hidden equals missing](../object-security-policies.md#hidden-objects). The key is taken, so the create cannot write, and the answer shows that an Object holds the key. Our rule.
- A function-backed Action loads its Objects again before the write, as the person. So an edit of an Object that the policy hides from the person gets the same answer as an edit of a missing Object. Our rule.

### Statuses

- An `active` Action Type cannot be deleted or renamed. Set it to `deprecated` first. Source: Statuses ("A resource’s status must be `experimental` or `deprecated` before it can be deleted", and "The API name of an active resource cannot be changed").
- Publish refuses a breaking parameter change on an `active` Action Type: a new required parameter, a removed parameter, a changed parameter type, or an optional parameter that becomes required. A renamed parameter is a removed parameter. A new optional parameter, and a required parameter that becomes optional, are allowed. A `validateOnly` publish with no Functions skips this check on a function-backed Action Type, as it skips the Function checks ([Publish](../../service/publish.md#route)). Our rule. It follows the rule that an `active` resource gets no major breaking change. Source: Statuses ("major breaking changes will not be made in the Ontology Manager").
- A change of the fields of a struct list parameter is a changed parameter type. So is a change of an input from a list of a base type to a struct list. So publish refuses each of them on an `active` Action Type, with 400 `Default:InvalidArgument`. Its `parameters` are `change: "Change the type of parameter <id> of Action Type <apiName>"`, `status: "active"`, and `requiredStatus: "deprecated"`. Our rule.

## Out of scope

- Conditional overrides: an override can change the validation of a parameter. Source: Overrides.
- Parameter filters: an Object reference limited to an Object Set. Source: Filter parameter results.
- Struct field validations on a rule-backed Action: a `required` setting and allowed values for each struct parameter field. `@osdk/maker` does not write them to the IR. Sources: Actions on structs, `convertActionValidation.ts`.
- Each default value kind other than `objectParameterPropertyValue`, as [Parameters](#parameters) specifies. Source: `ParameterPrefill` of `@osdk/client.unstable` 2.92.0.
- Parameter types Long, Attachment, Media reference, Object Set, Interface reference, and Object Type reference. A struct list parameter of a rule-backed Action (the IR type `structList`). Source: Scale and property limits.
- A field of a struct parameter or of a struct list that is an Object reference, a struct, or a list. Our rule.
- A Function input that is a list of an inline object type, such as `{ rowId: string; label: string }[]`. The CLI writes a custom type only for a named TypeScript interface, so it refuses an inline object type with `"<type>" is not a supported type.`, and an app declares the row type as an interface. Our rule.
- Allowed value kinds for groups, markings, and value types, and `fromGroups` in the `user` kind. Source: `@osdk/maker` `ActionParameterAllowedValues.ts`.
- The Action Log: one log Object Type for each Action Type. `@osdk/maker` cannot declare it. Source: Action log.
- The isolation level and the retry mode of an Action Type, which Ontology Manager sets in the Capabilities tab. `@osdk/maker` cannot declare them. Each Action Type uses the default retry mode, as [Storage](../../service/storage.md#writes) specifies. Source: Consistency and isolation.
- Action reverts. Source: Revert or undo actions.
- Batch apply (`applyBatch`): many Actions of one Action Type in one call. The Ontology service serves the route, and answers each request that passes the token check with 400 `Default:InvalidArgument`, with `parameters: { feature: "applyBatch" }`. Source: Apply Action Batch. Our rule for the error.
- Function-backed batched execution. Source: Batched execution.
- Action metrics, and monitors on them in monitoring views. [Observability](../../service/observability.md#scope) specifies the deviation. Source: Action metrics.

## Related

- [Rules](./rules.md)
- [Submission criteria](./submission-criteria.md)
- [Object Edit History](../object-edits/edit-history.md)
- [Edit Functions](../functions/edit-functions.md)
- [Storage](../../service/storage.md#writes)
- [HTTP API](../../service/http-api.md)
