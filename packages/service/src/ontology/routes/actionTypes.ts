import { actionTypeNotFound, ApiError, type AsyncFallible } from '../../errors/index.ts';
import type { Ctx, RouteInput } from '../../handler/index.ts';
import { page } from './pagination.ts';

export async function* getActionType(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  const actionType = input.params['actionType'] ?? '';

  const metadata = Object.hasOwn(ctx.ontology.metadata.actionTypes, actionType)
    ? ctx.ontology.metadata.actionTypes[actionType]
    : undefined;

  if (!metadata) return yield actionTypeNotFound(actionType, ctx.ontology.publishedActionTypeNames.get(actionType));

  return Response.json(metadata);
}

export async function* listActionTypes(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  const actionTypes = ctx.ontology.metadata.actionTypes;

  return Response.json(yield* page(Object.keys(actionTypes), input.query, (name) => actionTypes[name]));
}

export async function* getActionTypeByRid(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  const rid = input.params['actionTypeRid'] ?? '';
  const metadata = Object.values(ctx.ontology.metadata.actionTypes).find((actionType) => actionType.rid === rid);

  if (!metadata) return yield new ApiError(404, 'ActionTypeNotFound', { rid });

  return Response.json(metadata);
}
