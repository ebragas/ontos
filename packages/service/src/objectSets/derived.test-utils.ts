import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import { NS } from '../actions/actions.test-utils.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import { policyPeople } from '../policiesPeople.test-utils.ts';

export const ACCOUNT = `${NS}Account`;
export const TRANSACTION = `${NS}Transaction`;
export const CATEGORY = `${NS}Category`;
export const ENGAGEMENT = `${NS}Engagement`;
export const INVOICE = `${NS}Invoice`;
export const ROLE = `${NS}Role`;
export const ROLE_ASSIGNMENT = `${NS}RoleAssignment`;
export const ONTOLOGY = '/api/v2/ontologies/ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01';

export const ROLES = { admin: ['ontology:install', USE, 'admin'], member: [USE, 'member'] } as const;

export const PEOPLE = policyPeople(
  { one: { sub: 'user_one', role: 'admin' }, two: { sub: 'user_two', role: 'member' } },
  ROLES,
);

export type Person = keyof typeof PEOPLE;

export type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function at(value: unknown, ...path: string[]): Json {
  let current = value;

  for (const key of path) current = isRecord(current) ? current[key] : undefined;

  if (!isRecord(current)) throw new Error(`The derived IR has no object at ${path.join('.')}.`);

  return current;
}

export function datasourceOf(block: Json, type: string): Json {
  const entry = (block['datasources'] as unknown[]).find((each) => at(each, 'datasource')['type'] === type);

  return at(entry, 'datasource', type);
}

export function addString(block: Json, apiName: string): void {
  const types = at(block, 'objectType', 'propertyTypes');

  const copied = structuredClone(
    at(types, Object.keys(types).find((name) => at(types, name, 'type')['type'] === 'string') ?? ''),
  );

  types[apiName] = { ...copied, apiName, displayMetadata: { displayName: apiName, visibility: 'NORMAL' } };

  at(datasourceOf(block, 'datasetV2'), 'propertyMapping')[apiName] = { type: 'column', column: apiName };
}

export function addTyped(block: Json, apiName: string, type: Json, template: Json): void {
  at(block, 'objectType', 'propertyTypes')[apiName] = {
    ...structuredClone(template),
    apiName,
    displayMetadata: { displayName: apiName, visibility: 'NORMAL' },
    type,
  };
}

const ADMIN = {
  type: 'comparison',
  comparison: {
    operator: 'INTERSECTS',
    left: { type: 'userProperty', userProperty: { type: 'groupIds', groupIds: {} } },
    right: { type: 'constant', constant: { type: 'strings', strings: ['admin'] } },
  },
};

const isCaller = (property: string) => ({
  type: 'comparison',
  comparison: {
    left: { type: 'property', property },
    operator: 'EQUAL',
    right: { type: 'userProperty', userProperty: { type: 'userId', userId: {} } },
  },
});

function group(rid: string, kind: 'object' | 'property', property: string, properties: readonly string[]): Json {
  return {
    rid,
    security: {
      type: 'granular',
      granular: {
        viewPolicy: {
          granularPolicyCondition: { type: 'or', or: { conditions: [ADMIN, isCaller(property)] } },
          additionalMandatory: { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} },
        },
      },
    },
    type: kind === 'object' ? { type: 'primaryKey', primaryKey: {} } : { type: 'property', property: { name: rid } },
    properties,
  };
}

export function derivedIr(): OntologyIr {
  const ir = JSON.parse(readFileSync(new URL('../../twin/ir/derived.json', import.meta.url), 'utf8')) as Json;
  const block = (objectType: string) => at(ir, 'ontology', 'objectTypes', objectType);

  const account = block(ACCOUNT);
  const invoiceCount = at(block(ENGAGEMENT), 'objectType', 'propertyTypes', 'invoiceCount');

  at(account, 'objectType', 'propertyTypes')['transactionCount'] = {
    ...structuredClone(invoiceCount),
    apiName: 'transactionCount',
    displayMetadata: { displayName: 'Transaction count', visibility: 'NORMAL' },
  };

  const mapping = at(datasourceOf(account, 'derived'), 'definition', 'aggregatedProperties', 'propertyTypeMapping');

  mapping['transactionCount'] = { type: 'count', count: {} };

  const strings = {
    type: 'array',
    array: { subtype: at(account, 'objectType', 'propertyTypes', 'name', 'type'), reducers: [] },
  };

  for (const [apiName, operation, selected, limit] of [
    ['transactionIds', 'collectList', 'transactionId', 2],
    ['categoryIds', 'collectSet', 'categoryId', 5],
  ] as const) {
    at(account, 'objectType', 'propertyTypes')[apiName] = {
      ...structuredClone(invoiceCount),
      apiName,
      displayMetadata: { displayName: apiName, visibility: 'NORMAL' },
      type: strings,
    };

    mapping[apiName] = {
      type: operation,
      [operation]: { linkedProperty: { type: 'propertyType', propertyType: selected }, limit },
    };
  }

  const transaction = block(TRANSACTION);
  const amount = at(transaction, 'objectType', 'propertyTypes', 'amount');

  amount['type'] = { type: 'decimal', decimal: { precision: 18, scale: 2 } };

  for (const [apiName, kind] of [
    ['postedOn', 'date'],
    ['postedAt', 'timestamp'],
    ['units', 'integer'],
  ] as const) {
    addTyped(transaction, apiName, { type: kind, [kind]: {} }, amount);

    at(datasourceOf(transaction, 'datasetV2'), 'propertyMapping')[apiName] = { type: 'column', column: apiName };
  }

  const decimal = (precision: number) => ({ type: 'decimal', decimal: { precision, scale: 2 } });

  for (const [apiName, operation, selected, type] of [
    ['averageAmount', 'avg', 'amount', decimal(38)],
    ['minAmount', 'min', 'amount', decimal(18)],
    ['maxAmount', 'max', 'amount', decimal(18)],
    ['firstPostedOn', 'min', 'postedOn', { type: 'date', date: {} }],
    ['lastPostedOn', 'max', 'postedOn', { type: 'date', date: {} }],
    ['firstPostedAt', 'min', 'postedAt', { type: 'timestamp', timestamp: {} }],
    ['lastPostedAt', 'max', 'postedAt', { type: 'timestamp', timestamp: {} }],
    ['categoryCount', 'exactCardinality', 'categoryId', { type: 'integer', integer: {} }],
    ['categoryEstimate', 'approximateCardinality', 'categoryId', { type: 'integer', integer: {} }],
    ['unitsTotal', 'sum', 'units', { type: 'double', double: {} }],
  ] as const) {
    addTyped(account, apiName, type, invoiceCount);

    mapping[apiName] = { type: operation, [operation]: { type: 'propertyType', propertyType: selected } };
  }

  addString(transaction, 'owner');

  addString(transaction, 'amountViewer');

  datasourceOf(transaction, 'datasetV2')['propertySecurityGroups'] = {
    groups: [
      group('tx', 'object', 'owner', [
        'transactionId',
        'accountId',
        'categoryId',
        'owner',
        'amountViewer',
        'postedOn',
        'postedAt',
        'units',
      ]),
      group('money', 'property', 'amountViewer', ['amount']),
    ],
  };

  const engagement = block(ENGAGEMENT);

  addString(engagement, 'owner');

  datasourceOf(engagement, 'datasetV2')['propertySecurityGroups'] = {
    groups: [group('deal', 'object', 'owner', ['engagementId', 'accountId', 'title', 'owner'])],
  };

  return JSON.parse(JSON.stringify(ir)) as OntologyIr;
}
