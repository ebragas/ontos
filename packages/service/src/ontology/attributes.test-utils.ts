import type { OntologyIr } from '@osdk/client.unstable';
import type { GrantsFile } from './index.ts';
import type { PublishedFunctions } from '../publish/index.ts';
import { insertObjects, NS, type ActionsService } from '../actions/actions.test-utils.ts';
import { ATTRIBUTE_DECLARATIONS, attributesIr, ONTOLOGY_RID } from './stored.test-utils.ts';
import { withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { groupGrants, policyPeople } from '../policiesPeople.test-utils.ts';

export const CREW_MEMBER = `${NS}CrewMember`;
export const CREW = `${NS}Crew`;
export const JOBSITE = `${NS}Jobsite`;
export const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;

export const ROLES = {
  admin: ['ontology:install', 'admin', 'crew-members', 'crews', 'jobsites', 'crew-actions'],
  foreman: ['crew-members', 'crews', 'jobsites', 'crew-actions'],
  office: ['crews', 'crew-actions'],
  site: ['jobsites'],
};

export const SCHEMAS = { object: 'ontology_1_objects', engine: 'ontology_1_engine' };

export const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'foreman' },
    ben: { sub: 'user_ben', role: 'foreman' },
    carl: { sub: 'user_carl', role: 'foreman' },
    dan: { sub: 'user_dan', role: 'foreman' },
    admin: { sub: 'user_admin', role: 'admin' },
    office: { sub: 'user_ann', role: 'office' },
    site: { sub: 'user_ann', role: 'site' },
  },
  ROLES,
);

export type Person = keyof typeof PEOPLE;

const FUNCTIONS: TestFunction[] = [
  { apiName: 'readJobsites', inputs: [{ name: 'note', type: 'string' }], edits: [CREW] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Jobsite = { type: 'object', apiName: '${JOBSITE}' };

export const functions = {
  readJobsites: async (client, note) => {
    const batch = createEditBatch(client);
    const page = await client(Jobsite).fetchPage({ $orderBy: { jobsiteId: 'asc' } });
    batch.update({ $apiName: '${CREW}', $primaryKey: 'crew-d' }, { name: JSON.stringify({ note, jobsites: page.data.map((jobsite) => jobsite.$primaryKey) }) });
    return batch.getEdits();
  },
};
`;

export async function twin(): Promise<{ ir: OntologyIr; functions: PublishedFunctions }> {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, attributesIr());

  const own = (fn: unknown) => JSON.stringify(fn).includes('"functionName":"readJobsites"');

  return { ir, functions: { ...functions, discovered: functions.discovered.filter(own) } };
}

export function attributeGrants(ir: OntologyIr): GrantsFile {
  const all = groupGrants(ir, ROLES);

  return {
    ...all,
    objectTypes: { [CREW_MEMBER]: 'crew-members', [CREW]: 'crews', [JOBSITE]: 'jobsites' },
    actionTypes: Object.fromEntries(Object.keys(all.actionTypes).map((name) => [name, 'crew-actions'])),
    personAttributes: ATTRIBUTE_DECLARATIONS,
  };
}

export async function seedAttributes(service: ActionsService): Promise<void> {
  await service.clear();

  await insertObjects(
    service.db,
    CREW,
    ['crew-a', 'crew-b', 'crew-c', 'crew-d'].map((crewId) => ({ crewId, name: crewId })),
  );

  await insertObjects(
    service.db,
    JOBSITE,
    ['j-1', 'j-2', 'j-3', 'j-4', 'j-5'].map((jobsiteId) => ({ jobsiteId, name: jobsiteId })),
  );

  const member = (memberId: string, userId: string, crewId: string | null) => ({ memberId, userId, crewId });

  await insertObjects(service.db, CREW_MEMBER, [
    member('m-ann', 'user_ann', 'crew-a'),
    member('m-ben-1', 'user_ben', 'crew-b'),
    member('m-ben-2', 'user_ben', 'crew-d'),
    member('m-dan', 'user_dan', null),
  ]);

  for (const [crew, jobsite] of [
    ['crew-a', 'j-1'],
    ['crew-a', 'j-2'],
    ['crew-b', 'j-2'],
    ['crew-b', 'j-3'],
    ['crew-c', 'j-4'],
  ]) {
    await service.db.query(
      sql('INSERT INTO ontology_1_objects.crew_jobsites (a_crew_id, b_jobsite_id) VALUES ($1, $2)', crew, jobsite),
    );
  }
}
