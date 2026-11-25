import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { type Policy, type StoredOntologyVersion } from './index.ts';
import { planChanges } from '../publish/plan.ts';

import { SCHEMAS } from '../service.test-utils.ts';
import {
  compiledObjectType,
  compileOrThrow,
  convertOrThrow,
  expectFeatureRefused,
  NS,
  ONTOLOGY_RID,
  policiesIr,
  stored,
  twinFunctions,
  twinIr,
  unchecked,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const OWN: Policy = {
  kind: 'or',
  conditions: [
    {
      kind: 'compare',
      object: { kind: 'constant', values: ['admin'] },
      operator: 'intersects',
      person: { kind: 'permissions' },
    },
    {
      kind: 'compare',
      object: { kind: 'property', property: 'ownerId' },
      operator: 'equal',
      person: { kind: 'userId' },
    },
    {
      kind: 'compare',
      object: { kind: 'property', property: 'viewers' },
      operator: 'intersects',
      person: { kind: 'permissions' },
    },
    {
      kind: 'compare',
      object: { kind: 'property', property: 'viewers' },
      operator: 'supersetOf',
      person: { kind: 'userId' },
    },
  ],
};

interface Group {
  rid: string;
  security: {
    type: string;
    granular: { viewPolicy: { granularPolicyCondition: unknown; additionalMandatory: Record<string, unknown> } };
  };
  type: { type: string };
  properties: string[];
}

function datasourcesOf(
  ir: OntologyIr,
): { datasource: { type: string; datasetV3: { propertySecurityGroups: { groups: Group[] } } } }[] {
  const block = ir.ontology.objectTypes[ACCOUNT];

  if (!block) throw new Error('policies.json has no Account.');

  return unchecked(block.datasources);
}

function ownOf(ir: OntologyIr): Group {
  const group = datasourcesOf(ir)[0]?.datasource.datasetV3.propertySecurityGroups.groups[0];

  if (!group) throw new Error('policies.json has no group on Account.');

  return group;
}

function version(change: (ir: OntologyIr) => void = () => undefined): StoredOntologyVersion {
  const ir = policiesIr();

  change(ir);

  return stored(ir, { functions: twinFunctions('0.6.3') });
}

function withCondition(condition: unknown): StoredOntologyVersion {
  return version((ir) => {
    ownOf(ir).security.granular.viewPolicy.granularPolicyCondition = condition;
  });
}

const userId = { type: 'userProperty', userProperty: { type: 'userId', userId: {} } };
const property = (name: string) => ({ type: 'property', property: name });
const strings = (...values: string[]) => ({ type: 'constant', constant: { type: 'strings', strings: values } });

const comparison = (left: unknown, operator: string, right: unknown) => ({
  type: 'comparison',
  comparison: { left, operator, right },
});

const user = (type: string, body: object = {}) => ({ type: 'userProperty', userProperty: { type, [type]: body } });

describe('the object security policy of an IR from @osdk/maker', () => {
  it('service/ontology-as-code#security-policies: compile reads objectSecurityPolicy of a dataset datasource into the compiled Object Type', () => {
    expect(compiledObjectType(version(), ACCOUNT).policy).toEqual(OWN);
    expect(compiledObjectType(version(), `${NS}Engagement`).policy).toBeUndefined();
  });

  it('the maker group shortcut compiles to user.permissions, and a raw userId value to user.id', () => {
    const policy = compiledObjectType(version(), ACCOUNT).policy;
    const conditions = policy?.kind === 'or' ? policy.conditions : [];

    expect(
      conditions.map((condition) => (condition.kind === 'compare' ? condition.person.kind : condition.kind)),
    ).toEqual(['permissions', 'userId', 'permissions', 'userId']);

    expect(conditions[0]).toEqual({
      kind: 'compare',
      object: { kind: 'constant', values: ['admin'] },
      operator: 'intersects',
      person: { kind: 'permissions' },
    });
  });

  it.each([
    ['SUBSET_OF', 'supersetOf'],
    ['SUPERSET_OF', 'subsetOf'],
    ['EQUAL', 'equal'],
    ['INTERSECTS', 'intersects'],
  ] as const)(
    'ontology/object-security-policies#conditions: a person side on the left with %s compiles to %s with the sides swapped',
    (operator, compiled) => {
      const left = compiledObjectType(withCondition(comparison(userId, operator, property('viewers'))), ACCOUNT).policy;

      expect(left).toEqual({
        kind: 'compare',
        object: { kind: 'property', property: 'viewers' },
        operator: compiled,
        person: { kind: 'userId' },
      });

      const right = compiledObjectType(
        withCondition(comparison(property('viewers'), operator, userId)),
        ACCOUNT,
      ).policy;

      expect(right).toMatchObject({ object: { kind: 'property', property: 'viewers' }, person: { kind: 'userId' } });

      expect((right as { operator: string }).operator).toBe(
        { SUBSET_OF: 'subsetOf', SUPERSET_OF: 'supersetOf', EQUAL: 'equal', INTERSECTS: 'intersects' }[operator],
      );
    },
  );

  it('ontology/object-security-policies#conditions: a nested and and or keep their shape', () => {
    const nested = {
      type: 'and',
      and: {
        conditions: [
          comparison(property('ownerId'), 'EQUAL', userId),
          { type: 'or', or: { conditions: [comparison(user('groupIds'), 'INTERSECTS', strings('admin', 'member'))] } },
        ],
      },
    };

    expect(compiledObjectType(withCondition(nested), ACCOUNT).policy).toEqual({
      kind: 'and',
      conditions: [
        {
          kind: 'compare',
          object: { kind: 'property', property: 'ownerId' },
          operator: 'equal',
          person: { kind: 'userId' },
        },
        {
          kind: 'or',
          conditions: [
            {
              kind: 'compare',
              object: { kind: 'constant', values: ['admin', 'member'] },
              operator: 'intersects',
              person: { kind: 'permissions' },
            },
          ],
        },
      ],
    });
  });

  it('ontology/object-security-policies#conditions: a fixed String is an Object side of 1 value', () => {
    const single = comparison(
      { type: 'constant', constant: { type: 'string', string: 'admin' } },
      'INTERSECTS',
      user('groupIds'),
    );

    expect(compiledObjectType(withCondition(single), ACCOUNT).policy).toEqual({
      kind: 'compare',
      object: { kind: 'constant', values: ['admin'] },
      operator: 'intersects',
      person: { kind: 'permissions' },
    });
  });

  it('ontology/object-security-policies#conditions: the open policy that maker writes for a type with no objectSecurityPolicy gives no policy', () => {
    expect(compiledObjectType(withCondition({ type: 'and', and: { conditions: [] } }), ACCOUNT).policy).toBeUndefined();
  });
});

describe('the policies that publish refuses', () => {
  it('ontology/object-security-policies#conditions: refuses not, and the error names the Object Type, the policy, and not', () => {
    expectFeatureRefused(
      withCondition({ type: 'not', not: { condition: comparison(property('ownerId'), 'EQUAL', userId) } }),
      ACCOUNT,
      "'own'",
      /\bnot\b/,
    );
  });

  it.each([
    ['a markings condition', withCondition({ type: 'markings', markings: { property: 'ownerId' } }), /markings/],
    [
      'a constant markings condition',
      withCondition({ type: 'constantMarkings', constantMarkings: { markings: ['m-1'], markingType: 'MANDATORY' } }),
      /markings/,
    ],
    [
      'the additional mandatory markings',
      version((ir) => {
        ownOf(ir).security.granular.viewPolicy.additionalMandatory = {
          markings: { 'm-1': 'MANDATORY' },
          assumedMarkings: [],
          assumedMarkingsV2: {},
        };
      }),
      /markings/,
    ],
    [
      'the username of the person',
      withCondition(comparison(property('ownerId'), 'EQUAL', user('username'))),
      /username/,
    ],
    [
      'the group names of the person',
      withCondition(comparison(property('viewers'), 'INTERSECTS', user('groupNames'))),
      /group names/,
    ],
  ])(
    'ontology/object-security-policies#conditions: refuses %s, and the error names the feature',
    (_feature, refused, fragment) => {
      expectFeatureRefused(refused, ACCOUNT, "'own'", fragment);
    },
  );

  it('ontology/object-security-policies#conditions: refuses a comparison with no person side, and one with 2 person sides', () => {
    expectFeatureRefused(
      withCondition(comparison(property('ownerId'), 'EQUAL', strings('x'))),
      ACCOUNT,
      "'own'",
      /no person side/,
    );

    expectFeatureRefused(
      withCondition(comparison(userId, 'EQUAL', user('groupIds'))),
      ACCOUNT,
      "'own'",
      /2 person sides/,
    );
  });

  it('ontology/object-security-policies#conditions service/ontology-as-code#the-grants-file: a userAttributes value reads the Person attribute by its attributeKey, on each side', () => {
    const attribute = user('userAttributes', { attributeKey: 'jobsiteIds' });

    expect(
      compiledObjectType(withCondition(comparison(property('viewers'), 'INTERSECTS', attribute)), ACCOUNT).policy,
    ).toEqual({
      kind: 'compare',
      object: { kind: 'property', property: 'viewers' },
      operator: 'intersects',
      person: { kind: 'attribute', name: 'jobsiteIds' },
    });

    expect(
      compiledObjectType(withCondition(comparison(attribute, 'SUPERSET_OF', property('ownerId'))), ACCOUNT).policy,
    ).toEqual({
      kind: 'compare',
      object: { kind: 'property', property: 'ownerId' },
      operator: 'subsetOf',
      person: { kind: 'attribute', name: 'jobsiteIds' },
    });
  });

  it.each([
    ['an attributeKey that is not a String', { attributeKey: 7 }, 'has a Person attribute with no attributeKey'],
    ['no attributeKey', {}, 'has a Person attribute with no attributeKey'],
    ['an empty attributeKey', { attributeKey: '' }, 'has a Person attribute with no attributeKey'],
    [
      'an unknown key next to attributeKey',
      { attributeKey: 'jobsiteIds', x: 1 },
      'has a Person attribute with the unknown key x',
    ],
  ])(
    'ontology/object-security-policies#conditions: refuses a userAttributes value with %s',
    (_shape, body, message) => {
      expectFeatureRefused(
        withCondition(comparison(property('viewers'), 'INTERSECTS', user('userAttributes', body))),
        `Object Type ${ACCOUNT} has the object security policy 'own', which ${message}.`,
      );
    },
  );

  it.each([
    ['groupIds', { parentGroupId: 'g' }],
    ['userId', { x: 1 }],
  ])(
    'ontology/object-security-policies#conditions: refuses a %s value whose body is not empty, and never reads it as a plain person value',
    (type, body) => {
      expectFeatureRefused(
        withCondition(comparison(property('viewers'), 'INTERSECTS', user(type, body))),
        `Object Type ${ACCOUNT} has the object security policy 'own', which has a ${type} value with the unknown key ${Object.keys(body)[0]}.`,
      );
    },
  );

  it.each([
    ['a Boolean', { type: 'boolean', boolean: {} }],
    ['a Double', { type: 'double', double: {} }],
    ['an Integer array', { type: 'array', array: { subtype: { type: 'integer', integer: {} } } }],
  ])(
    'ontology/object-security-policies#conditions: refuses a policy that reads %s Property, and the error names the Property',
    (_type, type) => {
      const refused = version((ir) => {
        const account = ir.ontology.objectTypes[ACCOUNT];
        const owner = account?.objectType.propertyTypes['ownerId'];

        if (!owner) throw new Error('policies.json has no ownerId.');

        owner.type = unchecked(type);
      });

      expectFeatureRefused(refused, ACCOUNT, "'own'", 'ownerId', /String/);
    },
  );

  it('ontology/object-security-policies#conditions: refuses a Boolean constant', () => {
    expectFeatureRefused(
      withCondition(comparison({ type: 'constant', constant: { type: 'boolean', boolean: true } }, 'EQUAL', userId)),
      ACCOUNT,
      "'own'",
      /Boolean/,
    );
  });

  it('ontology/object-security-policies#policies: refuses 2 object security policies in 2 groups, and in 2 datasources, and the error names the Object Type', () => {
    const twoGroups = version((ir) => {
      const groups = datasourcesOf(ir)[0]?.datasource.datasetV3.propertySecurityGroups.groups;

      groups?.push({ ...structuredClone(ownOf(ir)), rid: 'second' });
    });

    expectFeatureRefused(twoGroups, ACCOUNT, /2 object security policies/);

    const twoDatasources = version((ir) => {
      const datasources = datasourcesOf(ir);
      const copy = structuredClone(datasources[0]);

      if (copy) datasources.push(copy);
    });

    expectFeatureRefused(twoDatasources, ACCOUNT, /2 object security policies/);
  });

  const own = comparison(property('ownerId'), 'EQUAL', userId);

  it.each([
    [
      'the maker output of an and with the key condition',
      { type: 'and', condition: [own] },
      'has an and with no list of conditions',
    ],
    [
      'an and with condition in place of conditions',
      { type: 'and', and: { condition: [own] } },
      'has an and with no list of conditions',
    ],
    ['an and with no and body', { type: 'and', conditions: [own] }, 'has an and with no list of conditions'],
    [
      'an and whose conditions is an object',
      { type: 'and', and: { conditions: { 0: own } } },
      'has an and with no list of conditions',
    ],
    ['an or with no or body', { type: 'or', conditions: [own] }, 'has an or with no list of conditions'],
    [
      'a nested and with no and body',
      { type: 'or', or: { conditions: [{ type: 'and', conditions: [own] }] } },
      'has an and with no list of conditions',
    ],
    ['a condition with no type', { comparison: own.comparison }, 'uses the condition undefined'],
  ])(
    'ontology/object-security-policies#conditions: refuses %s, and never reads it as an open policy',
    (_shape, condition, message) => {
      expectFeatureRefused(
        withCondition(condition),
        `Object Type ${ACCOUNT} has the object security policy 'own', which ${message}`,
      );
    },
  );

  it.each(['constructor', 'toString', '__proto__', 'LESS_THAN'])(
    'ontology/object-security-policies#conditions: refuses the operator %s',
    (operator) => {
      expectFeatureRefused(
        withCondition(comparison(property('ownerId'), operator, userId)),
        `which uses the operator ${operator}. A V1 comparison uses EQUAL, INTERSECTS, SUBSET_OF, or SUPERSET_OF.`,
      );
    },
  );

  it.each([
    ['no condition', undefined],
    ['a null condition', null],
    ['the true condition', { type: 'true', true: {} }],
  ])(
    'ontology/object-security-policies#conditions: refuses a primaryKey group with %s, and never reads it as an open policy',
    (_shape, condition) => {
      expectFeatureRefused(withCondition(condition), ACCOUNT, "'own'");
    },
  );

  it.each([
    ['the open policy with 1 more key', { type: 'and', and: { conditions: [] }, x: 1 }, 'has an and with no condition'],
    [
      'an and with an unknown key',
      { type: 'and', and: { conditions: [own] }, x: 1 },
      'has a condition with the unknown key x',
    ],
    [
      'an and of no condition inside an and',
      { type: 'and', and: { conditions: [own, { type: 'and', and: { conditions: [] } }] } },
      'has an and with no condition',
    ],
    [
      'an and of no condition inside an or',
      { type: 'or', or: { conditions: [own, { type: 'and', and: { conditions: [] } }] } },
      'has an and with no condition',
    ],
    ['a condition with an unknown key', { ...own, note: 'x' }, 'has a condition with the unknown key note'],
    [
      'an and body with an unknown key',
      { type: 'and', and: { conditions: [own], x: 1 } },
      'has an and with the unknown key x',
    ],
    [
      'a comparison with an unknown key',
      { type: 'comparison', comparison: { ...own.comparison, extra: true } },
      'has a comparison with the unknown key extra',
    ],
    [
      'a side with an unknown key',
      comparison({ ...property('ownerId'), x: 1 }, 'EQUAL', userId),
      'has a comparison side with the unknown key x',
    ],
    [
      'a user value with an unknown key',
      comparison(property('ownerId'), 'EQUAL', {
        type: 'userProperty',
        userProperty: { type: 'userId', userId: {}, x: 1 },
      }),
      'has a person value with the unknown key x',
    ],
  ])('ontology/object-security-policies#conditions: refuses %s', (_shape, condition, message) => {
    expectFeatureRefused(
      withCondition(condition),
      `Object Type ${ACCOUNT} has the object security policy 'own', which ${message}.`,
    );
  });

  it('refuses an unknown person value, and never reads it as user.id', () => {
    expectFeatureRefused(
      withCondition(comparison(property('ownerId'), 'EQUAL', user('serviceUserId'))),
      `Object Type ${ACCOUNT} has the object security policy 'own', which reads the person value serviceUserId. A person value is user.id, user.permissions, or a Person attribute.`,
    );
  });

  it('ontology/object-security-policies#conditions: an or of no condition is a policy that shows no Object, not an open policy', () => {
    expect(compiledObjectType(withCondition({ type: 'or', or: { conditions: [] } }), ACCOUNT).policy).toEqual({
      kind: 'or',
      conditions: [],
    });
  });

  const withSecurity = (security: unknown) =>
    version((ir) => {
      ownOf(ir).security = unchecked(security);
    });

  it.each([
    [
      'a mandatoryOnly security with markings',
      {
        type: 'mandatoryOnly',
        mandatoryOnly: { policy: { markings: { 'm-1': 'MANDATORY' }, assumedMarkings: [], assumedMarkingsV2: {} } },
      },
      'reads markings. V1 has no markings.',
    ],
    [
      'the flat form of a mandatoryOnly security, which is not the IR form',
      {
        type: 'mandatoryOnly',
        mandatoryOnly: { markings: { 'm-1': 'MANDATORY' }, assumedMarkings: [], assumedMarkingsV2: {} },
      },
      'has a mandatoryOnly security with the unknown key markings.',
    ],
  ])(
    'ontology/object-security-policies#conditions: refuses %s, and never reads it as an open policy',
    (_shape, security, message) => {
      expectFeatureRefused(
        withSecurity(security),
        `Object Type ${ACCOUNT} has the object security policy 'own', which ${message}`,
      );
    },
  );

  it('a mandatoryOnly security in the IR form with no markings is open', () => {
    expect(
      compiledObjectType(
        withSecurity({
          type: 'mandatoryOnly',
          mandatoryOnly: { policy: { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} } },
        }),
        ACCOUNT,
      ).policy,
    ).toBeUndefined();
  });

  it.each<[string, (ir: OntologyIr) => void, string]>([
    [
      'a security of another type',
      (ir) => void (ownOf(ir).security = unchecked({ type: 'markings', markings: { markings: ['m-1'] } })),
      `Object Type ${ACCOUNT} has the object security policy 'own', which has the security type markings. A V1 security is granular or mandatoryOnly.`,
    ],
    [
      'a security that is not an object',
      (ir) => void (ownOf(ir).security = unchecked('granular')),
      `Object Type ${ACCOUNT} has the object security policy 'own', which has a security that is not an object.`,
    ],
    [
      'a granular security with no viewPolicy',
      (ir) => void (ownOf(ir).security = unchecked({ type: 'granular', granular: {} })),
      `Object Type ${ACCOUNT} has the object security policy 'own', which has a granular security with no viewPolicy.`,
    ],
    [
      'a group of another type',
      (ir) => void (ownOf(ir).type = { type: 'rowLevel' }),
      `Object Type ${ACCOUNT} has the object security policy 'own', which has the security group type rowLevel. A V1 security group is a primaryKey group or a property group.`,
    ],
    [
      'groups that is not a list',
      (ir) =>
        void ((
          datasourcesOf(ir)[0] as { datasource: { datasetV3: { propertySecurityGroups: unknown } } }
        ).datasource.datasetV3.propertySecurityGroups = { groups: {} }),
      `Object Type ${ACCOUNT} has propertySecurityGroups with no list of groups.`,
    ],
    [
      'a group that is not an object',
      (ir) => void datasourcesOf(ir)[0]?.datasource.datasetV3.propertySecurityGroups.groups.push(unchecked('own')),
      `Object Type ${ACCOUNT} has a security group that is not an object.`,
    ],
  ])('ontology/object-security-policies#conditions: refuses %s', (_shape, change, message) => {
    expectFeatureRefused(version(change), message);
  });

  it('an open primaryKey group next to the policy is no second policy', () => {
    const withOpen = version((ir) => {
      const groups = datasourcesOf(ir)[0]?.datasource.datasetV3.propertySecurityGroups.groups;
      const open = structuredClone(ownOf(ir));

      open.rid = 'open';

      open.security.granular.viewPolicy.granularPolicyCondition = { type: 'and', and: { conditions: [] } };

      groups?.push(open);
    });

    expect(compiledObjectType(withOpen, ACCOUNT).policy).toEqual(OWN);
  });

  it('ontology/object-security-policies#policies: a property security group next to the object security policy keeps both policies', () => {
    const withGroup = version((ir) => {
      const groups = datasourcesOf(ir)[0]?.datasource.datasetV3.propertySecurityGroups.groups;

      groups?.push({
        ...structuredClone(ownOf(ir)),
        rid: 'pay',
        type: unchecked({ type: 'property', property: { name: 'pay' } }),
        properties: ['phase'],
      });
    });

    const account = compiledObjectType(withGroup, ACCOUNT);

    expect(account.policy).toEqual(OWN);
    expect(account.properties.get('phase')?.policy).toEqual(OWN);
  });
});

