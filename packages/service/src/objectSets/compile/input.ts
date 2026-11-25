import { ApiError, type Fallible } from '../../errors/index.ts';
import type { CompiledObjectType } from '../../ontology/index.ts';

export function* list(value: unknown, field: string): Fallible<readonly unknown[], ApiError> {
  if (!present(value)) return [];

  if (!Array.isArray(value)) return yield invalid(field);

  return value;
}

export function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function invalid(field: string, query?: unknown): ApiError {
  return new ApiError(400, 'Default:InvalidArgument', query === undefined ? { field } : { field, query });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface StructFieldName {
  readonly propertyApiName: unknown;
  readonly structFieldApiName: unknown;
}

export function* propertyName(
  entry: Readonly<Record<string, unknown>>,
  objectType: CompiledObjectType,
  name: string,
  refused?: unknown,
): Fallible<string | StructFieldName, ApiError> {
  const { field, propertyIdentifier: identifier } = entry;

  if (present(field) === present(identifier)) return yield invalid(name, refused);

  if (typeof field === 'string') return field;

  if (!isRecord(identifier)) return yield invalid(name, refused);

  switch (identifier.type) {
    case 'property':
      if (typeof identifier.apiName !== 'string') return yield invalid(name, refused);

      return identifier.apiName;
    case 'titleProperty':
      return objectType.titleKey;
    case 'primaryKeyProperty':
      return objectType.primaryKey.apiName;
    case 'structField':
      return { propertyApiName: identifier.propertyApiName, structFieldApiName: identifier.structFieldApiName };
    default:
      return yield invalid(name, refused);
  }
}
