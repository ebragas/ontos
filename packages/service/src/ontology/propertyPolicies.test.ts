import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { type Policy, type StoredOntologyVersion } from './index.ts';
import {
  compiledObjectType,
  compileOrThrow,
  expectFeatureRefused,
  NS,
  policiesIr,
  propertyPoliciesIr,
  stored,
  twinFunctions,
  unchecked,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

const ADMIN = {
  kind: 'compare',
  object: { kind: 'constant', values: ['admin'] },
  operator: 'intersects',
  person: { kind: 'permissions' },
} as const;

const PAY: Policy = {
  kind: 'or',
  conditions: [
    ADMIN,
    {
      kind: 'compare',
      object: { kind: 'property', property: 'ownerId' },
      operator: 'equal',
      person: { kind: 'userId' },
    },
    {
      kind: 'compare',
      object: { kind: 'property', property: 'readers' },
      operator: 'supersetOf',
      person: { kind: 'userId' },
    },
  ],
};

interface Group {
  rid: string;
  security: {
    type: string;
    granular: { viewPolicy: { granularPolicyCondition: unknown; [key: string]: unknown }; [key: string]: unknown };
    [key: string]: unknown;
  };
  type: { type: string; [body: string]: unknown };
  properties: string[];
  [key: string]: unknown;
}

function groupsOf(ir: OntologyIr, apiName: string): Group[] {
  const block = ir.ontology.objectTypes[apiName];

  const datasources = unchecked<{ datasource: { datasetV3: { propertySecurityGroups: { groups: Group[] } } } }[]>(
    block?.datasources,
  );

  const groups = datasources[0]?.datasource.datasetV3.propertySecurityGroups.groups;

  if (!groups) throw new Error(`property-policies.json has no groups on ${apiName}.`);

  return groups;
}

function groupOf(ir: OntologyIr, name: string): Group {
  const group = groupsOf(ir, ACCOUNT).find((each) => each.rid === name);

  if (!group) throw new Error(`property-policies.json has no group ${name} on Account.`);

  return group;
}

function version(change: (ir: OntologyIr) => void = () => undefined): StoredOntologyVersion {
  const ir = propertyPoliciesIr();

  change(ir);

  return stored(ir);
}

function policiesOf(compiled: StoredOntologyVersion, apiName: string): Record<string, Policy | undefined> {
  const objectType = compiledObjectType(compiled, apiName);

  return Object.fromEntries(
    [...objectType.properties.values()]
      .filter((property) => property.policy !== undefined)
      .map((property) => [property.apiName, property.policy]),
  );
}

const OPS = ['notes', 'score', 'cost', 'startDate', 'seenAt', 'active'];

const PAY_MESSAGE = `Object Type ${ACCOUNT} has the property security policy 'pay', which`;

describe('the property security policies of an IR from @osdk/maker', () => {
  it('service/ontology-as-code#security-policies: compile reads each item of propertySecurityGroups into the policy of each of its Properties', () => {
    const ops: Policy = {
      kind: 'or',
      conditions: [ADMIN, { ...ADMIN, object: { kind: 'constant', values: ['auditor'] } }],
    };

    expect(policiesOf(version(), ACCOUNT)).toEqual({
      name: PAY,
      phase: PAY,
      region: PAY,
      rate: PAY,
      profile: PAY,
      notes: ops,
      score: ops,
      cost: ops,
      startDate: ops,
      seenAt: ops,
      active: ops,
    });

    expect(policiesOf(version(), ENGAGEMENT)).toEqual({
      accountId: { kind: 'or', conditions: [ADMIN, { ...ADMIN, object: { kind: 'constant', values: ['guest'] } }] },
      amount: { kind: 'or', conditions: [ADMIN, { ...ADMIN, object: { kind: 'constant', values: ['guest'] } }] },
    });
  });

  it('ontology/object-security-policies#policies: the open primaryKey group that maker writes for a type with only property security policies gives no object security policy', () => {
    expect(groupsOf(propertyPoliciesIr(), ACCOUNT)[0]?.rid).toBe('defaultObjectSecurityPolicy');
    expect(compiledObjectType(version(), ACCOUNT).policy).toBeUndefined();
  });

  it('ontology/object-security-policies#policies: a type keeps its object security policy and its property security policy', () => {
    expect(compiledObjectType(version(), ENGAGEMENT).policy).toEqual({
      kind: 'or',
      conditions: [ADMIN, { ...ADMIN, object: { kind: 'constant', values: ['member'] } }],
    });
  });

  it('a property group that maker writes with no granularPolicy gives no policy, so its Properties stay visible', () => {
    expect(compiledObjectType(version(), ACCOUNT).properties.get('tags')?.policy).toBeUndefined();
  });

  it('the policy of a property group compiles each condition form as an object security policy does', () => {
    const nested = {
      type: 'and',
      and: {
        conditions: [
          {
            type: 'comparison',
            comparison: {
              left: { type: 'property', property: 'readers' },
              operator: 'INTERSECTS',
              right: { type: 'userProperty', userProperty: { type: 'groupIds', groupIds: {} } },
            },
          },
        ],
      },
    };

    const compiled = version(
      (ir) => void (groupOf(ir, 'plain').security.granular.viewPolicy.granularPolicyCondition = nested),
    );

    expect(compiledObjectType(compiled, ACCOUNT).properties.get('tags')?.policy).toEqual({
      kind: 'and',
      conditions: [
        {
          kind: 'compare',
          object: { kind: 'property', property: 'readers' },
          operator: 'intersects',
          person: { kind: 'permissions' },
        },
      ],
    });
  });

  it('the other Properties keep each other field: only policy differs from the same IR with no property group', () => {
    const declared = compiledObjectType(version(), ACCOUNT);

    const bare = compiledObjectType(
      version((ir) => groupsOf(ir, ACCOUNT).splice(1)),
      ACCOUNT,
    );

    const strip = (objectType: typeof declared) =>
      [...objectType.properties.values()].map((property) => ({ ...property, policy: undefined }));

    expect(strip(declared)).toEqual(strip(bare));

    expect(
      policiesOf(
        version((ir) => groupsOf(ir, ACCOUNT).splice(1)),
        ACCOUNT,
      ),
    ).toEqual({});
  });
});

describe('the property security policies that publish refuses', () => {
  it('ontology/object-security-policies#policies service/publish#security-policies: refuses a Property in 2 property security policies, and the error names the Property and both policies', () => {
    const twice = version((ir) => void groupOf(ir, 'plain').properties.push('rate'));

    expectFeatureRefused(
      twice,
      `Object Type ${ACCOUNT} has the Property rate in 2 property security policies, 'pay' and 'plain'. A Property is in at most 1 property security policy.`,
    );
  });

  it('ontology/object-security-policies#policies service/publish#security-policies: refuses the primary key in a property security policy', () => {
    const key = version((ir) => void groupOf(ir, 'pay').properties.push('accountId'));

    expectFeatureRefused(
      key,
      `${PAY_MESSAGE} holds the primary key accountId. The primary key is in no property security policy.`,
    );
  });

  it('service/publish#security-policies: refuses a Property that the Object Type does not have', () => {
    expectFeatureRefused(
      version((ir) => void groupOf(ir, 'pay').properties.push('salary')),
      `${PAY_MESSAGE} holds the Property salary, which the Object Type does not have.`,
    );
  });

  it.each([
    ['not', { type: 'not', not: { condition: { type: 'and', and: { conditions: [] } } } }, 'uses not'],
    [
      'the username of the person',
      {
        type: 'comparison',
        comparison: {
          left: { type: 'property', property: 'ownerId' },
          operator: 'EQUAL',
          right: { type: 'userProperty', userProperty: { type: 'username', username: {} } },
        },
      },
      'reads the username',
    ],
    [
      'a Double Property',
      {
        type: 'comparison',
        comparison: {
          left: { type: 'property', property: 'rate' },
          operator: 'EQUAL',
          right: { type: 'userProperty', userProperty: { type: 'userId', userId: {} } },
        },
      },
      'reads the Property rate, which is not a String',
    ],
    [
      'an unknown operator',
      {
        type: 'comparison',
        comparison: {
          left: { type: 'property', property: 'ownerId' },
          operator: 'LESS_THAN',
          right: { type: 'userProperty', userProperty: { type: 'userId', userId: {} } },
        },
      },
      'uses the operator LESS_THAN',
    ],
    [
      'an and of no condition inside an or',
      { type: 'or', or: { conditions: [{ type: 'and', and: { conditions: [] } }] } },
      'has an and with no condition',
    ],
  ])(
    'service/publish#security-policies ontology/object-security-policies#conditions: refuses a property security policy with %s, with the same error as an object security policy',
    (_shape, condition, message) => {
      expectFeatureRefused(
        version((ir) => void (groupOf(ir, 'pay').security.granular.viewPolicy.granularPolicyCondition = condition)),
        `${PAY_MESSAGE} ${message}`,
      );
    },
  );

  it('service/publish#security-policies: refuses a property security policy that reads markings', () => {
    const markings = version((ir) => {
      const viewPolicy = groupOf(ir, 'pay').security.granular.viewPolicy as { additionalMandatory?: unknown };

      viewPolicy.additionalMandatory = { markings: { 'm-1': 'MANDATORY' }, assumedMarkings: [], assumedMarkingsV2: {} };
    });

    expectFeatureRefused(markings, `${PAY_MESSAGE} reads markings. V1 has no markings.`);
  });

  it.each<[string, (group: Group) => void, string]>([
    [
      'a group with an unknown key',
      (group) => void (group['note'] = 'x'),
      'has a security group with the unknown key note',
    ],
    [
      'a type body with an unknown key',
      (group) => void (group.type['property'] = { name: 'pay', x: 1 }),
      'has a property group type with the unknown key x',
    ],
    [
      'a type with an unknown key',
      (group) => void (group.type['extra'] = {}),
      'has a property group type with the unknown key extra',
    ],
    ['a type with no name', (group) => void (group.type['property'] = {}), 'has a property group type with no name'],
    [
      'a type whose name is not the group name',
      (group) => void (group.type['property'] = { name: 'other' }),
      "has a property group type with the name 'other'",
    ],
    [
      'properties that is not a list',
      (group) => void (group.properties = unchecked('rate')),
      'has no list of Properties',
    ],
    [
      'a Property name that is not a String',
      (group) => void (group.properties = unchecked([1])),
      'has no list of Properties',
    ],
    [
      'no security',
      (group) => void delete (group as { security?: unknown }).security,
      'has a security that is not an object',
    ],
  ])('ontology/object-security-policies#conditions: refuses a property group with %s', (_shape, change, message) => {
    expectFeatureRefused(
      version((ir) => change(groupOf(ir, 'pay'))),
      `${PAY_MESSAGE} ${message}`,
    );
  });
});

describe('a stored version with no property group', () => {
  it('compiles each type of the issue policies IR with no Property policy', () => {
    const compiled = compileOrThrow(stored(policiesIr(), { functions: twinFunctions('0.6.3') }));

    expect(
      [...compiled.objectTypes.values()].flatMap((objectType) =>
        [...objectType.properties.values()].filter((property) => property.policy !== undefined),
      ),
    ).toEqual([]);
  });
});

describe('the security of each group kind, in the IR form of @osdk/client.unstable', () => {
  const EMPTY = { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} };

  const mandatoryOnly = (policy: unknown, extra: object = {}) => ({
    type: 'mandatoryOnly',
    mandatoryOnly: { policy, ...extra },
  });

  const KINDS = [
    [
      'the primaryKey group',
      'defaultObjectSecurityPolicy',
      `Object Type ${ACCOUNT} has the object security policy 'defaultObjectSecurityPolicy', which`,
    ],
    ['a property group', 'pay', PAY_MESSAGE],
  ] as const;

  const withSecurity = (group: string, security: unknown) =>
    version((ir) => void (groupOf(ir, group).security = unchecked(security)));

  describe.each(KINDS)('%s', (_kind, group, message) => {
    it.each<[string, unknown, string]>([
      [
        'the IR form of mandatoryOnly with markings',
        mandatoryOnly({ ...EMPTY, markings: { m1: 'MANDATORY' } }),
        'reads markings. V1 has no markings.',
      ],
      [
        'the IR form of mandatoryOnly with assumed markings',
        mandatoryOnly({ ...EMPTY, assumedMarkings: ['m1'] }),
        'reads markings. V1 has no markings.',
      ],
      [
        'the IR form of mandatoryOnly with assumedMarkingsV2',
        mandatoryOnly({ ...EMPTY, assumedMarkingsV2: { m1: 'MANDATORY' } }),
        'reads markings. V1 has no markings.',
      ],
      [
        'an unknown key in mandatoryOnly',
        mandatoryOnly(EMPTY, { groups: ['admin'] }),
        'has a mandatoryOnly security with the unknown key groups.',
      ],
      [
        'an unknown key in the mandatory policy',
        mandatoryOnly({ ...EMPTY, x: 1 }),
        'has a mandatory policy with the unknown key x.',
      ],
      [
        'the flat form mandatoryOnly: { markings }',
        { type: 'mandatoryOnly', mandatoryOnly: EMPTY },
        'has a mandatoryOnly security with the unknown key markings.',
      ],
      [
        'a mandatoryOnly with no policy',
        { type: 'mandatoryOnly', mandatoryOnly: {} },
        'has a mandatory policy that is not markings, assumedMarkings, and assumedMarkingsV2.',
      ],
      [
        'a mandatory policy with no assumedMarkings',
        mandatoryOnly({ markings: {}, assumedMarkingsV2: {} }),
        'has a mandatory policy that is not markings, assumedMarkings, and assumedMarkingsV2.',
      ],
      [
        'a mandatory policy whose markings is a list',
        mandatoryOnly({ ...EMPTY, markings: [] }),
        'has a mandatory policy that is not markings, assumedMarkings, and assumedMarkingsV2.',
      ],
      [
        'an unknown key in the security',
        { type: 'mandatoryOnly', mandatoryOnly: { policy: EMPTY }, granular: {} },
        'has a security with the unknown key granular.',
      ],
    ])(
      'ontology/object-security-policies#conditions service/publish#security-policies: refuses %s',
      (_shape, security, expected) => {
        expectFeatureRefused(withSecurity(group, security), `${message} ${expected}`);
      },
    );

    const granular = (
      change: (
        viewPolicy: Record<string, unknown>,
        granular: Record<string, unknown>,
        security: Record<string, unknown>,
      ) => void,
    ) =>
      version((ir) => {
        const { security } = groupOf(ir, group);

        change(security.granular.viewPolicy, security.granular, security);
      });

    it.each<
      [
        string,
        (
          viewPolicy: Record<string, unknown>,
          granular: Record<string, unknown>,
          security: Record<string, unknown>,
        ) => void,
        string,
      ]
    >([
      [
        'an unknown key in a granular security',
        (_v, _g, security) => void (security['mandatoryOnly'] = {}),
        'has a security with the unknown key mandatoryOnly.',
      ],
      [
        'an unknown key in granular',
        (_v, body) => void (body['x'] = 1),
        'has a granular security with the unknown key x.',
      ],
      [
        'an unknown key in viewPolicy',
        (viewPolicy) => void (viewPolicy['editPolicy'] = {}),
        'has a viewPolicy with the unknown key editPolicy.',
      ],
      [
        'an unknown key in additionalMandatory',
        (viewPolicy) => void (viewPolicy['additionalMandatory'] = { ...EMPTY, x: 1 }),
        'has a mandatory policy with the unknown key x.',
      ],
      [
        'no additionalMandatory',
        (viewPolicy) => void delete viewPolicy['additionalMandatory'],
        'has a mandatory policy that is not markings, assumedMarkings, and assumedMarkingsV2.',
      ],
      [
        'additionalMandatory with assumed markings',
        (viewPolicy) => void (viewPolicy['additionalMandatory'] = { ...EMPTY, assumedMarkings: ['m1'] }),
        'reads markings. V1 has no markings.',
      ],
    ])('ontology/object-security-policies#conditions: refuses %s', (_shape, change, expected) => {
      expectFeatureRefused(granular(change), `${message} ${expected}`);
    });
  });

  it('ontology/object-security-policies#policies: the exact empty IR form of mandatoryOnly reads as no policy, on both group kinds', () => {
    const open = version((ir) => {
      groupOf(ir, 'defaultObjectSecurityPolicy').security = unchecked(mandatoryOnly(EMPTY));

      groupOf(ir, 'pay').security = unchecked(mandatoryOnly(EMPTY));
    });

    expect(compiledObjectType(open, ACCOUNT).policy).toBeUndefined();
    expect(Object.keys(policiesOf(open, ACCOUNT))).toEqual(OPS);
  });

  it('the additionalMandatory that maker writes passes: each policy form of the maker IR compiles', () => {
    expect(Object.keys(policiesOf(version(), ACCOUNT))).toEqual(['name', 'phase', 'region', 'rate', 'profile', ...OPS]);
    expect(compiledObjectType(version(), ENGAGEMENT).policy).toBeDefined();
  });
});