describe('the dataset datasource changes nothing else', () => {
  const noDeclaration = () =>
    version((ir) => {
      const account = ir.ontology.objectTypes[ACCOUNT];

      if (account) account.datasources = [];
    });

  it('service/ontology-as-code#contract: a maker IR with a policy compiles, converts, and plans as the same IR with no datasource, except for the policy', () => {
    const declared = compileOrThrow(version());
    const bare = compileOrThrow(noDeclaration());
    const account = declared.objectTypes.get(ACCOUNT);

    if (!account) throw new Error('compile gave no Account.');

    const { policy, ...rest } = account;

    expect(policy).toEqual(OWN);
    expect({ ...declared, objectTypes: new Map([...declared.objectTypes, [ACCOUNT, rest]]) }).toEqual(bare);

    const metadata = (stored: StoredOntologyVersion) =>
      convertOrThrow({ ...stored, validateOnly: false }, ONTOLOGY_RID, 1).metadata;

    expect(metadata(version())).toEqual(metadata(noDeclaration()));

    const plan = planChanges(SCHEMAS, declared);
    const isPolicyIndex = (text: string) => text.startsWith('CREATE INDEX "policy_');

    expect(
      plan.flatMap((change) => change.statements.map((statement) => statement.text)).filter(isPolicyIndex),
    ).toEqual([expect.stringContaining('USING gin ((coalesce(array_remove("viewers", NULL)')]);

    expect(
      plan.map((change) => ({
        ...change,
        statements: change.statements.filter((statement) => !isPolicyIndex(statement.text)),
      })),
    ).toEqual(planChanges(SCHEMAS, bare));
  });
});

