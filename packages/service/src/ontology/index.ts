import { existsSync, readFileSync } from 'node:fs';
import { invariant } from '../errors/index.ts';
import type { ListedOsdkSet } from './compiled/stored.ts';

export * from './access/public.ts';

export * from './compiled/index.ts';

export * from './derived/public.ts';

export * from './model/public.ts';

export * from './routes.ts';

const OSDK_SETS_CANDIDATES = [
  new URL('../../osdk-sets.json', import.meta.url),
  new URL('../osdk-sets.json', import.meta.url),
  new URL('../../../osdk-sets.json', import.meta.url),
];

export function readOsdkSets(): readonly ListedOsdkSet[] {
  const path = OSDK_SETS_CANDIDATES.find((candidate) => existsSync(candidate)) ?? OSDK_SETS_CANDIDATES[0];

  invariant(path !== undefined, 'osdk-sets.json not found.');

  return JSON.parse(readFileSync(path, 'utf8')) as ListedOsdkSet[];
}
