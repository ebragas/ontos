---
status: specified
---

# Aggregations

An aggregation computes metrics, such as a count or a sum, over an [Object Set](./object-sets.md), in groups or as one total. App code calls `aggregate` on an Object Set, and the client sends `POST objectSets/aggregate`. Sources: TypeScript OSDK, Aggregate Object Set.

## Contract

### Metrics

- An aggregation takes these metrics. Sources: TypeScript OSDK, `@osdk/foundry.ontologies`.

| Metric                                 | Base types                                         |
| -------------------------------------- | -------------------------------------------------- |
| `count`                                | Any                                                |
| `sum`, `avg`                           | Integer, Double, Decimal, Boolean                  |
| `min`, `max`                           | Integer, Double, Decimal, Boolean, Date, Timestamp |
| `exactDistinct`, `approximateDistinct` | Any                                                |

- On a Boolean, `min`, `max`, `sum`, and `avg` count `false` as 0 and `true` as 1, when aggregated. An Object with no value is not counted. The value is a number. Our rule.
- `min`, `max`, `sum`, or `avg` on a String gets 400 `Default:InvalidArgument`, as [HTTP API](../../service/http-api.md#errors) specifies, because a 5xx means a fault of the Ontology service, as [Observability](../../service/observability.md) specifies. Our rule.
- The name of a metric is `count`, or `<property>.<metric>`. The response gives each metric with the name that the request sent. A metric with no name gets `<metric>_<property>`, for example `max_createdAt`. Our rule.
- A metric can order the groups (`ASC` or `DESC`) only when the aggregation groups by at most 1 Property. Source: TypeScript OSDK ("Ordering is available only when `$groupBy` names at most one property").
- The Ontology service computes `approximateDistinct` exactly. Our rule.
- A metric takes a derived property as a stored Property of its type, as [Derived properties](../object-link-types/derived-properties.md#reads) specifies. Our rule.
- A `sum`, `avg`, `min`, or `max` of a Decimal Property is an exact string with the scale of the Property. A distinct count stays a number. `sum`, `min`, and `max` are exact, so a sum past 2^53 keeps each digit: the sum of `"9007199254740993.00"` and `"1.00"` on scale 2 is `"9007199254740994.00"`. A grouped aggregation gives the same exact strings for each group. Our rule.
- `avg` of a Decimal Property is rounded 1 time to the scale of the Property, half away from zero, with the rule of [Value rules on write](../object-link-types/properties.md#value-rules-on-write). Postgres `avg(numeric)` rounds its quotient, so a `round` of it would round 2 times. The service rounds the exact average with an integer division of the exact sum by the count. So on scale 2, the average of `0.01` and `0.02` is `"0.02"`, and the average of `-0.01` and `-0.02` is `"-0.02"`. Our rule.
- An `avg` of a Decimal with a direction orders the groups by the shown value, the average rounded to the scale. The group keys order the groups that tie. Our rule.
- Deviation: OSDK types numeric metric values as doubles. Ontos returns a `sum`, `avg`, `min`, or `max` of a Decimal as an exact string, because a double loses precision past 2^53.

### Group-bys

- An aggregation takes these group-bys. Source: TypeScript OSDK.

| Group-by     | Fields                                               | Groups                                                                                                                 |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `exact`      | `maxGroupCount`, `defaultValue`, `includeNullValues` | One group for each value                                                                                               |
| `fixedWidth` | `fixedWidth`                                         | Number ranges of one width                                                                                             |
| `ranges`     | `startValue`, `endValue` for each range              | Each range includes its start value and excludes its end value                                                         |
| `duration`   | `value`, `unit`                                      | Date and Timestamp ranges of one duration. The units `weeks`, `months`, `quarters`, and `years` take only the value 1. |

- `maxGroupCount` is 10,000 by default. The groups over the limit are left out of `data` and counted in `excludedItems`, with no error. Source: Aggregate Object Set ("Items exceeding the limit are excluded from results and counted in `excludedItems`").
- A `ranges` group-by on a Decimal Property gives each bound key as its exact string, in the [plain form](../object-link-types/properties.md#base-types), also when the request sent the bound as a number. So a range sent as `startValue: 100, endValue: 200.5` has the key `{ startValue: "100", endValue: "200.5" }`. Our rule.
- A `duration` group starts in UTC, and a `weeks` range starts on Monday. The group key is the start of the range, as a Timestamp string, for example `2026-10-12T00:00:00Z`. Our rule.
- A range of more than 1 day, hour, or minute starts at a multiple of its length after 1970-01-01T00:00:00Z. So a `days` 7 range starts on a Thursday, as 1970-01-01 does. A range of more than 1 second or millisecond follows the same rule. Our rule.
- A `duration` group-by returns only the ranges that have Objects, as `exact` does, omitting empty ranges between them. Our rule.
- A metric or a group-by takes a Property that is not Searchable, as [Properties](../object-link-types/properties.md#searchable) specifies.
- A group-by takes a derived property as a stored Property of its type, as [Derived properties](../object-link-types/derived-properties.md#reads) specifies. Our rule.
- A `duration` group with `weeks`, `months`, `quarters`, or `years` and a value other than 1 gets 400 `InvalidDurationGroupByValue`, as [HTTP API](../../service/http-api.md#errors) specifies. Source: same section.

### Response

- `data` holds one entry for each group: `group`, keyed by the field that the request sent, and `metrics`, each with `name` and `value`. Source: Aggregate Object Set.
- A numeric metric value is a double, except a `sum`, `avg`, `min`, or `max` of a Decimal Property, which is a string, as [Metrics](#metrics) specifies. A Date or Timestamp metric value is a date string. Source: same section.
- With no `groupBy`, `data` holds exactly 1 entry with an empty `group`. Over an empty Object Set, its `count` is 0. With a `groupBy`, an empty Object Set gives an empty `data`. Our rule.
- `accuracy` is always `ACCURATE`, because each result is exact. The request may send either `accuracy` value. Our rule.
- The response has `excludedItems` only when the request has a `groupBy` that is not empty, 0 when no group was left out. Our rule.

### Security

- An aggregation reads only the Objects that the person can view. The count counts only them. Our rule.
- A metric skips a Property value that a [property security policy](../object-security-policies.md) hides, as it skips an Object with no value. Our rule.
- A group-by puts a hidden Property value in the null group. Our rule.

## Out of scope

- `approximatePercentile`: the client does not send it on `objectSets/aggregate`. Source: `@osdk/foundry.ontologies`.
- Metrics and group-bys on struct Properties and struct fields: not implemented in v1.0. Source: `@osdk/api` `AggregatableKeys.ts`.

## Related

- [Object Sets](./object-sets.md)
- [Ontology SDK](./ontology-sdk.md)
- [HTTP API](../../service/http-api.md)
