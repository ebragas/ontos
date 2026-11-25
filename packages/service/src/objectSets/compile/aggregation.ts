import { jsonForm, jsonValueOf, quoteName, roundedSql, type Sql } from '../../db/index.ts';
import { ApiError, each, unsupportedFeature, type Fallible } from '../../errors/index.ts';
import type { PropertyType, ScalarType } from '../../ontology/index.ts';
import type { CompiledObjectSet } from './objectSet.ts';
import { ROW } from './objects.ts';
import { invalid, isRecord, list, present, propertyName } from './request.ts';
import type { RowProperty } from './row.ts';
import { Params } from './sql.ts';
import { baseTypeName } from './where.ts';

const DEFAULT_MAX_GROUP_COUNT = 10_000;
const MAX_GROUP_COUNT = 10_000;

interface AggregateRequest {
  readonly objectSet: unknown;
  readonly metrics: readonly unknown[];
  readonly groupBy: readonly unknown[];
}

export function* readAggregateRequest(body: unknown): Fallible<AggregateRequest, ApiError> {
  if (!isRecord(body)) return yield invalid('body');

  const { accuracy } = body;

  if (present(accuracy) && accuracy !== 'REQUIRE_ACCURATE' && accuracy !== 'ALLOW_APPROXIMATE')
    return yield invalid('accuracy');

  return {
    objectSet: body.objectSet,
    metrics: yield* list(body.aggregation, 'aggregation'),
    groupBy: yield* list(body.groupBy, 'groupBy'),
  };
}

interface CompiledAggregation {
  readonly grouped: boolean;
  sql(): Sql;
  toGroup(row: Readonly<Record<string, unknown>>): Record<string, unknown>;
  excludedItems(row: Readonly<Record<string, unknown>>): number;
}

interface Metric {
  readonly name: string;
  readonly value: string;
  readonly sort: string;
  readonly direction?: 'ASC' | 'DESC';
}

interface GroupBy {
  readonly name: string;
  readonly maxGroupCount: number;
  readonly nullGroup: 'none' | 'null' | 'default';
  readonly defaultValue?: string;
  sql(params: Params, alias: string): GroupSql;
}

interface GroupSql {
  readonly group: string;
  readonly key: string;
  readonly sort: string;
  readonly join?: string;
}

