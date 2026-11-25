import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OntologyIr, OntologyIrPropertyType } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { type CompiledOntology, type StoredOntologyVersion } from './index.ts';
import {
  compileOrThrow,
  expectFeatureRefused,
  irOf,
  NS,
  stored,
  stringProperty,
  twinFunctions,
  twinIr,
  unchecked,
} from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;

type ObjectTypeBlock = OntologyIr['ontology']['objectTypes'][string];

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

type IrRule = ActionTypeBlock['actionType']['actionTypeLogic']['logic']['rules'][number];

type IrCondition =
  ActionTypeBlock['actionType']['actionTypeLogic']['validation']['actionTypeLevelValidation']['rules'][number]['condition'];

function twinWith(change: (ir: OntologyIr) => void = () => undefined): StoredOntologyVersion {
  const ir = twinIr('0.4.0');

  change(ir);

  return stored(ir, { functions: twinFunctions('0.4.0') });
}

function objectType(ir: OntologyIr, name: string): ObjectTypeBlock {
  const block = ir.ontology.objectTypes[`${NS}${name}`];

  if (!block) throw new Error(`The IR has no Object Type ${name}.`);

  return block;
}

function setEngagementStatus(ir: OntologyIr): ActionTypeBlock {
  const block = ir.ontology.actionTypes[SET_ENGAGEMENT_STATUS];

  if (!block) throw new Error('The IR has no Action Type set-engagement-status.');

  return block;
}

function addAccountProperty(ir: OntologyIr, property: OntologyIrPropertyType): void {
  objectType(ir, 'Account').objectType.propertyTypes[property.apiName] = property;
}

function setCriterion(ir: OntologyIr, condition: unknown): void {
  setEngagementStatus(ir).actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = {
    '0': {
      condition: unchecked<IrCondition>(condition),
      displayMetadata: { failureMessage: 'Not allowed.', typeClasses: [] },
    },
  };
}

