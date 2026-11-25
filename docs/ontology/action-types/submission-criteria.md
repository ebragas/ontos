---
status: specified
---

# Submission criteria

Submission criteria are the conditions that decide whether an Action can be submitted. An Action is submitted only when all of its submission criteria pass. Source: Submission criteria.

## Contract

- An Action Type has a list of criteria. Each criterion has one condition and one failure message. Sources: Submission criteria, `OntologyIrValidationRule`.
- An Action Type with no criteria has one criterion with the condition `true`. Source: `@osdk/maker` `convertActionValidation.ts`.
- The Ontology service evaluates the criteria after it checks the parameters and before it runs the rules. Our rule.
- When a criterion fails, the Action fails and writes nothing. The validation result gives the failure message of each criterion. Sources: Submission criteria, Apply Action.

### Conditions

These are the supported conditions. Source: `OntologyIrCondition`.

| Condition    | Passes when                                          |
| ------------ | ---------------------------------------------------- |
| `comparison` | The left value and the right value meet the operator |
| `regex`      | A value matches a regular expression                 |
| `and`        | All of its conditions pass                           |
| `or`         | Any of its conditions passes                         |
| `not`        | Its condition fails                                  |
| `true`       | Always                                               |

- A comparison uses one of these operators: `EQUALS`, `NOT_EQUALS`, `LESS_THAN`, `LESS_THAN_EQUALS`, `GREATER_THAN`, `GREATER_THAN_EQUALS`, and `INTERSECTS`. Source: `ComparisonOperator`.
- A condition value is a parameter, a static value, a Property of an Object parameter, or the length of a list parameter. A Property value is the value before the Action's edits. Source: `OntologyIrConditionValue`.
- A comparison of a Decimal compares by its exact value, as [Properties](../object-link-types/properties.md#base-types) specifies. This holds for a parameter, a Property of an Object parameter, and a static value on either side. So `"1299.9"` equals a stored `"1299.90"`, and `"9007199254740993"` is greater than `"9007199254740992"`. Our rule.
- A comparison of 2 structs compares each field by its base type, so a Decimal field compares by its exact value. A field with no value equals a field with the value `null`, and the order of the fields does not matter. Our rule.
- The length of an omitted list parameter is 0, the same as for `[]`. Our rule.
- `and`, `or`, and `not` can nest. Source: Submission criteria.

### Person values

- A comparison can take a person value of the person who applies the Action as 1 of its 2 values: `user.id`, `user.permissions`, or a [Person attribute](../object-security-policies.md#person-attributes). The other value is a parameter, a static value, or a Property of an Object parameter. Each person value is a set of Strings. Source: Submission criteria ("Multipass attributes are treated as string lists and can only be compared against other strings or string lists.").
- The app writes a check of `user.permissions` with the `@osdk/maker` `group` condition, and the Ontology service reads each group name as a permission slug, as in an [object security policy](../object-security-policies.md#conditions). Our rule.
- A comparison of `user.permissions` asks "holds 1 of these" with `INTERSECTS`. Compile refuses `user.permissions` with `EQUALS` or `NOT_EQUALS`, and the error names the operator. Our rule.
- A comparison of a person value uses `EQUALS`, `NOT_EQUALS`, or `INTERSECTS`. Compile refuses a person value in a comparison with another operator, and the error names the operator. Our rule.
- `EQUALS` passes when the person value holds exactly 1 String, and that String equals the other value. `NOT_EQUALS` passes when the person value is not empty and `EQUALS` fails. `INTERSECTS` passes when the person value and the other value share a String. `not`, `and`, and `or` can hold a comparison of a person value. Our rule.
- A comparison that reads an empty person value, such as the `user.permissions` of a caller with no permission or an empty Person attribute, is unknown. `not` of an unknown is unknown. `and` fails when a condition fails, and is unknown when no condition fails and a condition is unknown. `or` passes when a condition passes, and is unknown when no condition passes and a condition is unknown. A criterion that is unknown at the top fails, so the Action is refused with the failure message of that criterion. Our rule. Source: Submission criteria ("If a user does not have access to an attribute, they will fail the condition.").
- A Property value of an Object parameter is the value as the person sees it. A value that a property security policy hides is null, so a criterion that needs the value fails. Our rule.

## Out of scope

- Conditions on a value of the current user other than the 3 [person values](#person-values), such as the username. Source: Submission criteria.
- Conditions on markings. Source: `OntologyIrCondition`.
- Conditions on the execution context, such as an Ontology Scenario. Source: Submission criteria.
- The `IS_OF_OBJECT_TYPE` operator and Interface parameter Properties: The Ontology service has no Interfaces. Source: `ComparisonOperator`.

## Related

- [Action Types](./action-types.md)
- [Rules](./rules.md)
