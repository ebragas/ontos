import type { PropertyType } from '../compiled/links.ts';
import type { Operation } from './nodes.ts';

type ExpressionOperator =
  'add' | 'subtract' | 'multiply' | 'divide' | 'absoluteValue' | 'negate' | 'greatest' | 'least' | 'extract';

const INTEGER: PropertyType = { kind: 'integer' };
const DOUBLE: PropertyType = { kind: 'double' };

const MAX_DECIMAL_PRECISION = 38;

const isNumeric = (type: PropertyType) => type.kind === 'integer' || type.kind === 'double' || type.kind === 'decimal';

export function resultType(
  kind: Operation['kind'] | ExpressionOperator,
  operands: readonly (PropertyType | undefined)[],
): PropertyType | undefined {
  const types: PropertyType[] = [];

  for (const operand of operands) {
    if (!operand) return undefined;

    types.push(operand);
  }

  const [first] = types;

  switch (kind) {
    case 'count':
      return types.length <= 1 ? INTEGER : undefined;
    case 'exactDistinct':
    case 'approximateDistinct':
      return types.length === 1 ? INTEGER : undefined;
    case 'get':
      return types.length === 1 ? first : undefined;
    case 'sum':
    case 'avg':
      if (types.length !== 1 || !first) return undefined;

      if (first.kind === 'decimal') return { kind: 'decimal', precision: MAX_DECIMAL_PRECISION, scale: first.scale };

      return first.kind === 'integer' || first.kind === 'double' ? DOUBLE : undefined;
    case 'min':
    case 'max':
      if (types.length !== 1 || !first) return undefined;

      return isNumeric(first) || first.kind === 'boolean' || first.kind === 'date' || first.kind === 'timestamp'
        ? first
        : undefined;
    case 'approximatePercentile':
      return types.length === 1 && first && isNumeric(first) ? DOUBLE : undefined;
    case 'collectList':
    case 'collectSet':
      if (types.length !== 1 || !first || first.kind === 'array' || first.kind === 'struct') return undefined;

      return { kind: 'array', element: first };
    case 'absoluteValue':
    case 'negate':
      return types.length === 1 && first && isNumeric(first) ? first : undefined;
    case 'extract':
      return types.length === 1 && (first?.kind === 'date' || first?.kind === 'timestamp') ? INTEGER : undefined;
    case 'subtract':
    case 'divide':
      return types.length === 2 ? combine(kind, types) : undefined;
    case 'add':
    case 'multiply':
    case 'greatest':
    case 'least':
      return types.length >= 2 ? combine(kind, types) : undefined;
  }
}

function combine(
  kind: 'add' | 'subtract' | 'multiply' | 'divide' | 'greatest' | 'least',
  types: readonly PropertyType[],
): PropertyType | undefined {
  const [left] = types;

  if (!left) return undefined;

  if (types.every((type) => type.kind === left.kind) && (left.kind === 'date' || left.kind === 'timestamp')) {
    return kind === 'greatest' || kind === 'least' ? left : undefined;
  }

  if (!types.every(isNumeric)) return undefined;

  if (types.every((type) => type.kind === 'integer')) return kind === 'divide' ? DOUBLE : INTEGER;

  const hasDouble = types.some((type) => type.kind === 'double');
  const decimals = types.filter((type) => type.kind === 'decimal');

  if (decimals.length === 0) return DOUBLE;

  if (hasDouble)
    return decimals.length + types.filter((type) => type.kind === 'double').length === types.length
      ? DOUBLE
      : undefined;

  if (left.kind === 'decimal' && (kind === 'multiply' || kind === 'divide'))
    return { kind: 'decimal', precision: MAX_DECIMAL_PRECISION, scale: left.scale };

  if (decimals.length !== types.length) return undefined;

  if (kind === 'multiply' || kind === 'divide') return undefined;

  return { kind: 'decimal', precision: MAX_DECIMAL_PRECISION, scale: Math.max(...decimals.map((type) => type.scale)) };
}
