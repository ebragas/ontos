import type { DbFailure } from '../db/index.ts';
import { jsonStream, mapStream, type ApiError, type AsyncFallible } from '../errors/index.ts';
import type { Ctx, RouteInput } from '../handler/index.ts';
import { compileAggregation, readAggregateRequest } from './compile/aggregation.ts';
import { DerivedUses } from './compile/derived.ts';
import { compileObjectSet } from './compile/objectSet.ts';
import { mapReadFailures, reportSqlTime } from './stream.ts';

export async function* aggregateGroups(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure> {
  const request = yield* readAggregateRequest(input.body);
  const uses = new DerivedUses();
  const set = yield* compileObjectSet(ctx.reader, request.objectSet, ctx.ontology, uses);
  const aggregation = yield* compileAggregation(request, set);
  let excludedItems = 0;
  const rows = mapReadFailures(ctx.db.stream(aggregation.sql()), uses);

  const traced =
    uses.size > 0 ? reportSqlTime(rows, (sqlMs) => ctx.traceDerived({ values: uses.values(), sqlMs })) : rows;

  const groups = mapStream(traced, (row) => {
    excludedItems = aggregation.excludedItems(row);

    return aggregation.toGroup(row);
  });

  const body = yield* jsonStream(
    () => ({ accuracy: 'ACCURATE' }),
    'data',
    groups,
    () => (aggregation.grouped ? { excludedItems } : {}),
  );

  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}
