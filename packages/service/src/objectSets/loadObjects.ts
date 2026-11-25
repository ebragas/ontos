import type { DbFailure } from '../db/index.ts';
import { jsonStream, mapStream, type ApiError, type AsyncFallible } from '../errors/index.ts';
import type { Ctx, RouteInput } from '../handler/index.ts';
import { DerivedUses } from './compile/derived.ts';
import { compileObjectSet } from './compile/objectSet.ts';
import { objectReader } from './compile/objects.ts';
import { sortKeys } from './compile/order.ts';
import { bodyChecksum, holdsObject, pageSql, pageToken, readPageToken, sortValues, totalOf } from './compile/page.ts';
import { readLoadObjectsRequest } from './compile/request.ts';
import { mapReadFailures, reportSqlTime } from './stream.ts';

export async function* loadPage(input: RouteInput, ctx: Ctx): AsyncFallible<Response, ApiError | DbFailure> {
  const now = Date.now();
  const request = yield* readLoadObjectsRequest(input.body);
  const uses = new DerivedUses();
  const set = yield* compileObjectSet(ctx.reader, request.objectSet, ctx.ontology, uses);

  const reader = yield* objectReader(set, request.select, {
    excludeRid: request.excludeRid,
    ontologyRid: ctx.ontology.productRid,
    ...(request.loadOntologyDefinedDerivedProperties === undefined
      ? {}
      : { ontologyDerived: request.loadOntologyDefinedDerivedProperties }),
    loadDerivedProperties: ctx.loadDerivedProperties === true,
  });

  const keys = yield* sortKeys(set, request.orderBy);
  const checksum = bodyChecksum(input.body as Readonly<Record<string, unknown>>);

  const after =
    request.pageToken === undefined ? undefined : yield* readPageToken(request.pageToken, { checksum, keys, now });

  const includeTotalCount = ctx.includeTotalCount !== false;
  let totalCount = '0';
  let last: unknown[] | undefined;
  let nextAfter: unknown[] | undefined;
  let read = 0;

  const rows = mapReadFailures(
    ctx.db.stream(pageSql(set, reader, keys, request.pageSize, after, includeTotalCount)),
    uses,
  );

  const traced =
    uses.size > 0
      ? reportSqlTime(rows, (sqlMs) => ctx.traceDerived({ values: uses.values(), objects: read, sqlMs }))
      : rows;

  const objects = mapStream(traced, (row) => {
    if (includeTotalCount) totalCount = totalOf(row);

    if (!holdsObject(row)) return undefined;

    if (read === request.pageSize) {
      nextAfter = last;

      return undefined;
    }

    read += 1;

    last = sortValues(keys, row);

    return reader.toObject(row);
  });

  const head = () => ({
    totalCount,
    propertySecurities: [],
    ...(after === undefined ? { objectSetEntities: { objectTypeApiNames: set.objectTypes } } : {}),
  });

  const body = yield* jsonStream(head, 'data', objects, () =>
    nextAfter === undefined ? {} : { nextPageToken: pageToken(nextAfter, checksum, Date.now()) },
  );

  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}
