import { ApiError, type Fallible } from '../../errors/index.ts';
import { sameOsdkSet, type ListedOsdkSet } from '../../ontology/index.ts';
import type { OsdkSet } from '../index.ts';

export const OSDK_SET_PACKAGES = [
  '@osdk/maker',
  '@osdk/maker-experimental',
  '@osdk/client',
  '@osdk/cli',
  '@osdk/functions',
] as const;

export function* checkOsdkSet(listed: readonly ListedOsdkSet[], set: OsdkSet): Fallible<ListedOsdkSet, ApiError> {
  const match = listed.find((entry) => sameOsdkSet(entry.packages, set));

  if (match) return match;

  const names = [
    ...OSDK_SET_PACKAGES,
    ...Object.keys(set).filter((name) => !(OSDK_SET_PACKAGES as readonly string[]).includes(name)),
  ];

  const packages = names.filter((name) => !listed.some((entry) => entry.packages[name] === set[name]));

  return yield new ApiError(400, 'Default:InvalidArgument', { packages, listedOsdkSets: listed });
}

export function deprecationWarning(listed: readonly ListedOsdkSet[], set: ListedOsdkSet): string | undefined {
  if (!set.deprecated) return undefined;

  const current = listed.filter((entry) => !entry.deprecated).map((entry) => entry.name);

  const move =
    current.length > 0
      ? `Move to an OSDK set that is not deprecated: ${current.join(', ')}.`
      : 'This release lists no OSDK set that is not deprecated.';

  return `The OSDK set ${set.name} is deprecated. ${move} Only a new major version can remove it.`;
}
