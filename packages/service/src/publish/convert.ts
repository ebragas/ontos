import type { OntologyFullMetadata } from '@osdk/foundry.ontologies';
import { type Fallible } from '../errors/index.ts';
import {
  compileOntology,
  emptyOntology,
  type CompileError,
  type CompiledOntology,
  type StoredOntologyVersion,
} from '../ontology/index.ts';
import { toFullMetadata } from './metadata.ts';
import { standInFunctions } from './pure/standInFunctions.ts';

export * from './pure/convertReexports.ts';

/** The parts of a publish request that the compile step and the converter read. The compile step parses the IR and the Functions. */
export type ConvertRequest = Pick<StoredOntologyVersion, 'ir' | 'osdkSet' | 'functions'> & {
  readonly validateOnly: boolean;
};

/**
 * Compiles the IR into Ontology version `version` of the Ontology `ontologyRid`, and converts it to the Ontology
 * metadata. A validateOnly request with no Functions compiles with stand-in Functions. Yields `CompileError` for an
 * IR outside V1.
 */
export function* convert(
  request: ConvertRequest,
  ontologyRid: string,
  version: number,
): Fallible<CompiledOntology, CompileError> {
  const placeholder = emptyOntology(ontologyRid).metadata;
  const functions = request.functions ?? (request.validateOnly ? standInFunctions(request.ir) : undefined);

  const compiled = yield* compileOntology({
    version,
    ir: request.ir,
    metadata: placeholder,
    osdkSet: request.osdkSet,
    ...(functions ? { functions } : {}),
  });

  return { ...compiled, metadata: toFullMetadata(compiled) };
}

/** The metadata of a `validateOnly` publish with no Functions: each function-backed Action Type has no parameters. */
export function withoutFunctionParameters(ontology: CompiledOntology): OntologyFullMetadata {
  const actionTypes = { ...ontology.metadata.actionTypes };

  for (const action of ontology.actionTypes.values()) {
    if (action.logic.kind !== 'function') continue;

    const type = actionTypes[action.apiName];

    if (type) actionTypes[action.apiName] = { ...type, parameters: {} };
  }

  return { ...ontology.metadata, actionTypes };
}

/**
 * The Ontology metadata that a `validateOnly` publish of the same IR and Functions gives, with no database: the
 * metadata of `generate-osdk`. With no Functions, each function-backed Action Type has no parameters.
 */
export function* ontologyMetadata(
  request: Omit<ConvertRequest, 'validateOnly'>,
  ontologyRid: string,
): Fallible<OntologyFullMetadata, CompileError> {
  const ontology = yield* convert({ ...request, validateOnly: true }, ontologyRid, 1);

  return request.functions ? ontology.metadata : withoutFunctionParameters(ontology);
}
