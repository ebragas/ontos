import path from 'node:path';

export const DEFAULT_SCOPE = [
  'packages/service/src/',
  'packages/service/api/',
  'packages/service/testing/',
  'packages/cli/src/',
  'tools/fallible/',
  'tools/packaging/',
  'tools/ops/',
  'tools/docs/',
] as const;

export const DEFAULT_EXCLUDED = ['packages/service/src/functions/worker.ts'] as const;

export const TEST_FILE = /\.(test|test-utils|fixture)\.ts$/;

export function resolveScopePaths(root: string, entries: readonly string[] = DEFAULT_SCOPE): string[] {
  return entries.map((entry) => path.resolve(root, entry) + (entry.endsWith('/') ? path.sep : ''));
}

export const isInScope = (scope: readonly string[], file: string, excluded: readonly string[] = []): boolean => {
  if (TEST_FILE.test(file)) return false;

  const resolved = path.resolve(file);

  if (excluded.includes(resolved)) return false;

  return scope.some((entry) => (entry.endsWith(path.sep) ? resolved.startsWith(entry) : resolved === entry));
};

export function scopeOf(scope: readonly string[], excluded: readonly string[] = []): (file: string) => boolean {
  const exact = new Set<string>();
  const excludedSet = new Set(excluded.map((entry) => path.resolve(entry)));
  const dirs: string[] = [];

  for (const entry of scope) {
    if (entry.endsWith(path.sep)) dirs.push(entry);
    else exact.add(entry);
  }

  const cache = new Map<string, boolean>();

  return (file) => {
    const cached = cache.get(file);

    if (cached !== undefined) return cached;

    let hit = false;

    if (!TEST_FILE.test(file)) {
      const resolved = path.resolve(file);

      hit = !excludedSet.has(resolved) && (exact.has(resolved) || dirs.some((dir) => resolved.startsWith(dir)));
    }

    cache.set(file, hit);

    return hit;
  };
}
