import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionOf, ScriptedFunctions, withFunctions } from '../functions/functions.test-utils.ts';
import { propertyOfType, renamed, twinObjectType, unchecked } from '../ontology/stored.test-utils.ts';
import {
  actionType,
  addRule,
  errorAnswer,
  insertObjects,
  invalidValue,
  NS,
  parameterValue,
  rowsOf,
  startActions,
  twinIr,
  type ActionsService,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const DECIMAL_PROBE = `${NS}DecimalProbe`;
const CREATE_PROBE = `${NS}create-decimal-probe`;
const SCRIPTED_ACTION = actionOf('scripted');

type PropertyBlock = ReturnType<typeof propertyOfType>;

const decimal = (precision: number, scale: number) =>
  unchecked<PropertyBlock['type']>({ type: 'decimal', decimal: { precision, scale } });

function decimalProbe(): OntologyIr['ontology']['objectTypes'][string] {
  const block = renamed(twinObjectType('Account'), DECIMAL_PROBE);

  const properties = [
    propertyOfType('amount', decimal(10, 2)),
    propertyOfType('share', decimal(2, 4)),
    propertyOfType('amounts', unchecked({ type: 'array', array: { subtype: decimal(10, 2), reducers: [] } })),
  ];

  for (const property of properties) block.objectType.propertyTypes[property.apiName] = property;

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: DECIMAL_PROBE, storeAllPreviousProperties: false } },
  });

  return block;
}

const RANGE = { type: 'range', range: { type: 'range', range: {} } };
const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };

const CREATE_PARAMETERS = {
  accountId: { type: { type: 'string', string: {} }, allowedValues: TEXT, required: NOT_REQUIRED },
  name: { type: { type: 'string', string: {} }, allowedValues: TEXT, required: NOT_REQUIRED },
  amount: { type: { type: 'decimal', decimal: {} }, allowedValues: RANGE, required: NOT_REQUIRED },
  share: { type: { type: 'decimal', decimal: {} }, allowedValues: RANGE, required: NOT_REQUIRED },
  amounts: { type: { type: 'decimalList', decimalList: {} }, allowedValues: RANGE, required: NO_LIST_LENGTH },
};

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  ir.ontology.objectTypes[DECIMAL_PROBE] = decimalProbe();

  ir.ontology.actionTypes[CREATE_PROBE] = actionType(CREATE_PROBE, CREATE_PARAMETERS, [
    addRule(DECIMAL_PROBE, Object.fromEntries(Object.keys(CREATE_PARAMETERS).map((id) => [id, parameterValue(id)]))),
  ]);

  return ir;
}

let service: ActionsService;
let scripted: ScriptedFunctions;

beforeAll(async () => {
  const ir = testIr();

  scripted = new ScriptedFunctions(ir);

  const scriptedFunction = {
    apiName: 'scripted',
    inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }],
    edits: [ACCOUNT, DECIMAL_PROBE],
  } as const;

  const { ir: withScripted, functions } = await withFunctions([scriptedFunction], scripted.source, ir);

  service = await startActions(withScripted, functions);
});

afterAll(() => {
  scripted?.close();

  return service?.stop();
});

beforeEach(async () => {
  scripted.reset();

  await service.clear();

  await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-1', name: 'Acme', phase: 'customer' }]);
});

const EXECUTE_ALL = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL' };

const fitRule = (precision: number, scale: number) =>
  `A Decimal value fits the precision ${precision} and the scale ${scale} of its Property.`;

const FUNCTION_VALUE_MESSAGE = 'The Function assigned a value whose type does not match the Property.';

const createProbe = (accountId: string, values: Record<string, unknown>) =>
  service.apply(CREATE_PROBE, { parameters: { accountId, name: 'Probe', ...values }, options: EXECUTE_ALL });

function createWithFunction(accountId: string, properties: Record<string, unknown>) {
  scripted.once(() => [
    {
      type: 'addObject',
      object: { objectType: DECIMAL_PROBE, primaryKey: accountId },
      properties: new Map(Object.entries({ name: 'Probe', ...properties })),
    },
  ]);

  return service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_ALL });
}

async function loaded(): Promise<unknown> {
  const answer = await service.loadObjects({
    objectSet: { type: 'base', objectType: DECIMAL_PROBE },
    select: ['accountId', 'amount', 'share', 'amounts'],
    orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    excludeRid: true,
  });

  expect(answer.status).toBe(200);

  return (answer.body as { data: unknown[] }).data;
}

async function historyEdits(accountId: string): Promise<unknown> {
  const answer = await service.editsHistory(DECIMAL_PROBE, { objectPrimaryKey: { accountId } });

  expect(answer.status).toBe(200);

  return (answer.body as { data: { edit: unknown }[] }).data.map(({ edit }) => edit);
}

const createdAnswer = (accountId: string) => ({
  status: 200,
  body: {
    operationId: expect.any(String),
    validation: { result: 'VALID', submissionCriteria: [], parameters: expect.any(Object) },
    edits: {
      type: 'edits',
      edits: [{ type: 'addObject', primaryKey: accountId, objectType: DECIMAL_PROBE }],
      addedObjectCount: 1,
      modifiedObjectsCount: 0,
      deletedObjectsCount: 0,
      addedLinksCount: 0,
      deletedLinksCount: 0,
    },
  },
});

