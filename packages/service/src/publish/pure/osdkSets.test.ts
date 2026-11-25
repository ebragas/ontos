import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../errors/index.ts';
import { readOsdkSets, type ListedOsdkSet } from '../../ontology/index.ts';
import type { OsdkSet } from '../index.ts';
import { checkOsdkSet } from '../publish.test-utils.ts';
import { deprecationWarning, OSDK_SET_PACKAGES } from './osdkSets.ts';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));

function readJson<T>(pathFromRepo: string): T {
  return JSON.parse(readFileSync(`${repo}${pathFromRepo}`, 'utf8')) as T;
}

const OSDK_SETS_FILE = readJson<ListedOsdkSet[]>('packages/service/osdk-sets.json');

const LISTED_SET: OsdkSet = OSDK_SETS_FILE[0]?.packages ?? {};

const UNLISTED_VERSION = '0.0.0';

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function refusal(set: OsdkSet, listed: readonly ListedOsdkSet[] = OSDK_SETS_FILE): ApiError {
  let thrown: unknown;

  try {
    checkOsdkSet(listed, set);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ApiError);

  return thrown as ApiError;
}

function refusedFor(packages: readonly string[]): Pick<ApiError, 'status' | 'errorName' | 'parameters'> {
  return {
    status: 400,
    errorName: 'Default:InvalidArgument',
    parameters: { packages, listedOsdkSets: OSDK_SETS_FILE },
  };
}

describe('an OSDK set', () => {
  it('service/releases#osdk-sets: each listed set has one exact version of each of the 5 packages, and no other package', () => {
    expect(OSDK_SET_PACKAGES).toEqual([
      '@osdk/maker',
      '@osdk/maker-experimental',
      '@osdk/client',
      '@osdk/cli',
      '@osdk/functions',
    ]);

    expect(OSDK_SETS_FILE.length).toBeGreaterThan(0);

    for (const set of OSDK_SETS_FILE) {
      expect(Object.keys(set.packages).sort()).toEqual([...OSDK_SET_PACKAGES].sort());

      for (const version of Object.values(set.packages)) expect(version).toMatch(EXACT_VERSION);
    }
  });

  it('service/releases#osdk-sets: an exact pre-release version is exact', () => {
    expect('2.81.0-beta.3').toMatch(EXACT_VERSION);

    const beta = { ...LISTED_SET, '@osdk/client': '2.81.0-beta.3' };

    expect(() =>
      checkOsdkSet([{ name: 'client-2.81.0-beta.3', packages: beta, platformPackages: {} }], beta),
    ).not.toThrow();
  });

  it.each(['^2.80.0', '~2.80.0', '>=2.80.0', '2.80.x', '*', '2.80.0 - 2.81.0'])(
    'service/releases#osdk-sets: a set with the version range %s is refused, because each version is exact',
    (range) => {
      expect(range).not.toMatch(EXACT_VERSION);
      expect(refusal({ ...LISTED_SET, '@osdk/client': range })).toMatchObject(refusedFor(['@osdk/client']));
    },
  );

  it('service/releases#osdk-sets: a set with no version of 1 of the 5 packages is refused, and the error names the package', () => {
    const set: Record<string, string> = { ...LISTED_SET };

    delete set['@osdk/functions'];

    expect(refusal(set)).toMatchObject(refusedFor(['@osdk/functions']));
  });

  it('service/releases#osdk-sets: a set with a package outside the 5 is refused, and the error names the package', () => {
    expect(refusal({ ...LISTED_SET, '@osdk/foundry.ontologies': '2.78.0' })).toMatchObject(
      refusedFor(['@osdk/foundry.ontologies']),
    );
  });
});

