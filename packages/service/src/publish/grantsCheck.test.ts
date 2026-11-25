import { describe, expect, it } from 'vitest';
import { type CompiledOntology, type Condition, type GrantsFile, type Policy } from '../ontology/index.ts';

import { checkGrantsFile } from './grantsCheck.ts';
import {
  compileOrThrow,
  convertOrThrow,
  JOBSITE_DECLARATIONS,
  jobsiteIr,
  NS,
  ONTOLOGY_RID,
  stored,
  twinFunctions,
  twinGrantsFile,
  twinIr,
} from '../ontology/stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const CREATE_ACCOUNT = `${NS}create-account`;
const CLOSE_ACCOUNT = `${NS}close-account-action`;
const COPY_ACCOUNT_PHASE = `${NS}copy-account-phase`;
const PROBE_VERSION_CHECK = `${NS}probe-version-check-action`;
const SET_RELATIONSHIP = `${NS}set-relationship-action`;
const JOBSITE = `${NS}Jobsite`;
const DAILY_LOG = `${NS}DailyLog`;
const EDIT_JOBSITE = `${NS}edit-jobsite`;

const TWIN = convertOrThrow(
  { ...stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') }), validateOnly: false },
  ONTOLOGY_RID,
  1,
);

const TWIN_NO_FUNCTIONS = convertOrThrow({ ...stored(twinIr('0.7.0')), validateOnly: true }, ONTOLOGY_RID, 1);
const JOBSITE_TWIN = compileOrThrow(stored(jobsiteIr()));
const GRANTS = twinGrantsFile();
const PASS = { problems: [], warnings: [] };

function jobsiteGrants(
  permissions: GrantsFile['permissions'] = { admin: { description: 'Administer jobsites' } },
): GrantsFile {
  const each = (names: Iterable<string>, slug: string) => Object.fromEntries([...names].map((name) => [name, slug]));

  return {
    permissions: {
      ...permissions,
      'jobsites:read': { description: 'View jobsites' },
      'jobsites:write': { description: 'Change jobsites' },
    },
    objectTypes: each(JOBSITE_TWIN.objectTypes.keys(), 'jobsites:read'),
    actionTypes: each(JOBSITE_TWIN.actionTypes.keys(), 'jobsites:write'),
    defaultRoles: { admin: ['admin', 'jobsites:read', 'jobsites:write'] },
    personAttributes: JOBSITE_DECLARATIONS,
  };
}

function namingRules(slug: string): CompiledOntology {
  const swap = (policy: Policy): Policy =>
    JSON.parse(JSON.stringify(policy).replaceAll('"values":["admin"]', `"values":[${JSON.stringify(slug)}]`)) as Policy;

  const objectTypes = new Map(
    [...JOBSITE_TWIN.objectTypes].map(([name, objectType]) => {
      const properties = new Map(
        [...objectType.properties].map(([key, property]) => [
          key,
          property.policy ? { ...property, policy: swap(property.policy) } : property,
        ]),
      );

      return [name, { ...objectType, ...(objectType.policy ? { policy: swap(objectType.policy) } : {}), properties }];
    }),
  );

  const edit = JOBSITE_TWIN.actionTypes.get(EDIT_JOBSITE);

  if (!edit) throw new Error('The policy twin has no edit-jobsite.');

  const condition: Condition = {
    kind: 'comparison',
    operator: 'INTERSECTS',
    left: { kind: 'person', fact: { kind: 'permissions' } },
    right: { kind: 'static', value: [slug] },
  };

  return {
    ...JOBSITE_TWIN,
    objectTypes,
    actionTypes: new Map([
      ...JOBSITE_TWIN.actionTypes,
      [EDIT_JOBSITE, { ...edit, criteria: [{ condition, failureMessage: 'Only an admin' }] }],
    ]),
  };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

describe('a valid grants file', () => {
  it('the grants file of the twin passes the check', () => {
    expect(checkGrantsFile(TWIN, GRANTS, { functions: true, validateOnly: false })).toEqual(PASS);
  });

  it('the grants file of the policy twin, whose policies name the permission admin, passes the check', () => {
    expect(checkGrantsFile(JOBSITE_TWIN, jobsiteGrants(), { functions: true, validateOnly: false })).toEqual(PASS);
  });
});

describe('the types', () => {
  it('service/publish#grants-check: a type with no permission, an unknown permission, and an unknown type each give a problem', () => {
    const objectTypes = without(GRANTS.objectTypes, ENGAGEMENT);

    const grants = {
      ...GRANTS,
      objectTypes: { ...objectTypes, Ghost: 'accounts:read' },
      actionTypes: { ...without(GRANTS.actionTypes, SET_RELATIONSHIP), [CREATE_ACCOUNT]: 'accounts:create' },
    };

    expect(checkGrantsFile(TWIN, grants, { functions: true, validateOnly: false }).problems).toEqual([
      `The Object Type ${ENGAGEMENT} names no permission.`,
      'The key Ghost of objectTypes names no Object Type of the IR.',
      `The Action Type ${SET_RELATIONSHIP} names no permission.`,
      `The Action Type ${CREATE_ACCOUNT} names the permission accounts:create, which the key permissions does not declare.`,
    ]);
  });

  it('ontology/object-link-types/object-types#parts: an Object Type with no permission is refused', () => {
    const objectTypes = without(GRANTS.objectTypes, STRUCT_PROBE);

    expect(
      checkGrantsFile(TWIN, { ...GRANTS, objectTypes }, { functions: true, validateOnly: false }).problems,
    ).toEqual([`The Object Type ${STRUCT_PROBE} names no permission.`]);
  });
});

describe('the permissions of the Ontology service', () => {
  it('service/publish#grants-check: a product permission with the prefix ontology: gives a problem', () => {
    const grants = {
      ...GRANTS,
      permissions: { ...GRANTS.permissions, 'ontology:export': { description: 'Export the Ontology' } },
    };

    expect(checkGrantsFile(TWIN, grants, { functions: true, validateOnly: false }).problems).toEqual([
      'The product permission ontology:export has the prefix ontology:, which the Ontology service keeps for its own permissions.',
    ]);
  });

  it('service/ontology-as-code#the-grants-file: ontology:install in a default role passes, and in a type or a rule is refused', () => {
    expect(GRANTS.defaultRoles['admin']).toContain('ontology:install');
    expect(checkGrantsFile(TWIN, GRANTS, { functions: true, validateOnly: false })).toEqual(PASS);

    const inType = { ...GRANTS, objectTypes: { ...GRANTS.objectTypes, [ACCOUNT]: 'ontology:install' } };

    expect(checkGrantsFile(TWIN, inType, { functions: true, validateOnly: false }).problems).toContain(
      `The Object Type ${ACCOUNT} names the permission ontology:install of the Ontology service. A type names only a permission of the product.`,
    );

    expect(
      checkGrantsFile(namingRules('ontology:install'), jobsiteGrants(), { functions: true, validateOnly: false })
        .problems,
    ).toContain(
      `The object security policy of the Object Type ${JOBSITE} names the permission ontology:install of the Ontology service. A rule names only a permission of the product.`,
    );
  });

  it('service/publish#grants-check: ontology:install in a type, a policy, or a criterion gives a problem', () => {
    const grants = {
      ...jobsiteGrants(),
      actionTypes: { ...jobsiteGrants().actionTypes, [EDIT_JOBSITE]: 'ontology:install' },
    };

    expect(
      checkGrantsFile(namingRules('ontology:install'), grants, { functions: true, validateOnly: false }).problems,
    ).toEqual([
      `The Action Type ${EDIT_JOBSITE} names the permission ontology:install of the Ontology service. A type names only a permission of the product.`,
      `The object security policy of the Object Type ${JOBSITE} names the permission ontology:install of the Ontology service. A rule names only a permission of the product.`,
      `The property security policy of the Property budget of ${JOBSITE} names the permission ontology:install of the Ontology service. A rule names only a permission of the product.`,
      `The object security policy of the Object Type ${DAILY_LOG} names the permission ontology:install of the Ontology service. A rule names only a permission of the product.`,
      `A Submission criterion of the Action Type ${EDIT_JOBSITE} names the permission ontology:install of the Ontology service. A rule names only a permission of the product.`,
    ]);
  });

  it('service/publish#grants-check: a policy and a criterion that name a permission that permissions does not have each give a problem', () => {
    expect(
      checkGrantsFile(namingRules('jobsites:audit'), jobsiteGrants(), { functions: true, validateOnly: false })
        .problems,
    ).toEqual([
      `The object security policy of the Object Type ${JOBSITE} names the permission jobsites:audit, which the key permissions does not declare.`,
      `The property security policy of the Property budget of ${JOBSITE} names the permission jobsites:audit, which the key permissions does not declare.`,
      `The object security policy of the Object Type ${DAILY_LOG} names the permission jobsites:audit, which the key permissions does not declare.`,
      `A Submission criterion of the Action Type ${EDIT_JOBSITE} names the permission jobsites:audit, which the key permissions does not declare.`,
    ]);
  });
});

describe('the default roles', () => {
  it('service/publish#grants-check: a default role with a permission of neither the product nor the Ontology service gives a problem', () => {
    const grants = {
      ...GRANTS,
      defaultRoles: { ...GRANTS.defaultRoles, viewer: ['accounts:read', 'accounts:export', 'ontology:export'] },
    };

    expect(checkGrantsFile(TWIN, grants, { functions: true, validateOnly: false }).problems).toEqual([
      'The default role viewer names the permission accounts:export, which is not a permission of the product or of the Ontology service.',
      'The default role viewer names the permission ontology:export, which is not a permission of the product or of the Ontology service.',
    ]);
  });

  it('service/publish#grants-check: a default role with the permission of an Action Type and not of its Object Types gives a problem that names each missing permission', () => {
    const grants = { ...GRANTS, defaultRoles: { closer: ['accounts:close'] } };

    expect(checkGrantsFile(TWIN, grants, { functions: true, validateOnly: false }).problems).toEqual([
      `The default role closer holds the permission accounts:close of the Action Type ${CLOSE_ACCOUNT}, but not accounts:read, engagements:read, which its Object Types need.`,
      `The default role closer holds the permission accounts:close of the Action Type ${COPY_ACCOUNT_PHASE}, but not accounts:read, engagements:read, which its Object Types need.`,
      `The default role closer holds the permission accounts:close of the Action Type ${PROBE_VERSION_CHECK}, but not accounts:read, engagements:read, which its Object Types need.`,
    ]);
  });

  it('ontology/action-types/action-types#permissions: a default role with the permission of an Action Type and not of each of its Object Types is refused', () => {
    const grants = { ...GRANTS, defaultRoles: { ...GRANTS.defaultRoles, member: ['accounts:read', 'accounts:close'] } };

    expect(checkGrantsFile(TWIN, grants, { functions: true, validateOnly: false }).problems).toEqual([
      `The default role member holds the permission accounts:close of the Action Type ${CLOSE_ACCOUNT}, but not engagements:read, which its Object Types need.`,
      `The default role member holds the permission accounts:close of the Action Type ${COPY_ACCOUNT_PHASE}, but not engagements:read, which its Object Types need.`,
      `The default role member holds the permission accounts:close of the Action Type ${PROBE_VERSION_CHECK}, but not engagements:read, which its Object Types need.`,
    ]);
  });

  it('a validateOnly request with no Functions skips the rule of each function-backed Action Type, and 1 warning names them', () => {
    const grants = { ...GRANTS, defaultRoles: { prober: ['probes:write'] } };

    expect(checkGrantsFile(TWIN_NO_FUNCTIONS, grants, { functions: false, validateOnly: true })).toEqual({
      problems: [
        `The default role prober holds the permission probes:write of the Action Type ${NS}create-struct-probe, but not probes:read, which its Object Types need.`,
        `The default role prober holds the permission probes:write of the Action Type ${NS}set-struct-probe-relationship, but not probes:read, which its Object Types need.`,
        `The default role prober holds the permission probes:write of the Action Type ${NS}delete-struct-probe, but not probes:read, which its Object Types need.`,
      ],
      warnings: [
        `The grants check did not run the default role rule for these function-backed Action Types, because the request has no Functions: ${CLOSE_ACCOUNT}, ${PROBE_VERSION_CHECK}, ${SET_RELATIONSHIP}.`,
      ],
    });
  });
});

describe('the limits of WorkOS', () => {
  it('service/publish#grants-check: a slug of 49 characters, a description of 151 characters, and a default role slug with org- each give a problem', () => {
    const long = `accounts:${'a'.repeat(40)}`;

    expect(long).toHaveLength(49);

    const fits = `accounts:${'b'.repeat(39)}`;

    const grants = {
      ...GRANTS,
      permissions: {
        ...GRANTS.permissions,
        [long]: { description: 'Long' },
        [fits]: { description: 'd'.repeat(150) },
        'accounts:audit': { description: 'd'.repeat(151) },
      },
      defaultRoles: { ...GRANTS.defaultRoles, 'org-auditor': ['accounts:read'], organizer: ['accounts:read'] },
    };

    expect(checkGrantsFile(TWIN, grants, { functions: true, validateOnly: false }).problems).toEqual([
      `The permission slug ${long} has 49 characters. WorkOS takes at most 48.`,
      'The description of the permission accounts:audit has 151 characters. WorkOS takes at most 150.',
      'The default role org-auditor has the prefix org-, which WorkOS keeps for the custom roles of each Organization.',
    ]);
  });
});

describe('service/publish#grants-check: 1 slug rule for each permission slug and each default role slug', () => {
  const permissionProblem = (slug: string) =>
    `The permission slug ${JSON.stringify(slug)} has a form that WorkOS does not take: 1 to 48 characters of a to z, 0 to 9, -, _, :, ., and *, and not dots only.`;

  const roleProblem = (slug: string) =>
    `The default role slug ${JSON.stringify(slug)} has a form that WorkOS does not take: 1 to 48 characters of a to z, 0 to 9, -, and _.`;

  const withPermission = (slug: string): GrantsFile => ({
    ...GRANTS,
    permissions: { ...GRANTS.permissions, [slug]: { description: 'A probe' } },
  });

  const withRole = (slug: string): GrantsFile => ({
    ...GRANTS,
    defaultRoles: { ...GRANTS.defaultRoles, [slug]: ['accounts:read'] },
  });

  it('service/publish#grants-check: an empty permission slug, an uppercase letter, a space, .., and a slash are each a problem', () => {
    for (const slug of ['', 'Accounts:read', 'accounts read', '..', '.', '...', 'a/../b', 'accounts:é']) {
      expect([
        slug,
        checkGrantsFile(TWIN, withPermission(slug), { functions: true, validateOnly: false }).problems,
      ]).toEqual([slug, [permissionProblem(slug)]]);
    }
  });

  it('service/publish#grants-check: each allowed character passes, also in a slug of 48 characters', () => {
    const fits = `a-z_0:9.*${'x'.repeat(39)}`;

    expect(fits).toHaveLength(48);

    for (const slug of [fits, 'a', 'a*', 'accounts.v2:read', 'a..b'])
      expect(checkGrantsFile(TWIN, withPermission(slug), { functions: true, validateOnly: false })).toEqual(PASS);

    expect(checkGrantsFile(TWIN, withPermission('*'), { functions: true, validateOnly: false }).problems).toEqual([
      'The permission slug * is reserved for local dev mode.',
    ]);
  });

  it('service/publish#grants-check: an empty default role slug, an uppercase letter, a dot, a colon, and 49 characters are each a problem', () => {
    const long = 'r'.repeat(49);

    for (const slug of ['', 'Admin', 'site.lead', 'site:lead', '..', long]) {
      expect([slug, checkGrantsFile(TWIN, withRole(slug), { functions: true, validateOnly: false }).problems]).toEqual([
        slug,
        [roleProblem(slug)],
      ]);
    }
  });

  it('service/publish#grants-check: a default role slug of 48 lowercase letters, digits, - and _ passes', () => {
    const fits = `site-lead_9${'r'.repeat(37)}`;

    expect(fits).toHaveLength(48);
    expect(checkGrantsFile(TWIN, withRole(fits), { functions: true, validateOnly: false })).toEqual(PASS);
  });

  it('service/publish#grants-check: the check reads no WorkOS, so it refuses a bad slug that needs no WorkOS step, also in a validateOnly request with no Functions', () => {
    expect(
      checkGrantsFile(TWIN_NO_FUNCTIONS, withRole('Admin'), { functions: false, validateOnly: true }).problems,
    ).toEqual([roleProblem('Admin')]);
  });
});
