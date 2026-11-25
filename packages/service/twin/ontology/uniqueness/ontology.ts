import { defineObject } from '@osdk/maker';

export const invoice = defineObject({
  apiName: 'Invoice',
  displayName: 'Invoice',
  pluralDisplayName: 'Invoices',
  primaryKeyPropertyApiName: 'invoiceId',
  titlePropertyApiName: 'number',
  properties: {
    invoiceId: { type: 'string' },
    number: {
      type: 'string',
      typeClasses: [
        { kind: 'unique', name: 'invoiceNumber' },
        { kind: 'unique', name: 'numberPerYear' },
      ],
    },
    year: { type: 'integer', typeClasses: [{ kind: 'unique', name: 'numberPerYear' }] },
    tags: { type: 'string', array: true },
    address: { type: { type: 'struct', structDefinition: { street: 'string', city: 'string' } } },
  },
});

export const membership = defineObject({
  apiName: 'Membership',
  displayName: 'Membership',
  pluralDisplayName: 'Memberships',
  primaryKeyPropertyApiName: 'membershipId',
  titlePropertyApiName: 'membershipId',
  properties: {
    membershipId: { type: 'string' },
    roleId: { type: 'string', typeClasses: [{ kind: 'unique', name: 'onePersonPerRole' }] },
    personId: { type: 'string', typeClasses: [{ kind: 'unique', name: 'onePersonPerRole' }] },
  },
});
