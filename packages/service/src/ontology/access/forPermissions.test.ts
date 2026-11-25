import { describe, expect, it } from 'vitest';
import { OrganizationId, UserId } from '../../auth/caller.ts';
import { handleTrusted } from '../../handler/index.ts';
import { convert } from '../../metadata.test-utils.ts';
import type { DiscoveredFunction } from '../../publish/index.ts';
import { noSnapshot, TEST_READER, timeLeft } from '../../service.test-utils.ts';
import {
  permissionIndex,
  type CompiledLinkType,
  type CompiledOntology,
  type GrantsFile,
  type PermissionIndex,
  type PermissionSlug,
} from '../index.ts';
import { NS, twinFunctions, twinGrantsFile, twinIr } from '../stored.test-utils.ts';
import { forPermissions } from './forPermissions.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;

const converted = convert(twinIr('0.7.0'), { functions: twinFunctions('0.7.0'), version: 7 });
const compiled: CompiledOntology = { ...converted.compiled, metadata: converted.metadata };
const index = permissionIndex(compiled, twinGrantsFile());

const ALL = [
  'accounts:read',
  'accounts:write',
  'accounts:close',
  'engagements:read',
  'engagements:write',
  'probes:read',
  'probes:write',
];

function cut(
  permissions: readonly string[],
  ontology: CompiledOntology = compiled,
  from: PermissionIndex | null = index,
): CompiledOntology {
  return forPermissions(ontology, from, new Set(permissions as PermissionSlug[]));
}

function namesOf(view: CompiledOntology) {
  const sorted = (names: Iterable<string>) => [...names].sort();

  return {
    objectTypes: sorted(view.objectTypes.keys()),
    linkTypes: sorted(view.linkTypes.keys()),
    actionTypes: sorted(view.actionTypes.keys()),
    functions: sorted(view.functions.keys()),
    publishedActionTypeNames: view.publishedActionTypeNames.size,
    metadataObjectTypes: sorted(Object.keys(view.metadata.objectTypes)),
    metadataActionTypes: sorted(Object.keys(view.metadata.actionTypes)),
  };
}

const NO_TYPE = {
  objectTypes: [],
  linkTypes: [],
  actionTypes: [],
  functions: [],
  publishedActionTypeNames: 0,
  metadataObjectTypes: [],
  metadataActionTypes: [],
};

function stringsOf(view: CompiledOntology): Set<string> {
  const { functionBundle, ...rest } = view;

  void functionBundle;

  const strings = new Set<string>();

  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.add(value);
    else if (value instanceof Map || value instanceof Set) for (const entry of value) walk(entry);
    else if (Array.isArray(value)) for (const entry of value) walk(entry);
    else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) walk(entry);
  };

  walk(rest);

  return strings;
}

function hiddenOf(view: CompiledOntology): Set<string> {
  const hidden = new Set<string>();

  for (const [name, objectType] of compiled.objectTypes) {
    if (view.objectTypes.has(name)) continue;

    hidden.add(name).add(objectType.rid);

    for (const property of objectType.properties.values()) hidden.add(property.rid);
  }

  for (const [name, linkType] of compiled.linkTypes) if (!view.linkTypes.has(name)) hidden.add(name).add(linkType.rid);

  for (const [name, actionType] of compiled.actionTypes)
    if (!view.actionTypes.has(name)) hidden.add(name).add(actionType.rid);

  for (const [name, fn] of compiled.functions) if (!view.functions.has(name)) hidden.add(name).add(fn.rid);

  return hidden;
}

