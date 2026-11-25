import type { ApiError, AsyncFallible } from '../../errors/index.ts';
import type { Ctx, RouteInput } from '../../handler/index.ts';
import { queryOf } from '../model/queries.ts';
import { page } from './pagination.ts';

const QUERY_PAGE_SIZE = 100;

export async function* listQueryTypes(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  const queryTypes = ctx.ontology.metadata.queryTypes;

  return Response.json(yield* page(Object.keys(queryTypes), input.query, (name) => queryTypes[name], QUERY_PAGE_SIZE));
}

export async function* getQueryType(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  const fn = yield* queryOf(ctx.ontology, input.params['queryApiName'] ?? '', input.query.get('version'));

  return Response.json(ctx.ontology.metadata.queryTypes[fn.apiName]);
}
