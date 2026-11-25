import { readSource, type Reader } from '../../db/index.ts';
import { ApiError, unsupportedFeature, type Fallible } from '../../errors/index.ts';
import type { CompiledObjectType, CompiledOntology } from '../../ontology/index.ts';
import {
  DefinitionBudget,
  methodInput,
  Names,
  withObjectTypeDerived,
  withProperties,
  type DerivedUses,
} from './derived.ts';
import { isSetOperation, searchAround, setOperation } from './members.ts';
import { ROW } from './objects.ts';
import { invalid, isRecord } from './request.ts';
import { storedRow, type Row } from './row.ts';
import type { Params } from './sql.ts';
import { compileWhere, TextSearchBudget } from './where.ts';

export interface CompiledObjectSet {
  readonly objectType: CompiledObjectType;
  readonly objectTypes: readonly string[];
  readonly source: (params: Params) => string;
  readonly pageSource: (base: string, params: Params) => string;
  readonly hasComputedDerived: () => boolean;
  readonly hasPageDerived: () => boolean;
  readonly row: Row;
}

const MAX_OBJECT_SET_DEPTH = 64;

export interface CompileEnv {
  readonly reader: Reader;
  readonly ontology: CompiledOntology;
  readonly budget: TextSearchBudget;
  readonly names: Names;
  readonly uses: DerivedUses;
  readonly definitions: DefinitionBudget;
  readonly layers: number;
  readonly depth: number;
  readonly input?: HopInput;
}

export interface HopInput {
  readonly set: CompiledObjectSet;
  readonly alias: string;
}

export function compileObjectSet(
  reader: Reader,
  tree: unknown,
  ontology: CompiledOntology,
  uses: DerivedUses,
): Fallible<CompiledObjectSet, ApiError> {
  return compileMember(tree, {
    reader,
    ontology,
    budget: new TextSearchBudget(),
    names: new Names(),
    uses,
    definitions: new DefinitionBudget(),
    layers: 0,
    depth: 0,
  });
}

function* compileMember(tree: unknown, env: CompileEnv): Fallible<CompiledObjectSet, ApiError> {
  if (env.depth >= MAX_OBJECT_SET_DEPTH) return yield invalid('objectSet');

  if (!isRecord(tree) || typeof tree.type !== 'string') return yield invalid('objectSet');

  const deeper: CompileEnv = { ...env, depth: env.depth + 1 };

  if (tree.type === 'filter') return yield* filterSet(tree, deeper);

  if (tree.type === 'methodInput') return yield* methodInput(env);

  if (tree.type === 'withProperties') return yield* withProperties(tree, deeper, compileMember);

  if (isSetOperation(tree.type))
    return withObjectTypeDerived(yield* setOperation(tree.type, tree, deeper, compileMember), deeper, compileMember);

  if (tree.type === 'searchAround')
    return withObjectTypeDerived(yield* searchAround(tree, deeper, compileMember), deeper, compileMember);

  if (tree.type !== 'base') return yield unsupportedFeature(tree.type);

  if (typeof tree.objectType !== 'string') return yield invalid('objectSet');

  const objectType = env.ontology.objectTypes.get(tree.objectType);

  if (!objectType) return yield new ApiError(404, 'ObjectTypeNotFound', { objectType: tree.objectType });

  return withObjectTypeDerived(
    {
      objectType,
      objectTypes: [objectType.apiName],
      source: (params) => readSource(env.reader, objectType, params),
      pageSource: (base) => base,
      hasComputedDerived: () => false,
      hasPageDerived: () => false,
      row: storedRow(objectType),
    },
    deeper,
    compileMember,
  );
}

function* filterSet(tree: Readonly<Record<string, unknown>>, env: CompileEnv): Fallible<CompiledObjectSet, ApiError> {
  const set = yield* compileMember(tree.objectSet, env);
  const where = yield* compileWhere(tree.where, set, env.budget);

  return {
    ...set,
    source: (params) => `(SELECT ${ROW}.* FROM ${set.source(params)} AS ${ROW} WHERE ${where(params)})`,
  };
}
