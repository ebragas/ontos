import {
  defineCreateObjectAction,
  defineLink,
  defineModifyObjectAction,
  defineObject,
  type SecurityConditionDefinition,
} from '@osdk/maker';

const attribute = (attributeKey: string) =>
  ({ type: 'userProperty', userProperty: { type: 'userAttributes', userAttributes: { attributeKey } } }) as const;

const onCrewJobsite = (property: string): SecurityConditionDefinition => ({
  type: 'or',
  conditions: [
    { type: 'group', name: 'admin' },
    {
      type: 'comparison',
      comparison: { left: { type: 'property', property }, operator: 'SUBSET_OF', right: attribute('jobsiteIds') },
    },
  ],
});

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
  includeEmptyBackingDatasource: true,
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
    budget: { type: 'double' },
  },
  editsEnabled: true,
  editsHistoryConfig: { enabled: true, storeAllPreviousProperties: true },
  datasources: [
    {
      type: 'dataset',
      objectSecurityPolicy: { name: 'crew', granularPolicy: onCrewJobsite('jobsiteId') },
      propertySecurityGroups: [
        { name: 'finance', properties: ['budget'], granularPolicy: { type: 'group', name: 'admin' } },
      ],
    },
  ],
});

const dailyLog = defineObject({
  apiName: 'DailyLog',
  displayName: 'Daily Log',
  pluralDisplayName: 'Daily Logs',
  titlePropertyApiName: 'note',
  primaryKeyPropertyApiName: 'logId',
  properties: {
    logId: { type: 'string', displayName: 'Log ID' },
    jobsiteId: { type: 'string', displayName: 'Jobsite ID' },
    note: { type: 'string' },
    hours: { type: 'double' },
    authorId: { type: 'string', displayName: 'Author ID' },
  },
  editsEnabled: true,
  editsHistoryConfig: { enabled: true, storeAllPreviousProperties: true },
  datasources: [
    { type: 'dataset', objectSecurityPolicy: { name: 'crew', granularPolicy: onCrewJobsite('jobsiteId') } },
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

defineLink({
  apiName: 'jobsiteDailyLogs',
  one: {
    object: jobsite,
    metadata: { apiName: 'dailyLogs', displayName: 'Daily Log', pluralDisplayName: 'Daily Logs', visibility: 'NORMAL' },
  },
  toMany: {
    object: dailyLog,
    metadata: { apiName: 'jobsite', displayName: 'Jobsite', pluralDisplayName: 'Jobsites', visibility: 'NORMAL' },
  },
  manyForeignKeyProperty: 'jobsiteId',
  editsEnabled: true,
});

defineCreateObjectAction({
  objectType: dailyLog,
  apiName: 'create-daily-log',
  parameterConfiguration: { authorId: { required: false, allowedValues: { type: 'user' } } },
});

defineModifyObjectAction({
  objectType: jobsite,
  apiName: 'edit-jobsite',
  excludedProperties: ['jobsiteId'],
});
