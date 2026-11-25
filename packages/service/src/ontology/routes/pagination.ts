import { ApiError, caught, type Fallible } from '../../errors/index.ts';

const PAGE_SIZE = 500;

export function* page<T>(
  names: readonly string[],
  query: URLSearchParams,
  entry: (name: string) => T,
  maximum = PAGE_SIZE,
): Fallible<{ data: T[]; nextPageToken?: string }, ApiError> {
  const size = yield* pageSizeOf(query.get('pageSize'), maximum);
  const token = query.get('pageToken');
  const after = token === null ? undefined : yield* readPageToken(token);
  const sorted = [...names].sort();
  const rest = after === undefined ? sorted : sorted.filter((name) => name > after);
  const shown = rest.slice(0, size);
  const last = shown.at(-1);

  return {
    data: shown.map(entry),
    ...(rest.length > size && last !== undefined
      ? { nextPageToken: Buffer.from(JSON.stringify(last), 'utf8').toString('base64url') }
      : {}),
  };
}

function* pageSizeOf(value: string | null, maximum: number): Fallible<number, ApiError> {
  if (value === null) return maximum;

  if (!/^-?\d+$/.test(value)) return yield new ApiError(400, 'Default:InvalidArgument');

  const pageSize = Number(value);

  if (pageSize <= 0) return yield new ApiError(400, 'InvalidPageSize', { pageSize });

  return Math.min(pageSize, maximum);
}

function* readPageToken(token: string): Fallible<string, ApiError> {
  const parsed = caught(() => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown);
  const name = parsed.ok ? parsed.value : undefined;

  if (typeof name !== 'string') return yield new ApiError(400, 'InvalidPageToken', { pageToken: token });

  return name;
}
