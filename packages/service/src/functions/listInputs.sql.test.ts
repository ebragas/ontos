import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  errorAnswer,
  NS,
  rowsOf,
  startActions,
  type ActionsService,
  type Answer,
} from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'reportMembers',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'teamMembers', type: 'stringList' },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'reportAccounts',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'accounts', type: 'objectList', objectType: ACCOUNT },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'reportRate',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'rate', type: 'decimal' },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'reportRates',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'rates', type: 'decimalList' },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'defaultMembers',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'teamMembers', type: 'stringList' },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'reportRelationship',
    inputs: [
      { name: 'accountId', type: 'string' },
      {
        name: 'relationship',
        type: 'struct',
        fields: [
          { name: 'label', type: 'string', required: true },
          { name: 'since', type: 'date', required: false },
        ],
      },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'reportLine',
    inputs: [
      { name: 'accountId', type: 'string' },
      {
        name: 'line',
        type: 'struct',
        fields: [{ name: 'unitPrice', type: 'decimal', required: true, decimal: { precision: 12, scale: 4 } }],
      },
    ],
    edits: [ACCOUNT],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

function report(client, accountId, value) {
  const batch = createEditBatch(client);
  batch.create(Account, { accountId, name: JSON.stringify(value === undefined ? 'undefined' : value) });
  return batch.getEdits();
}

export const functions = {
  reportMembers: async (client, accountId, teamMembers) => report(client, accountId, teamMembers),
  reportAccounts: async (client, accountId, accounts) => report(client, accountId, accounts === undefined ? accounts : accounts.map((a) => a.$primaryKey)),
  reportRate: async (client, accountId, rate) => report(client, accountId, rate),
  reportRates: async (client, accountId, rates) => report(client, accountId, rates),
  defaultMembers: async (client, accountId, teamMembers = ['x']) => report(client, accountId, teamMembers),
  reportRelationship: async (client, accountId, relationship) => report(client, accountId, Object.hasOwn(relationship, 'since')),
  reportLine: async (client, accountId, line) => report(client, accountId, line),
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const EXECUTE_ALL = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const MODES = [VALIDATE_ONLY, EXECUTE_ALL];

function apply(apiName: string, parameters: Record<string, unknown>, options: object = EXECUTE) {
  return service.apply(actionOf(apiName), { parameters, options });
}

async function reported(accountId: string): Promise<unknown> {
  const rows = (await rowsOf(service.db, ACCOUNT, 'account_id')) as { account_id: string; name: string }[];

  const row = rows.find((r) => r.account_id === accountId);

  if (!row) throw new Error(`The Function created no Account ${accountId}.`);

  return JSON.parse(row.name);
}

async function expectEachMode(apiName: string, parameters: Record<string, unknown>, expected: Answer): Promise<void> {
  for (const options of MODES) expect(errorAnswer(await apply(apiName, parameters, options))).toEqual(expected);

  expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([]);
}

const NULL_LIST: Answer = {
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'ApplyActionFailed',
    parameters: {
      originalErrorName: 'Ontos:SingletonValueForListParameter',
      userErrorMessage: 'The Action could not apply because of an invalid list parameter.',
      builderErrorMessage: 'A list parameter received a single value instead of a list.',
    },
  },
};

const invalid = (errorName: string, parameters: Record<string, unknown>): Answer => ({
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName, parameters },
});

const ACCOUNT_TYPE = `OntologyObject<${ACCOUNT}>`;

const LISTS = [
  ['a list of String', 'reportMembers', 'teamMembers'],
  ['a list of Objects', 'reportAccounts', 'accounts'],
] as const;