describe('the twin of the conformance tests', () => {
  it.each(['0.4.0', '0.6.3', '0.7.0'] as const)(
    'the twin %s has no policy, so each of its reads keeps the table text of today',
    (twin) => {
      const compiled = compileOrThrow(
        stored(twinIr(twin), { functions: twinFunctions(twin === '0.4.0' ? '0.4.0' : '0.6.3') }),
      );

      expect(
        [...compiled.objectTypes.values()]
          .filter((objectType) => objectType.policy !== undefined)
          .map((objectType) => objectType.apiName),
      ).toEqual([]);
    },
  );
});

describe('user.permissions in a policy, with the group condition read as the permissions of the caller', () => {
  const CONDITIONS = 'ontology/object-security-policies#conditions';
  const PERMISSIONS = { kind: 'permissions' } as const;

  const permissionsPolicy = (condition: unknown) =>
    compileOrThrow(withCondition(condition)).objectTypes.get(ACCOUNT)?.policy;

  const refusal = (condition: unknown): string => {
    try {
      compileOrThrow(withCondition(condition));
    } catch (error) {
      return (error as Error).message;
    }

    throw new Error('Compile did not refuse the policy.');
  };

  it(`${CONDITIONS}/ba1fee3d ${CONDITIONS}/2f442292: the person side is user.id or user.permissions, and the maker group condition compiles to user.permissions with each group name as a permission slug`, () => {
    expect(
      permissionsPolicy({
        type: 'or',
        or: {
          conditions: [
            comparison(user('groupIds'), 'INTERSECTS', strings('jobs:read', 'jobs:edit')),
            comparison(property('ownerId'), 'EQUAL', userId),
          ],
        },
      }),
    ).toEqual({
      kind: 'or',
      conditions: [
        {
          kind: 'compare',
          object: { kind: 'constant', values: ['jobs:read', 'jobs:edit'] },
          operator: 'intersects',
          person: PERMISSIONS,
        },
        {
          kind: 'compare',
          object: { kind: 'property', property: 'ownerId' },
          operator: 'equal',
          person: { kind: 'userId' },
        },
      ],
    });
  });

  it.each([
    [
      'INTERSECTS with the person side on the left',
      comparison(user('groupIds'), 'INTERSECTS', strings('a')),
      { object: { kind: 'constant', values: ['a'] }, operator: 'intersects' },
    ],
    [
      'INTERSECTS with the person side on the right',
      comparison(property('viewers'), 'INTERSECTS', user('groupIds')),
      { object: { kind: 'property', property: 'viewers' }, operator: 'intersects' },
    ],
    [
      'SUPERSET_OF with the person side on the left',
      comparison(user('groupIds'), 'SUPERSET_OF', strings('a', 'b')),
      { object: { kind: 'constant', values: ['a', 'b'] }, operator: 'subsetOf' },
    ],
    [
      'SUBSET_OF with the person side on the right',
      comparison(property('viewers'), 'SUBSET_OF', user('groupIds')),
      { object: { kind: 'property', property: 'viewers' }, operator: 'subsetOf' },
    ],
  ])(`${CONDITIONS}/590eb04b: compiles user.permissions with %s`, (_shape, condition, expected) => {
    expect(permissionsPolicy(condition)).toEqual({ kind: 'compare', ...expected, person: PERMISSIONS });
  });

  it.each([
    [
      'EQUAL with the person side on the left',
      comparison(user('groupIds'), 'EQUAL', strings('a')),
      'compares user.permissions with the operator EQUAL',
    ],
    [
      'EQUAL with the person side on the right',
      comparison(property('viewers'), 'EQUAL', user('groupIds')),
      'compares user.permissions with the operator EQUAL',
    ],
    [
      'SUBSET_OF with the person side on the left',
      comparison(user('groupIds'), 'SUBSET_OF', strings('a')),
      'compares user.permissions with the operator SUBSET_OF, which is superset of after the swap of the 2 sides',
    ],
    [
      'SUPERSET_OF with the person side on the right',
      comparison(property('viewers'), 'SUPERSET_OF', user('groupIds')),
      'compares user.permissions with the operator SUPERSET_OF',
    ],
  ])(
    `${CONDITIONS}/590eb04b: refuses user.permissions with %s, and the error names the operator`,
    (_shape, condition, message) => {
      expect(refusal(condition)).toBe(
        `Object Type ${ACCOUNT} has the object security policy 'own', which ${message}. A comparison of user.permissions uses intersects (holds 1 of these) or subset of (holds each of these).`,
      );
    },
  );

  it(`${CONDITIONS}/590eb04b: refuses user.permissions with EQUAL inside an and and an or`, () => {
    const nested = {
      type: 'and',
      and: {
        conditions: [
          comparison(property('ownerId'), 'EQUAL', userId),
          { type: 'or', or: { conditions: [comparison(user('groupIds'), 'EQUAL', strings('a'))] } },
        ],
      },
    };

    expect(refusal(nested)).toMatch(/which compares user\.permissions with the operator EQUAL\./);
  });
});

describe('a deep condition', () => {
  it('ontology/object-security-policies#conditions: compiles 1500 nested or conditions, as before the yielded failures', () => {
    let condition: unknown = comparison(property('ownerId'), 'EQUAL', userId);

    for (let depth = 0; depth < 1500; depth += 1) condition = { type: 'or', or: { conditions: [condition] } };

    expect(compileOrThrow(withCondition(condition)).objectTypes.get(ACCOUNT)?.policy).toMatchObject({ kind: 'or' });
  });
});
