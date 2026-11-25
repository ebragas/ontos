import { describe, expect, it } from 'vitest';
import { permissionIndex, type CompiledOntology, type GrantsFile, type PropertyType } from '../index.ts';
import {
  ATTRIBUTE_DECLARATIONS,
  attributesIr,
  compileOrThrow,
  grantsOf,
  NS,
  stored,
  twinFunctions,
  twinIr,
} from '../stored.test-utils.ts';
import { forPermissions } from './forPermissions.ts';
import {
  attributesRead,
  personAttributeProblems,
  personAttributesOf,
  resolvePersonAttributes,
} from './personAttributes.ts';

const CREW_MEMBER = `${NS}CrewMember`;
const JOBSITE = `${NS}Jobsite`;
const COMPILED = compileOrThrow(stored(attributesIr()));

function grants(personAttributes: GrantsFile['personAttributes']): GrantsFile {
  return { ...grantsOf(attributesIr()), ...(personAttributes ? { personAttributes } : {}) };
}

function withUserIdOf(type: PropertyType): CompiledOntology {
  const member = COMPILED.objectTypes.get(CREW_MEMBER);
  const userId = member?.properties.get('userId');

  if (!member || !userId) throw new Error('The twin has no CrewMember.userId.');

  const properties = new Map(member.properties).set('userId', { ...userId, type });

  return { ...COMPILED, objectTypes: new Map(COMPILED.objectTypes).set(CREW_MEMBER, { ...member, properties }) };
}

function withoutPolicy<T extends { readonly policy?: unknown }>(value: T): Omit<T, 'policy'> {
  const { policy, ...rest } = value;

  void policy;

  return rest;
}