describe('the view of a set of permissions on the twin', () => {
  it('service/code-layout#seams: each permission of the twin gives each type of the twin', () => {
    expect(namesOf(cut(ALL))).toEqual({
      objectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
      linkTypes: ['accountToEngagements'],
      actionTypes: [
        `${NS}close-account-action`,
        `${NS}copy-account-phase`,
        `${NS}create-account`,
        `${NS}create-engagement`,
        `${NS}create-struct-probe`,
        `${NS}delete-account`,
        `${NS}delete-engagement`,
        `${NS}delete-struct-probe`,
        `${NS}probe-version-check-action`,
        `${NS}set-account-phase`,
        `${NS}set-engagement-status`,
        `${NS}set-relationship-action`,
        `${NS}set-struct-probe-relationship`,
      ],
      functions: ['closeAccount', 'probeVersionCheck', 'setRelationship'],
      publishedActionTypeNames: 26,
      metadataObjectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
      metadataActionTypes: [
        `${NS}close-account-action`,
        `${NS}copy-account-phase`,
        `${NS}create-account`,
        `${NS}create-engagement`,
        `${NS}create-struct-probe`,
        `${NS}delete-account`,
        `${NS}delete-engagement`,
        `${NS}delete-struct-probe`,
        `${NS}probe-version-check-action`,
        `${NS}set-account-phase`,
        `${NS}set-engagement-status`,
        `${NS}set-relationship-action`,
        `${NS}set-struct-probe-relationship`,
      ],
    });
  });

  it('service/code-layout#seams: the Engagement and StructProbe permissions give only their types, with the Functions and published names of their Action Types', () => {
    const view = cut(['engagements:read', 'engagements:write', 'probes:read', 'probes:write']);

    const actionTypes = [
      `${NS}create-engagement`,
      `${NS}create-struct-probe`,
      `${NS}delete-engagement`,
      `${NS}delete-struct-probe`,
      `${NS}set-engagement-status`,
      `${NS}set-relationship-action`,
      `${NS}set-struct-probe-relationship`,
    ];

    expect(namesOf(view)).toEqual({
      objectTypes: [ENGAGEMENT, STRUCT_PROBE],
      linkTypes: [],
      actionTypes,
      functions: ['setRelationship'],
      publishedActionTypeNames: 14,
      metadataObjectTypes: [ENGAGEMENT, STRUCT_PROBE],
      metadataActionTypes: actionTypes,
    });

    expect(view.publishedActionTypeNames.get('setEngagementStatus')).toBe(`${NS}set-engagement-status`);
    expect(view.publishedActionTypeNames.has('createAccount')).toBe(false);
  });

  it('service/code-layout#seams: the read permissions alone give the Object Types and no Action Type', () => {
    expect(namesOf(cut(['accounts:read', 'engagements:read', 'probes:read']))).toEqual({
      ...NO_TYPE,
      objectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
      linkTypes: ['accountToEngagements'],
      metadataObjectTypes: [ACCOUNT, ENGAGEMENT, STRUCT_PROBE],
    });
  });

  it('service/code-layout#seams: wildcard * returns the compiled Ontology reference directly and matches holding all permissions', () => {
    const withIndex = cut(['*']);
    const withoutIndex = cut(['*'], compiled, null);

    expect(withIndex).toBe(compiled);
    expect(withoutIndex).toBe(compiled);
    expect(namesOf(withIndex)).toEqual(namesOf(cut(ALL)));
  });

  it('service/code-layout#seams: an empty set, an unknown permission, and a permission that differs only in case give no type', () => {
    expect(namesOf(cut([]))).toEqual(NO_TYPE);
    expect(namesOf(cut(['accounts:admin', 'ontology:install']))).toEqual(NO_TYPE);
    expect(namesOf(cut(['Accounts:Read', 'ACCOUNTS:WRITE']))).toEqual(NO_TYPE);
  });

  it('service/code-layout#seams: an Action Type stays only when the set holds its own permission, also when the needs of an index leave it out', () => {
    const name = `${NS}create-struct-probe`;
    const entry = index.actionTypes.get(name);

    if (!entry) throw new Error('The index has no create-struct-probe.');

    const narrowed: PermissionIndex = {
      ...index,
      actionTypes: new Map([[name, { ...entry, needs: new Set(['probes:read']) }]]),
    };

    expect(namesOf(cut(['probes:read'], compiled, narrowed)).actionTypes).toEqual([]);
    expect(namesOf(cut(['probes:read', 'probes:write'], compiled, narrowed)).actionTypes).toEqual([name]);
  });

  it('service/code-layout#seams: no index, as for a grants file of v2, gives no type to a caller with each permission', () => {
    const view = cut(ALL, compiled, null);

    expect(namesOf(view)).toEqual(NO_TYPE);
    expect(view.metadata.ontology).toEqual(compiled.metadata.ontology);
  });

  it('service/code-layout#seams: the cut keeps the version, the product RID, the Ontology block, and the Function bundle', () => {
    const view = cut(['probes:read']);

    expect(view.version).toBe(7);
    expect(view.productRid).toBe(compiled.productRid);
    expect(view.metadata.ontology).toEqual(compiled.metadata.ontology);
    expect(view.functionBundle).toBe(compiled.functionBundle);
  });

  it('service/code-layout#seams: the metadata of a stored type with no compiled type is hidden, because the index names only compiled types', () => {
    const stale: CompiledOntology = {
      ...compiled,
      objectTypes: new Map(),
      linkTypes: new Map(),
      actionTypes: new Map(),
    };

    const view = cut(ALL, stale, permissionIndex(stale, twinGrantsFile()));

    expect(namesOf(view)).toEqual(NO_TYPE);
  });

  it('service/code-layout#seams: no string of a view equals a hidden API name or a hidden RID', () => {
    const view = cut(['engagements:read', 'engagements:write', 'probes:read', 'probes:write']);
    const hidden = hiddenOf(view);

    expect(hidden.size).toBe(2 + 5 + 2 + 6 * 2 + 2 * 2);
    expect([...stringsOf(view)].filter((text) => hidden.has(text))).toEqual([]);
  });
});

