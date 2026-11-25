import type { DbFailure } from '../db/index.ts';
import type { ApiError, AsyncFallible } from '../errors/index.ts';
import type { Ctx, RouteInput } from '../handler/index.ts';
import { aggregateGroups } from './aggregate.ts';
import { loadPage } from './loadObjects.ts';

export type { DerivedRead, DerivedUse } from './compile/derived.ts';

export function loadObjects(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure> {
  return loadPage(input, ctx);
}

export function aggregate(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure> {
  return aggregateGroups(input, ctx);
}
