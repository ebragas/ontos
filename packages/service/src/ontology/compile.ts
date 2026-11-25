import { type Fallible } from '../errors/index.ts';
import { compileActionTypes } from './actionTypes/compile.ts';
import type { CompiledOntology, CompileError, StoredOntologyVersion } from './compiled/index.ts';
import { compileFunctions } from './model/functions.ts';
import { compileLinkTypes } from './model/linkTypes.ts';
import { checkOneApiNamespace, publishedActionTypeNames } from './model/names.ts';
import { record } from './model/shape.ts';
import { checkOntologyFeatures, compileObjectTypes } from './objectTypes/compile.ts';
import { attachDerived } from './objectTypes/derived.ts';
import { ridNamespace } from './rids.ts';
import { compileValueTypes } from './valueTypes.ts';

export function* compileOntology(
  stored: Omit<StoredOntologyVersion, 'grants'>,
): Fallible<CompiledOntology, CompileError> {
  const namespace = yield* ridNamespace(stored.metadata.ontology.rid);
  const ir = yield* record(stored.ir, 'ir');
  const valueTypes = yield* compileValueTypes(ir, namespace);
  const ontology = yield* record(ir['ontology'], 'ontology');

  yield* checkOntologyFeatures(ontology);

  const irObjectTypes = yield* record(ontology['objectTypes'], 'ontology.objectTypes');

  const { objectTypes: compiledObjectTypes, readOnly } = yield* compileObjectTypes(
    irObjectTypes,
    namespace,
    valueTypes,
  );

  const { objectTypes: linked, linkTypes } = yield* compileLinkTypes(
    yield* record(ontology['linkTypes'], 'ontology.linkTypes'),
    compiledObjectTypes,
    namespace,
  );

  const objectTypes = yield* attachDerived(linked, linkTypes);

  const functions = yield* compileFunctions(
    stored.functions,
    new Set(objectTypes.keys()),
    readOnly,
    namespace,
    stored.version,
  );

  const actionTypes = yield* compileActionTypes(yield* record(ontology['actionTypes'], 'ontology.actionTypes'), {
    objectTypes,
    linkTypes,
    functions,
    readOnly,
    namespace,
  });

  yield* checkOneApiNamespace([...objectTypes.keys(), ...actionTypes.keys()]);

  return {
    version: stored.version,
    productRid: stored.metadata.ontology.rid,
    metadata: stored.metadata,
    objectTypes,
    linkTypes,
    actionTypes,
    publishedActionTypeNames: publishedActionTypeNames(actionTypes.keys()),
    functions,
    ...(stored.functions ? { functionBundle: stored.functions.bundle } : {}),
  };
}
