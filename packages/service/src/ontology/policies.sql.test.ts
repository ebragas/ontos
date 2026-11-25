import type { Claims } from '../tokens.test-utils.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONTOLOGY_RID, startActions, type ActionsService, type RawAnswer } from '../actions/actions.test-utils.ts';
import { compileOrThrow, jobsiteIr, stored, USE } from './stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  ANN,
  CAL,
  CREW,
  DAILY_LOG,
  JOBSITE,
  jobsiteGrants,
  jobsiteUsers,
  MEMBERSHIPS,
  PEOPLE,
  seedJobsite,
} from '../../twin/seed/jobsite.test-utils.ts';
import { type GrantsFile, type Policy } from './index.ts';

const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const ir = jobsiteIr();
const grants = jobsiteGrants(ir);

const memberships = MEMBERSHIPS.map((membership) =>
  membership.user_id === CAL.id ? { ...membership, roles: ['org-foreman'] } : membership,
);

const CUSTOM = { 'org-foreman': [USE, 'admin'], 'org-none': [] };
const users = jobsiteUsers(grants, CUSTOM, memberships);

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(ir, undefined, grants);

  await seedJobsite(service.db);
});

afterAll(async () => {
  await service.stop();
});

const json = (answer: RawAnswer) => JSON.parse(answer.text) as Record<string, unknown>;

const load = (objectType: string, claims: Claims, select: readonly string[], from = users) =>
  service.call(
    'POST',
    `${ONTOLOGY}/objectSets/loadObjects`,
    { objectSet: { type: 'base', objectType }, select, orderBy: { fields: [{ field: select[0], direction: 'asc' }] } },
    { claims, users: from },
  );

const rows = async (objectType: string, claims: Claims, select: readonly string[], from = users) => {
  const answer = await load(objectType, claims, select, from);

  if (answer.status !== 200) throw new Error(`loadObjects gave ${answer.status}: ${answer.text}`);

  return (json(answer)['data'] as Record<string, unknown>[]).map((object) =>
    Object.fromEntries(select.map((key) => [key, object[key] ?? null])),
  );
};

describe('the policy twin grants file', () => {
  it('service/testing#policy-twin service/ontology-as-code#security-policies: each group condition of the policy twin names a permission of its grants file, which only the default role admin holds', () => {
    const slugs = (policy: Policy): string[] =>
      policy.kind === 'compare'
        ? policy.person.kind === 'permissions' && policy.object.kind === 'constant'
          ? [...policy.object.values]
          : []
        : policy.conditions.flatMap(slugs);

    const compiled = compileOrThrow(stored(ir));

    const groups = [...compiled.objectTypes.values()]
      .flatMap((objectType) => [objectType.policy, ...[...objectType.properties.values()].map(({ policy }) => policy)])
      .flatMap((policy) => (policy ? slugs(policy) : []));

    const declared: GrantsFile = grants;

    expect({
      groups: [...new Set(groups)],
      permissions: Object.keys(declared.permissions).sort(),
      defaultRoles: declared.defaultRoles,
    }).toEqual({
      groups: ['admin'],
      permissions: ['admin', 'twin:use'],
      defaultRoles: { admin: ['ontology:install', 'admin', 'twin:use'], crew: ['twin:use'] },
    });
  });
});

describe('the policies of the twin with permissions', () => {
  it('service/authentication#access: a custom role that holds the permission of the policies views each Jobsite and each budget, as the default role admin does', async () => {
    const all = [
      { jobsiteId: 'j-1', budget: 120000 },
      { jobsiteId: 'j-2', budget: 80000 },
      { jobsiteId: 'j-3', budget: 50000 },
    ];

    expect(await rows(JOBSITE, PEOPLE.cal, ['jobsiteId', 'budget'])).toEqual(all);

    expect(await rows(JOBSITE, PEOPLE.admin, ['jobsiteId', 'budget'])).toEqual(all);

    expect(await rows(JOBSITE, PEOPLE.ann, ['jobsiteId', 'budget'])).toEqual([
      { jobsiteId: 'j-1', budget: null },
      { jobsiteId: 'j-2', budget: null },
    ]);
  });

  it('service/authentication#access: the policies run after the permission of the type, so a caller without it gets 404 ObjectTypeNotFound, and a caller with it gets the Objects that the policy lets it view', async () => {
    const none = jobsiteUsers(
      grants,
      CUSTOM,
      memberships.map((membership) =>
        membership.user_id === ANN.id ? { ...membership, roles: ['org-none'] } : membership,
      ),
    );

    const refused = await load(JOBSITE, PEOPLE.ann, ['jobsiteId'], none);

    expect([refused.status, json(refused)['errorName'], json(refused)['parameters']]).toEqual([
      404,
      'ObjectTypeNotFound',
      { objectType: JOBSITE },
    ]);

    expect(await rows(JOBSITE, PEOPLE.ann, ['jobsiteId'])).toEqual([{ jobsiteId: 'j-1' }, { jobsiteId: 'j-2' }]);
  });

  it('ontology/object-security-policies#policies: an Object Type with no object security policy shows each of its Objects to each caller that holds its permission', async () => {
    const crews = [{ crewId: 'crew-a' }, { crewId: 'crew-b' }];

    expect([
      await rows(CREW, PEOPLE.ann, ['crewId']),
      await rows(CREW, PEOPLE.cal, ['crewId']),
      await rows(CREW, PEOPLE.admin, ['crewId']),
    ]).toEqual([crews, crews, crews]);
  });
});

describe('a request reads only the Person attributes of its view', () => {
  it('ontology/object-security-policies#person-attributes service/code-layout#seams: a caller whose view has no policy that reads jobsiteIds reads no Person attribute, and a caller whose view has one reads it', async () => {
    const split: GrantsFile = {
      ...grants,
      permissions: {
        ...grants.permissions,
        'crews:read': { description: 'View crews' },
        'jobsites:read': { description: 'View jobsites' },
      },
      objectTypes: Object.fromEntries(
        Object.keys(grants.objectTypes).map((name) => [
          name,
          name === JOBSITE || name === DAILY_LOG ? 'jobsites:read' : 'crews:read',
        ]),
      ),
      actionTypes: Object.fromEntries(Object.keys(grants.actionTypes).map((name) => [name, 'jobsites:read'])),
      defaultRoles: {
        admin: ['ontology:install', 'admin', 'crews:read', 'jobsites:read'],
        crew: ['crews:read', 'jobsites:read'],
      },
    };

    await service.publish(ir, undefined, split);

    const custom = { 'org-crews': ['crews:read'], 'org-jobsites': ['crews:read', 'jobsites:read'] };

    const as = (role: string) =>
      jobsiteUsers(
        split,
        custom,
        memberships.map((membership) =>
          membership.user_id === ANN.id ? { ...membership, roles: [role] } : membership,
        ),
      );

    await service.db.query(sql('ALTER TABLE ontology_1_objects.crew_jobsites RENAME TO crew_jobsites_hidden'));

    try {
      const crewsOnly = await load(CREW, PEOPLE.ann, ['crewId'], as('org-crews'));

      const withJobsites = await load(CREW, PEOPLE.ann, ['crewId'], as('org-jobsites'));

      expect([crewsOnly.status, withJobsites.status, json(withJobsites)['errorName']]).toEqual([
        200,
        500,
        'Default:Internal',
      ]);
    } finally {
      await service.db.query(sql('ALTER TABLE ontology_1_objects.crew_jobsites_hidden RENAME TO crew_jobsites'));
    }
  });
});
