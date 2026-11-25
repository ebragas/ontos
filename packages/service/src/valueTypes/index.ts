import { compareDecimal, parseDecimal } from '../decimal/index.ts';
import { caught } from '../errors/index.ts';
import type { CompiledConstraint, CompiledValueType, JsonValue, ScalarType, ValueTypeRule } from '../ontology/index.ts';

export type Order = -1 | 0 | 1;

type Kind = ScalarType['kind'];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const scalarText = (value: JsonValue): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);

export function compareScalar(kind: Kind, left: JsonValue, right: JsonValue): Order | undefined {
  switch (kind) {
    case 'decimal': {
      const exactLeft = parseDecimal(left);
      const exactRight = parseDecimal(right);

      return exactLeft.ok && exactRight.ok ? compareDecimal(exactLeft.text, exactRight.text) : undefined;
    }
    case 'integer':
    case 'double':
      return sign(Number(left), Number(right));
    case 'timestamp':
      return sign(Date.parse(scalarText(left)), Date.parse(scalarText(right)));
    default:
      return sign(scalarText(left), scalarText(right));
  }
}

function sign<T extends number | string>(left: T, right: T): Order | undefined {
  if (left < right) return -1;

  if (left > right) return 1;

  return left === right ? 0 : undefined;
}

export function regexOf(pattern: string, partialMatch: boolean): ((value: string) => boolean) | undefined {
  const compiled = caught(() => {
    const alone = new RegExp(pattern);

    return partialMatch ? alone : new RegExp(`^(?:${pattern})$`);
  });

  if (!compiled.ok) return undefined;

  const regex = compiled.value;

  return (value) => regex.test(value);
}

export function valueTypeCheck(valueType: CompiledValueType): (value: JsonValue) => CompiledConstraint | undefined {
  const { baseType } = valueType;
  const kind = baseType.kind === 'array' ? baseType.element : baseType.kind;
  const tests = valueType.constraints.map((constraint) => [constraint, ruleTest(constraint.rule, kind)] as const);

  return (value) => tests.find(([, test]) => !test(value))?.[0];
}

function ruleTest(rule: ValueTypeRule, kind: Kind): (value: JsonValue) => boolean {
  const atMost = (left: JsonValue, right: JsonValue) => {
    const order = compareScalar(kind, left, right);

    return order !== undefined && order <= 0;
  };

  switch (rule.kind) {
    case 'enum':
      return (value) => rule.options.some((option) => compareScalar(kind, option, value) === 0);
    case 'range': {
      const { minimum, maximum } = rule;

      return (value) =>
        (minimum === undefined || atMost(minimum, value)) && (maximum === undefined || atMost(value, maximum));
    }
    case 'length':
      return (value) => typeof value === 'string' && within(value.length, rule.minimum, rule.maximum);
    case 'regex': {
      const matches = regexOf(rule.pattern, rule.partialMatch) ?? (() => false);

      return (value) => typeof value === 'string' && matches(value);
    }
    case 'uuid':
      return (value) => typeof value === 'string' && UUID.test(value);
    case 'array': {
      const each = rule.element && ruleTest(rule.element, kind);

      return (value) =>
        Array.isArray(value) &&
        within(value.length, rule.minimumSize, rule.maximumSize) &&
        (!rule.uniqueValues || new Set(value.map((element) => uniqueKey(kind, element))).size === value.length) &&
        (each === undefined || value.every(each));
    }
  }
}

function within(size: number, minimum: number | undefined, maximum: number | undefined): boolean {
  return (minimum === undefined || size >= minimum) && (maximum === undefined || size <= maximum);
}

function uniqueKey(kind: Kind, element: JsonValue): string {
  if (kind === 'timestamp') return String(Date.parse(scalarText(element)));

  if (kind === 'decimal') {
    const exact = parseDecimal(element);

    if (exact.ok) return exact.text;
  }

  return JSON.stringify(element);
}

export function constraintText(rule: ValueTypeRule): string {
  switch (rule.kind) {
    case 'enum':
      return `is one of ${rule.options.map((option) => JSON.stringify(option)).join(', ')}`;
    case 'range': {
      const { minimum, maximum } = rule;

      const parts = [
        ...(minimum === undefined ? [] : [`at least ${JSON.stringify(minimum)}`]),
        ...(maximum === undefined ? [] : [`at most ${JSON.stringify(maximum)}`]),
      ];

      return parts.length === 0 ? 'is any value' : `is ${parts.join(' and ')}`;
    }
    case 'length':
      return `has ${bounds(rule.minimum, rule.maximum, 'any number of')} characters`;
    case 'regex':
      return rule.partialMatch
        ? `contains a match of the regex ${rule.pattern}`
        : `matches the regex ${rule.pattern} in full`;
    case 'uuid':
      return 'is a UUID';
    case 'array': {
      const size =
        rule.minimumSize === undefined && rule.maximumSize === undefined
          ? ''
          : ` of ${bounds(rule.minimumSize, rule.maximumSize, '')} elements`;

      const unique = rule.uniqueValues ? ', with no element 2 times' : '';
      const each = rule.element === undefined ? '' : `, and each element ${constraintText(rule.element)}`;

      return `is a list${size}${unique}${each}`;
    }
  }
}

function bounds(minimum: number | undefined, maximum: number | undefined, none: string): string {
  if (minimum !== undefined && maximum !== undefined) return `${minimum} to ${maximum}`;

  if (minimum !== undefined) return `at least ${minimum}`;

  if (maximum !== undefined) return `at most ${maximum}`;

  return none;
}
