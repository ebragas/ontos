import { type Fallible } from '../../errors/index.ts';
import type { ScalarType } from '../compiled/links.ts';
import type { ParameterScalarType, ParameterType } from '../compiled/parameters.ts';
import { CompileError } from '../compiled/stored.ts';
import { isRecord, record, tag, type JsonRecord } from '../model/shape.ts';

export const SIMPLE: Readonly<Record<string, Exclude<ScalarType, { kind: 'decimal' }>>> = {
  string: { kind: 'string' },
  boolean: { kind: 'boolean' },
  integer: { kind: 'integer' },
  double: { kind: 'double' },
  date: { kind: 'date' },
  timestamp: { kind: 'timestamp' },
};

function decimal(body: unknown): ParameterScalarType {
  const { precision, scale } = isRecord(body) ? body : {};

  return {
    kind: 'decimal',
    ...(typeof precision === 'number' ? { precision } : {}),
    ...(typeof scale === 'number' ? { scale } : {}),
  };
}

export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function scalarOf(kind: string, body: unknown): ParameterScalarType | undefined {
  return kind === 'decimal' ? decimal(body) : own(SIMPLE, kind);
}

export const STRUCT_FIELD_RULE =
  'The base type of a struct field is String, Boolean, Integer, Double, Decimal, Date, or Timestamp.';

export function* structOf(
  fieldTypes: JsonRecord,
  path: string,
  owner: string,
  field?: (value: unknown, path: string, name: string) => Fallible<{ type: unknown; required: boolean }, CompileError>,
): Fallible<ParameterType, CompileError> {
  const fields = new Map<string, { type: ParameterScalarType; required: boolean }>();

  for (const [name, value] of Object.entries(fieldTypes)) {
    const fieldPath = `${path}.${name}`;
    const { type, required } = field ? yield* field(value, fieldPath, name) : { type: value, required: false };
    const kind = yield* tag(type, fieldPath);
    const scalar = scalarOf(kind, (yield* record(type, fieldPath))[kind]);

    if (!scalar)
      return yield new CompileError(`The field ${name} of ${owner} has the type ${kind}. ${STRUCT_FIELD_RULE}`);

    fields.set(name, { type: scalar, required });
  }

  if (fields.size === 0) return yield new CompileError(`${owner} is a struct with no field.`);

  return { kind: 'struct', fields };
}
