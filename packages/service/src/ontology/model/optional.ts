import { type Fallible } from '../../errors/index.ts';
import type { Status } from '../compiled/primitives.ts';
import { CompileError } from '../compiled/stored.ts';
import { string, tag } from './shape.ts';

export function* optionalBoolean(value: unknown, path: string): Fallible<boolean | undefined, CompileError> {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'boolean') return yield new CompileError(`The IR field ${path} is not a boolean.`);

  return value;
}

export function* optionalString(value: unknown, path: string): Fallible<string | undefined, CompileError> {
  if (value === undefined || value === null) return undefined;

  return yield* string(value, path);
}

export function* status(value: unknown, path: string, owner: string): Fallible<Status, CompileError> {
  const kind = yield* tag(value, path);

  if (kind === 'experimental' || kind === 'active' || kind === 'deprecated') return kind;

  return yield new CompileError(
    `${owner} has the status ${kind}. The statuses are experimental, active, and deprecated.`,
  );
}
