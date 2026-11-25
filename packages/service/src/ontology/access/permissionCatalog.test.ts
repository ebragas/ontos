import { describe, expect, it } from 'vitest';
import { checkGrantsFile } from '../../publish/grantsCheck.ts';
import { permissionIndex, SERVICE_PERMISSION_DESCRIPTIONS, SERVICE_PERMISSIONS } from '../index.ts';
import {
  convertOrThrow,
  NS,
  ONTOLOGY_RID,
  stored,
  twinFunctions,
  twinGrantsFile,
  twinIr,
} from '../stored.test-utils.ts';
import { loadPermissionCatalog, permissionCatalog } from './permissionCatalog.ts';

const TWIN = convertOrThrow(
  { ...stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') }), validateOnly: false },
  ONTOLOGY_RID,
  1,
);

const TWIN_CATALOG = [
  {
    slug: 'accounts:close',
    description: 'Close accounts and copy their phase to engagements',
    requires: ['accounts:read', 'engagements:read'],
  },
  { slug: 'accounts:read', description: 'View accounts', requires: [] },
  { slug: 'accounts:write', description: 'Create and change accounts', requires: ['accounts:read'] },
  { slug: 'engagements:read', description: 'View engagements', requires: [] },
  { slug: 'engagements:write', description: 'Create and change engagements', requires: ['engagements:read'] },
  { slug: 'ontology:install', description: 'Install an Ontology of a product in the Organization', requires: [] },
  { slug: 'probes:read', description: 'View struct probes', requires: [] },
  { slug: 'probes:write', description: 'Create and change struct probes', requires: ['probes:read'] },
];

describe('the permission catalog of a product version', () => {
  it('service/ontology-service#permission-catalog: the catalog of the twin holds each permission of its grants file and of the service, in the code point order of slug', () => {
    expect(loadPermissionCatalog(TWIN, JSON.parse(JSON.stringify(twinGrantsFile())))).toEqual(TWIN_CATALOG);
  });

  it('service/ontology-service#permission-catalog: requires joins the direct lists of each Action Type with the same permission, with no duplicate, in code point order', () => {
    const grants = twinGrantsFile();
    const joined = { ...grants, actionTypes: { ...grants.actionTypes, [`${NS}create-engagement`]: 'accounts:write' } };
    const catalog = permissionCatalog(joined, permissionIndex(TWIN, joined));

    expect(catalog.find((entry) => entry.slug === 'accounts:write')?.requires).toEqual([
      'accounts:read',
      'engagements:read',
    ]);

    expect(catalog.find((entry) => entry.slug === 'engagements:write')?.requires).toEqual(['engagements:read']);
  });

  it('service/ontology-service#permission-catalog: a permission that no Action Type has requires none, and an Action Type never requires its own permission', () => {
    const grants = twinGrantsFile();
    const own = { ...grants, actionTypes: { ...grants.actionTypes, [`${NS}create-account`]: 'accounts:read' } };
    const catalog = permissionCatalog(own, permissionIndex(TWIN, own));

    expect(catalog.find((entry) => entry.slug === 'accounts:read')?.requires).toEqual([]);
    expect(catalog.find((entry) => entry.slug === 'probes:read')?.requires).toEqual([]);
  });

  it('service/ontology-service#permission-catalog: the entries and each requires list are in code point order, not in file order or UTF-16 order', () => {
    const [fullwidth, emoji] = ['a:\uFF21', 'a:\u{1F600}'];

    const grants = {
      permissions: {
        'z:read': { description: 'Z' },
        [emoji]: { description: 'Emoji' },
        [fullwidth]: { description: 'Fullwidth' },
        w: { description: 'W' },
      },
      objectTypes: { [`${NS}Account`]: 'z:read', [`${NS}Engagement`]: emoji, [`${NS}StructProbe`]: fullwidth },
      actionTypes: { [`${NS}create-account`]: 'w', [`${NS}create-engagement`]: 'w', [`${NS}create-struct-probe`]: 'w' },
      defaultRoles: {},
    };

    expect(permissionCatalog(grants, permissionIndex(TWIN, grants))).toEqual([
      { slug: fullwidth, description: 'Fullwidth', requires: [] },
      { slug: emoji, description: 'Emoji', requires: [] },
      { slug: 'ontology:install', description: 'Install an Ontology of a product in the Organization', requires: [] },
      { slug: 'w', description: 'W', requires: [fullwidth, emoji, 'z:read'] },
      { slug: 'z:read', description: 'Z', requires: [] },
    ]);
  });

  it('service/ontology-service#permission-catalog: for each entry, the grants check of publish refuses a default role that holds only its permission, and names exactly its requires', () => {
    const grants = twinGrantsFile();
    const index = permissionIndex(TWIN, grants);

    for (const entry of permissionCatalog(grants, index)) {
      const { problems } = checkGrantsFile(
        TWIN,
        { ...grants, defaultRoles: { only: [entry.slug] } },
        { functions: true, validateOnly: false },
      );

      const missing = new Set(
        problems.flatMap(
          (problem) => /, but not (.+), which its Object Types need\.$/.exec(problem)?.[1]?.split(', ') ?? [],
        ),
      );

      expect({ slug: entry.slug, missing: [...missing].sort() }).toEqual({ slug: entry.slug, missing: entry.requires });
    }
  });

  it('service/ontology-service#permission-catalog: a grants file that does not parse, such as one of v2, gives the empty catalog', () => {
    expect(loadPermissionCatalog(TWIN, { roles: ['admin'], objectTypes: {}, actionTypes: {} })).toEqual([]);
    expect(loadPermissionCatalog(TWIN, null)).toEqual([]);
  });

  it('service/ontology-service#permission-catalog: the description of ontology:install is the text of the spec, and a stored file that declares it does not change it', () => {
    expect(SERVICE_PERMISSION_DESCRIPTIONS).toEqual({
      'ontology:install': 'Install an Ontology of a product in the Organization',
    });

    expect(Object.keys(SERVICE_PERMISSION_DESCRIPTIONS)).toEqual([...SERVICE_PERMISSIONS]);

    const grants = twinGrantsFile();
    const taken = { ...grants, permissions: { ...grants.permissions, 'ontology:install': { description: 'Taken' } } };

    const entries = permissionCatalog(taken, permissionIndex(TWIN, taken)).filter(
      (entry) => entry.slug === 'ontology:install',
    );

    expect(entries).toEqual([
      { slug: 'ontology:install', description: 'Install an Ontology of a product in the Organization', requires: [] },
    ]);
  });
});
