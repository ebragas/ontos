import type { DiscoveredFunction, PublishedFunctions } from '../publish/index.ts';
import type { GrantsFile } from '../ontology/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { bundle } from '../functions/functions.test-utils.ts';
import { NS, ONTOLOGY_RID, propertyPoliciesIr, USE } from '../ontology/stored.test-utils.ts';
import { groupGrants, policyPeople, PROPERTY_ROLES } from '../policiesPeople.test-utils.ts';
import { insertObjects, type ActionsService, type SendOptions } from './actions.test-utils.ts';
import { functions as APP_FUNCTIONS } from './queryApp/index.fixture.ts';

export const ACCOUNT = `${NS}Account`;
export const ENGAGEMENT = `${NS}Engagement`;
export const QUERY_IR = propertyPoliciesIr();

const string = { type: 'string', string: {} };
const decimal = { type: 'decimal', decimal: {} };
const date = { type: 'date', date: {} };
const integer = { type: 'integer', integer: {} };
const boolean = { type: 'boolean', boolean: {} };
const objectOf = (objectTypeId: string) => ({ type: 'object', object: { objectTypeId } });
const list = (elementsType: object) => ({ type: 'list', list: { elementsType } });
const optional = (wrappedType: object) => ({ type: 'optionalType', optionalType: { wrappedType } });
const struct = (fields: Record<string, object>) => ({ type: 'anonymousCustomType', anonymousCustomType: { fields } });

function query(functionName: string, output: object, inputs: Record<string, object> = {}): DiscoveredFunction {
  return {
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [
      { name: 'client', dataType: { type: 'client', client: {} } },
      ...Object.entries(inputs).map(([name, input]) =>
        'dataType' in input ? { name, ...input } : { name, dataType: input },
      ),
    ],
    output: { type: 'single', single: { dataType: output } },
    customTypes: {},
    documentation: `The Query Function ${functionName}.`,
  } as DiscoveredFunction;
}

const QUERIES: DiscoveredFunction[] = [
  query('scenarioComparison', list(struct({ days: integer, balance: decimal, runwayDate: optional(date) })), {
    balance: decimal,
  }),
  query('orderComparison', struct({ cheaper: string, first: decimal, second: decimal, same: boolean }), {
    first: decimal,
    second: decimal,
  }),
  query(
    'scenarioChart',
    struct({
      label: string,
      thirty: list(struct({ day: date, balance: decimal })),
      sixty: list(struct({ day: date, balance: decimal })),
    }),
  ),
  query('requiredPayments', list(struct({ account: objectOf(ACCOUNT), amount: decimal, due: date }))),
  query(
    'feedAccountCheck',
    struct({ balance: decimal, limit: decimal, warnings: list(string), note: optional(string) }),
    { account: objectOf(ACCOUNT) },
  ),
  query('classificationSuggestion', objectOf(ACCOUNT), { accountId: string }),
  query('amountLeft', optional(decimal), { budget: optional(decimal) }),
  query('readAccount', string, { accountId: string }),
  query('readEngagement', optional(objectOf(ENGAGEMENT)), { engagementId: string }),
  query('engagementTitle', string, { engagement: objectOf(ENGAGEMENT) }),
  query('readTwice', string, { accountId: string }),
  query('secretSummary', string),
  query('tryEdit', string, { ontology: string, accountId: string }),
  query('callRun', string, { ontology: string }),
  query('echo', string, { text: string }),
  query('wrongOutput', string, { text: string }),
  query('extraField', struct({ label: string })),
  query('appVersion', string),
  query('pickPhase', string, {
    phase: { dataType: string, allowedValues: ['customer', 'prospect'] },
    tags: list(string),
  }),
  query('accountCount', string, { accounts: list(objectOf(ACCOUNT)) }),
  query('refuse', string, { text: string }),
  query('fail', string, { text: string }),
  query('failWithAccount', string, { accountId: string, userFacing: boolean }),
  query('loopForever', string),
  query('fillHeap', string),
];

const EDIT_FUNCTION = {
  locator: { type: 'typescript', typescript: { functionName: 'editAccount' } },
  inputs: [{ name: 'client', dataType: { type: 'client', client: {} } }],
  output: { type: 'single', single: { dataType: list({ type: 'ontologyEdit', ontologyEdit: {} }) } },
  customTypes: {},
  ontologyProvenance: { editedObjects: { [ACCOUNT]: {} }, editedLinks: {}, editedInterfaces: {} },
} as DiscoveredFunction;

const APP = './packages/service/src/actions/queryApp/index.fixture.ts';

export async function queryFunctions(version: 1 | 2): Promise<PublishedFunctions> {
  const source =
    version === 1
      ? `export { functions } from '${APP}';`
      : `import { functions as app } from '${APP}';\nexport const functions = { ...app, appVersion: async () => '2' };`;

  return { discovered: [...QUERIES, EDIT_FUNCTION], bundle: await bundle(source) };
}

const ROLES = {
  ...PROPERTY_ROLES,
  admin: [...PROPERTY_ROLES.admin, 'twin:deals'],
  member: [...PROPERTY_ROLES.member, 'twin:deals'],
  guest: [...PROPERTY_ROLES.guest, 'twin:deals'],
};

const CUSTOM_ROLE = 'auditor';

export const QUERY_GRANTS: GrantsFile = (() => {
  const grants = groupGrants(QUERY_IR, ROLES);

  return {
    ...grants,
    objectTypes: { ...grants.objectTypes, [ENGAGEMENT]: 'twin:deals' },
    defaultRoles: Object.fromEntries(Object.entries(grants.defaultRoles).filter(([role]) => role !== CUSTOM_ROLE)),
    queryTypes: Object.fromEntries(
      Object.keys(APP_FUNCTIONS).map((name) => [name, name === 'secretSummary' ? 'admin' : USE]),
    ),
  };
})();

export const QUERY_PEOPLE = policyPeople(
  {
    admin: { sub: 'user_admin', role: 'admin' },
    ann: { sub: 'user_ann', role: 'member' },
    gus: { sub: 'user_gus', role: 'guest' },
    ada: { sub: 'user_ada', role: 'auditor' },
  },
  ROLES,
);

export type QueryPerson = keyof typeof QUERY_PEOPLE;

export async function insertQueryObjects(db: Db): Promise<void> {
  const account = (accountId: string, ownerId: string, phase: string, cost: string) => ({
    accountId,
    name: `Name ${accountId}`,
    phase,
    region: 'west',
    rate: 10,
    ownerId,
    readers: [],
    tags: [],
    cost,
  });

  await insertObjects(db, ACCOUNT, [
    account('acc-1', 'user_ann', 'customer', '1200.50'),
    account('acc-2', 'user_carl', 'prospect', '99.99'),
    account('acc-3', 'user_carl', 'prospect', '7.00'),
  ]);

  await insertObjects(db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'Discovery workshop', amount: 100, status: 'open' },
  ]);
}

export interface RunAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export async function runQuery(
  service: ActionsService,
  name: string,
  body: unknown,
  person: QueryPerson = 'admin',
  search = '',
  options: SendOptions = {},
): Promise<RunAnswer> {
  const { status, text } = await service.call(
    'POST',
    `/api/v2/ontologies/${ONTOLOGY_RID}/queries/${name}/execute${search}`,
    body,
    { ...QUERY_PEOPLE[person], ...options },
  );

  return { status, text, body: JSON.parse(text) as unknown };
}