export function* compileAggregation(
  request: AggregateRequest,
  set: CompiledObjectSet,
): Fallible<CompiledAggregation, ApiError> {
  const metrics = yield* each(request.metrics, (metric) => metricOf(metric, set));
  const groupBys = yield* each(request.groupBy, (groupBy) => groupByOf(groupBy, set));

  yield* checkGroupBys(groupBys, metrics);

  const limit = Math.min(...groupBys.map((groupBy) => groupBy.maxGroupCount));
  const grouped = groupBys.length > 0;

  return {
    grouped,
    sql: () => {
      const params = new Params();
      const source = set.source(params);
      const groups = groupBys.map((groupBy, index) => groupBy.sql(params, quoteName(`__range${index}`)));

      const columns = [
        ...groups.map((group, index) => `${group.key} AS ${quoteName(groupColumn(index))}`),
        ...metrics.map((metric, index) => `${metric.value} AS ${quoteName(metricColumn(index))}`),
      ];

      if (!grouped)
        return { text: `SELECT ${columns.join(', ')} FROM ${source} AS ${ROW} GROUP BY ()`, values: params.values };

      const joins = groups.map((group) => (group.join === undefined ? '' : ` ${group.join}`)).join('');

      const filters = groups
        .filter((_, index) => groupBys[index]?.nullGroup === 'none')
        .map((group) => `${group.group} IS NOT NULL`);

      const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`;

      columns.push(`count(*) OVER () AS ${quoteName(GROUPS)}`);

      const order = [...metricOrder(metrics), ...groups.map((group) => `${group.sort} ASC NULLS FIRST`)];
      const text = `SELECT ${columns.join(', ')} FROM ${source} AS ${ROW}${joins}${where} GROUP BY ${groups.map((group) => group.group).join(', ')} ORDER BY ${order.join(', ')} LIMIT ${params.add(limit)}`;

      return { text, values: params.values };
    },
    toGroup: (row) => ({
      group: Object.fromEntries(
        groupBys.map((groupBy, index) => [groupBy.name, row[groupColumn(index)] ?? groupBy.defaultValue ?? null]),
      ),
      metrics: metrics.map((metric, index) => {
        const value = row[metricColumn(index)];

        return value === null || value === undefined ? { name: metric.name } : { name: metric.name, value };
      }),
    }),
    excludedItems: (row) => Math.max(0, Number(row[GROUPS]) - limit),
  };
}

const GROUPS = '__groups';

function groupColumn(index: number): string {
  return `__group${index}`;
}

function metricColumn(index: number): string {
  return `__metric${index}`;
}

function metricOrder(metrics: readonly Metric[]): string[] {
  const ordered = metrics.filter((metric) => metric.direction !== undefined);

  if (ordered.length === 0) return ['count(*) DESC'];

  return ordered.map(
    (metric) => `${metric.sort} ${metric.direction === 'ASC' ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'}`,
  );
}

function* checkGroupBys(groupBys: readonly GroupBy[], metrics: readonly Metric[]): Fallible<void, ApiError> {
  const names = groupBys.map((groupBy) => groupBy.name);
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];

  if (duplicates.length > 0)
    return yield new ApiError(400, 'MultipleGroupByOnFieldNotSupported', { duplicateFields: duplicates });

  if (!metrics.some((metric) => metric.direction !== undefined)) return;

  if (groupBys.length > 1) return yield new ApiError(400, 'InvalidAggregationOrdering', {});

  if (groupBys.some((groupBy) => groupBy.nullGroup === 'null')) {
    return yield new ApiError(400, 'InvalidAggregationOrderingWithNullValues', {});
  }
}

const NUMERIC = new Set<PropertyType['kind']>(['integer', 'double', 'decimal', 'boolean']);
const ORDERED = new Set<PropertyType['kind']>([...NUMERIC, 'date', 'timestamp']);

function* metricOf(metric: unknown, set: CompiledObjectSet): Fallible<Metric, ApiError> {
  if (!isRecord(metric) || typeof metric.type !== 'string') return yield invalid('aggregation');

  const { type } = metric;

  if (present(metric.name) && typeof metric.name !== 'string') return yield invalid('aggregation');

  const direction = yield* directionOf(metric.direction);

  const named = (fallback: string) => ({
    name: typeof metric.name === 'string' ? metric.name : fallback,
    ...(direction === undefined ? {} : { direction }),
  });

  switch (type) {
    case 'count':
      return { ...named('count'), value: 'count(*)::double precision', sort: 'count(*)' };
    case 'approximatePercentile':
      return yield unsupportedFeature('approximatePercentile');
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'exactDistinct':
    case 'approximateDistinct':
      break;
    default:
      return yield invalid('aggregation');
  }

  const property = yield* propertyOf(metric, set, 'aggregation');
  const kind = property.type.kind;

  if (kind === 'struct') return yield unsupportedFeature(`${type} on a struct Property`);

  const column = `${ROW}.${quoteName(property.column)}`;
  const base = named(`${type}_${property.apiName}`);

  if (type === 'exactDistinct' || type === 'approximateDistinct') {
    const value = `count(DISTINCT ${column})`;

    return { ...base, value: `${value}::double precision`, sort: value };
  }

  const takes = type === 'sum' || type === 'avg' ? NUMERIC : ORDERED;

  if (!takes.has(kind)) {
    return yield new ApiError(400, 'Default:InvalidArgument', {
      metric: type,
      property: property.apiName,
      propertyBaseType: baseTypeName(property.type),
    });
  }

  const value = aggregateSql(type, column, property.type);

  if (kind === 'date' || kind === 'timestamp' || kind === 'decimal')
    return { ...base, value: jsonForm(property.type, value), sort: value };

  return { ...base, value: `${value}::double precision`, sort: value };
}

export function aggregateSql(operation: 'sum' | 'avg' | 'min' | 'max', column: string, type: PropertyType): string {
  if (type.kind === 'decimal' && operation === 'avg') return decimalAverage(column, type.scale);

  return `${operation}(${type.kind === 'boolean' ? `${column}::integer` : column})`;
}

function decimalAverage(column: string, scale: number): string {
  const sum = `sum(${column})`;
  const count = `count(${column})`;
  const units = `sign(${sum}) * div(2 * abs(${sum}) * power(10::numeric, ${scale}) + ${count}, 2 * ${count})`;

  return roundedSql(`${units} * power(10::numeric, ${-scale})`, scale);
}

function* directionOf(direction: unknown): Fallible<'ASC' | 'DESC' | undefined, ApiError> {
  if (!present(direction)) return undefined;

  if (direction !== 'ASC' && direction !== 'DESC') return yield invalid('aggregation');

  return direction;
}

function* groupByOf(groupBy: unknown, set: CompiledObjectSet): Fallible<GroupBy, ApiError> {
  if (!isRecord(groupBy) || typeof groupBy.type !== 'string') return yield invalid('groupBy');

  switch (groupBy.type) {
    case 'exact':
      return yield* exactGroupBy(groupBy, set);
    case 'fixedWidth':
      return yield* fixedWidthGroupBy(groupBy, set);
    case 'ranges':
      return yield* rangesGroupBy(groupBy, set);
    case 'duration':
      return yield* durationGroupBy(groupBy, set);
    default:
      return yield invalid('groupBy');
  }
}

function rangeGroupBy(property: RowProperty): Omit<GroupBy, 'sql'> {
  return { name: property.apiName, maxGroupCount: DEFAULT_MAX_GROUP_COUNT, nullGroup: 'none' };
}

const NUMBERS = new Set<PropertyType['kind']>(['integer', 'double', 'decimal']);
const TIMES = new Set<PropertyType['kind']>(['date', 'timestamp']);
const NUMBERS_AND_TIMES = new Set([...NUMBERS, ...TIMES]);

function* rangeType(property: RowProperty, takes: ReadonlySet<PropertyType['kind']>): Fallible<ScalarType, ApiError> {
  const { type } = property;

  if (type.kind === 'array' || type.kind === 'struct' || !takes.has(type.kind)) {
    return yield new ApiError(400, 'InvalidPropertyType', {
      property: property.apiName,
      propertyBaseType: baseTypeName(type),
    });
  }

  return type;
}

const FIXED_UNITS: ReadonlyMap<unknown, string> = new Map([
  ['MILLISECONDS', '1 millisecond'],
  ['SECONDS', '1 second'],
  ['MINUTES', '1 minute'],
  ['HOURS', '1 hour'],
  ['DAYS', '1 day'],
]);

const CALENDAR_UNITS: ReadonlyMap<unknown, string> = new Map([
  ['WEEKS', 'week'],
  ['MONTHS', 'month'],
  ['QUARTERS', 'quarter'],
  ['YEARS', 'year'],
]);

const TIMESTAMP: ScalarType = { kind: 'timestamp' };
const STRING: ScalarType = { kind: 'string' };

const MAX_DURATION_VALUE = 1_000_000;

function* durationGroupBy(
  groupBy: Readonly<Record<string, unknown>>,
  set: CompiledObjectSet,
): Fallible<GroupBy, ApiError> {
  const { value, unit } = groupBy;
  const fixed = FIXED_UNITS.get(unit);
  const calendar = CALENDAR_UNITS.get(unit);

  if (typeof value !== 'number' || (fixed === undefined && calendar === undefined)) return yield invalid('groupBy');

  const property = yield* propertyOf(groupBy, set, 'groupBy');
  const type = yield* rangeType(property, TIMES);
  const whole = Number.isInteger(value) && value >= 1 && value <= MAX_DURATION_VALUE;
  const lessThanADay = fixed !== undefined && unit !== 'DAYS';

  if (!whole || (calendar !== undefined && value !== 1) || (type.kind === 'date' && lessThanADay)) {
    return yield new ApiError(400, 'InvalidDurationGroupByValue', {});
  }

  const column = `${ROW}.${quoteName(property.column)}`;
  const time = type.kind === 'date' ? `(${column}::timestamp AT TIME ZONE 'UTC')` : column;

  return {
    ...rangeGroupBy(property),
    sql: (params) => {
      const start =
        calendar === undefined
          ? `date_bin(${params.add(value)}::integer * INTERVAL '${fixed}', ${time}, TIMESTAMPTZ '1970-01-01 00:00:00+00')`
          : `(date_trunc('${calendar}', ${time} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

      return { group: start, key: jsonForm(TIMESTAMP, start), sort: start };
    },
  };
}

function* fixedWidthGroupBy(
  groupBy: Readonly<Record<string, unknown>>,
  set: CompiledObjectSet,
): Fallible<GroupBy, ApiError> {
  const { fixedWidth } = groupBy;

  if (typeof fixedWidth !== 'number' || !Number.isFinite(fixedWidth) || fixedWidth <= 0)
    return yield invalid('groupBy');

  const property = yield* propertyOf(groupBy, set, 'groupBy');
  const type = yield* rangeType(property, NUMBERS);
  const column = `${ROW}.${quoteName(property.column)}`;

  return {
    ...rangeGroupBy(property),
    sql: (params) => {
      const width = `${params.add(fixedWidth)}::numeric`;
      const start = `(floor(${column}::numeric / ${width}) * ${width})`;

      return {
        group: start,
        key: type.kind === 'decimal' ? `${start}::text` : `${start}::double precision`,
        sort: start,
      };
    },
  };
}

const MAX_RANGES = 100;

function* rangesGroupBy(
  groupBy: Readonly<Record<string, unknown>>,
  set: CompiledObjectSet,
): Fallible<GroupBy, ApiError> {
  const { ranges } = groupBy;

  if (!Array.isArray(ranges) || ranges.length > MAX_RANGES) return yield invalid('groupBy');

  const property = yield* propertyOf(groupBy, set, 'groupBy');
  const type = yield* rangeType(property, NUMBERS_AND_TIMES);
  const boundType: ScalarType = type.kind === 'integer' ? { kind: 'double' } : type;

  function* bound(value: unknown): Fallible<unknown, ApiError> {
    const json = jsonValueOf(value, boundType);

    if (json === undefined) {
      return yield new ApiError(400, 'InvalidPropertyValue', {
        property: property.apiName,
        propertyBaseType: baseTypeName(type),
        propertyValue: value,
      });
    }

    return json;
  }

  const keys = yield* each(ranges, function* (range: unknown): Fallible<
    { startValue: unknown; endValue: unknown },
    ApiError
  > {
    if (!isRecord(range)) return yield invalid('groupBy');

    return { startValue: yield* bound(range.startValue), endValue: yield* bound(range.endValue) };
  });

  const sqlType = type.kind === 'date' ? 'date' : type.kind === 'timestamp' ? 'timestamptz' : 'numeric';
  const column = `${ROW}.${quoteName(property.column)}`;
  const value = sqlType === 'numeric' ? `${column}::numeric` : column;

  return {
    ...rangeGroupBy(property),
    sql: (params, alias) => {
      const starts = params.add(keys.map((key) => String(key.startValue)));
      const ends = params.add(keys.map((key) => String(key.endValue)));
      const join = `JOIN unnest(${starts}::${sqlType}[], ${ends}::${sqlType}[]) WITH ORDINALITY AS ${alias}(start_value, end_value, n) ON ${value} >= ${alias}.start_value AND ${value} < ${alias}.end_value`;
      const key = `(${params.add(JSON.stringify(keys))}::jsonb -> (${alias}.n::integer - 1))`;

      return { group: `${alias}.n`, key, sort: `${alias}.n`, join };
    },
  };
}

function* exactGroupBy(
  groupBy: Readonly<Record<string, unknown>>,
  set: CompiledObjectSet,
): Fallible<GroupBy, ApiError> {
  const { maxGroupCount, defaultValue, includeNullValues } = groupBy;

  if (
    present(maxGroupCount) &&
    (!Number.isSafeInteger(maxGroupCount) ||
      (maxGroupCount as number) < 1 ||
      (maxGroupCount as number) > MAX_GROUP_COUNT)
  )
    return yield invalid('groupBy');

  if (present(defaultValue) && jsonValueOf(defaultValue, STRING) === undefined) return yield invalid('groupBy');

  if (present(includeNullValues) && typeof includeNullValues !== 'boolean') return yield invalid('groupBy');

  if (typeof defaultValue === 'string' && includeNullValues === true)
    return yield new ApiError(400, 'DefaultAndNullGroupsNotSupported', {});

  const property = yield* propertyOf(groupBy, set, 'groupBy');

  if (property.type.kind === 'struct') return yield unsupportedFeature('exact group-by on a struct Property');

  if (property.type.kind === 'array') return yield unsupportedFeature('exact group-by on an array Property');

  const { type } = property;
  const column = `${ROW}.${quoteName(property.column)}`;
  const key = jsonForm(type, column);
  const sort = type.kind === 'string' ? `${column} COLLATE "C"` : column;

  const common: Omit<GroupBy, 'sql'> = {
    name: property.apiName,
    maxGroupCount: typeof maxGroupCount === 'number' ? maxGroupCount : DEFAULT_MAX_GROUP_COUNT,
    nullGroup: includeNullValues === true ? 'null' : typeof defaultValue === 'string' ? 'default' : 'none',
  };

  if (typeof defaultValue !== 'string') return { ...common, sql: () => ({ group: column, key, sort }) };

  if (!TEXT_KEYS.has(type.kind)) return { ...common, defaultValue, sql: () => ({ group: column, key, sort }) };

  return {
    ...common,
    sql: (params) => {
      const group = `COALESCE(${key}, ${params.add(defaultValue)}::text)`;

      return { group, key: group, sort: `${group} COLLATE "C"` };
    },
  };
}

const TEXT_KEYS = new Set<PropertyType['kind']>(['string', 'decimal', 'date', 'timestamp']);

function* propertyOf(
  entry: Readonly<Record<string, unknown>>,
  set: CompiledObjectSet,
  field: string,
): Fallible<RowProperty, ApiError> {
  const name = yield* propertyName(entry, set.objectType, field);

  if (typeof name !== 'string') return yield unsupportedFeature('structField');

  const property = set.row.compute(name);

  if (!property)
    return yield new ApiError(404, 'PropertiesNotFound', { objectType: set.objectType.apiName, properties: [name] });

  return property;
}
