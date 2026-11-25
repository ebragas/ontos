import { parseDecimal } from '../../decimal/index.ts';
import { each, type Fallible } from '../../errors/index.ts';
import type { AllowedValues } from '../compiled/conditions.ts';
import type { Bound, ParameterType } from '../compiled/parameters.ts';
import type { JsonValue } from '../compiled/primitives.ts';
import { CompileError } from '../compiled/stored.ts';
import { optionalBoolean } from '../model/optional.ts';
import { array, isRecord, record, string, tag, type JsonRecord } from '../model/shape.ts';
import { own } from './scalars.ts';

const OUTSIDE_ALLOWED: Readonly<Record<string, string>> = {
  multipassGroup: 'groups',
  cbacMarking: 'markings',
  mandatoryMarking: 'markings',
  organizationMarking: 'markings',
  valueType: 'value types',
};

const FITS: Readonly<Record<AllowedValues['kind'], readonly string[]>> = {
  oneOf: ['string', 'boolean', 'integer', 'double', 'decimal', 'date', 'timestamp'],
  range: ['integer', 'double', 'decimal'],
  text: ['string'],
  datetime: ['date', 'timestamp'],
  boolean: ['boolean'],
  objectQuery: ['object', 'objectList'],
  struct: ['struct'],
  user: ['string'],
};

function* orEmpty(value: unknown, path: string, expected: string): Fallible<JsonRecord | undefined, CompileError> {
  const kind = yield* tag(value, path);

  if (kind === 'empty') return undefined;

  if (kind !== expected)
    return yield new CompileError(`The IR field ${path} has the kind ${kind}, not ${expected} or empty.`);

  return yield* record((yield* record(value, path))[kind], `${path}.${kind}`);
}

function* optionalNumber(value: unknown, path: string): Fallible<number | undefined, CompileError> {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'number') return yield new CompileError(`The IR field ${path} is not a number.`);

  return value;
}

export function* optionalLength(value: unknown, path: string): Fallible<number | undefined, CompileError> {
  const length = yield* optionalNumber(value, path);

  if (length !== undefined && (!Number.isInteger(length) || length < 0))
    return yield new CompileError(`The IR field ${path} is not a whole number of 0 or more.`);

  return length;
}

