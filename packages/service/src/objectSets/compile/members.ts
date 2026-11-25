import { linkSource, quoteName, readSource, type Reader } from '../../db/index.ts';
import { ApiError, each, invariant, type Fallible } from '../../errors/index.ts';
import type { CompiledLink, CompiledObjectType } from '../../ontology/index.ts';
import type { CompileEnv, CompiledObjectSet } from './objectSet.ts';
import { ROW } from './objects.ts';
import { invalid } from './request.ts';
import { storedRow } from './row.ts';
import type { Params } from './sql.ts';

type Tree = Readonly<Record<string, unknown>>;

type Compile = (tree: unknown, env: CompileEnv) => Fallible<CompiledObjectSet, ApiError>;

const OPERATORS = { union: 'UNION', intersect: 'INTERSECT', subtract: 'EXCEPT' } as const;

type SetOperation = keyof typeof OPERATORS;

const SET = 's';
const LINK = 'l';

export function isSetOperation(type: string): type is SetOperation {
  return Object.hasOwn(OPERATORS, type);
}

export function* setOperation(
  type: SetOperation,
  tree: Tree,
  env: CompileEnv,
  compile: Compile,
): Fallible<CompiledObjectSet, ApiError> {
  if (!Array.isArray(tree.objectSets)) return yield invalid('objectSet');

  const sets = yield* each(tree.objectSets, (child) => compile(child, env));
  const objectType = sets[0]?.objectType;

  if (!objectType || sets.some((set) => set.objectType.apiName !== objectType.apiName))
    return yield invalid('objectSet');

  const key = primaryKeyColumn(objectType);

  return {
    objectType,
    objectTypes: distinct(sets.flatMap((set) => set.objectTypes)),
    source: (params) => {
      const keys = sets
        .map((set) => `SELECT ${SET}.${key} FROM ${set.source(params)} AS ${SET}`)
        .join(` ${OPERATORS[type]} `);

      return rowsOf(env.reader, objectType, params, `${ROW}.${key} IN (${keys})`);
    },
    pageSource: (base) => base,
    hasComputedDerived: () => sets.some((set) => set.hasComputedDerived()),
    hasPageDerived: () => false,
    row: storedRow(objectType),
  };
}

export function* searchAround(tree: Tree, env: CompileEnv, compile: Compile): Fallible<CompiledObjectSet, ApiError> {
  const set = yield* compile(tree.objectSet, env);

  if (typeof tree.link !== 'string') return yield invalid('objectSet');

  const link = set.objectType.links.get(tree.link);

  if (!link)
    return yield new ApiError(404, 'LinkTypeNotFound', { objectType: set.objectType.apiName, linkType: tree.link });

  const target = env.ontology.objectTypes.get(link.target);

  invariant(
    target,
    `The Link side ${link.apiName} links to the Object Type ${link.target}, which the Ontology does not have.`,
  );

  return {
    objectType: target,
    objectTypes: distinct([...set.objectTypes, target.apiName]),
    source: (params) => rowsOf(env.reader, target, params, linked(env.reader, link, set, target, params)),
    pageSource: (base) => base,
    hasComputedDerived: () => set.hasComputedDerived(),
    hasPageDerived: () => false,
    row: storedRow(target),
  };
}

function linked(
  reader: Reader,
  link: CompiledLink,
  set: CompiledObjectSet,
  target: CompiledObjectType,
  params: Params,
): string {
  const from = `FROM ${set.source(params)} AS ${SET}`;

  switch (link.via.kind) {
    case 'foreignKeyHere':
      return `${ROW}.${primaryKeyColumn(target)} IN (SELECT ${SET}.${quoteName(link.via.column)} ${from})`;
    case 'foreignKeyOnTarget':
      return `${ROW}.${quoteName(link.via.column)} IN (SELECT ${SET}.${primaryKeyColumn(set.objectType)} ${from})`;
    case 'joinTable': {
      const table = linkSource(reader, link.via);
      const sources = `SELECT ${SET}.${primaryKeyColumn(set.objectType)} ${from}`;

      return `${ROW}.${primaryKeyColumn(target)} IN (SELECT ${LINK}.${quoteName(link.via.targetColumn)} FROM ${table} AS ${LINK} WHERE ${LINK}.${quoteName(link.via.sourceColumn)} IN (${sources}))`;
    }
  }
}

function rowsOf(reader: Reader, objectType: CompiledObjectType, params: Params, condition: string): string {
  return `(SELECT ${ROW}.* FROM ${readSource(reader, objectType, params)} AS ${ROW} WHERE ${condition})`;
}

function primaryKeyColumn(objectType: CompiledObjectType): string {
  return quoteName(objectType.primaryKey.column);
}

function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}
