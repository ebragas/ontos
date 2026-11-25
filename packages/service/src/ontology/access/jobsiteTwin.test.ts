import { expect, it } from 'vitest';

import { jobsiteGrants } from '../../../twin/seed/jobsite.test-utils.ts';
import { compileOrThrow, jobsiteIr, NS, stored } from '../stored.test-utils.ts';
import { personAttributeProblems, resolvePersonAttributes } from './personAttributes.ts';

const COMPILED = compileOrThrow(stored(jobsiteIr()));
const GRANTS = jobsiteGrants(jobsiteIr());

const ADMIN_GROUP = {
  kind: 'compare',
  object: { kind: 'constant', values: ['admin'] },
  operator: 'intersects',
  person: { kind: 'permissions' },
};

const ON_CREW_JOBSITE = {
  kind: 'or',
  conditions: [
    ADMIN_GROUP,
    {
      kind: 'compare',
      object: { kind: 'property', property: 'jobsiteId' },
      operator: 'subsetOf',
      person: { kind: 'attribute', name: 'jobsiteIds' },
    },
  ],
};

function objectType(name: string) {
  const compiled = COMPILED.objectTypes.get(`${NS}${name}`);

  if (!compiled) throw new Error(`The policy twin has no Object Type ${name}.`);

  return compiled;
}

it('CrewMember has a userId Property, and Crew to Jobsite is a many-to-many Link Type', () => {
  expect([...objectType('CrewMember').properties.keys()]).toEqual(['memberId', 'userId', 'crewId']);
  expect(objectType('CrewMember').policy).toBeUndefined();
  expect(COMPILED.linkTypes.get('crewJobsites')?.storage).toMatchObject({ kind: 'joinTable', table: 'crew_jobsites' });
});

it('the grants file declares the Person attribute jobsiteIds from CrewMember.userId through crew and jobsites', () => {
  expect(personAttributeProblems(COMPILED, GRANTS)).toEqual([]);

  expect(Object.fromEntries(resolvePersonAttributes(COMPILED, GRANTS))).toEqual({
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
  });
});

it('Jobsite and DailyLog have an object security policy on jobsiteIds, and budget has a property security policy for admin', () => {
  expect(objectType('Jobsite').policy).toEqual(ON_CREW_JOBSITE);
  expect(objectType('DailyLog').policy).toEqual(ON_CREW_JOBSITE);
  expect(objectType('Jobsite').properties.get('budget')?.policy).toEqual(ADMIN_GROUP);

  const policed = [...COMPILED.objectTypes.values()].flatMap((type) =>
    [...type.properties.values()]
      .filter((property) => property.policy)
      .map((property) => `${type.apiName}.${property.apiName}`),
  );

  expect(policed).toEqual([`${NS}Jobsite.budget`]);
});
