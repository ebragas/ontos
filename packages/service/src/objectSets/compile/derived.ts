import { quoteName } from '../../db/index.ts';
import { ApiError, each, settle, unsupportedFeature, type Fallible } from '../../errors/index.ts';
import {
  checkPropertyApiName,
  COLLECT_LIMIT,
  parseDerived,
  type CompiledObjectType,
  type DerivedNode,
  type DerivedRefusal,
} from '../../ontology/index.ts';
import { Hops, leavesOf, valueSql } from './derivedSql.ts';
import { DefinitionBudget, type DerivedUse } from './derivedState.ts';
import type { CompileEnv, CompiledObjectSet } from './objectSet.ts';
import { invalid, isRecord } from './request.ts';
import { storedRow, type Row, type RowProperty } from './row.ts';
import type { Params } from './sql.ts';

export * from './derivedState.ts';

type Compile = (tree: unknown, env: CompileEnv) => Fallible<CompiledObjectSet, ApiError>;

type Origin = DerivedUse['origin'];

const MAX_LAYERS = 32;

export function* methodInput(env: CompileEnv): Fallible<CompiledObjectSet, ApiError> {
  const { input } = env;

  if (!input) return yield unsupportedFeature('methodInput');

  const { objectType } = input.set;

  return {
    objectType,
    objectTypes: [objectType.apiName],
    source: () => `(SELECT ${input.alias}.*)`,
    pageSource: (base) => base,
    hasComputedDerived: () => false,
    hasPageDerived: () => false,
    row: storedRow(objectType),
  };
}

export function withObjectTypeDerived(set: CompiledObjectSet, env: CompileEnv, compile: Compile): CompiledObjectSet {
  const { derived } = set.objectType;

  if (env.input || derived.size === 0) return set;

  return layerOf(
    env,
    set,
    [...derived.values()].map((property) => ({
      apiName: property.apiName,
      node: property.node,
      origin: { form: 'objectType', property },
    })),
    compile,
  ).set;
}

export function* withProperties(
  tree: Readonly<Record<string, unknown>>,
  outer: CompileEnv,
  compile: Compile,
): Fallible<CompiledObjectSet, ApiError> {
  const definitions = tree.derivedProperties;

  if (outer.layers > MAX_LAYERS) return yield* refuseOverLimit(tree, definitions, outer, compile);

  if (!outer.definitions.spend(isRecord(definitions) ? Object.keys(definitions).length : 0))
    return yield* refuseOverLimit(tree, definitions, outer, compile);

  const env = { ...outer, layers: outer.layers + 1 };
  const inner = yield* compile(tree.objectSet, env);

  if (!isRecord(definitions)) return yield invalid('objectSet');

  const held = new Map(inner.row.all().map((property) => [property.apiName, property]));
  const names = Object.keys(definitions);
  const invalidName = names.find((name) => !settle(checkPropertyApiName(name, inner.objectType.apiName)).ok);

  if (invalidName !== undefined) return yield invalidDefinition(inner, invalidName);

  const taken = names.filter((name) => held.has(name));

  if (taken.length > 0)
    return yield new ApiError(400, 'DerivedPropertyApiNamesNotUnique', { derivedPropertyApiNames: taken });

  const input = {
    objectType: inner.objectType,
    property: (apiName: string) => {
      const property = held.get(apiName);

      return property && { type: property.type };
    },
  };

  const entries: Definition[] = [];

  for (const [position, [name, definition]] of Object.entries(definitions).entries()) {
    const parsed = parseDerived(definition, input, env.ontology, 'request');

    if (!parsed.ok) return yield* refused(parsed.refusal, definition, inner, name, env, compile);

    entries.push({ apiName: name, node: parsed.node, origin: { form: 'request', position } });
  }

  const layer = layerOf(env, inner, entries, compile);

  const selections = leavesOf(entries.map((entry) => entry.node)).flatMap((leaf) =>
    leaf.kind === 'selection' ? [leaf] : [],
  );

  yield* each(selections, (node) => layer.hops.check(node, { set: inner, alias: layer.alias }));

  return layer.set;
}

function* refuseOverLimit(
  tree: Readonly<Record<string, unknown>>,
  definitions: unknown,
  env: CompileEnv,
  compile: Compile,
): Fallible<never, ApiError> {
  if (!isRecord(definitions)) return yield invalid('objectSet');

  let below: unknown = tree.objectSet;

  while (isRecord(below) && (below.type === 'withProperties' || below.type === 'filter')) below = below.objectSet;

  const set = yield* compile(below, { ...env, definitions: DefinitionBudget.unlimited() });

  return yield invalidDefinition(set, Object.keys(definitions)[0]);
}

function invalidDefinition(set: CompiledObjectSet, derivedProperty: string | undefined): ApiError {
  return new ApiError(400, 'InvalidDerivedPropertyDefinition', { objectType: set.objectType.apiName, derivedProperty });
}

function* refused(
  refusal: DerivedRefusal,
  definition: unknown,
  inner: CompiledObjectSet,
  name: string,
  env: CompileEnv,
  compile: Compile,
): Fallible<never, ApiError> {
  if (refusal.kind === 'collectLimit') {
    return yield new ApiError(400, 'InvalidDerivedPropertyCollectionLimit', {
      limit: refusal.limit,
      minLimit: COLLECT_LIMIT.min,
      maxLimit: COLLECT_LIMIT.max,
    });
  }

  if (refusal.kind === 'notFound')
    yield* compileHops(definition, { ...env, input: { set: inner, alias: env.names.next('__r') } }, compile);

  return yield invalidDefinition(inner, name);
}