describe('the path of a Person attribute', () => {
  it('service/ontology-as-code#the-grants-file: a path names a start Object Type, its String Property, and Link sides, each a side of the Object Type before it', () => {
    expect(personAttributeProblems(COMPILED, grants(ATTRIBUTE_DECLARATIONS))).toEqual([]);

    expect(Object.fromEntries(resolvePersonAttributes(COMPILED, grants(ATTRIBUTE_DECLARATIONS)))).toEqual({
      jobsiteIds: {
        name: 'jobsiteIds',
        start: { table: 'crew_member', keyColumn: 'member_id', userColumn: 'user_id' },
        steps: [
          { via: { kind: 'foreignKeyHere', column: 'crew_id' }, target: { table: 'crew', keyColumn: 'crew_id' } },
          {
            via: { kind: 'joinTable', table: 'crew_jobsites', sourceColumn: 'a_crew_id', targetColumn: 'b_jobsite_id' },
            target: { table: 'jobsite', keyColumn: 'jobsite_id' },
          },
        ],
      },
      memberIds: {
        name: 'memberIds',
        start: { table: 'crew_member', keyColumn: 'member_id', userColumn: 'user_id' },
        steps: [],
      },
    });
  });

  it.each([
    [
      'a missing Object Type',
      { start: { objectType: `${NS}Foreman`, property: 'userId' }, links: [] },
      `The Person attribute a starts at the Object Type ${NS}Foreman, which the IR does not have.`,
    ],
    [
      'a missing start Property',
      { start: { objectType: CREW_MEMBER, property: 'email' }, links: [] },
      `The Person attribute a starts at the Property email, which the Object Type ${CREW_MEMBER} does not have.`,
    ],
    [
      'a Link side of another Object Type',
      { start: { objectType: CREW_MEMBER, property: 'userId' }, links: ['jobsites'] },
      `The Person attribute a follows the Link side jobsites, which is not a side of the Object Type ${CREW_MEMBER}.`,
    ],
    [
      'a missing Link side after a valid one',
      { start: { objectType: CREW_MEMBER, property: 'userId' }, links: ['crew', 'crews'] },
      `The Person attribute a follows the Link side crews, which is not a side of the Object Type ${NS}Crew.`,
    ],
  ])('a path with %s is a problem of the grants check', (_name, declaration, problem) => {
    const file = grants({ ...ATTRIBUTE_DECLARATIONS, a: declaration });

    expect(personAttributeProblems(COMPILED, file)).toEqual([problem]);
    expect([...resolvePersonAttributes(COMPILED, file).keys()]).toEqual(['jobsiteIds', 'memberIds']);
  });

  it.each([
    ['an Integer', { kind: 'integer' }],
    ['a String array', { kind: 'array', element: { kind: 'string' } }],
  ] as const)('a start Property that is %s is a problem of the grants check', (_name, type) => {
    expect(personAttributeProblems(withUserIdOf(type), grants(ATTRIBUTE_DECLARATIONS))).toEqual([
      `The Person attribute jobsiteIds starts at the Property userId of ${CREW_MEMBER}, which is not a String.`,
      `The Person attribute memberIds starts at the Property userId of ${CREW_MEMBER}, which is not a String.`,
    ]);
  });

  it('a policy that reads an undeclared Person attribute is a problem of the grants check', () => {
    expect(personAttributeProblems(COMPILED, grants({ memberIds: ATTRIBUTE_DECLARATIONS.memberIds }))).toEqual([
      `The object security policy of the Object Type ${JOBSITE} reads the Person attribute jobsiteIds, which personAttributes does not declare.`,
    ]);

    expect(personAttributeProblems(COMPILED, grants(undefined))).toEqual([
      `The object security policy of the Object Type ${CREW_MEMBER} reads the Person attribute memberIds, which personAttributes does not declare.`,
      `The object security policy of the Object Type ${JOBSITE} reads the Person attribute jobsiteIds, which personAttributes does not declare.`,
    ]);
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'a policy that reads the attribute %s is undeclared, though every object has that name',
    (name) => {
      const jobsite = COMPILED.objectTypes.get(JOBSITE);

      if (!jobsite) throw new Error('The twin has no Jobsite.');

      const reads: CompiledOntology = {
        ...COMPILED,
        objectTypes: new Map(COMPILED.objectTypes).set(JOBSITE, {
          ...jobsite,
          policy: {
            kind: 'compare',
            object: { kind: 'property', property: 'jobsiteId' },
            operator: 'subsetOf',
            person: { kind: 'attribute', name },
          },
        }),
      };

      expect(personAttributeProblems(reads, grants(ATTRIBUTE_DECLARATIONS))).toEqual([
        `The object security policy of the Object Type ${JOBSITE} reads the Person attribute ${name}, which personAttributes does not declare.`,
      ]);
    },
  );

  it('ontology/object-security-policies#person-attributes: a declaration that does not resolve matches nothing at a cold start, and never throws', () => {
    const file = grants({
      jobsiteIds: { start: { objectType: CREW_MEMBER, property: 'userId' }, links: ['gone'] },
      memberIds: { start: { objectType: 'Gone', property: 'x' }, links: [] },
    });

    expect(() => resolvePersonAttributes(COMPILED, file)).not.toThrow();
    expect(resolvePersonAttributes(COMPILED, file).size).toBe(0);
    expect(resolvePersonAttributes(COMPILED, null).size).toBe(0);
  });
});

describe('the shape of personAttributes', () => {
  it('a declaration with start and links has the shape', () => {
    expect(personAttributesOf(ATTRIBUTE_DECLARATIONS)).toEqual(ATTRIBUTE_DECLARATIONS);
    expect(personAttributesOf({})).toEqual({});
  });

  it.each([
    ['a list', []],
    ['a String', 'jobsiteIds'],
    ['a declaration with no links', { a: { start: { objectType: 'A', property: 'p' } } }],
    ['a declaration with a 3rd key', { a: { start: { objectType: 'A', property: 'p' }, links: [], via: [] } }],
    ['a start with a 3rd key', { a: { start: { objectType: 'A', property: 'p', column: 'c' }, links: [] } }],
    ['a start Property that is not a String', { a: { start: { objectType: 'A', property: 1 }, links: [] } }],
    ['links that are not a list', { a: { start: { objectType: 'A', property: 'p' }, links: 'crew' } }],
    [
      'a Link side that is not a String',
      { a: { start: { objectType: 'A', property: 'p' }, links: [{ side: 'crew' }] } },
    ],
  ])('service/publish#security-policies: %s is another shape', (_name, value) => {
    expect(personAttributesOf(value)).toBeUndefined();
  });
});

describe('the attributes that the view of a set of permissions reads', () => {
  it('attributesRead names the attributes of the object policies of a view, and the view with no type reads none', () => {
    const file: GrantsFile = {
      permissions: {
        'crew:read': { description: 'Read crew members' },
        'jobsites:read': { description: 'Read jobsites' },
        'crews:read': { description: 'Read crews' },
      },
      objectTypes: { [CREW_MEMBER]: 'crew:read', [JOBSITE]: 'jobsites:read', [`${NS}Crew`]: 'crews:read' },
      actionTypes: {},
      defaultRoles: { admin: ['crew:read'], foreman: ['crew:read', 'jobsites:read'] },
    };

    const index = permissionIndex(COMPILED, file);
    const viewOf = (permissions: readonly string[]) => forPermissions(COMPILED, index, new Set(permissions));

    expect([...attributesRead(viewOf(['crew:read', 'jobsites:read']))].sort()).toEqual(['jobsiteIds', 'memberIds']);
    expect([...attributesRead(viewOf(['crew:read']))]).toEqual(['memberIds']);
    expect([...attributesRead(viewOf([]))]).toEqual([]);
  });

  it('attributesRead walks the property security policies and the Submission criteria', () => {
    const member = COMPILED.objectTypes.get(CREW_MEMBER);

    const action = compileOrThrow(stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') })).actionTypes.get(
      `${NS}create-account`,
    );

    if (!action) throw new Error('The twin has no create-account.');

    if (!member) throw new Error('The twin has no CrewMember.');

    const crewId = member.properties.get('crewId');

    if (!crewId) throw new Error('The twin has no crewId.');

    const person = (name: string) => ({ kind: 'attribute', name }) as const;

    const withProperty: CompiledOntology = {
      ...COMPILED,
      objectTypes: new Map([
        [
          CREW_MEMBER,
          {
            ...withoutPolicy(member),
            properties: new Map(member.properties).set('crewId', {
              ...crewId,
              policy: {
                kind: 'compare',
                object: { kind: 'property', property: 'crewId' },
                operator: 'subsetOf',
                person: person('crewIds'),
              },
            }),
          },
        ],
      ]),
      actionTypes: new Map([
        [
          action.apiName,
          {
            ...action,
            criteria: [
              {
                condition: {
                  kind: 'not',
                  condition: {
                    kind: 'comparison',
                    operator: 'INTERSECTS',
                    left: { kind: 'static', value: ['x'] },
                    right: { kind: 'person', fact: person('siteIds') },
                  },
                },
                failureMessage: 'm',
              },
            ],
          },
        ],
      ]),
    };

    expect([...attributesRead(withProperty)].sort()).toEqual(['crewIds', 'siteIds']);
  });
});
