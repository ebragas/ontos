import type { EditsHistorySortOrder } from '@osdk/foundry.ontologies';
import { historySource, OPERATION_ID_SQL, type Reader, type Sql, utcTimeSql } from '../../db/index.ts';
import { ApiError, caught, type Fallible } from '../../errors/index.ts';
import type { CompiledObjectType, JsonValue, PrimaryKey } from '../../ontology/index.ts';
import { invalidBody, isRecord } from './shared.ts';

const PAGE_SIZE = 100;

type Position = readonly [time: string, primaryKey: PrimaryKey, operationId: string];

interface HistoryRequest {
  readonly primaryKey?: PrimaryKey;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly operationIds?: readonly string[];
  readonly sortOrder: EditsHistorySortOrder;
  readonly includeAllPreviousProperties: boolean;
  readonly pageSize: number;
  readonly after?: Position;
}

export function* readHistoryRequest(body: unknown, objectType: CompiledObjectType): Fallible<HistoryRequest, ApiError> {
  if (!isRecord(body)) return yield invalidBody();

  const {
    objectPrimaryKey,
    filters,
    sortOrder = 'newest_first',
    includeAllPreviousProperties = false,
    pageSize,
    pageToken,
  } = withoutNulls(body);

  if (sortOrder !== 'newest_first' && sortOrder !== 'oldest_first') return yield invalidBody();

  if (typeof includeAllPreviousProperties !== 'boolean') return yield invalidBody();

  return {
    ...(objectPrimaryKey === undefined ? {} : { primaryKey: yield* primaryKeyOf(objectPrimaryKey, objectType) }),
    ...(filters === undefined ? {} : yield* filterOf(filters)),
    sortOrder,
    includeAllPreviousProperties,
    pageSize: yield* pageSizeOf(pageSize),
    ...(pageToken === undefined ? {} : { after: yield* readPageToken(pageToken) }),
  };
}

function* primaryKeyOf(value: unknown, objectType: CompiledObjectType): Fallible<PrimaryKey, ApiError> {
  if (!isRecord(value)) return yield invalidBody();

  const entries = Object.entries(value);
  const [entry] = entries;

  if (entries.length !== 1 || entry === undefined || entry[0] !== objectType.primaryKey.apiName)
    return yield invalidBody();

  const key = entry[1];

  if (isRecord(key) && key['type'] === 'stringValue' && typeof key['value'] === 'string') {
    if (key['value'].includes('\0')) return yield invalidBody();

    return key['value'];
  }

  if (typeof key === 'string') {
    if (key.includes('\0')) return yield invalidBody();

    return key;
  }

  if (typeof key === 'number' && Number.isFinite(key)) return String(key);

  return yield invalidBody();
}

function* filterOf(value: unknown): Fallible<Pick<HistoryRequest, 'startTime' | 'endTime' | 'operationIds'>, ApiError> {
  if (!isRecord(value)) return yield invalidBody();

  const filter = withoutNulls(value);

  switch (filter.type) {
    case 'timestampFilter': {
      const { startTime, endTime } = filter;

      if ((startTime !== undefined && !isTime(startTime)) || (endTime !== undefined && !isTime(endTime)))
        return yield invalidBody();

      return {
        ...(startTime === undefined ? {} : { startTime }),
        ...(endTime === undefined ? {} : { endTime }),
      };
    }
    case 'operationIdsFilter': {
      const { operationIds } = filter;

      if (
        !Array.isArray(operationIds) ||
        operationIds.length > PAGE_SIZE ||
        !operationIds.every((id) => typeof id === 'string' && !id.includes('\0'))
      )
        return yield invalidBody();

      return { operationIds: operationIds as string[] };
    }
    default:
      return yield invalidBody();
  }
}

function* pageSizeOf(value: unknown): Fallible<number, ApiError> {
  if (value === undefined) return PAGE_SIZE;

  if (!Number.isInteger(value)) return yield invalidBody();

  const pageSize = value as number;

  if (pageSize <= 0) return yield new ApiError(400, 'InvalidPageSize', { pageSize });

  return Math.min(pageSize, PAGE_SIZE);
}

const TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

function isTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const day = TIME.exec(value)?.[1];

  return (
    day !== undefined && !Number.isNaN(Date.parse(value)) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)
  );
}

