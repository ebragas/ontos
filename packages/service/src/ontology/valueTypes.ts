import { isDeepStrictEqual } from 'node:util';
import { parseDecimal } from '../decimal/index.ts';
import { each, type Fallible } from '../errors/index.ts';
import { compareScalar, regexOf } from '../valueTypes/index.ts';
import type {
  CompiledConstraint,
  CompiledValueType,
  PropertyType,
  ScalarType,
  ScalarValue,
  ValueTypeApiName,
  ValueTypeBase,
  ValueTypeRule,
} from './compiled/index.ts';
import { CompileError } from './compiled/stored.ts';
import { valueTypeRid } from './model/entityRids.ts';
import { optionalBoolean, optionalString } from './model/optional.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from './model/shape.ts';

type Kind = ScalarType['kind'];

const KINDS: ReadonlySet<string> = new Set<Kind>([
  'string',
  'boolean',
  'integer',
  'double',
  'decimal',
  'date',
  'timestamp',
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const BOOLEANS: Readonly<Record<string, readonly boolean[]>> = {
  TRUE_VALUE: [true],
  FALSE_VALUE: [false],
  NULL_VALUE: [],
};

export function* compileValueTypes(
  ir: JsonRecord,
  namespace: string,
): Fallible<ReadonlyMap<ValueTypeApiName, CompiledValueType>, CompileError> {
  const compiled = new Map<ValueTypeApiName, CompiledValueType>();
  const root = ir['valueTypes'];

  if (root === undefined || root === null) return compiled;

  const path = 'valueTypes.valueTypes';

  yield* each(yield* array((yield* record(root, 'valueTypes'))['valueTypes'], path), function* (entry, i): Fallible<
    void,
    CompileError
  > {
    const valueType = yield* compileValueType(yield* record(entry, `${path}.${i}`), `${path}.${i}`, namespace);

    if (compiled.has(valueType.apiName)) {
      return yield new CompileError(
        `2 value types have the API name ${valueType.apiName}. A publish holds 1 definition of each value type.`,
      );
    }

    compiled.set(valueType.apiName, valueType);
  });

  return compiled;
}

export function* propertyValueType(
  property: JsonRecord,
  path: string,
  owner: string,
  type: PropertyType,
  valueTypes: ReadonlyMap<ValueTypeApiName, CompiledValueType>,
): Fallible<CompiledValueType | undefined, CompileError> {
  const constraints = property['dataConstraints'];
  const copyPath = `${path}.dataConstraints.propertyTypeConstraints`;
  const copyValue = isRecord(constraints) ? constraints['propertyTypeConstraints'] : undefined;
  const copy = copyValue === undefined || copyValue === null ? [] : yield* array(copyValue, copyPath);
  const reference = property['valueType'];

  if (reference === undefined || reference === null) {
    if (copy.length > 0)
      return yield new CompileError(
        `${owner} has propertyTypeConstraints and no value type. Only a value type gives a Property constraints.`,
      );

    return undefined;
  }

  const referencePath = `${path}.valueType`;
  const named = yield* record(reference, referencePath);
  const apiName = yield* string(named['apiName'], `${referencePath}.apiName`);
  const version = yield* string(named['version'], `${referencePath}.version`);
  const valueType = valueTypes.get(apiName);

  if (valueType?.version !== version)
    return yield new CompileError(`${owner} uses the value type ${apiName} ${version}, which the IR does not define.`);

  if (type.kind === 'struct')
    return yield new CompileError(
      `${owner} is a struct with the value type ${apiName}. A struct Property has no value type.`,
    );

  const propertyBase = baseName(type.kind === 'array' ? { kind: 'array', element: type.element.kind } : type);

  if (propertyBase !== baseName(valueType.baseType)) {
    return yield new CompileError(
      `${owner} has the base type ${propertyBase}, and its value type ${apiName} has the base type ${baseName(valueType.baseType)}. The base type of a Property is the base type of its value type.`,
    );
  }

  const copied = yield* each(copy, function* (entry, i): Fallible<CompiledConstraint, CompileError> {
    return yield* constraintOf(
      yield* record(entry, `${copyPath}.${i}`),
      'constraints',
      `${copyPath}.${i}`,
      valueType.baseType,
      owner,
    );
  });

  if (!isDeepStrictEqual(copied, valueType.constraints)) {
    return yield new CompileError(
      `${owner} has propertyTypeConstraints that differ from the constraints of its value type ${apiName}. The value type definition is the 1 source of its constraints.`,
    );
  }

  return valueType;
}

function* compileValueType(
  entry: JsonRecord,
  path: string,
  namespace: string,
): Fallible<CompiledValueType, CompileError> {
  const metadata = yield* record(entry['metadata'], `${path}.metadata`);
  const apiName = yield* string(metadata['apiName'], `${path}.metadata.apiName`);
  const owner = `Value type ${apiName}`;
  const versions = yield* array(entry['versions'], `${path}.versions`);

  if (versions.length !== 1)
    return yield new CompileError(`${owner} has ${versions.length} versions. A value type has exactly 1 version.`);

  const versionPath = `${path}.versions.0`;
  const version = yield* record(versions[0], versionPath);
  const displayPath = `${path}.metadata.displayMetadata`;
  const display = yield* record(metadata['displayMetadata'], displayPath);
  const description = yield* optionalString(display['description'], `${displayPath}.description`);
  const baseType = yield* baseTypeOf(version['baseType'], `${versionPath}.baseType`, owner);
  const constraintsPath = `${versionPath}.constraints`;

  return {
    apiName,
    rid: valueTypeRid(namespace, apiName),
    version: yield* string(version['version'], `${versionPath}.version`),
    status: yield* valueTypeStatus(metadata['status'], `${path}.metadata.status`, owner),
    displayName: yield* string(display['displayName'], `${displayPath}.displayName`),
    description: description === '' ? undefined : description,
    baseType,
    constraints: yield* each(yield* array(version['constraints'], constraintsPath), function* (value, i): Fallible<
      CompiledConstraint,
      CompileError
    > {
      const wrapperPath = `${constraintsPath}.${i}.constraint`;

      return yield* constraintOf(
        yield* record((yield* record(value, `${constraintsPath}.${i}`))['constraint'], wrapperPath),
        'constraint',
        wrapperPath,
        baseType,
        owner,
      );
    }),
  };
}

function* valueTypeStatus(
  value: unknown,
  path: string,
  owner: string,
): Fallible<CompiledValueType['status'], CompileError> {
  const kind = yield* tag(value, path);

  if (kind === 'active' || kind === 'deprecated') return kind;

  return yield new CompileError(`${owner} has the status ${kind}. The status of a value type is active or deprecated.`);
}

function isKind(kind: string): kind is Kind {
  return KINDS.has(kind);
}

function baseName(base: ValueTypeBase): string {
  return base.kind === 'array' ? `array of ${base.element}` : base.kind;
}

function* baseTypeOf(value: unknown, path: string, owner: string): Fallible<ValueTypeBase, CompileError> {
  const kind = yield* tag(value, path);

  if (isKind(kind)) return { kind };

  let name = kind === 'structV2' ? 'struct' : kind;

  if (kind === 'array') {
    const element = yield* tag(
      (yield* record((yield* record(value, path))['array'], `${path}.array`))['elementType'],
      `${path}.array.elementType`,
    );

    if (isKind(element)) return { kind: 'array', element };

    name = `array of ${element}`;
  }

  return yield new CompileError(
    `${owner} has the base type ${name}. The base type of a value type is String, Boolean, Integer, Double, Decimal, Date, Timestamp, or an array of 1 of them.`,
  );
}

function* constraintOf(
  entry: JsonRecord,
  field: 'constraint' | 'constraints',
  path: string,
  base: ValueTypeBase,
  owner: string,
): Fallible<CompiledConstraint, CompileError> {
  const message = entry['failureMessage'];
  const messagePath = `${path}.failureMessage`;

  return {
    rule: yield* ruleOf(entry[field], `${path}.${field}`, base, owner),
    failureMessage:
      message === undefined || message === null
        ? undefined
        : yield* string((yield* record(message, messagePath))['message'], `${messagePath}.message`),
  };
}

function* ruleOf(
  value: unknown,
  path: string,
  base: ValueTypeBase,
  owner: string,
): Fallible<ValueTypeRule, CompileError> {
  const kind = yield* tag(value, path);

  if (kind === 'struct' || kind === 'structV2')
    return yield new CompileError(`${owner} has a struct constraint. The Ontology service has no struct constraint.`);

  if (kind !== base.kind) return yield doesNotFit(owner, kind, base.kind);

  const bodyPath = `${path}.${kind}`;
  const body = yield* record((yield* record(value, path))[kind], bodyPath);

  return base.kind === 'array'
    ? yield* arrayRule(body, bodyPath, base.element, owner)
    : yield* scalarRule(body, bodyPath, base.kind, owner);
}

function doesNotFit(owner: string, kind: string, base: string): CompileError {
  return new CompileError(
    `${owner} has a ${kind} constraint on the base type ${base}. The constraint does not fit the base type.`,
  );
}

function* arrayRule(
  body: JsonRecord,
  path: string,
  element: Kind,
  owner: string,
): Fallible<ValueTypeRule, CompileError> {
  const size =
    body['size'] === undefined || body['size'] === null ? {} : yield* sizeOf(body['size'], `${path}.size`, owner);

  const elementConstraint = body['elementsConstraint'];

  return {
    kind: 'array',
    ...(size.minimum === undefined ? {} : { minimumSize: size.minimum }),
    ...(size.maximum === undefined ? {} : { maximumSize: size.maximum }),
    uniqueValues: (yield* optionalBoolean(body['elementsUnique'], `${path}.elementsUnique`)) ?? false,
    ...(elementConstraint === undefined || elementConstraint === null
      ? {}
      : { element: yield* ruleOf(elementConstraint, `${path}.elementsConstraint`, { kind: element }, owner) }),
  };
}

function* scalarRule(body: JsonRecord, path: string, kind: Kind, owner: string): Fallible<ValueTypeRule, CompileError> {
  if (kind === 'boolean') {
    const values = yield* array(body['allowedValues'], `${path}.allowedValues`);

    return {
      kind: 'enum',
      options: (yield* each(values, function* (value): Fallible<readonly boolean[], CompileError> {
        const options = typeof value === 'string' && Object.hasOwn(BOOLEANS, value) ? BOOLEANS[value] : undefined;

        if (!options) return yield notValue(owner, 'option', value, kind);

        return options;
      })).flat(),
    };
  }

  if (kind === 'date' || kind === 'timestamp') {
    const range = body['range'];

    if (!isRecord(range))
      return yield doesNotFit(
        owner,
        typeof body['type'] === 'string' ? body['type'] : Object.keys(body).join(', '),
        kind,
      );

    return yield* rangeRule(range, kind, owner);
  }

  const inner = yield* tag(body, path);
  const innerPath = `${path}.${inner}`;

  const fields = function* (): Fallible<JsonRecord, CompileError> {
    return yield* record(body[inner], innerPath);
  };

  if (inner === 'oneOf') {
    if (
      kind === 'string' &&
      (yield* optionalBoolean((yield* fields())['useIgnoreCase'], `${innerPath}.useIgnoreCase`)) === true
    ) {
      return yield new CompileError(
        `${owner} has an enum with useIgnoreCase: true. The Ontology service has no case-insensitive enum.`,
      );
    }

    const values = yield* array((yield* fields())['values'], `${innerPath}.values`);

    const options = yield* each(values, function* (value): Fallible<ScalarValue, CompileError> {
      const option = valueOf(value, kind);

      if (option === undefined) return yield notValue(owner, 'option', value, kind);

      return option;
    });

    return { kind: 'enum', options };
  }

  if (inner === 'range' && kind !== 'string') return yield* rangeRule(yield* fields(), kind, owner);

  if (kind === 'string') {
    if (inner === 'length') {
      const { minimum, maximum } = yield* sizeOf(yield* fields(), innerPath, owner);

      return {
        kind: 'length',
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      };
    }

    if (inner === 'regex') {
      const pattern = yield* string((yield* fields())['regexPattern'], `${innerPath}.regexPattern`);

      const partialMatch =
        (yield* optionalBoolean((yield* fields())['usePartialMatch'], `${innerPath}.usePartialMatch`)) ?? false;

      if (!regexOf(pattern, partialMatch))
        return yield new CompileError(`${owner} has the regex ${pattern}, which JavaScript RegExp does not compile.`);

      return { kind: 'regex', pattern, partialMatch };
    }

    if (inner === 'isUuid') return { kind: 'uuid' };

    if (inner === 'isRid')
      return yield new CompileError(`${owner} has an isRid constraint. The Ontology service has no RID constraint.`);
  }

  return yield doesNotFit(owner, inner, kind);
}

function* rangeRule(range: JsonRecord, kind: Kind, owner: string): Fallible<ValueTypeRule, CompileError> {
  const bound = function* (field: 'min' | 'max', role: string): Fallible<ScalarValue | undefined, CompileError> {
    const value = range[field];

    if (value === undefined || value === null) return undefined;

    const parsed = valueOf(value, kind);

    if (parsed === undefined) return yield notValue(owner, role, value, kind);

    return parsed;
  };

  const minimum = yield* bound('min', 'minimum');
  const maximum = yield* bound('max', 'maximum');

  if (minimum !== undefined && maximum !== undefined && compareScalar(kind, minimum, maximum) === 1)
    return yield aboveMaximum(owner, minimum, maximum);

  return {
    kind: 'range',
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

function* sizeOf(
  value: unknown,
  path: string,
  owner: string,
): Fallible<{ minimum?: number; maximum?: number }, CompileError> {
  const size = yield* record(value, path);

  const count = function* (field: 'minSize' | 'maxSize', role: string): Fallible<number | undefined, CompileError> {
    const bound = size[field];

    if (bound === undefined || bound === null) return undefined;

    if (typeof bound === 'number' && Number.isInteger(bound) && bound >= 0) return bound;

    return yield new CompileError(
      `${owner} has the ${role} ${JSON.stringify(bound)}, which is not a whole number of 0 or more.`,
    );
  };

  const minimum = yield* count('minSize', 'minimum');
  const maximum = yield* count('maxSize', 'maximum');

  if (minimum !== undefined && maximum !== undefined && minimum > maximum)
    return yield aboveMaximum(owner, minimum, maximum);

  return { ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) };
}

function valueOf(value: unknown, kind: Kind): ScalarValue | undefined {
  switch (kind) {
    case 'string':
      return typeof value === 'string' ? value : undefined;
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

function notValue(owner: string, role: string, value: unknown, kind: Kind): CompileError {
  return new CompileError(
    `${owner} has the ${role} ${JSON.stringify(value)}, which is not a value of the base type ${kind}.`,
  );
}

function aboveMaximum(owner: string, minimum: ScalarValue, maximum: ScalarValue): CompileError {
  return new CompileError(
    `${owner} has the minimum ${JSON.stringify(minimum)} above the maximum ${JSON.stringify(maximum)}.`,
  );
}
