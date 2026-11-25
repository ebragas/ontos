import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGrantsFile, type GrantsFile } from '../ontology/index.ts';
import { planReconcile, planWorkosSteps, type WorkosRoles } from './workosSteps.ts';

const TWIN = parseGrantsFile(
  JSON.parse(readFileSync(new URL('../../twin/ontology/0.7.0/grants.json', import.meta.url), 'utf8')),
);

const twin = (): GrantsFile => {
  if (!('grants' in TWIN)) throw new Error(TWIN.problem);

  return TWIN.grants;
};

const EMPTY: WorkosRoles = { permissions: new Map(), roles: new Map() };

const TWIN_ROLES: ReadonlySet<string> = new Set(['admin', 'member']);

const NEW_ENVIRONMENT: WorkosRoles = {
  permissions: new Map(),
  roles: new Map([
    ['admin', new Set()],
    ['member', new Set()],
  ]),
};

const TWIN_PERMISSION_STEPS = [
  { step: 'createPermission', permission: 'accounts:close' },
  { step: 'createPermission', permission: 'accounts:read' },
  { step: 'createPermission', permission: 'accounts:write' },
  { step: 'createPermission', permission: 'engagements:read' },
  { step: 'createPermission', permission: 'engagements:write' },
  { step: 'createPermission', permission: 'ontology:install' },
  { step: 'createPermission', permission: 'probes:read' },
  { step: 'createPermission', permission: 'probes:write' },
  {
    step: 'setDescription',
    permission: 'accounts:close',
    description: 'Close accounts and copy their phase to engagements',
  },
  { step: 'setDescription', permission: 'accounts:read', description: 'View accounts' },
  { step: 'setDescription', permission: 'accounts:write', description: 'Create and change accounts' },
  { step: 'setDescription', permission: 'engagements:read', description: 'View engagements' },
  { step: 'setDescription', permission: 'engagements:write', description: 'Create and change engagements' },
  {
    step: 'setDescription',
    permission: 'ontology:install',
    description: 'Install an Ontology of a product in the Organization',
  },
  { step: 'setDescription', permission: 'probes:read', description: 'View struct probes' },
  { step: 'setDescription', permission: 'probes:write', description: 'Create and change struct probes' },
];

const TWIN_ADD_STEPS = [
  { step: 'addPermission', role: 'admin', permission: 'accounts:close' },
  { step: 'addPermission', role: 'admin', permission: 'accounts:read' },
  { step: 'addPermission', role: 'admin', permission: 'accounts:write' },
  { step: 'addPermission', role: 'admin', permission: 'engagements:read' },
  { step: 'addPermission', role: 'admin', permission: 'engagements:write' },
  { step: 'addPermission', role: 'admin', permission: 'ontology:install' },
  { step: 'addPermission', role: 'admin', permission: 'probes:read' },
  { step: 'addPermission', role: 'admin', permission: 'probes:write' },
  { step: 'addPermission', role: 'member', permission: 'accounts:read' },
  { step: 'addPermission', role: 'member', permission: 'accounts:write' },
  { step: 'addPermission', role: 'member', permission: 'engagements:read' },
  { step: 'addPermission', role: 'member', permission: 'probes:read' },
];

