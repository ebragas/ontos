import { describe, expect, it } from 'vitest';
import {
  loadPermissionIndex,
  permissionIndex,
  typesNamedBy,
  type CompiledActionType,
  type CompiledLinkType,
  type CompiledOntology,
  type PermissionIndex,
} from './index.ts';

import {
  convertOrThrow,
  NS,
  ONTOLOGY_RID,
  stored,
  twinFunctions,
  twinGrantsFile,
  twinIr,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const CREATE_ACCOUNT = `${NS}create-account`;
const DELETE_ACCOUNT = `${NS}delete-account`;
const COPY_ACCOUNT_PHASE = `${NS}copy-account-phase`;
const CLOSE_ACCOUNT = `${NS}close-account-action`;
const SET_RELATIONSHIP = `${NS}set-relationship-action`;

const TWIN = convertOrThrow(
  { ...stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') }), validateOnly: false },
  ONTOLOGY_RID,
  1,
);

function actionType(ontology: CompiledOntology, apiName: string): CompiledActionType {
  const action = ontology.actionTypes.get(apiName);

  if (!action) throw new Error(`The twin has no Action Type ${apiName}.`);

  return action;
}

function withAction(ontology: CompiledOntology, action: CompiledActionType): CompiledOntology {
  return { ...ontology, actionTypes: new Map([...ontology.actionTypes, [action.apiName, action]]) };
}

function plain(index: PermissionIndex | null) {
  if (!index) return null;

  return {
    objectTypes: Object.fromEntries(index.objectTypes),
    actionTypes: Object.fromEntries(
      [...index.actionTypes].map(([name, { own, requires, needs }]) => [name, { own, requires, needs: [...needs] }]),
    ),
  };
}

const TWIN_INDEX = {
  objectTypes: { [ACCOUNT]: 'accounts:read', [ENGAGEMENT]: 'engagements:read', [STRUCT_PROBE]: 'probes:read' },
  actionTypes: {
    [CREATE_ACCOUNT]: {
      own: 'accounts:write',
      requires: ['accounts:read'],
      needs: ['accounts:write', 'accounts:read'],
    },
    [`${NS}create-engagement`]: {
      own: 'engagements:write',
      requires: ['engagements:read'],
      needs: ['engagements:write', 'engagements:read'],
    },
    [`${NS}set-engagement-status`]: {
      own: 'engagements:write',
      requires: ['engagements:read'],
      needs: ['engagements:write', 'engagements:read'],
    },
    [DELETE_ACCOUNT]: {
      own: 'accounts:write',
      requires: ['accounts:read'],
      needs: ['accounts:write', 'accounts:read'],
    },
    [`${NS}delete-engagement`]: {
      own: 'engagements:write',
      requires: ['engagements:read'],
      needs: ['engagements:write', 'engagements:read'],
    },
    [CLOSE_ACCOUNT]: {
      own: 'accounts:close',
      requires: ['accounts:read', 'engagements:read'],
      needs: ['accounts:close', 'accounts:read', 'engagements:read'],
    },
    [`${NS}set-account-phase`]: {
      own: 'accounts:write',
      requires: ['accounts:read'],
      needs: ['accounts:write', 'accounts:read'],
    },
    [COPY_ACCOUNT_PHASE]: {
      own: 'accounts:close',
      requires: ['accounts:read', 'engagements:read'],
      needs: ['accounts:close', 'accounts:read', 'engagements:read'],
    },
    [`${NS}probe-version-check-action`]: {
      own: 'accounts:close',
      requires: ['accounts:read', 'engagements:read'],
      needs: ['accounts:close', 'accounts:read', 'engagements:read'],
    },
    [`${NS}create-struct-probe`]: {
      own: 'probes:write',
      requires: ['probes:read'],
      needs: ['probes:write', 'probes:read'],
    },
    [`${NS}set-struct-probe-relationship`]: {
      own: 'probes:write',
      requires: ['probes:read'],
      needs: ['probes:write', 'probes:read'],
    },
    [SET_RELATIONSHIP]: { own: 'probes:write', requires: ['probes:read'], needs: ['probes:write', 'probes:read'] },
    [`${NS}delete-struct-probe`]: {
      own: 'probes:write',
      requires: ['probes:read'],
      needs: ['probes:write', 'probes:read'],
    },
  },
};

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

describe('the index of a product version', () => {
  it('service/code-layout#seams: the index of the twin gives the permission of each Object Type, and the direct and full lists of each Action Type', () => {
    expect(plain(permissionIndex(TWIN, twinGrantsFile()))).toEqual(TWIN_INDEX);
  });

  it('service/code-layout#seams: an Action Type that names an Object Type with no permission is not in the index, and a key with no type changes nothing', () => {
    const grants = twinGrantsFile();
    const objectTypes = without(grants.objectTypes, ENGAGEMENT);

    const index = permissionIndex(TWIN, {
      ...grants,
      objectTypes: { ...objectTypes, Ghost: 'ghosts:read' },
      actionTypes: { ...grants.actionTypes, 'ghost-action': 'ghosts:write' },
    });

    expect([...index.objectTypes.keys()]).toEqual([ACCOUNT, STRUCT_PROBE]);

    expect([...index.actionTypes.keys()]).toEqual([
      CREATE_ACCOUNT,
      DELETE_ACCOUNT,
      `${NS}set-account-phase`,
      `${NS}create-struct-probe`,
      `${NS}set-struct-probe-relationship`,
      SET_RELATIONSHIP,
      `${NS}delete-struct-probe`,
    ]);
  });

  it('service/publish#grants-check: a version load builds the index of a grants file that the grants check refuses, and runs no check', () => {
    const grants = twinGrantsFile();
    const objectTypes = without(grants.objectTypes, STRUCT_PROBE);

    const refused = {
      ...grants,
      permissions: { ...grants.permissions, 'ontology:extra': { description: 'Taken' } },
      objectTypes,
      defaultRoles: { 'org-admin': ['accounts:read'] },
    };

    expect(plain(loadPermissionIndex(TWIN, refused))?.objectTypes).toEqual({
      [ACCOUNT]: 'accounts:read',
      [ENGAGEMENT]: 'engagements:read',
    });

    expect(plain(loadPermissionIndex(TWIN, twinGrantsFile()))).toEqual(TWIN_INDEX);
  });

  it('service/publish#grants-check: a version load of a grants file that does not parse, such as one of v2, gives no index', () => {
    expect(loadPermissionIndex(TWIN, { roles: ['admin'], objectTypes: {}, actionTypes: {} })).toBeNull();
    expect(loadPermissionIndex(TWIN, null)).toBeNull();
  });
});

describe('the Object Types that an Action Type names', () => {
  it('ontology/action-types/action-types#permissions: an Action Type names the Object Type of each object and objectList parameter', () => {
    const copy = actionType(TWIN, COPY_ACCOUNT_PHASE);

    expect([...typesNamedBy(TWIN, copy)].sort()).toEqual([ACCOUNT, ENGAGEMENT]);

    const [first] = copy.parameters.values();

    const list = {
      ...copy,
      parameters: new Map([
        ['probes', { ...first, id: 'probes', type: { kind: 'objectList', objectType: STRUCT_PROBE } }],
      ]),
      logic: { kind: 'rules', rules: [] },
    } as CompiledActionType;

    expect([...typesNamedBy(TWIN, list)]).toEqual([STRUCT_PROBE]);
  });

  it('ontology/action-types/action-types#permissions: an Action Type names the Object Type of each addObjectRule', () => {
    expect([...typesNamedBy(TWIN, actionType(TWIN, CREATE_ACCOUNT))]).toEqual([ACCOUNT]);
  });

  it('ontology/action-types/action-types#permissions: an Action Type names both Object Types of each Link rule', () => {
    const account = TWIN.objectTypes.get(ACCOUNT);
    const accountToEngagements = TWIN.linkTypes.get('accountToEngagements');

    if (!account || !accountToEngagements) throw new Error('The twin has no Account or accountToEngagements.');

    const [side] = account.links.values();

    if (!side) throw new Error('Account has no Link side.');

    const joinTable: CompiledLinkType['storage'] = {
      kind: 'joinTable',
      table: 'account_probes',
      a: { objectType: ACCOUNT, column: 'account' },
      b: { objectType: STRUCT_PROBE, column: 'probe' },
    };

    const linked = {
      ...TWIN,
      linkTypes: new Map([
        ...TWIN.linkTypes,
        ['accountProbes', { ...accountToEngagements, apiName: 'accountProbes', storage: joinTable }],
      ]),
      objectTypes: new Map([
        ...TWIN.objectTypes,
        [
          ACCOUNT,
          {
            ...account,
            links: new Map([
              ...account.links,
              ['probes', { ...side, apiName: 'probes', linkType: 'accountProbes', target: STRUCT_PROBE }],
            ]),
          },
        ],
      ]),
    } as CompiledOntology;

    const remove = actionType(TWIN, DELETE_ACCOUNT);
    const [source = ''] = remove.parameters.keys();

    const link = {
      ...remove,
      logic: { kind: 'rules', rules: [{ kind: 'addLink', link: 'probes', source, target: source }] },
    } as CompiledActionType;

    expect([...typesNamedBy(linked, link)].sort()).toEqual([ACCOUNT, STRUCT_PROBE]);
  });

  it('ontology/action-types/action-types#permissions: a function-backed Action Type names each Object Type of its Provenance', () => {
    expect([...typesNamedBy(TWIN, actionType(TWIN, CLOSE_ACCOUNT))].sort()).toEqual([ACCOUNT, ENGAGEMENT]);
    expect([...typesNamedBy(TWIN, actionType(TWIN, SET_RELATIONSHIP))]).toEqual([STRUCT_PROBE]);
  });

  it('ontology/action-types/action-types#permissions: a function-backed Action Type names both Object Types of each Link Type of its Provenance', () => {
    const close = actionType(TWIN, CLOSE_ACCOUNT);

    if (close.logic.kind !== 'function') throw new Error('close-account-action is not function-backed.');

    const fn = TWIN.functions.get(close.logic.function);

    if (fn?.kind !== 'edit') throw new Error('The twin has no edit Function closeAccount.');

    const linkOnly = {
      ...TWIN,
      functions: new Map([
        ...TWIN.functions,
        [
          fn.apiName,
          { ...fn, provenance: { objectTypes: new Set<string>(), linkTypes: new Set(['accountToEngagements']) } },
        ],
      ]),
    };

    const withoutParameters = { ...close, parameters: new Map() } as CompiledActionType;

    expect([...typesNamedBy(withAction(linkOnly, withoutParameters), withoutParameters)].sort()).toEqual([
      ACCOUNT,
      ENGAGEMENT,
    ]);
  });
});
