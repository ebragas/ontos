import type {
  CompiledLink,
  CompiledLinkType,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  PropertyType,
} from '../compiled/index.ts';
import { emptyOntology } from '../compiled/stored.ts';

export const INTEGER: PropertyType = { kind: 'integer' };
export const DOUBLE: PropertyType = { kind: 'double' };
export const STRING: PropertyType = { kind: 'string' };
export const BOOLEAN: PropertyType = { kind: 'boolean' };
export const DATE: PropertyType = { kind: 'date' };
export const TIMESTAMP: PropertyType = { kind: 'timestamp' };
export const decimal = (scale: number, precision = 18): PropertyType => ({ kind: 'decimal', precision, scale });

function property(apiName: string, type: PropertyType): CompiledProperty {
  return {
    apiName,
    rid: `ri.property.${apiName}`,
    status: { type: 'active' },
    display: {
      displayName: apiName,
      description: undefined,
      visibility: 'NORMAL',
      typeClasses: [],
      structFields: new Map(),
    },
    column: apiName,
    type,
    required: false,
    noEmptyCollections: false,
    searchable: false,
  };
}

type Side = Pick<CompiledLink, 'cardinality' | 'via'>;

function objectTypeOf(
  apiName: string,
  properties: Readonly<Record<string, PropertyType>>,
  links: readonly CompiledLink[],
): CompiledObjectType {
  const entries = Object.entries({ id: STRING, ...properties }).map(
    ([name, type]) => [name, property(name, type)] as const,
  );

  const map = new Map(entries);
  const primaryKey = map.get('id');

  if (!primaryKey) throw new Error('The fixture has no primary key.');

  return {
    apiName,
    rid: `ri.object-type.${apiName}`,
    status: 'active',
    display: {
      displayName: apiName,
      pluralDisplayName: apiName,
      description: undefined,
      icon: { color: '#000000', locator: 'cube' },
      visibility: 'NORMAL',
    },
    table: apiName.toLowerCase(),
    primaryKey,
    titleKey: 'id',
    properties: map,
    derived: new Map(),
    links: new Map(links.map((link) => [link.apiName, link])),
    joinTables: [],
    uniqueness: [],
  };
}

const link = (linkType: string, apiName: string, target: string, side: Side): CompiledLink => ({
  apiName,
  displayName: apiName,
  linkType,
  target,
  ...side,
});

function oneToMany(apiName: string, one: { type: string; side: string }, many: { type: string; side: string }) {
  const linkType: CompiledLinkType = {
    apiName,
    rid: `ri.link-type.${apiName}`,
    status: 'active',
    storage: {
      kind: 'foreignKey',
      manySide: many.type,
      property: property(`${apiName}Key`, STRING),
      oneSide: one.type,
      table: many.type.toLowerCase(),
    },
  };

  return {
    linkType,
    onOne: link(apiName, one.side, many.type, {
      cardinality: 'MANY',
      via: { kind: 'foreignKeyOnTarget', column: `${apiName}Key` },
    }),
    onMany: link(apiName, many.side, one.type, {
      cardinality: 'ONE',
      via: { kind: 'foreignKeyHere', column: `${apiName}Key` },
    }),
  };
}

function manyToMany(apiName: string, a: { type: string; side: string }, b: { type: string; side: string }) {
  const linkType: CompiledLinkType = {
    apiName,
    rid: `ri.link-type.${apiName}`,
    status: 'active',
    storage: {
      kind: 'joinTable',
      table: `${apiName}_links`,
      a: { objectType: a.type, column: 'a_id' },
      b: { objectType: b.type, column: 'b_id' },
    },
  };

  return {
    linkType,
    onA: link(apiName, a.side, b.type, {
      cardinality: 'MANY',
      via: { kind: 'joinTable', table: `${apiName}_links`, sourceColumn: 'a_id', targetColumn: 'b_id' },
    }),
    onB: link(apiName, b.side, a.type, {
      cardinality: 'MANY',
      via: { kind: 'joinTable', table: `${apiName}_links`, sourceColumn: 'b_id', targetColumn: 'a_id' },
    }),
  };
}