describe('the Action Types of a view', () => {
  it('ontology/action-types/action-types#permissions: an Action Type is absent when the set lacks the permission of 1 Object Type that it names', () => {
    const view = cut(['accounts:read', 'accounts:write', 'accounts:close']);

    expect(namesOf(view)).toEqual({
      objectTypes: [ACCOUNT],
      linkTypes: [],
      actionTypes: [`${NS}create-account`, `${NS}delete-account`, `${NS}set-account-phase`],
      functions: [],
      publishedActionTypeNames: 6,
      metadataObjectTypes: [ACCOUNT],
      metadataActionTypes: [`${NS}create-account`, `${NS}delete-account`, `${NS}set-account-phase`],
    });

    expect(view.publishedActionTypeNames.has('closeAccountAction')).toBe(false);

    const hidden = hiddenOf(view);

    expect(hidden.has(`${NS}close-account-action`)).toBe(true);
    expect(hidden.has('closeAccount')).toBe(true);
    expect([...stringsOf(view)].filter((text) => hidden.has(text))).toEqual([]);
  });

  it('ontology/action-types/action-types#permissions: the set with the missing Object Type permission gives the Action Type and its Function', () => {
    const view = cut(['accounts:read', 'accounts:close', 'engagements:read']);

    expect(namesOf(view).actionTypes).toEqual([
      `${NS}close-account-action`,
      `${NS}copy-account-phase`,
      `${NS}probe-version-check-action`,
    ]);

    expect(namesOf(view).functions).toEqual(['closeAccount', 'probeVersionCheck']);
    expect(view.publishedActionTypeNames.get('closeAccountAction')).toBe(`${NS}close-account-action`);
  });

  it('ontology/action-types/action-types#permissions: the permission of an Action Type alone, or of its Object Types alone, does not give it', () => {
    expect(namesOf(cut(['accounts:write'])).actionTypes).toEqual([]);
    expect(namesOf(cut(['accounts:read'])).actionTypes).toEqual([]);

    expect(namesOf(cut(['accounts:read', 'accounts:write'])).actionTypes).toEqual([
      `${NS}create-account`,
      `${NS}delete-account`,
      `${NS}set-account-phase`,
    ]);
  });

  it('ontology/action-types/action-types#permissions: an Action Type that the index does not hold is absent for each set', () => {
    const grants = twinGrantsFile();
    const { [ENGAGEMENT]: dropped, ...objectTypes } = grants.objectTypes;

    void dropped;

    const partial = permissionIndex(compiled, { ...grants, objectTypes });
    const view = cut([...ALL, 'engagements:read'], compiled, partial);

    expect(namesOf(view).objectTypes).toEqual([ACCOUNT, STRUCT_PROBE]);

    expect(namesOf(view).actionTypes).toEqual([
      `${NS}create-account`,
      `${NS}create-struct-probe`,
      `${NS}delete-account`,
      `${NS}delete-struct-probe`,
      `${NS}set-account-phase`,
      `${NS}set-relationship-action`,
      `${NS}set-struct-probe-relationship`,
    ]);
  });

  it('ontology/action-types/action-types#permissions: the full metadata of an Action Type goes with it', () => {
    const full = { [`${NS}create-account`]: { apiName: 'kept' }, [`${NS}close-account-action`]: { apiName: 'hidden' } };

    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Compile writes no full metadata of an Action Type, so the test gives 2 partial entries.
    const withFull = {
      ...compiled,
      metadata: { ...compiled.metadata, actionTypesFullMetadata: full },
    } as unknown as CompiledOntology;

    expect(cut(['accounts:read', 'accounts:write'], withFull).metadata.actionTypesFullMetadata).toEqual({
      [`${NS}create-account`]: { apiName: 'kept' },
    });

    expect(cut([], withFull).metadata.actionTypesFullMetadata).toEqual({});
  });
});