export function* allowedValues(
  value: unknown,
  path: string,
  owner: string,
  type: ParameterType,
): Fallible<AllowedValues, CompileError> {
  const kind = yield* tag(value, path);
  const feature = own(OUTSIDE_ALLOWED, kind);

  if (feature)
    return yield new CompileError(`${owner} has allowed values for ${feature} (${kind}), which V1 does not have.`);

  const body = (yield* record(value, path))[kind];
  const bodyPath = `${path}.${kind}`;
  let allowed: AllowedValues;

  switch (kind) {
    case 'oneOf': {
      const oneOf = yield* orEmpty(body, bodyPath, 'oneOf');

      const values = oneOf
        ? yield* each(
            yield* array(oneOf['labelledValues'], `${bodyPath}.oneOf.labelledValues`),
            function* (labelled, i): Fallible<JsonValue, CompileError> {
              return yield* staticValue(
                (yield* record(labelled, `${bodyPath}.oneOf.labelledValues.${i}`))['value'],
                `${bodyPath}.oneOf.labelledValues.${i}.value`,
                owner,
              );
            },
          )
        : [];

      const other =
        oneOf && isRecord(oneOf['otherValueAllowed'])
          ? yield* optionalBoolean(oneOf['otherValueAllowed']['allowed'], `${bodyPath}.oneOf.otherValueAllowed.allowed`)
          : undefined;

      allowed = { kind: 'oneOf', values, otherValueAllowed: other ?? false };

      break;
    }
    case 'range': {
      const range = yield* orEmpty(body, bodyPath, 'range');

      allowed = { kind: 'range', ...(yield* bounds(range, `${bodyPath}.range`, owner, rangeBound)) };

      break;
    }
    case 'datetime': {
      const range = yield* orEmpty(body, bodyPath, 'datetime');

      allowed = { kind: 'datetime', ...(yield* bounds(range, `${bodyPath}.datetime`, owner, dateBound)) };

      break;
    }
    case 'text': {
      const text = yield* orEmpty(body, bodyPath, 'text');
      const minLength = yield* optionalNumber(text?.['minLength'], `${bodyPath}.text.minLength`);
      const maxLength = yield* optionalNumber(text?.['maxLength'], `${bodyPath}.text.maxLength`);

      const regex = isRecord(text?.['regex'])
        ? yield* string(text['regex']['regex'], `${bodyPath}.text.regex.regex`)
        : undefined;

      allowed = {
        kind: 'text',
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(regex === undefined ? {} : { regex }),
      };

      break;
    }
    case 'objectQuery': {
      const query = yield* orEmpty(body, bodyPath, 'objectQuery');

      if (query?.['objectSet'] !== undefined && query['objectSet'] !== null) {
        return yield new CompileError(`${owner} has a parameter filter (an Object Set), which V1 does not have.`);
      }

      allowed = { kind: 'objectQuery' };

      break;
    }
    case 'boolean':
      allowed = { kind: 'boolean' };

      break;
    case 'struct':
      allowed = { kind: 'struct' };

      break;
    case 'user': {
      const user = yield* orEmpty(body, bodyPath, 'user');

      if (user && (yield* array(user['filter'], `${bodyPath}.user.filter`)).length > 0)
        return yield new CompileError(`${owner} has user allowed values with fromGroups, which V1 does not have.`);

      allowed = { kind: 'user' };

      break;
    }
    default:
      return yield new CompileError(
        `${owner} has the allowed values ${kind}, which V1 does not have. The kinds are oneOf, range, text, datetime, boolean, objectQuery, struct, and user.`,
      );
  }

  const element = type.kind === 'list' ? type.element : type;

  if (!FITS[allowed.kind].includes(element.kind)) {
    return yield new CompileError(
      `${owner} has the allowed values ${allowed.kind}, which do not fit its type ${element.kind}.`,
    );
  }

  return element.kind === 'decimal' ? yield* exactAllowed(allowed, owner) : allowed;
}

function* exactAllowed(allowed: AllowedValues, owner: string): Fallible<AllowedValues, CompileError> {
  const exact = function* (bound: Bound): Fallible<Bound, CompileError> {
    return { ...bound, value: yield* exactDecimal(bound.value, owner) };
  };

  switch (allowed.kind) {
    case 'oneOf':
      return {
        ...allowed,
        values: yield* each(allowed.values, function* (value): Fallible<string, CompileError> {
          return yield* exactDecimal(value, owner);
        }),
      };
    case 'range': {
      const { min, max } = allowed;

      return {
        kind: 'range',
        ...(min === undefined ? {} : { min: yield* exact(min) }),
        ...(max === undefined ? {} : { max: yield* exact(max) }),
      };
    }
    default:
      return allowed;
  }
}

export function* exactDecimal(value: JsonValue, owner: string): Fallible<string, CompileError> {
  const parsed = parseDecimal(value);

  if (!parsed.ok || !parseDecimal(parsed.text).ok)
    return yield new CompileError(
      `${owner} has the static value ${JSON.stringify(value)} for a Decimal, which is not a Decimal.`,
    );

  return parsed.text;
}

function* bounds(
  range: JsonRecord | undefined,
  path: string,
  owner: string,
  bound: (value: unknown, path: string, owner: string) => Fallible<Bound, CompileError>,
): Fallible<{ min?: Bound; max?: Bound }, CompileError> {
  if (!range) return {};

  const { minimum, maximum } = range;

  return {
    ...(minimum === undefined || minimum === null ? {} : { min: yield* bound(minimum, `${path}.minimum`, owner) }),
    ...(maximum === undefined || maximum === null ? {} : { max: yield* bound(maximum, `${path}.maximum`, owner) }),
  };
}

