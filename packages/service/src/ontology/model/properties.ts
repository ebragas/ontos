import { each, type Fallible } from '../../errors/index.ts';
import type { PropertyType, ScalarType } from '../compiled/links.ts';
import { CompileError } from '../compiled/stored.ts';
import { own, SIMPLE, STRUCT_FIELD_RULE } from '../parameters/scalars.ts';
import { checkStructFieldApiName } from './memberNames.ts';
import { array, isRecord, record, string, tag } from './shape.ts';

const FEATURES: Readonly<Record<string, string>> = {
  byte: 'Byte',
  short: 'Short',
  float: 'Float',
  long: 'Long',
  vector: 'Vector',
  experimentalTimeDependentV1: 'time series',
  geotimeSeriesReference: 'geotemporal series',
  cipherText: 'cipher text',
  attachment: 'attachment',
  geohash: 'Geopoint',
  geoshape: 'Geoshape',
  mediaReference: 'media reference',
};

const MAX_DECIMAL_PRECISION = 38;
const ARRAY_RULE = 'The base type of an array is String, Boolean, Integer, Double, Decimal, Date, or Timestamp.';

export function* compilePropertyType(type: unknown, path: string, owner: string): Fallible<PropertyType, CompileError> {
  if (!isRecord(type) || typeof type['type'] !== 'string') return yield new CompileError(`${owner} has no base type.`);

  yield* checkAnalyzer(type, path, owner);

  if (type['type'] === 'array')
    return yield* arrayType(yield* record(type['array'], `${path}.array`), `${path}.array`, owner);

  if (type['type'] === 'struct')
    return yield* structType(yield* record(type['struct'], `${path}.struct`), `${path}.struct`, owner);

  const scalar = yield* scalarType(type, path, owner);

  if (!scalar)
    return yield new CompileError(`${owner} has the type ${yield* typeName(type, path)}, which V1 does not have.`);

  return scalar;
}

function* arrayType(
  body: Readonly<Record<string, unknown>>,
  path: string,
  owner: string,
): Fallible<PropertyType, CompileError> {
  const reducers = body['reducers'];

  if (reducers !== undefined && reducers !== null && (yield* array(reducers, `${path}.reducers`)).length > 0) {
    return yield new CompileError(`${owner} has property reducers, which V1 does not have.`);
  }

  const subtype = yield* record(body['subtype'], `${path}.subtype`);
  const kind = yield* tag(subtype, `${path}.subtype`);

  if (kind === 'array') return yield new CompileError(`${owner} is an array of arrays. An array never holds an array.`);

  if (kind === 'struct') {
    return yield new CompileError(
      `${owner} is an array of structs, which V1 does not have. A struct Property is never an array.`,
    );
  }

  const element = yield* scalarType(subtype, `${path}.subtype`, owner);

  if (!element)
    return yield new CompileError(
      `${owner} is an array of ${yield* typeName(subtype, `${path}.subtype`)}. ${ARRAY_RULE}`,
    );

  return { kind: 'array', element };
}

function* structType(
  body: Readonly<Record<string, unknown>>,
  path: string,
  owner: string,
): Fallible<PropertyType, CompileError> {
  const structFields = yield* array(body['structFields'], `${path}.structFields`);

  if (structFields.length === 0)
    return yield new CompileError(`${owner} is a struct with no field. A struct has at least 1 field.`);

  const fields = new Map<string, ScalarType>();

  yield* each(structFields, function* (value, index): Fallible<void, CompileError> {
    const fieldPath = `${path}.structFields.${index}`;
    const field = yield* record(value, fieldPath);
    const apiName = yield* string(field['apiName'], `${fieldPath}.apiName`);

    yield* checkStructFieldApiName(apiName, owner);

    if (fields.has(apiName)) {
      return yield new CompileError(
        `2 fields of ${owner} have the API name ${apiName}. A struct field API name is unique within its struct.`,
      );
    }

    fields.set(
      apiName,
      yield* structFieldType(field['fieldType'], `${fieldPath}.fieldType`, `The struct field ${apiName} of ${owner}`),
    );
  });

  return { kind: 'struct', fields };
}

function* structFieldType(type: unknown, path: string, owner: string): Fallible<ScalarType, CompileError> {
  yield* checkAnalyzer(type, path, owner);

  const kind = yield* tag(type, path);

  if (kind === 'array' || kind === 'struct') {
    return yield new CompileError(
      `${owner} is ${kind === 'array' ? 'an array' : 'a struct'}. A struct field is never a struct or an array.`,
    );
  }

  const scalar = yield* scalarType(type, path, owner);

  if (!scalar)
    return yield new CompileError(`${owner} has the type ${yield* typeName(type, path)}. ${STRUCT_FIELD_RULE}`);

  return scalar;
}

function* scalarType(type: unknown, path: string, owner: string): Fallible<ScalarType | undefined, CompileError> {
  const kind = yield* tag(type, path);
  const simple = own(SIMPLE, kind);

  if (simple) return simple;

  if (kind === 'decimal')
    return yield* decimalType(yield* record((yield* record(type, path))['decimal'], `${path}.decimal`), owner);

  return undefined;
}

function* typeName(type: unknown, path: string): Fallible<string, CompileError> {
  const kind = yield* tag(type, path);

  if (kind === 'marking') {
    const markingType = (yield* record((yield* record(type, path))['marking'], `${path}.marking`))['markingType'];

    return markingType === 'MANDATORY'
      ? 'marking MANDATORY (mandatory control)'
      : `marking ${String(markingType)} (marking property)`;
  }

  const feature = own(FEATURES, kind);

  return feature ? `${kind} (${feature})` : kind;
}

function* decimalType(decimal: Readonly<Record<string, unknown>>, owner: string): Fallible<ScalarType, CompileError> {
  const rule = `A Decimal Property declares a precision of ${MAX_DECIMAL_PRECISION} or less and a scale.`;
  const { precision, scale } = decimal;

  if (
    typeof precision !== 'number' ||
    !Number.isInteger(precision) ||
    precision < 1 ||
    precision > MAX_DECIMAL_PRECISION
  ) {
    return yield new CompileError(`${owner} has the precision ${String(precision)}. ${rule}`);
  }

  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_PRECISION) {
    return yield new CompileError(`${owner} has the scale ${String(scale)}. ${rule}`);
  }

  return { kind: 'decimal', precision, scale };
}

function* checkAnalyzer(type: unknown, path: string, owner: string): Fallible<void, CompileError> {
  if (!isRecord(type)) return;

  const isArray = type['type'] === 'array' && isRecord(type['array']);
  const strings = isArray && isRecord(type['array']) ? type['array']['subtype'] : type;

  if (!isRecord(strings) || strings['type'] !== 'string') return;

  const body = yield* record(strings['string'], `${isArray ? `${path}.array.subtype` : path}.string`);

  if (body['analyzerOverride'] !== undefined && body['analyzerOverride'] !== null) {
    return yield new CompileError(`${owner} has an analyzerOverride. V1 has only the default analyzer.`);
  }
}
