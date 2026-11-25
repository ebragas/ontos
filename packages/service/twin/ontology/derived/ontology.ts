import { defineLink, defineObject } from '@osdk/maker';

const link = (apiName: string, one: string, oneSide: string, many: string, manySide: string, foreignKey: string) =>
  defineLink({
    apiName,
    one: {
      object: `com.example.twin.${one}`,
      metadata: { apiName: oneSide, displayName: oneSide, pluralDisplayName: oneSide, visibility: 'NORMAL' },
    },
    toMany: {
      object: `com.example.twin.${many}`,
      metadata: { apiName: manySide, displayName: manySide, pluralDisplayName: manySide, visibility: 'NORMAL' },
    },
    manyForeignKeyProperty: foreignKey,
    editsEnabled: true,
  });

const accountTransactions = link(
  'accountTransactions',
  'Account',
  'transactions',
  'Transaction',
  'account',
  'accountId',
);

const categoryTransactions = link(
  'categoryTransactions',
  'Category',
  'transactions',
  'Transaction',
  'category',
  'categoryId',
);

const accountEngagements = link('accountEngagements', 'Account', 'engagements', 'Engagement', 'account', 'accountId');

const engagementInvoices = link(
  'engagementInvoices',
  'Engagement',
  'invoices',
  'Invoice',
  'engagement',
  'engagementId',
);

const roleAssignments = link('roleAssignments', 'Role', 'assignments', 'RoleAssignment', 'role', 'roleId');

const money = { type: { type: 'decimal', precision: 14, scale: 2 } } as const;

const account = defineObject({
  apiName: 'Account',
  displayName: 'Account',
  pluralDisplayName: 'Accounts',
  titlePropertyApiName: 'name',
  primaryKeyPropertyApiName: 'accountId',
  properties: {
    accountId: { type: 'string' },
    name: { type: 'string' },
    entity: { type: 'string' },
    balance: { ...money, displayName: 'Balance' },
  },
  editsEnabled: true,
  datasources: [{ type: 'dataset' }],
});

defineObject({
  apiName: 'Category',
  displayName: 'Category',
  pluralDisplayName: 'Categories',
  titlePropertyApiName: 'name',
  primaryKeyPropertyApiName: 'categoryId',
  properties: {
    categoryId: { type: 'string' },
    name: { type: 'string' },
    entity: { type: 'string' },
  },
  editsEnabled: true,
  includeEmptyBackingDatasource: true,
});

defineObject({
  apiName: 'Transaction',
  displayName: 'Transaction',
  pluralDisplayName: 'Transactions',
  titlePropertyApiName: 'transactionId',
  primaryKeyPropertyApiName: 'transactionId',
  properties: {
    transactionId: { type: 'string' },
    accountId: { type: 'string' },
    categoryId: { type: 'string' },
    amount: money,
    categoryEntity: { type: 'string' },
    accountEntity: { type: 'string' },
  },
  editsEnabled: true,
  datasources: [
    { type: 'dataset' },
    {
      type: 'derived',
      linkDefinition: [{ linkType: categoryTransactions }],
      propertyMapping: { categoryEntity: 'entity' },
    },
    {
      type: 'derived',
      linkDefinition: [{ linkType: accountTransactions }],
      propertyMapping: { accountEntity: 'entity' },
    },
  ],
});

account.datasources?.push({
  type: 'derived',
  linkDefinition: [{ linkType: accountTransactions }],
  propertyMapping: { balance: { type: 'sum', property: 'amount' } },
});

defineObject({
  apiName: 'Engagement',
  displayName: 'Engagement',
  pluralDisplayName: 'Engagements',
  titlePropertyApiName: 'title',
  primaryKeyPropertyApiName: 'engagementId',
  properties: {
    engagementId: { type: 'string' },
    accountId: { type: 'string' },
    title: { type: 'string' },
    invoiceCount: { type: 'integer' },
  },
  editsEnabled: true,
  datasources: [
    { type: 'dataset' },
    {
      type: 'derived',
      linkDefinition: [{ linkType: engagementInvoices }],
      propertyMapping: { invoiceCount: { type: 'count' } },
    },
  ],
});

defineObject({
  apiName: 'Invoice',
  displayName: 'Invoice',
  pluralDisplayName: 'Invoices',
  titlePropertyApiName: 'invoiceId',
  primaryKeyPropertyApiName: 'invoiceId',
  properties: {
    invoiceId: { type: 'string' },
    engagementId: { type: 'string' },
    total: money,
    invoiceAccount: { type: 'string' },
  },
  editsEnabled: true,
  datasources: [
    { type: 'dataset' },
    {
      type: 'derived',
      linkDefinition: [{ linkType: engagementInvoices }, { linkType: accountEngagements }],
      propertyMapping: { invoiceAccount: 'name' },
    },
  ],
});

defineObject({
  apiName: 'Role',
  displayName: 'Role',
  pluralDisplayName: 'Roles',
  titlePropertyApiName: 'name',
  primaryKeyPropertyApiName: 'roleId',
  properties: {
    roleId: { type: 'string' },
    name: { type: 'string' },
    assignmentCount: { type: 'integer' },
  },
  editsEnabled: true,
  datasources: [
    { type: 'dataset' },
    {
      type: 'derived',
      linkDefinition: [{ linkType: roleAssignments }],
      propertyMapping: { assignmentCount: { type: 'count' } },
    },
  ],
});

defineObject({
  apiName: 'RoleAssignment',
  displayName: 'Role assignment',
  pluralDisplayName: 'Role assignments',
  titlePropertyApiName: 'assignmentId',
  primaryKeyPropertyApiName: 'assignmentId',
  properties: {
    assignmentId: { type: 'string' },
    roleId: { type: 'string' },
    person: { type: 'string' },
  },
  editsEnabled: true,
  includeEmptyBackingDatasource: true,
});
