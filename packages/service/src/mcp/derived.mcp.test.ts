import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { insertObjects } from '../actions/actions.test-utils.ts';
import {
  ACCOUNT,
  CATEGORY,
  INVOICE,
  ROLE_ASSIGNMENT,
  ROLES,
  TRANSACTION,
  derivedIr,
} from '../objectSets/derived.test-utils.ts';
import { ONTOLOGY_RID } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { groupGrants } from '../policiesPeople.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { connectV1, mcpSettings, startMcpService, type McpService } from './mcp.test-utils.ts';

const TOOLS = 'service/ontology-mcp#tools';
const IR = derivedIr();
const GRANTS = groupGrants(IR, ROLES);

const CATEGORY_ADMIN_ONLY = {
  ...GRANTS,
  objectTypes: { ...GRANTS.objectTypes, [CATEGORY]: 'admin', [ROLE_ASSIGNMENT]: 'admin' },
};

let service: McpService;
let loadDerivedOn: McpService;
let admin: string;
let member: string;

beforeAll(async () => {
  service = await startMcpService({ ir: IR, grants: CATEGORY_ADMIN_ONLY });

  const baseUrl = await service.serve({ ...mcpSettings, loadDerivedProperties: true });

  loadDerivedOn = { ...service, baseUrl, url: new URL('/api/mcp', baseUrl) };

  admin = await service.issuer.authkit({ exp: now() + 3600, ...claimsOf('admin') });

  member = await service.issuer.authkit({ exp: now() + 3600, ...claimsOf('member') });

  await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-1', name: 'Acme', entity: 'E1' }]);

  await insertObjects(service.db, TRANSACTION, [
    { transactionId: 'tx-1', accountId: 'acc-1', amount: '100.00', owner: 'user_two', amountViewer: 'user_two' },
    { transactionId: 'tx-2', accountId: 'acc-1', amount: '20.50', owner: 'user_two', amountViewer: 'user_two' },
  ]);
});

afterAll(() => service?.stop());

