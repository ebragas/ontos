import type { DbFailure } from '../db/index.ts';
import { unsupportedFeature, type ApiError, type AsyncFallible, type Fault } from '../errors/index.ts';
import type { Ctx, RouteInput, WriteCtx } from '../handler/index.ts';
import { apply } from './apply.ts';
import { history } from './history.ts';

export { warmWorker } from '../functions/index.ts';

export { executeQuery } from './query.ts';

export type * from './edit.ts';

export function applyAction(input: RouteInput, ctx: WriteCtx): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  return apply(input, ctx);
}

export async function* applyActionBatch(): AsyncFallible<Response, ApiError> {
  return yield unsupportedFeature('applyBatch');
}

export function editsHistory(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure> {
  return history(input, ctx);
}
