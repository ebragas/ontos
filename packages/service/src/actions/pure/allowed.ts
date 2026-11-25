import type { ParameterEvaluatedConstraint } from '@osdk/foundry.ontologies';
import type { Bound, CompiledParameter, JsonValue, ParameterScalarType, ParameterType } from '../../ontology/index.ts';
import { compareScalar, regexOf, type Order } from '../../valueTypes/index.ts';

const MAX_OBJECTS = 1000;
export const MAX_VALUES = 10_000;

interface AllowedCheck {
  readonly constraints: ParameterEvaluatedConstraint[];
  readonly last: ParameterEvaluatedConstraint[];
  readonly valid: boolean;
}

export function checkAllowed(parameter: CompiledParameter, value: JsonValue | undefined): AllowedCheck {
  const checks: [ParameterEvaluatedConstraint, (value: JsonValue) => boolean][] = [];
  const list = parameter.type.kind === 'list' || parameter.type.kind === 'objectList';
  const structList = parameter.type.kind === 'list' && parameter.type.element.kind === 'struct';
  const size = list && !structList ? arraySize(parameter, Array.isArray(value) ? value.length : 0) : undefined;

  if (size) checks.push(size);

  const element = elementType(parameter.type);
  const values = valueChecks(parameter, element);

  for (const [constraint, fits] of values) {
    checks.push([constraint, (checked) => (list && Array.isArray(checked) ? checked.every(fits) : fits(checked))]);
  }

  const last: [ParameterEvaluatedConstraint, (value: JsonValue) => boolean][] =
    list && !size && values.length === 0
      ? [[{ type: 'arraySize' }, (checked) => !Array.isArray(checked) || checked.length <= MAX_VALUES]]
      : [];

  return {
    constraints: checks.map(([constraint]) => constraint),
    last: last.map(([constraint]) => constraint),
    valid: value === undefined || [...checks, ...last].every(([, fits]) => fits(value)),
  };
}

function arraySize(
  parameter: CompiledParameter,
  length: number,
): [ParameterEvaluatedConstraint, (value: JsonValue) => boolean] | undefined {
  const limit = parameter.type.kind === 'objectList' ? MAX_OBJECTS : MAX_VALUES;
  const { min, max } = parameter.listLength ?? {};
  const lte = max === undefined ? (length > limit ? limit : undefined) : Math.min(max, limit);

  if (min === undefined && lte === undefined) return undefined;

  const fits = (value: JsonValue) =>
    Array.isArray(value) && (min === undefined || value.length >= min) && value.length <= (lte ?? limit);

  return [
    { type: 'arraySize', ...(min === undefined ? {} : { gte: min }), ...(lte === undefined ? {} : { lte }) },
    fits,
  ];
}

function valueChecks(
  parameter: CompiledParameter,
  element: ParameterScalarType | undefined,
): [ParameterEvaluatedConstraint, (value: JsonValue) => boolean][] {
  const { allowed } = parameter;

  switch (allowed.kind) {
    case 'oneOf': {
      const options = allowed.values.map((value) => ({ value }));

      const fits = (value: JsonValue) =>
        allowed.otherValueAllowed ||
        allowed.values.some(
          (option) => element !== undefined && compareScalar(orderKind(element), option, value) === 0,
        );

      return [[{ type: 'oneOf', options, otherValuesAllowed: allowed.otherValueAllowed }, fits]];
    }
    case 'range':
    case 'datetime': {
      if (!element || (allowed.min === undefined && allowed.max === undefined)) return [];

      const { min, max } = allowed;

      const fits = (value: JsonValue) =>
        (min === undefined || above(compareScalar(orderKind(element), value, min.value), min.inclusive)) &&
        (max === undefined || above(compareScalar(orderKind(element), max.value, value), max.inclusive));

      return [[{ type: 'range', ...bound(min, 'gte', 'gt'), ...bound(max, 'lte', 'lt') }, fits]];
    }
    case 'text': {
      const checks: [ParameterEvaluatedConstraint, (value: JsonValue) => boolean][] = [];
      const { minLength, maxLength, regex } = allowed;

      if (minLength !== undefined || maxLength !== undefined) {
        const fits = (value: JsonValue) =>
          typeof value === 'string' &&
          (minLength === undefined || value.length >= minLength) &&
          (maxLength === undefined || value.length <= maxLength);

        checks.push([
          {
            type: 'stringLength',
            ...(minLength === undefined ? {} : { gte: minLength }),
            ...(maxLength === undefined ? {} : { lte: maxLength }),
          },
          fits,
        ]);
      }

      if (regex !== undefined) {
        const matches = regexOf(regex, false) ?? (() => false);

        checks.push([{ type: 'stringRegexMatch', regex }, (value) => typeof value === 'string' && matches(value)]);
      }

      return checks;
    }
    case 'boolean':
    case 'objectQuery':
    case 'struct':
      return [];
    case 'user':
      return [[{ type: 'groupMember' }, () => true]];
  }
}

function elementType(type: ParameterType): ParameterScalarType | undefined {
  switch (type.kind) {
    case 'list':
      return type.element.kind === 'struct' ? undefined : type.element;
    case 'object':
    case 'objectList':
    case 'struct':
      return undefined;
    default:
      return type;
  }
}

function bound(
  value: Bound | undefined,
  inclusive: 'gte' | 'lte',
  exclusive: 'gt' | 'lt',
): Record<string, string | number> {
  return value === undefined ? {} : { [value.inclusive ? inclusive : exclusive]: value.value };
}

function orderKind(element: ParameterScalarType): ParameterScalarType['kind'] {
  return element.kind === 'date' ? 'timestamp' : element.kind;
}

function above(order: Order | undefined, inclusive: boolean): boolean {
  return order === 1 || (inclusive && order === 0);
}