export function pageToken(position: Position): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function* readPageToken(token: unknown): Fallible<Position, ApiError> {
  if (typeof token !== 'string') return yield invalidBody();

  const parsed = caught((): unknown => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  const position = parsed.ok ? parsed.value : undefined;

  if (!isPosition(position)) return yield new ApiError(400, 'InvalidPageToken', { pageToken: token });

  return position;
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isTime(value[0]) &&
    typeof value[1] === 'string' &&
    !value[1].includes('\0') &&
    typeof value[2] === 'string' &&
    !value[2].includes('\0')
  );
}

export interface HistoryRow {
  readonly time: string;
  readonly timestamp: string;
  readonly primaryKey: PrimaryKey;
  readonly operationId: string;
  readonly entry: Readonly<Record<string, JsonValue>>;
}

const PRIMARY_KEY_SQL = 'primary_key COLLATE "C"';

export function historySql(reader: Reader, objectType: CompiledObjectType, request: HistoryRequest): Sql {
  const values: unknown[] = [objectType.apiName];
  const add = (value: unknown) => `$${values.push(value)}`;
  const where = ['object_type = $1'];

  if (request.primaryKey !== undefined) where.push(`primary_key = ${add(request.primaryKey)}`);

  if (request.startTime !== undefined) {
    where.push(
      `created_at >= date_trunc('milliseconds', ${add(request.startTime)}::timestamptz + interval '999 microseconds', 'UTC')`,
    );
  }

  if (request.endTime !== undefined) {
    where.push(
      `created_at < date_trunc('milliseconds', ${add(request.endTime)}::timestamptz, 'UTC') + interval '1 millisecond'`,
    );
  }

  if (request.operationIds !== undefined)
    where.push(`entry ->> 'operationId' = ANY(${add(request.operationIds)}::text[])`);

  const newest = request.sortOrder === 'newest_first';

  if (request.after) {
    const [time, primaryKey, operationId] = request.after;

    where.push(
      `(created_at, ${PRIMARY_KEY_SQL}, ${OPERATION_ID_SQL}) ${newest ? '<' : '>'} (${add(time)}::timestamptz, ${add(primaryKey)}, ${add(operationId)})`,
    );
  }

  const direction = newest ? 'DESC' : 'ASC';

  return {
    text: `SELECT ${utcTimeSql('created_at')} AS "time", ${utcTimeSql('created_at', 'MS')} AS "timestamp", primary_key AS "primaryKey", entry ->> 'operationId' AS "operationId", entry
FROM ${historySource(reader, objectType, { add })} WHERE ${where.join(' AND ')}
ORDER BY created_at ${direction}, ${PRIMARY_KEY_SQL} ${direction}, ${OPERATION_ID_SQL} ${direction} LIMIT ${add(request.pageSize + 1)}`,
    values,
  };
}

export const positionOf = (row: HistoryRow): Position => [row.time, row.primaryKey, row.operationId];

export function historyEntry(row: HistoryRow, request: HistoryRequest, objectType: CompiledObjectType): JsonValue {
  const { edit, ...fields } = row.entry;

  return {
    ...fields,
    objectPrimaryKey: { [objectType.primaryKey.apiName]: { type: 'stringValue', value: row.primaryKey } },
    timestamp: row.timestamp,
    edit: !isRecord(edit)
      ? (edit ?? null)
      : edit['type'] === 'modifyEdit'
        ? modifyEdit(edit, request)
        : edit['type'] === 'createEdit'
          ? createEdit(edit, objectType)
          : edit,
  };
}

function createEdit(edit: Readonly<Record<string, JsonValue>>, objectType: CompiledObjectType): JsonValue {
  if (!isRecord(edit['properties'])) return edit;

  const properties = Object.fromEntries(
    Object.entries(edit['properties']).filter(([property]) => property !== objectType.primaryKey.apiName),
  );

  return { ...edit, properties };
}

function modifyEdit(edit: Readonly<Record<string, JsonValue>>, request: HistoryRequest): JsonValue {
  const all = request.includeAllPreviousProperties && edit['includesAllPreviousValues'] === true;
  const properties = isRecord(edit['properties']) ? edit['properties'] : {};
  const previous = isRecord(edit['previousProperties']) ? edit['previousProperties'] : {};

  const previousProperties = all
    ? previous
    : Object.fromEntries(Object.entries(previous).filter(([property]) => property in properties));

  return { ...edit, previousProperties, includesAllPreviousValues: all };
}

function withoutNulls(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== undefined));
}
