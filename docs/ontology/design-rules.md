# Ontology design rules

These rules govern each design decision: Ontology modeling in the Ontology service and in each app's Ontology, and the features of the Ontology service. Each rule cites the OSDK page it comes from. A rule marked "Our rule" has no OSDK source. A rule that departs from OSDK states the deviation and its reason. To change a rule, edit it in place.

## Authority

- Follow the public OSDK Ontology guidance by default. Before you propose an Ontology design, read the relevant OSDK documentation and Apache-2.0 package types and cite them. Make the OSDK shape the default recommendation. Our rule.
- Verify each "OSDK does X" claim against public OSDK documentation or Apache-2.0 `@osdk/*` package sources. Our rule.
- An interoperability check covers public sources: public OSDK docs, release notes, the newest Apache-2.0 `@osdk/*` packages against the pinned ones, and `osdk-ts` main. For a Function feature, read the TypeScript v2 form. Our rule.
- An engine capability beyond OSDK is not a reason to depart from the OSDK shape. Our rule.
- A deviation from OSDK needs explicit maintainer approval. Record it on its rule as `Deviation: OSDK does X. We do Y because Z.` Our rule.
- Each deviation has 1 item in [Deviations](../service/deviations.md). When you add or remove a `Deviation:` sentence, change that page in the same pull request. Our rule.
- Use the OSDK term for a concept wherever OSDK has one. Our rule.

## Service features

- A service gap becomes a service feature that each deployment can use, not a workaround in an app. Our rule.
- Choose the design where the Function runtime, the authoring helper, and the client are all stock. Our rule.
- The service adds no edit kind, route, or field outside the OSDK HTTP API v2 contract unless documented in `docs/service/`. The app's Function holds application-specific logic. Our rule.
- A new setting must prove its need. Prefer one fixed value. Our rule.

## Object Types

