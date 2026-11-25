import type { CompiledObjectType, CompiledOntology, CompiledProperty, JsonValue } from '../compiled/index.ts';
import { isRecord, type JsonRecord } from '../model/shape.ts';
import { COLLECT_LIMIT, FORM_LIMITS, type FormLimits, type ParsedDerived } from './limits.ts';
import type { DerivedForm, DerivedNode, DerivedRefusal, InputRow, Operation } from './nodes.ts';
import { resultType } from './resultType.ts';

type Refused = Extract<ParsedDerived, { ok: false }>;

type Objects = Pick<CompiledOntology, 'objectTypes'>;

const refuse = (refusal: DerivedRefusal): Refused => ({ ok: false, refusal });
const shape = (detail: string): Refused => refuse({ kind: 'shape', detail });

const EXTRACT_PARTS = new Set(['DAYS', 'MONTHS', 'QUARTERS', 'YEARS']);

export function parseDerived(
  definition: unknown,
  input: InputRow,
  ontology: Objects,
  form: DerivedForm,
): ParsedDerived {
  return parseNode(definition, input, ontology, FORM_LIMITS[form]);
}

const MAX_DERIVED_DEPTH = 64;

function parseNode(
  definition: unknown,
  input: InputRow,
  ontology: Objects,
  limits: FormLimits,
  depth = 0,
): ParsedDerived {
  if (depth >= MAX_DERIVED_DEPTH) return shape('This derived property definition is too deeply nested.');

  if (!isRecord(definition) || typeof definition['type'] !== 'string')
    return shape('A derived property definition is an object with a type.');

  const kind = definition['type'];

  if (kind === 'selection') return parseSelection(definition, input, ontology, limits);

  if (!limits.expressions) return shape('This form has no expression. A definition is 1 selection.');

  if (kind === 'property') return parsePropertyRead(definition, input);

  const operand = (value: unknown) => parseNode(value, input, ontology, limits, depth + 1);

  switch (kind) {
    case 'add':
    case 'multiply':
    case 'greatest':
    case 'least': {
      const members = definition['properties'];

      if (!Array.isArray(members) || members.length < 2) return shape('This expression takes 2 or more operands.');

      const operands: DerivedNode[] = [];

      for (const member of members) {
        const parsed = operand(member);

        if (!parsed.ok) return parsed;

        operands.push(parsed.node);
      }

      const type = resultType(
        kind,
        operands.map((node) => node.type),
      );

      if (!type) return shape('This expression does not take the types of its operands.');

      return { ok: true, node: { kind: 'nary', op: kind, operands, type } };
    }
    case 'subtract':
    case 'divide': {
      const left = operand(definition['left']);

      if (!left.ok) return left;

      const right = operand(definition['right']);

      if (!right.ok) return right;

      const type = resultType(kind, [left.node.type, right.node.type]);

      if (!type) return shape('This expression does not take the types of its operands.');

      return { ok: true, node: { kind: 'binary', op: kind, left: left.node, right: right.node, type } };
    }
    case 'absoluteValue':
    case 'negate':
    case 'extract': {
      const inner = operand(definition['property']);

      if (!inner.ok) return inner;

      const type = resultType(kind, [inner.node.type]);

      if (!type) return shape('This expression does not take the type of its operand.');

      if (kind !== 'extract') return { ok: true, node: { kind: 'unary', op: kind, operand: inner.node, type } };

      const part = definition['part'];

      if (typeof part !== 'string' || !EXTRACT_PARTS.has(part))
        return shape('The part of an extract is DAYS, MONTHS, QUARTERS, or YEARS.');

      return {
        ok: true,
        node: { kind: 'extract', part: part as 'DAYS' | 'MONTHS' | 'QUARTERS' | 'YEARS', operand: inner.node, type },
      };
    }
    default:
      return shape('This definition type is not a selection, a property, or an expression.');
  }
}

function parsePropertyRead(definition: JsonRecord, input: InputRow): ParsedDerived {
  const apiName = definition['apiName'];

  if (typeof apiName !== 'string') return shape('A property read names a Property.');

  const found = input.property(apiName);

  if (!found) return refuse({ kind: 'notFound', linkOrProperty: apiName });

  return { ok: true, node: { kind: 'property', apiName, type: found.type } };
}