describe('the Link Types of a view', () => {
  const both = cut(['accounts:read', 'engagements:read']);
  const accountOnly = cut(['accounts:read']);
  const engagementOnly = cut(['engagements:read']);

  it('service/authentication#access: a Link Type exists only when the set opens both of its Object Types', () => {
    expect([...both.linkTypes.keys()]).toEqual(['accountToEngagements']);
    expect([...accountOnly.linkTypes.keys()]).toEqual([]);
    expect([...engagementOnly.linkTypes.keys()]).toEqual([]);
  });

  it('service/authentication#access: each Link side and each metadata side goes with its Link Type', () => {
    expect([...(both.objectTypes.get(ACCOUNT)?.links.keys() ?? [])]).toEqual(['engagements']);
    expect([...(both.objectTypes.get(ENGAGEMENT)?.links.keys() ?? [])]).toEqual(['account']);
    expect(both.metadata.objectTypes[ACCOUNT]?.linkTypes.map((side) => side.apiName)).toEqual(['engagements']);
    expect(both.metadata.objectTypes[ENGAGEMENT]?.linkTypes.map((side) => side.apiName)).toEqual(['account']);
    expect([...(accountOnly.objectTypes.get(ACCOUNT)?.links.keys() ?? [])]).toEqual([]);
    expect(accountOnly.metadata.objectTypes[ACCOUNT]?.linkTypes).toEqual([]);
    expect([...(engagementOnly.objectTypes.get(ENGAGEMENT)?.links.keys() ?? [])]).toEqual([]);
    expect(engagementOnly.metadata.objectTypes[ENGAGEMENT]?.linkTypes).toEqual([]);
  });

  it('ontology/object-link-types/link-types#parts: a Link Type has no permission of its own, so the permissions of its 2 Object Types give it', () => {
    expect(index.objectTypes.has('accountToEngagements')).toBe(false);
    expect([...both.linkTypes.keys()]).toEqual(['accountToEngagements']);
    expect([...accountOnly.linkTypes.keys()]).toEqual([]);
    expect([...engagementOnly.linkTypes.keys()]).toEqual([]);
  });

  it('the foreign key Property of a visible Object Type stays when its Link Type is hidden', () => {
    expect(engagementOnly.objectTypes.get(ENGAGEMENT)?.properties.get('accountId')?.column).toBe('account_id');

    expect(Object.keys(engagementOnly.metadata.objectTypes[ENGAGEMENT]?.objectType.properties ?? {})).toContain(
      'accountId',
    );
  });
});

describe('the join tables of a view', () => {
  it('service/code-layout#seams: a kept Object Type keeps each of its join tables, also of a Link Type that the view hides', () => {
    const account = compiled.objectTypes.get(ACCOUNT);
    const probe = compiled.objectTypes.get(STRUCT_PROBE);
    const accountToEngagements = compiled.linkTypes.get('accountToEngagements');
    const [side] = account?.links.values() ?? [];

    if (!account || !probe || !accountToEngagements || !side)
      throw new Error('The twin has no Account, StructProbe, or accountToEngagements.');

    const joinTable = { table: 'account_probes', columns: ['account'] };

    const storage: CompiledLinkType['storage'] = {
      kind: 'joinTable',
      table: 'account_probes',
      a: { objectType: ACCOUNT, column: 'account' },
      b: { objectType: STRUCT_PROBE, column: 'probe' },
    };

    const linked: CompiledOntology = {
      ...compiled,
      linkTypes: new Map([
        ...compiled.linkTypes,
        ['accountProbes', { ...accountToEngagements, apiName: 'accountProbes', storage }],
      ]),
      objectTypes: new Map([
        ...compiled.objectTypes,
        [
          ACCOUNT,
          {
            ...account,
            joinTables: [joinTable],
            links: new Map([
              ...account.links,
              ['probes', { ...side, apiName: 'probes', linkType: 'accountProbes', target: STRUCT_PROBE }],
            ]),
          },
        ],
        [STRUCT_PROBE, { ...probe, joinTables: [{ table: 'account_probes', columns: ['probe'] }] }],
      ]),
    };

    const view = cut(['accounts:read'], linked, permissionIndex(linked, twinGrantsFile()));

    expect([...view.linkTypes.keys()]).toEqual([]);
    expect([...(view.objectTypes.get(ACCOUNT)?.links.keys() ?? [])]).toEqual([]);
    expect(view.objectTypes.get(ACCOUNT)?.joinTables).toEqual([{ table: 'account_probes', columns: ['account'] }]);

    const full = cut(['accounts:read', 'probes:read'], linked, permissionIndex(linked, twinGrantsFile()));

    expect([...full.linkTypes.keys()].sort()).toEqual(['accountProbes']);
    expect(full.objectTypes.get(STRUCT_PROBE)?.joinTables).toEqual([{ table: 'account_probes', columns: ['probe'] }]);
  });
});

