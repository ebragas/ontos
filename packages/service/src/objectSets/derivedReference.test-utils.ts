export type ValueType =
  | { readonly kind: 'decimal'; readonly scale: number }
  | { readonly kind: 'string' | 'integer' | 'double' | 'date' | 'timestamp' };

type Kind = ValueType['kind'];

type Value = string | number | null;

export type Row = Readonly<Record<string, Value>>;

interface LinkSide {
  readonly target: string;
  readonly many: boolean;
  readonly from: string;
  readonly to: string;
}

interface ObjectTypeModel {
  readonly key: string;
  readonly properties: Readonly<Record<string, ValueType>>;
  readonly links: Readonly<Record<string, LinkSide>>;
}

export type Model = Readonly<Record<string, ObjectTypeModel>>;

export type Dataset = Readonly<Record<string, readonly Row[]>>;

export interface Hidden {
  readonly objects: ReadonlySet<string>;
  readonly values: ReadonlySet<string>;
}

export type Query =
  | { readonly type: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; readonly field: string; readonly value: string | number }
  | { readonly type: 'isNull'; readonly field: string; readonly value: boolean }
  | { readonly type: 'in'; readonly field: string; readonly value: readonly (string | number)[] }
  | { readonly type: 'not'; readonly value: Query }
  | { readonly type: 'and' | 'or'; readonly value: readonly Query[] };

type MethodSet =
  | { readonly type: 'methodInput' }
  | { readonly type: 'searchAround'; readonly objectSet: MethodSet; readonly link: string }
  | { readonly type: 'filter'; readonly objectSet: MethodSet; readonly where: Query };

export type Operation =
  | { readonly type: 'count' }
  | {
      readonly type: 'get' | 'sum' | 'avg' | 'min' | 'max' | 'exactDistinct' | 'approximateDistinct';
      readonly selectedPropertyApiName: string;
    }
  | {
      readonly type: 'approximatePercentile';
      readonly selectedPropertyApiName: string;
      readonly approximatePercentile: number;
    }
  | { readonly type: 'collectList' | 'collectSet'; readonly selectedPropertyApiName: string; readonly limit: number };

export type Definition =
  | { readonly type: 'selection'; readonly objectSet: MethodSet; readonly operation: Operation }
  | { readonly type: 'property'; readonly apiName: string }
  | { readonly type: 'add' | 'multiply' | 'greatest' | 'least'; readonly properties: readonly Definition[] }
  | { readonly type: 'subtract' | 'divide'; readonly left: Definition; readonly right: Definition }
  | { readonly type: 'absoluteValue' | 'negate'; readonly property: Definition }
  | {
      readonly type: 'extract';
      readonly property: Definition;
      readonly part: 'DAYS' | 'MONTHS' | 'QUARTERS' | 'YEARS';
    };

export type Layers = readonly Readonly<Record<string, Definition>>[];

export type Scope = Readonly<Record<string, ResultType>>;

export type ResultType = ValueType | { readonly kind: 'array'; readonly of: ValueType };

type Json = string | number | readonly Json[];

export type Expected =
  | { readonly status: 200; readonly objects: Readonly<Record<string, Readonly<Record<string, Json>>>> }
  | { readonly status: 400; readonly errorName: 'Default:InvalidArgument' | 'InvalidDerivedPropertyDefinition' };

interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

const TEN = 10n;
const pow10 = (exponent: number): bigint => TEN ** BigInt(exponent);

function parseDec(text: string): Dec {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const units = BigInt(`${whole}${fraction}`);

  return { units: negative ? -units : units, scale: fraction.length };
}

function atScale(value: Dec, scale: number): Dec {
  if (scale < value.scale)
    throw new Error(`The reference cannot widen ${value.scale} to the smaller scale ${scale} with no rounding.`);

  return { units: value.units * pow10(scale - value.scale), scale };
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const top = numerator < 0n ? -numerator : numerator;
  const bottom = denominator < 0n ? -denominator : denominator;
  let quotient = top / bottom;

  if ((top % bottom) * 2n >= bottom) quotient += 1n;

  return negative ? -quotient : quotient;
}