describe('the datasources, the wrapper, and each group: no key out of place reads as no policy', () => {
  type Entry = Record<string, unknown> & {
    datasource: Record<string, unknown> & {
      datasetV3: Record<string, unknown> & { propertySecurityGroups: Record<string, unknown> };
    };
  };

  const withBlock = (change: (block: { datasources: unknown }, entry: Entry) => void) =>
    version((ir) => {
      const block = unchecked<{ datasources: Entry[] }>(ir.ontology.objectTypes[ACCOUNT]);
      const [entry] = block.datasources;

      if (!entry) throw new Error('property-policies.json has no datasource on Account.');

      change(block, entry);
    });

  const owner = `Object Type ${ACCOUNT} has`;

  it.each<[string, (block: { datasources: unknown }, entry: Entry) => void, string]>([
    [
      'datasources that is not a list',
      (block, entry) => void (block.datasources = { 0: entry }),
      `${owner} datasources that are not a list.`,
    ],
    [
      'a datasource entry that is not an object',
      (block) => void (block.datasources = ['dataset']),
      `${owner} a datasource that is not an object.`,
    ],
    [
      'a datasource with no type',
      (_b, entry) => void delete entry.datasource['type'],
      `${owner} a datasource with no body for its type.`,
    ],
    [
      'a body under another key than its type',
      (_b, entry) => void (entry.datasource['type'] = 'datasetV2'),
      `${owner} a datasource with no body for its type.`,
    ],
    [
      'propertySecurityGroups on the datasource, outside its body',
      (_b, entry) =>
        void (entry.datasource['propertySecurityGroups'] = entry.datasource.datasetV3.propertySecurityGroups),
      `${owner} propertySecurityGroups outside the body of its datasource.`,
    ],
    [
      'propertySecurityGroups on the datasource entry',
      (_b, entry) => void (entry['propertySecurityGroups'] = entry.datasource.datasetV3.propertySecurityGroups),
      `${owner} propertySecurityGroups outside the body of its datasource.`,
    ],
    [
      'an unknown key in propertySecurityGroups',
      (_b, entry) => void (entry.datasource.datasetV3.propertySecurityGroups['extra'] = []),
      `${owner} propertySecurityGroups with the unknown key extra.`,
    ],
    [
      'propertySecurityGroups with no group',
      (_b, entry) => void (entry.datasource.datasetV3.propertySecurityGroups['groups'] = []),
      `${owner} propertySecurityGroups with no group.`,
    ],
    [
      'a datasource whose type names another body, with the property group in a second body',
      (_b, entry) => {
        const groups = entry.datasource.datasetV3.propertySecurityGroups['groups'] as Group[];

        entry.datasource.datasetV3.propertySecurityGroups['groups'] = groups.filter(
          (group) => group.type.type === 'property',
        );

        entry.datasource['type'] = 'datasetV2';
        entry.datasource['datasetV2'] = { datasetRid: 'x' };
      },
      `${owner} a datasource with the unknown key datasetV3.`,
    ],
    [
      'a datasource whose type names another body, with the primaryKey group in a second body',
      (_b, entry) => {
        const groups = entry.datasource.datasetV3.propertySecurityGroups['groups'] as Group[];

        entry.datasource.datasetV3.propertySecurityGroups['groups'] = groups.filter(
          (group) => group.type.type === 'primaryKey',
        );

        entry.datasource['type'] = 'datasetV2';
        entry.datasource['datasetV2'] = { datasetRid: 'x' };
      },
      `${owner} a datasource with the unknown key datasetV3.`,
    ],
    [
      'a null propertySecurityGroups',
      (_b, entry) => void ((entry.datasource.datasetV3 as Record<string, unknown>)['propertySecurityGroups'] = null),
      `${owner} propertySecurityGroups with no list of groups.`,
    ],
  ])('ontology/object-security-policies#conditions: refuses %s', (_shape, change, expected) => {
    expectFeatureRefused(withBlock(change), expected);
  });

  const DEFAULT = `Object Type ${ACCOUNT} has the object security policy 'defaultObjectSecurityPolicy', which`;

  it.each<[string, (group: Group) => void, string]>([
    [
      'a primaryKey group with an unknown key',
      (group) => void (group['note'] = 'x'),
      'has a security group with the unknown key note.',
    ],
    [
      'a primaryKey type with an unknown key',
      (group) => void (group.type['x'] = {}),
      'has a primaryKey group type with the unknown key x.',
    ],
    [
      'a primaryKey type body that is not empty',
      (group) => void (group.type['primaryKey'] = { name: 'pay' }),
      'has a primaryKey group type with the unknown key name.',
    ],
    [
      'a primaryKey group with no type',
      (group) => void delete (group as { type?: unknown }).type,
      'has the security group type undefined.',
    ],
  ])('ontology/object-security-policies#conditions: refuses %s', (_shape, change, expected) => {
    expectFeatureRefused(
      version((ir) => change(groupOf(ir, 'defaultObjectSecurityPolicy'))),
      `${DEFAULT} ${expected}`,
    );
  });

  it('a datasource with no propertySecurityGroups, and no datasources, read as no policy', () => {
    expect(
      compiledObjectType(
        withBlock(
          (_b, entry) =>
            void delete (entry.datasource.datasetV3 as { propertySecurityGroups?: unknown }).propertySecurityGroups,
        ),
        ACCOUNT,
      ).policy,
    ).toBeUndefined();

    expect(
      policiesOf(
        withBlock((block) => void (block.datasources = [])),
        ACCOUNT,
      ),
    ).toEqual({});
  });
});
