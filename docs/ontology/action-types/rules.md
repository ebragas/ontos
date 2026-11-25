---
status: specified
---

# Rules

A rule defines the edits that an Action makes. An Action Type has an ordered list of rules. Source: Rules.

## Contract

### Rule kinds

These are the supported rules. Sources: Rules, `OntologyIrLogicRule`.

| Rule          | IR rule            | Edit                                                                                          |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| Create object | `addObjectRule`    | Creates one Object, with a value for each Property that the rule maps                         |
| Modify object | `modifyObjectRule` | Changes the mapped Properties of the Object in an Object reference parameter                  |
| Delete object | `deleteObjectRule` | Deletes the Object in an Object reference parameter                                           |
| Create link   | `addLinkRule`      | Creates a many-to-many Link between the Objects in two parameters                             |
| Delete link   | `deleteLinkRule`   | Deletes a many-to-many Link between the Objects in two parameters                             |
| Function      | `functionRule`     | Runs an [edit Function](../functions/edit-functions.md) and applies the edits that it returns |

- A Create link or Delete link rule uses a many-to-many Link Type. A one-to-many Link changes through a Modify object rule on its foreign key Property. Source: Rules.
- A Modify object or Delete object rule cannot use an Object that the same Action creates. Source: Rules ("This cannot reference an object created as a part of the current action").
- An Action Type with a Function rule has no other rule. Source: Rules ("When this rule is present, no other rule may be configured").
- A Function rule comes from `defineFunctionBackedAction`. [Functions](../functions/functions.md#function-backed-actions) specifies how the Ontology service fills it at publish.

### Values

A rule maps each Property or Function input to a value. These are the supported values. Sources: Rules, `OntologyIrLogicRuleValue`.

| Value                           | IR value                       | Gives                                                                                      |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| Parameter                       | `parameterId`                  | The value of a parameter                                                                   |
| Static value                    | `staticValue`                  | A fixed value                                                                              |
| Property of an Object parameter | `objectParameterPropertyValue` | A Property value of the Object in an Object reference parameter, before the Action's edits |
| Current user                    | `currentUser`                  | The ID of the user that applies the Action                                                 |
| Current time                    | `currentTime`                  | The time when the user submits the Action                                                  |
| Generated UUID                  | `uniqueIdentifier`             | A new UUID                                                                                 |

- A struct Property gets its value only from 1 struct parameter. The rule maps each field of the struct Property to the same field of that parameter, with a `structParameterFieldValue` in `structFieldValues`. Sources: Actions on structs ("Struct property values can only be created or modified through _struct parameters_"), `@osdk/maker` `defineAction.ts`.
- A Modify object rule replaces the whole struct value with the value of its struct parameter. A field with no value in the parameter becomes absent. A struct parameter with no value sets the struct to `{}`. To change 1 field, the caller sends all the fields. Our rule.
- A parameter value has no value in 2 cases. The call sends `null` for a parameter that is not a list, or the call omits the parameter and it has no default value. Then the rule writes the empty value of the Property type: null, `[]` for an array, or `{}` for a struct. Our rule.
- When the call omits a parameter with a default value, a parameter value gives the default value. When the default value is the Property that the rule writes, of the Object that the Modify object rule changes, the rule keeps the Property: it does not write it. The edit is still a modify of the Object. Our rule.
- The 2 rules above apply in the same way to a struct parameter. Our rule.
- A call that sends `null` for a list parameter gets the error of [Action Types](./action-types.md#parameters). So a Create object rule writes `[]` for an omitted list parameter with no default value. A Modify object rule of `defineModifyObjectAction` keeps the Property of an omitted list parameter, through its default value. Our rule.
- A rule writes a Decimal value padded to the scale of its Property, also in a Decimal struct field, as [Value rules on write](../object-link-types/properties.md#value-rules-on-write) specifies. So a rule that writes the number `1299.9` to a Decimal Property of scale 2 stores it, and `loadObjects` then reads `"1299.90"`. A value that does not fit gets the 400 of that section, and the Action writes nothing. Our rule.
- A Property of an Object parameter gives the value as the person sees it. When a [property security policy](../object-security-policies.md) hides the value from the person, the rule writes null. Our rule.
- [Authentication](../../service/authentication.md#user-ids) specifies the user ID that the current user value gives.
- A generated UUID value gives a new UUID on each Action. Source: `UniqueIdentifier` ("An auto generated UUID will be used for this value").
- The `linkId` of a generated UUID value has no effect. In OSDK Ontology metadata types, only a reference to a new Interface Object uses it, and the Ontology service has no Interfaces. Source: `CreatedInterfaceObjectReferenceByUniqueIdentifier` ("Used to support creating a new object and linking it to another object in the same action type").

### Compile

- The Ontology service runs the rules in order and compiles one edit for each Object. For the same Property of the same Object, a later rule wins. Source: Rules ("the actions backend compiles rules to generate a single edit per object").
- The Ontology service refuses an Action whose rules delete an Object and then change it, change an Object before they create it, or create the same Object twice. Source: Rules.
- [Storage](../../service/storage.md#writes) specifies how the edits commit.

## Out of scope

- Create or modify object: not implemented in v1.0. Source: Rules.
- Interface rules: The Ontology service has no Interfaces. Source: Rules.
- Scenario rules: not implemented in v1.0. Source: `OntologyIrLogicRule`.
- Side effects: notifications, webhooks, and schedule rules. The `@osdk/maker` IR cannot hold them. Sources: Notifications, Webhooks.
- The values for Interface parameter Properties, media references, webhook outputs, and schedule runs. Source: `OntologyIrLogicRuleValue`.

## Related

- [Action Types](./action-types.md)
- [Submission criteria](./submission-criteria.md)
- [Edit Functions](../functions/edit-functions.md)
- [Link Types](../object-link-types/link-types.md)
