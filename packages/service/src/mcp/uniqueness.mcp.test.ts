import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionType, addRule, parameterValue } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import type { GrantsFile } from '../ontology/index.ts';
import { grantsOf, NS, stringProperty, twinIr, unchecked } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { now } from '../tokens.test-utils.ts';
import { connectV1, startMcpService, type McpService } from './mcp.test-utils.ts';

const INVOICE = `${NS}Invoice`;
const MEMBERSHIP = `${NS}Membership`;
const ACCOUNT = `${NS}Account`;
const CREATE_INVOICE = `${NS}create-invoice`;
const INVOICES_READ = 'invoices:read';

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'createMembership',
    inputs: ['membershipId', 'personId', 'roleId', 'teamId'].map((name) => ({ name, type: 'string' })),
    edits: [MEMBERSHIP],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Membership = { type: 'object', apiName: '${MEMBERSHIP}' };

export const functions = {
  createMembership: async (client, membershipId, personId, roleId, teamId) => {
    const batch = createEditBatch(client);
    batch.create(Membership, { membershipId, personId, roleId, teamId });
    return batch.getEdits();
  },
};
`;

type Block = OntologyIr['ontology']['objectTypes'][string];

function addProperty(block: Block, apiName: string, typeClasses: readonly object[]): void {
  block.objectType.propertyTypes[apiName] = unchecked({ ...stringProperty(apiName), typeClasses });

  const [datasource] = unchecked<{ datasource: { datasetV2: { propertyMapping: Record<string, object> } } }[]>(
    block.datasources,
  );

  if (!datasource) throw new Error(`${block.objectType.apiName} has no datasource.`);

  datasource.datasource.datasetV2.propertyMapping[apiName] = { type: 'column', column: apiName };
}

function uniquenessIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  const source = JSON.parse(
    readFileSync(new URL('../../twin/ir/uniqueness.json', import.meta.url), 'utf8'),
  ) as OntologyIr;

  const invoice = source.ontology.objectTypes[INVOICE];
  const membership = source.ontology.objectTypes[MEMBERSHIP];

  if (!invoice || !membership) throw new Error('The uniqueness IR has no Invoice or no Membership.');

  const number = unchecked<{ typeClasses: object[]; dataConstraints?: object }>(
    invoice.objectType.propertyTypes['number'],
  );

  number.typeClasses = [...number.typeClasses, { kind: 'unique', name: 'numberPerSeriesYear' }];
  number.dataConstraints = { nullabilityV2: { noNulls: true, noEmptyCollections: false } };

  addProperty(invoice, 'series', [{ kind: 'unique', name: 'numberPerSeriesYear' }]);

  const year = unchecked<{ typeClasses: object[] }>(invoice.objectType.propertyTypes['year']);

  year.typeClasses = [...year.typeClasses, { kind: 'unique', name: 'numberPerSeriesYear' }];

  addProperty(membership, 'teamId', [{ kind: 'unique', name: 'teamLead' }]);

  for (const block of [invoice, membership])
    block.entityMetadata = unchecked({ ...block.entityMetadata, arePatchesEnabled: true });

  ir.ontology.objectTypes[INVOICE] = invoice;
  ir.ontology.objectTypes[MEMBERSHIP] = membership;

  const string = {
    type: { type: 'string', string: {} },
    allowedValues: { type: 'text', text: { type: 'text', text: {} } },
    required: { type: 'notRequired', notRequired: {} },
  };

  const parameters = { invoiceId: string, number: string };

  ir.ontology.actionTypes[CREATE_INVOICE] = actionType(CREATE_INVOICE, unchecked(parameters), [
    addRule(INVOICE, { invoiceId: parameterValue('invoiceId'), number: parameterValue('number') }),
  ]);

  return ir;
}

function grantsWithHiddenInvoice(ir: OntologyIr): GrantsFile {
  const grants = grantsOf(ir);

  return {
    ...grants,
    permissions: { ...grants.permissions, [INVOICES_READ]: { description: 'Read Invoices' } },
    objectTypes: { ...grants.objectTypes, [INVOICE]: INVOICES_READ },
    actionTypes: { ...grants.actionTypes, [CREATE_INVOICE]: INVOICES_READ },
    defaultRoles: { ...grants.defaultRoles, admin: [...(grants.defaultRoles['admin'] ?? []), INVOICES_READ] },
  };
}

let service: McpService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, uniquenessIr());

  service = await startMcpService({ ir, functions, grants: grantsWithHiddenInvoice(ir) });
});

afterAll(() => service?.stop());

async function call(name: string, args: Record<string, unknown>, role = 'admin'): Promise<CallToolResult> {
  const { client } = await connectV1(service, {
    token: await service.issuer.authkit({ exp: now() + 3600, ...claimsOf(role) }),
  });

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

async function notesOf(objectType: string): Promise<unknown> {
  const result = await call('describe_object_type', { objectType });

  expect(result.isError).toBeFalsy();

  return (result.structuredContent as { notes?: unknown }).notes;
}

const textOf = (result: CallToolResult): string =>
  (result.content as { text: string }[]).map(({ text }) => text).join('');

describe('service/ontology-mcp#tools: describe_object_type gives each Uniqueness constraint', () => {
  it('service/ontology-mcp#tools: issue gives 1 line per rule in rule name order, for 1 required Property, for 3 Properties, and for 2 Properties with an optional one', async () => {
    expect(await notesOf(INVOICE)).toEqual([
      'Uniqueness constraints:',
      '- Unique: no 2 Invoices have the same `number`.',
      '- Unique: no 2 Invoices have the same `number`, `series` and `year`. An Object with no value in 1 of them never clashes.',
      '- Unique: no 2 Invoices have the same `number` and `year`. An Object with no value in 1 of them never clashes.',
    ]);
  });

  it('service/ontology-mcp#tools: issue names the Properties of a rule in API name order, and gives a rule on 1 optional Property its own sentence', async () => {
    expect(await notesOf(MEMBERSHIP)).toEqual([
      'Uniqueness constraints:',
      '- Unique: no 2 Memberships have the same `personId` and `roleId`. An Object with no value in 1 of them never clashes.',
      '- Unique: no 2 Memberships have the same `teamId`. An Object with no value in `teamId` never clashes.',
    ]);
  });

  it('service/ontology-mcp#tools: issue gives an Object Type with no rule no notes, and the answer keys of before', async () => {
    const result = await call('describe_object_type', { objectType: ACCOUNT });

    expect(Object.keys(result.structuredContent ?? {})).toEqual([
      'apiName',
      'primaryKey',
      'titleProperty',
      'properties',
      'links',
    ]);
  });

  it('service/ontology-mcp#tools: issue gives a caller who cannot see Invoice the answer of an unknown name, with no rule line', async () => {
    const hidden = await call('describe_object_type', { objectType: INVOICE }, 'member');

    const unknown = await call('describe_object_type', { objectType: `${NS}Nope` }, 'member');

    expect(hidden.isError).toBe(true);

    expect({ ...hidden.structuredContent, errorInstanceId: '' }).toEqual({
      ...unknown.structuredContent,
      errorInstanceId: '',
      parameters: { objectType: INVOICE },
    });

    expect(textOf(hidden)).not.toMatch(/Unique/);
  });
});

describe('service/ontology-mcp#errors: the tool error of apply_action for 409 PropertyValueAlreadyExists', () => {
  it('service/ontology-mcp#errors: issue a rule-backed create that clashes keeps the error body, and adds 1 sentence from the error parameters', async () => {
    const createInvoice = (invoiceId: string) =>
      call('apply_action', { action: CREATE_INVOICE, parameters: { invoiceId, number: 'N-1' } });

    expect((await createInvoice('inv-1')).isError).toBeFalsy();

    const result = await createInvoice('inv-2');

    expect(result.isError).toBe(true);

    expect(result.structuredContent).toEqual({
      errorCode: 'CONFLICT',
      errorName: 'PropertyValueAlreadyExists',
      errorInstanceId: expect.any(String),
      parameters: { objectType: INVOICE, constraint: 'invoiceNumber', properties: ['number'] },
    });

    expect(textOf(result)).toBe(
      `${JSON.stringify(result.structuredContent)}\nAnother Object of ${INVOICE} has the same \`number\`, and the error does not name it, so use other values or change that Object first.`,
    );
  });

  it('service/ontology-mcp#errors: issue a function-backed create that clashes on 2 Properties keeps the error body, and adds 1 sentence that names both', async () => {
    const createMembership = (membershipId: string, teamId: string) =>
      call('apply_action', {
        action: actionOf('createMembership'),
        parameters: { membershipId, personId: 'p-1', roleId: 'r-1', teamId },
      });

    expect((await createMembership('m-1', 't-1')).isError).toBeFalsy();

    const result = await createMembership('m-2', 't-2');

    expect(result.isError).toBe(true);

    expect(result.structuredContent).toEqual({
      errorCode: 'CONFLICT',
      errorName: 'PropertyValueAlreadyExists',
      errorInstanceId: expect.any(String),
      parameters: { objectType: MEMBERSHIP, constraint: 'onePersonPerRole', properties: ['personId', 'roleId'] },
    });

    expect(textOf(result)).toBe(
      `${JSON.stringify(result.structuredContent)}\nAnother Object of ${MEMBERSHIP} has the same \`personId\` and \`roleId\`, and the error does not name it, so use other values or change that Object first.`,
    );
  });
});