function* boundValue(value: unknown, path: string, owner: string): Fallible<string | number, CompileError> {
  if ((yield* tag(value, path)) !== 'staticValue')
    return yield new CompileError(`${owner} has a bound that is not a static value, which V1 does not have.`);

  const bound = yield* staticValue((yield* record(value, path))['staticValue'], `${path}.staticValue`, owner);

  if (typeof bound !== 'string' && typeof bound !== 'number')
    return yield new CompileError(`${owner} has a bound that is not a number or a string.`);

  return bound;
}

function* rangeBound(value: unknown, path: string, owner: string): Fallible<Bound, CompileError> {
  const bound = yield* record(value, path);

  return {
    value: yield* boundValue(bound['value'], `${path}.value`, owner),
    inclusive: (yield* optionalBoolean(bound['inclusive'], `${path}.inclusive`)) ?? true,
  };
}

function* dateBound(value: unknown, path: string, owner: string): Fallible<Bound, CompileError> {
  const bound = yield* record(value, path);
  const kind = yield* tag(bound['value'], `${path}.value`);

  if (kind !== 'fixed')
    return yield new CompileError(
      `${owner} has a ${kind} date bound, which V1 does not have. A date bound is a fixed value.`,
    );

  return {
    value: yield* boundValue((yield* record(bound['value'], `${path}.value`))['fixed'], `${path}.value.fixed`, owner),
    inclusive: (yield* optionalBoolean(bound['inclusive'], `${path}.inclusive`)) ?? true,
  };
}

const isString = (value: unknown): value is string => typeof value === 'string';

const isDouble = (value: unknown): value is number | string =>
  typeof value === 'number' || value === 'NaN' || value === 'Infinity' || value === '-Infinity';

const STATIC_VALUES: Readonly<Record<string, { readonly fits: (value: unknown) => boolean; readonly list: string }>> = {
  boolean: { fits: (value) => typeof value === 'boolean', list: 'booleans' },
  integer: { fits: Number.isInteger, list: 'integers' },
  double: { fits: isDouble, list: 'doubles' },
  string: { fits: isString, list: 'strings' },
  timestamp: { fits: isString, list: 'timestamps' },
  date: { fits: isString, list: 'dates' },
  decimal: { fits: isString, list: 'decimals' },
};

const WRAPPED: Readonly<Record<string, string>> = { date: 'dateValue', decimal: 'decimalValue' };

export function* staticValue(value: unknown, path: string, owner: string): Fallible<JsonValue, CompileError> {
  const kind = yield* tag(value, path);
  const body = (yield* record(value, path))[kind];
  const bodyPath = `${path}.${kind}`;

  if (kind === 'null') return null;

  const scalar = own(STATIC_VALUES, kind);

  if (scalar) {
    const wrapper = own(WRAPPED, kind);
    const single = wrapper ? (yield* record(body, bodyPath))[wrapper] : body;

    if (!scalar.fits(single))
      return yield new CompileError(
        `The IR field ${wrapper ? `${bodyPath}.${wrapper}` : bodyPath} is not a ${kind} value.`,
      );

    return single as JsonValue;
  }

  const list = kind.endsWith('List') ? own(STATIC_VALUES, kind.slice(0, -'List'.length)) : undefined;

  if (list) {
    const values = yield* array((yield* record(body, bodyPath))[list.list], `${bodyPath}.${list.list}`);

    yield* each(values, function* (element, i): Fallible<void, CompileError> {
      if (!list.fits(element))
        return yield new CompileError(
          `The IR field ${bodyPath}.${list.list}.${i} is not a ${kind.slice(0, -'List'.length)} value.`,
        );
    });

    return values as JsonValue[];
  }

  return yield new CompileError(`${owner} has a static value of the type ${kind}, which V1 does not have.`);
}