describe('each request makes its own view', () => {
  it('2 sets on 1 compiled Ontology give 2 views, and the cut changes neither the compiled Ontology nor a later cut', () => {
    const before = structuredClone(compiled);
    const reader = cut(['probes:read']);
    const writer = cut(['probes:read', 'probes:write']);

    expect(namesOf(reader).actionTypes).toEqual([]);

    expect(namesOf(writer).actionTypes).toEqual([
      `${NS}create-struct-probe`,
      `${NS}delete-struct-probe`,
      `${NS}set-relationship-action`,
      `${NS}set-struct-probe-relationship`,
    ]);

    expect(namesOf(cut(['probes:read']))).toEqual(namesOf(reader));
    expect(compiled).toEqual(before);
    expect(namesOf(compiled).actionTypes).toHaveLength(13);
  });
});

describe('the view of a Query Function', () => {
  const QUERY = 'engagementOfAccount';
  const objectOf = (objectTypeId: string) => ({ type: 'object', object: { objectTypeId } });

  const query: DiscoveredFunction = {
    locator: { type: 'typescript', typescript: { functionName: QUERY } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      { name: 'account', dataType: objectOf(ACCOUNT) },
    ],
    output: { type: 'single', single: { dataType: objectOf(ENGAGEMENT) } },
    customTypes: {},
    documentation: 'The newest Engagement of an Account.',
  };

  const twin = twinFunctions('0.7.0');

  const withQuery = convert(twinIr('0.7.0'), {
    functions: { ...twin, discovered: [...twin.discovered, query] },
    version: 7,
  });

  const ontology: CompiledOntology = { ...withQuery.compiled, metadata: withQuery.metadata };
  const twinGrants = twinGrantsFile();

  const grants: GrantsFile = {
    ...twinGrants,
    permissions: { ...twinGrants.permissions, 'reports:read': { description: 'Run reports' } },
    queryTypes: { [QUERY]: 'reports:read' },
  };

  function queryVisibility(permissions: readonly string[], from: PermissionIndex = permissionIndex(ontology, grants)) {
    const view = cut(permissions, ontology, from);

    return { functions: view.functions.has(QUERY), queryTypes: Object.keys(view.metadata.queryTypes) };
  }

  it.each([
    [
      'its permission and the permission of each Object Type of its input and output',
      ['reports:read', 'accounts:read', 'engagements:read'],
      { functions: true, queryTypes: [QUERY] },
    ],
    [
      'no permission of the Query Function',
      ['accounts:read', 'engagements:read'],
      { functions: false, queryTypes: [] },
    ],
    [
      'no permission of the Object Type of its output',
      ['reports:read', 'accounts:read'],
      { functions: false, queryTypes: [] },
    ],
    [
      'no permission of the Object Type of its input',
      ['reports:read', 'engagements:read'],
      { functions: false, queryTypes: [] },
    ],
  ])('service/authentication#access: a caller with %s', (_name, permissions, expected) => {
    expect(queryVisibility(permissions)).toEqual(expected);
  });

  it('service/authentication#access: a grants file with no key queryTypes gives no caller the Query Function', () => {
    expect(queryVisibility(ALL.concat('reports:read'), permissionIndex(ontology, twinGrants))).toEqual({
      functions: false,
      queryTypes: [],
    });
  });

  it('service/authentication#access: fullMetadata lists the Query Function only for a caller that holds each of its permissions', async () => {
    const queryTypesOf = async (permissions: readonly string[]) => {
      const trusted = {
        db: noSnapshot,
        reader: TEST_READER,
        ontology: cut(permissions, ontology, permissionIndex(ontology, grants)),
        caller: {
          user: UserId.parse('user-1'),
          kind: 'person' as const,
          organization: OrganizationId.parse('org_1'),
          permissions: [],
        },
        checkWrite: timeLeft,
      };

      const response = await handleTrusted(
        new Request(`http://localhost/api/v2/ontologies/${ontology.metadata.ontology.rid}/fullMetadata`),
        trusted,
      );

      return Object.keys(((await response.json()) as { queryTypes: object }).queryTypes);
    };

    expect(await queryTypesOf(['reports:read', 'accounts:read', 'engagements:read'])).toEqual([QUERY]);

    expect(await queryTypesOf(['reports:read', 'accounts:read'])).toEqual([]);
  });
});
