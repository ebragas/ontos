import {
  defineObject,
  defineCreateObjectAction,
  defineDeleteObjectAction,
  defineLink,
  defineModifyObjectAction,
} from '@osdk/maker';
import { defineFunctionBackedAction } from '@osdk/maker-experimental';

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
  },
  editsEnabled: true,
  includeEmptyBackingDatasource: true,
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
    createdAt: { type: 'timestamp' },
  },
  editsEnabled: true,
  includeEmptyBackingDatasource: true,
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

defineCreateObjectAction({ objectType: account, apiName: 'create-account' });

defineCreateObjectAction({
  objectType: engagement,
  apiName: 'create-engagement',
  nonParameterMappings: {
    status: { type: 'staticValue', staticValue: { type: 'string', string: 'open' } },
    createdAt: { type: 'currentTime' },
  },
});

defineModifyObjectAction({
  objectType: engagement,
  apiName: 'set-engagement-status',
  excludedProperties: ['engagementId', 'accountId', 'title', 'amount', 'createdAt'],
});

defineDeleteObjectAction({ objectType: account, apiName: 'delete-account' });

defineDeleteObjectAction({ objectType: engagement, apiName: 'delete-engagement' });

defineFunctionBackedAction({
  functionApiName: 'closeAccount',
  apiName: 'close-account-action',
  displayName: 'Close account',
});

defineModifyObjectAction({
  objectType: account,
  apiName: 'set-account-phase',
  excludedProperties: ['accountId', 'name'],
});

defineModifyObjectAction({
  objectType: engagement,
  apiName: 'copy-account-phase',
  excludedProperties: ['engagementId', 'accountId', 'title', 'amount', 'createdAt'],
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

defineFunctionBackedAction({
  functionApiName: 'probeVersionCheck',
  apiName: 'probe-version-check-action',
  displayName: 'Probe version check',
});

const structProbe = defineObject({
  apiName: 'StructProbe',
  displayName: 'Struct Probe',
  pluralDisplayName: 'Struct Probes',
  titlePropertyApiName: 'probeId',
  primaryKeyPropertyApiName: 'probeId',
  properties: {
    probeId: { type: 'string', displayName: 'Probe ID' },
    relationship: {
      type: { type: 'struct', structDefinition: { label: 'string', since: 'date' } },
      displayName: 'Relationship',
    },
    measures: {
      type: {
        type: 'struct',
        structDefinition: { flag: 'boolean', count: 'integer', score: 'double', at: 'timestamp' },
      },
      displayName: 'Measures',
    },
  },
  editsEnabled: true,
  includeEmptyBackingDatasource: true,
});

defineCreateObjectAction({ objectType: structProbe, apiName: 'create-struct-probe' });

defineModifyObjectAction({
  objectType: structProbe,
  apiName: 'set-struct-probe-relationship',
  excludedProperties: ['probeId', 'measures'],
});

defineFunctionBackedAction({
  functionApiName: 'setRelationship',
  apiName: 'set-relationship-action',
  displayName: 'Set relationship',
});

defineDeleteObjectAction({ objectType: structProbe, apiName: 'delete-struct-probe' });
