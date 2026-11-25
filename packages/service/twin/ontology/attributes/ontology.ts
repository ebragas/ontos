import { defineLink, defineObject } from '@osdk/maker';

const attribute = (attributeKey: string) =>
  ({ type: 'userProperty', userProperty: { type: 'userAttributes', userAttributes: { attributeKey } } }) as const;

const crewMember = defineObject({
  apiName: 'CrewMember',
  displayName: 'Crew Member',
  pluralDisplayName: 'Crew Members',
  titlePropertyApiName: 'memberId',
  primaryKeyPropertyApiName: 'memberId',
  properties: {
    memberId: { type: 'string', displayName: 'Member ID' },
    userId: { type: 'string', displayName: 'User ID' },
    crewId: { type: 'string', displayName: 'Crew ID' },
  },
  editsEnabled: true,
  datasources: [
    {
      type: 'dataset',
      objectSecurityPolicy: {
        name: 'self',
        granularPolicy: {
          type: 'comparison',
          comparison: {
            left: { type: 'property', property: 'memberId' },
            operator: 'SUBSET_OF',
            right: attribute('memberIds'),
          },
        },
      },
    },
  ],
});

const crew = defineObject({
  apiName: 'Crew',
  displayName: 'Crew',
  pluralDisplayName: 'Crews',
  titlePropertyApiName: 'name',
  primaryKeyPropertyApiName: 'crewId',
  properties: {
    crewId: { type: 'string', displayName: 'Crew ID' },
    name: { type: 'string' },
  },
  editsEnabled: true,
  includeEmptyBackingDatasource: true,
});

const jobsite = defineObject({
  apiName: 'Jobsite',
  displayName: 'Jobsite',
  pluralDisplayName: 'Jobsites',
  titlePropertyApiName: 'name',
  primaryKeyPropertyApiName: 'jobsiteId',
  properties: {
    jobsiteId: { type: 'string', displayName: 'Jobsite ID' },
    name: { type: 'string' },
  },
  editsEnabled: true,
  datasources: [
    {
      type: 'dataset',
      objectSecurityPolicy: {
        name: 'crew',
        granularPolicy: {
          type: 'or',
          conditions: [
            { type: 'group', name: 'admin' },
            {
              type: 'comparison',
              comparison: {
                left: { type: 'property', property: 'jobsiteId' },
                operator: 'SUBSET_OF',
                right: attribute('jobsiteIds'),
              },
            },
          ],
        },
      },
    },
  ],
});

defineLink({
  apiName: 'crewMembers',
  one: {
    object: crew,
    metadata: { apiName: 'members', displayName: 'Member', pluralDisplayName: 'Members', visibility: 'NORMAL' },
  },
  toMany: {
    object: crewMember,
    metadata: { apiName: 'crew', displayName: 'Crew', pluralDisplayName: 'Crews', visibility: 'NORMAL' },
  },
  manyForeignKeyProperty: 'crewId',
  editsEnabled: true,
});

defineLink({
  apiName: 'crewJobsites',
  many: {
    object: crew,
    metadata: { apiName: 'jobsites', displayName: 'Jobsite', pluralDisplayName: 'Jobsites', visibility: 'NORMAL' },
  },
  toMany: {
    object: jobsite,
    metadata: { apiName: 'crews', displayName: 'Crew', pluralDisplayName: 'Crews', visibility: 'NORMAL' },
  },
});