describe('the plan of the WorkOS steps', () => {
  it('service/publish#default-roles-in-workos service/publish#reconcile: a default role that no stored version names gets no role step before the transaction, and each permission is still created', () => {
    expect(planWorkosSteps(twin(), EMPTY, new Set())).toEqual(TWIN_PERMISSION_STEPS);

    expect(planWorkosSteps(twin(), NEW_ENVIRONMENT, new Set(['member']))).toEqual([
      ...TWIN_PERMISSION_STEPS,
      ...TWIN_ADD_STEPS.filter((step) => step.role === 'member'),
    ]);
  });

  it('service/publish#default-roles-in-workos: the twin grants file on an empty WorkOS environment gives each step, in the stated order', () => {
    expect(planWorkosSteps(twin(), EMPTY, TWIN_ROLES)).toEqual([
      ...TWIN_PERMISSION_STEPS,
      { step: 'createRole', role: 'admin' },
      { step: 'createRole', role: 'member' },
      ...TWIN_ADD_STEPS,
    ]);
  });

  it('service/publish#default-roles-in-workos: the twin grants file on a new WorkOS environment creates no role that exists', () => {
    expect(planWorkosSteps(twin(), NEW_ENVIRONMENT, TWIN_ROLES)).toEqual([...TWIN_PERMISSION_STEPS, ...TWIN_ADD_STEPS]);
  });

  it('service/publish#default-roles-in-workos: a permission that exists in WorkOS is added to a role that lacks it, with no create', () => {
    const workos: WorkosRoles = {
      permissions: new Map([
        ['accounts:read', 'View accounts'],
        ['accounts:write', 'Old text'],
      ]),
      roles: new Map([['member', new Set(['accounts:read'])]]),
    };

    const grants: GrantsFile = {
      permissions: {
        'accounts:read': { description: 'View accounts' },
        'accounts:write': { description: 'Create and change accounts' },
      },
      objectTypes: {},
      actionTypes: {},
      defaultRoles: { member: ['accounts:write', 'accounts:read'] },
    };

    expect(planWorkosSteps(grants, workos, new Set(['member']))).toEqual([
      { step: 'setDescription', permission: 'accounts:write', description: 'Create and change accounts' },
      { step: 'addPermission', role: 'member', permission: 'accounts:write' },
    ]);
  });

  it('service/publish#default-roles-in-workos: ontology:install in a default role creates the permission with the description of the Ontology service', () => {
    const grants: GrantsFile = {
      permissions: {},
      objectTypes: {},
      actionTypes: {},
      defaultRoles: { admin: ['ontology:install'] },
    };

    expect(planWorkosSteps(grants, NEW_ENVIRONMENT, TWIN_ROLES)).toEqual([
      { step: 'createPermission', permission: 'ontology:install' },
      {
        step: 'setDescription',
        permission: 'ontology:install',
        description: 'Install an Ontology of a product in the Organization',
      },
      { step: 'addPermission', role: 'admin', permission: 'ontology:install' },
    ]);
  });

  it('service/publish#default-roles-in-workos: a service permission that no default role holds is not created', () => {
    const grants: GrantsFile = {
      permissions: { 'accounts:read': { description: '' } },
      objectTypes: {},
      actionTypes: {},
      defaultRoles: { member: ['accounts:read'] },
    };

    expect(planWorkosSteps(grants, NEW_ENVIRONMENT, TWIN_ROLES)).toEqual([
      { step: 'createPermission', permission: 'accounts:read' },
      { step: 'addPermission', role: 'member', permission: 'accounts:read' },
    ]);
  });

  it('service/publish#default-roles-in-workos: after the steps, a second plan of the twin grants file is empty', () => {
    const grants = twin();

    const done: WorkosRoles = {
      permissions: new Map([
        ...Object.entries(grants.permissions).map(([slug, { description }]) => [slug, description] as const),
        ['ontology:install', 'Install an Ontology of a product in the Organization'],
      ]),
      roles: new Map(Object.entries(grants.defaultRoles).map(([role, permissions]) => [role, new Set(permissions)])),
    };

    expect(planWorkosSteps(grants, done, TWIN_ROLES)).toEqual([]);
  });

  it('service/publish#default-roles-in-workos: a grants file that drops permissions and a role plans no delete and no removal', () => {
    const workos: WorkosRoles = {
      permissions: new Map([
        ['a', ''],
        ['b', ''],
        ['c', ''],
      ]),
      roles: new Map([
        ['admin', new Set(['a', 'b', 'c'])],
        ['viewer', new Set(['a'])],
      ]),
    };

    const grants: GrantsFile = {
      permissions: { a: { description: '' } },
      objectTypes: {},
      actionTypes: {},
      defaultRoles: { admin: ['a'] },
    };

    expect(planWorkosSteps(grants, workos, new Set(['admin', 'viewer']))).toEqual([]);
  });
});

function rolesFile(roles: Readonly<Record<string, readonly string[]>>): GrantsFile {
  return { permissions: {}, objectTypes: {}, actionTypes: {}, defaultRoles: roles };
}

function held(roles: Readonly<Record<string, readonly string[]>>): WorkosRoles {
  return {
    permissions: new Map(),
    roles: new Map(Object.entries(roles).map(([slug, permissions]) => [slug, new Set(permissions)])),
  };
}

describe('the plan of the reconcile', () => {
  it('service/publish#reconcile: each changed default role gets the full list of the newest grants file, sorted and with no repeat, in role order', () => {
    const newest = rolesFile({ member: ['b', 'a', 'b'], admin: ['ontology:install', 'a'] });

    expect(planReconcile(newest, [], held({ member: ['a', 'x'], admin: ['a'] }))).toEqual([
      { role: 'admin', permissions: ['a', 'ontology:install'], create: false },
      { role: 'member', permissions: ['a', 'b'], create: false },
    ]);
  });

  it('service/publish#reconcile: a default role of an earlier version that the newest version lacks gets an empty list', () => {
    expect(
      planReconcile(
        rolesFile({ member: ['a'] }),
        ['member', 'viewer'],
        held({ member: ['a'], viewer: ['a', 'ontology:install'] }),
      ),
    ).toEqual([{ role: 'viewer', permissions: [], create: false }]);
  });

  it('service/publish#reconcile: a role that holds the same set in another order gets no write', () => {
    expect(planReconcile(rolesFile({ member: ['a', 'b'] }), ['member'], held({ member: ['b', 'a'] }))).toEqual([]);
  });

  it('service/publish#reconcile: a role of the newest version that WorkOS lacks is created with its list, and a removed role that WorkOS lacks, an empty removed role, and an environment role that no version names get no write', () => {
    const newest = rolesFile({ admin: ['b', 'a'], member: ['a'] });

    expect(
      planReconcile(
        newest,
        ['admin', 'member', 'viewer', 'gone'],
        held({ member: ['a'], viewer: [], other: ['a', 'x'], 'org-custom': ['x'] }),
      ),
    ).toEqual([{ role: 'admin', permissions: ['a', 'b'], create: true }]);
  });

  it('a role slug that names a key of every object, such as constructor, is read as a role of the grants file only', () => {
    const newest = rolesFile({ member: ['a'] });

    expect(
      planReconcile(
        newest,
        ['constructor', 'toString', 'member'],
        held({ constructor: ['a'], toString: ['a'], member: ['a'] }),
      ),
    ).toEqual([
      { role: 'constructor', permissions: [], create: false },
      { role: 'toString', permissions: [], create: false },
    ]);
  });
});