function* compileHops(definition: unknown, env: CompileEnv, compile: Compile): Fallible<void, ApiError> {
  if (Array.isArray(definition)) {
    yield* each(definition, (item) => compileHops(item, env, compile));
  } else if (isRecord(definition)) {
    if (definition.type === 'selection') yield* compile(definition.objectSet, env);
    else yield* each(Object.values(definition), (value) => compileHops(value, env, compile));
  }
}

interface Definition {
  readonly apiName: string;
  readonly node: DerivedNode;
  readonly origin: Origin;
}

interface Entry {
  readonly property: RowProperty;
  readonly node: DerivedNode;
  readonly objectType: CompiledObjectType;
  readonly origin: Origin;
  readonly reads: readonly string[];
  readonly lateral: string;
  readonly input: string;
}

interface Layer {
  readonly set: CompiledObjectSet;
  readonly alias: string;
  readonly hops: Hops;
}

function layerOf(
  env: CompileEnv,
  inner: CompiledObjectSet,
  definitions: readonly Definition[],
  compile: Compile,
): Layer {
  const layer = definitions.map(({ apiName, node, origin }): Entry => ({
    property: {
      apiName,
      column: env.names.next('__d'),
      type: node.type,
      searchable: false,
      derived: { form: origin.form },
    },
    node,
    objectType: inner.objectType,
    origin,
    reads: leavesOf([node]).flatMap((leaf) => (leaf.kind === 'property' ? [leaf.apiName] : [])),
    lateral: quoteName(env.names.next('__l')),
    input: quoteName(env.names.next('__r')),
  }));

  const byName = new Map(layer.map((entry) => [entry.property.apiName, entry]));
  const computed = new Set<Entry>();
  const pageComputed = new Set<Entry>();
  const returned = new Set<Entry>();
  const alias = quoteName(env.names.next('__r'));
  const pageAlias = quoteName(env.names.next('__r'));
  const hops = new Hops(env, compile);

  const valueOf = (entry: Entry, input: string, params: Params) =>
    valueSql(entry.node, { set: inner, alias: input }, params, hops);

  const computeReads = (entry: Entry) => entry.reads.forEach((apiName) => inner.row.compute(apiName));
  const computePageReads = (entry: Entry) => entry.reads.forEach((apiName) => inner.row.computeForPage(apiName));

  const row: Row = {
    compute: (apiName) => {
      const entry = byName.get(apiName);

      if (!entry) return inner.row.compute(apiName);

      if (computed.has(entry)) return entry.property;

      computed.add(entry);

      env.uses.computed(entry);

      computeReads(entry);

      return entry.property;
    },
    computeForPage: (apiName) => {
      const entry = byName.get(apiName);

      if (!entry) return inner.row.computeForPage(apiName);

      if (pageComputed.has(entry)) return entry.property;

      pageComputed.add(entry);

      env.uses.computed(entry);

      computePageReads(entry);

      return entry.property;
    },
    select: (property, reason) => {
      const entry = byName.get(property.apiName);

      if (!entry) return inner.row.select(property, reason);

      returned.add(entry);

      env.uses.returned(entry, reason);

      computePageReads(entry);

      return (rowAlias, params) => {
        if (computed.has(entry) || pageComputed.has(entry)) return `${rowAlias}.${quoteName(entry.property.column)}`;

        return `(SELECT ${entry.lateral}.v FROM (SELECT ${rowAlias}.*) AS ${entry.input} CROSS JOIN LATERAL ${valueOf(entry, entry.input, params)} AS ${entry.lateral})`;
      };
    },
    all: () => [...inner.row.all(), ...layer.map((entry) => entry.property)],
  };

  const append = (from: string, rowAlias: string, used: readonly Entry[], params: Params) => {
    const columns = used.map((entry) => `${entry.lateral}.v AS ${quoteName(entry.property.column)}`);

    const joins = used.map(
      (entry) => `LEFT JOIN LATERAL ${valueOf(entry, rowAlias, params)} AS ${entry.lateral} ON TRUE`,
    );

    return `(SELECT ${rowAlias}.*, ${columns.join(', ')} FROM ${from} AS ${rowAlias} ${joins.join(' ')})`;
  };

  const set: CompiledObjectSet = {
    ...inner,
    row,
    hasComputedDerived: () => computed.size > 0 || inner.hasComputedDerived(),
    hasPageDerived: () =>
      [...returned, ...pageComputed].some((entry) => !computed.has(entry)) || inner.hasPageDerived(),
    source: (params) => {
      const used = layer.filter((entry) => computed.has(entry));

      return used.length === 0 ? inner.source(params) : append(inner.source(params), alias, used, params);
    },
    pageSource: (base, params) => {
      const from = inner.pageSource(base, params);
      const used = layer.filter((entry) => pageComputed.has(entry) && !computed.has(entry));

      return used.length === 0 ? from : append(from, pageAlias, used, params);
    },
  };

  return { set, alias, hops };
}
