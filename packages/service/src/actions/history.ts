import type { DbFailure } from '../db/index.ts';
import { ApiError, jsonStream, mapStream, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { Ctx, RouteInput } from '../handler/index.ts';
import type { CompiledObjectType, JsonValue } from '../ontology/index.ts';
import {
  historyEntry,
  historySql,
  pageToken,
  positionOf,
  readHistoryRequest,
  type HistoryRow,
} from './pure/history.ts';

export async function* history(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure> {
  const objectType = yield* objectTypeOf(input, ctx);
  const request = yield* readHistoryRequest(input.body, objectType);
  const rows = ctx.db.stream<HistoryRow>(historySql(ctx.reader, objectType, request));
  let count = 0;
  let last: HistoryRow | undefined;
  let more = false;

  const entries = mapStream(rows, (row): JsonValue | undefined => {
    if (count === request.pageSize) {
      more = true;

      return undefined;
    }

    count += 1;

    last = row;

    return historyEntry(row, request, objectType);
  });

  const tail = () => ({
    totalCount: count,
    ...(more && last ? { nextPageToken: pageToken(positionOf(last)) } : {}),
  });

  return new Response(yield* jsonStream(() => ({}), 'data', entries, tail), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function* objectTypeOf(input: RouteInput, ctx: Ctx): Fallible<CompiledObjectType, ApiError> {
  const apiName = input.params['objectType'] ?? '';
  const objectType = ctx.ontology.objectTypes.get(apiName);

  if (!objectType) return yield new ApiError(404, 'ObjectTypeNotFound', { objectType: apiName });

  return objectType;
}
