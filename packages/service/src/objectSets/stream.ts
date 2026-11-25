import type { DbFailure } from '../db/index.ts';
import { ApiError, mapStream, type FallibleStream } from '../errors/index.ts';
import type { DerivedUses } from './compile/derived.ts';

const NUMERIC_VALUE_OUT_OF_RANGE = '22003';
const TOO_MANY_COLUMNS = '54011';

const MAX_RESULT_COLUMNS = 1664;

export async function* mapReadFailures<T>(
  stream: FallibleStream<T, DbFailure>,
  uses: DerivedUses,
): FallibleStream<T, DbFailure | ApiError> {
  const failure = yield* stream;
  const code = (failure?.error as { code?: unknown } | undefined)?.code;

  if (code === TOO_MANY_COLUMNS)
    return new ApiError(400, 'Default:InvalidArgument', { maximumColumns: MAX_RESULT_COLUMNS });

  if (code === NUMERIC_VALUE_OUT_OF_RANGE && uses.hasRequest()) {
    return new ApiError(400, 'Default:InvalidArgument', { field: 'derivedProperties' });
  }

  return failure;
}

export async function* reportSqlTime<T, E>(
  stream: FallibleStream<T, E>,
  done: (ms: number) => void,
): FallibleStream<T, E> {
  const start = performance.now();
  const end = (ms: number) => done(ms);
  let sqlMs: number | undefined;

  try {
    return yield* mapStream(stream, (row) => {
      sqlMs ??= performance.now() - start;

      return row;
    });
  } finally {
    end(sqlMs ?? performance.now() - start);
  }
}
