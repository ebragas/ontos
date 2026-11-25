import type { OntologyIr } from '@osdk/client.unstable';
import type { Db } from '../../src/db/promise.test-utils.ts';
import type { GrantsFile } from '../../src/ontology/index.ts';
import { grantsOf, JOBSITE_DECLARATIONS, NS, USE } from '../../src/ontology/stored.test-utils.ts';
import { insertObjects } from '../../src/publish/publish.test-utils.ts';
import { ORGANIZATION } from '../../src/tokens.test-utils.ts';
import { stubUsers, type StubMembership } from '../../src/workos.test-utils.ts';
import type { UserSource, WorkosUser } from '../../src/auth/index.ts';

const CREW_MEMBER = `${NS}CrewMember`;
export const CREW = `${NS}Crew`;
export const JOBSITE = `${NS}Jobsite`;
export const DAILY_LOG = `${NS}DailyLog`;
export const CREATE_DAILY_LOG = `${NS}create-daily-log`;
export const EDIT_JOBSITE = `${NS}edit-jobsite`;

export const ANN: WorkosUser = {
  id: 'user_01JBSTANN0000000000000000A',
  email: 'ann@jobsite.test',
  first_name: 'Ann',
  last_name: 'Crew',
};

const BEN: WorkosUser = {
  id: 'user_01JBSTBEN0000000000000000B',
  email: 'ben@jobsite.test',
  first_name: 'Ben',
  last_name: 'Crew',
};

export const CAL: WorkosUser = {
  id: 'user_01JBSTCAL0000000000000000E',
  email: 'cal@jobsite.test',
  first_name: 'Cal',
  last_name: 'Crew',
};

const DEE: WorkosUser = {
  id: 'user_01JBSTDEE0000000000000000F',
  email: 'dee@jobsite.test',
  first_name: 'Dee',
  last_name: 'Crew',
};

const ADMIN: WorkosUser = {
  id: 'user_01JBSTADM0000000000000000C',
  email: 'admin@jobsite.test',
  first_name: 'Ada',
  last_name: 'Admin',
};

const FORMER: WorkosUser = {
  id: 'user_01JBSTFMR0000000000000000G',
  email: 'former@jobsite.test',
  first_name: 'Flo',
  last_name: 'Former',
};

const OUTSIDER: WorkosUser = {
  id: 'user_01JBSTOUT0000000000000000D',
  email: 'out@jobsite.test',
  first_name: 'Otto',
  last_name: 'Outside',
};

export const PEOPLE = {
  ann: { sub: ANN.id },
  ben: { sub: BEN.id },
  cal: { sub: CAL.id },
  dee: { sub: DEE.id },
  admin: { sub: ADMIN.id },
} as const;

const ROLES: Readonly<Record<string, string>> = {
  [ANN.id]: 'crew',
  [BEN.id]: 'crew',
  [CAL.id]: 'crew',
  [DEE.id]: 'crew',
  [ADMIN.id]: 'admin',
};

export type Person = keyof typeof PEOPLE;

const USERS: readonly WorkosUser[] = [ANN, BEN, CAL, DEE, ADMIN, FORMER, OUTSIDER];

export const MEMBERSHIPS: readonly StubMembership[] = [
  ...[ANN, BEN, CAL, DEE, ADMIN].map((user): StubMembership => ({
    user_id: user.id,
    organization_id: ORGANIZATION,
    status: 'active',
    roles: [ROLES[user.id] ?? ''],
  })),
  { user_id: FORMER.id, organization_id: ORGANIZATION, status: 'inactive' },
];

export function jobsiteGrants(ir: OntologyIr): GrantsFile {
  const grants = grantsOf(ir, ['admin', 'crew']);

  return {
    ...grants,
    permissions: { ...grants.permissions, admin: { description: 'See each jobsite, daily log, and budget' } },
    defaultRoles: { admin: ['ontology:install', 'admin', USE], crew: [USE] },
    personAttributes: JOBSITE_DECLARATIONS,
  };
}

export function jobsiteUsers(
  grants: GrantsFile,
  custom: Readonly<Record<string, readonly string[]>> = {},
  memberships: readonly StubMembership[] = MEMBERSHIPS,
): UserSource {
  return stubUsers(USERS, memberships, { roles: { [ORGANIZATION]: { ...grants.defaultRoles, ...custom } } });
}

export async function seedJobsite(db: Db): Promise<void> {
  await insertObjects(db, CREW, [
    { crewId: 'crew-a', name: 'Framing' },
    { crewId: 'crew-b', name: 'Concrete' },
  ]);

  await insertObjects(db, CREW_MEMBER, [
    { memberId: 'm-ann', userId: ANN.id, crewId: 'crew-a' },
    { memberId: 'm-ben', userId: BEN.id, crewId: 'crew-b' },
    { memberId: 'm-dee-a', userId: DEE.id, crewId: 'crew-a' },
    { memberId: 'm-dee-b', userId: DEE.id, crewId: 'crew-b' },
  ]);

  await insertObjects(db, JOBSITE, [
    { jobsiteId: 'j-1', name: 'Riverside', budget: 120000 },
    { jobsiteId: 'j-2', name: 'Harbor', budget: 80000 },
    { jobsiteId: 'j-3', name: 'Hilltop', budget: 50000 },
  ]);

  await insertObjects(db, DAILY_LOG, [
    { logId: 'log-1', jobsiteId: 'j-1', note: 'Poured footings', hours: 8, authorId: ANN.id },
    { logId: 'log-2', jobsiteId: 'j-2', note: 'Framed walls', hours: 6, authorId: ANN.id },
    { logId: 'log-3', jobsiteId: 'j-3', note: 'Graded lot', hours: 4, authorId: BEN.id },
    { logId: 'log-4', jobsiteId: 'j-3', note: 'Set forms', hours: 5, authorId: BEN.id },
  ]);

  for (const [crew, jobsite] of [
    ['crew-a', 'j-1'],
    ['crew-a', 'j-2'],
    ['crew-b', 'j-2'],
    ['crew-b', 'j-3'],
  ]) {
    await db.query({
      text: 'INSERT INTO ontology_1_objects.crew_jobsites (a_crew_id, b_jobsite_id) VALUES ($1, $2)',
      values: [crew, jobsite],
    });
  }
}