describe('the sets of a release', () => {
  it('service/releases#osdk-sets: the release reads its sets from packages/service/osdk-sets.json', () => {
    expect(readOsdkSets()).toEqual(OSDK_SETS_FILE);
  });

  it('service/releases#osdk-sets: each listed set names, in platformPackages, the exact @osdk/foundry.ontologies version that its @osdk/client depends on, and the @osdk/foundry.admin version on the same @osdk/foundry.core', () => {
    const client = readJson<{ version?: string; dependencies?: Record<string, string> }>(
      'node_modules/@osdk/client/package.json',
    );

    const admin = readJson<{ version?: string; dependencies?: Record<string, string> }>(
      'node_modules/@osdk/foundry.admin/package.json',
    );

    for (const set of OSDK_SETS_FILE) {
      expect(client.version).toBe(set.packages['@osdk/client']);
      expect(client.dependencies?.['@osdk/foundry.ontologies']).toMatch(EXACT_VERSION);
      expect(set.platformPackages['@osdk/foundry.ontologies']).toBe(client.dependencies?.['@osdk/foundry.ontologies']);
      expect(admin.version).toBe(set.platformPackages['@osdk/foundry.admin']);
      expect(client.dependencies?.['@osdk/foundry.core']).toMatch(EXACT_VERSION);
      expect(admin.dependencies?.['@osdk/foundry.core']).toBe(client.dependencies?.['@osdk/foundry.core']);

      for (const version of Object.values(set.platformPackages)) expect(version).toMatch(EXACT_VERSION);
    }
  });

  it('service/releases#osdk-sets: the publish check compares only the 5 packages, so a set with a platform package is refused', () => {
    for (const set of OSDK_SETS_FILE) {
      expect(() => checkOsdkSet(OSDK_SETS_FILE, set.packages)).not.toThrow();

      expect(refusal({ ...set.packages, ...set.platformPackages })).toMatchObject(
        refusedFor(Object.keys(set.platformPackages)),
      );
    }
  });
});

describe('the check of the set of a publish', () => {
  it('service/releases#osdk-sets: each listed set passes', () => {
    for (const set of OSDK_SETS_FILE) expect(() => checkOsdkSet(OSDK_SETS_FILE, set.packages)).not.toThrow();
  });

  it('service/releases#osdk-sets: a set that the release does not list is refused with 400, and the error names the package and the listed sets', () => {
    expect(refusal({ ...LISTED_SET, '@osdk/client': UNLISTED_VERSION })).toMatchObject({
      status: 400,
      errorName: 'Default:InvalidArgument',
      parameters: { packages: ['@osdk/client'], listedOsdkSets: OSDK_SETS_FILE },
    });
  });

  it('service/releases#osdk-sets: a set that differs in 2 packages names both, in the order of the 5 packages', () => {
    expect(
      refusal({ ...LISTED_SET, '@osdk/functions': UNLISTED_VERSION, '@osdk/maker': UNLISTED_VERSION }),
    ).toMatchObject(refusedFor(['@osdk/maker', '@osdk/functions']));
  });
});

describe('a deprecated OSDK set', () => {
  const old: ListedOsdkSet = { name: 'client-2.80.0', packages: LISTED_SET, platformPackages: {}, deprecated: true };

  const newer: ListedOsdkSet = {
    name: 'client-2.90.0',
    packages: { ...LISTED_SET, '@osdk/client': '2.90.0' },
    platformPackages: {},
  };

  const newest: ListedOsdkSet = {
    name: 'client-3.0.0',
    packages: { ...LISTED_SET, '@osdk/client': '3.0.0' },
    platformPackages: {},
  };

  it('service/releases#osdk-sets: a deprecated set passes the check, and the warning names it and each set that is not deprecated', () => {
    const listed = [old, newer, newest];
    const set = checkOsdkSet(listed, old.packages);

    expect(set).toBe(old);

    expect(deprecationWarning(listed, set)).toBe(
      'The OSDK set client-2.80.0 is deprecated. Move to an OSDK set that is not deprecated: client-2.90.0, client-3.0.0. Only a new major version can remove it.',
    );
  });

  it('service/releases#osdk-sets: a set that is not deprecated gets no warning', () => {
    const listed = [old, newer];

    expect(deprecationWarning(listed, checkOsdkSet(listed, newer.packages))).toBeUndefined();
  });

  it('service/releases#osdk-sets: the first listed set is not deprecated', () => {
    expect(OSDK_SETS_FILE[0]?.deprecated).not.toBe(true);
  });

  it('service/releases#osdk-sets: when each listed set is deprecated, the warning says that no set is not deprecated', () => {
    expect(deprecationWarning([old], old)).toBe(
      'The OSDK set client-2.80.0 is deprecated. This release lists no OSDK set that is not deprecated. Only a new major version can remove it.',
    );
  });
});
