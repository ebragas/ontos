---
status: specified
---

# Object security policies

An object security policy decides which Objects of an Object Type a person can view. A property security policy decides which Property values of a viewable Object the person can view. Source: Object security policies ("If a user does not pass the object security policy, the object instance will not be viewable to that user. If they pass the object security policy but do not pass the property security policy, they will see a _null_ value in place of the property value.").

A product uses them so that a crew member sees only the jobsites that they work on, and a member does not see a financial Property. The [permission](../../GLOSSARY.md) of a type decides who can use the type. The policies then decide which Objects and Property values of it each person sees. [Ontology-as-code](../service/ontology-as-code.md#security-policies) specifies how the app writes them.

## Contract

### Policies

- An Object Type has at most 1 object security policy. An IR can hold 2, in 2 datasources of 1 Object Type or in 2 `primaryKey` groups. Publish refuses it, and the error names the Object Type. Source: Object security policies.
- An Object Type with no object security policy shows each of its Objects to each caller that holds the permission of the Object Type. Our rule.
- An object security policy with no condition shows each Object of its type. `@osdk/maker` writes one when the Object Type has property security policies and no object security policy. Source: `@osdk/maker` `convertDatasourceDefinition.ts`.
- A property security policy names 1 or more Properties of its Object Type. To view the value of such a Property, the person must pass the object security policy and the property security policy. Source: Object security policies ("the user must pass both the object security policy and the property security policy to view the property value").
- Publish refuses a Property in 2 property security policies. Source: Object security policies ("A non-primary key property can be a member of at most one property security policy").
- Publish refuses a [derived property](./object-link-types/derived-properties.md#security) in an object security policy or a property security policy. A derived value gets its security from the Objects that it reads. Our rule.
- Publish refuses a primary key Property in a property security policy. Source: Object security policies ("The primary key property cannot be a member of any property security policy").

### Conditions

- A policy is 1 condition. A condition is a comparison, or an `and` or `or` of conditions. `and` passes when each of its conditions passes. `or` passes when 1 of its conditions passes. Source: Manage granular policies.
- A comparison has 1 person side and 1 Object side. The Object side is a Property of the Object, or a fixed String or list of Strings. Our rule.
- Publish refuses a comparison with no person side, and a comparison with 2 person sides. Our rule.
- The person side is a person value: `user.id` or `user.permissions`. Each person value is a set of Strings. Our rule.
- The person side can also be a [Person attribute](#person-attributes), which is a set of Strings. Our rule.
- `user.id` is the User ID of the person: the `sub` of their token, as [Authentication](../service/authentication.md#user-ids) specifies. It is a set of 1 value. Our rule.
- `user.permissions` is the set of permissions of the caller in the Organization of the Ontology, as [Authentication](../service/authentication.md#permissions-of-a-caller) specifies. It is empty for a caller with no permission. Our rule.
- The app writes a check of `user.permissions` with the `@osdk/maker` `group` condition, and the Ontology service reads each group name as a permission slug. Deviation: OSDK checks the groups of a user, each named by a UUID. We read a group as a permission, because the Ontology service has no groups, and a permission does the same job: it names the callers that a policy checks. Source: Manage granular policies ("**Group IDs:** The IDs of all the groups that have the user as a member (direct and inherited)."). [OSDK workarounds](../service/osdk-workarounds.md) records it.
- A comparison uses 1 of 4 operators: equals, intersects, subset of, and superset of. Source: Manage granular policies (Equal, Intersects, Subset of, Superset of).
- Each operator compares 2 sets of Strings, the Object side on the left and the person side on the right. Intersects passes when they share a value. Subset of passes when each value of the left is in the right. Superset of passes when each value of the right is in the left. Our rule.
- Equals passes when the 2 sets hold the same values. Deviation: OSDK requires that both sides of Equal hold 1 value. We compare sets, because each person value and each policy Property is a set of Strings here. Source: Manage granular policies ("**Equal:** Both the left and right side of the comparison must be single-valued (not a collection) and of the same type.").
- When the IR holds the person side on the left, as the `@osdk/maker` `group` shortcut writes it, compile swaps the 2 sides, and swaps subset of and superset of. Equals and intersects do not change. Our rule.
- A comparison of `user.permissions` asks "holds 1 of these" with intersects, or "holds each of these" with subset of, after the swap. Publish refuses equals and superset of on `user.permissions`, and the error names the operator. Our rule.
- A Property that a policy compares with `user.permissions` holds permission slugs. Our rule.
- A comparison removes each null from both sides first. A side that is then empty fails the comparison, for each operator. So an empty Property matches nothing. Our rule.
- Publish refuses `not` in a policy. Deviation: OSDK accepts `not`, and warns against it. We refuse it, because a `not` on a person value that is missing grants access. Source: Manage granular policies ("Avoid using `NOT` conditions with group, marking, or organization memberships. Using a `NOT` condition in these circumstances is a misconfiguration.").
- Publish refuses a policy that reads markings, the `username` of the person, or the group names of the person. The error names the feature. Our rule.
- A policy compares only String and String array Properties. Publish refuses a policy that reads a Property of another base type, and the error names the Property. Our rule.
- Publish refuses a policy condition that is not a comparison, an `and`, or an `or` in the IR shape, an `and` or `or` with no list of conditions, and a comparison with another operator. The error names the Object Type, the policy, and the shape. Only the open policy that `@osdk/maker` writes for an Object Type with no object security policy reads as no policy. Publish refuses each other `and` with no condition, because it would show each Object. Our rule.

### Empty values

- An empty value is null, an empty array, or an array of only nulls. An empty String is a value. Our rule.
- An Object with an empty value in a Property that its object security policy reads is hidden from each person, `admin` included. Source: Manage granular policies ("Rows with null values in a policy column will be inaccessible to all users.").
- An empty value in a Property that a property security policy reads fails only the comparisons that read it. It does not hide the Object. Our rule.

### Hidden Objects

- A person can view an Object when they can use its type and pass its object security policy. Otherwise the Object is hidden from them. Our rule.
- A hidden Object answers as a missing Object on each route: the same status, the same error, and the same bytes. There are 2 exceptions. A create of a primary key that a hidden Object holds gets 409 `ObjectAlreadyExists`, as [Action Types](./action-types/action-types.md#security) specifies. A write whose values clash with a hidden Object on a Uniqueness constraint gets 409 `PropertyValueAlreadyExists`, as [Uniqueness constraints](./object-link-types/properties.md#uniqueness-constraints) specifies. Our rule.
- Known risk: a modify can write the empty value to the Property that a parameter maps to, as [Rules](./action-types/rules.md#values) specifies. It does so when it sends `null` for a parameter that is not a list, or omits a parameter with no default value. When an object security policy reads that Property, the Object is then hidden from each person, `admin` included, as [Empty values](#empty-values) specifies. The Ontology service does not refuse such a modify because it clears the Property normally. A modify that omits a parameter whose default value is the Property keeps the Property, so the Object stays visible. Our rule.
- [Object sets](./ontology-sdk/object-sets.md#security), [Aggregations](./ontology-sdk/aggregations.md#security), [Link Types](./object-link-types/link-types.md#security), [Action Types](./action-types/action-types.md#security), and [Object Edit History](./object-edits/edit-history.md#security) specify what a hidden Object does there.

### Hidden Property values

- A Property value that a property security policy hides is null for the person on each read. A count of Objects does not change, because the Object itself is visible. Source: Object security policies.
- [Object sets](./ontology-sdk/object-sets.md#security), [Aggregations](./ontology-sdk/aggregations.md#security), [Properties](./object-link-types/properties.md#security), [Submission criteria](./action-types/submission-criteria.md#person-values), [Rules](./action-types/rules.md#values), and [Object Edit History](./object-edits/edit-history.md#security) specify what null does there.

### Person attributes

- A [Person attribute](../../GLOSSARY.md) is a set of primary keys that the Ontology service derives for the person from Objects. The app declares each one in the grants file, as [Ontology-as-code](../service/ontology-as-code.md#the-grants-file) specifies. Our rule.
- A Person attribute starts at the Objects of its start Object Type whose start Property equals `user.id`. It follows each Link side of its path in order. It collects the primary keys of the Objects at the end. Our rule.
- A Person attribute with no Link side collects the primary keys of its start Objects. Our rule.
- A person with 2 or more start Objects gets the union of their paths. Our rule.
- A person with no start Object gets the empty set, so each comparison that reads the attribute fails. Our rule.
- A Person attribute reads the stored Objects and Links, not the person's view. So a policy cannot depend on itself. Our rule.
- The Ontology service reads each Person attribute once for each request, before the route runs. So a change reaches the policies at the next request, and an Action reads the attribute before it applies its edits. Our rule.
- A request reads only the Person attributes that the policies of the types that its caller can see read. Our rule.
- A request whose policies read no Person attribute reads none. Our rule.
- A failed read of a Person attribute fails the request with 500 `Default:Internal`, and the request serves no data. Our rule.
- An agent that calls the [Ontology MCP](../service/ontology-mcp.md) for a person reads with the Person attributes of that person. Our rule.
- A declaration that names a type, a Property, or a Link side that the product version does not have matches nothing at a cold start. It does not fail the cold start. Our rule.

## Out of scope

- Markings, Organizations, and classifications in a policy: the mandatory controls. The Ontology service has no markings. Source: Object security policies.
- Custom attributes from the identity provider. A Person attribute comes from Objects. Source: Manage granular policies.
- The comparison weight limit of 10,000 for each policy. The Ontology service sets no limit on comparisons, and no limit on the Link sides of a Person attribute. Source: Manage granular policies.
- The edit of a policy by a person in Ontology Manager. A policy changes only with a publish of the Ontology-as-code. Source: Object security policies.
- Policies on Properties of a base type other than String and String array.

## Related

- [Object Types](./object-link-types/object-types.md)
- [Properties](./object-link-types/properties.md)
- [Ontology-as-code](../service/ontology-as-code.md#security-policies)
- [Authentication: Access](../service/authentication.md#access)
- [Design rules: Permissions](./design-rules.md#permissions)