describe('a rule-backed write of a Decimal', () => {
  it('ontology/action-types/rules#values: a rule writes the number 1299.9 to a Decimal of scale 2, and loadObjects reads "1299.90"', async () => {
    expect((await createProbe('dp-1', { amount: 1299.9 })).status).toBe(200);

    expect(await loaded()).toEqual([
      { __apiName: DECIMAL_PROBE, __primaryKey: 'dp-1', accountId: 'dp-1', amount: '1299.90', amounts: [] },
    ]);
  });

  it('ontology/object-edits/edit-history#entries: the history entry of that write gives "1299.90", the same text as the read', async () => {
    await createProbe('dp-1', { amount: 1299.9 });

    expect(await historyEdits('dp-1')).toEqual([
      { type: 'createEdit', properties: { name: 'Probe', amount: '1299.90', amounts: [] } },
    ]);
  });

  it('ontology/action-types/action-types#apply: the returnEdits answer of that write names the created Object, and holds no Property value', async () => {
    expect(await createProbe('dp-1', { amount: 1299.9 })).toEqual(createdAnswer('dp-1'));
  });
});

describe('a Function write of a Decimal', () => {
  it('ontology/functions/functions#function-backed-actions: a Function edit of a number or a string stores the padded text, and its history entry gives the same text', async () => {
    expect(await createWithFunction('dp-n', { amount: 1299.9 })).toEqual(createdAnswer('dp-n'));

    expect(await createWithFunction('dp-s', { amount: '7.5' })).toEqual(createdAnswer('dp-s'));

    expect(await loaded()).toEqual([
      expect.objectContaining({ accountId: 'dp-n', amount: '1299.90' }),
      expect.objectContaining({ accountId: 'dp-s', amount: '7.50' }),
    ]);

    expect(await historyEdits('dp-n')).toEqual([
      { type: 'createEdit', properties: { name: 'Probe', amount: '1299.90' } },
    ]);

    expect(await historyEdits('dp-s')).toEqual([{ type: 'createEdit', properties: { name: 'Probe', amount: '7.50' } }]);
  });
});

describe('a Decimal that does not fit', () => {
  it.each([
    ['"1299.955" on the scale 2', { amount: '1299.955' }, 'amount', fitRule(10, 2)],
    ['too many digits before the point', { amount: '123456789' }, 'amount', fitRule(10, 2)],
    ['"0.012" on numeric(2, 4)', { share: '0.012' }, 'share', fitRule(2, 4)],
  ])(
    'ontology/object-link-types/properties#value-rules-on-write: a rule-backed write of %s gets the fit 400, and writes nothing',
    async (_, values, property, rule) => {
      expect(errorAnswer(await createProbe('dp-1', values))).toEqual(invalidValue(DECIMAL_PROBE, property, rule));

      expect(await rowsOf(service.db, DECIMAL_PROBE, 'account_id')).toEqual([]);
    },
  );

  it.each([
    ['the number 0.1 + 0.2 on the scale 2', { amount: 0.1 + 0.2 }],
    ['"1299.955" on the scale 2', { amount: '1299.955' }],
    ['too many digits before the point', { amount: 123456789 }],
  ])(
    'ontology/object-link-types/properties#value-rules-on-write: a Function edit of %s gets the fit 400, and writes nothing',
    async (_, values) => {
      expect(errorAnswer(await createWithFunction('dp-1', values))).toEqual(
        invalidValue(DECIMAL_PROBE, 'amount', FUNCTION_VALUE_MESSAGE),
      );

      expect(await rowsOf(service.db, DECIMAL_PROBE, 'account_id')).toEqual([]);
    },
  );

  it('ontology/object-link-types/properties#value-rules-on-write: "0.0012" fits numeric(2, 4), so the write stores it', async () => {
    expect((await createProbe('dp-1', { share: '0.0012' })).status).toBe(200);

    expect(await loaded()).toEqual([expect.objectContaining({ accountId: 'dp-1', share: '0.0012' })]);
  });
});

describe('a Decimal array', () => {
  it('ontology/object-link-types/properties#arrays: each element is stored padded to the scale', async () => {
    expect((await createProbe('dp-1', { amounts: [1.5, '2'] })).status).toBe(200);

    expect(await loaded()).toEqual([expect.objectContaining({ accountId: 'dp-1', amounts: ['1.50', '2.00'] })]);

    expect(await historyEdits('dp-1')).toEqual([
      { type: 'createEdit', properties: { name: 'Probe', amounts: ['1.50', '2.00'] } },
    ]);
  });

  it('ontology/object-link-types/properties#arrays: an element that does not fit gets the fit 400, and the write stores nothing', async () => {
    expect(errorAnswer(await createProbe('dp-1', { amounts: ['1.5', '1299.955'] }))).toEqual(
      invalidValue(DECIMAL_PROBE, 'amounts', fitRule(10, 2)),
    );

    expect(await rowsOf(service.db, DECIMAL_PROBE, 'account_id')).toEqual([]);
  });
});