function formatDec(value: Dec): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale);

  return `${negative ? '-' : ''}${whole}${value.scale > 0 ? `.${fraction}` : ''}`;
}

function compareDec(left: Dec, right: Dec): number {
  const scale = Math.max(left.scale, right.scale);
  const difference = atScale(left, scale).units - atScale(right, scale).units;

  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

const decToNumber = (value: Dec): number => Number(formatDec(value));

type Inner = Dec | bigint | number | string | null | readonly Inner[];

class Overflow extends Error {}

const INTEGER_MIN = -(2n ** 31n);
const INTEGER_MAX = 2n ** 31n - 1n;

function checked(value: bigint): bigint {
  if (value < INTEGER_MIN || value > INTEGER_MAX)
    throw new Overflow('An Integer expression does not fit in an Integer.');

  return value;
}

const isDec = (value: Inner): value is Dec => typeof value === 'object' && value !== null && !Array.isArray(value);

function inner(value: Value, type: ValueType): Inner {
  if (value === null) return null;

  if (type.kind === 'decimal') return atScale(parseDec(String(value)), type.scale);

  if (type.kind === 'integer') return BigInt(value);

  return value;
}

const innerText = (value: Inner): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
    ? String(value)
    : JSON.stringify(value);

function toNumber(value: Inner): number {
  if (isDec(value)) return decToNumber(value);

  if (typeof value === 'bigint') return Number(value);

  if (typeof value === 'number') return value;

  throw new Error(`The reference cannot read ${innerText(value)} as a number.`);
}

function toDec(value: Inner): Dec {
  if (isDec(value)) return value;

  if (typeof value === 'bigint') return { units: value, scale: 0 };

  throw new Error(`The reference cannot read ${innerText(value)} as a Decimal.`);
}

function json(value: Inner, type: ResultType): Json | null {
  if (value === null) return null;

  if (type.kind === 'array') return (value as readonly Inner[]).map((element) => json(element, type.of) ?? 'null');

  if (type.kind === 'decimal') return formatDec(atScale(toDec(value), type.scale));

  if (type.kind === 'integer') return Number(value as bigint);

  if (type.kind === 'double') return toNumber(value);

  return value as string;
}

const numeric = (kind: Kind): boolean => kind === 'integer' || kind === 'double' || kind === 'decimal';
const decimal = (scale: number): ValueType => ({ kind: 'decimal', scale });
const INTEGER: ValueType = { kind: 'integer' };
const DOUBLE: ValueType = { kind: 'double' };

function operationType(
  operation: Operation,
  selected: ValueType | undefined,
  path: readonly LinkSide[],
): ResultType | undefined {
  switch (operation.type) {
    case 'count':
      return INTEGER;
    case 'exactDistinct':
    case 'approximateDistinct':
      return selected && INTEGER;
    case 'get':
      return selected && path.every((side) => !side.many) ? selected : undefined;
    case 'sum':
    case 'avg':
      if (!selected || !numeric(selected.kind)) return undefined;

      return selected.kind === 'decimal' ? selected : DOUBLE;
    case 'min':
    case 'max':
      return selected && selected.kind !== 'string' ? selected : undefined;
    case 'approximatePercentile':
      return selected && numeric(selected.kind) ? DOUBLE : undefined;
    case 'collectList':
    case 'collectSet':
      return selected && { kind: 'array', of: selected };
  }
}

function pairType(
  operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'greatest' | 'least',
  left: ResultType,
  right: ResultType,
): ValueType | undefined {
  if (left.kind === 'array' || right.kind === 'array') return undefined;

  const ordering = operator === 'greatest' || operator === 'least';

  if (ordering && (left.kind === 'date' || left.kind === 'timestamp'))
    return left.kind === right.kind ? left : undefined;

  if (!numeric(left.kind) || !numeric(right.kind)) return undefined;

  if (left.kind === 'double' || right.kind === 'double') return DOUBLE;

  if (left.kind === 'integer' && right.kind === 'integer') return operator === 'divide' ? DOUBLE : INTEGER;

  if (left.kind === 'decimal' && right.kind === 'decimal')
    return operator === 'multiply' || operator === 'divide' ? left : decimal(Math.max(left.scale, right.scale));

  if (left.kind === 'decimal' && (operator === 'multiply' || operator === 'divide')) return left;

  return undefined;
}

function pathOf(
  model: Model,
  root: string,
  set: MethodSet,
): { readonly target: string; readonly sides: readonly LinkSide[] } | undefined {
  if (set.type === 'methodInput') return { target: root, sides: [] };

  const inner = pathOf(model, root, set.objectSet);

  if (!inner || set.type === 'filter') return inner;

  const side = model[inner.target]?.links[set.link];

  return side && { target: side.target, sides: [...inner.sides, side] };
}

export function typeOf(model: Model, root: string, scope: Scope, definition: Definition): ResultType | undefined {
  const of = (each: Definition) => typeOf(model, root, scope, each);

  switch (definition.type) {
    case 'property':
      return scope[definition.apiName];
    case 'selection': {
      const path = pathOf(model, root, definition.objectSet);

      if (!path || path.sides.length === 0) return undefined;

      const selected =
        'selectedPropertyApiName' in definition.operation
          ? model[path.target]?.properties[definition.operation.selectedPropertyApiName]
          : undefined;

      if ('selectedPropertyApiName' in definition.operation && !selected) return undefined;

      return operationType(definition.operation, selected, path.sides);
    }
    case 'add':
    case 'multiply':
    case 'greatest':
    case 'least': {
      const types = definition.properties.map(of);
      const [first, ...rest] = types;

      if (!first || rest.length === 0) return undefined;

      const kinds = new Set(types.map((each) => each?.kind));

      if (kinds.has('decimal') && kinds.has('integer'))
        return definition.type === 'multiply' && first.kind === 'decimal' && kinds.size === 2 ? first : undefined;

      let type: ResultType | undefined = first;

      for (const next of rest) type = type && next && pairType(definition.type, type, next);

      return type;
    }
    case 'subtract':
    case 'divide': {
      const left = of(definition.left);
      const right = of(definition.right);

      return left && right && pairType(definition.type, left, right);
    }
    case 'absoluteValue':
    case 'negate': {
      const type = of(definition.property);

      return type && type.kind !== 'array' && numeric(type.kind) ? type : undefined;
    }
    case 'extract': {
      const type = of(definition.property);

      return type && (type.kind === 'date' || type.kind === 'timestamp') ? INTEGER : undefined;
    }
  }
}

interface Context {
  readonly model: Model;
  readonly data: Dataset;
  readonly hidden: Hidden;
}

interface Located {
  readonly type: string;
  readonly row: Row;
}

const keyOf = (context: Context, object: Located): string => String(object.row[context.model[object.type]?.key ?? '']);

const visible = (context: Context, object: Located): boolean =>
  !context.hidden.objects.has(`${object.type}/${keyOf(context, object)}`);

function read(context: Context, object: Located, property: string): Value {
  if (context.hidden.values.has(`${object.type}/${keyOf(context, object)}/${property}`)) return null;

  return object.row[property] ?? null;
}

function compareValues(type: ValueType, left: Inner, right: Inner): number {
  if (type.kind === 'decimal') return compareDec(toDec(left), toDec(right));

  if (type.kind === 'integer' || type.kind === 'double') return Math.sign(toNumber(left) - toNumber(right));

  const a = innerText(left);
  const b = innerText(right);

  return a < b ? -1 : a > b ? 1 : 0;
}

function matches(context: Context, object: Located, query: Query): boolean {
  switch (query.type) {
    case 'and':
      return query.value.every((each) => matches(context, object, each));
    case 'or':
      return query.value.some((each) => matches(context, object, each));
    case 'not':
      return !matches(context, object, query.value);
    case 'isNull':
      return (read(context, object, query.field) === null) === query.value;
    default: {
      const type = context.model[object.type]?.properties[query.field];

      if (!type) throw new Error(`The reference has no Property ${query.field} on ${object.type}.`);

      if (query.type === 'in' && query.value.length === 0) return true;

      const value = inner(read(context, object, query.field), type);

      if (value === null) return false;

      const compare = (other: string | number) => compareValues(type, value, inner(other, type));

      if (query.type === 'in') return query.value.some((each) => compare(each) === 0);

      const order = compare(query.value);

      return { eq: order === 0, gt: order > 0, gte: order >= 0, lt: order < 0, lte: order <= 0 }[query.type];
    }
  }
}

function objectsOf(context: Context, input: Located, set: MethodSet): readonly Located[] {
  if (set.type === 'methodInput') return [input];

  const sources = objectsOf(context, input, set.objectSet);

  if (set.type === 'filter') return sources.filter((object) => matches(context, object, set.where));

  const reached = new Map<string, Located>();

  for (const source of sources) {
    const side = context.model[source.type]?.links[set.link];

    if (!side) throw new Error(`The reference has no Link side ${set.link} on ${source.type}.`);

    const from = source.row[side.from] ?? null;

    if (from === null) continue;

    for (const row of context.data[side.target] ?? []) {
      const object = { type: side.target, row };

      if (row[side.to] === from && visible(context, object)) reached.set(keyOf(context, object), object);
    }
  }

  return [...reached.values()];
}

function byKey(context: Context, left: Located, right: Located): number {
  const a = keyOf(context, left);
  const b = keyOf(context, right);

  return a < b ? -1 : a > b ? 1 : 0;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const below = Math.floor(position);
  const low = sorted[below] ?? 0;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;

  return low + (position - below) * (high - low);
}

function distinct(type: ValueType, values: readonly Inner[]): Inner[] {
  const sorted = [...values].sort((left, right) => compareValues(type, left, right));

  return sorted.filter((value, index) => index === 0 || compareValues(type, sorted[index - 1] ?? null, value) !== 0);
}

function aggregate(context: Context, objects: readonly Located[], operation: Operation): Inner {
  if (operation.type === 'count') return BigInt(objects.length);

  if (objects.length === 0 && (operation.type === 'exactDistinct' || operation.type === 'approximateDistinct'))
    return 0n;

  if (objects.length === 0) return null;

  const property = operation.selectedPropertyApiName;
  const type = context.model[objects[0]?.type ?? '']?.properties[property];

  if (!type) throw new Error(`The reference has no Property ${property}.`);

  const ordered = [...objects].sort((left, right) => byKey(context, left, right));

  const values = ordered
    .map((object) => inner(read(context, object, property), type))
    .filter((value) => value !== null);

  switch (operation.type) {
    case 'get':
      if (objects.length > 1) throw new Error('The reference reached more than 1 Object for a get.');

      return values[0] ?? null;
    case 'exactDistinct':
    case 'approximateDistinct':
      return BigInt(distinct(type, values).length);
    case 'collectList':
      return values.length === 0 ? null : values.slice(0, operation.limit);
    case 'collectSet':
      return values.length === 0 ? null : distinct(type, values).slice(0, operation.limit);
    default:
      break;
  }

  if (values.length === 0) return null;

  switch (operation.type) {
    case 'min':
      return [...values].sort((left, right) => compareValues(type, left, right))[0] ?? null;
    case 'max':
      return [...values].sort((left, right) => compareValues(type, right, left))[0] ?? null;
    case 'approximatePercentile':
      return percentile(
        values.map(toNumber).sort((left, right) => left - right),
        operation.approximatePercentile,
      );
    case 'sum':
    case 'avg': {
      if (type.kind !== 'decimal') {
        const sum = values.map(toNumber).reduce((total, value) => total + value, 0);

        return operation.type === 'sum' ? sum : sum / values.length;
      }

      const units = values.map(toDec).reduce((total, value) => total + atScale(value, type.scale).units, 0n);

      return {
        units: operation.type === 'sum' ? units : divideRounded(units, BigInt(values.length)),
        scale: type.scale,
      };
    }
  }
}

function times(left: Inner, right: Inner): Inner {
  if (typeof left === 'number' || typeof right === 'number') return toNumber(left) * toNumber(right);

  if (typeof left === 'bigint' && typeof right === 'bigint') return checked(left * right);

  const [a, b] = [toDec(left), toDec(right)];

  return { units: a.units * b.units, scale: a.scale + b.scale };
}

function arithmetic(operator: 'add' | 'subtract' | 'divide', type: ValueType, left: Inner, right: Inner): Inner {
  if (left === null || right === null) return null;

  if (type.kind === 'double') {
    const [a, b] = [toNumber(left), toNumber(right)];

    if (operator === 'divide') return b === 0 ? null : a / b;

    return operator === 'add' ? a + b : a - b;
  }

  if (type.kind === 'integer') {
    const [a, b] = [left as bigint, right as bigint];

    return checked(operator === 'add' ? a + b : a - b);
  }

  if (type.kind !== 'decimal') throw new Error(`The reference has no ${operator} of ${type.kind}.`);

  const [a, b] = [toDec(left), toDec(right)];

  if (operator === 'add' || operator === 'subtract') {
    const units = atScale(b, type.scale).units;

    return { units: atScale(a, type.scale).units + (operator === 'add' ? units : -units), scale: type.scale };
  }

  if (b.units === 0n) return null;

  return { units: divideRounded(a.units * pow10(b.scale + type.scale), b.units * pow10(a.scale)), scale: type.scale };
}

const PARTS = {
  DAYS: (date: Date) => date.getUTCDate(),
  MONTHS: (date: Date) => date.getUTCMonth() + 1,
  QUARTERS: (date: Date) => Math.floor(date.getUTCMonth() / 3) + 1,
  YEARS: (date: Date) => date.getUTCFullYear(),
} as const;

export type Observer = (definition: Definition, type: ResultType, value: Json | null) => void;

interface Evaluation {
  readonly context: Context;
  readonly observe: Observer | undefined;
  readonly root: string;
  readonly input: Located;
  readonly scope: Scope;
  readonly values: Readonly<Record<string, Inner>>;
}

function evaluate(evaluation: Evaluation, definition: Definition): Inner {
  const { context, observe, root, scope } = evaluation;
  const value = compute(evaluation, definition);
  const type = observe && typeOf(context.model, root, scope, definition);

  if (observe && type) observe(definition, type, json(value, type));

  return value;
}

function compute(evaluation: Evaluation, definition: Definition): Inner {
  const { context, root, input, scope, values } = evaluation;

  const typeOfDefinition = (each: Definition): ValueType => {
    const type = typeOf(context.model, root, scope, each);

    if (!type || type.kind === 'array')
      throw new Error(`The generator made a definition with no scalar type: ${JSON.stringify(each)}`);

    return type;
  };

  const of = (each: Definition) => evaluate(evaluation, each);

  switch (definition.type) {
    case 'property':
      return values[definition.apiName] ?? null;
    case 'selection':
      return aggregate(context, objectsOf(context, input, definition.objectSet), definition.operation);
    case 'multiply': {
      const type = typeOfDefinition(definition);
      const [first = null, ...rest] = definition.properties.map(of);

      const value = rest.reduce<Inner>(
        (product, next) => (product === null || next === null ? null : times(product, next)),
        first,
      );

      if (type.kind !== 'decimal' || value === null) return value;

      const exact = toDec(value);

      return { units: divideRounded(exact.units, pow10(exact.scale - type.scale)), scale: type.scale };
    }
    case 'add': {
      const [first, ...rest] = definition.properties;

      if (!first) return null;

      let value = of(first);
      let type = typeOfDefinition(first);

      for (const next of rest) {
        const nextType = typeOfDefinition(next);
        const right = of(next);
        const result = pairType(definition.type, type, nextType);

        if (!result) throw new Error('The generator made an expression with no type.');

        value = arithmetic(definition.type, result, value, right);

        type = result;
      }

      return value;
    }
    case 'subtract':
    case 'divide': {
      const left = of(definition.left);
      const right = of(definition.right);

      return arithmetic(definition.type, typeOfDefinition(definition), left, right);
    }
    case 'greatest':
    case 'least': {
      const type = typeOfDefinition(definition);
      const present = definition.properties.map(of).filter((value) => value !== null);

      if (present.length === 0) return null;

      const sign = definition.type === 'greatest' ? -1 : 1;
      const best = [...present].sort((left, right) => sign * compareValues(type, left, right))[0] ?? null;

      return type.kind === 'double' ? toNumber(best) : best;
    }
    case 'absoluteValue':
    case 'negate': {
      const value = of(definition.property);

      if (value === null) return null;

      const negative =
        compareValues(
          typeOfDefinition(definition.property),
          value,
          typeof value === 'bigint' ? 0n : isDec(value) ? { units: 0n, scale: 0 } : 0,
        ) < 0;

      if (definition.type === 'absoluteValue' && !negative) return value;

      if (isDec(value)) return { units: -value.units, scale: value.scale };

      if (typeof value === 'bigint') return checked(-value);

      return -toNumber(value);
    }
    case 'extract': {
      const value = of(definition.property);

      return value === null ? null : BigInt(PARTS[definition.part](new Date(innerText(value))));
    }
  }
}

export function reference(
  model: Model,
  data: Dataset,
  hidden: Hidden,
  root: string,
  layers: Layers,
  observe?: Observer,
): Expected {
  const context: Context = { model, data, hidden };
  const rootType = model[root];

  if (!rootType) throw new Error(`The reference has no Object Type ${root}.`);

  const declared: Record<string, ResultType> = { ...rootType.properties };

  for (const layer of layers) {
    const types = Object.entries(layer).map(
      ([name, definition]) => [name, typeOf(model, root, declared, definition)] as const,
    );

    if (types.some(([, type]) => !type)) return { status: 400, errorName: 'InvalidDerivedPropertyDefinition' };

    Object.assign(declared, Object.fromEntries(types));
  }

  const objects: Record<string, Record<string, Json>> = {};

  try {
    for (const row of data[root] ?? []) {
      const input = { type: root, row };

      if (!visible(context, input)) continue;

      const scope: Record<string, ResultType> = { ...rootType.properties };

      const values: Record<string, Inner> = Object.fromEntries(
        Object.entries(rootType.properties).map(([name, type]) => [name, inner(read(context, input, name), type)]),
      );

      const answer: Record<string, Json> = {};

      for (const layer of layers) {
        const types: Record<string, ResultType> = {};

        for (const [name, definition] of Object.entries(layer)) {
          const type = typeOf(model, root, scope, definition);

          if (!type) throw new Error(`The generator made a definition with no type: ${JSON.stringify(definition)}`);

          const value = evaluate({ context, observe, root, input, scope, values }, definition);

          values[name] = value;

          types[name] = type;

          const shown = json(value, type);

          if (shown !== null) answer[name] = shown;
        }

        Object.assign(scope, types);
      }

      objects[keyOf(context, input)] = answer;
    }
  } catch (error) {
    if (error instanceof Overflow) return { status: 400, errorName: 'Default:InvalidArgument' };

    throw error;
  }

  return { status: 200, objects };
}
