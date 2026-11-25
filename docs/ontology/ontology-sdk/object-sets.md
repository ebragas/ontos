---
status: specified
---

# Object Sets

An Object Set is a set of Objects of one Object Type: a base Object Type with filters, set operations, and Link traversals on it. App code builds it with the Ontology SDK, and the client sends it to `loadObjects` and `aggregate` as one tree. Source: Object sets.

## Contract

### Members

- An Object Set tree uses these members: `base`, `filter`, `union`, `intersect`, `subtract`, and `searchAround`. The client sends them for `where`, `union`, `intersect`, `subtract`, `pivotTo`, and `$link`. Source: `@osdk/foundry.ontologies`.
- A tree can also use `withProperties` and `methodInput`. `withProperties` adds the request derived properties to its Object Set, and `methodInput` is the input row of 1 of them. [Derived properties](../object-link-types/derived-properties.md) specifies both. Source: `@osdk/foundry.ontologies`.
- A tree with any other member gets `Default:InvalidArgument`, as [HTTP API](../../service/http-api.md#errors) specifies. Our rule.

### Where clauses

- A `where` clause uses these queries: `eq`, `gt`, `gte`, `lt`, `lte`, `in`, `isNull`, `contains`, `and`, `or`, and `not`. The client sends `$ne` as `not` of `eq`. Source: `@osdk/foundry.ontologies`.
- `gt`, `gte`, `lt`, and `lte` apply to String, number, Date, and Timestamp Properties. `contains` applies to an array Property. Source: TypeScript OSDK.
- `not` matches each Object that its query does not match, also an Object whose Property is null. So `not(eq(phase, "a"))` matches an Object with a null `phase`. Our rule.
- A `where` clause takes a Property that is not Searchable, as [Properties](../object-link-types/properties.md#searchable) specifies. Only a text search query needs a Searchable Property.
- A `where` clause on a struct field uses the queries of the field's base type. The client sends it with `propertyIdentifier: { type: "structField", propertyApiName, structFieldApiName }` in place of `field`. A struct Property itself takes only `isNull` and `eq`. `isNull` matches no Object whose struct no edit set, because that struct reads as `{}`. `eq` matches no Object, also an Object whose struct has the same value. Source: `@osdk/api` `WhereClause.ts`. Our rule.
- A `where` clause on an unknown struct field gets 404 `PropertiesNotFound`, with `properties: ["<property>.<field>"]`, because a 5xx means a fault of the Ontology service, as [Observability](../../service/observability.md) specifies. Our rule.
- A `where` query of a shape that the Ontology service does not read gets 400 `Default:InvalidArgument`, with `parameters: { field: "where", query }`. `query` is the refused query, such as `{"type":"isNull","field":"businessId"}` with no `value`. So the caller sees which query to fix. Our rule.
- A value of a query on a Decimal Property is a JSON number or a Decimal string, as [Properties](../object-link-types/properties.md#base-types) specifies. It matches by its exact value. So `100`, `"100.00"`, and `"1e2"` each match the Objects with the value `100.00`. A value that is not a Decimal gets 400 `InvalidPropertyValue`, with `property`, `propertyBaseType: "Decimal"`, and `propertyValue`, as a value of the wrong type of each other base type. Our rule.
- `in` with an empty list matches every Object. Source: Load Object Set ("If an empty array is provided as the value, then the filter will match all objects in the object set").

### Text search

- A Searchable String Property that is not an array takes 4 text search queries. A text search query on a Property that is not Searchable gets `PropertiesNotSearchable`, as [Properties](../object-link-types/properties.md#searchable) specifies. Each query compares words with no regard to case. Source: TypeScript OSDK ("white-space separated words (case insensitive)").

| Query                     | Client operator            | Matches an Object whose value has                                                       |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `containsAnyTerm`         | `$containsAnyTerm`         | Any of the words                                                                        |
| `containsAllTerms`        | `$containsAllTerms`        | All of the words, in any order                                                          |
| `containsAllTermsInOrder` | `$containsAllTermsInOrder` | All of the words, in order, next to each other                                          |
| `startsWith`              | `$startsWith`              | All of the words, in order, next to each other, where the last word matches as a prefix |

- The Ontology service splits a value into words using standard analyzer rules. It ignores case. It splits at each character that is not a letter, a combining mark, or a decimal digit, with 2 exceptions: an underscore stays inside a word, and a period or an apostrophe (`'` or `’`) stays inside a word when it is between 2 letters or between 2 digits. So `O'Brien`, `foo.bar`, `3.14`, and `hello_world` are each one word, `90's` has the words `90` and `s`, and `Acme, Inc.` has the words `acme` and `inc`. It does not remove accents: `cafe` does not match `café`. Each Han ideograph is one word, and a run of Katakana is one word. Source: Text search ("The standard analyzer treats underscores and periods as part of a token rather than as separators").
- Deviation: OSDK runs text search in a dedicated search index with Lucene's standard analyzer. Ontos runs it as a PostgreSQL filter backed by a `pg_trgm` trigram index ([Storage](../../service/storage.md#indexes)), splitting at commas or semicolons between digits and colons or middle dots between letters.
- `startsWith` and `containsAllTermsInOrderPrefixLastTerm` are the same query. The words can start at any word of the value: `Cor` matches `Acme Corp Holdings`. Source: `@osdk/foundry.ontologies` ("Deprecated alias for `containsAllTermsInOrderPrefixLastTerm`").
- `regex`, `interval`, and a `fuzzy` text search get `PropertyFiltersNotSupported`, as [HTTP API](../../service/http-api.md#errors) specifies. This check comes before the Searchable check, so such a query on a Property that is not Searchable also gets `PropertyFiltersNotSupported`. Our rule.
- A text search query with `analyzerSelection: "BASE_ANALYZER"` matches as the same query with no `analyzerSelection`, because `BASE_ANALYZER` is the default. `"PHONETIC_ANALYZER"` gets 400 `UnsupportedAnalyzerSelection`, with `parameters: { analyzerSelection: "PHONETIC_ANALYZER" }`, because the Ontology service has no phonetic index. Any other `analyzerSelection` gets 400 `Default:InvalidArgument`. Our rule. `@osdk/client` 2.92.0 sends `PHONETIC_ANALYZER` for the `phoneticSearch` option of each of the 4 client operators. Sources: `AnalyzerSelection` in `build/esm/v2/_components.d.ts` and `UnsupportedAnalyzerSelection` in `build/esm/v2/_errors.d.ts` of `@osdk/foundry.ontologies` 2.87.0, and `internal/conversions/modernToLegacyWhereClause.js` of `@osdk/client` 2.92.0.
- The text search queries of 1 Object Set have at most 16 words in all. The count includes each query of each `filter` member, also inside `and`, `or`, and `not`. A larger count gets 400 `Default:InvalidArgument` with the parameters `{ "field": "where", "maximum": 16 }`, and the Ontology service reads no data. Deviation: OSDK documents no limit on the words of a text search; Ontos enforces this cap because each word adds a regex predicate to the PostgreSQL filter. Source: [palantir/foundry-platform-python](https://github.com/palantir/foundry-platform-python).
- The value of 1 text search query has at most 256 characters. A longer value gets 400 `Default:InvalidArgument` with the parameters `{ "field": "where", "maximum": 256 }`, and the Ontology service reads no data. Deviation: OSDK documents no limit on the length of a text search value; Ontos enforces this cap to bound regex evaluation time.

### Order

- `orderBy` lists Properties, each `asc` or `desc`. A field with no direction is `asc`. Source: Load Object Set.
- A null sorts as the lowest value: first for `asc`, last for `desc`. Our rule.
- Strings sort by the Unicode code points of the raw value, with no language rules. So digits come before upper case, upper case before `_`, `_` before lower case, and `é` after `z`. Source: Search Objects v1 ("The sort order for strings is based on unicode code points of the raw (non-analyzed) string").
- An `orderBy` takes a Property that is not Searchable, as [Properties](../object-link-types/properties.md#searchable) specifies.
- With no `orderBy`, the order is not specified. Source: Load Object Set ("If this object is omitted entirely, the ordering is unspecified").
- A relevance order (`orderType: "relevance"`) gets `Default:InvalidArgument`. Our rule.

### Paging

- The default `pageSize` is 1,000. The maximum is 10,000. A larger `pageSize` is reduced to 10,000, with no error. Our rule. Source of the reduction: Paging ("Requests for more than the maximum page size will be reduced to the maximum").
- A page holds `pageSize` Objects. Only the last page holds fewer. Our rule. OSDK allows a short page at "an internal memory limit". The Ontology service has no such limit, because the Ontology service streams each page, as [HTTP API](../../service/http-api.md#requests) specifies. Sources: Load Object Set ("A page may contain fewer objects than requested"), Paging ("There will always be at least one result per page as long as there are more results").
- The last page has no `nextPageToken`. The client's `fetchOne` depends on it. Source: `@osdk/client`.
- `fetchOne` of a primary key with no Object throws an API error with the message `Expected a single result but got 0 instead`. It has no `errorName` and no `statusCode`. The stock client builds it from an empty page. Source: `object/fetchSingle.js` of `@osdk/client` 2.92.0.
- A page token is opaque and short-lived. It expires 1 hour after the Ontology service sends it. A bad or expired token gets `InvalidPageToken`. A token also gets `InvalidPageToken` when a field of the request body other than `pageToken` differs from the request that got the token. Source: Paging ("Page tokens are short-lived and intended for immediate sequential use"). Our rule for the 1 hour.
- A create or a delete between 2 pages does not make the next page skip or repeat an Object that stays in the set. So the page token holds the sort values of the last Object of its page, not a count of Objects. Our rule.
- Known limit: a sort value edit, a change of the caller's permissions, a change of a Person attribute that a policy reads, or a policy publish between 2 pages may make the next page skip or repeat an Object. The read gets no error. A change of the permissions, of a Person attribute, or of a policy can hide or show a sort value, and a hidden sort value sorts as null. This is also true when `snapshot` is true, because the Ontology service ignores `snapshot`, as the deviation below states. OSDK allows the same when `snapshot` is false. Source: Load Object Set ("Setting this to false will let new results enter as you page, but you may encounter duplicate or missing items").
- A change that takes away the permission of the Object Type between 2 pages gives the next page 404 `ObjectTypeNotFound`, the same as a first page, because the Ontology service checks the request body before the page token. Our rule.
- A page token after a publish that removes a Property that the request body names gets 404 `PropertiesNotFound`. The same body with no page token gets the same error. The Ontology service checks the body against the current Ontology version before it reads the page token. Our rule.
- A page token from before a base type change of a sort Property can hold a sort value that is not a value of the new base type. That token gets 400 `InvalidPageToken`. A null sort value passes, and a hidden sort value is null in the token. A value of the new base type also passes, such as an Integer value after a change to Double. Then the read goes on. Our rule.
- The order of a Decimal sort Property is exact across pages, and the page token holds each Decimal sort value as its exact string. So a page ordered by a Decimal gives each Object 1 time across pages, also when 2 values differ only after the 15th significant digit, such as `"1.0000000000000001"` and `"1.0000000000000002"`. Our rule.
- `totalCount` is a string that counts the Objects on all pages. Our rule.
- `totalCount` and the Objects of a page come from 1 snapshot of the data, so a create or a delete during the request cannot make them disagree. An empty page also has its `totalCount`. Our rule.
- The Ontology service ignores `snapshot`. Deviation: OSDK keeps "a consistent view from before you start paging" when `snapshot` is true. We ignore it, because each page is a separate request, and a consistent view needs stored state for each read. A later version can honor it. Source: Load Object Set.

### Request size

- Each SQL query of 1 `loadObjects` or `aggregate` request selects at most 1,664 columns, the Postgres limit of a result set. A request with more gets 400 `Default:InvalidArgument` with the parameters `{ "maximumColumns": 1664 }`. Postgres refuses the query before it reads data, so the caller gets the whole error body and no part of a page. Source: [PostgreSQL limits](https://www.postgresql.org/docs/17/limits.html) ("columns in a result set", 1,664).
- A page uses about 1 column for each returned Property, 2 for each `orderBy` field, and 5 more. An empty `select` returns each stored Property and each derived property. So 830 `orderBy` fields with 1 returned Property get the 400, and 829 pass. An `aggregate` uses about 1 column for each metric. To pass, send fewer `orderBy` fields, a shorter `select`, fewer derived properties, or fewer metrics.
- Deviation: OSDK documents no such limit. Ontos maps the PostgreSQL result-column limit directly to `400 Default:InvalidArgument`.

### Objects in a page

- Each Object has `__apiName`, `__primaryKey`, and its primary key Property. It has `__rid` only when `excludeRid` is false. It has `__title` only when `select` is empty or names the title Property. Our rule.
- An empty `selectV2` returns all Properties. A Property with a null value is left out. Source: Load Object Set ("Note that null value properties will not be returned").
- The first page has `objectSetEntities` with the API name of each Object Type in the Object Set tree, in no set order. So a `searchAround` lists its start Object Type and its Link target. Later pages do not have it. The Ontology service always knows the Object Types of a set. Source: Load Object Set ("This field is only returned on the first page when entity information is available").
- [Properties](../object-link-types/properties.md#base-types) gives the JSON form of each base type. [HTTP API](../../service/http-api.md#rids) gives the form of `__rid`.

### Security

- An Object Set holds only the Objects that the person can view. A hidden Object leaves each Object Set, each page, and `totalCount`. Source: Object security policies ("Users can never read object instances or property values they are not authorized to see.").
- A `where` clause reads a Property value that a [property security policy](../object-security-policies.md) hides as null. So it matches `isNull`, and no clause that compares a value. Our rule.
- A text search does not match a hidden Property value. Our rule.
- An `orderBy` reads a hidden Property value as null, so it sorts as null. A page token holds null for it. Our rule.
- An Object of a page leaves out each hidden Property, as it leaves out a null Property. Our rule.
- A `loadObjects` response keeps `propertySecurities: []`, also when a property security policy hides a value, because the Ontology service has no markings to list. Our rule.

## Out of scope

- `nearestNeighbors`: The Ontology service has no vector Properties. Source: TypeScript OSDK.
- Interface members: `interfaceBase`, `interfaceLinkSearchAround`, `asType`, and `asBaseObjectTypes`. The Ontology service has no Interfaces. Source: `@osdk/foundry.ontologies`.
- `static` and `reference` Object Sets, and saved or temporary Object Sets. Source: `@osdk/foundry.ontologies`.
- The text queries `regex` and `interval`, and `fuzzy` matching: OSDK does not describe them. Source: TypeScript OSDK.
- Phonetic text search (`phoneticSearch`), as [Text search](#text-search) specifies.
- Relevance order and `__score`: OSDK does not document its scoring. Source: Load Object Set.
- Order by a struct Property or a struct field: not implemented in v1.0. Source: `@osdk/api` `FetchPageArgs.ts`.
- Geo queries: The Ontology service has no Geopoint or Geoshape Properties. Source: [Properties](../object-link-types/properties.md#out-of-scope).
- `loadLinks` and subscriptions. Source: `@osdk/foundry.ontologies`.

## Related

- [Aggregations](./aggregations.md)
- [Ontology SDK](./ontology-sdk.md)
- [HTTP API](../../service/http-api.md)
- [Link Types](../object-link-types/link-types.md)
- [Properties](../object-link-types/properties.md)
