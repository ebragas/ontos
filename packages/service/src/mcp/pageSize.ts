import type { JsonValue } from '../ontology/index.ts';

const DEFAULT_PAGE_SIZE = 50;

export function pageSizeOf(value: JsonValue | undefined, max: number): JsonValue {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;

  if (Number.isInteger(value) && (value as number) > max) return max;

  return value;
}