- The primary key of each Object Type is a generated ID with no business meaning, except a [person Object Type](#people), which uses the User ID. Each business identifier and each source-system ID is a unique Property with a [Uniqueness constraint](./object-link-types/properties.md#uniqueness-constraints), not the primary key. Object Edit History and Links stay with the primary key, and its value never changes. Deviation: OSDK advises authors to "Identify the primary key that uniquely identifies the entity across systems (for example, employee ID)". We use a generated ID because an outside key can be wrong or re-used, and 2 sources can match 1 Object by their ID Properties. Sources: Create an object type ("Edits are permanently attached to the primary key value you made them for"), Scale and property limits ("Modifying the primary key is equivalent to deleting an object and then adding a new object"), Ontology design: Anti-patterns.
- A Property has 1 meaning on each Object of its Object Type. When the meaning of a value would change with another Property, such as a kind, put the value in its own Property or its own Object Type. Source: Ontology design: Anti-patterns (an indicator of The God Object: "Property meanings change based on another property's value (such as type or category)").
- Put data that only some kinds of an Object Type have in its own Object Type, with a Link Type to it. Do not add Properties that most Objects leave empty. Such a Property shows that the Object Type holds 2 entities, so split it before its data grows. Source: Ontology design: Anti-patterns (an indicator of The God Object: "An object type has many properties that are frequently null"; the fix for Department Silos: "Use link types to connect shared objects to department-specific objects").
- Put behavior that only some kinds have in its own Action Type, with submission criteria that check the kind. One Action Type does not branch on the kind. Source: Ontology design: Anti-patterns (a problem of The God Object: "Actions must handle wildly different entity types with complex conditional logic").

## Actions

- People and agents change Objects only through Action Types. Source: Action types overview.
- An Action Type performs one business operation. Property edits that the same people make together share one Action Type. Source: Ontology anti-patterns: Action Sprawl.
- An Action Type that changes one Property exists only when that change is its own business event: its own verb, precondition, permission, or an effect that the Action performs. A `Set <Property>` name is a warning sign. A business event takes its own verb, such as Classify, Cancel, or Run. Our rule.
- Name an Action Type as a verb, then the Object Type. Use the singular name for 1 Object, such as `create-account`. Use the plural name for a list, such as `bulk-merge-transactions`. Our rule.
- Use 3 plain verbs for standard writes: Create, Update, and Delete. An Update bundles the Properties that the same people change together. A released Action Type keeps its name, as [Schema evolution](#schema-evolution) specifies. Our rule.
- Keep the caller and the source out of an Action Type name. Use no "sync", no "import", and no name of an outside system. Our rule.
- A create Action takes each Link as an Object parameter. A required Link is a required parameter, and an optional Link is an optional parameter that the caller can omit. Add a separate Action Type for a Link only when Objects can exist without that Link. For example, `create-account` requires Entity, and `assign-account` exists because `bulk-merge-accounts` creates an Account from a feed with no Entity. Our rule.
- A Function input that names an Object takes that Object, typed `Osdk.Instance<T>`, not its primary key as a string. Then the parameter type names its Object Type, and the business map puts the Action Type under that Object Type. Our rule.
- A row of a list of structs that can create its Object carries the primary key as a String field. The Object may not exist yet, and a struct field cannot hold an Object. Our rule.
- A bulk write of Objects by key is a function-backed Action with 1 parameter that is a list of structs. Name it "Bulk merge" and the plural Object Type, such as `bulk-merge-transactions`. Use "bulk", not "batch", because OSDK uses "batch" for `applyBatch` and batched execution, which are different features. Its Function reads the Objects of the incoming keys. It returns a create, an update, or a delete only for a row that changes an Object. Our rule.

## Agents

- Each Object Type, Property, Link Type, Action Type, and Action parameter has a description, because agents read it to learn the business. Write the description of a Function input in its `@param` tag. Our rule.
- Agents read Objects and apply Actions through the Ontology MCP as the person who signed in. Deviation: OSDK scopes the Ontology MCP to the resources of a Developer Console application. We expose each type that the person's permissions open, because the Ontology service has no applications and the engine already enforces security. Source: Ontology MCP overview ("Ontology MCP (OMCP) is a Developer Console feature that exposes your application's ontology resources").

## Permissions

- A permission grants access on each Object Type, Action Type, and Query Function that names it, at 1 level, the same as the OSDK `Viewer`. A role is a set of permissions in WorkOS. The product defines its default roles in the grants file, and an Organization can add custom roles. Deviation: OSDK grants roles on Projects. We name 1 permission on each type, because we have no Projects, a product has few types, and an Organization must change what a role can use with no publish. Sources: Ontology permissions, [Roles and permissions](https://workos.com/docs/authkit/roles-and-permissions) ("you can add or modify roles and their access rights without changing the application code").

- Hide Objects with an object security policy, and hide Property values with a property security policy, on the Object Type in the Ontology-as-code. Do not split an Object Type to hide its Objects or Properties. Source: Object security policies.
- Give each Property that an object security policy reads a value. An Object with an empty value there is hidden from each person. Source: Manage granular policies ("Make sure policy columns are non-null").
- Derive a fact about a person, such as their jobsites, as a Person attribute: a path from the Objects that hold their User ID, through Link Types. Deviation: OSDK takes custom user attributes from the identity provider. We derive them from Objects, because every fact must be part of the Ontology and change through Actions. Source: Manage granular policies ("**Custom attributes:** Any custom attributes configured by your identity provider").
- Hold a membership in a many-to-many Link Type, such as Crew to Jobsite. Do not add an Object Type only to hold a membership. Our rule.

## People

- A person Object Type uses the User ID as its primary key. A product that needs more Objects for each person uses another Object Type with a `userId` Property, such as `CrewMember`. Our rule.

## History

- Object Edit History records the edits that Actions apply. Source data updates create no history. Enable it per Object Type. History starts when you enable it. Sources: User edit history, How user edits are applied.
- A process that makes a business decision applies a named Action Type, so its edits enter history. Our rule.
- Create a separate business object or event only for a concrete question that Object Edit History and the current Object cannot answer. Our rule.
- Secrets, credentials, binary content, signed URLs, and raw source payloads never enter Object Edit History. Our rule.
- A sync that applies an Action is a caller of that Action. Its edits enter Object Edit History under its service user. Our rule.

## Schema evolution

- To change a Property's meaning, add a new Property and Move the values to it. To change its type, add a new Property, fill it with an Action, and Drop the old one. To remove a Property, Drop or Move its values. Source: Schema migrations.
- Machine names are permanent contracts. A retired name stays reserved. A released Action Type keeps its name. Never rewrite stored history. Our rule.
