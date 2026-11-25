import { type Fallible } from '../../errors/index.ts';
import { CompileError } from '../compiled/stored.ts';

export type JsonRecord = { readonly [key: string]: unknown };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function* record(value: unknown, path: string): Fallible<JsonRecord, CompileError> {
  if (!isRecord(value)) return yield new CompileError(`The IR field ${path} is not an object.`);

  return value;
}

export function* array(value: unknown, path: string): Fallible<readonly unknown[], CompileError> {
  if (!Array.isArray(value)) return yield new CompileError(`The IR field ${path} is not an array.`);

  return value;
}

export function* string(value: unknown, path: string): Fallible<string, CompileError> {
  if (typeof value !== 'string') return yield new CompileError(`The IR field ${path} is not a string.`);

  return value;
}

export function* tag(value: unknown, path: string): Fallible<string, CompileError> {
  return yield* string((yield* record(value, path))['type'], `${path}.type`);
}