async function call(
  name: string,
  args: Record<string, unknown>,
  token: string,
  on: McpService = service,
): Promise<CallToolResult> {
  const { client } = await connectV1(on, { token });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

async function route(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${service.baseUrl}/api/v2/ontologies/${ONTOLOGY_RID}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await service.issuer.workos({ exp: now() + 3600, ...claimsOf('admin') })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(200);

  return response.json();
}

type Entry = { notes?: string[] };

async function propertiesOf(objectType: string, token: string): Promise<Record<string, Entry>> {
  const result = await call('describe_object_type', { objectType }, token);

  expect(result.isError).toBeFalsy();

  return (result.structuredContent as { properties: Record<string, Entry> }).properties;
}

const SEEN = 'It counts only the Objects that you can see.';
const HIDDEN = 'Derived. It reads Objects that you cannot see.';

describe(`${TOOLS}: describe_object_type gives each derived property with a Derived: line`, () => {
  it(`${TOOLS}: each derived property of Account gives its definition in plain words and the sentence that it counts only the Objects that the caller can see`, async () => {
    const properties = await propertiesOf(ACCOUNT, admin);

    const of = 'of the Transactions of `transactions`.';

    expect(properties['balance']?.notes).toEqual([`Derived: the sum of \`amount\` ${of} ${SEEN}`]);
    expect(properties['transactionCount']?.notes).toEqual([`Derived: the count ${of} ${SEEN}`]);
    expect(properties['averageAmount']?.notes).toEqual([`Derived: the average of \`amount\` ${of} ${SEEN}`]);
    expect(properties['firstPostedOn']?.notes).toEqual([`Derived: the minimum of \`postedOn\` ${of} ${SEEN}`]);
    expect(properties['lastPostedOn']?.notes).toEqual([`Derived: the maximum of \`postedOn\` ${of} ${SEEN}`]);

    expect(properties['categoryCount']?.notes).toEqual([
      `Derived: the count of distinct values of \`categoryId\` ${of} ${SEEN}`,
    ]);

    expect(properties['categoryEstimate']?.notes).toEqual([
      `Derived: the approximate count of distinct values of \`categoryId\` ${of} ${SEEN}`,
    ]);

    expect(properties['transactionIds']?.notes).toEqual([
      `Derived: the list of at most 2 values of \`transactionId\` ${of} ${SEEN}`,
    ]);

    expect(properties['categoryIds']?.notes).toEqual([
      `Derived: the set of at most 5 distinct values of \`categoryId\` ${of} ${SEEN}`,
    ]);

    expect(properties['name']?.notes).toBeUndefined();
  });

  it(`${TOOLS}: a get over 2 hops names each Link side in order`, async () => {
    const properties = await propertiesOf(INVOICE, admin);

    expect(properties['invoiceAccount']?.notes).toEqual([
      `Derived: the \`name\` of the Account of \`engagement\`, then \`account\`. ${SEEN}`,
    ]);
  });

  it(`${TOOLS}: for a caller who cannot see a hop, the line says that the Property reads Objects that the caller cannot see, and names nothing of the hidden hop`, async () => {
    const seen = await propertiesOf(TRANSACTION, admin);

    expect(seen['categoryEntity']?.notes).toEqual([`Derived: the \`entity\` of the Category of \`category\`. ${SEEN}`]);

    const restricted = await propertiesOf(TRANSACTION, member);

    expect(restricted['categoryEntity']).toEqual({ dataType: { type: 'string' }, required: false, notes: [HIDDEN] });
    expect(JSON.stringify(restricted)).not.toMatch(/Categor|`category`/);

    expect(restricted['accountEntity']?.notes).toEqual([
      `Derived: the \`entity\` of the Account of \`account\`. ${SEEN}`,
    ]);
  });
});

describe(`${TOOLS}: load_objects sends loadOntologyDefinedDerivedProperties false`, () => {
  const objectSet = {
    type: 'filter',
    objectSet: { type: 'base', objectType: 'Account' },
    where: { type: 'eq', field: 'accountId', value: 'acc-1' },
  };

  it(`${TOOLS}: with the deployment setting on, a call with no select gives no derived value`, async () => {
    const result = await call('load_objects', { objectSet }, admin, loadDerivedOn);

    expect(result.isError).toBeFalsy();

    const [object] = (result.structuredContent as { data: Record<string, unknown>[] }).data;

    expect(object).toMatchObject({ accountId: 'acc-1', name: 'Acme' });
    expect(object).not.toHaveProperty('balance');
  });

  it(`${TOOLS}: with the deployment setting on, an agent flag of true gives no derived value either`, async () => {
    const result = await call(
      'load_objects',
      { objectSet, loadOntologyDefinedDerivedProperties: true },
      admin,
      loadDerivedOn,
    );

    expect((result.structuredContent as { data: Record<string, unknown>[] }).data[0]).not.toHaveProperty('balance');
  });

  it(`${TOOLS}: a call whose select names a derived property gives it`, async () => {
    const result = await call('load_objects', { objectSet, select: ['accountId', 'balance'] }, admin, loadDerivedOn);

    expect((result.structuredContent as { data: Record<string, unknown>[] }).data).toEqual([
      expect.objectContaining({ __primaryKey: 'acc-1', accountId: 'acc-1', balance: '120.50' }),
    ]);
  });

  it(`${TOOLS}: the load_objects description says that a derived Property is returned only when select names it`, async () => {
    const { client } = await connectV1(service, { token: admin });

    try {
      const { tools } = await client.listTools();

      expect(tools.find((tool) => tool.name === 'load_objects')?.description).toContain(
        'A derived Property is returned only when `select` names it.',
      );
    } finally {
      await client.close();
    }
  });
});

describe(`${TOOLS}: load_objects and aggregate_objects pass a withProperties member to the route unchanged`, () => {
  const count = {
    type: 'selection',
    objectSet: { type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'transactions' },
    operation: { type: 'count' },
  };

  const withProperties = (objectType: string) => ({
    type: 'withProperties',
    objectSet: { type: 'base', objectType },
    derivedProperties: { n: count },
  });

  it(`${TOOLS}: load_objects with a withProperties set, and a short name in its base, gives the answer of the route`, async () => {
    const result = await call(
      'load_objects',
      { objectSet: withProperties('Account'), select: ['accountId', 'n'] },
      admin,
    );

    expect(result.isError).toBeFalsy();

    const expected = await route('/objectSets/loadObjects', {
      objectSet: withProperties(ACCOUNT),
      select: ['accountId', 'n'],
      pageSize: 50,
    });

    expect(result.structuredContent).toEqual(expected);

    expect(expected).toEqual({
      data: [
        {
          __apiName: ACCOUNT,
          __primaryKey: 'acc-1',
          __rid: 'ri.phonograph2-objects.main.object.8d7bec66-1177-57d5-8311-9617d1f43aa2',
          accountId: 'acc-1',
          n: 2,
        },
      ],
      objectSetEntities: { objectTypeApiNames: [ACCOUNT] },
      propertySecurities: [],
      totalCount: '1',
    });
  });

  it(`${TOOLS}: aggregate_objects with a withProperties set gives the answer of the route`, async () => {
    const aggregation = [{ type: 'sum', field: 'n', name: 'total' }];

    const result = await call('aggregate_objects', { objectSet: withProperties('Account'), aggregation }, admin);

    expect(result.isError).toBeFalsy();

    const expected = await route('/objectSets/aggregate', { objectSet: withProperties(ACCOUNT), aggregation });

    expect(result.structuredContent).toEqual(expected);
    expect(expected).toEqual({ accuracy: 'ACCURATE', data: [{ group: {}, metrics: [{ name: 'total', value: 2 }] }] });
  });
});
