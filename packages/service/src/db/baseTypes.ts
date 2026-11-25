import { parseDecimal } from '../decimal/index.ts';
import type { PropertyType, ScalarType } from '../ontology/index.ts';

const DATE = /^(?!0000)\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-](0\d|1[0-5]):[0-5]\d)$/;

export function jsonValueOf(value: unknown, type: Pick<ScalarType, 'kind'>): string | number | boolean | undefined {
  switch (type.kind) {
    case 'string':
      return typeof value === 'string' && !value.includes('\0') ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31
        ? value
        : undefined;
    case 'double':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'decimal': {
      const parsed = parseDecimal(value);

      return parsed.ok ? parsed.text : undefined;
    }
    case 'date':
      return typeof value === 'string' && DATE.test(value) && isDay(value) ? value : undefined;
    case 'timestamp':
      return typeof value === 'string' &&
        TIMESTAMP.test(value) &&
        isDay(value.slice(0, 10)) &&
        !Number.isNaN(Date.parse(value))
        ? value
        : undefined;
  }
}

function isDay(date: string): boolean {
  const time = Date.parse(`${date}T00:00:00Z`);

  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === date;
}

export function columnType(type: PropertyType): string {
  switch (type.kind) {
    case 'array':
      return `${scalarColumnType(type.element)}[]`;
    case 'struct':
      return 'jsonb';
    default:
      return scalarColumnType(type);
  }
}

export function valueType(type: ScalarType): string {
  return type.kind === 'decimal' ? 'numeric' : scalarColumnType(type);
}

function scalarColumnType(type: ScalarType): string {
  switch (type.kind) {
    case 'string':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'double':
      return 'double precision';
    case 'decimal':
      return `numeric(${type.precision}, ${type.scale})`;
    case 'date':
      return 'date';
    case 'timestamp':
      return 'timestamptz';
  }
}

export function jsonForm(type: PropertyType, value: string): string {
  switch (type.kind) {
    case 'struct':
      return value;
    case 'array':
      if (type.element.kind === 'decimal') return `${value}::text[]`;

      if (type.element.kind !== 'date' && type.element.kind !== 'timestamp') return value;

      return `CASE WHEN ${value} IS NULL THEN NULL ELSE ARRAY(SELECT ${scalarForm(type.element, 'e.value')} FROM unnest(${value}) WITH ORDINALITY AS e(value, n) ORDER BY e.n) END`;
    default:
      return scalarForm(type, value);
  }
}

export function roundedSql(value: string, scale: number): string {
  return `round(${value}, ${scale})`;
}

function scalarForm(type: ScalarType, value: string): string {
  switch (type.kind) {
    case 'decimal':
      return `${value}::text`;
    case 'date':
      return `to_char(${value}::timestamp, 'YYYY-MM-DD')`;
    case 'timestamp':
      return utcTimeSql(value);
    default:
      return value;
  }
}

export function utcTimeSql(value: string, fraction: 'US' | 'MS' = 'US'): string {
  return `rtrim(rtrim(to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.${fraction}'), '0'), '.') || 'Z'`;
}
