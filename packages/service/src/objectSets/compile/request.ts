import { ApiError, each, unsupportedFeature, type Fallible } from '../../errors/index.ts';
import { invalid, isRecord, list, present } from './input.ts';

export * from './input.ts';

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10_000;

export type PropertySelector =
  | { readonly kind: 'property'; readonly apiName: string }
  | { readonly kind: 'titleProperty' }
  | { readonly kind: 'primaryKeyProperty' };

export interface OrderField {
  readonly apiName: string;
  readonly direction: 'asc' | 'desc';
}

interface LoadObjectsRequest {
  readonly objectSet: unknown;
  readonly select: readonly PropertySelector[];
  readonly orderBy: readonly OrderField[];
  readonly pageSize: number;
  readonly pageToken?: string;
  readonly excludeRid: boolean;
  readonly loadOntologyDefinedDerivedProperties?: boolean;
}

export function* readLoadObjectsRequest(body: unknown): Fallible<LoadObjectsRequest, ApiError> {
  if (!isRecord(body)) return yield invalid('body');

  yield* checkLoadLevel(body.defaultLoadLevel, 'defaultLoadLevel');

  yield* optionalBoolean(body.snapshot, 'snapshot');

  const select: PropertySelector[] = yield* each(yield* list(body.select, 'select'), function* (apiName): Fallible<
    PropertySelector,
    ApiError
  > {
    if (typeof apiName !== 'string') return yield invalid('select');

    return { kind: 'property', apiName };
  });

  for (const identifier of yield* list(body.selectV2, 'selectV2')) select.push(yield* selector(identifier));

  const pageToken = body.pageToken;

  if (present(pageToken) && typeof pageToken !== 'string') return yield invalid('pageToken');

  const loadOntologyDefinedDerivedProperties = yield* optionalBoolean(
    body.loadOntologyDefinedDerivedProperties,
    'loadOntologyDefinedDerivedProperties',
  );

  return {
    objectSet: body.objectSet,
    select,
    orderBy: yield* orderByOf(body.orderBy),
    pageSize: yield* pageSizeOf(body.pageSize),
    ...(typeof pageToken === 'string' ? { pageToken } : {}),
    excludeRid: (yield* optionalBoolean(body.excludeRid, 'excludeRid')) ?? false,
    ...(loadOntologyDefinedDerivedProperties === undefined ? {} : { loadOntologyDefinedDerivedProperties }),
  };
}

function* orderByOf(value: unknown): Fallible<OrderField[], ApiError> {
  if (!present(value)) return [];

  if (!isRecord(value)) return yield invalid('orderBy');

  if (value.orderType === 'relevance') return yield unsupportedFeature('relevance');

  if (present(value.orderType) && value.orderType !== 'fields') return yield invalid('orderBy');

  return yield* each(yield* list(value.fields, 'orderBy'), function* (field): Fallible<OrderField, ApiError> {
    if (!isRecord(field) || typeof field.field !== 'string') return yield invalid('orderBy');

    const direction = field.direction ?? 'asc';

    if (direction !== 'asc' && direction !== 'desc') return yield invalid('orderBy');

    return { apiName: field.field, direction };
  });
}

function* pageSizeOf(value: unknown): Fallible<number, ApiError> {
  if (!present(value)) return DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(value)) return yield invalid('pageSize');

  const pageSize = value as number;

  if (pageSize <= 0) return yield new ApiError(400, 'InvalidPageSize', { pageSize });

  return Math.min(pageSize, MAX_PAGE_SIZE);
}

const MAX_SELECTOR_DEPTH = 16;

function* selector(identifier: unknown, depth = 0): Fallible<PropertySelector, ApiError> {
  if (depth >= MAX_SELECTOR_DEPTH || !isRecord(identifier)) return yield invalid('selectV2');

  switch (identifier.type) {
    case 'property':
      if (typeof identifier.apiName !== 'string') return yield invalid('selectV2');

      return { kind: 'property', apiName: identifier.apiName };
    case 'propertyWithLoadLevel':
      yield* checkLoadLevel(identifier.loadLevel, 'selectV2');

      return yield* selector(identifier.propertyIdentifier, depth + 1);
    case 'titleProperty':
      return { kind: 'titleProperty' };
    case 'primaryKeyProperty':
      return { kind: 'primaryKeyProperty' };
    case 'structField':
      return yield unsupportedFeature('structField');
    default:
      return yield invalid('selectV2');
  }
}

function* checkLoadLevel(level: unknown, field: string): Fallible<void, ApiError> {
  if (!present(level)) return;

  if (!isRecord(level)) return yield invalid(field);

  switch (level.type) {
    case 'noLoadLevel':
      return;
    case 'extractMainValue':
    case 'applyReducersAndExtractMainValue':
    case 'applyReducers':
      return yield unsupportedFeature(level.type);
    default:
      return yield invalid(field);
  }
}

function* optionalBoolean(value: unknown, field: string): Fallible<boolean | undefined, ApiError> {
  if (!present(value)) return undefined;

  if (typeof value !== 'boolean') return yield invalid(field);

  return value;
}
