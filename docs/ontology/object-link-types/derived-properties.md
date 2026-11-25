---
status: specified
---

# Derived properties

A [derived property](../../../GLOSSARY.md) is a read-only Property whose value the Ontology service computes at read time from linked Objects. An Object Type declares it, or a request declares it. This page is the 1 home of the rules of both forms. Source: Derived properties ("Derived properties are **read-only**. They cannot be edited by actions or functions, and they are not stored in object storage.").

## Contract

### Forms

- An Object Type declares a derived property with the stock `@osdk/maker` `derived` datasource: a chain of Link Types, then 1 aggregation or 1 linked value. The author declares the Property in `properties` with its type, as a stored Property. Our rule.
- A request declares a derived property with the stock `withProperties` member of an [Object Set](../ontology-sdk/object-sets.md#members). Its value is a `selection` over a chain of hops from `methodInput`, a `property` of the input row, or an expression. Our rule.
- Both forms are 1 feature. The compile step converts each Object Type definition to 1 `selection` tree for each Property, with no loss, and 1 compiler reads both forms. No TypeScript Function backs a derived value. Our rule.
- To reuse 1 request definition in many reads, the app exports the `withProperties` clause from a shared TypeScript module. Our rule.
- The conversion maps each maker datasource kind to 1 operation of the `selection` tree. `linkedProperties` gives `get`, `approximateCardinality` gives `approximateDistinct`, and `exactCardinality` gives `exactDistinct`. Each other aggregation keeps its name. Our rule.
- Each step of the maker chain names a Link Type and a side, `SOURCE` or `TARGET`. The conversion gives the Link side API name of that step on its Object Type, as a `searchAround`. A self-link converts in both directions by the same rule. Our rule.
- The maker README example converts to the body of the stock client. The `passengersList` Property, a `collectList` of `name` over 1 Link, gives the same `selection` as `pivotTo` on that Link, then `aggregate("name:collectList", { limit: 100 })`. Our rule.
- `@osdk/maker` 0.91.0 refuses a derived aggregation on a Decimal Property inside `defineObject`. The Ontology service accepts it. Deviation: [OSDK workarounds](../../service/osdk-workarounds.md) records the `@osdk/maker` limitation and the workaround.

### Limits

- Each form has these limits. Source: Derived properties reference ("Static literals are not currently supported in expressions").

| Limit                              | Object Type form | Request form                                                            |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| Link hops                          | 1 to 3           | 1 or more, with no fixed maximum                                        |
| A filter on a hop                  | No               | Yes                                                                     |
| An expression                      | No               | Yes, as [Operations](#operations) specifies                             |
| `approximatePercentile`            | No               | Yes                                                                     |
| A read of another derived property | No               | Yes, a value of an inner `withProperties`, as [Reads](#reads) specifies |
| A literal, or the current time     | No               | No                                                                      |

- A definition that breaks a limit of its form gets refused. Publish refuses it as [Publish](#publish) specifies. A read refuses it with 400 `InvalidDerivedPropertyDefinition`, as [HTTP API](../../service/http-api.md#errors) specifies. Our rule.
- The `limit` of `collectList` and `collectSet` is from 1 to 100, in both forms. A `limit` below 1 or over 100 gets refused. A read refuses it with 400 `InvalidDerivedPropertyCollectionLimit`. Source: Derived properties reference ("The limit defaults to `10` and can be raised to a maximum of `100`."). Our rule for the minimum.
- A request nests at most 32 layers: each `withProperties` member has at most 32 `withProperties` members around it. A deeper request gets 400 `InvalidDerivedPropertyDefinition` before the service reads data. The error names the first layer, from the outside, that has more than 32 layers around it. Our rule.
- A request has at most 1,000 `withProperties` definitions, counted over all its clauses, nested clauses included. A request with more gets 400 `InvalidDerivedPropertyDefinition` before the service reads data. The error names the first definition of the first clause that passes the limit. The definitions, with the stored Properties and the `orderBy` fields, also count toward the column limit of a read, as [Object Sets](../ontology-sdk/object-sets.md#request-size) specifies.
- The request form has no "now". To compare with today, the app sends the date as a filter value. Our rule.

### Operations

- A `selection` reads the Objects at the end of its hops, and gives 1 value with 1 of these 11 operations. Our rule.

| Operation                              | Value                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `count`                                | The count of the Objects                                                                                 |
| `get`                                  | The value of the 1 Object                                                                                |
| `sum`, `avg`, `min`, `max`             | The metric of the values, as [Metrics](../ontology-sdk/aggregations.md#metrics) specifies                |
| `exactDistinct`, `approximateDistinct` | The count of the distinct values. Both are exact                                                         |
| `approximatePercentile`                | The continuous percentile of the values, at the fraction that `approximatePercentile` gives. It is exact |
| `collectList`                          | The values, with no null, in the order of the primary keys of their Objects, at most `limit` values      |
| `collectSet`                           | The distinct values, with no null, in value order, at most `limit` values                                |

- `get` needs each hop to reach at most 1 Object: each Link side of the path has cardinality ONE. A `get` after a hop whose Link side has cardinality MANY gets refused, in both forms. Source: Derived properties reference ("If more than one object can be reached, an aggregation is required").
- A `count`, an `exactDistinct`, and an `approximateDistinct` over no linked Object give 0. Each other operation over no linked Object gives null, so a load leaves the Property out of the Object. So a `sum` over no Objects is null. Our rule.
- A `collectList` or a `collectSet` whose linked Objects have no value that is not null gives null, as over no linked Object. So a load leaves the Property out. Our rule.
- A filter on a hop keeps only the Objects that match it. The filter is the `filter` member of [Object Sets](../ontology-sdk/object-sets.md#where-clauses), with its queries and its errors. Examples: cleared balance is the `sum` of `amount` of the Transactions whose `status` is `cleared`. Plan cash is the `sum` of `amount` of the Transactions whose `date` is on or before a date that the request sends. Our rule.
- A request derived property can be an expression. These are the expressions: `add`, `subtract`, `multiply`, `divide`, `absoluteValue`, `negate`, `greatest`, `least`, and `extract`. An operand is a `selection`, a `property` of the input row, or an expression. Our rule.
- Besides `type`, the value of each expression reads only these members. `add`, `multiply`, `greatest`, and `least` read `properties`. `subtract` and `divide` read `left` and `right`. `absoluteValue` and `negate` read `property`, and `extract` reads `property` and `part`. An extra member does not change the value, so a `divide` with an extra `properties` member divides `left` by `right`. Our rule.
- Example: category available is the `sum` of `amount` of the Transactions of a Category, minus the stored Property `budget` of the Category. Our rule.
- A `divide` by 0 gives null, not an error. Our rule.
- An expression with a null operand gives null. `greatest` and `least` skip a null operand, and give null only when each operand is null. Our rule.
- `extract` gives the `DAYS`, `MONTHS`, `QUARTERS`, or `YEARS` part of a Date or a Timestamp as an Integer, in UTC. Our rule.
- 2 nested derived values give the right values when their hop filters name the same Property. A filter of an inner hop reads the Objects of its own hop, never the Objects of an outer hop. Our rule.
- Each derived value equals the value that the rules of this page give for the Objects and the Property values that the caller can see, as [Security](#security) specifies. Our rule.

### Types

- Each operation and each expression has 1 result type. A definition whose operation does not take the type of its Property or of its operands has no result type, and gets refused. An example is a `sum` of a String. A `sum` and an `avg` of a Boolean also have no result type, although [Metrics](../ontology-sdk/aggregations.md#metrics) takes a Boolean. Our rule.
- The type table gives the result type of 2 operands. A list of 3 or more operands of `add`, `multiply`, `greatest`, or `least` follows the same rows. So a list of Integers gives Integer, and a list of Integers and Doubles, or of Decimals and Doubles, with at least 1 Double gives Double. An `add`, `greatest`, or `least` of Decimals gives a Decimal with the largest scale of the operands. A `multiply` whose first operand is a Decimal, and whose other operands are each a Decimal or an Integer, gives a Decimal with the scale of the first operand. Each other list that holds both a Decimal and an Integer has no result type, and a read refuses it with 400 `InvalidDerivedPropertyDefinition`. Our rule.

| Operation                                       | Property type                                                                       | Result type                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------- |
| `count`, `exactDistinct`, `approximateDistinct` | Any                                                                                 | Integer                                 |
| `sum`, `avg`                                    | Integer or Double                                                                   | Double                                  |
| `sum`, `avg`                                    | Decimal                                                                             | Decimal, with the scale of the Property |
| `min`, `max`                                    | A type that [Metrics](../ontology-sdk/aggregations.md#metrics) takes for the metric | The type of the Property                |
| `get`                                           | Any                                                                                 | The type of the Property                |
| `approximatePercentile`                         | Integer, Double, or Decimal                                                         | Double                                  |
| `collectList`, `collectSet`                     | A stored base type that is not an array or a struct                                 | An array of the type of the Property    |

| Expression                              | Operand types                                                | Result type                                     |
| --------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `add`, `subtract`, `multiply`           | Integer and Integer                                          | Integer                                         |
| `divide`                                | Integer and Integer                                          | Double                                          |
| `add`, `subtract`, `multiply`, `divide` | Integer or Double, with at least 1 Double                    | Double                                          |
| `add`, `subtract`, `greatest`, `least`  | Decimal and Decimal                                          | Decimal, with the largest scale of the operands |
| `multiply`, `divide`                    | A Decimal left value, and a right value that is not a Double | Decimal, with the scale of the left value       |
| Any numeric expression                  | Decimal and Double                                           | Double                                          |
| `absoluteValue`, `negate`               | Integer, Double, or Decimal                                  | The type of the operand                         |
| `greatest`, `least`                     | Integer and Integer                                          | Integer                                         |
| `greatest`, `least`                     | Integer or Double, with at least 1 Double                    | Double                                          |
| `greatest`, `least`                     | Date and Date, or Timestamp and Timestamp                    | The type of the operands                        |
| `extract`                               | Date or Timestamp                                            | Integer                                         |

- A count and a distinct count give Integer. Deviation: OSDK gives a count and a distinct count as Long. We give Integer, because the Ontology service has no Long base type, as [Properties](./properties.md#out-of-scope) specifies. Source: Derived properties reference (the aggregation table gives Long for Count, Approximate cardinality, and Exact cardinality).
- A `sum` of an Integer gives Double. Deviation: OSDK gives Long for a `sum` of `short` and `integer` values. We give Double, because the Ontology service has no Long base type, as [Properties](./properties.md#out-of-scope) specifies, and the stock client types a derived `sum` as `double`. Source: Derived properties reference (the aggregation table gives "`short`, `integer` | `long`").
- An `avg` of a Decimal gives a Decimal with the scale of the Property. Deviation: OSDK gives Double for `avg` of a numeric Property. We give a Decimal, because the answer keeps its exact value, as [Metrics](../ontology-sdk/aggregations.md#metrics) specifies. Source: Derived properties reference (the aggregation table gives "Average | `avg` | Numeric | Double").
- An `approximatePercentile` gives Double. Deviation: OSDK gives the type of the source. We give Double, because a percentile of Integers can have a fraction. Source: Derived properties reference (the aggregation table gives "Numeric | Same as source").
- A `sum` of a Decimal keeps the scale of the Property. Deviation: OSDK gives "increased precision and reduced scale (if necessary)". We keep the scale, because the answer is an exact string with the scale of the Property, as [Metrics](../ontology-sdk/aggregations.md#metrics) specifies. Source: Derived properties reference.
- A Decimal value keeps its exact value from the column to the answer, and the answer gives it as an exact string, as [Properties](./properties.md#base-types) specifies. So a `sum` of a Decimal past 2^53 keeps each digit. Our rule.
- `avg` of a Decimal is rounded 1 time to the scale of the Property, half away from zero, as `avg` of [Metrics](../ontology-sdk/aggregations.md#metrics). Our rule.
- `add`, `subtract`, `negate`, `absoluteValue`, `greatest`, and `least` of Decimals are exact. Our rule.
- `multiply` and `divide` with a Decimal left value are rounded 1 time to the scale of the left value, half away from zero. So on scale 2, `1.25 * 0.5` gives `"0.63"`, and `-1.25 * 0.5` gives `"-0.63"`. Our rule.
- A `multiply` of 3 or more operands is 1 operation, so it is rounded 1 time, after the last operand, to the scale of the first operand. So on scale 2, `1.25 * 0.5 * 0.5` gives `"0.31"`, and a nested `(1.25 * 0.5) * 0.5` is 2 operations and gives `"0.32"`. A `divide` has exactly 2 operands, `left` and `right`, so it is rounded 1 time. Our rule.
- An Integer expression whose value does not fit in an Integer gets 400 `Default:InvalidArgument`, not a 500. An Integer expression applies its operator from left to right over its operands. So an overflow before a null operand gets this 400, and a null operand before the overflow gives null. An operand that is itself an expression always computes, so an overflow inside it gets this 400 also after a null operand. Our rule.

### Reads

- A derived value works as a stored Property in a `where` clause, an `orderBy`, a page token, a metric, and a group-by. Source: Derived properties reference (the table "Compare derived properties to native properties").
- A `where` clause names a derived property by `field`, or by `propertyIdentifier: { type: "property", apiName }`, as the stock client sends it. Our rule.
- A load returns a derived property by this rule. `ontologyDerived` is on when `loadOntologyDefinedDerivedProperties` is `true`, or when it is absent and the deployment setting is on. A flag of `false` turns the setting off for that request. Source: `loadOntologyDefinedDerivedProperties` in `@osdk/foundry.ontologies`. Our rule for the setting.

| `select`                   | Returned                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Names 1 or more Properties | Only the named Properties: stored, Object Type derived, or request derived                                                              |
| Empty                      | Each stored Property, each request derived property of the set, and each Object Type derived property only when `ontologyDerived` is on |

- So a load of Account whose `select` names `balance` gives the `sum` of `amount` of the Transactions of each Account. With no `select`, no request flag, and the setting off, it gives no `balance`. With `loadOntologyDefinedDerivedProperties: true`, it gives each derived property of Account. Our rule.
- The deployment setting `ONTOLOGY_LOAD_DERIVED_PROPERTIES` is off by default, as [Deployment files](../../service/deployment.md#deployment-files) specifies. Deviation: OSDK has no such setting, and returns an Object Type derived property only when the request selects it or sets the flag. We add the setting, so that a deployment can return each derived value to an app that does not name it. Source: Derived properties ("API and Ontology SDK requests do not return ontology-defined derived properties unless you select them").
- A sort on a derived value pages as a sort on a stored Property, as [Paging](../ontology-sdk/object-sets.md#paging) specifies. So an `orderBy` on `balance` over 2 pages gives each Object 1 time, when no edit happens between the pages. Known limit: an edit of a linked Object between 2 pages can move an Object to another page. Our rule.
- An aggregate takes a derived property as a metric and as a group-by, as [Aggregations](../ontology-sdk/aggregations.md#metrics) specifies. Examples: a `sum` of `balance`, and an `exact` group-by on `transactionCount`. Our rule.
- Inside a hop, the Object Type derived properties of the target are not in scope. So 2 derived properties that point at each other, such as Account to Transaction and back, compute with no loop. Source: Derived properties reference ("Linked property- and aggregation-based derived properties cannot reference other derived properties at all").
- A `withProperties` set gives a value for each of the 11 operations of [Operations](#operations). Our rule.
- A `where` clause, an `orderBy`, and an aggregate read a request derived value. Example: account active is a `count` of the active Engagements of an Account, and a `where` keeps each Account whose value is `> 0`. Our rule.
- An expression of a later `withProperties` reads a value of an inner `withProperties`. A `selection` cannot read a derived value: its selected Property is a stored Property of its target. Source: Derived properties reference ("a derived property can be referenced in a subsequent expression-based operation, but not within the same operation or any earlier one in the declaration order").
- A text search query takes a derived property as a Property that is not Searchable, as [Text search](../ontology-sdk/object-sets.md#text-search) specifies. This holds in both forms, also when the IR marks the Property Searchable. Our rule.
- A request derived property does not pass through a set operation or a `searchAround`. So a `select` of it after a `union` gets 404 `PropertiesNotFound`. Our rule.
- A stock client of each OSDK set reads an Object Type derived property by `$select` and by `$UNSTABLE_loadOntologyDefinedDerivedProperties`. It reads a request derived property with `withProperties`, `where`, `$orderBy`, `fetchPage` with no `$select`, and `aggregate`. [OSDK workarounds](../../service/osdk-workarounds.md) lists the gaps of the stock client. Our rule.

### Security

- A derived value reads only the Objects and the Property values that the caller can view. The Ontology service checks the access of the caller at each hop, as [Object Sets](../ontology-sdk/object-sets.md#security) specifies. Source: Derived properties ("Access checks apply at each object in the calculation, including intermediate objects in a multi-hop traversal, before their values are combined.").
- A hidden Object drops out of each hop. So a `count` does not count it, a `sum` leaves it out, and a hidden middle Object of a 2-hop path removes the Objects behind it from the path. Our rule.
- A Property value that a [property security policy](../object-security-policies.md#hidden-property-values) hides counts as null. So a `sum` skips it, a `collectList` leaves it out, and a hop filter reads it as null. Our rule.
- So 2 readers can get 2 values of 1 derived property on 1 Object. Example: an object security policy hides 1 Transaction of an Account from the second reader, and a property security policy hides its `amount`. Each reader gets the `balance` of the Transactions and the values that the reader can see. Source: Derived properties ("two users can see different values for the same derived property on the same object").
- In the Object Type form, a hop to an Object Type that the caller has no permission for gives the same value as over no linked Object: 0 for a `count`, an `exactDistinct`, and an `approximateDistinct`, and null for each other operation. The Property stays in the Ontology metadata, so the metadata has 1 shape for each person. Our rule.
- In the request form, a hop through a Link side that the caller cannot view gets 404 `LinkTypeNotFound`, as `searchAround` does. A hop to an Object Type that the caller cannot view gets the same error, because the caller cannot view a Link side to it. Our rule.
- A derived property has no policy of its own. A policy cannot name it, as [Publish](#publish) specifies. Our rule.
- The Ontology service stores and caches no derived value. Each read computes each value for its caller. Our rule.

### Publish

- Publish accepts a derived property on an Object Type. The table of the Object Type has no column for it. Our rule.
- A derived property has no column, so the `changes` of the publish answer do not list an added derived property, a removed derived property, a new definition, or a new type. The status rules of [Edge rules](../object-edits/schema-migrations.md#edge-rules) apply, so an `active` derived property cannot change its type. Our rule.
- A change from stored to derived, or from derived to stored, counts as a delete of the old Property and an add of the new one. So by [Edge rules](../object-edits/schema-migrations.md#edge-rules), an `active` Property cannot change its form, and a stored Property that holds values needs a schema migration to become derived. Our rule.
- These cases publish. Balance is a `sum` of `amount` over 1 hop, from an Account to its Transactions. The 2 counts are a `count` over 1 hop: the Role assignment count, and the Invoice count of an Engagement. Invoice Account is a `get` over 2 hops that each reach 1 Object, from an Invoice to its Engagement to its Account. The 2 entities of a Transaction, `categoryEntity` and `accountEntity`, are each a `get`. Our rule.
- Publish refuses each definition error. The error is 400 `Default:InvalidArgument`, and its message names the Object Type and the Property. Our rule. These are the definition errors:
  - A definition with no hop, or with a 4th hop.
  - A Link Type, or a side, that does not connect to the Object Type of its step.
  - A `deleted` definition.
  - A `get` after a hop with cardinality MANY.
  - A selected Property that is missing, or that is a derived property.
  - A collect `limit` below 1 or over 100.
  - An operation that does not take the type of its Property.
  - A declared type that is not the result type of [Types](#types). A Decimal must also have the scale of the result type. Publish does not compare the precision.
- Publish refuses each wrong use of a derived property. The error is 400 `Default:InvalidArgument`, and its message names the Object Type, the Property, and the use. Our rule. These are the wrong uses:
  - A mapped name that the `properties` of the Object Type do not declare.
  - A name that 2 datasources map.
  - The primary key, or the title key.
  - `required`.
  - A value type, or a Uniqueness type class.
  - A Link Type foreign key.
  - A write by an Action rule.
  - A name in an object security policy or a property security policy.
- Publish cannot see the Properties that a Function edits. So an apply refuses a Function edit of a derived property, as [Function-backed Actions](../functions/functions.md#function-backed-actions) specifies. Source: Derived properties ("They cannot be edited by actions or functions").
- The refusal of the title key is our rule. A derived title key would add a computed value to each read of `__title`.

### Ontology metadata

- The Ontology metadata gives each derived property as a plain `PropertyV2`, with its declared type and its display parts. It holds no definition. Our rule.
- An Object Type with a derived property has 1 datasource, `{ rid, definition: { type: "unsupported", unsupportedType: "derived", properties } }`. `properties` lists the API name of each derived property of the Object Type. An Object Type with no derived property has no datasource. Source: `ObjectTypeUnsupportedDatasource` of `@osdk/foundry.ontologies` 2.87.0 ("callers can recognize known but unmodelled cases (e.g., derived properties)").
- `generate-osdk` types a derived property as a plain Property of its declared type. Our rule.

### Cost

- A derived value is in the SQL of a read only when the read uses it. So a load that names no derived property computes no derived value. Our rule.
- A value that only the load selects is computed only for the Objects of the page. So a load that selects `balance`, sorts by `name`, and has a page of 10 computes `balance` for 11 Objects: the 10 of the page, and 1 more that shows that a next page exists. Our rule.
- A value that a `where` clause, an `orderBy`, a metric, or a group-by reads is computed 1 time for each Object of the set. A load whose `where`, `orderBy`, and `select` all read `balance` computes it 1 time for each Object, not 1 time for each use. Our rule.
- Each hop reads its target through a foreign key column or a join table column, and each of these columns has an index, as [Storage](../../service/storage.md#indexes) specifies. So 1 hop is 1 index scan for each input Object. Our rule.

## Out of scope

- A derived struct field, and a derived property on an Interface. The Ontology service has no Interfaces. Source: Derived properties.
- A derived value that a TypeScript Function backs. Our rule.
- Subscriptions of a set with `withProperties`, and the Search Objects route. The Ontology service serves neither. Our rule.
- Property reducers on a collected value. Source: Derived properties reference.

## Related

- [Properties](./properties.md)
- [Object Sets](../ontology-sdk/object-sets.md)
- [Aggregations](../ontology-sdk/aggregations.md)
- [Object security policies](../object-security-policies.md)
- [HTTP API](../../service/http-api.md#errors)
