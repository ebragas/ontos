import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertObjects, NS, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { ATTRIBUTE_DECLARATIONS, attributesIr, ONTOLOGY_RID } from '../ontology/stored.test-utils.ts';
import { groupGrants, policyPeople } from '../policiesPeople.test-utils.ts';
import { installOntology } from '../install.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';

const CREW_MEMBER = `${NS}CrewMember`;
const CREW = `${NS}Crew`;
const JOBSITE = `${NS}Jobsite`;
const SECOND_RID = 'ri.ontology.main.ontology.00000000-0000-0000-0000-000000000002';

const ROLES = { admin: ['admin'], foreman: ['crew-members', 'crews', 'jobsites'] };

const PEOPLE = policyPeople(
  { ann: { sub: 'user_ann', role: 'foreman' }, ben: { sub: 'user_ben', role: 'foreman' } },
  ROLES,
);

type Person = keyof typeof PEOPLE;

let service: ActionsService;

beforeAll(async () => {
  const ir = attributesIr();

  const grants = {
    ...groupGrants(ir, ROLES),
    objectTypes: { [CREW_MEMBER]: 'crew-members', [CREW]: 'crews', [JOBSITE]: 'jobsites' },
    personAttributes: ATTRIBUTE_DECLARATIONS,
  };

  service = await startActions(ir, undefined, grants);

  await installOntology(service.db, {
    rid: SECOND_RID,
    product: 'twin',
    apiName: 'second',
    displayName: 'second',
    organization: ORGANIZATION,
  });

  await insertObjects(service.db, CREW, [
    { crewId: 'crew-a', name: 'crew-a' },
    { crewId: 'crew-b', name: 'crew-b' },
  ]);

  await insertObjects(service.db, JOBSITE, [
    { jobsiteId: 'j-1', name: 'j-1' },
    { jobsiteId: 'j-2', name: 'j-2' },
  ]);

  await insertObjects(service.db, CREW_MEMBER, [
    { memberId: 'm-ann', userId: 'user_ann', crewId: 'crew-a' },
    { memberId: 'm-ben', userId: 'user_ben', crewId: 'crew-b' },
  ]);

  await service.db.query(
    sql(
      `INSERT INTO ontology_1_objects.crew_jobsites (a_crew_id, b_jobsite_id) VALUES ('crew-a', 'j-1'), ('crew-b', 'j-2')`,
    ),
  );

  await service.db.query(sql(`INSERT INTO ontology_2_objects.crew (crew_id, name) VALUES ('crew-x', 'crew-x')`));

  await service.db.query(sql(`INSERT INTO ontology_2_objects.jobsite (jobsite_id, name) VALUES ('j-7', 'j-7')`));

  await service.db.query(
    sql(
      `INSERT INTO ontology_2_objects.crew_member (member_id, user_id, crew_id) VALUES ('m-ann-2', 'user_ann', 'crew-x')`,
    ),
  );

  await service.db.query(
    sql(`INSERT INTO ontology_2_objects.crew_jobsites (a_crew_id, b_jobsite_id) VALUES ('crew-x', 'j-7')`),
  );
});

afterAll(() => service?.stop());

async function keysOf(rid: string, objectType: string, primaryKey: string, person: Person): Promise<unknown> {
  const body = {
    objectSet: { type: 'base', objectType },
    select: [primaryKey],
    orderBy: { fields: [{ field: primaryKey, direction: 'asc' }] },
    excludeRid: true,
  };

  const answer = await service.call('POST', `/api/v2/ontologies/${rid}/objectSets/loadObjects`, body, PEOPLE[person]);

  if (answer.status !== 200) return { status: answer.status, text: answer.text };

  return (JSON.parse(answer.text) as { data: Record<string, unknown>[] }).data.map((object) => object[primaryKey]);
}

describe('ontology/object-security-policies#person-attributes: openRequest binds the attributes of the view of its own request', () => {
  it('ontology/object-security-policies#person-attributes the Reader of each request holds the schemas, the attributes, and the person of the view of that request, not of another view or version', async () => {
    const requests: [string, Person][] = [
      [ONTOLOGY_RID, 'ann'],
      [ONTOLOGY_RID, 'ben'],
      [SECOND_RID, 'ann'],
      [SECOND_RID, 'ben'],
      [ONTOLOGY_RID, 'ann'],
    ];

    const answers = [];

    for (const [rid, person] of requests)
      answers.push([
        await keysOf(rid, JOBSITE, 'jobsiteId', person),
        await keysOf(rid, CREW_MEMBER, 'memberId', person),
      ]);

    expect(answers).toEqual([
      [['j-1'], ['m-ann']],
      [['j-2'], ['m-ben']],
      [['j-7'], ['m-ann-2']],
      [[], []],
      [['j-1'], ['m-ann']],
    ]);
  });
});