const accountTransactions = oneToMany(
  'accountTransactions',
  { type: 'Account', side: 'transactions' },
  { type: 'Transaction', side: 'account' },
);

const categoryTransactions = oneToMany(
  'categoryTransactions',
  { type: 'Category', side: 'transactions' },
  { type: 'Transaction', side: 'category' },
);

const accountEngagements = oneToMany(
  'accountEngagements',
  { type: 'Account', side: 'engagements' },
  { type: 'Engagement', side: 'account' },
);

const engagementInvoices = oneToMany(
  'engagementInvoices',
  { type: 'Engagement', side: 'invoices' },
  { type: 'Invoice', side: 'engagement' },
);

const flightToPassengersLink = oneToMany(
  'flightToPassengersLink',
  { type: 'Flight', side: 'passengersFromFlight' },
  { type: 'Passenger', side: 'flightFromPassengers' },
);

const personReports = oneToMany(
  'personReports',
  { type: 'Person', side: 'reports' },
  { type: 'Person', side: 'manager' },
);

const personFriends = manyToMany(
  'personFriends',
  { type: 'Person', side: 'friends' },
  { type: 'Person', side: 'friendOf' },
);

const accountPartners = manyToMany(
  'accountPartners',
  { type: 'Account', side: 'partners' },
  { type: 'Engagement', side: 'partnerAccounts' },
);

const linkTypes = [
  accountTransactions,
  categoryTransactions,
  accountEngagements,
  engagementInvoices,
  flightToPassengersLink,
  personReports,
  personFriends,
  accountPartners,
];

const objectTypes = [
  objectTypeOf('Account', { name: STRING, budget: decimal(2) }, [
    accountTransactions.onOne,
    accountEngagements.onOne,
    accountPartners.onA,
  ]),
  objectTypeOf(
    'Transaction',
    {
      amount: decimal(2),
      status: STRING,
      quantity: INTEGER,
      ratio: DOUBLE,
      active: BOOLEAN,
      day: DATE,
      postedAt: TIMESTAMP,
      rate: decimal(4),
      tags: { kind: 'array', element: { kind: 'string' } },
    },
    [accountTransactions.onMany, categoryTransactions.onMany],
  ),
  objectTypeOf('Category', { name: STRING }, [categoryTransactions.onOne]),
  objectTypeOf('Engagement', { name: STRING }, [
    accountEngagements.onMany,
    engagementInvoices.onOne,
    accountPartners.onB,
  ]),
  objectTypeOf('Invoice', { total: decimal(2) }, [engagementInvoices.onMany]),
  objectTypeOf('Flight', { code: STRING }, [flightToPassengersLink.onOne]),
  objectTypeOf('Passenger', { name: STRING }, [flightToPassengersLink.onMany]),
  objectTypeOf('Person', { name: STRING }, [
    personReports.onOne,
    personReports.onMany,
    personFriends.onA,
    personFriends.onB,
  ]),
];

export const ONTOLOGY: CompiledOntology = {
  ...emptyOntology('ri.product.derived'),
  objectTypes: new Map(objectTypes.map((objectType) => [objectType.apiName, objectType])),
  linkTypes: new Map(linkTypes.map(({ linkType }) => [linkType.apiName, linkType])),
};

export function objectTypeNamed(apiName: string): CompiledObjectType {
  const found = ONTOLOGY.objectTypes.get(apiName);

  if (!found) throw new Error(`The fixture has no Object Type ${apiName}.`);

  return found;
}

export function linkTypeNamed(apiName: string): CompiledLinkType {
  const found = ONTOLOGY.linkTypes.get(apiName);

  if (!found) throw new Error(`The fixture has no Link Type ${apiName}.`);

  return found;
}
