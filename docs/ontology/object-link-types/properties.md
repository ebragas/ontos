---
status: specified
---

# Properties

A Property is the schema definition of one characteristic of an Object Type. A property value is the value of that Property on one Object. Its base type sets the kind of value that it holds. Sources: Properties overview, Base types.

## Contract

### Parts

- A Property has these parts: API name, display name, description, base type, array flag, nullability, and status. Source: Property metadata.
- The API name, display name, and base type are required. Source: Create an object type.
- The description is the text that people and agents read. Our rule.
- The status values are in [Object Types](./object-types.md#statuses).
- A Property can use a value type. [Value types](./value-types.md) specifies it.
- A Property is stored or derived. The Ontology service stores the value of a stored Property, and computes the value of a [derived property](./derived-properties.md) at read time. Our rule.

### API names

- A Property API name is camelCase. It starts with a lowercase letter and has only letters and digits. It has 1 to 100 characters. Source: Create an object type (naming guidelines).
- A Property API name is unique within its Object Type. Source: Create an object type.
- [Link Types](./link-types.md#api-names) gives the rule for a Property API name and a Link side API name on the same Object Type.
- The reserved words in [Object Types](./object-types.md#api-names) apply.

### Base types

- These are the supported base types. The TypeScript forms are the forms of the TypeScript OSDK. Sources: Base types, `@osdk/api` `PropertyValueMapping.ts`.

| Base type | Holds                            | TypeScript form on read | TypeScript form on write | Sample                   |
| --------- | -------------------------------- | ----------------------- | ------------------------ | ------------------------ |
| String    | Text                             | `string`                | `string`                 | `"Replace filter"`       |
| Boolean   | True or false                    | `boolean`               | `boolean`                | `true`                   |
| Integer   | A 32-bit whole number            | `number`                | `number`                 | `42`                     |
| Double    | A 64-bit floating point number   | `number`                | `number`                 | `3.14`                   |
| Decimal   | An exact decimal number          | `string`                | `string \| number`       | `"1299.95"`              |
| Date      | A calendar date, ISO 8601        | `string`                | `string`                 | `"2026-10-06"`           |
| Timestamp | A point in time, ISO 8601 in UTC | `string`                | `string`                 | `"2026-10-06T14:30:00Z"` |

- Struct is also a supported base type. [Structs](#structs) specifies it.
- [Storage](../../service/storage.md#base-type-columns) gives the Postgres column type for each base type.
- A Decimal Property declares a precision of 38 or less and a scale. Sources: `@osdk/maker` `PropertyTypeType.ts` (`precision`, `scale`), Datasets (38 is the highest precision).
- A Decimal value is a JSON string in each answer of the REST API and of the [Ontology MCP](../../service/ontology-mcp.md#tools), such as `"1299.95"`. This holds for a Property value, an array element, a struct field, a `sum`, `avg`, `min`, or `max` metric, and an Object Edit History entry. The Ontology metadata gives the type, `{ type: "decimal", precision, scale }`, not the value. Our rule.
- A read gives a Decimal Property value as the text of its `numeric(precision, scale)` column, padded with zeros to the scale, such as `"1299.90"` on scale 2. [Storage](../../service/storage.md#base-type-columns) gives the column. Our rule.
- A Decimal in a request is a JSON string or a JSON number. A number reads as its shortest text, `String(value)`. So the number `0.1 + 0.2` is `"0.30000000000000004"`, and never `"0.3"`. Our rule.
- A Decimal string matches 1 grammar: `^[+-]?(\d+(\.\d*)?|\.\d+)([eE]([+-]?\d+))?$`. It has an optional sign, digits with an optional point, and an optional exponent. So `"+1.50"`, `".5"`, `"5."`, and `"1.5e3"` are Decimals. Our rule.
- A Decimal has at most 1,000 characters, and an exponent of at most 1,000 in size. The Ontology service checks both caps before it reads the digits, so it refuses `"1e999999"` at once. A Decimal Property, a Decimal parameter, and a Decimal Function input have the same caps. Our rule.
- A value is not a Decimal when it is not a string or a number, is `NaN` or an infinity, does not match the grammar, has more than 1,000 characters, or has an exponent larger than 1,000 in size. A value over a cap is not a Decimal. It is not a value that does not fit, as [Value rules on write](#value-rules-on-write) specifies. Our rule.
- The plain form of a Decimal has no exponent, no `+`, no `-0`, and no zero at the end of a fraction. `"+1.50"` gives `"1.5"`, `"1.5e3"` gives `"1500"`, `"-0.0"` gives `"0"`, and the number `0.1 + 0.2` gives `"0.30000000000000004"`. The plain form is the text of Postgres `trim_scale($1::numeric)::text`. Our rule.
- 2 Decimals compare by their exact value, never as doubles. `"9007199254740993"` is greater than `"9007199254740992"`, and `"1.5"` equals `"1.50"`. The order is the sign of Postgres `$1::numeric - $2::numeric`. Our rule.
- A stock client of each [OSDK set](../../service/releases.md#osdk-sets) writes a Decimal as a number or a string. It reads the padded string, and gets each `sum`, `avg`, `min`, and `max` of a Decimal as an exact string. Our rule.
- App code reads a Decimal value as a string, such as `"9500.00"`. The string keeps each digit. A JavaScript number is an IEEE 754 double. A double keeps the value of a decimal with 15 significant digits or fewer. So `Number(value)` keeps the value, but drops the trailing zeros of the scale: `"9500.00"` becomes `9500`. To show the scale again, app code uses `toFixed(scale)`. Sources: `@osdk/api` `PropertyValueMapping.ts` (`decimal: string` in `PropertyValueWireToClient`), [MDN: Number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number) (a double, `toFixed`), [Double-precision floating-point format](https://en.wikipedia.org/wiki/Double-precision_floating-point_format) (at most 15 significant digits).
- For a Decimal value with more than 15 significant digits, app code uses a decimal library, such as `big.js`, or keeps the string. [Functions](../functions/functions.md#code) shows `big.js` in a Function. Our rule.

### Arrays

- A Property with the array flag holds an array of its base type. Source: Base types.
- The base type of an array Property is String, Boolean, Integer, Double, Decimal, Date, or Timestamp. Source: Base types.
- An array never holds an array. Source: Properties overview.
- Each element of a Decimal array gets the fit check of [Value rules on write](#value-rules-on-write), and is stored padded to the scale. So `[1.5, "2"]` on scale 2 reads as `["1.50", "2.00"]`. An element that does not fit gets the same 400 as a Property value, and the Action writes nothing. Our rule.

### Structs

- A struct Property holds named fields. Each field has an API name and a base type. Source: Structs.
- A struct field API name follows the rules of a Property API name. It is unique within its struct. Our rule.
- The base type of a struct field is String, Boolean, Integer, Double, Decimal, Date, or Timestamp. Sources: Structs (the list of field types holds `DECIMAL`), Actions on structs.
- A Decimal struct field declares a precision of 38 or less and a scale, as a Decimal Property does. Publish refuses a Decimal field with no precision or no scale, or with a precision over 38, with the rule of a Decimal Property: "A Decimal Property declares a precision of 38 or less and a scale." Our rule.
- A rule-backed Action writes a Decimal struct field through a struct parameter with a Decimal field. A Decimal field value gets the fit check of [Value rules on write](#value-rules-on-write), and is stored padded to the scale of the field. So `unitPrice: 12.5` on a field of scale 4 reads as `"12.5000"`, and its Object Edit History entry gives `"12.5000"`. A field sent as `null` has no value, so the read and the entry give no key for it. Deviation: the OSDK struct parameter fields cannot be Decimal (Actions on structs: "The supported base types for struct parameter fields are `BOOLEAN`, `DATE`, `DOUBLE`, `GEOPOINT`, `INTEGER`, `LONG`, `STRING`, and `TIMESTAMP`"), so a rule-backed Action cannot write a Decimal struct field. We allow a Decimal struct parameter field, because an app keeps money in a struct, and a String field moves the exact check into each app.
- A struct has at least 1 field. A struct field is never a struct or an array. Source: Structs.
- A struct Property is never an array. Our rule.
- A struct field has no nullability. A struct value can leave out any field. Source: `StructFieldType`.
- Ontology-as-code declares a struct Property with `type: "struct"` and a `structDefinition` that maps each field API name to its base type. Source: `@osdk/maker` `PropertyTypeType.ts`.
- The Ontology metadata gives a struct Property the data type `{ type: "struct", structFieldTypes: [{ apiName, dataType }] }`. Source: `wirePropertyV2ToSdkPropertyDefinition.ts`.
- A struct value in JSON is an object with one key for each field that holds a value, such as `{ "signed": "2026-07-09", "link": "https://example.com/msa" }`. Each field value has the JSON form of its base type, so a Decimal field value is a string padded to the scale of the field. A field with no value is left out. Our rule.
- A struct Property that no edit set reads as `{}`, not as null. A struct Property that an edit Function set to `null` has no key on read. Our rule.
- A struct field is never a Link. To link a field to an Object, use a foreign key Property outside the struct. Source: Structs (the list of field types).

### Keys

- The primary key Property is a String. Source: Properties overview ("In most cases, we recommend using `String` instead").
- The primary key value of an Object never changes. Source: Action scale and property limits.
- [Rules](../action-types/rules.md#values) specifies the generated UUID value. A Create object rule can use it for the primary key.
- The title key Property is never an array. Our rule.
- The primary key Property and the title key Property are never a struct. Our rule.

### Required Properties

- A Property is optional by default. An optional Property can hold null. Our rule. OSDK makes a Property required with a Required toggle (Required properties).
- Ontology-as-code declares nullability in the `@osdk/maker` shape: `nullability: { noNulls, noEmptyCollections }`. Source: `@osdk/maker` `Nullability.ts`.
- A Property with `noNulls: true` is required. The Ontology service refuses null for it. Source: Required properties.
- A required array Property with `noEmptyCollections: true` also refuses an empty array. With `noEmptyCollections: false`, it accepts an empty array. Source: Required properties ("allow empty arrays").
- The Ontology service refuses `noEmptyCollections: true` without `noNulls: true`. Our rule.
- The primary key Property is always required. It needs no nullability declaration. Source: Create an object type.

### Ontology metadata

- The Ontology metadata of a Property has no `nullable` field. A Property with `noNulls: true` that is not the primary key gets `dataConstraints: { nullability: "NOT_NULLABLE" }`. Other Properties get no `dataConstraints`. Our rule.
- So the OSDK generator types each Property in the Ontology SDK as nullable, except the primary key. The Ontology service still refuses null for a required Property. Sources: `wirePropertyV2ToSdkPropertyDefinition.ts`, `wireObjectTypeFullMetadataToSdkObjectMetadata.ts`.
- The Ontology metadata copies the type classes of each Property from the IR. When the author sets none, `@osdk/maker` writes the render hints `SELECTABLE` and `SORTABLE`. Sources: `convertObjectPropertyType.ts`, `propertyConversionUtils.ts`.
- The Ontology metadata gives a Decimal struct field the data type `{ type: "decimal", precision, scale }`, with the precision and the scale of the field. This holds for each `structFieldTypes` entry of a struct Property of an Object Type, and for the `fieldType` of a field of a struct parameter of an Action Type. Source: `DecimalType` of `@osdk/foundry.core` 2.87.0 (`precision?`, `scale?`). Our rule for the struct parameter field.
- The Ontology service gives type classes no behavior, except the kind `unique` of [Type classes](#type-classes). A Property sorts and aggregates with or without them. Source: Type classes ("type classes define additional metadata that can be interpreted by user applications").

### Type classes

- A type class with the kind `unique`, `{ kind: "unique", name: "<rule name>" }`, puts its Property in the [Uniqueness constraint](#uniqueness-constraints) with that name. Our rule.
- Only the exact kind `unique` makes a rule. A type class with the kind `Unique` or `UNIQUE` has no behavior. Our rule.
- 1 Property can be in 2 rules, such as `{ number }` and `{ number, year }`. Our rule.
- 1 rule name on 2 Object Types makes 2 rules, 1 for each Object Type. Our rule.
- The same type class 2 times on 1 Property counts 1 time. Our rule.
- The kind `unique` on an Action parameter has no behavior. Our rule.
- The Ontology metadata gives the type class `{ kind: "unique", name }` unchanged in the `typeClasses` of its Property, as [Ontology metadata](#ontology-metadata) specifies for each type class. Our rule.

### Uniqueness constraints

- A [Uniqueness constraint](../../../GLOSSARY.md) is a named rule of an Object Type. No 2 of its Objects have the same values in the Properties of the rule. Our rule. Deviation: `@osdk/maker` has no unique option ([OSDK workarounds](../../service/osdk-workarounds.md)), so Ontos adds the rule via a `unique` type class to prevent concurrent Actions from creating duplicate business identifiers.
- An author marks each Property of the rule with the type class `{ kind: "unique", name: "<rule name>" }` in stock `@osdk/maker`. Properties of 1 Object Type that share a `name` are 1 rule. [Type classes](#type-classes) specifies the type class. Our rule.

```ts
const invoice = defineObject({
  apiName: 'Invoice',
  displayName: 'Invoice',
  pluralDisplayName: 'Invoices',
  primaryKeyPropertyApiName: 'invoiceId',
  titlePropertyApiName: 'number',
  properties: {
    invoiceId: { type: 'string' },
    number: { type: 'string', typeClasses: [{ kind: 'unique', name: 'invoiceNumber' }] },
  },
});
const membership = defineObject({
  apiName: 'Membership',
  displayName: 'Membership',
  pluralDisplayName: 'Memberships',
  primaryKeyPropertyApiName: 'membershipId',
  titlePropertyApiName: 'membershipId',
  properties: {
    membershipId: { type: 'string' },
    roleId: { type: 'string', typeClasses: [{ kind: 'unique', name: 'onePersonPerRole' }] },
    personId: { type: 'string', typeClasses: [{ kind: 'unique', name: 'onePersonPerRole' }] },
  },
});
```

- A rule has 1 to 5 Properties. The compiled rule holds its name, its Properties in API name order, and its Postgres name, as [Storage](../../service/storage.md#indexes) specifies. Our rule.
- Publish refuses each of these with `CompileError`, so it gets 400 `Default:InvalidArgument`, and its `feature` names the fault. The CLI shows the same error before a deploy. Our rule.
  - The kind `unique` on the primary key Property. The primary key is unique already.
  - The kind `unique` on an array Property, on a struct Property, or on a struct field.
  - A rule with an empty name.
  - A rule with more than 5 Properties.
  - 2 rules of 1 Object Type with the same set of Properties.
- Publish accepts 2 rules where 1 holds the other, such as `{ number }` and `{ number, year }`. A rule can hold a Property with a [property security policy](../object-security-policies.md). Our rule.
- An Object with no value in 1 Property of a rule never clashes. So on a rule of 2 Properties, 2 Objects with the same value in 1 Property and no value in the other do not clash. Our rule.
- 2 values clash only when they are equal by exact value. The Ontology service never changes a value before the compare. So Decimal `"1.5"` and `"1.50"` clash, and 2 Timestamps of 1 instant with 2 offsets clash. Our rule.
- `"A"` and `"a"` do not clash, and an `é` in NFC and an `é` in NFD do not clash. Double `0` and `-0` clash. To compare without case, a Function or a value type keeps each value in 1 form, such as lowercase, before the write. Our rule.
- A String value of a Property in a rule has at most 500 UTF-8 bytes. A value of 500 bytes passes. A value of more than 500 bytes gets 400 `ApplyActionFailed`, with `originalErrorName: "Ontos:InvalidActionPropertyFormat"`, `objectType`, and `property`, as [HTTP API](../../service/http-api.md#errors) specifies. Our rule.
- The byte limit holds for a rule-backed edit and for a Function edit, and the Action then writes nothing. 5 Strings of 500 bytes fit in 1 Postgres index entry, which holds at most 2,704 bytes. Our rule.
- The Ontology service refuses each write that leaves 2 Objects of the Object Type with the same values in the Properties of a rule. The check runs at the end of the write, against the end state of the Action. This holds for a rule-backed Action and a function-backed Action, and for a create and a modify. Our rule.
- So each of these passes in 1 Action. Our rule.
  - A swap of 2 values between 2 Objects.
  - A delete and a create of 1 value.
  - A move of a pair of values from 1 Object to another.
- A write that a rule refuses gets 409 `PropertyValueAlreadyExists`, with `errorCode: "CONFLICT"` and `parameters: { objectType, constraint, properties }`. `objectType` is the API name of the Object Type, and `constraint` is the rule name. `properties` lists the Property API names of the rule in API name order. Our rule. Deviation: Ontos defines `PropertyValueAlreadyExists` so callers know which Uniqueness constraint failed.
- The error body holds no value and no primary key of the other Object, and no text of the Postgres error. A clash with an Object that a security policy hides gets the same 409. So the error shows that some Object holds the values, but not which one. The Action writes nothing, and adds no [Object Edit History](../object-edits/edit-history.md) entry. Our rule.

```json
{
  "errorCode": "CONFLICT",
  "errorName": "PropertyValueAlreadyExists",
  "parameters": { "objectType": "Membership", "constraint": "onePersonPerRole", "properties": ["personId", "roleId"] },
  "errorInstanceId": "<UUID>"
}
```

- A rule-backed Action that a rule refuses does not run again, as [Apply](../action-types/action-types.md#apply) specifies. [Writes](../../service/storage.md#writes) specifies the answer of 2 Actions that race. Our rule.
- A `VALIDATE_ONLY` apply checks no clash, because it opens no write transaction. Our rule.
- The CLI bundle holds no `pg`, as [Code layout](../../service/code-layout.md) specifies. Our rule.
- A publish that adds a rule checks the stored values, and a publish that removes a rule always passes, as [Stored-data checks](../object-edits/schema-migrations.md#stored-data-checks) specifies. Our rule.

### Security

- A Property that a [property security policy](../object-security-policies.md) hides keeps its Ontology metadata. So a Property with `noNulls: true` keeps `dataConstraints: { nullability: "NOT_NULLABLE" }`, and the person still reads null for it. Our rule.
- When a property security policy hides the title key Property, the Object of a response has no `__title`. Our rule.
- A struct Property that a property security policy hides is absent from the Object, not `{}`. Our rule.

### Searchable

- A Property is [Searchable](../../../GLOSSARY.md) by default. In the Ontology-as-code, `indexedForSearch: false` makes a Property not Searchable. When the IR has no `indexedForSearch`, the Property is Searchable, as in `@osdk/maker`. Source: Text search ("Properties must have the **Searchable** render hint enabled to be searchable").
- Searchable controls text search only. Each Searchable String Property that is not an array has a text search index, as [Storage](../../service/storage.md#indexes) specifies. Our rule.
- A filter, an `orderBy`, a metric, or a group-by accepts a Property that is not Searchable. Our rule.
- A text search query on a Property that is not Searchable gets 400 `PropertiesNotSearchable`, as [HTTP API](../../service/http-api.md#errors) specifies, because such a Property has no text search index and does not support word tokenization. Our rule.
- The Ontology metadata does not show Searchable. Our rule.

### Value rules on write

- The Ontology service checks these rules on each write. Source: Data restrictions.
  - No `NaN` or ±infinity.
  - No empty strings. The Ontology service refuses `""`. It does not convert it to null.
  - No null elements in an array.
  - A string has at most 1,000,000 bytes in UTF-8. Deviation: OSDK allows 12 MB. We allow 1,000,000 bytes, because a request to the Ontology service is at most 4.5 MB, as [HTTP API](../../service/http-api.md#requests) specifies.
  - An array has at most 100,000 elements.
  - A Decimal value is a Decimal, as [Base types](#base-types) specifies, and fits the precision and the scale of its Property. The fit applies to a Property value, to each element of a Decimal array, and to each Decimal struct field value. Our rule.
  - A Decimal value fits when it has at most `scale` digits after the point, and its absolute value is less than 10^(`precision - scale`). So `"1299.9"` fits `numeric(6, 2)`, and `"0.0012"` fits `numeric(2, 4)`, but `"0.012"` does not. The zeros that do not change the value do not count, so `"1.500"` fits scale 2, and a zero always fits. `"1299.955"` on scale 2 does not fit, and the number `0.1 + 0.2` fits no scale under 17. Our rule.
  - The Ontology service never rounds a write. A value fits exactly when Postgres `$1::numeric(p, s)` keeps its value. Postgres itself rounds a value with too many fraction digits, so the service checks the fit before it writes. Source: [Numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html) ("the system will round the value to the specified number of fractional digits"). Our rule.
  - The Ontology service writes a Decimal value that fits as its text padded with zeros to the scale: `"1299.9"` on scale 2 gives `"1299.90"`, the same text as `$1::numeric(p, s)::text`. The column and the Object Edit History entry hold this text. Our rule.
  - A struct value has only the fields of its struct. Each field value follows the rules of its base type. An edit with an unknown struct field is refused strictly so bugs are caught instead of silently dropping data. Our rule.
- When a value breaks a rule, the Ontology service refuses the write. The error names the Object Type, the Property, and the rule. Our rule.
- A value of a Property with a value type also gets the value type check, after these rules, as [Checks on write](./value-types.md#checks-on-write) specifies.
- [HTTP API](../../service/http-api.md#errors) gives the error for a value of an edit Function.
- A Decimal value that does not fit gets the error of a value that breaks a rule: 400 `ApplyActionFailed` with `originalErrorName: "Ontos:InvalidActionPropertyFormat"`, as [HTTP API](../../service/http-api.md#errors) specifies. This holds for a rule-backed Action and for a Function edit. The Action writes nothing. Our rule.
- Code that computes a Decimal rounds its result 1 time, to the scale of its Property, half away from zero. So `0.015` on scale 2 gives `0.02`, and `-0.015` gives `-0.02`. A write is never rounded. In Postgres, the rounding is `round(value, scale)`. In `big.js`, it is `round(scale, 1)`, where rounding mode 1 is `roundHalfUp`. Sources: [Mathematical functions](https://www.postgresql.org/docs/17/functions-math.html) (`round`: "Ties are broken by rounding away from zero"), `big.js` 7.0.1 (rounding mode 1). Our rule.

## Out of scope

- Byte, Short, and Float base types: OSDK gives them "limited support". Integer and Double cover them. Source: Property metadata.
- Vector: needs pgvector, and storage uses only the `pg_trgm` extension. Source: Base types.
- Time series and geotemporal series: need a separate time series store. Sources: Time series properties, Geotemporal series.
- Cipher text: needs the Cipher service. Source: Base types.
- Attachment: not implemented in v1.0. Source: Upload media.
- Integer, Date, Timestamp, and Boolean primary keys: not implemented in v1.0. Source: Properties overview.
- Mandatory control Properties: The Ontology service has no markings. Source: Mandatory control properties.
- Long: not implemented in v1.0. Source: Base types.
- Geopoint and Geoshape: not implemented in v1.0. Source: Geospatial data in the Ontology.
- Arrays of structs: not implemented in v1.0. Source: Structs.
- Long, Byte, Short, Float, and Geopoint struct fields. Source: Structs.
- The main value of a struct (`mainValue`) and the `EXTRACT_MAIN_VALUE` load level: not implemented in v1.0. Source: Search Objects.
- Media reference and media sets: not implemented in v1.0. Source: Media overview.
- Array title keys. Source: Base types.
- Render hints other than Searchable, visibility, type classes, value formatting, and conditional formatting: display and index hints for OSDK apps. Publish accepts and ignores each of them. The Ontology metadata carries render hints as type classes, with the defaults `SELECTABLE` and `SORTABLE` of `@osdk/maker`, as [Ontology metadata](#ontology-metadata) specifies. [Searchable](#searchable) specifies the Searchable render hint. Source: Property metadata.
- Analyzers other than the default standard analyzer: a publish refuses `analyzerOverride` on a String Property. [Object Sets](../ontology-sdk/object-sets.md#text-search) specifies the text search. Source: `propertyTypeTypeToOntologyIrType.ts`.
- Property reducers (Beta). Sources: Property reducers.
- Shared Properties: one Property definition that many Object Types use. A TypeScript constant in the Ontology-as-code gives the same reuse. Source: Shared properties.
- External Property ID and RID values: publish ignores a Property ID or RID in the IR. The Ontology service derives its own deterministic RIDs, as [HTTP API](../../service/http-api.md#rids) specifies. A RID is the same in the Ontology metadata and in the compiled Ontology. Source: Property metadata.

## Related

- [Object Types](./object-types.md)
- [Value types](./value-types.md)
- [Storage](../../service/storage.md)