function files(dir: URL): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(test|test-utils|fixture)\.ts$|\.snap$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('the service code', () => {
  it('service/ontology-as-code#contract: holds no Ontology; the twin Ontology-as-code and its IRs are test fixtures', () => {
    const sources = files(new URL('../', import.meta.url));

    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const text = readFileSync(file, 'utf8');

      expect(text, file).not.toMatch(/importedOntology|importedValueTypes/);
      expect(text, file).not.toMatch(/from\s+['"]@osdk\/maker/);
      expect(text, file).not.toMatch(/\bdefine(Object|Link|Action|Ontology|FunctionBackedAction)\s*\(/);
      expect(text, file).not.toMatch(/com\.osdk\.ontology\./);
    }

    for (const version of ['0.4.0', '0.6.3', '0.7.0']) {
      expect(existsSync(new URL(`../../twin/ir/${version}.json`, import.meta.url))).toBe(true);
      expect(existsSync(new URL(`../../twin/ontology/${version}/ontology.ts`, import.meta.url))).toBe(true);
    }

    const empty = compileOrThrow(stored(irOf()));

    expect([empty.objectTypes.size, empty.linkTypes.size, empty.actionTypes.size, empty.functions.size]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe('the V1 concepts', () => {
  it('service/ontology-as-code#contract: accepts the twin IR, which uses only V1 concepts', () => {
    const compiled = compileOrThrow(twinWith());

    expect(compiled.objectTypes.size).toBe(2);
    expect(compiled.linkTypes.size).toBe(1);
    expect(compiled.actionTypes.size).toBe(6);
    expect(compiled.functions.size).toBe(1);
  });

  const outside: [string, (ir: OntologyIr) => void, RegExp][] = [
    [
      'Interfaces (Object Types)',
      (ir) => {
        ir.ontology.interfaceTypes[`${NS}Party`] = unchecked({ interfaceType: { apiName: `${NS}Party` } });
      },
      /interface/i,
    ],
    [
      'Geoshape (Properties)',
      (ir) => addAccountProperty(ir, { ...stringProperty('area'), type: { type: 'geoshape', geoshape: {} } }),
      /geoshape/i,
    ],
    [
      'One-to-one Link Types (Link Types)',
      (ir) => {
        const link = ir.ontology.linkTypes['account-to-engagements'];

        if (!link) throw new Error('The IR has no Link Type account-to-engagements.');

        const definition = unchecked<{ oneToMany: { cardinalityHint: string } }>(link.linkType.definition);

        definition.oneToMany.cardinalityHint = 'ONE_TO_ONE';
      },
      /one-to-one/i,
    ],
    [
      'Scenario rules (Rules)',
      (ir) => {
        setEngagementStatus(ir).actionType.actionTypeLogic.logic.rules = [
          unchecked<IrRule>({ type: 'scenarioRule', scenarioRule: {} }),
        ];
      },
      /scenario/i,
    ],
    [
      'Conditions on the execution context (Submission criteria)',
      (ir) => setCriterion(ir, { type: 'executionContext', executionContext: { type: 'scenario', scenario: {} } }),
      /execution context/i,
    ],
  ];

  it.each(outside)(
    'service/ontology-as-code#contract: refuses %s, and the error names the feature',
    (_feature, change, fragment) => {
      expectFeatureRefused(twinWith(change), fragment);
    },
  );
});

describe('markings and groups', () => {
  it.each([
    ['MANDATORY', { type: 'marking', marking: { markingType: 'MANDATORY' } }],
    ['CBAC', { type: 'marking', marking: { markingType: 'CBAC' } }],
  ])(
    'service/ontology-as-code#contract: refuses a %s marking property, and the error names markings',
    (_kind, type) => {
      expectFeatureRefused(
        twinWith((ir) =>
          addAccountProperty(ir, {
            ...stringProperty('classification'),
            type: unchecked<OntologyIrPropertyType['type']>(type),
          }),
        ),
        'classification',
        /marking/i,
      );
    },
  );

  it('service/ontology-as-code#security-policies: reads the datasources, and compiles a property security group to the policy of its Properties', () => {
    const version = twinWith((ir) => {
      const account = objectType(ir, 'Account');

      const security = {
        type: 'granular',
        granular: {
          viewPolicy: {
            granularPolicyCondition: { type: 'and', and: { conditions: [] } },
            additionalMandatory: { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} },
          },
        },
      };

      const restricted = structuredClone(security);

      restricted.granular.viewPolicy.granularPolicyCondition = unchecked({
        type: 'comparison',
        comparison: {
          operator: 'INTERSECTS',
          left: { type: 'userProperty', userProperty: { type: 'groupIds', groupIds: {} } },
          right: { type: 'constant', constant: { type: 'strings', strings: ['admin'] } },
        },
      });

      account.datasources = [
        unchecked({
          datasourceName: ACCOUNT,
          datasource: {
            type: 'datasetV3',
            datasetV3: {
              datasetRid: ACCOUNT,
              propertyMapping: {
                accountId: { type: 'column', column: 'accountId' },
                name: { type: 'column', column: 'name' },
                phase: { type: 'column', column: 'phase' },
              },
              branchId: 'master',
              propertySecurityGroups: {
                groups: [
                  {
                    rid: 'defaultObjectSecurityPolicy',
                    security,
                    type: { type: 'primaryKey', primaryKey: {} },
                    properties: ['accountId', 'name'],
                  },
                  {
                    rid: 'restricted',
                    security: restricted,
                    type: { type: 'property', property: { name: 'restricted' } },
                    properties: ['phase'],
                  },
                ],
              },
            },
          },
          editsConfiguration: { onlyAllowPrivilegedEdits: false },
          redacted: false,
        }),
      ];
    });

    const account = compileOrThrow(version).objectTypes.get(ACCOUNT);

    expect(account?.properties.get('phase')?.policy).toEqual({
      kind: 'compare',
      object: { kind: 'constant', values: ['admin'] },
      operator: 'intersects',
      person: { kind: 'permissions' },
    });

    expect(
      [...(account?.properties.values() ?? [])]
        .filter((property) => property.policy !== undefined)
        .map((property) => property.apiName),
    ).toEqual(['phase']);

    expect(account?.policy).toBeUndefined();
  });

  it('compiles a group condition as user.permissions INTERSECTS the group names', () => {
    const inGroup = {
      type: 'comparison',
      comparison: {
        operator: 'INTERSECTS',
        left: {
          type: 'userProperty',
          userProperty: {
            userId: { type: 'currentUser', currentUser: {} },
            propertyValue: { type: 'groupIds', groupIds: {} },
          },
        },
        right: { type: 'staticValue', staticValue: { type: 'stringList', stringList: { strings: ['sales'] } } },
      },
    };

    const actionType = compileOrThrow(twinWith((ir) => setCriterion(ir, inGroup))).actionTypes.get(
      SET_ENGAGEMENT_STATUS,
    );

    expect(actionType?.criteria.map(({ condition }) => condition)).toEqual([
      {
        kind: 'comparison',
        operator: 'INTERSECTS',
        left: { kind: 'person', fact: { kind: 'permissions' } },
        right: { kind: 'static', value: ['sales'] },
      },
    ]);
  });

  describe('Object security policies', () => {
    function withPolicy(condition: unknown): StoredOntologyVersion {
      return twinWith((ir) => {
        objectType(ir, 'Account').datasources = [
          unchecked({
            datasourceName: ACCOUNT,
            datasource: {
              type: 'datasetV3',
              datasetV3: {
                datasetRid: ACCOUNT,
                propertyMapping: {},
                branchId: 'master',
                propertySecurityGroups: {
                  groups: [
                    {
                      rid: 'salesOnly',
                      security: {
                        type: 'granular',
                        granular: {
                          viewPolicy: {
                            granularPolicyCondition: condition,
                            additionalMandatory: { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} },
                          },
                        },
                      },
                      type: { type: 'primaryKey', primaryKey: {} },
                      properties: ['accountId', 'name', 'phase'],
                    },
                  ],
                },
              },
            },
            editsConfiguration: { onlyAllowPrivilegedEdits: false },
            redacted: false,
          }),
        ];
      });
    }

    const open = { type: 'and', and: { conditions: [] } };

    const inGroup = {
      type: 'comparison',
      comparison: {
        operator: 'INTERSECTS',
        left: { type: 'userProperty', userProperty: { type: 'groupIds', groupIds: {} } },
        right: { type: 'constant', constant: { type: 'strings', strings: ['sales'] } },
      },
    };

    it('compiles an Object security policy with a group condition to user.permissions', () => {
      expect(compileOrThrow(withPolicy(inGroup)).objectTypes.get(ACCOUNT)?.policy).toEqual({
        kind: 'compare',
        object: { kind: 'constant', values: ['sales'] },
        operator: 'intersects',
        person: { kind: 'permissions' },
      });
    });

    it('ontology/object-security-policies#policies: accepts the primaryKey group that @osdk/maker writes with no condition and no markings, and it shows each Object', () => {
      expect(compileOrThrow(withPolicy(open)).objectTypes.has(ACCOUNT)).toBe(true);
      expect(compileOrThrow(withPolicy(open)).objectTypes.get(ACCOUNT)?.policy).toBeUndefined();
    });
  });
});

describe('the datasources', () => {
  function storage(compiled: CompiledOntology): Record<string, { table: string; columns: Record<string, string> }> {
    return Object.fromEntries(
      [...compiled.objectTypes.values()].map((o) => [
        o.apiName,
        { table: o.table, columns: Object.fromEntries([...o.properties.values()].map((p) => [p.apiName, p.column])) },
      ]),
    );
  }

  const TWIN_STORAGE = {
    [ACCOUNT]: { table: 'account', columns: { accountId: 'account_id', name: 'name', phase: 'phase' } },
    [`${NS}Engagement`]: {
      table: 'engagement',
      columns: {
        engagementId: 'engagement_id',
        accountId: 'account_id',
        title: 'title',
        amount: 'amount',
        status: 'status',
        createdAt: 'created_at',
      },
    },
  };

  it('builds no table or column from a dataset datasource; a changed one changes nothing', () => {
    const original = compileOrThrow(twinWith());

    const changed = compileOrThrow(
      twinWith((ir) => {
        objectType(ir, 'Account').datasources = [
          unchecked({
            datasourceName: 'accounts',
            datasource: {
              type: 'datasetV2',
              datasetV2: {
                datasetRid: 'ri.dataset.main.dataset.accounts',
                propertyMapping: {
                  accountId: { type: 'column', column: 'ACCOUNT_KEY' },
                  name: { type: 'column', column: 'account_name' },
                  phase: { type: 'column', column: 'lifecycle' },
                },
              },
            },
            editsConfiguration: { onlyAllowPrivilegedEdits: false },
            redacted: false,
          }),
        ];
      }),
    );

    expect(storage(changed)).toEqual(TWIN_STORAGE);
    expect(changed).toEqual(original);
  });

  it('builds no table or column from the datasources; removing them changes nothing', () => {
    const original = compileOrThrow(twinWith());

    const removed = compileOrThrow(
      twinWith((ir) => {
        for (const block of Object.values(ir.ontology.objectTypes)) block.datasources = [];

        for (const block of Object.values(ir.ontology.linkTypes)) block.datasources = [];
      }),
    );

    expect(storage(removed)).toEqual(TWIN_STORAGE);
    expect(removed).toEqual(original);
  });

  function addJoinTableLink(ir: OntologyIr, columns: { a: string; b: string } | undefined): void {
    const side = (apiName: string) => ({
      apiName,
      displayMetadata: {
        displayName: apiName,
        pluralDisplayName: `${apiName}s`,
        visibility: 'NORMAL',
        groupDisplayName: '',
      },
      typeClasses: [],
    });

    const engagement = `${NS}Engagement`;

    ir.ontology.linkTypes['account-engagements'] = unchecked({
      linkType: {
        definition: {
          type: 'manyToMany',
          manyToMany: {
            objectTypeAToBLinkMetadata: side('relatedEngagements'),
            objectTypeBToALinkMetadata: side('relatedAccounts'),
            objectTypeRidA: ACCOUNT,
            objectTypeRidB: engagement,
            objectTypeAPrimaryKeyPropertyMapping: [
              { from: { apiName: 'accountId', object: ACCOUNT }, to: { apiName: 'accountId', object: ACCOUNT } },
            ],
            objectTypeBPrimaryKeyPropertyMapping: [
              {
                from: { apiName: 'engagementId', object: engagement },
                to: { apiName: 'engagementId', object: engagement },
              },
            ],
          },
        },
        id: 'account-engagements',
        status: { type: 'active', active: {} },
        redacted: false,
      },
      datasources: columns
        ? [
            {
              datasourceName: 'account-engagements',
              datasource: {
                type: 'dataset',
                dataset: {
                  datasetRid: 'ri.dataset.main.dataset.account-engagements',
                  objectTypeAPrimaryKeyMapping: [
                    { property: { apiName: 'accountId', object: ACCOUNT }, column: columns.a },
                  ],
                  objectTypeBPrimaryKeyMapping: [
                    { property: { apiName: 'engagementId', object: engagement }, column: columns.b },
                  ],
                },
              },
              editsConfiguration: { onlyAllowPrivilegedEdits: false },
            },
          ]
        : [],
      entityMetadata: { arePatchesEnabled: true },
    });
  }

  it('builds no join table or column from a many-to-many join table datasource', () => {
    const withColumns = compileOrThrow(twinWith((ir) => addJoinTableLink(ir, { a: 'acct', b: 'eng' })));
    const withOthers = compileOrThrow(twinWith((ir) => addJoinTableLink(ir, { a: 'ACCOUNT_KEY', b: 'engagement' })));
    const withNone = compileOrThrow(twinWith((ir) => addJoinTableLink(ir, undefined)));
    const linkStorage = withColumns.linkTypes.get('accountEngagements')?.storage;

    expect(linkStorage).toMatchObject({ kind: 'joinTable', table: 'account_engagements' });

    if (linkStorage?.kind !== 'joinTable') throw new Error('accountEngagements has no join table.');

    expect([linkStorage.a.column, linkStorage.b.column]).not.toContain('acct');
    expect([linkStorage.a.column, linkStorage.b.column]).not.toContain('eng');
    expect(withOthers).toEqual(withColumns);
    expect(withNone).toEqual(withColumns);
  });

  it('ontology/object-link-types/derived-properties#publish: reads the datasources to compile a derived Property, and builds no column for it', () => {
    const version = twinWith((ir) => {
      addAccountProperty(ir, { ...stringProperty('engagementCount'), type: { type: 'integer', integer: {} } });

      objectType(ir, 'Account').datasources.push(
        unchecked({
          datasourceName: `${ACCOUNT}.derived.0`,
          datasource: {
            type: 'derived',
            derived: {
              definition: {
                type: 'aggregatedProperties',
                aggregatedProperties: {
                  linkDefinition: {
                    type: 'multiHopLink',
                    multiHopLink: {
                      steps: [
                        {
                          type: 'searchAround',
                          searchAround: {
                            linkTypeIdentifier: { type: 'linkType', linkType: 'account-to-engagements' },
                            linkTypeSide: 'SOURCE',
                          },
                        },
                      ],
                    },
                  },
                  propertyTypeMapping: { engagementCount: { type: 'count', count: {} } },
                },
              },
            },
          },
          editsConfiguration: { onlyAllowPrivilegedEdits: false },
          redacted: false,
        }),
      );
    });

    const account = compileOrThrow(version).objectTypes.get(ACCOUNT);

    expect(account?.properties.has('engagementCount')).toBe(false);
    expect(account?.derived.get('engagementCount')?.definition.operation).toEqual({ type: 'count' });
  });
});
