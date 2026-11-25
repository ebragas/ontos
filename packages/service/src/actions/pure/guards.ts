import { ApiError } from '../../errors/index.ts';
import type { JsonValue } from '../../ontology/index.ts';

export function refused(): ApiError {
  return new ApiError(400, 'ApplyActionFailed');
}

export function withoutNullFields(value: JsonValue): JsonValue {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)) : value;
}

export function invalidBody(): ApiError {
  return new ApiError(400, 'Default:InvalidArgument');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
