import { columnType, quoteName, roundedSql, valueType } from '../../db/index.ts';
import { invariant, settle, type ApiError, type Fallible } from '../../errors/index.ts';
import type { DerivedNode, PropertyType } from '../../ontology/index.ts';
import { aggregateSql } from './aggregation.ts';
import type { CompileEnv, CompiledObjectSet, HopInput } from './objectSet.ts';
import { ROW } from './objects.ts';
import type { Params } from './sql.ts';
import { TextSearchBudget } from './where.ts';

type Compile = (tree: unknown, env: CompileEnv) => Fallible<CompiledObjectSet, ApiError>;

export type SelectionNode = Extract<DerivedNode, { kind: 'selection' }>;

type Leaf = Extract<DerivedNode, { kind: 'selection' | 'property' }>;

export function leavesOf(nodes: readonly DerivedNode[]): Leaf[] {
  return nodes.flatMap((node): Leaf[] => {
    switch (node.kind) {
      case 'selection':
      case 'property':
        return [node];
      case 'nary':
        return leavesOf(node.operands);
      case 'binary':
        return leavesOf([node.left, node.right]);
      case 'unary':
      case 'extract':
        return leavesOf([node.operand]);
    }
  });
}

export class Hops {
  private readonly sets = new Map<SelectionNode, Map<string, CompiledObjectSet | undefined>>();

  private readonly env: CompileEnv;
  private readonly compile: Compile;

  constructor(env: CompileEnv, compile: Compile) {
    this.env = env;
    this.compile = compile;
  }

  *check(node: SelectionNode, input: HopInput): Fallible<void, ApiError> {
    this.keep(node, input.alias, yield* this.compile(node.path.objectSet, { ...this.env, input }));
  }

  of(node: SelectionNode, input: HopInput): CompiledObjectSet | undefined {
    const known = this.sets.get(node);

    if (known?.has(input.alias)) return known.get(input.alias);

    const hops = settle(this.compile(node.path.objectSet, { ...this.env, budget: new TextSearchBudget(), input }));

    if (hops.ok) return this.keep(node, input.alias, hops.value);

    invariant(
      hops.error.status === 404,
      `The hops of a derived value failed with ${hops.error.errorName}, not a hidden Link side.`,
    );

    return this.keep(node, input.alias, undefined);
  }

  private keep(node: SelectionNode, alias: string, set: CompiledObjectSet | undefined): CompiledObjectSet | undefined {
    const known = this.sets.get(node) ?? new Map<string, CompiledObjectSet | undefined>();

    known.set(alias, set);

    this.sets.set(node, known);

    return set;
  }
}

export function valueSql(node: DerivedNode, input: HopInput, params: Params, hops: Hops): string {
  if (node.kind === 'selection') return selectionSql(node, hops.of(node, input), params);

  return `(SELECT ${expressionSql(node, input, params, hops)} AS v OFFSET 0)`;
}

function selectionSql(node: SelectionNode, hops: CompiledObjectSet | undefined, params: Params): string {
  if (!hops)
    return `(SELECT ${['count', 'exactDistinct', 'approximateDistinct'].includes(node.operation.kind) ? '0' : 'NULL'}::${castOf(node.type)} AS v)`;

  return `(SELECT ${operationSql(node, params)} AS v FROM ${hops.source(params)} AS ${ROW})`;
}

function operationSql({ operation, path, type }: SelectionNode, params: Params): string {
  if (operation.kind === 'count') return `count(*)::${castOf(type)}`;

  const value = `${ROW}.${quoteName(operation.property.column)}`;

  switch (operation.kind) {
    case 'get':
      return `any_value(${value})`;
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
      return `${aggregateSql(operation.kind, value, operation.property.type)}::${castOf(type)}`;
    case 'exactDistinct':
    case 'approximateDistinct':
      return `count(DISTINCT ${value})::${castOf(type)}`;
    case 'approximatePercentile':
      return `percentile_cont(${params.add(operation.percentile)}::double precision) WITHIN GROUP (ORDER BY ${value}::double precision)`;
    case 'collectList':
      return `(array_agg(${value} ORDER BY ${ROW}.${quoteName(path.target.primaryKey.column)}) FILTER (WHERE ${value} IS NOT NULL))[1:${params.add(operation.limit)}::integer]`;
    case 'collectSet':
      return `(array_agg(DISTINCT ${value} ORDER BY ${value}) FILTER (WHERE ${value} IS NOT NULL))[1:${params.add(operation.limit)}::integer]`;
  }
}

const EXTRACT_FIELDS = { DAYS: 'day', MONTHS: 'month', QUARTERS: 'quarter', YEARS: 'year' } as const;

function expressionSql(node: DerivedNode, input: HopInput, params: Params, hops: Hops): string {
  const operand = (child: DerivedNode) => expressionSql(child, input, params, hops);

  switch (node.kind) {
    case 'selection':
      return selectionSql(node, hops.of(node, input), params);
    case 'property': {
      const property = input.set.row.all().find((candidate) => candidate.apiName === node.apiName);

      invariant(property, `parseDerived took the Property ${node.apiName}, which the input row does not have.`);

      return `${input.alias}.${quoteName(property.column)}`;
    }
    case 'unary':
      return typed(node.type, node.op === 'negate' ? `(- ${operand(node.operand)})` : `abs(${operand(node.operand)})`);
    case 'extract': {
      const value =
        node.operand.type.kind === 'timestamp'
          ? `(${operand(node.operand)} AT TIME ZONE 'UTC')`
          : operand(node.operand);

      return `extract(${EXTRACT_FIELDS[node.part]} FROM ${value})::integer`;
    }
    case 'nary': {
      const operands = node.operands.map(operand);

      if (node.op === 'greatest' || node.op === 'least')
        return typed(node.type, `${node.op.toUpperCase()}(${operands.join(', ')})`);

      return typed(node.type, `(${operands.join(node.op === 'add' ? ' + ' : ' * ')})`);
    }
    case 'binary': {
      const [left, right] = [operand(node.left), operand(node.right)];

      if (node.op === 'subtract') return typed(node.type, `(${left} - ${right})`);

      if (node.type.kind !== 'decimal') return `(${left}::double precision / NULLIF(${right}::double precision, 0))`;

      return decimalQuotient(left, right, node.type.scale);
    }
  }
}

function typed(type: PropertyType, sql: string): string {
  return type.kind === 'decimal' ? roundedSql(sql, type.scale) : `(${sql})::${castOf(type)}`;
}

function decimalQuotient(left: string, right: string, scale: number): string {
  const units = `sign(q.l) * sign(q.r) * div(2 * abs(q.l) * power(10::numeric, ${scale}) + abs(q.r), 2 * abs(q.r))`;

  return `(SELECT ${roundedSql(`${units} * power(10::numeric, ${-scale})`, scale)} FROM (SELECT (${left})::numeric AS l, NULLIF((${right})::numeric, 0) AS r OFFSET 0) AS q)`;
}

function castOf(type: PropertyType): string {
  return type.kind === 'array' || type.kind === 'struct' ? columnType(type) : valueType(type);
}
