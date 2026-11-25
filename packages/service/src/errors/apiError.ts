type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNAUTHORIZED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CONFLICT'
  | 'REQUEST_ENTITY_TOO_LARGE'
  | 'INTERNAL';

interface ErrorBody {
  readonly errorCode: ErrorCode;
  readonly errorName: string;
  readonly errorInstanceId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly errorName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    errorName: string,
    parameters: Readonly<Record<string, unknown>> = {},
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(errorName);

    this.name = 'ApiError';
    this.status = status;
    this.errorName = errorName;
    this.parameters = parameters;
    this.headers = headers;
  }
}

export interface Fault {
  readonly kind: 'fault';
  readonly error: unknown;
}

export function outsideFailure(error: unknown): ApiError | Fault {
  return error instanceof ApiError ? error : { kind: 'fault', error };
}

const CALLER_VALUE_KEYS: ReadonlySet<string> = new Set([
  'parameterValue',
  'propertyValue',
  'primaryKey',
  'pageToken',
  'query',
]);

const NAME_KEYS: ReadonlyMap<string, string> = new Map([['QueryNotFound', 'query']]);

export function redactedParameters(
  errorName: string,
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters).map(([key, value]) => [
      key,
      CALLER_VALUE_KEYS.has(key) && NAME_KEYS.get(errorName) !== key ? '<redacted>' : value,
    ]),
  );
}

export function errorCodeOf(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 408:
      return 'TIMEOUT';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'REQUEST_ENTITY_TOO_LARGE';
    default:
      return 'INTERNAL';
  }
}

export function errorBody(error: ApiError, errorInstanceId: string): ErrorBody {
  return {
    errorCode: errorCodeOf(error.status),
    errorName: error.errorName,
    errorInstanceId,
    parameters: error.parameters,
  };
}
