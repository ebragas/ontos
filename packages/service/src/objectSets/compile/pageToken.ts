import { createHash } from 'node:crypto';
import { jsonValueOf } from '../../db/index.ts';
import { ApiError, caught, type Fallible } from '../../errors/index.ts';
import type { SortKey } from './order.ts';
import { isRecord } from './request.ts';

const PAGE_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export function bodyChecksum(body: Readonly<Record<string, unknown>>): string {
  const fields = Object.entries(body).filter(
    ([key, value]) => key !== 'pageToken' && value !== null && value !== undefined,
  );

  return createHash('sha256')
    .update(canonical(Object.fromEntries(fields)))
    .digest('base64url');
}

const MAX_CANONICAL_DEPTH = 64;

function canonical(value: unknown, depth = 0): string {
  if (depth >= MAX_CANONICAL_DEPTH) return '"[depth]"';

  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

interface PageTokenFields {
  readonly values: readonly unknown[];
  readonly checksum: string;
  readonly expires: number;
}

export function pageToken(values: readonly unknown[], checksum: string, now: number): string {
  const fields: PageTokenFields = { values, checksum, expires: now + PAGE_TOKEN_LIFETIME_MS };

  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}

export function* readPageToken(
  token: string,
  request: { readonly checksum: string; readonly keys: readonly SortKey[]; readonly now: number },
): Fallible<unknown[], ApiError> {
  const parsed = caught((): unknown => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  const fields = parsed.ok ? parsed.value : undefined;
  const invalid = new ApiError(400, 'InvalidPageToken', { pageToken: token });

  const valid =
    isRecord(fields) &&
    fields.checksum === request.checksum &&
    typeof fields.expires === 'number' &&
    request.now < fields.expires &&
    Array.isArray(fields.values) &&
    fields.values.length === request.keys.length;

  if (!valid) return yield invalid;

  const sent = fields.values as unknown[];
  const values = request.keys.map((key, index) => (sent[index] === null ? null : jsonValueOf(sent[index], key.type)));

  if (values.includes(undefined)) return yield invalid;

  return values;
}
