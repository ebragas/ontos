import { queryNotFound, queryVersionNotFound, type ApiError, type Fallible } from '../../errors/index.ts';
import type { CompiledOntology } from '../compiled/objects.ts';
import type { QueryFunction } from '../compiled/rules.ts';

export const QUERY_TYPE_VERSION = '0.0.0';

export function* queryOf(
  ontology: CompiledOntology,
  apiName: string,
  version: string | null,
): Fallible<QueryFunction, ApiError> {
  const fn = ontology.functions.get(apiName);

  if (fn?.kind !== 'query' || !Object.hasOwn(ontology.metadata.queryTypes, apiName))
    return yield queryNotFound(apiName);

  if (version !== null && version !== QUERY_TYPE_VERSION) return yield queryVersionNotFound(apiName, version);

  return fn;
}