function parseSelection(definition: JsonRecord, input: InputRow, ontology: Objects, limits: FormLimits): ParsedDerived {
  const chain: JsonRecord[] = [];

  for (let current = definition['objectSet']; ;) {
    if (!isRecord(current)) return shape('A hop is an object.');

    if (current['type'] === 'methodInput') break;

    if (current['type'] !== 'searchAround' && current['type'] !== 'filter')
      return shape('A selection walks searchAround and filter members only.');

    chain.push(current);

    current = current['objectSet'];
  }

  chain.reverse();

  let target = input.objectType;
  let hops = 0;
  let single = true;

  for (const member of chain) {
    if (member['type'] === 'filter') {
      if (!limits.filters) return shape('This form has no filter on a hop.');

      if (!isRecord(member['where'])) return shape('A filter has a where clause.');

      continue;
    }

    const link = member['link'];

    if (typeof link !== 'string') return shape('A searchAround names a Link side.');

    const side = target.links.get(link);
    const next = side ? ontology.objectTypes.get(side.target) : undefined;

    if (!side || !next) return refuse({ kind: 'notFound', linkOrProperty: link });

    hops += 1;

    single &&= side.cardinality === 'ONE';

    target = next;
  }

  if (hops === 0) return shape('A selection has 1 hop or more.');

  if (hops > limits.maxHops) return shape(`This form has at most ${limits.maxHops} hops.`);

  const operation = parseOperation(definition['operation'], target, single, limits);

  if ('ok' in operation) return operation;

  const type = resultType(operation.kind, operation.kind === 'count' ? [] : [operation.property.type]);

  if (!type) return shape('The operation does not take the type of the Property.');

  return {
    ok: true,
    node: {
      kind: 'selection',
      path: { objectSet: definition['objectSet'] as JsonValue, hops, target, single },
      operation,
      type,
    },
  };
}

type PropertyOperationKind = Extract<
  Operation,
  { property: CompiledProperty; limit?: never; percentile?: never }
>['kind'];

const PROPERTY_OPERATIONS: ReadonlySet<string> = new Set<PropertyOperationKind>([
  'get',
  'sum',
  'avg',
  'min',
  'max',
  'exactDistinct',
  'approximateDistinct',
]);

const isPropertyOperation = (kind: string): kind is PropertyOperationKind => PROPERTY_OPERATIONS.has(kind);

function parseOperation(
  value: unknown,
  target: CompiledObjectType,
  single: boolean,
  limits: FormLimits,
): Operation | Refused {
  if (!isRecord(value) || typeof value['type'] !== 'string') return shape('A selection has an operation with a type.');

  const kind = value['type'];

  if (kind === 'count') return { kind };

  const isCollect = kind === 'collectList' || kind === 'collectSet';

  if (!isPropertyOperation(kind) && !isCollect && kind !== 'approximatePercentile')
    return shape('This operation is not one of the 11 operations.');

  if (kind === 'approximatePercentile' && !limits.percentile) return shape('This form has no approximatePercentile.');

  const name = value['selectedPropertyApiName'];

  if (typeof name !== 'string') return shape('This operation names a Property.');

  const property = target.properties.get(name);

  if (!property) return refuse({ kind: 'notFound', linkOrProperty: name });

  if (kind === 'approximatePercentile') {
    const fraction = value['approximatePercentile'];

    if (typeof fraction !== 'number' || !(fraction >= 0 && fraction <= 1))
      return shape('A percentile is a fraction from 0 to 1.');

    return { kind, property, percentile: fraction };
  }

  if (isCollect) {
    const limit = value['limit'];

    if (typeof limit !== 'number') return shape('A collect operation has a limit.');

    if (!Number.isInteger(limit) || limit < COLLECT_LIMIT.min || limit > COLLECT_LIMIT.max)
      return refuse({ kind: 'collectLimit', limit });

    return { kind, property, limit };
  }

  if (kind === 'get' && !single) return shape('A get needs each hop to reach at most 1 Object.');

  return { kind, property };
}