describe('a list input of a function-backed Action', () => {
  it.each(LISTS)(
    'ontology/action-types/action-types#parameters: a call that omits an input of type %s, or sends [], passes VALIDATE_ONLY and apply, and the Function gets []',
    async (_name, apiName, input) => {
      for (const [accountId, parameters] of [
        ['omitted', { accountId: 'omitted' }],
        ['empty', { accountId: 'empty', [input]: [] }],
      ] as const) {
        expect(await apply(apiName, parameters, VALIDATE_ONLY)).toMatchObject({
          status: 200,
          body: { validation: { result: 'VALID' } },
        });

        expect((await apply(apiName, parameters)).status).toBe(200);

        expect(await reported(accountId)).toEqual([]);
      }
    },
  );

  it('ontology/action-types/action-types#parameters: the Function gets [] for an omitted list input, so its default value ["x"] does not apply', async () => {
    expect((await apply('defaultMembers', { accountId: 'omitted' })).status).toBe(200);

    expect(await reported('omitted')).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a list input with no list length and no allowed values gets a bare arraySize as its last constraint', async () => {
    expect((await apply('reportMembers', { accountId: 'a' }, VALIDATE_ONLY)).body).toMatchObject({
      validation: {
        parameters: {
          teamMembers: { result: 'VALID', evaluatedConstraints: [{ type: 'arraySize' }], required: false },
        },
      },
    });

    expect((await apply('reportAccounts', { accountId: 'a' }, VALIDATE_ONLY)).body).toMatchObject({
      validation: {
        parameters: {
          accounts: {
            result: 'VALID',
            evaluatedConstraints: [{ type: 'objectQueryResult' }, { type: 'arraySize' }],
            required: false,
          },
        },
      },
    });
  });

  it.each(LISTS)(
    'ontology/action-types/action-types#parameters, service/http-api#errors: null for an input of type %s gets 400 ApplyActionFailed in both modes, and the Function does not run',
    async (_name, apiName, input) => {
      await expectEachMode(apiName, { accountId: 'null', [input]: null }, NULL_LIST);
    },
  );

  it.each([[[null]], [['a', null, 'b']]])(
    'ontology/action-types/action-types#parameters: the String list %j gets 400 InvalidParameterValue with the base type String and the whole list',
    async (teamMembers) => {
      await expectEachMode(
        'reportMembers',
        { accountId: 'a', teamMembers },
        invalid('InvalidParameterValue', {
          parameterBaseType: 'String',
          parameterId: 'teamMembers',
          parameterValue: teamMembers,
        }),
      );
    },
  );

  it.each([[[null]], [['acc-1', null, 'acc-2']]])(
    'ontology/action-types/action-types#parameters: the Object list %j gets 400 InvalidParameterValue with the Object base type and the whole list',
    async (accounts) => {
      await expectEachMode(
        'reportAccounts',
        { accountId: 'a', accounts },
        invalid('InvalidParameterValue', {
          parameterBaseType: ACCOUNT_TYPE,
          parameterId: 'accounts',
          parameterValue: accounts,
        }),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a wrong element gets the 400 of its list kind', async () => {
    await expectEachMode(
      'reportMembers',
      { accountId: 'a', teamMembers: [1] },
      invalid('InvalidParameterValue', {
        parameterBaseType: 'String',
        parameterId: 'teamMembers',
        parameterValue: [1],
      }),
    );

    await expectEachMode(
      'reportAccounts',
      { accountId: 'a', accounts: [1] },
      invalid('InvalidPropertyValue', { propertyBaseType: 'String', property: 'accountId', propertyValue: 1 }),
    );
  });

  it('ontology/action-types/action-types#parameters: a value that is not a list gets 400 InvalidParameterValue with the base type of an element', async () => {
    await expectEachMode(
      'reportMembers',
      { accountId: 'a', teamMembers: 'a' },
      invalid('InvalidParameterValue', {
        parameterBaseType: 'String',
        parameterId: 'teamMembers',
        parameterValue: 'a',
      }),
    );

    await expectEachMode(
      'reportAccounts',
      { accountId: 'a', accounts: 'acc-1' },
      invalid('InvalidParameterValue', {
        parameterBaseType: ACCOUNT_TYPE,
        parameterId: 'accounts',
        parameterValue: 'acc-1',
      }),
    );
  });

  it('ontology/action-types/action-types#parameters: an unknown parameter wins over a null list, and a null list wins over a missing required parameter', async () => {
    for (const options of MODES) {
      expect(
        errorAnswer(await apply('reportMembers', { accountId: 'a', teamMembers: null, unknown: 1 }, options)),
      ).toMatchObject({
        status: 400,
        body: { errorName: 'ParametersNotFound' },
      });
    }

    await expectEachMode('reportMembers', { teamMembers: null }, NULL_LIST);
  });
});

describe('a struct input of a function-backed Action', () => {
  it('ontology/action-types/action-types#parameters: an optional field with the value null passes, and the Function gets the struct with no key for it', async () => {
    expect(
      (await apply('reportRelationship', { accountId: 'null', relationship: { label: 'met', since: null } })).status,
    ).toBe(200);

    expect(await reported('null')).toBe(false);

    expect(
      (await apply('reportRelationship', { accountId: 'set', relationship: { label: 'met', since: '2026-01-01' } }))
        .status,
    ).toBe(200);

    expect(await reported('set')).toBe(true);
  });
});

describe('a Decimal input of a function-backed Action', () => {
  it('ontology/functions/functions#function-backed-actions: the Function gets rate: Decimal sent as the number 0.0825 as "0.0825", and "1.50" as "1.5"', async () => {
    for (const [accountId, rate] of [
      ['number', 0.0825],
      ['string', '1.50'],
    ] as const)
      expect((await apply('reportRate', { accountId, rate })).status).toBe(200);

    expect([await reported('number'), await reported('string')]).toEqual(['0.0825', '1.5']);
  });

  it('ontology/functions/functions#function-backed-actions: the Function gets each element of a Decimal[] input as its plain exact string', async () => {
    expect((await apply('reportRates', { accountId: 'list', rates: [0.0825, '1.50', '+2', '1.5e3'] })).status).toBe(
      200,
    );

    expect(await reported('list')).toEqual(['0.0825', '1.5', '2', '1500']);
  });
});

describe('a struct input with a Decimal field', () => {
  it('ontology/action-types/action-types#parameters: the Function gets the Decimal field 12.5 as "12.5", and "+1.50" as "1.5", not padded to the scale 4', async () => {
    for (const [accountId, unitPrice] of [
      ['number', 12.5],
      ['string', '+1.50'],
    ] as const)
      expect((await apply('reportLine', { accountId, line: { unitPrice } })).status).toBe(200);

    expect([await reported('number'), await reported('string')]).toEqual([{ unitPrice: '12.5' }, { unitPrice: '1.5' }]);
  });
});
