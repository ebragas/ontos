import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NS, ONTOLOGY_RID, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const LINE = 'line-custom-type';

const decimal = { type: 'decimal', decimal: {} };
const optionalDecimal = { type: 'optionalType', optionalType: { wrappedType: decimal } };

const INPUTS = [
  {
    name: 'client',
    dataType: { type: 'client', client: { type: 'ontologySdkClient', ontologySdkClient: {} } },
    constraints: [],
    required: true,
  },
  { name: 'accountId', dataType: { type: 'string', string: {} }, required: true, constraints: [] },
  { name: 'rate', dataType: decimal, required: true, constraints: [] },
  { name: 'rates', dataType: { type: 'list', list: { elementsType: decimal } }, required: true, constraints: [] },
  {
    name: 'lines',
    dataType: { type: 'list', list: { elementsType: { type: 'functionCustomType', functionCustomType: LINE } } },
    required: true,
    constraints: [],
  },
  { name: 'cap', dataType: optionalDecimal, required: false, constraints: [] },
];

const CUSTOM_TYPES = {
  [LINE]: {
    id: LINE,
    fields: { lineId: { type: 'string', string: {} }, unitPrice: decimal, discount: optionalDecimal },
    fieldMetadata: { lineId: { required: true }, unitPrice: { required: true }, discount: { required: false } },
  },
};

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

export const functions = {
  priceLines: async (client, accountId, rate, rates, lines, cap) => {
    const batch = createEditBatch(client);
    batch.create(Account, { accountId, name: JSON.stringify(lines) });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions([{ apiName: 'priceLines', inputs: [], edits: [ACCOUNT] }], SOURCE);

  const discovered = functions.discovered.map((fn) =>
    fn.locator.typescript?.functionName === 'priceLines' ? { ...fn, inputs: INPUTS, customTypes: CUSTOM_TYPES } : fn,
  );

  service = await startActions(ir, { ...functions, discovered });
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const PRICE_LINES = actionOf('priceLines');

describe('the Decimal inputs that the CLI discovers', () => {
  it('ontology/functions/functions#discovery: the Action publishes, and its metadata gives each Decimal input as a decimal parameter, and the row field as a decimal field', async () => {
    const answer = await service.call('GET', `/api/v2/ontologies/${ONTOLOGY_RID}/actionTypes/${PRICE_LINES}`);

    expect(answer.status).toBe(200);

    const { parameters } = JSON.parse(answer.text) as {
      parameters: Record<string, { dataType: unknown; required: boolean }>;
    };

    const shapes = Object.fromEntries(
      Object.entries(parameters).map(([name, { dataType, required }]) => [name, { dataType, required }]),
    );

    expect(shapes).toEqual({
      accountId: { dataType: { type: 'string' }, required: true },
      rate: { dataType: { type: 'decimal' }, required: true },
      rates: { dataType: { type: 'array', subType: { type: 'decimal' } }, required: false },
      lines: {
        dataType: {
          type: 'array',
          subType: {
            type: 'struct',
            fields: [
              { name: 'lineId', fieldType: { type: 'string' }, required: true },
              { name: 'unitPrice', fieldType: { type: 'decimal' }, required: true },
              { name: 'discount', fieldType: { type: 'decimal' }, required: false },
            ],
          },
        },
        required: false,
      },
      cap: { dataType: { type: 'decimal' }, required: false },
    });
  });

  it('ontology/functions/functions#discovery: the Function gets the struct list row field sent as 12.5 as "12.5"', async () => {
    const parameters = { accountId: 'a', rate: '1', rates: [], lines: [{ lineId: 'l1', unitPrice: 12.5 }] };

    const answer = await service.apply(PRICE_LINES, {
      parameters,
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(answer.status).toBe(200);

    const rows = (await rowsOf(service.db, ACCOUNT, 'account_id')) as { name: string }[];

    expect(rows.map((row) => JSON.parse(row.name))).toEqual([[{ lineId: 'l1', unitPrice: '12.5' }]]);
  });
});
