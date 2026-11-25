import type { ObjectTypeFullMetadata } from '@osdk/foundry.ontologies';
import { ApiError, type AsyncFallible, type Fallible } from '../../errors/index.ts';
import type { Ctx, RouteInput } from '../../handler/index.ts';
import { page } from './pagination.ts';

export function getOntologyFullMetadata(input: RouteInput, ctx: Ctx): Promise<Response> {
  void input;

  return Promise.resolve(Response.json(ctx.ontology.metadata));
}

export async function* getObjectTypeFullMetadata(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  return Response.json(yield* objectTypeOf(input, ctx));
}

function* objectTypeOf(input: RouteInput, ctx: Ctx): Fallible<ObjectTypeFullMetadata, ApiError> {
  const objectType = input.params['objectType'] ?? '';

  const metadata = Object.hasOwn(ctx.ontology.metadata.objectTypes, objectType)
    ? ctx.ontology.metadata.objectTypes[objectType]
    : undefined;

  if (!metadata) return yield new ApiError(404, 'ObjectTypeNotFound', { objectType });

  return metadata;
}

export async function* listObjectTypes(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  const objectTypes = ctx.ontology.metadata.objectTypes;

  return Response.json(yield* page(Object.keys(objectTypes), input.query, (name) => objectTypes[name]?.objectType));
}

export async function* getObjectType(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError> {
  return Response.json((yield* objectTypeOf(input, ctx)).objectType);
}
