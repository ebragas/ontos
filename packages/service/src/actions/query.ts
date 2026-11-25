import type { DbFailure } from '../db/index.ts';
import type { ApiError, AsyncFallible, Fault } from '../errors/index.ts';
import { runFunction } from '../functions/index.ts';
import type { Ctx, RouteInput } from '../handler/index.ts';
import type { QueryFunction } from '../ontology/index.ts';
import { checkInputs } from './pure/parameters.ts';
import { invalidBody, isRecord } from './pure/shared.ts';
import { runSnapshot } from './snapshot.ts';

export async function* executeQuery(
  fn: QueryFunction,
  input: RouteInput,
  ctx: Ctx,
): AsyncFallible<Response, ApiError | DbFailure | Fault> {
  const { body } = input;

  if (!isRecord(body) || !isRecord(body['parameters'])) return yield invalidBody();

  const inputs = yield* checkInputs(fn, body['parameters'], ctx.ontology);
  const value = yield* runSnapshot(ctx.db, (snapshot) => runFunction(fn, inputs, snapshot, ctx));

  return Response.json({ value });
}
