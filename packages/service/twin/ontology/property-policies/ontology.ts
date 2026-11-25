import { defineLink, defineModifyObjectAction, defineObject } from '@osdk/maker';

const userId = { type: 'userProperty', userProperty: { type: 'userId', userId: {} } } as const;

const account = defineObject({
  apiName: 'Account',
  displayName: 'Account',
  pluralDisplayName: 'Accounts',
  titlePropertyApiName: 'name',
  primaryKeyPropertyApiName: 'accountId',
  properties: {
    accountId: { type: 'string', displayName: 'Account ID' },
    name: { type: 'string', nullability: { noNulls: true, noEmptyCollections: false } },
    phase: { type: 'string' },
    region: { type: 'string' },
    rate: { type: 'double' },
    profile: { type: { type: 'struct', structDefinition: { label: 'string', since: 'date' } } },
    ownerId: { type: 'string', displayName: 'Owner ID' },
    readers: { type: 'string', array: true },
    tags: { type: 'string', array: true },
    notes: { type: 'string', array: true },
    score: { type: 'integer' },
    cost: { type: { type: 'decimal', precision: 10, scale: 2 } },
    startDate: { type: 'date' },
    seenAt: { type: 'timestamp' },
    active: { type: 'boolean' },
  },
  editsEnabled: true,
  datasources: [
    {
      type: 'dataset',
      propertySecurityGroups: [
        {
          name: 'pay',
          properties: ['name', 'phase', 'region', 'rate', 'profile'],
          granularPolicy: {
            type: 'or',
            conditions: [
              { type: 'group', name: 'admin' },
              {
                type: 'comparison',
                comparison: { left: { type: 'property', property: 'ownerId' }, operator: 'EQUAL', right: userId },
              },
              {
                type: 'comparison',
                comparison: { left: userId, operator: 'SUBSET_OF', right: { type: 'property', property: 'readers' } },
              },
            ],
          },
        },
        {
          name: 'ops',
          properties: ['notes', 'score', 'cost', 'startDate', 'seenAt', 'active'],
          granularPolicy: {
            type: 'or',
            conditions: [
              { type: 'group', name: 'admin' },
              { type: 'group', name: 'auditor' },
            ],
          },
        },
        { name: 'plain', properties: ['tags'] },
      ],
    },
  ],
});

const engagement = defineObject({
  apiName: 'Engagement',
  displayName: 'Engagement',
  pluralDisplayName: 'Engagements',
  titlePropertyApiName: 'title',
  primaryKeyPropertyApiName: 'engagementId',
  properties: {
    engagementId: { type: 'string', displayName: 'Engagement ID' },
    accountId: { type: 'string', displayName: 'Account ID' },
    title: { type: 'string', nullability: { noNulls: true, noEmptyCollections: false } },
    amount: { type: 'double' },
    status: { type: 'string' },
  },
  editsEnabled: true,
  datasources: [
    {
      type: 'dataset',
      objectSecurityPolicy: {
        name: 'staff',
        granularPolicy: {
          type: 'or',
          conditions: [
            { type: 'group', name: 'admin' },
            { type: 'group', name: 'member' },
          ],
        },
      },
      propertySecurityGroups: [
        {
          name: 'deal',
          properties: ['accountId', 'amount'],
          granularPolicy: {
            type: 'or',
            conditions: [
              { type: 'group', name: 'admin' },
              { type: 'group', name: 'guest' },
            ],
          },
        },
      ],
    },
  ],
});

defineLink({
  apiName: 'accountToEngagements',
  one: {
    object: account,
    metadata: {
      apiName: 'engagements',
      displayName: 'Engagement',
      pluralDisplayName: 'Engagements',
      visibility: 'NORMAL',
    },
  },
  toMany: {
    object: engagement,
    metadata: { apiName: 'account', displayName: 'Account', pluralDisplayName: 'Accounts', visibility: 'NORMAL' },
  },
  manyForeignKeyProperty: 'accountId',
  editsEnabled: true,
});

defineModifyObjectAction({
  objectType: account,
  apiName: 'set-account-phase',
  excludedProperties: [
    'accountId',
    'name',
    'region',
    'rate',
    'profile',
    'ownerId',
    'readers',
    'tags',
    'notes',
    'score',
    'cost',
    'startDate',
    'seenAt',
    'active',
  ],
});

defineModifyObjectAction({
  objectType: engagement,
  apiName: 'copy-account-phase',
  excludedProperties: ['engagementId', 'accountId', 'title', 'amount'],
  parameterConfiguration: {
    account: {
      displayName: 'Account',
      required: true,
      customParameterType: { type: 'objectReference', objectReference: { objectTypeId: account.apiName } },
    },
  },
  nonParameterMappings: {
    status: {
      type: 'objectParameterPropertyValue',
      objectParameterPropertyValue: { parameterId: 'account', propertyTypeId: 'phase' },
    },
  },
});
